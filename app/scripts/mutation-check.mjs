#!/usr/bin/env node
/**
 * Mutation check for the Task E authorization suite.
 *
 * A green suite proves nothing until it has been seen red. This script breaks
 * the app on purpose, once per known failure mode, and records which tests
 * notice. It fails if a mutation kills nothing (the suite does not cover that
 * failure mode) or if a test is never killed by any mutation (the test cannot
 * distinguish a correct app from a broken one).
 *
 * Nothing under `app/` is touched: each run works on a copy in the system temp
 * directory with `node_modules` symlinked rather than reinstalled.
 *
 *   node scripts/mutation-check.mjs          # table + verdict
 *   node scripts/mutation-check.mjs --quiet  # verdict only
 */
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = "test/authz.test.js";
const quiet = process.argv.includes("--quiet");

// Each mutation rewrites `src/app.js`. `apply` must change the source: if a
// refactor makes one of these a no-op, the run fails loudly instead of
// reporting a mutation that was never actually applied.
const mutations = [
  {
    name: "no owner condition",
    why: "single-record queries scope by id alone, the way the seeded hole did",
    apply: (src) => src.replace(/ AND user_id = \?/g, "").replace(/, req\.userId\)/g, ")"),
  },
  {
    name: "one fixed caller",
    why: "the session resolves every request to user 1 instead of reading the header",
    apply: (src) => src.replace("req.userId = id;", "req.userId = 1;"),
  },
  {
    name: "owner taken from the body",
    why: "the insert trusts client-supplied user_id and archived",
    apply: (src) =>
      src
        .replace(
          '"INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)"',
          '"INSERT INTO notes (user_id, title, body, archived) VALUES (?, ?, ?, ?)"',
        )
        .replace(
          ".run(req.userId, title, body);",
          ".run(req.body?.user_id ?? req.userId, title, body, req.body?.archived ? 1 : 0);",
        ),
  },
  {
    name: "widened response",
    why: "handlers select every column, so user_id reaches the client",
    apply: (src) => src.replace(/SELECT id, title, body, created_at, archived FROM notes/g, "SELECT * FROM notes"),
  },
  {
    name: "lax id parsing",
    why: "the header is parsed with Number() alone, so forms like \"+1\" and \"01\" resolve to a user",
    apply: (src) => src.replace("  if (!/^[1-9]\\d*$/.test(raw)) return null;\n", ""),
  },
  {
    name: "no session guard",
    why: "the middleware never refuses, so an absent or unknown caller reaches the handlers",
    apply: (src) => src.replace("if (id === null || !userExists.get(id)) {", "if (false) {"),
  },
];

// One test asserts behaviour that is already correct and cannot be broken from
// inside the app, so no mutation can kill it. It stays in the suite as a note
// to the next reader; see docs/task-e-bonus.md.
const expectedSurvivors = new Map([
  [
    "the shape of the user header is not bypassed by padding the header with spaces",
    "characterization: HTTP strips the padding before the app sees the header, so only a trim() added to the app would change this — and that is the mistake the test exists to prevent",
  ],
]);

function run(mutate) {
  const work = mkdtempSync(join(tmpdir(), "authz-mutation-"));
  try {
    for (const entry of ["src", "test", "package.json"]) {
      cpSync(join(appDir, entry), join(work, entry), { recursive: true });
    }
    symlinkSync(join(appDir, "node_modules"), join(work, "node_modules"));

    if (mutate) {
      const file = join(work, "src", "app.js");
      const before = readFileSync(file, "utf8");
      const after = mutate(before);
      if (after === before) return { error: "mutation no longer applies to src/app.js" };
      writeFileSync(file, after);
    }

    const out = join(work, "report.json");
    spawnSync(join(work, "node_modules", ".bin", "vitest"), ["run", SUITE, "--reporter=json", "--outputFile", out], {
      cwd: work,
      stdio: "ignore",
    });

    const report = JSON.parse(readFileSync(out, "utf8"));
    const tests = report.testResults.flatMap((file) => file.assertionResults);
    if (tests.length === 0) return { error: "the suite did not run" };
    return {
      all: tests.map((t) => t.fullName),
      failed: tests.filter((t) => t.status === "failed").map((t) => t.fullName),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const baseline = run(null);
if (baseline.error) {
  console.error(`baseline: ${baseline.error}`);
  process.exit(1);
}
if (baseline.failed.length > 0) {
  console.error(`baseline is not green: ${baseline.failed.length} of ${baseline.all.length} failed`);
  for (const name of baseline.failed) console.error(`  ${name}`);
  process.exit(1);
}

const total = baseline.all.length;
const killed = new Set();
const problems = [];
const rows = [];

for (const mutation of mutations) {
  const result = run(mutation.apply);
  if (result.error) {
    problems.push(`mutation "${mutation.name}": ${result.error}`);
    rows.push({ name: mutation.name, killed: "—", why: mutation.why });
    continue;
  }
  for (const name of result.failed) killed.add(name);
  if (result.failed.length === 0) {
    problems.push(`mutation "${mutation.name}" killed nothing — the suite does not cover it`);
  }
  rows.push({ name: mutation.name, killed: `${result.failed.length}/${total}`, why: mutation.why });
}

const survivors = baseline.all.filter((name) => !killed.has(name));
for (const name of survivors) {
  if (!expectedSurvivors.has(name)) {
    problems.push(`no mutation kills "${name}" — it never fails on a broken app`);
  }
}
for (const name of expectedSurvivors.keys()) {
  if (killed.has(name)) {
    problems.push(`"${name}" is listed as a survivor but a mutation killed it — update the list`);
  }
  if (!baseline.all.includes(name)) {
    problems.push(`"${name}" is listed as a survivor but no longer exists in the suite`);
  }
}

if (!quiet) {
  const width = Math.max(...rows.map((r) => r.name.length));
  console.log(`baseline: ${total} tests, all green\n`);
  for (const row of rows) {
    console.log(`  ${row.name.padEnd(width)}  ${String(row.killed).padStart(5)}  ${row.why}`);
  }
  console.log(`\ncovered: ${killed.size}/${total} tests fail on at least one mutation`);
  for (const name of survivors) {
    console.log(`survivor: ${name}\n          ${expectedSurvivors.get(name) ?? "UNEXPECTED"}`);
  }
}

if (problems.length > 0) {
  console.error("\nFAILED");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("\nOK");
