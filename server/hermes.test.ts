import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  deduplicatedProviderIdentity,
  isHermesCompletionInput,
  isHermesFeed,
  isHermesTaskAnnotationInput,
  type HermesMirrorSnapshot,
  type HermesRemoteTask,
} from "../src/hermes-model.ts";
import {
  createHermesActionClient,
  createHermesMirrorService,
  HermesServiceError,
  readHermesFeed,
  type HermesActionClient,
} from "./hermes.ts";
import { openStore } from "./store.ts";

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
      assert.equal("body" in task, false);
      assert.equal("source_metadata" in task, false);
      assert.equal(typeof task.createdAt, "string");
      assert.equal(typeof task.version, "number");
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

test("requires offset-bearing instants at the Hermes API boundary", () => {
  const annotation = {
    area: "Personal",
    localState: "scheduled",
    duration: "30 min",
    due: "Tomorrow",
    scheduledAt: "2026-09-12T09:00:00.000Z",
    reminderMode: "one-hour",
    reminderFireAt: "2026-09-12T08:00:00.000Z",
  };
  assert.equal(isHermesTaskAnnotationInput(annotation), true);
  assert.equal(isHermesTaskAnnotationInput({ ...annotation, scheduledAt: "2026-09-12" }), false);
  assert.equal(isHermesTaskAnnotationInput({ ...annotation, reminderFireAt: "2026-09-12T08:00:00" }), false);
  assert.equal(isHermesCompletionInput({
    expectedVersion: 7,
    confirmation: { beforeStatus: "scheduled", afterStatus: "done", confirmedAt: "2026-09-12T08:00:00Z" },
  }), true);
  assert.equal(isHermesCompletionInput({
    expectedVersion: 7,
    confirmation: { beforeStatus: "scheduled", afterStatus: "done", confirmedAt: "2026-09-12" },
  }), false);
  assert.equal(isHermesFeed({
    state: "unavailable",
    checkedAt: "2026-09-12T08:00:00Z",
    board: null,
    completionAvailable: "yes",
  }), false);
});

function remoteTask(overrides: Partial<HermesRemoteTask> = {}): HermesRemoteTask {
  return {
    id: "t_11111111",
    title: "Mirror me",
    status: "scheduled",
    priority: 2,
    createdAt: "2026-09-10T08:00:00.000Z",
    updatedAt: "2026-09-11T09:00:00.000Z",
    version: 7,
    owner: "human",
    source: "Unsorted",
    parentTitle: null,
    sourceProvider: null,
    sourceExternalId: null,
    sourceDueOn: null,
    sourceStatus: null,
    sourceContainerId: null,
    sourceContainerName: null,
    sourceMatchUnique: false,
    ...overrides,
  };
}

function snapshot(tasks: HermesRemoteTask[], complete = true): HermesMirrorSnapshot {
  return {
    state: "connected",
    checkedAt: "2026-09-11T10:00:00.000Z",
    complete,
    board: { slug: "personal-tasks", name: "Personal Tasks", total: tasks.length, tasks, sources: ["Unsorted"] },
  };
}

test("keeps a still-open provider task visible after its Hermes mirror is done", () => {
  const openMirror = remoteTask({
    sourceProvider: "google",
    sourceExternalId: "provider-task",
    sourceMatchUnique: true,
    sourceStatus: "needsAction",
  });
  assert.equal(deduplicatedProviderIdentity(openMirror), "google\u0000provider-task");
  assert.equal(deduplicatedProviderIdentity({ ...openMirror, status: "done" }), null);
  assert.equal(deduplicatedProviderIdentity({ ...openMirror, status: "done", sourceStatus: "completed" }),
    "google\u0000provider-task");
  assert.equal(deduplicatedProviderIdentity({ ...openMirror, sourceStatus: "completed" }), null);
  assert.equal(deduplicatedProviderIdentity({ ...openMirror, sourceMatchUnique: false }), null);
});

