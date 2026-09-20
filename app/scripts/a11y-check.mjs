#!/usr/bin/env node
/**
 * Accessibility check for Task A.
 *
 * The UI suite (`test/ui.test.js`) runs in jsdom, which draws nothing: it can
 * assert roles, names and states, but not contrast or how large a control is.
 * Those two claims are written as thresholds in `public/style.css`, and a
 * comment is not evidence. This script starts the app, drives a real headless
 * Chrome through the archive flow, dumps the accessibility tree at each step
 * and measures what jsdom cannot:
 *
 *   - every control has an accessible name, and a field the user types into
 *     is named by a label rather than by its placeholder;
 *   - every control is at least 44x44 CSS px (WCAG 2.5.5);
 *   - borders reach 3:1 against the page background (WCAG 1.4.11) and text
 *     reaches 4.5:1 (WCAG 1.4.3), in both the light and the dark scheme.
 *
 * It exits non-zero when a measurement misses its threshold, so it is a check
 * and not only a screenshot in words.
 *
 *   npm run check:a11y
 *
 * Chrome is driven over the DevTools protocol with Node's built-in WebSocket;
 * nothing is installed for this. Set CHROME_PATH if Chrome lives elsewhere.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const TARGET_MIN_PX = 44; // WCAG 2.5.5 Target Size (Enhanced)
const BORDER_MIN_RATIO = 3; // WCAG 1.4.11 Non-text Contrast
const TEXT_MIN_RATIO = 4.5; // WCAG 1.4.3 Contrast (Minimum)

const problems = [];

/** Minimal DevTools protocol client over Node's built-in WebSocket. */
async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) return; // an event, not an answer to a command
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(`${message.error.message} (${waiting.method})`));
    else waiting.resolve(message.result);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)), { once: true });
  });

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    close: () => socket.close(),
  };
}

async function launchChrome() {
  const binary = CANDIDATES.find((path) => existsSync(path));
  if (!binary) {
    console.error("Chrome not found. Install it or set CHROME_PATH to its binary.");
    process.exit(1);
  }

  const profile = mkdtempSync(join(tmpdir(), "a11y-chrome-"));
  const chrome = spawn(binary, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ]);

  // Chrome prints the endpoint it chose on stderr once it is ready.
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not report a DevTools endpoint")), 20000);
    let buffered = "";
    chrome.stderr.on("data", (chunk) => {
      buffered += chunk;
      const found = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    chrome.on("exit", (code) => reject(new Error(`Chrome exited early (${code})`)));
  });

  return { chrome, endpoint, profile };
}

/** Runs an expression in the page and returns its value. */
async function evaluate(cdp, session, expression) {
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    session,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "page threw");
  return result.value;
}

async function waitFor(cdp, session, expression, what) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(cdp, session, expression)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The accessibility tree as the browser computes it — the same source a screen
 * reader reads. Ignored and structural nodes are dropped so the output is
 * about the controls.
 */
async function snapshot(cdp, session, label) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree", {}, session);
  const interesting = new Set([
    "button",
    "heading",
    "list",
    "listitem",
    "combobox",
    "textbox",
    "status",
    "alert",
    "group",
  ]);

  const lines = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value;
    if (!interesting.has(role)) continue;
    const name = node.name?.value ?? "";
    const states = (node.properties ?? [])
      .filter((p) => ["pressed", "level", "disabled"].includes(p.name))
      .map((p) => `${p.name}=${p.value.value}`)
      .join(" ");
    lines.push(`  ${role}${name ? ` "${name}"` : ""}${states ? ` ${states}` : ""}`);

    if (["button", "textbox", "combobox"].includes(role) && !name) {
      problems.push(`${label}: a ${role} has no accessible name`);
    }
  }
  console.log(`\n${label}`);
  console.log(lines.join("\n"));
}

/**
 * The name of a field the user types into. A placeholder is a hint: it is gone
 * as soon as the field has text, and the accessibility tree falls back to it
 * only because nothing better was provided. Each field has to be named by a
 * label or an aria-label instead, so the check reads the DOM rather than the
 * computed name — the computed name cannot say where it came from.
 */
async function checkFieldNames(cdp, session, label) {
  const fields = await evaluate(
    cdp,
    session,
    `[...document.querySelectorAll("input, select, textarea")].map((el) => ({
       id: el.id,
       aria: el.getAttribute("aria-label"),
       label: [...el.labels].map((l) => {
         // A label that wraps its control also contains the control's own text
         // (the options of a select); that text is not part of the name.
         const text = l.cloneNode(true);
         for (const nested of text.querySelectorAll("input, select, textarea")) nested.remove();
         return text.textContent.replace(/\s+/g, " ").trim();
       }).join(" "),
       placeholder: el.getAttribute("placeholder"),
     }))`,
  );
  for (const field of fields) {
    const name = field.aria ?? field.label;
    if (!name) {
      problems.push(`${label}: field "${field.id}" has no label, only a placeholder`);
    } else if (field.placeholder && name === field.placeholder) {
      problems.push(`${label}: field "${field.id}" is named by its placeholder`);
    }
  }
  console.log(
    `  field names: ${fields.map((f) => `${f.id} "${f.aria ?? f.label}"`).join(", ")}`,
  );
}

