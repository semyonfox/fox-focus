import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterCalendarContextByDateRange, sortTodayCalendarContext } from '../src/integration-model.ts';

test('selected calendar day includes Dublin-local timed starts and puts all-day records first', () => {
  const records = [
    { title: 'Late meeting', startsAt: '2026-06-10T22:30:00.000Z', startsOn: null, allDay: false },
    { title: 'UTC date is the previous day', startsAt: '2026-06-09T23:15:00.000Z', startsOn: null, allDay: false },
    { title: 'Outside after Dublin midnight', startsAt: '2026-06-10T23:01:00.000Z', startsOn: null, allDay: false },
    { title: 'Outside before', startsAt: '2026-06-09T12:00:00.000Z', startsOn: null, allDay: false },
    { title: 'Conference day', startsAt: null, startsOn: '2026-06-10', allDay: true },
  ];

  const selected = filterCalendarContextByDateRange(records, '2026-06-10', '2026-06-10');

  assert.deepEqual(selected.map(item => item.title), [
    'Conference day',
    'UTC date is the previous day',
    'Late meeting',
  ]);
  assert.deepEqual(records.map(item => item.title), [
    'Late meeting',
    'UTC date is the previous day',
    'Outside after Dublin midnight',
    'Outside before',
    'Conference day',
  ]);
});

test('selected calendar range is inclusive at both all-day date boundaries', () => {
  const selected = filterCalendarContextByDateRange([
    { title: 'Before range', startsAt: null, startsOn: '2026-09-09', allDay: true },
    { title: 'First day', startsAt: null, startsOn: '2026-09-10', allDay: true },
    { title: 'Middle day', startsAt: '2026-09-11T08:00:00.000Z', startsOn: null, allDay: false },
    { title: 'Last day', startsAt: null, startsOn: '2026-09-12', allDay: true },
    { title: 'After range', startsAt: null, startsOn: '2026-09-13', allDay: true },
  ], '2026-09-10', '2026-09-12');

  assert.deepEqual(selected.map(item => item.title), ['First day', 'Middle day', 'Last day']);
});

test('selected calendar day respects the Dublin spring DST boundary', () => {
  const selected = filterCalendarContextByDateRange([
    { title: 'All day', startsAt: null, startsOn: '2026-03-29', allDay: true },
    { title: 'Before the clock change', startsAt: '2026-03-29T00:30:00.000Z', startsOn: null, allDay: false },
    { title: 'After the clock change', startsAt: '2026-03-29T01:30:00.000Z', startsOn: null, allDay: false },
    { title: 'UTC still says Sunday', startsAt: '2026-03-29T23:30:00.000Z', startsOn: null, allDay: false },
  ], '2026-03-29', '2026-03-29');

  assert.deepEqual(selected.map(item => item.title), [
    'All day',
    'Before the clock change',
    'After the clock change',
  ]);
});

test('invalid or reversed selected calendar ranges return no records', () => {
  const records = [{ title: 'Calendar item', startsAt: null, startsOn: '2026-09-11', allDay: true }];
  assert.deepEqual(filterCalendarContextByDateRange(records, '2026-02-30', '2026-03-01'), []);
  assert.deepEqual(filterCalendarContextByDateRange(records, '2026-09-12', '2026-09-11'), []);
});

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
