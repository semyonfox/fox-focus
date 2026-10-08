import { dublinDateTimeToInstant } from './calendar-time.ts';
import type { InboxItem, InboxSourceContext } from './model.ts';

export const DEFAULT_INBOX_GRACE_MINUTES = 24 * 60;

export function normalizeInboxSourceContext(context: InboxSourceContext): InboxSourceContext {
  return {
    ...context,
    ...(context.startsAt ? { startsAt: new Date(context.startsAt).toISOString() } : {}),
    ...(context.endsAt ? { endsAt: new Date(context.endsAt).toISOString() } : {}),
    ...(context.dueAt ? { dueAt: new Date(context.dueAt).toISOString() } : {}),
    ...(context.expiresAt ? { expiresAt: new Date(context.expiresAt).toISOString() } : {}),
  };
}

export function inboxExpiry(item: InboxItem): { at: string; moveAt: string; destination: 'history' | 'automation' } | null {
  if (item.expiryRule?.enabled === false || item.expiryApplied || item.status === 'handled') return null;
  const context = item.sourceContext;
  // a task deadline is not an expiry; overdue work stays in the review queue
  const at = item.expiryRule?.at ?? (context?.timing === 'confirmed' ? context.expiresAt ?? context.endsAt : undefined);
  if (!at) return null;
  const moveAt = new Date(Date.parse(at) + (item.expiryRule?.graceMinutes ?? DEFAULT_INBOX_GRACE_MINUTES) * 60_000);
  if (!Number.isFinite(moveAt.getTime())) return null;
  return { at, moveAt: moveAt.toISOString(), destination: item.expiryRule?.destination ?? 'history' };
}

export function expireInboxItems(items: InboxItem[], now: Date): InboxItem[] {
  let changed = false;
  const next = items.map(item => {
    const expiry = inboxExpiry(item);
    if (!expiry || Date.parse(expiry.moveAt) > now.getTime()) return item;
    changed = true;
    return {
      ...item,
      ...(expiry.destination === 'history' ? { status: 'handled' as const } : { lane: 'automation' as const }),
      expiryApplied: { at: now.toISOString(), destination: expiry.destination },
    };
  });
  return changed ? next : items;
}

type SourceRecord = {
  provider: string; externalId: string; containerId: string; connectionId?: string | null;
  startsAt: string | null; startsOn?: string | null; endsAt?: string | null; endsOn?: string | null; dueOn: string | null; kind: string;
};

export function enrichInboxSource(item: InboxItem, records: readonly SourceRecord[]): InboxItem {
  const context = item.sourceContext;
  if (!context || !context.containerId || !context.connectionId) return item;
  const matches = records.filter(record => record.provider === context.provider && record.externalId === context.externalId &&
    record.containerId === context.containerId && record.connectionId === context.connectionId);
  if (matches.length !== 1) return item;
  const record = matches[0];
  const endsAt = record.kind === 'calendar_event' ? record.endsAt ?? (record.endsOn ? dublinDateTimeToInstant(record.endsOn, '00:00') : null) : null;
  // these values come from the exact imported record, never a title match
  const sourceContext = normalizeInboxSourceContext({
    ...context,
    startsAt: record.startsAt ?? (record.startsOn ? dublinDateTimeToInstant(record.startsOn, '00:00') ?? undefined : undefined),
    expiresAt: undefined,
    dueAt: undefined,
    endsAt: endsAt ?? undefined,
    dueOn: record.dueOn ?? undefined,
    timing: 'confirmed',
  });
  return JSON.stringify(sourceContext) === JSON.stringify(context) ? item : { ...item, sourceContext };
}