/** Measures every control the user can hit in the current state. */
async function measureTargets(cdp, session, label) {
  const sizes = await evaluate(
    cdp,
    session,
    `[...document.querySelectorAll("button")].map((b) => {
       const r = b.getBoundingClientRect();
       return { name: b.getAttribute("aria-label") || b.textContent, w: Math.round(r.width), h: Math.round(r.height) };
     })`,
  );
  for (const target of sizes) {
    if (target.w < TARGET_MIN_PX || target.h < TARGET_MIN_PX) {
      problems.push(
        `${label}: control "${target.name}" is ${target.w}x${target.h} px, below ${TARGET_MIN_PX}x${TARGET_MIN_PX}`,
      );
    }
  }
  console.log(
    `  target sizes: ${sizes.map((t) => `${t.w}x${t.h}`).join(", ")} (minimum ${TARGET_MIN_PX})`,
  );
}

/**
 * Contrast, measured from what the browser actually paints. The colours are
 * written as `light-dark()` tokens, so each scheme has to be asked separately.
 */
const CONTRAST_SCRIPT = `(() => {
  const luminance = (color) => {
    const [r, g, b] = color.match(/[\\d.]+/g).slice(0, 3).map(Number);
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
  };
  // body has no background of its own, so the paper colour is the canvas.
  const probe = document.createElement("div");
  probe.style.background = "Canvas";
  document.body.append(probe);
  const canvas = getComputedStyle(probe).backgroundColor;
  probe.remove();

  const note = document.querySelector("#notes li");
  const stamp = note.querySelector("small");
  const toggle = note.querySelector(".actions button");
  return {
    canvas,
    "note border": ratio(getComputedStyle(note).borderTopColor, canvas),
    "button border": ratio(getComputedStyle(toggle).borderTopColor, canvas),
    "button text": ratio(getComputedStyle(toggle).color, canvas),
    "timestamp text": ratio(getComputedStyle(stamp).color, canvas),
  };
})()`;

async function measureContrast(cdp, session, scheme) {
  await cdp.send(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value: scheme }] },
    session,
  );
  const measured = await evaluate(cdp, session, CONTRAST_SCRIPT);
  const { canvas, ...ratios } = measured;

  console.log(`\ncontrast — ${scheme} scheme (background ${canvas})`);
  for (const [what, value] of Object.entries(ratios)) {
    const minimum = what.endsWith("text") ? TEXT_MIN_RATIO : BORDER_MIN_RATIO;
    const verdict = value >= minimum ? "ok" : "BELOW";
    console.log(`  ${what.padEnd(16)} ${String(value).padStart(5)}:1  (minimum ${minimum}) ${verdict}`);
    if (value < minimum) {
      problems.push(`${scheme} scheme: ${what} is ${value}:1, below ${minimum}:1`);
    }
  }
}

const db = createDb(":memory:");
const server = createServer(createApp(db));
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}/`;

const { chrome, endpoint, profile } = await launchChrome();
const cdp = await connect(endpoint);

try {
  const { targetId } = await cdp.send("Target.createTarget", { url: base });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Accessibility.enable", {}, sessionId);

  const listed = (count) => `document.querySelectorAll("#notes li").length === ${count}`;
  const click = (selector) => `document.querySelector('${selector}').click()`;

  await waitFor(cdp, sessionId, listed(2), "the active list");
  await snapshot(cdp, sessionId, "1. active view, two notes");
  await measureTargets(cdp, sessionId, "active view");
  await checkFieldNames(cdp, sessionId, "active view");

  await evaluate(cdp, sessionId, click("#notes li .actions button"));
  await waitFor(cdp, sessionId, listed(1), "the archived note to leave the active list");
  await snapshot(cdp, sessionId, "2. after archiving the first note");

  await evaluate(cdp, sessionId, click('[data-view="archived"]'));
  await waitFor(cdp, sessionId, listed(1), "the archive to list the note");
  await snapshot(cdp, sessionId, "3. archive view");

  await evaluate(cdp, sessionId, click("#notes li .actions button"));
  await waitFor(cdp, sessionId, listed(0), "the archive to empty out");
  await waitFor(
    cdp,
    sessionId,
    'document.querySelector("#empty").hidden === false',
    "the empty state",
  );
  await snapshot(cdp, sessionId, "4. archive view, empty");
  // The status node carries its text in a child; print it, because the point
  // of the empty state is what it says.
  console.log(
    `  status text: "${await evaluate(cdp, sessionId, 'document.querySelector("#empty").textContent')}"`,
  );

  await evaluate(cdp, sessionId, click('[data-view="active"]'));
  await waitFor(cdp, sessionId, listed(2), "the restored note to come back");

  await measureContrast(cdp, sessionId, "light");
  await measureContrast(cdp, sessionId, "dark");
} finally {
  cdp.close();
  chrome.kill();
  await new Promise((done) => server.close(done));
  db.close();
  rmSync(profile, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error("\nFAILED");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("\nOK");
