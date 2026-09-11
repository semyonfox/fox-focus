import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrototypeData, Reminder } from '../src/model.ts';
import { deliveryKey, dueReminders } from './push.ts';

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

test('selects reminders due in the last ten minutes through now', () => {
  const reminders = [
    baseReminder,
    { ...baseReminder, id: 'boundary', fireAt: '2026-09-11T09:50:00.000Z' },
    { ...baseReminder, id: 'too-old', fireAt: '2026-09-11T09:49:59.999Z' },
    { ...baseReminder, id: 'future', fireAt: '2026-09-11T10:00:00.001Z' },
  ];
  assert.deepEqual(dueReminders(data(reminders), new Date('2026-09-11T10:00:00.000Z')).map(reminder => reminder.id), ['due', 'boundary']);
});

test('skips reminders that already fired or are not scheduled', () => {
  const reminders: Reminder[] = [
    { ...baseReminder, id: 'fired', firedAt: '2026-09-11T09:56:00.000Z' },
    { ...baseReminder, id: 'snoozed', state: 'snoozed' },
  ];
  assert.deepEqual(dueReminders(data(reminders), new Date('2026-09-11T10:00:00.000Z')), []);
});

test('skips reminders the server already delivered unless they were rescheduled', () => {
  const rescheduled = { ...baseReminder, id: 'again', fireAt: '2026-09-11T09:58:00.000Z' };
  const delivered = new Set([deliveryKey(baseReminder), `${rescheduled.id}@2026-09-11T09:30:00.000Z`]);
  assert.deepEqual(dueReminders(data([baseReminder, rescheduled]), new Date('2026-09-11T10:00:00.000Z'), delivered).map(reminder => reminder.id), ['again']);
});
