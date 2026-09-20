# Task E (bonus) — path 3: an authorization test suite

**What was done:** every endpoint under `/api` is walked by a caller who does
not own the record, and by a caller who is not a user at all. The suite lives
in `app/test/authz.test.js` (23 tests) and runs with the rest: `cd app &&
npm test` — 47 tests, green.

Seed data: notes 1 and 2 belong to Оля (id 1), note 3 to Тарас (id 2). Note 3
carries an obvious marker in its body (`пароль від сейфа: 1234`), so a leak is
visible in the response text rather than inferred from a status code.

## The matrix

Requests made as Оля (`x-user-id: 1`) against Тарас's note 3.

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

Two properties are checked beyond the status code:

- **The refusal is visible in the data.** After each refused write, the note is
  read back as its owner. A handler that answered `404` and still performed the
  `UPDATE` or `DELETE` would pass on the status code alone and fail here.
- **No existence oracle.** Someone else's note and a note that does not exist
  answer identically (`404 {"error":"not found"}`), so the API cannot be used
  to enumerate which ids are taken.

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

A green suite proves nothing until it has been seen red. The owner condition was
removed from every single-record query in a throwaway copy of `app/src`
(`WHERE id = ? AND user_id = ?` → `WHERE id = ?`, and the matching bound
parameter dropped) and the same suite was run against it: **5 of 23 tests
failed**, all in the "the wrong user" group — `GET`, `PATCH` (archive),
`PATCH` (restore), `DELETE`, and the existence-oracle test.

To reproduce, from the repository root:

```bash
cd app
rm -rf /tmp/authz-mutation && mkdir -p /tmp/authz-mutation
cp -R src test package.json /tmp/authz-mutation/
ln -s "$PWD/node_modules" /tmp/authz-mutation/node_modules
cd /tmp/authz-mutation
node -e "const f='src/app.js',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/ AND user_id = \?/g,'').replace(/, req\.userId\)/g,')'))"
npx vitest run test/authz.test.js
```

The mutation touches only the queries that take an id from the URL; the list
query (`WHERE user_id = ? AND archived = ?`) and the insert keep their owner.
Nothing under `app/` is modified — the copy lives in `/tmp` and `node_modules`
is a symlink, not a second install.

What the mutated copy answered Оля for note 3:

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

## What the sweep found

No additional gap. Every route already scoped its query to `req.userId`, and the
one seeded hole — `GET /api/notes/:id` — was found and fixed in Task C
(`9d24b59`), before this suite existed.

Four things the sweep made explicit that were not obvious beforehand:

1. **The list endpoint is not the risk, and it hides the risk.** `GET /api/notes`
   answered correctly even on the fully broken copy, because its filter is
   `WHERE user_id = ?` — there is no id from the client to trust. Any suite that
   checks authorization only through lists stays green over a leaking API. The
   damage is concentrated in the routes that take an id from the URL.
2. **`POST` needed a test even though it takes no id.** The route builds the row
   from `req.userId` and ignores everything else in the body, which is correct —
   but that is a property worth pinning down, because the natural "improvement"
   of spreading `req.body` into the insert would hand the client its own
   `user_id` and `archived`.
3. **Assertion order decides what a failure tells you.** The read test first
   asserted the status and then the absence of the note's content. Supertest's
   `.expect(404)` throws, so on the mutated copy the content assertion never
   ran: the failure read "expected 404, got 200" — true, but it does not say a
   secret crossed the wire. Asserting the body before the status changed the
   same failure into the line quoted above, which names the leak. The test was
   never wrong; it just could not describe what it had caught.
4. **The read-back is insurance the status code cannot give.** All five
   failures on the mutated copy were reachable from the response alone, because
   those handlers answered `200`/`204` outright. The read-back covers the
   failure mode that mutation does not produce: a handler that answers `404`
   and performs the write anyway. That one is invisible to a suite that stops
   at the response, and it is the more likely shape of a real regression, since
   the refusal branch and the query are edited separately.