test("mirrors complete snapshots by stable task ID and preserves local annotations", () => {
  const store = openStore(":memory:");
  try {
    store.replaceHermesTasks(snapshot([
      remoteTask(),
      remoteTask({ id: "t_22222222", title: "Remove me", version: 8 }),
    ]));
    store.replaceHermesTasks(snapshot([remoteTask({ title: "Renamed remotely", version: 9 })]));
    let feed = store.readHermesFeed();
    assert.equal(feed.state, "connected");
    if (feed.state !== "connected") return;
    assert.deepEqual(feed.board.tasks.map(task => [task.id, task.title]), [["t_11111111", "Renamed remotely"]]);

    const annotated = store.updateHermesTaskAnnotation("t_11111111", {
      area: "Work",
      localState: "scheduled",
      duration: "45 min",
      due: "Tomorrow",
      scheduledAt: "2026-09-12T09:00:00.000Z",
      reminderMode: "one-hour",
      reminderFireAt: "2026-09-12T08:00:00.000Z",
    });
    assert.equal(annotated?.area, "Work");
    store.replaceHermesTasks(snapshot([remoteTask({ title: "Remote title wins", version: 10 })]));
    feed = store.readHermesFeed();
    assert.equal(feed.state, "connected");
    if (feed.state === "connected") {
      assert.equal(feed.board.tasks[0]?.title, "Remote title wins");
      assert.equal(feed.board.tasks[0]?.area, "Work");
      assert.equal(feed.board.tasks[0]?.scheduledAt, "2026-09-12T09:00:00.000Z");
    }
    assert.deepEqual(store.read().data.tasks, []);
  } finally { store.close(); }
});

test("a bounded snapshot preserves rows but pauses reminders and completion until a complete read", async () => {
  const store = openStore(":memory:");
  try {
    store.replaceHermesTasks(snapshot([remoteTask(), remoteTask({ id: "t_22222222" })]));
    store.updateHermesTaskAnnotation("t_22222222", {
      area: "Personal",
      localState: "scheduled",
      duration: "30 min",
      due: "Tomorrow",
      scheduledAt: "2026-09-12T09:00:00.000Z",
      reminderMode: "one-hour",
      reminderFireAt: "2026-09-12T08:00:00.000Z",
    });
    assert.equal(store.listHermesReminders().length, 1);
    store.replaceHermesTasks(snapshot([remoteTask({ version: 8 })], false));
    let feed = store.readHermesFeed();
    assert.equal(feed.state, "stale");
    if (feed.state !== "stale") return;
    assert.equal(feed.board.tasks.length, 2);
    assert.equal(store.listHermesReminders().length, 0);
    assert.equal(store.listHermesReminders(true).length, 1);

    let actionCalls = 0;
    const service = createHermesMirrorService(store, { dbPath: "/not-used" }, {
      async complete() {
        actionCalls += 1;
        throw new Error("should not be called");
      },
    });
    await assert.rejects(
      service.completeTask("t_11111111", {
        expectedVersion: 8,
        confirmation: { beforeStatus: "scheduled", afterStatus: "done", confirmedAt: new Date().toISOString() },
      }),
      /not current/i,
    );
    assert.equal(actionCalls, 0);

    store.markHermesUnavailable("2026-09-11T10:01:00.000Z");
    feed = store.readHermesFeed();
    assert.equal(feed.state, "stale");
    if (feed.state === "stale") {
      assert.equal(feed.lastSuccessfulAt, "2026-09-11T10:00:00.000Z");
      assert.equal(feed.board.tasks.length, 2);
    }
  } finally { store.close(); }
});

test("retains stale Hermes reminder keys without delivering stale reminders", () => {
  const store = openStore(":memory:");
  try {
    store.replaceHermesTasks(snapshot([remoteTask()]));
    store.updateHermesTaskAnnotation("t_11111111", {
      area: "Personal",
      localState: "scheduled",
      duration: "30 min",
      due: "Tomorrow",
      scheduledAt: "2026-09-12T09:00:00.000Z",
      reminderMode: "one-hour",
      reminderFireAt: "2026-09-12T08:00:00.000Z",
    });
    assert.equal(store.listHermesReminders().length, 1);

    store.markHermesUnavailable("2026-09-11T10:01:00.000Z");
    assert.equal(store.listHermesReminders().length, 0);
    assert.equal(store.listHermesReminders(true).length, 1);
  } finally { store.close(); }
});

