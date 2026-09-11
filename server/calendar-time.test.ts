import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUBLIN_TIME_ZONE,
  addCalendarDays,
  calendarDateWindow,
  dublinDateKey,
  dublinDateTimeToInstant,
  dublinTimeValue,
  formatDublinDateKey,
  isDateKey,
  isTimeValue,
} from "../src/calendar-time.ts";

test("validates strict calendar dates and time values", () => {
  assert.equal(DUBLIN_TIME_ZONE, "Europe/Dublin");
  assert.equal(isDateKey("2024-02-29"), true);
  assert.equal(isDateKey("2026-02-29"), false);
  assert.equal(isDateKey("2026-13-01"), false);
  assert.equal(isDateKey("2026-9-11"), false);
  assert.equal(isDateKey("0000-01-01"), false);
  assert.equal(isTimeValue("00:00"), true);
  assert.equal(isTimeValue("23:59"), true);
  assert.equal(isTimeValue("24:00"), false);
  assert.equal(isTimeValue("9:30"), false);
});

test("adds calendar days across month, leap-year, and year boundaries", () => {
  assert.equal(addCalendarDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addCalendarDays("2024-03-01", -1), "2024-02-29");
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
});

test("builds a seven-day window centred on the selected date", () => {
  assert.deepEqual(calendarDateWindow("2026-09-11", 3, 3), [
    "2026-09-08",
    "2026-09-09",
    "2026-09-10",
    "2026-09-11",
    "2026-09-12",
    "2026-09-13",
    "2026-09-14",
  ]);
});

test("formats Dublin date keys and converts instants back to Dublin day and time", () => {
  const instant = new Date("2026-09-11T23:30:00.000Z");
  assert.equal(dublinDateKey(instant), "2026-09-12");
  assert.equal(dublinTimeValue(instant), "00:30");
  assert.equal(formatDublinDateKey("2026-03-29"), "Sunday, 29 Mar");
  assert.equal(formatDublinDateKey("2026-03-29", { weekday: "short", day: "numeric" }), "Sun 29");
});

test("resolves valid Dublin wall times and rejects the spring-forward gap", () => {
  assert.equal(dublinDateTimeToInstant("2026-03-29", "00:30"), "2026-03-29T00:30:00.000Z");
  assert.equal(dublinDateTimeToInstant("2026-03-29", "01:30"), null);
  assert.equal(dublinDateTimeToInstant("2026-03-29", "02:30"), "2026-03-29T01:30:00.000Z");
});

test("does not guess between duplicate fall-back times", () => {
  assert.equal(dublinDateTimeToInstant("2026-10-25", "00:30"), "2026-10-24T23:30:00.000Z");
  assert.equal(dublinDateTimeToInstant("2026-10-25", "01:30"), null);
  assert.equal(dublinDateTimeToInstant("2026-10-25", "02:30"), "2026-10-25T02:30:00.000Z");
});

test("rejects malformed wall times without creating an instant", () => {
  assert.equal(dublinDateTimeToInstant("2026-02-29", "09:00"), null);
  assert.equal(dublinDateTimeToInstant("2026-09-11", "24:00"), null);
});
