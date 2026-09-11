import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrototypeData, Reminder } from '../src/model.ts';
import { dueReminders } from './push.ts';

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