test("enriches Google provenance only when the provider record match is unambiguous", () => {
  const store = openStore(":memory:");
  try {
    store.replaceProviderRecords("google", [{
      provider: "google", kind: "task", containerId: "list-one", containerName: "Uni",
      externalId: "google-id", title: "Provider task", status: "needsAction",
      startsAt: null, endsAt: null, startsOn: null, endsOn: null, allDay: false,
      dueOn: "2026-09-12", completedAt: null, sourceUpdatedAt: null, sourceUrl: null, sourceTimeZone: null,
    }]);
    store.replaceHermesTasks(snapshot([remoteTask({
      source: "Uni", sourceProvider: "google", sourceExternalId: "google-id",
    })]));
    let feed = store.readHermesFeed();
    assert.notEqual(feed.state, "unavailable");
    if (feed.state === "unavailable") return;
    assert.equal(feed.board.tasks[0]?.sourceMatchUnique, true);
    assert.equal(feed.board.tasks[0]?.sourceContainerId, "list-one");
    assert.equal(feed.board.tasks[0]?.sourceDueOn, "2026-09-12");

    store.replaceProviderRecords("google", [
      {
        provider: "google", kind: "task", containerId: "list-one", containerName: "One",
        externalId: "google-id", title: "Provider task", status: "needsAction",
        startsAt: null, endsAt: null, startsOn: null, endsOn: null, allDay: false,
        dueOn: null, completedAt: null, sourceUpdatedAt: null, sourceUrl: null, sourceTimeZone: null,
      },
      {
        provider: "google", kind: "task", containerId: "list-two", containerName: "Two",
        externalId: "google-id", title: "Provider task", status: "needsAction",
        startsAt: null, endsAt: null, startsOn: null, endsOn: null, allDay: false,
        dueOn: null, completedAt: null, sourceUpdatedAt: null, sourceUrl: null, sourceTimeZone: null,
      },
    ]);
    feed = store.readHermesFeed();
    assert.notEqual(feed.state, "unavailable");
    if (feed.state !== "unavailable") assert.equal(feed.board.tasks[0]?.sourceMatchUnique, false);
  } finally { store.close(); }
});

test("completion records approval, calls the narrow action contract and waits for readback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fox-hermes-action-"));
  const path = join(dir, "kanban.db");
  const source = new DatabaseSync(path);
  const store = openStore(":memory:");
  const sentRequests: Array<Parameters<HermesActionClient["complete"]>[0]> = [];
  try {
    source.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT,
        status TEXT NOT NULL, priority INTEGER NOT NULL, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER, idempotency_key TEXT
      );
      CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, created_at INTEGER);
      CREATE TABLE task_links (parent_id TEXT, child_id TEXT);
    `);
    source.prepare(`INSERT INTO tasks
      (id,title,body,assignee,status,priority,created_at,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      "t_action01", "Finish through Fox", "private", "semyon-human", "scheduled", 2, 100,
      "google-task:external-1",
    );
    source.prepare("INSERT INTO task_events (id,task_id,created_at) VALUES (7,?,?)").run("t_action01", 110);

    const client: HermesActionClient = {
      async complete(request) {
        sentRequests.push(request);
        const completedAt = 120;
        source.prepare("UPDATE tasks SET status='done', completed_at=? WHERE id=?")
          .run(completedAt, request.taskId);
        const result = source.prepare("INSERT INTO task_events (task_id,created_at) VALUES (?,?)")
          .run(request.taskId, completedAt);
        const version = Number(result.lastInsertRowid);
        return {
          taskId: request.taskId,
          board: "personal-tasks",
          before: { id: request.taskId, title: "Finish through Fox", status: "scheduled", completedAt: null, version: request.expectedVersion },
          after: { id: request.taskId, title: "Finish through Fox", status: "done", completedAt, version },
          version,
          replayed: false,
          approvalId: request.approvalId,
          idempotencyKey: request.idempotencyKey,
        };
      },
    };
    const service = createHermesMirrorService(store, { dbPath: path }, client);
    const initial = await service.poll();
    assert.equal(initial.state, "connected");
    assert.equal(initial.completionAvailable, true);
    if (initial.state !== "connected") return;
    const task = initial.board.tasks[0];
    assert.ok(task);
    const result = await service.completeTask(task.id, {
      expectedVersion: task.version,
      confirmation: { beforeStatus: task.status, afterStatus: "done", confirmedAt: new Date().toISOString() },
    });
    assert.equal(result.task.status, "done");
    const sentRequest = sentRequests[0];
    assert.ok(sentRequest);
    assert.deepEqual(Object.keys(sentRequest).sort(), ["approvalId", "change", "expectedVersion", "idempotencyKey", "taskId"]);
    assert.deepEqual(sentRequest.change, { status: "done" });
    assert.equal(store.listHermesActions().length, 1);
    assert.equal(store.listHermesActions()[0]?.state, "succeeded");
    assert.match(store.listHermesActions()[0]?.approvalSummary ?? "", /scheduled -> done/);
    const completedAction = store.listHermesActions()[0];
    assert.ok(completedAction);
    store.finishHermesAction(completedAction.id, "failed", null, "late_transport_error");
    assert.equal(store.listHermesActions()[0]?.state, "succeeded");
  } finally {
    store.close();
    source.close();
    rmSync(dir, { recursive: true });
  }
});

