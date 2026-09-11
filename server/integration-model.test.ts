import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortTodayCalendarContext } from '../src/integration-model.ts';

test('Today calendar context puts current and future items before the rolling past window', () => {
  const ordered = sortTodayCalendarContext([
    { title: 'Older', startsAt: null, startsOn: '2026-09-01' },
    { title: 'Tomorrow', startsAt: '2026-09-12T08:00:00.000Z', startsOn: null },
    { title: 'Today', startsAt: null, startsOn: '2026-09-11' },
    { title: 'Yesterday', startsAt: null, startsOn: '2026-09-10' },
  ], new Date('2026-09-11T10:00:00.000Z'));
  assert.deepEqual(ordered.map(item => item.title), ['Today', 'Tomorrow', 'Yesterday', 'Older']);
});

test('Today calendar context uses Europe/Dublin dates across the DST change', () => {
  const ordered = sortTodayCalendarContext([
    { title: 'Late on the DST day', startsAt: '2026-03-29T23:30:00.000Z', startsOn: null },
    { title: 'Early on the DST day', startsAt: '2026-03-29T00:30:00.000Z', startsOn: null },
  ], new Date('2026-03-29T00:30:00.000Z'));
  assert.deepEqual(ordered.map(item => item.title), ['Early on the DST day', 'Late on the DST day']);
});
