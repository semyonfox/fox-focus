import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daySegment, layoutDay, minuteOfDay } from '../src/calendar-layout.ts';
const date = '2026-10-07';
const entry = { id: 'lecture', date, time: '15:00', duration: 60 };

test('current time is inside the running event and overlaps have independent columns', () => {
  const rows = layoutDay([entry, { ...entry, id: 'meeting', time: '15:15', duration: 30 }, { ...entry, id: 'next', time: '16:00' }], date);
  const now = minuteOfDay('15:08');
  assert.ok(rows[0].start < now && now < rows[0].end);
  assert.deepEqual(rows.map(row => [row.entry.id, row.column, row.columns]), [['lecture', 0, 2], ['meeting', 1, 2], ['next', 0, 1]]);
});

test('overnight events are clipped to each date, ending at midnight adds no extra day', () => {
  const overnight = { ...entry, time: '23:30', duration: 90 };
  assert.deepEqual(daySegment(overnight, date), { start: 1410, end: 1440 });
  assert.deepEqual(daySegment(overnight, '2026-10-08'), { start: 0, end: 60 });
  assert.equal(daySegment({ ...overnight, duration: 30 }, '2026-10-08'), null);
});

test('spring and autumn events use Dublin wall-clock positions from UTC instants', () => {
  assert.deepEqual(daySegment({ id: 'spring', date: '2026-03-29', time: '00:30', startsAt: '2026-03-29T00:30:00.000Z', duration: 120 }, '2026-03-29'), { start: 30, end: 210 });
  assert.deepEqual(daySegment({ id: 'autumn', date: '2026-10-25', time: '00:30', startsAt: '2026-10-24T23:30:00.000Z', duration: 180 }, '2026-10-25'), { start: 30, end: 150 });
});
