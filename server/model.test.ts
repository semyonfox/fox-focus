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

test("accepts native task provenance without making it mandatory", () => {
  const linked = task("linked", {
    origin: "migration",
    deadlineDate: "2026-09-14",
    externalLinks: [{
      provider: "google_tasks",
      containerId: "personal",
      externalId: "source-task",
      containerName: "Personal",
      policy: "completion_only",
      sourceStatus: "needsAction",
      sourceVersion: "etag-1",
      sourceUpdatedAt: "2026-09-11T10:00:00.000Z",
      linkedAt: "2026-09-11T10:01:00.000Z",
    }],
  });
  assert.equal(isTask(linked), true);
  assert.equal(isTask({ ...linked, deadlineDate: "2026-02-30" }), false);
  assert.equal(isTask({ ...linked, externalLinks: [{ ...linked.externalLinks![0], policy: "two_way" }] }), false);
  assert.equal(isPrototypeData({
    tasks: [linked, task("duplicate", { externalLinks: linked.externalLinks })],
    events: [], inboxItems: [], reminders: [],
  }), false);
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

test("orders exact deadline dates before legacy labels", () => {
  const tasks = [
    task("later", { due: "Today", deadlineDate: "2026-09-20" }),
    task("earlier", { due: "Next week", deadlineDate: "2026-09-14" }),
    task("legacy", { due: "Today" }),
  ];
  assert.deepEqual(tasks.sort(compareTasksByDue).map(({ id }) => id), ["earlier", "later", "legacy"]);
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

test("orders dated due labels chronologically instead of by creation time", () => {
  const tasks = [
    task("ospf", { due: "Wed 18 Nov", createdAt: "2026-09-12T16:08:00Z" }),
    task("practical", { due: "Mon 21 Sep", createdAt: "2026-09-12T16:08:00Z" }),
    task("vlan", { due: "Sun 18 Oct", createdAt: "2026-09-12T16:08:00Z" }),
    task("group", { due: "Tue 15 Sep", createdAt: "2026-09-09T12:05:00Z" }),
  ];
  assert.deepEqual(
    tasks.sort((first, second) => compareTasksByDue(first, second, "2026-09-12")).map(({ id }) => id),
    ["group", "practical", "vlan", "ospf"],
  );
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
