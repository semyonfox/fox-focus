import type { Reminder } from '../src/model.ts';
import type { ReminderRow } from '../src/row-model.ts';

export type StoredPushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

export type StoredPushDelivery = {
  deliveryKey: string;
  endpoint: string;
};

export type PushDeliverySummary = {
  due: number;
  sent: number;
  failed: number;
  removed: number;
};

export type PushReminder = Pick<Reminder, 'id' | 'title' | 'when' | 'state' | 'fireAt'>;

export const PUSH_DELIVERY_GRACE_MS = 24 * 60 * 60_000;
const pushReminderTimeFormatter = new Intl.DateTimeFormat('en-IE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Dublin',
});

export function formatPushReminderTime(fireAt: string): string {
  return pushReminderTimeFormatter.format(new Date(fireAt));
}

export function mergeReminderSources(...sources: readonly (readonly PushReminder[])[]): PushReminder[] {
  const reminders = new Map<string, PushReminder>();
  for (const source of sources) {
    for (const reminder of source) {
      if (!reminders.has(reminder.id)) reminders.set(reminder.id, reminder);
    }
  }
  return [...reminders.values()];
}

export function projectRowReminder(row: ReminderRow, title: string, when: string): PushReminder | null {
  if (row.state !== 'scheduled') return null;
  return {
    id: row.id,
    title,
    when,
    state: 'scheduled',
    fireAt: row.fireAt,
  };
}

// a snoozed reminder gets a new fireAt, so the key changes and it can be delivered again
export function deliveryKey(reminder: PushReminder): string {
  return `${reminder.id}@${reminder.fireAt ?? ''}`;
}

export function subscriptionDeliveryKey(delivery: StoredPushDelivery): string {
  return `${delivery.endpoint.length}:${delivery.endpoint}${delivery.deliveryKey}`;
}

export function dueReminders(data: { reminders: readonly PushReminder[] }, now: Date): PushReminder[] {
  const latestFireAt = now.getTime();
  const earliestFireAt = latestFireAt - PUSH_DELIVERY_GRACE_MS;
  return data.reminders.filter(reminder => {
    if (reminder.state !== 'scheduled' || !reminder.fireAt) return false;
    const fireAt = Date.parse(reminder.fireAt);
    return fireAt >= earliestFireAt && fireAt <= latestFireAt;
  });
}

type DeliverPushOptions = {
  data: { reminders: readonly PushReminder[] };
  now: Date;
  subscriptions: StoredPushSubscription[];
  delivered: ReadonlySet<string>;
  send: (subscription: StoredPushSubscription, payload: string) => Promise<void>;
  markDelivered: (key: string, endpoint: string) => void;
  deleteSubscription: (endpoint: string) => boolean;
};

export async function deliverDuePushNotifications({
  data,
  now,
  subscriptions,
  delivered,
  send,
  markDelivered,
  deleteSubscription,
}: DeliverPushOptions): Promise<PushDeliverySummary> {
  const reminders = dueReminders(data, now);
  const summary: PushDeliverySummary = { due: reminders.length, sent: 0, failed: 0, removed: 0 };
  const deliveredThisTick = new Set(delivered);
  const removedEndpoints = new Set<string>();

  for (const reminder of reminders) {
    const key = deliveryKey(reminder);
    const payload = JSON.stringify({ title: reminder.title, body: reminder.when, tag: reminder.id, url: '/' });
    for (const subscription of subscriptions) {
      if (removedEndpoints.has(subscription.endpoint)) continue;
      const subscriptionKey = subscriptionDeliveryKey({ deliveryKey: key, endpoint: subscription.endpoint });
      if (deliveredThisTick.has(subscriptionKey)) continue;
      try {
        await send(subscription, payload);
        markDelivered(key, subscription.endpoint);
        deliveredThisTick.add(subscriptionKey);
        summary.sent += 1;
      } catch (error) {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
          ? error.statusCode
          : undefined;
        if (statusCode === 404 || statusCode === 410) {
          removedEndpoints.add(subscription.endpoint);
          if (deleteSubscription(subscription.endpoint)) summary.removed += 1;
        } else {
          summary.failed += 1;
        }
      }
    }
  }

  return summary;
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
