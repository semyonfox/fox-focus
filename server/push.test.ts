import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrototypeData, Reminder } from '../src/model.ts';
import {
  deliverDuePushNotifications,
  deliveryKey,
  dueReminders,
  subscriptionDeliveryKey,
  type StoredPushSubscription,
} from './push.ts';

const baseReminder: Reminder = {
  id: 'due',
  targetId: 'task-1',
  targetType: 'task',
  title: 'Start assignment',
  mode: 'one-hour',
  when: '1 hour before',
  state: 'scheduled',
  fireAt: '2026-09-11T09:55:00.000Z',
};

function data(reminders: Reminder[]): PrototypeData {
  return { tasks: [], events: [], inboxItems: [], reminders };
}

const firstSubscription: StoredPushSubscription = {
  endpoint: 'https://push.example.test/first',
  keys: { p256dh: 'first-public-key', auth: 'first-auth-secret' },
};
const secondSubscription: StoredPushSubscription = {
  endpoint: 'https://push.example.test/second',
  keys: { p256dh: 'second-public-key', auth: 'second-auth-secret' },
};

test('selects reminders due in the last 24 hours through now', () => {
  const reminders = [
    baseReminder,
    { ...baseReminder, id: 'boundary', fireAt: '2026-09-10T10:00:00.000Z' },
    { ...baseReminder, id: 'too-old', fireAt: '2026-09-10T09:59:59.999Z' },
    { ...baseReminder, id: 'future', fireAt: '2026-09-11T10:00:00.001Z' },
  ];
  assert.deepEqual(dueReminders(data(reminders), new Date('2026-09-11T10:00:00.000Z')).map(reminder => reminder.id), ['due', 'boundary']);
});

test('server delivery ignores shared firedAt but skips reminders that are not scheduled', () => {
  const reminders: Reminder[] = [
    { ...baseReminder, id: 'fired', firedAt: '2026-09-11T09:56:00.000Z' },
    { ...baseReminder, id: 'snoozed', state: 'snoozed' },
  ];
  assert.deepEqual(dueReminders(data(reminders), new Date('2026-09-11T10:00:00.000Z')).map(reminder => reminder.id), ['fired']);
});

test('tracks success per subscription and sends only to the device still pending', async () => {
  const key = deliveryKey(baseReminder);
  const delivered = new Set([subscriptionDeliveryKey({ deliveryKey: key, endpoint: firstSubscription.endpoint })]);
  const sent: string[] = [];
  const marked: string[] = [];
  const summary = await deliverDuePushNotifications({
    data: data([baseReminder]),
    now: new Date('2026-09-11T10:00:00.000Z'),
    subscriptions: [firstSubscription, secondSubscription],
    delivered,
    send: async subscription => { sent.push(subscription.endpoint); },
    markDelivered: (delivery, endpoint) => { marked.push(subscriptionDeliveryKey({ deliveryKey: delivery, endpoint })); },
    deleteSubscription: () => false,
  });

  assert.deepEqual(sent, [secondSubscription.endpoint]);
  assert.deepEqual(marked, [subscriptionDeliveryKey({ deliveryKey: key, endpoint: secondSubscription.endpoint })]);
  assert.deepEqual(summary, { due: 1, sent: 1, failed: 0, removed: 0 });
});

test('does not mark a reminder with no subscriptions or after a failed send, so it can retry', async () => {
  const marked: string[] = [];
  const options = {
    data: data([baseReminder]),
    now: new Date('2026-09-11T10:00:00.000Z'),
    delivered: new Set<string>(),
    markDelivered: (key: string, endpoint: string) => { marked.push(subscriptionDeliveryKey({ deliveryKey: key, endpoint })); },
    deleteSubscription: () => false,
  };
  const withoutSubscriptions = await deliverDuePushNotifications({
    ...options,
    subscriptions: [],
    send: async () => { throw new Error('send should not run'); },
  });
  assert.deepEqual(withoutSubscriptions, { due: 1, sent: 0, failed: 0, removed: 0 });
  assert.deepEqual(marked, []);

  const failed = await deliverDuePushNotifications({
    ...options,
    subscriptions: [firstSubscription],
    send: async () => { throw new Error('temporary provider failure'); },
  });
  assert.deepEqual(failed, { due: 1, sent: 0, failed: 1, removed: 0 });
  assert.deepEqual(marked, []);

  const retried = await deliverDuePushNotifications({
    ...options,
    subscriptions: [firstSubscription],
    send: async () => {},
  });
  assert.deepEqual(retried, { due: 1, sent: 1, failed: 0, removed: 0 });
  assert.equal(marked.length, 1);
});