test("recovers an ambiguous completion from the Hermes action receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fox-hermes-replay-"));
  const path = join(dir, "kanban.db");
  const source = new DatabaseSync(path);
  const store = openStore(":memory:");
  let calls = 0;
  try {
    source.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT,
        status TEXT NOT NULL, priority INTEGER NOT NULL, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER, idempotency_key TEXT
      );
      CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, created_at INTEGER);
      CREATE TABLE task_links (parent_id TEXT, child_id TEXT);
      CREATE TABLE kanban_external_actions (
        idempotency_key TEXT PRIMARY KEY, board TEXT, task_id TEXT, approval_id TEXT,
        before_json TEXT, after_json TEXT, result_version INTEGER
      );
    `);
    source.prepare(`INSERT INTO tasks
      (id,title,body,assignee,status,priority,created_at,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      "t_replay01", "Survive a lost response", null, "semyon-human", "scheduled", 2, 100, null,
    );
    source.prepare("INSERT INTO task_events (id,task_id,created_at) VALUES (7,?,?)").run("t_replay01", 110);

    const client: HermesActionClient = {
      async complete(request) {
        calls += 1;
        if (calls === 1) {
          source.prepare("UPDATE tasks SET status='done', completed_at=? WHERE id=?").run(120, request.taskId);
          const event = source.prepare("INSERT INTO task_events (task_id,created_at) VALUES (?,?)").run(request.taskId, 120);
          const version = Number(event.lastInsertRowid);
          source.prepare(`INSERT INTO kanban_external_actions
            (idempotency_key,board,task_id,approval_id,before_json,after_json,result_version)
            VALUES (?,?,?,?,?,?,?)`).run(
            request.idempotencyKey,
            "personal-tasks",
            request.taskId,
            request.approvalId,
            JSON.stringify({ id: request.taskId, title: "Survive a lost response", status: "scheduled", completedAt: null, version: request.expectedVersion }),
            JSON.stringify({ id: request.taskId, title: "Survive a lost response", status: "done", completedAt: 120, version }),
            version,
          );
        }
        throw new HermesServiceError(503, "The response was lost after Hermes committed.", true);
      },
    };
    const service = createHermesMirrorService(store, { dbPath: path }, client);
    const initial = await service.poll();
    assert.equal(initial.state, "connected");
    if (initial.state !== "connected") return;
    const task = initial.board.tasks[0];
    assert.ok(task);
    const result = await service.completeTask(task.id, {
      expectedVersion: task.version,
      confirmation: { beforeStatus: task.status, afterStatus: "done", confirmedAt: new Date().toISOString() },
    });

    assert.equal(calls, 2);
    assert.equal(result.task.status, "done");
    assert.equal(store.listHermesActions()[0]?.state, "succeeded");
  } finally {
    store.close();
    source.close();
    rmSync(dir, { recursive: true });
  }
});

