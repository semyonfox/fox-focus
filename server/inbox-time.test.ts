import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichInboxSource, expireInboxItems, inboxExpiry } from '../src/inbox-time.ts';
import { isInboxItem, isInboxSourceContext, isInboxExpiryRule, type InboxItem } from '../src/model.ts';

const item: InboxItem = {
  id: 'event-review', title: 'Conference invitation', summary: 'Review the event.', actor: 'Hermes', source: 'Calendar', status: 'new', accent: 'Work',
  sourceContext: { provider: 'google', externalId: 'event-1', containerId: 'calendar-1', connectionId: 'connection-1', endsAt: '2026-10-07T17:00:00.000Z', timing: 'confirmed' },
};

test('confirmed event expiry moves to History after exactly 24 hours and remains recoverable', () => {
  const items = [item];
  assert.equal(expireInboxItems(items, new Date('2026-10-08T16:59:59.999Z')), items);
  const expired = expireInboxItems(items, new Date('2026-10-08T17:00:00.000Z'));
  assert.equal(expired[0].status, 'handled');
  assert.equal(expired[0].expiryApplied?.destination, 'history');
  assert.equal(expired[0].title, item.title);
  assert.deepEqual(expired[0].sourceContext, item.sourceContext);
  assert.equal(item.status, 'new');
  assert.equal(expireInboxItems(expired, new Date('2026-10-10T17:00:00.000Z')), expired);
});

test('uncertain times and overdue deadlines do not automatically dismiss work', () => {
  const uncertain = { ...item, sourceContext: { ...item.sourceContext!, timing: 'suggested' as const } };
  assert.equal(inboxExpiry(uncertain), null);
  assert.equal(inboxExpiry({ ...item, sourceContext: { provider: 'canvas', externalId: 'assignment-1', dueAt: '2026-10-07T17:00:00.000Z', dueOn: '2026-10-07', timing: 'confirmed' } }), null);
  assert.equal(inboxExpiry({ ...item, expiryRule: { enabled: false, graceMinutes: 1440, destination: 'history' } }), null);
});

test('custom dates, grace periods and moving to Automations work once', () => {
  const custom: InboxItem = { ...item, expiryRule: { enabled: true, at: '2026-10-09T12:00:00.000Z', graceMinutes: 60, destination: 'automation' } };
  assert.equal(inboxExpiry(custom)?.moveAt, '2026-10-09T13:00:00.000Z');
  const moved = expireInboxItems([custom], new Date('2026-10-09T13:00:00.000Z'));
  assert.equal(moved[0].lane, 'automation');
  assert.equal(moved[0].status, 'new');
  assert.equal(inboxExpiry(moved[0]), null);
});

test('the grace period is elapsed time across Dublin clock changes', () => {
  const fall = { ...item, sourceContext: { ...item.sourceContext!, endsAt: '2026-10-24T22:00:00.000Z' } };
  const spring = { ...item, sourceContext: { ...item.sourceContext!, endsAt: '2026-03-28T22:00:00.000Z' } };
  assert.equal(inboxExpiry(fall)?.moveAt, '2026-10-25T22:00:00.000Z');
  assert.equal(inboxExpiry(spring)?.moveAt, '2026-03-29T22:00:00.000Z');
});

test('source enrichment requires the exact connection, container and ID; refreshed source times replace stale suggestions', () => {
  const record = { provider: 'google', externalId: 'event-1', containerId: 'calendar-1', connectionId: 'connection-1', kind: 'calendar_event', startsAt: '2026-10-09T14:00:00.000Z', endsAt: '2026-10-09T17:00:00.000Z', dueOn: null };
  const enriched = enrichInboxSource({ ...item, sourceContext: { ...item.sourceContext!, timing: 'suggested', expiresAt: '2026-10-01T12:00:00.000Z' } }, [record]);
  assert.equal(enriched.sourceContext?.timing, 'confirmed');
  assert.equal(enriched.sourceContext?.expiresAt, undefined);
  assert.equal(enriched.sourceContext?.endsAt, record.endsAt);
  assert.equal(inboxExpiry(enriched)?.moveAt, '2026-10-10T17:00:00.000Z');
  assert.equal(enrichInboxSource(item, [{ ...record, connectionId: 'different-account' }]), item);
  assert.equal(enrichInboxSource(item, [record, record]), item);
  assert.equal(enrichInboxSource(item, [{ ...record, externalId: 'different-event' }]), item);
  const allDay = enrichInboxSource(item, [{ ...record, startsAt: null, startsOn: '2026-10-24', endsAt: null, endsOn: '2026-10-26' }]);
  assert.equal(allDay.sourceContext?.startsAt, '2026-10-23T23:00:00.000Z');
  assert.equal(allDay.sourceContext?.endsAt, '2026-10-26T00:00:00.000Z');
});

test('source context and expiry rules reject malformed dates and unbounded grace periods', () => {
  assert.equal(isInboxItem(item), true);
  assert.equal(isInboxSourceContext({ ...item.sourceContext, endsAt: '2026-02-30T17:00:00Z' }), false);
  assert.equal(isInboxSourceContext({ ...item.sourceContext, startsAt: '2026-10-08T17:00:00Z' }), false);
  assert.equal(isInboxExpiryRule({ enabled: true, graceMinutes: -1, destination: 'history' }), false);
  assert.equal(isInboxExpiryRule({ enabled: true, graceMinutes: 43201, destination: 'history' }), false);
  assert.equal(isInboxExpiryRule({ enabled: true, graceMinutes: 60, destination: 'delete' }), false);
});
