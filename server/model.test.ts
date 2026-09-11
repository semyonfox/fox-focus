import assert from "node:assert/strict";
import { test } from "node:test";
import { addCalendarDays, calendarDateForDueLabel, compareTasksByCreatedAt, compareTasksByDue, dublinCalendarDate, isCalendarDate, isTask, isTimelineEvent, startOfCalendarWeek, type Task } from "../src/model.ts";

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
  assert.equal(isTask(task("planned", { scheduledDate: "2026-09-11", scheduledTime: "10:00" })), true);
  assert.equal(isTask(task("bad-plan-date", { scheduledDate: "2026-02-30", scheduledTime: "10:00" })), false);
});

test("keeps date-only planning stable through Dublin daylight-saving changes", () => {
  assert.equal(isCalendarDate("2026-02-29"), false);
  assert.equal(isCalendarDate("2028-02-29"), true);
  assert.equal(addCalendarDays("2026-03-28", 1), "2026-03-29");
  assert.equal(addCalendarDays("2026-03-29", 1), "2026-03-30");
  assert.equal(addCalendarDays("2026-10-24", 1), "2026-10-25");
  assert.equal(addCalendarDays("2026-10-25", 1), "2026-10-26");
  assert.equal(startOfCalendarWeek("2026-03-29"), "2026-03-23");
  assert.equal(startOfCalendarWeek("2026-10-25"), "2026-10-19");
  assert.equal(dublinCalendarDate(new Date("2026-03-29T00:30:00Z")), "2026-03-29");
  assert.equal(dublinCalendarDate(new Date("2026-03-29T23:30:00Z")), "2026-03-30");
  assert.equal(dublinCalendarDate(new Date("2026-10-25T00:30:00Z")), "2026-10-25");
  assert.equal(dublinCalendarDate(new Date("2026-10-25T23:30:00Z")), "2026-10-25");
});

test("maps the prototype's relative deadlines onto visible calendar days", () => {
  assert.equal(calendarDateForDueLabel("Today", "2026-09-11"), "2026-09-11");
  assert.equal(calendarDateForDueLabel("Tomorrow", "2026-09-11"), "2026-09-12");
  assert.equal(calendarDateForDueLabel("Friday", "2026-09-10"), "2026-09-11");
  assert.equal(calendarDateForDueLabel("Friday", "2026-09-11"), "2026-09-11");
  assert.equal(calendarDateForDueLabel("No deadline", "2026-09-11"), null);
});

test("accepts legacy timetable records while validating newly dated blocks", () => {
  const legacy = {
    id: "legacy-block",
    title: "Legacy block",
    subtitle: "",
    area: "Personal",
    start: "09:00",
    duration: 30,
    editable: true,
    origin: "local",
  } as const;
  assert.equal(isTimelineEvent(legacy), true);
  assert.equal(isTimelineEvent({ ...legacy, date: "2026-09-11" }), true);
  assert.equal(isTimelineEvent({ ...legacy, date: "2026-02-30" }), false);
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