test("reconciles a delayed Hermes completion even when the task changes again before polling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fox-hermes-delayed-"));
  const path = join(dir, "kanban.db");
  const source = new DatabaseSync(path);
  const store = openStore(":memory:");
  let calls = 0;
  try {
    source.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT,
        status TEXT NOT NULL, priority INTEGER NOT NULL, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER, idempotency_key TEXT
      );
      CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, created_at INTEGER);
      CREATE TABLE task_links (parent_id TEXT, child_id TEXT);
      CREATE TABLE kanban_external_actions (
        idempotency_key TEXT PRIMARY KEY, board TEXT, task_id TEXT, approval_id TEXT,
        before_json TEXT, after_json TEXT, result_version INTEGER
      );
    `);
    source.prepare(`INSERT INTO tasks
      (id,title,body,assignee,status,priority,created_at,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      "t_delayed1", "Finish after a lock wait", null, "semyon-human", "scheduled", 2, 100, null,
    );
    source.prepare("INSERT INTO task_events (id,task_id,created_at) VALUES (7,?,?)").run("t_delayed1", 110);

    const client: HermesActionClient = {
      async complete() {
        calls += 1;
        throw new HermesServiceError(503, "The request is still waiting on Hermes.", true);
      },
    };
    const service = createHermesMirrorService(store, { dbPath: path }, client);
    const initial = await service.poll();
    assert.equal(initial.state, "connected");
    if (initial.state !== "connected") return;
    const task = initial.board.tasks[0];
    assert.ok(task);

    await assert.rejects(
      service.completeTask(task.id, {
        expectedVersion: task.version,
        confirmation: { beforeStatus: task.status, afterStatus: "done", confirmedAt: new Date().toISOString() },
      }),
      /could not confirm.*keep checking/i,
    );
    assert.equal(calls, 2);
    const unresolved = store.listHermesActions()[0];
    assert.ok(unresolved);
    assert.equal(unresolved.state, "readback_failed");
    assert.equal(store.getHermesTask(task.id)?.status, "scheduled");

    source.prepare("UPDATE tasks SET status='done', completed_at=? WHERE id=?").run(120, task.id);
    const event = source.prepare("INSERT INTO task_events (task_id,created_at) VALUES (?,?)").run(task.id, 120);
    const version = Number(event.lastInsertRowid);
    source.prepare(`INSERT INTO kanban_external_actions
      (idempotency_key,board,task_id,approval_id,before_json,after_json,result_version)
      VALUES (?,?,?,?,?,?,?)`).run(
      unresolved.idempotencyKey,
      "personal-tasks",
      task.id,
      unresolved.id,
      JSON.stringify({ id: task.id, title: task.title, status: task.status, completedAt: null, version: task.version }),
      JSON.stringify({ id: task.id, title: task.title, status: "done", completedAt: 120, version }),
      version,
    );
    source.prepare("UPDATE tasks SET status='todo', completed_at=NULL WHERE id=?").run(task.id);
    const reopenedEvent = source.prepare("INSERT INTO task_events (task_id,created_at) VALUES (?,?)").run(task.id, 121);
    const reopenedVersion = Number(reopenedEvent.lastInsertRowid);

    const reconciled = await service.poll();
    assert.equal(reconciled.state, "connected");
    if (reconciled.state === "connected") {
      assert.equal(reconciled.board.tasks[0]?.status, "todo");
      assert.equal(reconciled.board.tasks[0]?.version, reopenedVersion);
    }
    assert.equal(store.listHermesActions()[0]?.state, "succeeded");
  } finally {
    store.close();
    source.close();
    rmSync(dir, { recursive: true });
  }
});

test("a definitive Hermes rejection is not retried or left awaiting a receipt", async () => {
  const store = openStore(":memory:");
  let calls = 0;
  try {
    store.replaceHermesTasks(snapshot([remoteTask()]));
    const client: HermesActionClient = {
      async complete() {
        calls += 1;
        throw new HermesServiceError(503, "Hermes rejected the scoped request.");
      },
    };
    const service = createHermesMirrorService(store, { dbPath: "/not-used" }, client);
    await assert.rejects(
      service.completeTask("t_11111111", {
        expectedVersion: 7,
        confirmation: { beforeStatus: "scheduled", afterStatus: "done", confirmedAt: new Date().toISOString() },
      }),
      /rejected the scoped request/,
    );
    assert.equal(calls, 1);
    assert.equal(store.listHermesActions()[0]?.state, "failed");
  } finally { store.close(); }
});

test("the Hermes HTTP client classifies a token rejection as definitive", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "insufficient_scope" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const client = createHermesActionClient(`http://127.0.0.1:${address.port}/task-completion`, "test-token");
    await assert.rejects(
      client.complete({
        taskId: "t_11111111",
        expectedVersion: 7,
        idempotencyKey: "fox-focus:test-action",
        approvalId: "test-approval",
        change: { status: "done" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HermesServiceError);
        assert.equal(error.status, 503);
        assert.equal(error.outcomeUnknown, false);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("an unavailable action API leaves the mirrored task open and records the failed attempt", async () => {
  const store = openStore(":memory:");
  try {
    store.replaceHermesTasks(snapshot([remoteTask()]));
    const service = createHermesMirrorService(store, { dbPath: "/not-used" });
    assert.equal(service.feed().completionAvailable, false);
    await assert.rejects(
      service.completeTask("t_11111111", {
        expectedVersion: 7,
        confirmation: { beforeStatus: "scheduled", afterStatus: "done", confirmedAt: new Date().toISOString() },
      }),
      /not configured/,
    );
    assert.equal(store.getHermesTask("t_11111111")?.status, "scheduled");
    assert.equal(store.listHermesActions()[0]?.state, "failed");
  } finally { store.close(); }
});
