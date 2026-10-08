import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.ts';
import { openStore } from './store.ts';
import { reviewItemFromRow } from '../src/inbox-review.ts';
import { enrichInboxSource } from '../src/inbox-time.ts';

test('source-backed row proposals retain local review context without changing execution records', async () => {
  const store = openStore(':memory:');
  const password = 'isolated-review-test-password';
  const token = 'isolated-review-test-token-value';
  const authorization = `Basic ${Buffer.from(`fox:${password}`).toString('base64')}`;
  let now = new Date('2026-10-07T11:00:00Z');
  const app = createApp(store, password, undefined, undefined, { taskStatusToken: token, now: () => now });
  const proposal = {
    expectedVersion: null, source: { kind: 'hermes', reference: 'confirmed-event-42' },
    title: 'Review university event', summary: 'An event invitation.', likelyNoise: false,
    lane: 'review', existingHermesTaskId: 'personal-task-42',
    recommendation: { outcome: 'needs-decision', reason: 'An invitation needs a response.', nextStep: 'Do you want to attend?' },
    sourceContext: { provider: 'canvas', externalId: 'event-42', timing: 'confirmed', endsAt: '2026-10-07T13:00:00+01:00' },
  };
  const submit = (body: unknown) => app.request('/api/v1/inbox/event-42', {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await submit({ ...proposal, sourceContext: { ...proposal.sourceContext, endsAt: 'bad-date' } })).status, 400);
    assert.equal((await submit(proposal)).status, 201);
    const row = store.listInboxItems()[0];
    const review = store.read().data.inboxItems[0];
    assert.equal(review.id, row.id);
    assert.equal(review.sourceContext?.endsAt, '2026-10-07T12:00:00.000Z');
    assert.equal(review.existingHermesTaskId, 'personal-task-42');
    assert.equal(reviewItemFromRow(row, review).recommendation?.outcome, 'needs-decision');
    const snapshot = store.read();
    const put = (data: unknown) => app.request('/api/v1/workspace', {
      method: 'PUT', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: snapshot.revision, data }),
    });
    assert.equal((await put({ ...snapshot.data, inboxItems: [{ ...review, title: 'Forged source title' }] })).status, 403);
    assert.equal((await put({ ...snapshot.data, inboxItems: [{ ...review, id: 'unverified-id' }] })).status, 403);
    assert.equal((await put({ ...snapshot.data, inboxItems: [] })).status, 403);
    assert.equal((await put({ ...snapshot.data, inboxItems: [{ ...review, reviewDecision: { outcome: 'awareness', note: 'Keep for reference', savedAt: now.toISOString() } }] })).status, 200);
    now = new Date('2026-10-08T12:00:00Z');
    assert.equal((await app.request('/api/v1/workspace', { headers: { authorization } })).status, 200);
    const archived = store.read().data.inboxItems[0];
    assert.equal(archived.status, 'handled');
    assert.equal(archived.expiryApplied?.destination, 'history');
    assert.equal(archived.reviewDecision?.note, 'Keep for reference');
    const revision = store.read().revision;
    assert.equal((await submit(proposal)).status, 200);
    assert.equal(store.read().revision, revision);
    assert.equal((await submit({ ...proposal, lane: 'automation' })).status, 409);
    assert.deepEqual(store.listInboxItems(), [row]);
    assert.deepEqual(store.listTasks(), []);
    assert.deepEqual(store.listJobs(), []);
    assert.deepEqual(store.listActions(), []);
    assert.deepEqual(store.listReminders(), []);
    const restored = reviewItemFromRow({ ...row, state: 'resolved', outcome: 'read' }, {
      ...archived, status: 'new', expiryApplied: undefined,
      expiryRule: { enabled: false, graceMinutes: 1440, destination: 'history' },
    });
    assert.equal(restored.status, 'new');
    assert.equal(restored.expiryRule?.enabled, false);
  } finally { store.close(); }
});

test('confirmed distinct expiry survives an exact source refresh', () => {
  const context = { provider: 'google' as const, externalId: 'event-1', containerId: 'calendar-1', connectionId: 'account-1', timing: 'confirmed' as const, expiresAt: '2026-10-06T12:00:00Z' };
  const item = { id: 'invite', title: 'Registration closes', summary: 'An earlier registration cutoff.', source: 'Hermes', actor: 'Hermes', accent: 'Personal' as const, status: 'new' as const, sourceContext: context };
  const record = { provider: 'google', externalId: 'event-1', containerId: 'calendar-1', connectionId: 'account-1', kind: 'calendar_event', startsAt: '2026-10-20T12:00:00Z', endsAt: '2026-10-20T15:00:00Z', dueOn: null };
  const refreshed = enrichInboxSource(item, [record]);
  assert.equal(refreshed.sourceContext?.expiresAt, '2026-10-06T12:00:00.000Z');
  assert.equal(refreshed.sourceContext?.endsAt, '2026-10-20T15:00:00.000Z');
});

test('a verified row can receive local review metadata without a previous workspace copy', async () => {
  const store = openStore(':memory:');
  const password = 'isolated-review-test-password';
  const authorization = `Basic ${Buffer.from(`fox:${password}`).toString('base64')}`;
  const headers = { authorization, 'Content-Type': 'application/json' };
  const app = createApp(store, password);
  try {
    const response = await app.request('/api/v1/inbox/row-only', {
      method: 'PUT', headers, body: JSON.stringify({ expectedVersion: null, source: { kind: 'hermes', reference: 'row-only' }, title: 'Canvas assignment', summary: 'Check the assignment.', likelyNoise: false }),
    });
    assert.equal(response.status, 201);
    const row = store.listInboxItems()[0];
    const snapshot = store.read();
    assert.deepEqual(snapshot.data.inboxItems, []);
    const item = { ...reviewItemFromRow(row), reviewDecision: { outcome: 'awareness', note: 'Already tracked', savedAt: new Date().toISOString() } };
    const saved = await app.request('/api/v1/workspace', { method: 'PUT', headers, body: JSON.stringify({ ...snapshot, data: { ...snapshot.data, inboxItems: [item] } }) });
    assert.equal(saved.status, 200);
    assert.equal(store.read().data.inboxItems[0].reviewDecision?.note, 'Already tracked');
    assert.deepEqual(store.listInboxItems(), [row]);
    assert.deepEqual(store.listActions(), []);
  } finally { store.close(); }
});
