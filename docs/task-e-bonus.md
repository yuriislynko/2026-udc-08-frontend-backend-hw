# Task E (bonus) — path 3: an authorization test suite

**What was done:** every endpoint under `/api` is walked by a caller who does
not own the record, and by a caller who is not a user at all. The suite lives
in `app/test/authz.test.js` (30 tests) and runs with the rest: `cd app &&
npm test` — 54 tests, green.

Seed data: notes 1 and 2 belong to Оля (id 1), note 3 to Тарас (id 2). Note 3
carries an obvious marker in its body (`пароль від сейфа: 1234`), so a leak is
visible in the response text rather than inferred from a status code; note 1
(`хліб, кава`) serves the same purpose in the opposite direction.

## The matrix

Each crossing runs in both directions — as Оля against Тарас's note 3, and as
Тарас against Оля's note 1. The table gives the Оля → Тарас values; the
mirrored direction answers the same way with its own ids.

| Endpoint | As the wrong user | Expected | Actual |
|---|---|---|---|
| `GET /api/notes` | list the notes | only the caller's own ids | `200`, ids `[1, 2]` — note 3 absent |
| `GET /api/notes?archived=true` | list the archive after Тарас archived note 3 | caller's archive only | `200`, `[]` |
| `GET /api/notes/:id` | read note 3 | refused, nothing of the content in the response | `404 {"error":"not found"}` |
| `POST /api/notes` | create with `user_id: 2` and `archived: true` in the body | body ignored, note belongs to the caller and starts active | `201`, note 4 owned by Оля, `archived: false`; Тарас's list unchanged |
| `PATCH /api/notes/:id` (archive) | archive note 3 | refused, note 3 unchanged | `404`; note 3 still `archived: false` for Тарас |
| `PATCH /api/notes/:id` (restore) | restore note 3 after Тарас archived it | refused, note 3 stays archived | `404`; note 3 still `archived: true` for Тарас |
| `DELETE /api/notes/:id` | delete note 3 | refused, note 3 still readable by Тарас | `404`; note 3 present, title intact |
| every route above | no `x-user-id` header | refused before any query | `401 {"error":"not authenticated"}` |
| every route above | `x-user-id: 99` (not a user) | refused | `401 {"error":"not authenticated"}` |
| `GET /api/notes` | `x-user-id: 1, 2`, `+1`, `01`, `1;2`, `1/../2`, empty | refused | `401 {"error":"not authenticated"}` |
| `GET /api/notes` | `x-user-id: " 1"` / `"1 "` (padded) | 200 as user 1 — see below | `200`, ids `[1, 2]` |

Three properties are checked beyond the status code:

- **The refusal is visible in the data.** After each refused write, the note is
  read back as its owner. A handler that answered `404` and still performed the
  `UPDATE` or `DELETE` would pass on the status code alone and fail here.
- **No existence oracle.** Someone else's note and a note that does not exist
  answer identically (`404 {"error":"not found"}`), so the API cannot be used
  to enumerate which ids are taken. Asserted on `GET`, `PATCH` and `DELETE`
  separately: each route has its own refusal branch, and one of them drifting
  to a different status or message would be enough to tell the two cases
  apart.
- **Neither user is privileged.** The crossings are a `describe.each` over both
  directions, so a handler that resolved the caller to a fixed id instead of
  reading the request cannot stay green.

The suite also asserts the response shape on every route, including the
archived list: exactly `id`, `title`, `body`, `created_at`, `archived`.
`user_id` never reaches the client.

The padded header is the one row where the expected answer is not a refusal.
`" 1"` and `"1 "` are accepted as user 1, and that is correct rather than
tolerant: HTTP strips the whitespace around a field value in the parser, so
`parseId` is handed a bare `"1"` and no padded form ever reaches it. The row is
in the suite because the obvious reading of that 200 — "the app tolerates
spaces" — is wrong, and acting on it by adding a `trim()` would widen what the
app really accepts.

## Whether the tests actually bite

A green suite proves nothing until it has been seen red. `app/scripts/mutation-check.mjs`
breaks the app on purpose, once per failure mode, and records which tests notice:

```bash
cd app && npm run test:mutations
```

Each run copies `src`, `test` and `package.json` to a temp directory and
symlinks `node_modules`. Nothing under `app/` is modified and there is no
second install. The run fails if a mutation kills no tests, if a mutation no
longer applies to `src/app.js` after a refactor, or if a test survives every
mutation.

