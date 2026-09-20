/**
 * Task E, path 3 — the authorization matrix.
 *
 * The seeded suite checks each route with its own owner. This file does the
 * opposite pass: every route is walked by a caller who does not own the
 * record, and by a caller who is not a user at all. A route passes only when
 * the refusal is visible in the data afterwards — a 404 that still deleted the
 * row would satisfy the status code alone.
 *
 * Seed data: notes 1 and 2 belong to Оля (id 1), note 3 to Тарас (id 2).
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

let app;
beforeEach(() => {
  app = createApp(createDb(":memory:"));
});

const asOlya = (r) => r.set("x-user-id", "1");
const asTaras = (r) => r.set("x-user-id", "2");

const OTHERS_NOTE = 3; // belongs to Тарас
const SECRET = "пароль від сейфа"; // body of note 3

// Every route under /api, so the unauthenticated sweep cannot miss one.
const routes = [
  { name: "GET /api/notes", call: (agent) => agent.get("/api/notes") },
  { name: "GET /api/notes?archived=true", call: (agent) => agent.get("/api/notes?archived=true") },
  { name: "GET /api/notes/:id", call: (agent) => agent.get("/api/notes/1") },
  { name: "POST /api/notes", call: (agent) => agent.post("/api/notes").send({ title: "Нова" }) },
  { name: "PATCH /api/notes/:id", call: (agent) => agent.patch("/api/notes/1").send({ archived: true }) },
  { name: "DELETE /api/notes/:id", call: (agent) => agent.delete("/api/notes/1") },
];

describe("no caller at all", () => {
  for (const route of routes) {
    it(`${route.name} refuses a request with no user header`, async () => {
      await route.call(request(app)).expect(401);
    });

    it(`${route.name} refuses a user id that does not exist`, async () => {
      await route.call(request(app)).set("x-user-id", "99").expect(401);
    });
  }

  it("refuses a user header that is not a bare id", async () => {
    // "1, 2" is what Node builds when the header arrives twice; the rest are
    // the forms a hand-edited request sends. None of them names one user.
    for (const id of ["1, 2", "+1", "01", "1;2", "1/../2", ""]) {
      await asOlya(request(app).get("/api/notes")).set("x-user-id", id).expect(401);
    }
  });

  it("is not bypassed by padding the header with spaces", async () => {
    // " 1" and "1 " answer 200 as user 1, and that is correct: HTTP strips the
    // whitespace around a field value in the parser, so `parseId` is handed a
    // bare "1" and there is no padded form for it to accept. Pinned here
    // because the obvious reading — "the app tolerates spaces" — is wrong and
    // would invite a trim() that really does widen what is accepted.
    for (const id of [" 1", "1 "]) {
      const res = await request(app).get("/api/notes").set("x-user-id", id).expect(200);
      expect(res.body.map((n) => n.id)).toEqual([1, 2]);
    }
  });

  it("leaves the data untouched after the refused writes", async () => {
    for (const route of routes) {
      await route.call(request(app)).expect(401);
      await route.call(request(app)).set("x-user-id", "99").expect(401);
    }

    const olya = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(olya.body.map((n) => n.id)).toEqual([1, 2]);
    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body.map((n) => n.id)).toEqual([3]);
  });
});

describe("the wrong user", () => {
  it("GET /api/notes never lists someone else's note, archived or not", async () => {
    await asTaras(request(app).patch(`/api/notes/${OTHERS_NOTE}`))
      .send({ archived: true })
      .expect(200);

    const active = await asOlya(request(app).get("/api/notes")).expect(200);
    const archived = await asOlya(request(app).get("/api/notes?archived=true")).expect(200);
    expect([...active.body, ...archived.body].map((n) => n.id)).toEqual([1, 2]);
  });

  it("GET /api/notes/:id refuses to read it and leaks nothing of its content", async () => {
    // The content check comes first on purpose. `.expect(404)` throws, so
    // asserting the status before the body would skip the leak check on
    // exactly the build that leaks.
    const res = await asOlya(request(app).get(`/api/notes/${OTHERS_NOTE}`));
    expect(res.text).not.toContain(SECRET);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  it("GET /api/notes/:id answers someone else's note exactly as a missing one", async () => {
    const theirs = await asOlya(request(app).get(`/api/notes/${OTHERS_NOTE}`)).expect(404);
    const missing = await asOlya(request(app).get("/api/notes/999")).expect(404);
    expect(theirs.body).toEqual(missing.body);
  });

  it("POST /api/notes ignores an owner named in the body", async () => {
    const res = await asOlya(request(app).post("/api/notes"))
      .send({ title: "Підкинута", body: "текст", user_id: 2, archived: true })
      .expect(201);
    expect(res.body.archived).toBe(false);

    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body.map((n) => n.id)).toEqual([OTHERS_NOTE]);
    const olya = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(olya.body.map((n) => n.title)).toContain("Підкинута");
  });

  it("PATCH /api/notes/:id refuses to archive it and leaves its state alone", async () => {
    await asOlya(request(app).patch(`/api/notes/${OTHERS_NOTE}`))
      .send({ archived: true })
      .expect(404);

    const note = await asTaras(request(app).get(`/api/notes/${OTHERS_NOTE}`)).expect(200);
    expect(note.body.archived).toBe(false);
  });

  it("PATCH /api/notes/:id refuses to restore it either", async () => {
    await asTaras(request(app).patch(`/api/notes/${OTHERS_NOTE}`))
      .send({ archived: true })
      .expect(200);

    await asOlya(request(app).patch(`/api/notes/${OTHERS_NOTE}`))
      .send({ archived: false })
      .expect(404);

    const note = await asTaras(request(app).get(`/api/notes/${OTHERS_NOTE}`)).expect(200);
    expect(note.body.archived).toBe(true);
  });

  it("DELETE /api/notes/:id refuses and the note is still there for its owner", async () => {
    await asOlya(request(app).delete(`/api/notes/${OTHERS_NOTE}`)).expect(404);

    const note = await asTaras(request(app).get(`/api/notes/${OTHERS_NOTE}`)).expect(200);
    expect(note.body.title).toBe("Приватна нотатка Тараса");
  });
});

describe("the response body", () => {
  it("carries no column the caller has no business seeing", async () => {
    const list = await asOlya(request(app).get("/api/notes")).expect(200);
    const one = await asOlya(request(app).get("/api/notes/1")).expect(200);
    await asOlya(request(app).patch("/api/notes/2")).send({ archived: true }).expect(200);
    const archived = await asOlya(request(app).get("/api/notes?archived=true")).expect(200);
    const created = await asOlya(request(app).post("/api/notes"))
      .send({ title: "Нова" })
      .expect(201);
    const patched = await asOlya(request(app).patch("/api/notes/1"))
      .send({ archived: true })
      .expect(200);

    const fields = ["id", "title", "body", "created_at", "archived"];
    for (const note of [...list.body, ...archived.body, one.body, created.body, patched.body]) {
      expect(Object.keys(note).sort()).toEqual([...fields].sort());
    }
  });
});
