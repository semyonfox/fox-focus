export type CalendarContextItem = {
  title: string;
  startsAt: string | null;
  startsOn: string | null;
};

function dublinDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function itemDateKey(item: CalendarContextItem): string {
  if (item.startsOn && /^\d{4}-\d{2}-\d{2}$/.test(item.startsOn)) return item.startsOn;
  if (!item.startsAt) return '';
  const instant = new Date(item.startsAt);
  return Number.isNaN(instant.getTime()) ? '' : dublinDateKey(instant);
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
    if (firstCurrentOrUpcoming) return firstDay.localeCompare(secondDay) || first.title.localeCompare(second.title);
    return secondDay.localeCompare(firstDay) || first.title.localeCompare(second.title);
  });
}
