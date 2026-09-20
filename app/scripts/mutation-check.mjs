#!/usr/bin/env node
/**
 * Mutation check for the authorization suite (Task E) and the UI suite
 * (Task A).
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
const quiet = process.argv.includes("--quiet");

const suites = {
  authz: { title: "authorization — test/authz.test.js", file: "test/authz.test.js" },
  ui: { title: "UI — test/ui.test.js", file: "test/ui.test.js" },
};

// Each mutation rewrites one file. `apply` must change it: if a refactor makes
// one of these a no-op, the run fails loudly instead of reporting a mutation
// that was never actually applied.
const mutations = [
  {
    suite: "authz",
    file: "src/app.js",
    name: "no owner condition",
    why: "single-record queries scope by id alone, the way the seeded hole did",
    apply: (src) => src.replace(/ AND user_id = \?/g, "").replace(/, req\.userId\)/g, ")"),
  },
  {
    suite: "authz",
    file: "src/app.js",
    name: "one fixed caller",
    why: "the session resolves every request to user 1 instead of reading the header",
    apply: (src) => src.replace("req.userId = id;", "req.userId = 1;"),
  },
  {
    suite: "authz",
    file: "src/app.js",
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
    suite: "authz",
    file: "src/app.js",
    name: "widened response",
    why: "handlers select every column, so user_id reaches the client",
    apply: (src) =>
      src
        .replace(/SELECT id, title, body, created_at, archived FROM notes/g, "SELECT * FROM notes")
        .replace("RETURNING id, title, body, created_at, archived", "RETURNING *"),
  },
  {
    suite: "authz",
    file: "src/app.js",
    name: "lax id parsing",
    why: 'the header is parsed with Number() alone, so forms like "+1" and "01" resolve to a user',
    apply: (src) => src.replace("  if (!/^[1-9]\\d*$/.test(raw)) return null;\n", ""),
  },
  {
    suite: "authz",
    file: "src/app.js",
    name: "no session guard",
    why: "the middleware never refuses, so an absent or unknown caller reaches the handlers",
    apply: (src) => src.replace("if (id === null || !userExists.get(id)) {", "if (false) {"),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "label from the view",
    why: "the archive control is labelled from the open view instead of the note it belongs to",
    apply: (src) =>
      src
        .replace(
          'toggle.textContent = n.archived ? "Повернути з архіву" : "Архівувати";',
          'toggle.textContent = view === "archived" ? "Повернути з архіву" : "Архівувати";',
        )
        .replace(
          'toggle.addEventListener("click", () => setArchived(li, n, !n.archived));',
          'toggle.addEventListener("click", () => setArchived(li, n, view !== "archived"));',
        ),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "no accessible name",
    why: "the control keeps its visible text but loses the aria-label naming its note",
    apply: (src) => src.replace(/\n\s*toggle\.setAttribute\("aria-label".*\);/, ""),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "HTTP errors ignored",
    why: "fetch resolves on 4xx/5xx, so a server error looks like a successful response",
    apply: (src) => src.replace(/  if \(!res\.ok\) \{\n[\s\S]*?\n  \}\n/, ""),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "change never sent",
    why: "the page updates itself and never asks the server to store the change",
    apply: (src) =>
      src.replace(
        '    () => api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ archived }) }),',
        "    () => Promise.resolve(),",
      ),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "change failure swallowed",
    why: "a change that the server refused leaves no message on the page",
    apply: (src) => src.replace("  if (error) showError(`${failure} ${error.message}`);\n", ""),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "user switch ignored",
    why: "changing the user in the dropdown does not reload the list",
    apply: (src) => src.replace('userSelect.addEventListener("change", load);\n', ""),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "buttons stay live",
    why: "a control is not disabled while its request is in flight, so a double click sends two",
    apply: (src) => src.replace("for (const b of buttons) b.disabled = true;", ""),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "no empty state",
    why: "an empty list renders as a blank area with nothing said about it",
    apply: (src) => src.replace("empty.hidden = notes.length > 0;", "empty.hidden = true;"),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "view state not announced",
    why: "the open view is shown by styling only; aria-pressed never changes",
    apply: (src) =>
      src.replace(
        'b.setAttribute("aria-pressed", String(b.dataset.view === view));',
        "",
      ),
  },
  {
    suite: "ui",
    file: "public/app.js",
    name: "typed text discarded",
    why: "a failed create clears the form, so the user retypes what the server never took",
    apply: (src) =>
      src.replace(
        /    showError\(`Не вдалося додати нотатку\. \$\{err\.message\}`\);\n    return;/,
        '    showError(`Не вдалося додати нотатку. ${err.message}`);\n    title.value = "";\n    body.value = "";\n    return;',
      ),
  },
];

// Tests that assert behaviour which is already correct and cannot be broken
// from inside the app, so no mutation can kill them. They stay in the suite as
// a note to the next reader; see docs/task-e-bonus.md.
const expectedSurvivors = new Map([
  [
    "the shape of the user header is not bypassed by padding the header with spaces",
    "characterization: HTTP strips the padding before the app sees the header, so only a trim() added to the app would change this — and that is the mistake the test exists to prevent",
  ],
]);

function run(suite, mutation) {
  const work = mkdtempSync(join(tmpdir(), "mutation-"));
  try {
    for (const entry of ["src", "public", "test", "package.json"]) {
      cpSync(join(appDir, entry), join(work, entry), { recursive: true });
    }
    symlinkSync(join(appDir, "node_modules"), join(work, "node_modules"));

    if (mutation) {
      const file = join(work, mutation.file);
      const before = readFileSync(file, "utf8");
      const after = mutation.apply(before);
      if (after === before) return { error: `mutation no longer applies to ${mutation.file}` };
      writeFileSync(file, after);
    }

    const out = join(work, "report.json");
    spawnSync(
      join(work, "node_modules", ".bin", "vitest"),
      ["run", suites[suite].file, "--reporter=json", "--outputFile", out],
      { cwd: work, stdio: "ignore" },
    );

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

const problems = [];
const results = [];

for (const [key, suite] of Object.entries(suites)) {
  const baseline = run(key, null);
  if (baseline.error) {
    console.error(`baseline for ${suite.file}: ${baseline.error}`);
    process.exit(1);
  }
  if (baseline.failed.length > 0) {
    console.error(`baseline for ${suite.file} is not green: ${baseline.failed.length} failed`);
    for (const name of baseline.failed) console.error(`  ${name}`);
    process.exit(1);
  }

  const total = baseline.all.length;
  const killed = new Set();
  const rows = [];

  for (const mutation of mutations.filter((m) => m.suite === key)) {
    const result = run(key, mutation);
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
  results.push({ suite, total, rows, killed, survivors });
}

for (const name of expectedSurvivors.keys()) {
  const known = results.some((r) => r.survivors.includes(name));
  const alive = results.some((r) => r.killed.has(name));
  if (alive) problems.push(`"${name}" is listed as a survivor but a mutation killed it`);
  if (!known && !alive) problems.push(`"${name}" is listed as a survivor but is not in any suite`);
}

if (!quiet) {
  for (const { suite, total, rows, killed, survivors } of results) {
    console.log(`\n${suite.title} — baseline ${total} tests, all green\n`);
    const width = Math.max(...rows.map((r) => r.name.length));
    for (const row of rows) {
      console.log(`  ${row.name.padEnd(width)}  ${String(row.killed).padStart(5)}  ${row.why}`);
    }
    console.log(`\n  covered: ${killed.size}/${total} tests fail on at least one mutation`);
    for (const name of survivors) {
      console.log(`  survivor: ${name}\n            ${expectedSurvivors.get(name) ?? "UNEXPECTED"}`);
    }
  }
}

if (problems.length > 0) {
  console.error("\nFAILED");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("\nOK");
