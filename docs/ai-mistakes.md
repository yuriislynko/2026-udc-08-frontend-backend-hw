# What the AI got wrong (Task D)

**Tool and model:** Claude Code / Claude Opus 5

Sources of evidence: the commits on `ws08/yuriislynko`, the Claude Code session
logs from 2026-09-16 and 2026-09-19, and re-runs of the pre-fix code in a
scratch copy of `app/`. Most defects were caught by a separate review pass: a
new agent session asked to review Tasks A–C critically against the
walkthrough.

---

## 1. Route ids accepted `1e0` and `0x1` as note 1

- **Asked:** Task B — an endpoint that toggles the archive flag, with server-side
  validation.
- **Produced:** `PATCH /api/notes/:id` parsed the id with
  `Number(req.params.id)` and checked `Number.isInteger(id) && id > 0`
  (`e94227f`, `app/src/app.js` line 79). `Number()` also reads `"1e0"`,
  `"0x1"` and `"1.0"` as `1`. A later hardening commit moved the same check into
  a shared `parseId` and applied it to `DELETE` (`f6b6cb4`), so the flaw spread
  instead of being fixed.
- **Noticed by:** review pass on 2026-09-16. Reproduced on the pre-fix code on
  2026-09-19: `DELETE /api/notes/1e0` as user 1 answered `204` and deleted
  note 1.
- **Fixed:** `parseId` first requires the id to match `/^[1-9]\d*$/` and only
  then converts it (`9d24b59`). Tests send `abc`, `0`, `-1`, `1.5`, `0x1`, `1e0`
  to `GET`, `PATCH` and `DELETE` and expect `400`.
- **Why the agent did it (hypothesis):** it checked the result of the
  conversion ("a positive integer") but not the input format. JavaScript's
  conversion rules were not part of the question it asked itself.

## 2. Malformed JSON returned an HTML stack trace with server file paths

- **Asked:** Task B — "the endpoint answers sensibly to invalid input".
- **Produced:** the first `PATCH` validated `archived` inside the route, but a
  body that is not valid JSON fails earlier, in `express.json()`. Express then
  answered with its default HTML error page, which includes the stack trace and
  absolute paths on the server.
- **Noticed by:** a manual request with a broken body during the Task B
  walkthrough on 2026-09-16. No test sent malformed JSON, so the suite was green.
- **Fixed:** an error handler at the end of `app/src/app.js` answers
  `400 {"error":"invalid JSON"}` for parse errors and `500 {"error":"internal
  error"}` for anything else, logging details on the server only. Test:
  `answers malformed JSON with a short JSON error, not a stack trace`.
- **Why the agent did it (hypothesis):** it validated the fields it wrote code
  for and did not consider failures that happen before the route runs.

## 3. The first UI ignored server errors

- **Asked:** Task A — archive / restore control and an archive view.
- **Produced:** the first version of `app/public/app.js`. It was rewritten
  before anything was pushed, so it is not in the repository history: the
  evidence for this entry is the Claude Code session log from 2026-09-16, not a
  commit. What it contained — `load()` read the response without checking it:

  ```js
  const res = await fetch(`/api/notes?archived=${archived}`, { headers: headers() });
  const notes = await res.json();
  ```

  A failed archive showed a browser `alert()`, delete and create did not check
  the response at all, and a network failure was unhandled. A `4xx`/`5xx` left
  the list silently broken.
- **Noticed by:** review pass on 2026-09-16. The defect itself is reproducible
  on the current code without the session log: `npm run test:mutations` applies
  it as the `HTTP errors ignored` mutation, which strips the status check back
  out of `public/app.js`.
- **Fixed:** one `api()` helper in `app/public/app.js` turns HTTP errors and
  network failures into a thrown error; messages appear in an on-page
  `role="alert"` region; a failed create keeps the typed text; the list reloads
  after a failed change so it shows what the server has (`e9cb6b0`).
- **Why the agent did it (hypothesis):** the happy path was what the task
  described, and `fetch()` resolves on `4xx`/`5xx`, so nothing failed visibly
  during its own check.

## 4. Stale responses, double clicks and low contrast in the UI

- **Asked:** Task A, including "size of the target, contrast".
- **Produced:** (a) switching quickly between Оля and Тарас could render Оля's
  list under Тарас, because a late response overwrote a newer one; (b) buttons
  stayed enabled during a request, so a double click sent two requests; (c)
  borders used the seeded `#8884`, well below the 3:1 non-text contrast
  minimum. The agent's first fix for the error box used a red border that
  measured 2.97:1 in the dark theme — still below 3:1.
