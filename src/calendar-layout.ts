import { addCalendarDays, dublinDateKey, dublinTimeValue } from './calendar-time.ts';

export type TimedEntry = { id: string; date: string; time: string; duration: number; startsAt?: string };
export type PositionedEntry<T> = { entry: T; start: number; end: number; column: number; columns: number };
export const minuteOfDay = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// clip crossing-midnight events to each displayed Dublin day
export function daySegment(entry: TimedEntry, date: string): { start: number; end: number } | null {
  let endDate: string;
  let endMinute: number;
  if (entry.startsAt) {
    const end = new Date(Date.parse(entry.startsAt) + entry.duration * 60_000);
    endDate = dublinDateKey(end);
    endMinute = minuteOfDay(dublinTimeValue(end));
  } else {
    const end = minuteOfDay(entry.time) + entry.duration;
    endDate = addCalendarDays(entry.date, Math.floor(end / 1440));
    endMinute = end % 1440;
  }
  if (entry.date > date || endDate < date || endDate === date && endMinute === 0) return null;
  const start = entry.date < date ? 0 : minuteOfDay(entry.time);
  // the repeated autumn hour shares a wall-clock slot
  const end = endDate > date ? 1440 : Math.max(start + 1, endMinute);
  return { start, end: Math.min(1440, end) };
}

export function layoutDay<T extends TimedEntry>(entries: readonly T[], date: string): PositionedEntry<T>[] {
  const rows = entries.flatMap(entry => {
    const segment = daySegment(entry, date);
    return segment ? [{ entry, ...segment, column: 0, columns: 1 }] : [];
  }).sort((a, b) => a.start - b.start || b.end - a.end || a.entry.id.localeCompare(b.entry.id));
  let group: PositionedEntry<T>[] = [];
  let ends: number[] = [];
  let groupEnd = -1;
  function finish() { for (const row of group) row.columns = ends.length; }
  for (const row of rows) {
    // reserve the minimum painted height as well as the actual duration
    if (row.start >= groupEnd) { finish(); group = []; ends = []; }
    let column = ends.findIndex(end => end <= row.start);
    if (column < 0) column = ends.length;
    row.column = column;
    ends[column] = Math.max(row.end, row.start + 24);
    groupEnd = Math.max(...ends);
    group.push(row);
  }
  finish();
  return rows;
}