| Mutation | What it breaks | Killed |
|---|---|---|
| no owner condition | `WHERE id = ? AND user_id = ?` → `WHERE id = ?` in every single-record query | 10 / 30 |
| one fixed caller | `req.userId = id` → `req.userId = 1` in the session middleware | 13 / 30 |
| owner taken from the body | the insert trusts `user_id` and `archived` from the request body | 2 / 30 |
| widened response | handlers `SELECT *`, so `user_id` reaches the client | 1 / 30 |
| lax id parsing | the header is parsed with `Number()` alone, so `+1` and `01` resolve to a user | 1 / 30 |
| no session guard | the middleware never refuses, so an absent or unknown caller reaches the handlers | 14 / 30 |

**29 of 30 tests fail on at least one mutation.** The survivor is named in the
script with its reason: `is not bypassed by padding the header with spaces`
cannot be killed from inside the app, because HTTP strips the padding in the
parser before any application code runs. It is a characterization test — it
records why that `200` is correct, so that the plausible "fix" of adding a
`trim()` is not applied later.

Two of the mutations carry a finding beyond their count.

**No owner condition** is the seeded hole, re-opened. The five id-taking
crossings fail in each direction — read, existence oracle, archive, restore,
delete — while `GET /api/notes` stays green, because its filter is
`WHERE user_id = ?` and there is no id from the client to trust. What the
mutated copy answered Оля for note 3:

```
GET    /api/notes/3  -> 200 {"id":3,"title":"Приватна нотатка Тараса","body":"пароль від сейфа: 1234",…}
PATCH  /api/notes/3  -> 200 (archived Тарас's note)
DELETE /api/notes/3  -> 204 (deleted it)
GET    /api/notes    -> 200 ids [1,2]   ← the list stayed correct
```

and how the suite reported the read:

```
AssertionError: expected '{"id":3,"title":"Приватна нотатка Тар…' not to contain 'пароль від сейфа'
```

**One fixed caller** is the mutation that justifies running both directions. In
the Оля direction the failures are mostly setup noise — requests made *as
Тарас* to prepare the case come back as Оля — while the Тарас direction names
the leak outright:

```
AssertionError: expected '{"id":1,"title":"Список покупок","bod…' not to contain 'хліб, кава'
```

## What the sweep found

No additional gap. Every route already scoped its query to `req.userId`, and the
one seeded hole — `GET /api/notes/:id` — was found and fixed in Task C, before
this suite existed.

Five things the sweep made explicit that were not obvious beforehand:

1. **The list endpoint is not the risk, and it hides the risk.** `GET /api/notes`
   answered correctly even on the copy with no owner condition, because its
   filter is `WHERE user_id = ?` — there is no id from the client to trust. Any
   suite that checks authorization only through lists stays green over a leaking
   API. The damage is concentrated in the routes that take an id from the URL.
2. **`POST` needed a test even though it takes no id.** The route builds the row
   from `req.userId` and ignores everything else in the body, which is correct —
   but the natural "improvement" of spreading `req.body` into the insert would
   hand the client its own `user_id` and `archived`. That is the "owner taken
   from the body" mutation, and it is the only one those two tests catch: no
   other mutation touches them.
3. **Assertion order decides what a failure tells you.** The read test first
   asserted the status and then the absence of the note's content. Supertest's
   `.expect(404)` throws, so on the mutated copy the content assertion never
   ran: the failure read "expected 404, got 200" — true, but it does not say a
   secret crossed the wire. Asserting the body before the status changed the
   same failure into the line quoted above, which names the leak. The test was
   never wrong; it just could not describe what it had caught.
4. **The read-back is insurance the status code cannot give.** Every failure
   under mutation 1 was reachable from the response alone, because those
   handlers answered `200`/`204` outright. The read-back covers the failure mode
   that mutation does not produce: a handler that answers `404` and performs the
   write anyway. That one is invisible to a suite that stops at the response,
   and it is the more likely shape of a real regression, since the refusal
   branch and the query are edited separately.
5. **One direction is half a test.** The first version of this suite only sent
   Оля at Тарас's note. Mutation 2 is the case it describes badly: with every
   caller resolved to user 1, Оля's own requests stay correct, so the Оля
   crossings fail on their setup steps rather than on a leak. Running the same
   crossings as Тарас turns the same bug into an assertion that quotes the
   leaked body.
