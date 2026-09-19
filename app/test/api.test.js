import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

let app;
beforeEach(() => {
  app = createApp(createDb(":memory:"));
});

const asOlya = (r) => r.set("x-user-id", "1");
const asTaras = (r) => r.set("x-user-id", "2");

describe("authentication", () => {
  it("rejects a request with no user header", async () => {
    await request(app).get("/api/notes").expect(401);
  });
});

describe("GET /api/notes", () => {
  it("returns only the caller's own notes", async () => {
    const res = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((n) => n.title)).toEqual([
      "Список покупок",
      "Ідеї для відпустки",
    ]);
  });

  it("gives a different user a different list", async () => {
    const res = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("POST /api/notes", () => {
  it("creates a note owned by the caller", async () => {
    const res = await asOlya(request(app).post("/api/notes"))
      .send({ title: "Нова", body: "текст" })
      .expect(201);
    expect(res.body.title).toBe("Нова");

    const list = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(list.body).toHaveLength(3);
  });

  it("rejects an empty title", async () => {
    await asOlya(request(app).post("/api/notes")).send({ title: "  " }).expect(400);
  });
});

describe("GET /api/notes/:id", () => {
  it("returns the caller's own note", async () => {
    const res = await asOlya(request(app).get("/api/notes/1")).expect(200);
    expect(res.body).toEqual({
      id: 1,
      title: "Список покупок",
      body: "хліб, кава",
      created_at: expect.any(String),
      archived: false,
    });
  });

  it("404s for a note that does not exist", async () => {
    await asOlya(request(app).get("/api/notes/999")).expect(404);
  });

  it("will not read someone else's note", async () => {
    const res = await asOlya(request(app).get("/api/notes/3")).expect(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  it("rejects an invalid note id", async () => {
    for (const id of ["abc", "0", "-1", "1.5", "0x1", "1e0"]) {
      await asOlya(request(app).get(`/api/notes/${id}`)).expect(400);
    }
  });
});

describe("DELETE /api/notes/:id", () => {
  it("deletes the caller's own note", async () => {
    await asOlya(request(app).delete("/api/notes/1")).expect(204);
    const list = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it("will not delete someone else's note", async () => {
    await asOlya(request(app).delete("/api/notes/3")).expect(404);
    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body).toHaveLength(1);
  });

  it("rejects an invalid note id", async () => {
    for (const id of ["abc", "0", "-1", "1.5", "0x1", "1e0"]) {
      await asOlya(request(app).delete(`/api/notes/${id}`)).expect(400);
    }
  });
});

describe("PATCH /api/notes/:id (archive)", () => {
  it("archives the caller's own note and moves it to the archived list", async () => {
    const res = await asOlya(request(app).patch("/api/notes/1"))
      .send({ archived: true })
      .expect(200);
    expect(res.body).toEqual({
      id: 1,
      title: "Список покупок",
      body: "хліб, кава",
      created_at: expect.any(String),
      archived: true,
    });

    const active = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(active.body.map((n) => n.id)).toEqual([2]);
    const archived = await asOlya(request(app).get("/api/notes?archived=true")).expect(200);
    expect(archived.body.map((n) => n.id)).toEqual([1]);
  });

  it("restores an archived note", async () => {
    await asOlya(request(app).patch("/api/notes/1")).send({ archived: true }).expect(200);
    const res = await asOlya(request(app).patch("/api/notes/1"))
      .send({ archived: false })
      .expect(200);
    expect(res.body.archived).toBe(false);

    const active = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(active.body.map((n) => n.id)).toEqual([1, 2]);
  });

  it("rejects a non-boolean archived value", async () => {
    for (const archived of ["true", 1, null, undefined]) {
      await asOlya(request(app).patch("/api/notes/1")).send({ archived }).expect(400);
    }
  });

  it("answers malformed JSON with a short JSON error, not a stack trace", async () => {
    const res = await asOlya(request(app).patch("/api/notes/1"))
      .set("content-type", "application/json")
      .send("not json at all")
      .expect(400)
      .expect("content-type", /json/);
    expect(res.body).toEqual({ error: "invalid JSON" });
  });

  it("rejects an invalid note id", async () => {
    for (const id of ["abc", "0", "-1", "1.5", "0x1", "1e0"]) {
      await asOlya(request(app).patch(`/api/notes/${id}`)).send({ archived: true }).expect(400);
    }
  });

  it("404s for a note that does not exist", async () => {
    await asOlya(request(app).patch("/api/notes/999")).send({ archived: true }).expect(404);
  });

  it("will not archive someone else's note", async () => {
    await asOlya(request(app).patch("/api/notes/3")).send({ archived: true }).expect(404);
    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body.map((n) => n.id)).toEqual([3]);
  });

  it("rejects an invalid archived filter on the list", async () => {
    await asOlya(request(app).get("/api/notes?archived=yes")).expect(400);
  });
});

describe("schema migration", () => {
  it("adds the archived column to a database created before the feature, keeping its notes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ws08-"));
    const file = join(dir, "notes.db");
    try {
      // The notes table as it was before the archive feature.
      const old = new Database(file);
      old.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE notes (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id   INTEGER NOT NULL REFERENCES users(id),
          title     TEXT NOT NULL,
          body      TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users (id, name) VALUES (1, 'Оля');
        INSERT INTO notes (user_id, title) VALUES (1, 'Before the migration');
      `);
      old.close();

      const db = createDb(file);
      expect(db.prepare("SELECT id, title, archived FROM notes").all()).toEqual([
        { id: 1, title: "Before the migration", archived: 0 },
      ]);
      db.close();

      // Opening it again must not try to add the column a second time.
      createDb(file).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
