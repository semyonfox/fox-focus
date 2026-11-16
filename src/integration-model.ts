import { dublinDateKey, isDateKey } from './calendar-time.ts';
import { isIsoInstant, isRecord, type Area } from './model.ts';

const areaKeywords: Array<[Area, readonly string[]]> = [
  ['University', ['university', 'uni', 'college', 'study', 'exam', 'lecture']],
  ['Work', ['work', 'job', 'office', 'client']],
  ['Health', ['health', 'gym', 'fitness', 'doctor']],
  ['Admin', ['admin', 'bill', 'bills', 'errand', 'errands', 'finance', 'tax']],
];

export function defaultAreaForList(name: string): Area {
  const words = new Set(name.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return areaKeywords.find(([, keywords]) => keywords.some(keyword => words.has(keyword)))?.[0] ?? 'Personal';
}

export function listAreaKey(provider: string, containerId: string): string {
  return `${provider}:id:${containerId}`;
}

export function areaForList(
  listAreas: Record<string, Area> | undefined,
  provider: string,
  containerId: string,
  name: string,
): Area {
  return listAreas?.[listAreaKey(provider, containerId)] ?? listAreas?.[`${provider}:${name}`] ?? defaultAreaForList(name);
}

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

// GET /api/v1/integrations, shared by the web drawer and the Android calendar
export type Provider = 'google' | 'microsoft';
type SyncState = 'idle' | 'syncing' | 'failed';
type ConnectionState = 'connected' | 'needs_reconnect';

type Connection = {
  connectionId: string;
  state: ConnectionState;
  scopes: string[];
  connectedAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type ProviderStatus = {
  provider: Provider;
  displayName: string;
  configured: boolean;
  connection: Connection | null;
  sync: { state: SyncState; completedAt: string | null; lastError: string | null };
  calendarEventCount: number;
  taskCount: number;
};

export type ImportedRecord = {
  id: number;
  provider: Provider;
  connectionId: string | null;
  kind: 'calendar_event' | 'task';
  containerId: string;
  containerName: string;
  externalId: string;
  title: string;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
  startsOn: string | null;
  endsOn: string | null;
  dueOn: string | null;
  allDay: boolean;
  adoptedTaskId: string | null;
};

export type Overview = { providers: ProviderStatus[]; records: ImportedRecord[] };

function isProvider(value: unknown): value is Provider {
  return value === 'google' || value === 'microsoft';
}

function isConnection(value: unknown): value is Connection {
  return isRecord(value) &&
    typeof value.connectionId === 'string' && value.connectionId.length > 0 &&
    (value.state === 'connected' || value.state === 'needs_reconnect') &&
    Array.isArray(value.scopes) && value.scopes.every(scope => typeof scope === 'string') &&
    typeof value.connectedAt === 'string' &&
    (value.lastSyncedAt === null || typeof value.lastSyncedAt === 'string') &&
    (value.lastError === null || typeof value.lastError === 'string');
}

function isProviderStatus(value: unknown): value is ProviderStatus {
  return isRecord(value) && isProvider(value.provider) && typeof value.displayName === 'string' &&
    typeof value.configured === 'boolean' && (value.connection === null || isConnection(value.connection)) &&
    isRecord(value.sync) && (value.sync.state === 'idle' || value.sync.state === 'syncing' || value.sync.state === 'failed') &&
    (value.sync.completedAt === null || typeof value.sync.completedAt === 'string') &&
    (value.sync.lastError === null || typeof value.sync.lastError === 'string') &&
    typeof value.calendarEventCount === 'number' && Number.isSafeInteger(value.calendarEventCount) && value.calendarEventCount >= 0 &&
    typeof value.taskCount === 'number' && Number.isSafeInteger(value.taskCount) && value.taskCount >= 0;
}

function isImportedRecord(value: unknown): value is ImportedRecord {
  return isRecord(value) && typeof value.id === 'number' && Number.isSafeInteger(value.id) &&
    isProvider(value.provider) && (value.kind === 'calendar_event' || value.kind === 'task') &&
    (value.connectionId === null || typeof value.connectionId === 'string') &&
    typeof value.containerId === 'string' && typeof value.containerName === 'string' &&
    typeof value.externalId === 'string' && typeof value.title === 'string' &&
    (value.status === null || typeof value.status === 'string') &&
    (value.startsAt === null || isIsoInstant(value.startsAt)) &&
    (value.endsAt === null || isIsoInstant(value.endsAt)) &&
    (value.startsOn === null || isDateKey(value.startsOn)) &&
    (value.endsOn === null || isDateKey(value.endsOn)) &&
    (value.dueOn === null || typeof value.dueOn === 'string') && typeof value.allDay === 'boolean' &&
    (value.adoptedTaskId === null || typeof value.adoptedTaskId === 'string');
}

export function isOverview(value: unknown): value is Overview {
  return isRecord(value) && Array.isArray(value.providers) && value.providers.every(isProviderStatus) &&
    Array.isArray(value.records) && value.records.every(isImportedRecord);
}
