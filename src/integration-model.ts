import { dublinDateKey, isDateKey } from './calendar-time.ts';

export type CalendarContextItem = {
  title: string;
  startsAt: string | null;
  startsOn: string | null;
  allDay?: boolean;
};

function itemDateKey(item: CalendarContextItem): string {
  if (item.startsOn && isDateKey(item.startsOn)) return item.startsOn;
  if (!item.startsAt) return '';
  const instant = new Date(item.startsAt);
  return Number.isNaN(instant.getTime()) ? '' : dublinDateKey(instant);
}

function compareCalendarContext(first: CalendarContextItem, second: CalendarContextItem): number {
  const dayOrder = itemDateKey(first).localeCompare(itemDateKey(second));
  if (dayOrder !== 0) return dayOrder;

  const firstAllDay = first.allDay === true || isDateKey(first.startsOn);
  const secondAllDay = second.allDay === true || isDateKey(second.startsOn);
  if (firstAllDay !== secondAllDay) return firstAllDay ? -1 : 1;

  const firstInstant = first.startsAt ? Date.parse(first.startsAt) : Number.POSITIVE_INFINITY;
  const secondInstant = second.startsAt ? Date.parse(second.startsAt) : Number.POSITIVE_INFINITY;
  const timeOrder = firstInstant - secondInstant;
  if (Number.isFinite(timeOrder) && timeOrder !== 0) return timeOrder;

  return first.title.localeCompare(second.title);
}

/**
 * Selects records whose start falls within an inclusive calendar-date range.
 * Timed starts are assigned to dates in Europe/Dublin; all-day date keys are
 * already calendar dates and must not be shifted through UTC.
 */
export function filterCalendarContextByDateRange<T extends CalendarContextItem>(
  items: readonly T[],
  startDate: string,
  endDate: string,
): T[] {
  if (!isDateKey(startDate) || !isDateKey(endDate) || startDate > endDate) return [];

  return items
    .filter((item) => {
      const date = itemDateKey(item);
      return date >= startDate && date <= endDate;
    })
    .sort(compareCalendarContext);
}

/** Puts today and upcoming calendar context ahead of the rolling past window. */
export function sortTodayCalendarContext<T extends CalendarContextItem>(items: readonly T[], now = new Date()): T[] {
  const today = dublinDateKey(now);
  return [...items].sort((first, second) => {
    const firstDay = itemDateKey(first);
    const secondDay = itemDateKey(second);
    const firstCurrentOrUpcoming = firstDay >= today;
    const secondCurrentOrUpcoming = secondDay >= today;
    if (firstCurrentOrUpcoming !== secondCurrentOrUpcoming) return firstCurrentOrUpcoming ? -1 : 1;
    if (firstCurrentOrUpcoming) return compareCalendarContext(first, second);
    return secondDay.localeCompare(firstDay) || compareCalendarContext(first, second);
  });
}
