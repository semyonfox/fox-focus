import assert from "node:assert/strict";
import { test } from "node:test";
import { compareTasksByCreatedAt, compareTasksByDue, isTask, type Task } from "../src/model.ts";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    area: "Personal",
    state: "up-next",
    duration: "30 min",
    due: "No deadline",
    priority: "medium",
    completed: false,
    scheduledTime: null,
    origin: "manual",
    ...overrides,
  };
}

test("accepts valid optional creation instants and preserves legacy tasks", () => {
  assert.equal(isTask(task("legacy")), true);
  assert.equal(isTask(task("offset", { createdAt: "2026-09-11T10:00:00+01:00" })), true);
  assert.equal(isTask(task("bad-date", { createdAt: "2026-02-30T10:00:00Z" })), false);
  assert.equal(isTask(task("date-only", { createdAt: "2026-09-11" })), false);
  assert.equal(isTask(task("not-an-instant", { createdAt: "yesterday" })), false);
});

test("orders due values using the existing UI semantics with deterministic ties", () => {
  const tasks = [
    task("no-deadline"),
    task("unknown", { due: "Next week" }),
    task("today-b", { due: "Today" }),
    task("today-a", { due: "Today" }),
    task("tomorrow", { due: "Tomorrow" }),
  ];
  assert.deepEqual(tasks.sort(compareTasksByDue).map(({ id }) => id), [
    "today-a", "today-b", "tomorrow", "unknown", "no-deadline",
  ]);
});

test("orders timestamped tasks newest-first and puts legacy tasks last", () => {
  const tasks = [
    task("legacy-b"),
    task("a-older", { createdAt: "2026-09-10T23:00:00Z" }),
    task("z-newer", { createdAt: "2026-09-11T00:02:00+01:00" }),
    task("legacy-a"),
  ];
  assert.deepEqual(tasks.sort(compareTasksByCreatedAt).map(({ id }) => id), [
    "z-newer", "a-older", "legacy-a", "legacy-b",
  ]);
});
