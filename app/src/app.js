import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Pretend session. A real app would verify a signed cookie or a JWT here;
 * that is deliberately out of scope — this workshop is about what happens
 * AFTER you know who the caller is.
 *
 * The caller identifies itself with the `x-user-id` header. Seeded users are
 * 1 (Оля) and 2 (Тарас). The header must name an existing user; an unknown id
 * is not a caller, so it gets 401 rather than an empty list or a failed insert.
 */
function currentUser(db) {
  const userExists = db.prepare("SELECT 1 FROM users WHERE id = ?");
  return (req, res, next) => {
    const id = parseId(req.header("x-user-id") ?? "");
    if (id === null || !userExists.get(id)) {
      return res.status(401).json({ error: "not authenticated" });
    }
    req.userId = id;
    next();
  };
}

// Route ids are positive integers written as plain digits; anything else is a
// bad request, not a lookup that happens to find nothing. The pattern check
// comes first because Number() also accepts forms like "0x1" and "1e0".
function parseId(raw) {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// SQLite stores the flag as 0/1; the API speaks booleans.
function toNote(row) {
  return { ...row, archived: row.archived === 1 };
}

export function createApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.static(resolve(here, "../public")));

  app.use("/api", currentUser(db));

  // List the caller's own notes: active ones by default, archived ones with
  // ?archived=true.
  app.get("/api/notes", (req, res) => {
    const { archived = "false" } = req.query;
    if (archived !== "true" && archived !== "false") {
      return res.status(400).json({ error: "archived must be true or false" });
    }
    const rows = db
      .prepare(
        "SELECT id, title, body, created_at, archived FROM notes WHERE user_id = ? AND archived = ? ORDER BY id",
      )
      .all(req.userId, archived === "true" ? 1 : 0);
    res.json(rows.map(toNote));
  });

  // Read one of the caller's own notes. The owner check is part of the query,
  // so someone else's note is indistinguishable from a missing one.
  app.get("/api/notes/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid note id" });
    const note = db
      .prepare("SELECT id, title, body, created_at, archived FROM notes WHERE id = ? AND user_id = ?")
      .get(id, req.userId);
    if (!note) return res.status(404).json({ error: "not found" });
    res.json(toNote(note));
  });

  // Create a note for the caller.
  app.post("/api/notes", (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    if (!title) return res.status(400).json({ error: "title is required" });

    const info = db
      .prepare("INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)")
      .run(req.userId, title, body);
    const created = db
      .prepare("SELECT id, title, body, created_at, archived FROM notes WHERE id = ?")
      .get(info.lastInsertRowid);
    res.status(201).json(toNote(created));
  });

  // Archive or restore one of the caller's own notes. The owner check is part
  // of the UPDATE itself, so someone else's note is indistinguishable from a
  // missing one. RETURNING reads the new row inside the same statement: a
  // separate SELECT afterwards could find nothing if another connection
  // deleted the row in between, and would answer 500 instead of 404.
  app.patch("/api/notes/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid note id" });
    const archived = req.body?.archived;
    if (typeof archived !== "boolean") {
      return res.status(400).json({ error: "archived must be a boolean" });
    }

    const updated = db
      .prepare(
        "UPDATE notes SET archived = ? WHERE id = ? AND user_id = ? RETURNING id, title, body, created_at, archived",
      )
      .get(archived ? 1 : 0, id, req.userId);
    if (!updated) return res.status(404).json({ error: "not found" });

    res.json(toNote(updated));
  });

  // Delete one of the caller's own notes.
  app.delete("/api/notes/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid note id" });
    const info = db
      .prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
      .run(id, req.userId);
    if (info.changes === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  // Express's default error page is HTML with a stack trace, which exposes
  // server file paths. Answer in JSON and keep the details in the server log.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid JSON" });
    }
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