- **Noticed by:** review pass on 2026-09-16 for (a)–(c); the 2.97:1 value was
  caught by the agent's own contrast measurement while fixing (c).
- **Fixed:** a request counter drops stale responses, buttons are disabled
  while a request is in flight, colours are tokens with measured contrast
  (`--border`, `--muted`, a separate dark-theme red) (`f6b6cb4`).
- **Why the agent did it (hypothesis):** it tested one action at a time in a
  fast local browser, where timing problems do not show up, and it did not
  measure colours it inherited from the seeded CSS.

## 5. The archive button label came from the view, not the note

- **Asked:** Task A.
- **Produced:** the toggle text and action were computed from the current view
  (`archived ? "Повернути з архіву" : "Архівувати"`, where `archived` meant
  "the archive tab is open") (`e9cb6b0`). It worked only because each view
  lists notes of one state; any list that mixed states would show wrong labels
  and send the wrong value.
- **Noticed by:** code review on 2026-09-16. No visible symptom and no failing
  test.
- **Fixed:** the label and action read the note's own `archived` flag
  (`c9f5656`).
- **Why the agent did it (hypothesis):** the view variable was in scope and
  gave the right answer in every case it tried.

## 6. The pseudo-session accepted any number as a user

- **Asked:** Task C — walk every route and check where its data boundary
  comes from.
- **Produced:** the agent audited the five note routes but not the
  `currentUser` middleware in front of them. It kept the seeded check
  `Number(header)` + `Number.isInteger`, so `x-user-id: 1e0` was accepted as
  Оля, and an id with no user behind it was accepted as a caller:
  `GET /api/notes` as user `99` answered `200 []`, and `POST /api/notes` as
  user `99` failed on the foreign key and answered `500 {"error":"internal
  error"}`.
- **Noticed by:** a final review of Tasks A–D on 2026-09-19, reproduced on the
  committed code with supertest.
- **Fixed:** `currentUser` uses the same `parseId` as the routes and checks
  that the user exists; anything else is `401`. Tests: `rejects a user header
  that is not a plain positive integer` and `rejects a user id that does not
  exist` — both fail on the previous code.
- **Why the agent did it (hypothesis):** the walkthrough frames authentication
  as out of scope, so the agent treated the middleware as given and only
  checked what happens after it.

## 7. The first UI test suite was green but could not fail

- **Asked:** cover the UI with automated tests, so a regression like #5 is
  caught by a command and not by a reader.
- **Produced:** `app/test/ui.test.js` — 10 tests, green on the first run. Three
  of them asserted nothing a broken app could violate: the user-switch test, the
  "the change reaches the server" test, and the test for a failed request. The
  failure test rejected `fetch` with a network error, so it passed whether or
  not the page checked the HTTP status — the exact defect from #3 would have
  slipped through the suite written to prevent it.
- **Noticed by:** the mutation harness, extended to `public/app.js` in the same
  session. It reported `HTTP errors ignored 0/10 — killed nothing` and named the
  three tests no mutation could kill. Reading the tests did not reveal this;
  running them against a broken copy did.
- **Fixed:** a test that answers `500` from the server instead of failing the
  connection, and four more UI mutations (`change never sent`, `change failure
  swallowed`, `user switch ignored`, `HTTP errors ignored`). All 11 UI tests now
  fail on at least one mutation: `npm run test:mutations`.
- **Why the agent did it (hypothesis):** the tests were written against the code
  as it is, so each one described the current behaviour accurately. Nothing in
  writing them asks the question the harness asks — which broken version of this
  app would still pass?

## 8. The create form named its fields with a placeholder

- **Asked:** Task A — an accessible archive UI, and then an automated check
  that measures the accessibility claims instead of asserting them in prose.
- **Produced:** the seeded `app/public/index.html` named the two fields of the
  create form with `placeholder="Заголовок"` and `placeholder="Текст"` and
  nothing else. The agent reviewed that form, wrote 11 UI tests around it and a
  browser check for it, and left the placeholders as the names. A placeholder
  is a hint: it disappears as soon as the field has text, so a user who is
  interrupted mid-form has no way to be told what the field is (WCAG 3.3.2).
- **Noticed by:** CodeRabbit on pull request #11, after the branch was pushed:
  "The core note-creation form lacks persistent programmatic labels, making it
  harder for assistive-technology users to identify fields." Neither the UI
  suite nor `npm run check:a11y` had anything to say about it — the browser
  check asserted accessible names for `button` nodes only, and Chrome computes
  a name for a `textbox` from its placeholder, so the field appeared named in
  the tree that was printed as evidence.
