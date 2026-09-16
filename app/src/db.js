import Database from "better-sqlite3";

/**
 * Schema + seed data. In-memory by default so tests are isolated and nobody
 * has to run a migration to get started; `server.js` uses a file so the UI
 * keeps its data between restarts.
 *
 * Everything here is synthetic.
 */
export function createDb(file = ":memory:") {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id    INTEGER PRIMARY KEY,
      name  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      title     TEXT NOT NULL,
      body      TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived  INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
    );
  `);

  // Migration for a notes.db created before the archive feature: add the
  // column in place. Existing rows get the default (0 = not archived), so no
  // data is lost.
  const hasArchived = db
    .prepare("SELECT 1 FROM pragma_table_info('notes') WHERE name = 'archived'")
    .get();
  if (!hasArchived) {
    db.exec(
      "ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))",
    );
  }

  const seeded = db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0;
  if (!seeded) {
    db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(1, "Оля");
    db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(2, "Тарас");
    const ins = db.prepare("INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)");
    ins.run(1, "Список покупок", "хліб, кава");
    ins.run(1, "Ідеї для відпустки", "Карпати восени");
    ins.run(2, "Приватна нотатка Тараса", "пароль від сейфа: 1234");
  }

  return db;
}
