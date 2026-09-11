import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { isHermesFeed } from "../src/hermes-model.ts";
import { readHermesFeed } from "./hermes.ts";

test("reads a bounded, redacted, human-readable Hermes feed", () => {
  const dir = mkdtempSync(join(tmpdir(), "fox-hermes-"));
  const path = join(dir, "kanban.db");
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, result TEXT,
        workspace_path TEXT, session_id TEXT, assignee TEXT, status TEXT NOT NULL,
        priority INTEGER NOT NULL, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER
      );
      CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, created_at INTEGER);
    `);
    const insert = db.prepare(`INSERT INTO tasks
      (id,title,body,result,workspace_path,session_id,assignee,status,priority,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insert.run("t_aaaaaaaa", "  Prepare   timetable  ", "private body", "private result", "/private", "uuid", "semyon-human", "scheduled", 4, 100);
    insert.run("t_bbbbbbbb", "t_bbbbbbbb", "private", null, null, null, "worker", "running", 3, 200);
    insert.run("t_cccccccc", "Old item", null, null, null, null, null, "archived", 1, 300);
    db.prepare("INSERT INTO task_events (id,task_id,created_at) VALUES (1,?,?)").run("t_aaaaaaaa", 150);

    const feed = readHermesFeed({ dbPath: path, now: () => new Date("2026-09-11T09:00:00Z") });
    assert.equal(feed.state, "connected");
    assert.ok(isHermesFeed(feed));
    if (feed.state !== "connected") return;
    assert.equal(feed.board.total, 2);
    assert.deepEqual(feed.board.tasks.map(({ title, status, owner, updatedAt }) => ({ title, status, owner, updatedAt })), [
      { title: "Untitled task", status: "running", owner: "agent", updatedAt: "1970-01-01T00:03:20.000Z" },
      { title: "Prepare timetable", status: "scheduled", owner: "human", updatedAt: "1970-01-01T00:02:30.000Z" },
    ]);
    for (const task of feed.board.tasks) {
      assert.deepEqual(Object.keys(task).sort(), ["id", "owner", "priority", "status", "title", "updatedAt"]);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});

test("returns unavailable without leaking source errors", () => {
  const feed = readHermesFeed({ dbPath: "/definitely/not/a/hermes.db", now: () => new Date("2026-09-11T09:00:00Z") });
  assert.deepEqual(feed, { state: "unavailable", checkedAt: "2026-09-11T09:00:00.000Z", board: null });
  assert.ok(isHermesFeed(feed));
});
