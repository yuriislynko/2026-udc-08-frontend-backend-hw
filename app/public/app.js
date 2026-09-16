// Minimal UI. No framework and no build step on purpose: the point of this
// homework is the seam between UI, API, database and authorization, not the
// view layer. Keep it that way — do not introduce a bundler.

const userSelect = document.querySelector("#user");
const list = document.querySelector("#notes");
const empty = document.querySelector("#empty");
const heading = document.querySelector("#list-heading");
const form = document.querySelector("#new-note");
const viewButtons = document.querySelectorAll("[data-view]");
const errorBox = document.querySelector("#error");

const VIEWS = {
  active: { heading: "Активні нотатки", empty: "Нотаток поки немає." },
  archived: {
    heading: "Архів",
    empty: "В архіві порожньо. Архівовані нотатки з'являться тут.",
  },
};

let view = "active";
// Each load() takes the next number; a response that arrives after a newer
// load() started is stale (another user or view) and is dropped.
let loadSeq = 0;

function headers() {
  return { "content-type": "application/json", "x-user-id": userSelect.value };
}

// Shows a message in the page's alert region; an empty message hides it.
function showError(message = "") {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

// fetch() only rejects on a network failure; a 4xx/5xx still resolves. Turn
// both into one thrown error so every caller handles them the same way.
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { ...options, headers: headers() });
  } catch {
    throw new Error("Немає з'єднання із сервером. Перевірте мережу й спробуйте ще раз.");
  }
  if (!res.ok) {
    throw new Error(`Сервер відповів помилкою (${res.status}). Спробуйте ще раз.`);
  }
  return res.status === 204 ? null : res.json();
}

// Runs a change for one list item, then reloads the list. The item's buttons
// are disabled while the request is in flight, so a double click sends one
// request. A failed change is reported and the list is still reloaded, so the
// page shows what the server actually has. The re-rendered list drops the
// focused button, so focus moves to the list heading instead of the page top.
async function mutate(item, action, failure) {
  const buttons = item.querySelectorAll("button");
  for (const b of buttons) b.disabled = true;
  let error = null;
  try {
    await action();
  } catch (err) {
    error = err;
  } finally {
    for (const b of buttons) b.disabled = false;
  }
  await load();
  if (error) showError(`${failure} ${error.message}`);
  if (!list.contains(document.activeElement)) heading.focus();
}

function setView(next) {
  view = next;
  for (const b of viewButtons) {
    b.setAttribute("aria-pressed", String(b.dataset.view === view));
  }
  heading.textContent = VIEWS[view].heading;
  load();
}

function setArchived(item, note, archived) {
  return mutate(
    item,
    () => api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ archived }) }),
    "Не вдалося змінити нотатку.",
  );
}

async function load() {
  const seq = ++loadSeq;
  const archived = view === "archived";
  let notes;
  try {
    notes = await api(`/api/notes?archived=${archived}`);
  } catch (err) {
    if (seq !== loadSeq) return;
    list.replaceChildren();
    empty.hidden = true;
    showError(`Не вдалося завантажити нотатки. ${err.message}`);
    return;
  }
  if (seq !== loadSeq) return;
  showError();

  list.replaceChildren(
    ...notes.map((n) => {
      const li = document.createElement("li");

      const grow = document.createElement("div");
      grow.className = "grow";
      const title = document.createElement("strong");
      title.textContent = n.title;
      const body = document.createElement("span");
      body.textContent = n.body;
      const when = document.createElement("small");
      when.textContent = n.created_at;
      grow.append(title, body, document.createElement("br"), when);

      const actions = document.createElement("div");
      actions.className = "actions";

      // Visible text says what the button does; aria-label adds which note,
      // so a screen reader user hearing a list of buttons can tell them apart.
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = archived ? "Повернути з архіву" : "Архівувати";
      toggle.setAttribute("aria-label", `${toggle.textContent}: ${n.title}`);
      toggle.addEventListener("click", () => setArchived(li, n, !archived));

      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Видалити";
      del.setAttribute("aria-label", `Видалити: ${n.title}`);
      del.addEventListener("click", () =>
        mutate(
          li,
          () => api(`/api/notes/${n.id}`, { method: "DELETE" }),
          "Не вдалося видалити нотатку.",
        ),
      );

      actions.append(toggle, del);
      li.append(grow, actions);
      return li;
    }),
  );
  empty.textContent = VIEWS[view].empty;
  empty.hidden = notes.length > 0;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.querySelector("#title");
  const body = document.querySelector("#body");
  const submit = form.querySelector("button[type=submit]");
  // Disabled while saving, so a double click does not create two notes.
  submit.disabled = true;
  try {
    await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title: title.value, body: body.value }),
    });
  } catch (err) {
    // Keep what the user typed so they can retry.
    showError(`Не вдалося додати нотатку. ${err.message}`);
    return;
  } finally {
    submit.disabled = false;
  }
  title.value = "";
  body.value = "";
  // A new note is active, so show the list it landed in.
  setView("active");
});

for (const b of viewButtons) {
  b.addEventListener("click", () => setView(b.dataset.view));
}
userSelect.addEventListener("change", load);
load();
