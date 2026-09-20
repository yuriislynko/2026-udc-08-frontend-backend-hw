// @vitest-environment jsdom
/**
 * UI tests for Task A.
 *
 * The page is the real `public/index.html` and the real `public/app.js`; the
 * API behind it is the real Express app on a real HTTP server with a fresh
 * in-memory database. Nothing about the feature is mocked, so a test fails
 * when the UI stops working, not when its implementation changes.
 *
 * jsdom draws no pixels, so the checks here are the ones that hold without
 * layout: what the controls are, what they are called, which state they
 * announce, and what they do. Contrast and target size are measured in a real
 * browser instead — `npm run check:a11y`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(here, "../public/index.html"), "utf8");
const pageBody = indexHtml.match(/<body>([\s\S]*)<\/body>/)[1];

const realFetch = globalThis.fetch;
let server;
let db;
let base;

beforeEach(async () => {
  db = createDb(":memory:");
  server = createServer(createApp(db));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;

  // The page asks for paths like "/api/notes". jsdom serves the document from
  // about:blank, so those are pointed at the test server here.
  globalThis.fetch = (path, options) => realFetch(new URL(path, base), options);

  // Scripts inserted with innerHTML never run, so the page's own module is not
  // started twice; each test imports it when it is ready.
  document.body.innerHTML = pageBody;
  vi.resetModules();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await new Promise((done) => server.close(done));
  db.close();
});

async function boot() {
  await import("../public/app.js");
  await waitFor(() => rendered(), "the first list to render");
}

// The page renders after a request resolves, so every assertion waits for the
// state it needs instead of for a fixed delay.
async function waitFor(predicate, what) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const rendered = () => items().length > 0 || !empty().hidden || !errorBox().hidden;
const items = () => [...document.querySelectorAll("#notes li")];
const titles = () => items().map((li) => li.querySelector("strong").textContent);
const toggles = () => items().map((li) => li.querySelector(".actions button"));
const empty = () => document.querySelector("#empty");
const errorBox = () => document.querySelector("#error");
const heading = () => document.querySelector("#list-heading");
const viewButton = (view) => document.querySelector(`[data-view="${view}"]`);

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("the notes list", () => {
  it("shows the caller's own notes, each with a real button named after its note", async () => {
    await boot();

    expect(titles()).toEqual(["Список покупок", "Ідеї для відпустки"]);
    for (const [index, toggle] of toggles().entries()) {
      // A real <button>, not a clickable div: it has to be reachable by
      // keyboard and announced as a button.
      expect(toggle.tagName).toBe("BUTTON");
      expect(toggle.type).toBe("button");
      expect(toggle.textContent).toBe("Архівувати");
      // Visible text says the action; the accessible name adds which note, so
      // a list of identical buttons is still distinguishable by ear.
      expect(toggle.getAttribute("aria-label")).toBe(`Архівувати: ${titles()[index]}`);
    }
  });

  it("loads the other user's notes when the user changes", async () => {
    await boot();

    const select = document.querySelector("#user");
    select.value = "2";
    select.dispatchEvent(new Event("change"));

    await waitFor(() => titles().length === 1, "Тарас's list");
    expect(titles()).toEqual(["Приватна нотатка Тараса"]);
  });
});

describe("the create form", () => {
  it("names each field with a label, not with placeholder text alone", () => {
    // A placeholder is a hint, not a name: it disappears as soon as the field
    // has text, and it is not reliably announced. Every control the user types
    // into has to carry a name that survives being filled in.
    const controls = [...document.querySelectorAll("#new-note input, #user")];
    expect(controls.length).toBe(3);

    for (const control of controls) {
      const fromLabel = [...control.labels].map((l) => l.textContent.trim()).join(" ");
      const name = control.getAttribute("aria-label") ?? fromLabel;
      expect(name, control.id).toBeTruthy();
      expect(name, control.id).not.toBe(control.getAttribute("placeholder"));
    }
  });
});

describe("archiving", () => {
  it("moves a note to the archive and offers to restore it there", async () => {
    await boot();

    toggles()[0].click();
    await waitFor(() => titles().length === 1, "the archived note to leave the active list");
    expect(titles()).toEqual(["Ідеї для відпустки"]);

    viewButton("archived").click();
    await waitFor(() => titles().includes("Список покупок"), "the archive to list the note");
    expect(heading().textContent).toBe("Архів");
    const restore = toggles()[0];
    expect(restore.textContent).toBe("Повернути з архіву");
    expect(restore.getAttribute("aria-label")).toBe("Повернути з архіву: Список покупок");

    restore.click();
    await waitFor(() => items().length === 0, "the archive to empty out");

    viewButton("active").click();
    await waitFor(() => titles().length === 2, "the restored note to come back");
    expect(titles()).toEqual(["Список покупок", "Ідеї для відпустки"]);
  });

  it("writes the change through to the server, not only to the page", async () => {
    await boot();

    toggles()[0].click();
    await waitFor(() => titles().length === 1, "the archive request to finish");

    expect(db.prepare("SELECT archived FROM notes WHERE id = 1").get()).toEqual({ archived: 1 });
  });

  it("labels each control from its own note, not from the open view", async () => {
    // Regression test. The first version computed the label and the action
    // from the current view, which is right only as long as every list holds
    // one state. This list holds both, so a view-derived label is visibly
    // wrong on one of the two rows.
    globalThis.fetch = async () =>
      jsonResponse([
        { id: 1, title: "Активна", body: "", created_at: "", archived: false },
        { id: 2, title: "Архівована", body: "", created_at: "", archived: true },
      ]);

    await boot();

    expect(toggles().map((b) => b.textContent)).toEqual(["Архівувати", "Повернути з архіву"]);
  });

  it("sends one request when the control is clicked twice", async () => {
    // The button is disabled while its request is in flight, so an impatient
    // double click cannot archive and restore in one go.
    let patches = 0;
    const counted = globalThis.fetch;
    globalThis.fetch = (path, options = {}) => {
      if (options.method === "PATCH") patches++;
      return counted(path, options);
    };

    await boot();
    const toggle = toggles()[0];
    toggle.click();
    toggle.click();

    await waitFor(() => titles().length === 1, "the archive request to finish");
    expect(patches).toBe(1);
  });
});

describe("the archive view", () => {
  it("explains an empty archive instead of showing a blank page", async () => {
    await boot();

    viewButton("archived").click();
    await waitFor(() => !empty().hidden, "the empty state");

    expect(items()).toHaveLength(0);
    expect(empty().textContent).toBe("В архіві порожньо. Архівовані нотатки з'являться тут.");
    // role="status" so the text is announced when it appears, not only seen.
    expect(empty().getAttribute("role")).toBe("status");
  });

  it("says which view is open, in the accessibility tree and not only by colour", async () => {
    await boot();

    expect(viewButton("active").getAttribute("aria-pressed")).toBe("true");
    expect(viewButton("archived").getAttribute("aria-pressed")).toBe("false");

    viewButton("archived").click();
    await waitFor(() => heading().textContent === "Архів", "the archive heading");

    expect(viewButton("active").getAttribute("aria-pressed")).toBe("false");
    expect(viewButton("archived").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("when a request fails", () => {
  it("reports it in the page's alert region instead of failing silently", async () => {
    await boot();
    expect(errorBox().hidden).toBe(true);

    globalThis.fetch = () => Promise.reject(new TypeError("network down"));
    toggles()[0].click();

    await waitFor(() => !errorBox().hidden, "the error message");
    expect(errorBox().getAttribute("role")).toBe("alert");
    expect(errorBox().textContent).toContain("Не вдалося змінити нотатку.");
  });

  it("treats a server error as a failure, not as a list of notes", async () => {
    // fetch() resolves on 4xx/5xx — only the status says the request failed.
    // A page that skips that check renders the error body as if it were data.
    await boot();

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    viewButton("archived").click();

    await waitFor(() => !errorBox().hidden, "the error message");
    expect(errorBox().textContent).toContain("Не вдалося завантажити нотатки.");
    expect(errorBox().textContent).toContain("500");
    expect(items()).toHaveLength(0);
  });

  it("keeps a note the user typed when creating it fails", async () => {
    await boot();

    globalThis.fetch = () => Promise.reject(new TypeError("network down"));
    const title = document.querySelector("#title");
    const body = document.querySelector("#body");
    title.value = "Чернетка";
    body.value = "текст";
    document.querySelector("#new-note").dispatchEvent(new Event("submit", { cancelable: true }));

    await waitFor(() => !errorBox().hidden, "the error message");
    expect(errorBox().textContent).toContain("Не вдалося додати нотатку.");
    expect(title.value).toBe("Чернетка");
    expect(body.value).toBe("текст");
    // The submit button has to come back, or the user cannot retry.
    expect(document.querySelector("#new-note button[type=submit]").disabled).toBe(false);
  });
});
