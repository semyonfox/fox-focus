import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareTasksByCreatedAt,
  compareTasksByDue,
  isInboxItem,
  isPrototypeData,
  isReminder,
  isTask,
  isTimelineEvent,
  type Task,
} from "../src/model.ts";

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
  assert.equal(isTask(task("dated-plan", { scheduledDate: "2026-09-11", scheduledTime: "10:00" })), true);
  assert.equal(isTask(task("bad-plan-date", { scheduledDate: "2026-02-30", scheduledTime: "10:00" })), false);
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

test("uses newest-created as the secondary due-ordering rule", () => {
  const tasks = [
    task("legacy", { due: "Today" }),
    task("older", { due: "Today", createdAt: "2026-09-10T09:00:00Z" }),
    task("newer", { due: "Today", createdAt: "2026-09-11T09:00:00Z" }),
  ];
  assert.deepEqual(tasks.sort(compareTasksByDue).map(({ id }) => id), ["newer", "older", "legacy"]);
});

test("accepts exact calendar instants while preserving dated and time-only legacy rows", () => {
  const base = {
    id: "event-1",
    title: "Focus block",
    subtitle: "Local",
    area: "Personal",
    duration: 30,
    editable: true,
    origin: "local",
  };

  assert.equal(isTimelineEvent({ ...base, startsAt: "2026-09-11T08:30:00.000Z" }), true);
  assert.equal(isTimelineEvent({ ...base, start: "09:30" }), true);
  assert.equal(isTimelineEvent({ ...base, date: "2026-09-11", start: "09:30" }), true);
  assert.equal(isTimelineEvent({ ...base, date: "2026-02-30", start: "09:30" }), false);
  assert.equal(isTimelineEvent({ ...base, startsAt: "2026-09-11", start: "09:30" }), false);
  assert.equal(isTimelineEvent({ ...base, startsAt: "2026-09-11T08:30:00.000Z", start: "09:30" }), false);
  assert.equal(isTimelineEvent({ ...base, startsAt: "2026-09-11T08:30:00.000Z", date: "2026-09-11" }), false);
});

test("accepts handled inbox records", () => {
  assert.equal(isInboxItem({
    id: "inbox-1",
    title: "Reviewed proposal",
    summary: "No action needed.",
    source: "Local",
    actor: "Semyon",
    status: "handled",
    accent: "Personal",
  }), true);
});

test("validates optional task-list area mappings", () => {
  const base = { tasks: [], events: [], inboxItems: [], reminders: [] };
  assert.equal(isPrototypeData(base), true);
  assert.equal(isPrototypeData({ ...base, listAreas: { "google:University": "University" } }), true);
  assert.equal(isPrototypeData({ ...base, listAreas: [] }), false);
  assert.equal(isPrototypeData({ ...base, listAreas: { "": "Personal" } }), false);
  assert.equal(isPrototypeData({ ...base, listAreas: { "google:Tasks": "Other" } }), false);
  assert.equal(isPrototypeData({ ...base, listAreas: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`google:${index}`, "Personal"])) }), false);
});

test("validates reminder fire instants", () => {
  const reminder = {
    id: "reminder-1",
    targetId: "task-1",
    targetType: "task",
    title: "Start assignment",
    mode: "one-hour",
    when: "1 hour before",
    state: "scheduled",
  } as const;
  assert.equal(isReminder({ ...reminder, fireAt: "2026-09-11T08:00:00.000Z" }), true);
  assert.equal(isReminder({ ...reminder, fireAt: "tomorrow morning" }), false);
});
