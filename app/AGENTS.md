# AGENTS.md — notes app

Guidance for an Agentic IDE working inside `app/`.

## Stack

- Node 22+ (`engines` in `package.json`; recommended version in root
  `.nvmrc`), ESM (`"type": "module"`)
- Express for the HTTP layer
- SQLite via `better-sqlite3` (synchronous API — no await on queries).
  Pinned to `^13.0.3`: v11 has no prebuilt binary for Node 26 and its
  source build fails there. Do not downgrade.
- vitest + supertest for the API tests; vitest + jsdom for the UI tests
  (`test/ui.test.js` runs `public/app.js` against a real server, so the UI has
  regression cover without a browser in the loop). jsdom is a devDependency —
  it never reaches the application.
- The UI is plain HTML/CSS/JS served statically. **No build step. No framework.**

## Commands

```bash
npm install
npm test              # vitest run (API, authorization and UI suites)
npm run dev           # http://localhost:3080 (writes notes.db)
npm run test:mutations  # break the app on purpose, check the authz and UI suites notice
npm run check:a11y      # drive the UI in headless Chrome, dump its accessibility tree
```

`test:mutations` and `check:a11y` are evidence, not gates: they are not part of
`npm test`. The first needs no browser; the second needs Chrome installed.

## Architecture

- `src/db.js` — `createDb(file)` builds the schema and seeds it. Tests call it
  with `:memory:` so each test file is isolated; `server.js` passes a filename.
- `src/app.js` — `createApp(db)` returns the Express app. All routes live here.
  The `currentUser` middleware reads the `x-user-id` header and sets
  `req.userId`; everything under `/api` requires it.
- `src/server.js` — composition root. Nothing but wiring.
- `public/` — the UI. `app.js` there talks to the API with `fetch` and sends
  the same `x-user-id` header, chosen by the dropdown.

## Conventions

- Keep route handlers thin and readable; this code is meant to be reviewed.
- SQL goes through `db.prepare(...)` with **bound parameters**, never string
  concatenation.
- Tests are named after the behaviour they check, and each new route gets a
  test for the caller's own data **and** a test for someone else's.

## Guardrails

- **Scope every single-record query to the caller**, not only to the id.
  `WHERE id = ?` is almost never the whole condition in this app.
- Validate input **on the server**. `required` in the HTML does not count.
- Do not return columns the caller has no business seeing.
- Do not change the `x-user-id` scheme — simplified auth is intentional.
- Do not break the seeded users or tables; the tests depend on them.
- Never commit `notes.db`.
