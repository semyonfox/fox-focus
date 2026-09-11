import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { isHermesFeed } from "../src/hermes-model.ts";
import { readHermesFeed } from "./hermes.ts";

test("reads a bounded, redacted Hermes feed with source groups", () => {
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
      CREATE TABLE task_links (parent_id TEXT, child_id TEXT);
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
      assert.deepEqual(Object.keys(task).sort(), ["id", "owner", "parentTitle", "priority", "source", "status", "title", "updatedAt"]);
    }
    insert.run("list", "Google Tasks list — Wishlist", "structure only", null, null, null, null, "scheduled", 0, 50);
    insert.run("child", "Future purchase", "Source: Google Tasks (Wishlist).\nNext action: private notes", null, null, null, null, "scheduled", 0, 50);
    insert.run("literal", "Literal source marker", "Source: Google Tasks (Literal List).\\nPrivate source text", null, null, null, null, "scheduled", 0, 50);
    insert.run("email", "Reply to a message", "Source: email triage\nPrivate source text", null, null, null, null, "scheduled", 0, 50);
    insert.run("direct", "Do the thing", "Source: direct request\nPrivate source text", null, null, null, null, "scheduled", 0, 50);
    insert.run("parent-list", "Google Tasks list — Parent only", "structure only", null, null, null, null, "scheduled", 0, 50);
    insert.run("parent-child", "Inherited source", null, null, null, null, null, "scheduled", 0, 50);
    insert.run("too-late", "Late source marker", `${"x".repeat(512)}\nSource: Google Tasks (Too late).`, null, null, null, null, "scheduled", 0, 50);
    db.prepare("INSERT INTO task_links VALUES (?,?)").run("list", "child");
    db.prepare("INSERT INTO task_links VALUES (?,?)").run("parent-list", "parent-child");
    const grouped = readHermesFeed({ dbPath: path });
    assert.equal(grouped.state, "connected");
    if (grouped.state === "connected") {
      assert.ok(grouped.board.sources.includes("Wishlist"));
      assert.ok(grouped.board.sources.includes("Email"));
      assert.ok(grouped.board.sources.includes("Direct request"));
      assert.ok(grouped.board.sources.includes("Literal List"));
      assert.ok(grouped.board.sources.includes("Parent only"));
      assert.equal(grouped.board.tasks.find(task => task.id === "child")?.source, "Wishlist");
      assert.equal(grouped.board.tasks.find(task => task.id === "literal")?.source, "Literal List");
      assert.equal(grouped.board.tasks.find(task => task.id === "email")?.source, "Email");
      assert.equal(grouped.board.tasks.find(task => task.id === "direct")?.source, "Direct request");
      assert.equal(grouped.board.tasks.find(task => task.id === "parent-child")?.source, "Parent only");
      assert.equal(grouped.board.tasks.find(task => task.id === "too-late")?.source, "Unsorted");
      assert.ok(!grouped.board.tasks.some(task => task.id === "list"));
      assert.ok(!JSON.stringify(grouped).includes("private notes"));
      assert.ok(!JSON.stringify(grouped).includes("Private source text"));
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
