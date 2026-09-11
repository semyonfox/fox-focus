export const DUBLIN_TIME_ZONE = "Europe/Dublin";

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_VALUE_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DAY_IN_MILLISECONDS = 86_400_000;

type DateParts = Readonly<{
  year: number;
  month: number;
  day: number;
}>;

type DublinDateTimeParts = DateParts & Readonly<{
  hour: number;
  minute: number;
}>;

const dublinDateTimeFormatter = new Intl.DateTimeFormat("en-IE", {
  timeZone: DUBLIN_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function utcTimestamp(parts: DublinDateTimeParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, 0, 0);
  return date.getTime();
}

function parseDateKey(value: string): DateParts | null {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0) return null;

  const timestamp = utcTimestamp({ year, month, day, hour: 0, minute: 0 });
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day }
    : null;
}

function partNumber(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number | null {
  const value = parts.find((part) => part.type === type)?.value;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function dublinParts(date: Date): DublinDateTimeParts | null {
  if (!Number.isFinite(date.getTime())) return null;
  const parts = dublinDateTimeFormatter.formatToParts(date);
  const year = partNumber(parts, "year");
  const month = partNumber(parts, "month");
  const day = partNumber(parts, "day");
  const hour = partNumber(parts, "hour");
  const minute = partNumber(parts, "minute");
  return year === null || month === null || day === null || hour === null || minute === null
    ? null
    : { year, month, day, hour, minute };
}

function formatDateParts({ year, month, day }: DateParts): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function assertDateKey(value: string): DateParts {
  const parts = parseDateKey(value);
  if (parts === null) throw new RangeError(`Invalid calendar date: ${value}`);
  return parts;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && parseDateKey(value) !== null;
}

export function isTimeValue(value: unknown): value is string {
  return typeof value === "string" && TIME_VALUE_PATTERN.test(value);
}

/** Returns the calendar date containing an instant in Europe/Dublin. */
export function dublinDateKey(value: Date): string {
  const parts = dublinParts(value);
  if (parts === null) throw new RangeError("Expected a valid instant");
  return formatDateParts(parts);
}

/** Formats a date-only value without allowing the host system time zone to shift its day. */
export function formatDublinDateKey(
  dateKey: string,
  options: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "short" },
): string {
  const parts = assertDateKey(dateKey);
  const formatter = new Intl.DateTimeFormat("en-IE", {
    ...options,
    timeZone: DUBLIN_TIME_ZONE,
    calendar: "gregory",
    numberingSystem: "latn",
  });
  return formatter.format(new Date(utcTimestamp({ ...parts, hour: 12, minute: 0 })));
}

/** Adds whole calendar days rather than fixed 24-hour periods. */
export function addCalendarDays(dateKey: string, delta: number): string {
  const parts = assertDateKey(dateKey);
  if (!Number.isSafeInteger(delta)) throw new RangeError("delta must be an integer");

  const date = new Date(utcTimestamp({ ...parts, hour: 0, minute: 0 }));
  date.setUTCDate(date.getUTCDate() + delta);
  const result = formatDateParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
  if (!Number.isFinite(date.getTime()) || !isDateKey(result)) throw new RangeError("Result is outside the supported date range");
  return result;
}

/** Builds an inclusive window ordered from the oldest day to the newest. */
export function calendarDateWindow(dateKey: string, daysBefore: number, daysAfter: number): string[] {
  assertDateKey(dateKey);
  assertNonNegativeInteger(daysBefore, "daysBefore");
  assertNonNegativeInteger(daysAfter, "daysAfter");
  if (!Number.isSafeInteger(daysBefore + daysAfter + 1)) throw new RangeError("Date window is too large");

  const dates: string[] = [];
  for (let offset = -daysBefore; offset <= daysAfter; offset += 1) {
    dates.push(addCalendarDays(dateKey, offset));
  }
  return dates;
}

/**
 * Resolves a Dublin wall time to an exact UTC instant. DST gaps and ambiguous
 * fall-back times return null instead of silently moving or choosing a side.
 */
export function dublinDateTimeToInstant(dateKey: string, time: string): string | null {
  const date = parseDateKey(dateKey);
  if (date === null || !isTimeValue(time)) return null;

  const [hourText, minuteText] = time.split(":");
  const local = { ...date, hour: Number(hourText), minute: Number(minuteText) };
  const naive = utcTimestamp(local);
  const candidates = new Set<number>();

  for (const sample of [naive - DAY_IN_MILLISECONDS, naive, naive + DAY_IN_MILLISECONDS]) {
    const rendered = dublinParts(new Date(sample));
    if (rendered === null) return null;
    const offset = utcTimestamp(rendered) - sample;
    const candidate = naive - offset;
    const roundTrip = dublinParts(new Date(candidate));
    if (
      roundTrip !== null &&
      roundTrip.year === local.year &&
      roundTrip.month === local.month &&
      roundTrip.day === local.day &&
      roundTrip.hour === local.hour &&
      roundTrip.minute === local.minute
    ) {
      candidates.add(candidate);
    }
  }

  return candidates.size === 1 ? new Date([...candidates][0]).toISOString() : null;
}

/** Returns an instant's HH:mm wall-clock value in Europe/Dublin. */
export function dublinTimeValue(instant: string | Date): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts = dublinParts(date);
  if (parts === null) throw new RangeError("Expected a valid instant");
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}