- **Fixed:** a `<label for>` per field, visually hidden and present in the
  accessibility tree (`visually-hidden` in `app/public/style.css`). The check
  that missed it now reads the DOM rather than the computed name — it fails
  when a field has no label, and separately when its name equals its own
  placeholder — and `textbox` and `combobox` nodes are held to the same
  accessible-name rule as buttons. A test (`names each field with a label, not
  with placeholder text alone`) and a mutation (`fields named by placeholder
  only`, which deletes the labels again) keep it that way.
- **Why the agent did it (hypothesis):** the fields were seeded code that the
  task did not ask it to touch, and the accessibility work went to the controls
  it added itself. Its own check then confirmed the result, because the check
  asked the browser for a name and the browser answered with the placeholder —
  the measurement agreed with the mistake.

## 9. Process mistakes

- **Task B work committed under a Task A title.** The first local commit,
  "Task A: archive / restore notes in the UI", also contained the schema change
  and the endpoint. Noticed in review; split into
  `e94227f` (Task B) and `e9cb6b0` (Task A) before anything was pushed.
- **A change outside the project without asking.** While writing a helper
  script, the agent tried to add a line to `~/.zshrc`. The edit was refused in
  the permission prompt; the agent then asked, and the line was never added.

---

## What the agent did well where problems were expected

- **Owner check inside the query from the first version.** The first `PATCH`
  already used `UPDATE … WHERE id = ? AND user_id = ?`, so another user's note
  answers `404`, like a missing one. Removing `AND user_id = ?` in a scratch
  copy turns `will not archive someone else's note` red.
- **No data loss on the schema change.** `createDb()` adds `archived` with
  `ALTER TABLE` when an existing `notes.db` lacks it; a test builds a
  pre-feature database file and checks that its notes survive and that a second
  start does not fail.
- **No extra fields.** Every query lists its columns; `user_id` is never
  returned, and the archive test compares the whole response with `toEqual`.
- **Strict input.** `archived` must be a real boolean: `"true"`, `1`, `null`
  and a missing value answer `400`.

## What was checked and turned out clean

- **Every endpoint as the wrong user.** Оля reading, archiving or deleting
  note 3 gets `404`; her archive list stays empty after Тарас archives note 3;
  `POST` with `"user_id": 2` in the body still creates the note for Оля; no
  `x-user-id` header, a malformed one, or an unknown user gets `401`. All five routes take their data boundary from
  the caller, not only from the id.
- **The Task C read test catches the leak.** With the pre-fix query
  (`WHERE id = ?`) Оля received Тарас's note: `200
  {"id":3,"user_id":2,"title":"Приватна нотатка Тараса","body":"пароль від
  сейфа: 1234",…}`. On that code `will not read someone else's note` fails with
  `expected 404 "Not Found", got 200 "OK"`; on the fixed code it passes.
- **The list scope is tested.** Removing `user_id = ?` from the list query in a
  scratch copy turns 9 tests red, including `keeps someone else's archived note
  out of the caller's archive`.
- **Browser.** Checked by hand in Chrome on 2026-09-16: archive, restore, the
  empty archive, switching users. That check is now a command rather than a
  memory: `cd app && npm run check:a11y` drives headless Chrome through the same
  flow, dumps the accessibility tree at each step, and fails if a control has no
  accessible name, is smaller than 44x44 px, or misses its contrast threshold
  (`app/scripts/a11y-check.mjs`), or is named by its own placeholder rather
  than by a label. Measured on 2026-09-20: borders `4.54:1` light
  and `5.79:1` dark against a `3:1` minimum, timestamp text `7:1` and `8.93:1`
  against `4.5:1`, every control `109x44` or larger. Tree as Оля (excerpt,
  relevant nodes only):

  ```text
  1. Active view
    button "Активні" pressed=true
    button "Архів" pressed=false
    heading "Активні нотатки" level=2
    button "Архівувати: Список покупок"        (109x44 px)
    button "Видалити: Список покупок"
    button "Архівувати: Ідеї для відпустки"
    button "Видалити: Ідеї для відпустки"
  2. After archiving "Список покупок", archive view
    button "Активні" pressed=false
    button "Архів" pressed=true
    heading "Архів" level=2
    button "Повернути з архіву: Список покупок"
    button "Видалити: Список покупок"
  3. After restoring it, archive view
    heading "Архів" level=2
    status  (visible) "В архіві порожньо. Архівовані нотатки з'являться тут."
  ```
- **Repository hygiene.** No `.env` or `*.db` file is tracked; no credentials in
  the diff.
