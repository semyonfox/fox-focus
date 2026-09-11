import type { PrototypeData, Reminder } from '../src/model.ts';

export type StoredPushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

export function dueReminders(data: PrototypeData, now: Date): Reminder[] {
  const latestFireAt = now.getTime();
  const earliestFireAt = latestFireAt - 10 * 60_000;
  return data.reminders.filter(reminder => {
    if (reminder.state !== 'scheduled' || reminder.firedAt || !reminder.fireAt) return false;
    const fireAt = Date.parse(reminder.fireAt);
    return fireAt >= earliestFireAt && fireAt <= latestFireAt;
  });
}

export function isPushSubscription(value: unknown): value is StoredPushSubscription {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.endpoint !== 'string') return false;
  try {
    if (new URL(candidate.endpoint).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  if (typeof candidate.keys !== 'object' || candidate.keys === null || Array.isArray(candidate.keys)) return false;
  const keys = candidate.keys as Record<string, unknown>;
  return typeof keys.p256dh === 'string' && keys.p256dh.length > 0 &&
    typeof keys.auth === 'string' && keys.auth.length > 0 &&
    (candidate.expirationTime === undefined || candidate.expirationTime === null ||
      typeof candidate.expirationTime === 'number');
}
