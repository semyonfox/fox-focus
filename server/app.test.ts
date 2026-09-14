import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.ts';
import type { HermesMirrorService } from './hermes.ts';
import type { GoogleTaskWriteResult, IntegrationService } from './integrations.ts';
import { ROW_SCHEMA_VERSION } from './row-store.ts';
import { openStore, type ImportedRecord } from './store.ts';
import type { HermesFeed } from '../src/hermes-model.ts';
import type { PrototypeData } from '../src/model.ts';

function testData(): PrototypeData {
  return {
    tasks: [{ id: 'test-task', title: 'Test task', area: 'Personal', state: 'scheduled',
      duration: '30 min', due: 'Today', priority: 'medium', completed: false,
      scheduledDate: '2026-09-11', scheduledTime: '10:00', linkedEventId: 'test-block', origin: 'manual' }],
    events: [
      { id: 'test-context', title: 'Read-only test context', subtitle: '', area: 'Work',
        date: '2026-09-11', start: '09:00', duration: 30, editable: false, origin: 'fixture' },
      { id: 'test-block', title: 'Test task', subtitle: '', area: 'Personal',
        date: '2026-09-11', start: '10:00', duration: 30, editable: true, origin: 'task', taskId: 'test-task' },
    ],
    inboxItems: [], reminders: [],
  };
}

test('a fresh workspace starts empty', () => {
  const store = openStore(':memory:');
  try {
    assert.deepEqual(store.read(), { revision: 0, data: { tasks: [], events: [], inboxItems: [], reminders: [], listAreas: {} } });
  } finally { store.close(); }
});

test('an existing legacy workspace password remains valid', async () => {
  const store = openStore(':memory:');
  const legacyPassword = 'legacy-8';
  const legacyAuthorization = `Basic ${Buffer.from(`fox:${legacyPassword}`).toString('base64')}`;
  try {
    const app = createApp(store, legacyPassword);
    assert.equal((await app.request('/api/v1/workspace', { headers: { authorization: legacyAuthorization } })).status, 200);
    assert.throws(() => createApp(store, 'shorter'), /at least 8 characters/);
    assert.throws(
      () => createApp(store, legacyPassword, undefined, undefined, { taskStatusToken: 'shorter' }),
      /Hermes task-status token must have at least 24 characters/,
    );
  } finally { store.close(); }
});

const password = 'test-only-password-at-least-24-characters';
const authorization = `Basic ${Buffer.from(`fox:${password}`).toString('base64')}`;
const unusedTaskCreation: Pick<IntegrationService, 'listGoogleTaskDestinations' | 'createGoogleTask' | 'reconcileGoogleTaskCreate'> = {
  listGoogleTaskDestinations: () => ({
    accountId: null, connectionGeneration: null, destinations: [], fallbackListId: null,
  }),
  createGoogleTask: async () => ({ outcome: 'failed', notice: 'unused', retryable: false }),
  reconcileGoogleTaskCreate: async () => ({ outcome: 'unknown', notice: 'unused' }),
};

function linkedTaskData(): PrototypeData {
  return {
    tasks: [{
      id: 'linked-task', title: 'Linked task', area: 'Personal', state: 'up-next', duration: '30 min', due: 'Today',
      priority: 'medium', completed: false, scheduledTime: null, origin: 'migration', createdAt: '2026-09-13T09:00:00.000Z',
      externalLinks: [{
        provider: 'google_tasks', connectionId: 'google-connection-1', containerId: 'list-1', containerName: 'Personal',
        externalId: 'source-1', policy: 'completion_only', sourceStatus: 'needsAction', sourceVersion: 'etag-1',
        linkedAt: '2026-09-13T09:00:00.000Z',
      }],
    }],
    events: [], inboxItems: [], reminders: [],
  };
}

function googleTaskRecord(overrides: Partial<ImportedRecord> = {}): ImportedRecord {
  return {
    provider: 'google', connectionId: 'google-connection-1', kind: 'task', containerId: 'list-1', containerName: 'Personal',
    externalId: 'source-1', title: 'Linked task', status: 'needsAction', startsAt: null, endsAt: null,
    startsOn: null, endsOn: null, allDay: false, dueOn: null, completedAt: null,
    sourceUpdatedAt: '2026-09-13T09:00:00.000Z', sourceVersion: 'etag-1', sourceUrl: null, sourceTimeZone: null,
    completionWritable: true,
    ...overrides,
  };
}

function connectGoogle(store: ReturnType<typeof openStore>) {
  store.saveConnection({
    provider: 'google', connectionId: 'google-connection-1', state: 'connected', scopes: ['https://www.googleapis.com/auth/tasks'],
    tokenEnvelope: null, connectedAt: '2026-09-13T09:00:00.000Z', updatedAt: '2026-09-13T09:00:00.000Z',
    lastSyncedAt: null, lastError: null,
  });
}

test('workspace API protects data, validates writes and rejects stale revisions', async () => {
  const store = openStore(':memory:', testData());
  try {
    const app = createApp(store, password);
    assert.equal((await app.request('/api/v1/workspace')).status, 401);
    assert.equal((await app.request('/app')).status, 401);
    assert.equal((await app.request('/')).status, 401);
    const legacy = await app.request('/app', { headers: { authorization } });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('Location'), '/');
    assert.equal((await app.request('/api/v1/hermes')).status, 401);
    assert.equal((await app.request('/api/v1/hermes', { headers: { authorization } })).status, 200);
    assert.equal((await app.request('/healthz')).status, 200);
    const put = (body: unknown, origin?: string) => app.request('/api/v1/workspace', {
      method: 'PUT', headers: { authorization, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
    });
    const snapshot = store.read();
    const editableEvent = snapshot.data.events.find(event => event.editable);
    assert.ok(editableEvent);
    editableEvent.subtitle = 'Saved local note';
    assert.equal((await put(snapshot)).status, 200);
    assert.equal(store.read().data.events.find(event => event.editable)?.subtitle, 'Saved local note');
    assert.equal((await put(snapshot)).status, 409);
    assert.equal((await put({ revision: 1, data: {} })).status, 400);
    assert.equal((await put(store.read(), 'https://evil.example')).status, 403);
    const imported = store.read();
    const readOnly = imported.data.events.find(event => !event.editable);
    assert.ok(readOnly);
    readOnly.title = 'Forbidden imported edit';
    assert.equal((await put(imported)).status, 403);
    const duplicate = store.read();
    duplicate.data.tasks.push(duplicate.data.tasks[0]);
    assert.equal((await put(duplicate)).status, 400);
    const badTime = store.read();
    badTime.data.events[0].start = '26:99';
    assert.equal((await put(badTime)).status, 400);
    const badDate = store.read();
    badDate.data.events[0].date = '2026-02-30';
    assert.equal((await put(badDate)).status, 400);
    assert.equal(store.read().revision, 1);
  } finally { store.close(); }
});

test('workspace writes cannot create, alter, detach, complete, or delete externally linked tasks', async () => {
  const store = openStore(':memory:', linkedTaskData());
  try {
    const app = createApp(store, password);
    const put = (body: unknown) => app.request('/api/v1/workspace', {
      method: 'PUT', headers: { authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const fabricated = store.read();
    fabricated.data.tasks.push({
      ...fabricated.data.tasks[0],
      id: 'fabricated-linked-task',
      title: 'Fabricated linked task',
      externalLinks: [{ ...fabricated.data.tasks[0].externalLinks![0], externalId: 'fabricated-source' }],
    });
    assert.equal((await put(fabricated)).status, 403, 'cannot fabricate a provider link');

    const mutated = store.read();
    mutated.data.tasks[0].externalLinks![0].sourceVersion = 'fabricated-etag';
    assert.equal((await put(mutated)).status, 403, 'cannot mutate provider metadata');

    const detached = store.read();
    delete detached.data.tasks[0].externalLinks;
    assert.equal((await put(detached)).status, 403, 'cannot detach a provider link');

    const completed = store.read();
    completed.data.tasks[0].completed = true;
    completed.data.tasks[0].completedAt = '2026-09-13T10:00:00.000Z';
    completed.data.tasks[0].state = 'done';
    assert.equal((await put(completed)).status, 403, 'cannot bypass completion approval');

    const deleted = store.read();
    deleted.data.tasks = [];
    assert.equal((await put(deleted)).status, 403, 'cannot delete an adopted task');
    assert.deepEqual(store.read(), { revision: 0, data: linkedTaskData() });
  } finally {
    store.close();
  }
});

test('SQLite keeps edits across restart and preserves task/event transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-focus-test-'));
  const path = join(dir, 'test.sqlite');
  let store = openStore(path, testData());
  try {
    const snapshot = store.read();
    snapshot.data.tasks[0].title = 'Survives restart';
    assert.ok(store.save(snapshot.revision, snapshot.data));
    store.close();
    store = openStore(path);
    assert.equal(store.read().revision, 1);
    assert.equal(store.read().data.tasks[0].title, 'Survives restart');
    assert.equal(store.read().data.tasks[0].linkedEventId, 'test-block');
    assert.equal(store.read().data.tasks[0].scheduledDate, '2026-09-11');
    assert.equal(store.read().data.events.find(event => event.id === 'test-block')?.taskId, 'test-task');
    assert.equal(store.read().data.events.find(event => event.id === 'test-block')?.date, '2026-09-11');
    assert.equal(store.save(0, snapshot.data), null);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('SQLite adds the Hermes mirror schema to an existing workspace without changing its data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-focus-hermes-migration-'));
  const path = join(dir, 'test.sqlite');
  let store = openStore(path, testData());
  try {
    const snapshot = store.read();
    snapshot.data.tasks[0].title = 'Keep this existing task';
    assert.ok(store.save(snapshot.revision, snapshot.data));
    store.close();

    const previous = new DatabaseSync(path);
    previous.exec(`
      DROP TABLE hermes_actions;
      DROP TABLE hermes_task_annotations;
      DROP TABLE hermes_task_mirrors;
      DROP TABLE hermes_sync_state;
    `);
    assert.equal((previous.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, ROW_SCHEMA_VERSION);
    previous.close();

    store = openStore(path);
    assert.equal(store.read().revision, 1);
    assert.equal(store.read().data.tasks[0].title, 'Keep this existing task');
    const migrated = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = new Set((migrated.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map(row => row.name));
      for (const table of ['hermes_sync_state', 'hermes_task_mirrors', 'hermes_task_annotations', 'hermes_actions']) {
        assert.ok(tables.has(table), `${table} was not created`);
      }
    } finally { migrated.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('integration routes keep browser OAuth callbacks authenticated and expose no token material', async () => {
  const store = openStore(':memory:');
  let callbackQuery = '';
  const integrations: IntegrationService = {
    ...unusedTaskCreation,
    overview: () => ({
      providers: [
        {
          provider: 'google', displayName: 'Google', configured: true, connection: null,
          sync: { provider: 'google', state: 'idle', startedAt: null, completedAt: null, recordCount: 0, lastError: null },
          calendarEventCount: 0, taskCount: 0,
        },
        {
          provider: 'microsoft', displayName: 'Microsoft', configured: false, connection: null,
          sync: { provider: 'microsoft', state: 'idle', startedAt: null, completedAt: null, recordCount: 0, lastError: null },
          calendarEventCount: 0, taskCount: 0,
        },
      ], records: [],
    }),
    startAuthorization: provider => provider === 'google' ? 'https://accounts.example.test/authorize?state=opaque' : null,
    completeAuthorization: async (_provider, search) => {
      callbackQuery = search.toString();
      return { outcome: 'connected', notice: 'Connected.' };
    },
    sync: async () => ({ outcome: 'synced', recordCount: 2 }),
    syncConnected: async () => {},
    updateGoogleTaskCompletion: async () => ({
      outcome: 'succeeded', sourceStatus: 'completed', sourceVersion: 'etag-2',
      sourceUpdatedAt: '2026-09-11T10:00:00.000Z', completedAt: '2026-09-11T10:00:00.000Z',
    }),
  };
  try {
    const app = createApp(store, password, undefined, integrations);
    assert.equal((await app.request('/api/v1/integrations')).status, 401);
    const overview = await app.request('/api/v1/integrations', { headers: { authorization } });
    assert.equal(overview.status, 200);
    assert.ok(!JSON.stringify(await overview.json()).includes('token'));
    const connect = await app.request('/api/v1/integrations/google/connect', { headers: { authorization }, redirect: 'manual' });
    assert.equal(connect.status, 302);
    assert.equal(connect.headers.get('location'), 'https://accounts.example.test/authorize?state=opaque');
    assert.equal((await app.request('/api/v1/integrations/microsoft/connect', { headers: { authorization } })).status, 404);
    const callback = await app.request('/api/v1/integrations/google/callback?state=opaque&code=one-time', { headers: { authorization }, redirect: 'manual' });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/?integration=google&result=connected');
    assert.equal(callbackQuery, 'state=opaque&code=one-time');
    const sync = await app.request('/api/v1/integrations/google/sync', { method: 'POST', headers: { authorization } });
    assert.equal(sync.status, 200);
    assert.deepEqual(await sync.json(), { outcome: 'synced', recordCount: 2 });
  } finally { store.close(); }
});

test('push subscription API accepts valid subscriptions and rejects non-HTTPS endpoints', async () => {
  const store = openStore(':memory:');
  try {
    const app = createApp(store, password, undefined, undefined, { pushPublicKey: 'test-public-key' });
    const request = (body: unknown) => app.request('/api/v1/push/subscriptions', {
      method: 'POST',
      headers: { authorization, 'Content-Type': 'application/json', 'User-Agent': 'test-browser' },
      body: JSON.stringify(body),
    });
    const valid = { endpoint: 'https://push.example.test/subscription/1', keys: { p256dh: 'public-key', auth: 'auth-secret' } };
    assert.equal((await request(valid)).status, 201);
    assert.equal(store.listPushSubscriptions().length, 1);
    assert.equal(store.listPushSubscriptions()[0].userAgent, 'test-browser');
    assert.equal((await request({ ...valid, endpoint: 'http://push.example.test/insecure' })).status, 400);
    assert.equal(store.listPushSubscriptions().length, 1);
  } finally { store.close(); }
});

test('SQLite tracks push delivery per subscription and removes delivery state with its subscription', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-focus-push-delivery-'));
  const path = join(dir, 'test.sqlite');
  let store = openStore(path);
  const first = { endpoint: 'https://push.example.test/first', keys: { p256dh: 'first-key', auth: 'first-auth' } };
  const second = { endpoint: 'https://push.example.test/second', keys: { p256dh: 'second-key', auth: 'second-auth' } };
  try {
    store.savePushSubscription(first, null);
    store.savePushSubscription(second, null);
    store.markPushDelivered('reminder-1@2026-09-11T10:00:00.000Z', first.endpoint);
    store.markPushDelivered('reminder-1@2026-09-11T10:00:00.000Z', first.endpoint);
    store.markPushDelivered('reminder-1@2026-09-11T10:00:00.000Z', second.endpoint);
    store.close();
    store = openStore(path);
    assert.deepEqual(store.listPushDeliveries(), [
      { deliveryKey: 'reminder-1@2026-09-11T10:00:00.000Z', endpoint: first.endpoint },
      { deliveryKey: 'reminder-1@2026-09-11T10:00:00.000Z', endpoint: second.endpoint },
    ]);
    assert.equal(store.deletePushSubscription(first.endpoint), true);
    assert.deepEqual(store.listPushDeliveries(), [{
      deliveryKey: 'reminder-1@2026-09-11T10:00:00.000Z', endpoint: second.endpoint,
    }]);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('SQLite migrates the global delivery ledger without dropping its table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-focus-push-migration-'));
  const path = join(dir, 'test.sqlite');
  const endpoint = 'https://push.example.test/existing';
  const legacy = new DatabaseSync(path);
  legacy.exec(`PRAGMA user_version=3;
    CREATE TABLE push_deliveries (delivery_key TEXT PRIMARY KEY, fired_at TEXT NOT NULL);
    CREATE TABLE push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription_json TEXT NOT NULL CHECK(json_valid(subscription_json)),
      user_agent TEXT,
      created_at TEXT NOT NULL
    );`);
  legacy.prepare('INSERT INTO push_deliveries VALUES (?, ?)')
    .run('reminder-1@2026-09-11T10:00:00.000Z', '2026-09-11T10:00:01.000Z');
  legacy.prepare('INSERT INTO push_subscriptions VALUES (?, ?, NULL, ?)')
    .run(endpoint, JSON.stringify({ endpoint, keys: { p256dh: 'public-key', auth: 'auth-secret' } }), '2026-09-11T09:00:00.000Z');
  legacy.close();

  const store = openStore(path);
  try {
    assert.deepEqual(store.listPushDeliveries(), [{
      deliveryKey: 'reminder-1@2026-09-11T10:00:00.000Z', endpoint,
    }]);
    const db = new DatabaseSync(path);
    try {
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, ROW_SCHEMA_VERSION);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_deliveries'").get());
    } finally { db.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test('Hermes can upsert email Inbox rows and run a claim-bound job through the five-route API', async () => {
  const store = openStore(':memory:', testData());
  const token = 'hermes-test-token-at-least-24-characters';
  const bearer = `Bearer ${token}`;
  try {
    const app = createApp(store, password, undefined, undefined, {
      taskStatusToken: token,
      now: () => new Date('2026-09-13T10:00:00.000Z'),
    });
    const proposalBody = JSON.stringify({
      expectedVersion: null,
      source: { kind: 'email', accountId: 'mail-account', messageId: 'message-1', threadId: 'thread-1' },
      title: 'Check event timing', summary: 'Hermes found a possible clash.', likelyNoise: false,
      draft: {
        accountId: 'mail-account', threadId: 'thread-1', replyToMessageId: 'message-1',
        inReplyTo: '<message-1@example.test>', references: [], from: 'owner@example.test',
        to: ['sender@example.test'], cc: [], bcc: [], subject: 'Re: Event timing', bodyText: 'I will check.',
      },
    });
    const first = await app.request('/api/v1/inbox/email-message-1', {
      method: 'PUT', headers: { authorization: bearer, 'Content-Type': 'application/json' }, body: proposalBody,
    });
    assert.equal(first.status, 201);
    const firstBody = await first.json() as { item: { id: string; version: number }; draftOutcome: string };
    assert.equal(firstBody.draftOutcome, 'created');
    const second = await app.request('/api/v1/inbox/email-message-1', {
      method: 'PUT', headers: { authorization: bearer, 'Content-Type': 'application/json' }, body: proposalBody,
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { outcome: string }).outcome, 'replayed');
    const conflicting = await app.request('/api/v1/inbox/email-message-1', {
      method: 'PUT', headers: { authorization: bearer, 'Content-Type': 'application/json' },
      body: proposalBody.replace('possible clash', 'different clash'),
    });
    assert.equal(conflicting.status, 409);
    assert.equal(store.listInboxItems().length, 1);
    assert.equal(store.read().revision, 0);
    const directSent = await app.request(`/api/v1/inbox-items/${firstBody.item.id}`, {
      method: 'PUT', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: firstBody.item.version, state: 'resolved', outcome: 'sent', snoozedUntil: null }),
    });
    assert.equal(directSent.status, 400);
    assert.equal(store.getInboxItem(firstBody.item.id)?.outcome, null);

    const createJob = await app.request('/api/v1/jobs', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'job-check-event-1', title: 'Check the event', instruction: 'Confirm its start time.',
        taskId: null, inboxId: firstBody.item.id,
      }),
    });
    assert.equal(createJob.status, 201);
    const job = (await createJob.json() as { job: { id: string } }).job;
    const replayedJob = await app.request('/api/v1/jobs', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'job-check-event-1', title: 'Check the event', instruction: 'Confirm its start time.',
        taskId: null, inboxId: firstBody.item.id,
      }),
    });
    assert.equal(replayedJob.status, 200);
    assert.equal((await replayedJob.json() as { job: { id: string } }).job.id, job.id);
    assert.equal(store.listJobs().length, 1);
    const conflictingJob = await app.request('/api/v1/jobs', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'job-check-event-1', title: 'Check the event', instruction: 'Do something different.',
        taskId: null, inboxId: firstBody.item.id,
      }),
    });
    assert.equal(conflictingJob.status, 409);
    const claim = await app.request(`/api/v1/requests/${job.id}/claim`, {
      method: 'POST', headers: { authorization: bearer },
    });
    assert.equal(claim.status, 200);
    const claimBody = await claim.json() as { claimId: string };
    const multiline = await app.request(`/api/v1/requests/${job.id}/result`, {
      method: 'POST',
      headers: { authorization: bearer, 'Content-Type': 'application/json', 'X-Claim-Id': claimBody.claimId },
      body: JSON.stringify({ kind: 'progress', text: 'First line\nsecond line', url: null }),
    });
    assert.equal(multiline.status, 400);
    const progressBody = JSON.stringify({ kind: 'progress', text: 'Checking the source page.', url: null });
    const progress = await app.request(`/api/v1/requests/${job.id}/result`, {
      method: 'POST',
      headers: { authorization: bearer, 'Content-Type': 'application/json', 'X-Claim-Id': claimBody.claimId },
      body: progressBody,
    });
    assert.equal(progress.status, 200);
    const progressReplay = await app.request(`/api/v1/requests/${job.id}/result`, {
      method: 'POST',
      headers: { authorization: bearer, 'Content-Type': 'application/json', 'X-Claim-Id': claimBody.claimId },
      body: progressBody,
    });
    assert.equal((await progressReplay.json() as { outcome: string }).outcome, 'replayed');

    const context = await app.request('/api/v1/context?from=2026-09-01&to=2026-10-31', {
      headers: { authorization: bearer },
    });
    assert.equal(context.status, 200);
    const contextBody = await context.json() as { jobs: unknown[]; jobUpdates: unknown[] };
    assert.equal(contextBody.jobs.length, 1);
    assert.equal(contextBody.jobUpdates.length, 1);
  } finally {
    store.close();
  }
});

test('the Hermes bearer is accepted only on the five exact Hermes routes', async () => {
  const store = openStore(':memory:', linkedTaskData());
  const token = 'hermes-route-scope-token-at-least-24-characters';
  const bearer = `Bearer ${token}`;
  try {
    const app = createApp(store, password, undefined, undefined, { taskStatusToken: token });
    const deniedRequests: Array<{ path: string; method?: 'DELETE' | 'GET' | 'POST' | 'PUT'; body?: unknown }> = [
      { path: '/api/v1/workspace' },
      { path: '/api/v1/workspace', method: 'PUT', body: store.read() },
      { path: '/api/v1/rows' },
      { path: '/api/v1/hermes' },
      { path: '/api/v1/hermes/sync', method: 'POST' },
      { path: '/api/v1/hermes/tasks/task/annotation', method: 'PUT', body: {} },
      { path: '/api/v1/hermes/tasks/task/complete', method: 'POST', body: {} },
      { path: '/api/v1/integrations' },
      { path: '/api/v1/integrations/google/connect' },
      { path: '/api/v1/integrations/google/callback' },
      { path: '/api/v1/integrations/google/sync', method: 'POST' },
      { path: '/api/v1/task-adoptions/preview', method: 'POST', body: { source: 'google', recordId: 1 } },
      { path: '/api/v1/task-adoptions/not-an-approval/approve', method: 'POST' },
      { path: '/api/v1/task-actions' },
      {
        path: '/api/v1/task-actions/preview', method: 'POST',
        body: { taskId: 'linked-task', desiredState: 'completed', idempotencyKey: 'bearer-denied-1' },
      },
      { path: '/api/v1/task-actions/not-an-action/approve', method: 'POST' },
      { path: '/api/v1/task-actions/not-an-action/retry', method: 'POST' },
      { path: '/api/v1/task-status' },
      { path: '/api/v1/task-proposals', method: 'POST', body: {} },
      { path: '/api/v1/task-destinations' },
      { path: '/api/v1/tasks', method: 'POST', body: {} },
      { path: '/api/v1/tasks/linked-task/plan', method: 'PUT', body: {} },
      { path: '/api/v1/tasks/linked-task/status', method: 'POST', body: { version: 1, state: 'completed' } },
      { path: '/api/v1/jobs', method: 'POST', body: { title: 'No', instruction: 'No', taskId: null, inboxId: null } },
      { path: '/api/v1/jobs/not-a-job/answer', method: 'POST', body: {} },
      { path: '/api/v1/jobs/not-a-job/send-back', method: 'POST', body: {} },
      { path: '/api/v1/jobs/not-a-job/settle', method: 'POST', body: { version: 1, outcome: 'dropped' } },
      { path: '/api/v1/inbox-items/not-an-item', method: 'PUT', body: {} },
      { path: '/api/v1/inbox-items/not-an-item/drafts', method: 'POST', body: {} },
      { path: '/api/v1/push/public-key' },
      { path: '/api/v1/push/subscriptions', method: 'POST', body: {} },
      { path: '/api/v1/push/subscriptions', method: 'DELETE', body: {} },
      { path: '/api/v1/inbox/key' },
      { path: '/api/v1/inbox/key', method: 'POST', body: {} },
      { path: '/api/v1/requests/key/claim' },
      { path: '/api/v1/requests/key/result', method: 'PUT', body: {} },
    ];
    for (const request of deniedRequests) {
      const response = await app.request(request.path, {
        method: request.method ?? 'GET',
        headers: {
          authorization: bearer,
          ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      assert.equal(response.status, 401, `${request.method ?? 'GET'} ${request.path}`);
    }
    assert.equal((await app.request('/api/v1/context?from=2026-09-01&to=2026-10-31', {
      headers: { authorization: bearer },
    })).status, 200);
    assert.equal((await app.request('/api/v1/changes?after=0&limit=1', { headers: { authorization: bearer } })).status, 200);
  } finally {
    store.close();
  }
});

test('an adopted Hermes task cannot be completed through the legacy action bridge', async () => {
  const data = linkedTaskData();
  data.tasks[0].externalLinks = [{
    provider: 'hermes', containerId: 'personal-tasks', containerName: 'Personal Tasks', externalId: 'hermes-task-1',
    policy: 'read_only', sourceStatus: 'todo', sourceVersion: '1', linkedAt: '2026-09-13T09:00:00.000Z',
  }];
  const store = openStore(':memory:', data);
  const feed: HermesFeed = {
    state: 'connected', checkedAt: '2026-09-13T10:00:00.000Z', completionAvailable: true,
    board: {
      slug: 'personal-tasks', name: 'Personal Tasks', total: 1, sources: ['Direct request'],
      tasks: [{
        id: 'hermes-task-1', title: 'Linked task', status: 'todo', priority: 1, owner: 'human',
        source: 'Direct request', parentTitle: null, createdAt: '2026-09-13T09:00:00.000Z',
        updatedAt: '2026-09-13T09:30:00.000Z', version: 1, sourceProvider: null,
        sourceExternalId: null, sourceDueOn: null, sourceStatus: null, sourceContainerId: null,
        sourceContainerName: null, sourceMatchUnique: false, area: 'Personal', localState: 'up-next',
        duration: '30 min', due: 'No deadline', scheduledAt: null, reminderMode: 'none',
        reminderFireAt: null, annotationUpdatedAt: null,
      }],
    },
  };
  let legacyCompletionCalls = 0;
  const hermes: HermesMirrorService = {
    feed: () => feed,
    poll: async () => feed,
    updateAnnotation: () => null,
    completeTask: async () => {
      legacyCompletionCalls += 1;
      throw new Error('Legacy completion should not run for an adopted task');
    },
  };
  try {
    const app = createApp(store, password, hermes);
    const response = await app.request('/api/v1/hermes/tasks/hermes-task-1/complete', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        confirmation: { beforeStatus: 'todo', afterStatus: 'done', confirmedAt: '2026-09-13T10:00:00.000Z' },
      }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /owned by Fox Focus/i);
    assert.equal(legacyCompletionCalls, 0);
  } finally {
    store.close();
  }
});

test('an imported Google task is adopted explicitly and is not duplicated', async () => {
  const store = openStore(':memory:');
  try {
    store.replaceProviderRecords('google', [{
      provider: 'google', connectionId: 'google-connection-1', kind: 'task', containerId: 'list-1', containerName: 'Personal', externalId: 'source-1',
      title: 'Legacy task', status: 'needsAction', startsAt: null, endsAt: null, startsOn: null, endsOn: null,
      allDay: false, dueOn: '2026-09-14', completedAt: null, sourceUpdatedAt: '2026-09-12T10:00:00.000Z',
      sourceVersion: 'etag-1', sourceUrl: null, sourceTimeZone: null,
    }]);
    const app = createApp(store, password, undefined, undefined, { now: () => new Date('2026-09-13T10:00:00.000Z') });
    const recordId = store.listProviderRecords()[0].id;
    const preview = await app.request('/api/v1/task-adoptions/preview', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'google', recordId }),
    });
    assert.equal(preview.status, 201);
    const previewBody = await preview.json() as { id: string; before: { ownership: string }; after: { title: string } };
    assert.equal(previewBody.before.ownership, 'google');
    assert.equal(previewBody.after.title, 'Legacy task');
    const approved = await app.request(`/api/v1/task-adoptions/${previewBody.id}/approve`, {
      method: 'POST', headers: { authorization },
    });
    assert.equal(approved.status, 200);
    assert.equal(store.read().data.tasks.length, 1);
    const repeated = await app.request(`/api/v1/task-adoptions/${previewBody.id}/approve`, {
      method: 'POST', headers: { authorization },
    });
    assert.equal(repeated.status, 200);
    assert.equal(store.read().data.tasks.length, 1);
    const overview = await app.request('/api/v1/integrations', { headers: { authorization } });
    const overviewBody = await overview.json() as { records: Array<{ adoptedTaskId: string | null }> };
    assert.equal(overviewBody.records[0].adoptedTaskId, store.read().data.tasks[0].id);
  } finally {
    store.close();
  }
});

test('adoption approval rejects a provider task that changed or disappeared after preview', async () => {
  const store = openStore(':memory:');
  try {
    store.replaceProviderRecords('google', [googleTaskRecord({ title: 'Legacy task' })]);
    const app = createApp(store, password, undefined, undefined, { now: () => new Date('2026-09-13T10:00:00.000Z') });
    const preview = async () => {
      const recordId = store.listProviderRecords()[0].id;
      const response = await app.request('/api/v1/task-adoptions/preview', {
        method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'google', recordId }),
      });
      assert.equal(response.status, 201);
      return await response.json() as { id: string };
    };

    const changedPreview = await preview();
    store.replaceProviderRecords('google', [googleTaskRecord({
      title: 'Legacy task changed upstream',
      sourceUpdatedAt: '2026-09-13T09:30:00.000Z',
      sourceVersion: 'etag-2',
    })]);
    const changedApproval = await app.request(`/api/v1/task-adoptions/${changedPreview.id}/approve`, {
      method: 'POST', headers: { authorization },
    });
    assert.equal(changedApproval.status, 409);
    assert.equal(store.read().data.tasks.length, 0);

    const removedPreview = await preview();
    store.replaceProviderRecords('google', []);
    const removedApproval = await app.request(`/api/v1/task-adoptions/${removedPreview.id}/approve`, {
      method: 'POST', headers: { authorization },
    });
    assert.equal(removedApproval.status, 409);
    assert.equal(store.read().data.tasks.length, 0);
  } finally {
    store.close();
  }
});

test('approved Google completion keeps the local task done when upstream fails and can be retried safely', async () => {
  const store = openStore(':memory:', {
    tasks: [{
      id: 'linked-task', title: 'Linked task', area: 'Personal', state: 'up-next', duration: '30 min', due: 'Today',
      priority: 'medium', completed: false, scheduledTime: null, origin: 'migration', createdAt: '2026-09-13T09:00:00.000Z',
      externalLinks: [{
        provider: 'google_tasks', containerId: 'list-1', containerName: 'Personal', externalId: 'source-1',
        connectionId: 'google-connection-1', policy: 'completion_only', sourceStatus: 'needsAction', sourceVersion: 'etag-1', linkedAt: '2026-09-13T09:00:00.000Z',
      }],
    }], events: [], inboxItems: [], reminders: [],
  });
  let attempts = 0;
  const integrations: IntegrationService = {
    ...unusedTaskCreation,
    overview: () => emptyIntegrationOverview(),
    startAuthorization: () => null,
    completeAuthorization: async () => ({ outcome: 'failed', notice: 'unused' }),
    sync: async () => ({ outcome: 'synced', recordCount: 0 }),
    syncConnected: async () => {},
    updateGoogleTaskCompletion: async () => {
      attempts += 1;
      return attempts === 1
        ? { outcome: 'failed', notice: 'Temporary network failure.', retryable: true }
        : {
            outcome: 'succeeded', sourceStatus: 'completed', sourceVersion: 'etag-2',
            sourceUpdatedAt: '2026-09-13T10:03:00.000Z', completedAt: '2026-09-13T10:03:00.000Z',
          };
    },
  };
  try {
    store.saveConnection({
      provider: 'google', connectionId: 'google-connection-1', state: 'connected', scopes: ['https://www.googleapis.com/auth/tasks'],
      tokenEnvelope: null, connectedAt: '2026-09-13T09:00:00.000Z', updatedAt: '2026-09-13T09:00:00.000Z',
      lastSyncedAt: null, lastError: null,
    });
    store.replaceProviderRecords('google', [{
      provider: 'google', connectionId: 'google-connection-1', kind: 'task', containerId: 'list-1', containerName: 'Personal',
      externalId: 'source-1', title: 'Linked task', status: 'needsAction', startsAt: null, endsAt: null,
      startsOn: null, endsOn: null, allDay: false, dueOn: null, completedAt: null,
      sourceUpdatedAt: '2026-09-13T09:00:00.000Z', sourceVersion: 'etag-1', sourceUrl: null, sourceTimeZone: null,
    }]);
    const app = createApp(store, password, undefined, integrations, { now: () => new Date('2026-09-13T10:00:00.000Z') });
    const preview = await app.request('/api/v1/task-actions/preview', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'linked-task', desiredState: 'completed', idempotencyKey: 'complete-linked-1' }),
    });
    assert.equal(preview.status, 201);
    const request = await preview.json() as { id: string; status: string; before: unknown; after: unknown };
    assert.equal(request.status, 'awaiting_approval');
    assert.ok(request.before);
    assert.ok(request.after);
    const failed = await app.request(`/api/v1/task-actions/${request.id}/approve`, { method: 'POST', headers: { authorization } });
    assert.equal(failed.status, 503);
    assert.equal(store.read().data.tasks[0].completed, true);
    assert.equal(store.getTaskAction(request.id)?.status, 'failed');
    const retried = await app.request(`/api/v1/task-actions/${request.id}/retry`, { method: 'POST', headers: { authorization } });
    assert.equal(retried.status, 200);
    assert.equal(store.getTaskAction(request.id)?.status, 'succeeded');
    assert.equal(store.read().data.tasks[0].externalLinks?.[0].sourceVersion, 'etag-2');
  } finally {
    store.close();
  }
});

test('a delayed Google update blocks a second-tab action for the same task', async () => {
  const store = openStore(':memory:', linkedTaskData());
  let releaseProvider!: (result: GoogleTaskWriteResult) => void;
  let signalProviderStarted!: () => void;
  const providerStarted = new Promise<void>(resolve => { signalProviderStarted = resolve; });
  const providerResult = new Promise<GoogleTaskWriteResult>(resolve => { releaseProvider = resolve; });
  const integrations: IntegrationService = {
    ...unusedTaskCreation,
    overview: () => emptyIntegrationOverview(),
    startAuthorization: () => null,
    completeAuthorization: async () => ({ outcome: 'failed', notice: 'unused' }),
    sync: async () => ({ outcome: 'synced', recordCount: 0 }),
    syncConnected: async () => {},
    updateGoogleTaskCompletion: async () => {
      signalProviderStarted();
      return providerResult;
    },
  };
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [googleTaskRecord()]);
    const app = createApp(store, password, undefined, integrations, { now: () => new Date('2026-09-13T10:00:00.000Z') });
    const previewResponse = await app.request('/api/v1/task-actions/preview', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'linked-task', desiredState: 'completed', idempotencyKey: 'delayed-complete-1' }),
    });
    assert.equal(previewResponse.status, 201);
    const preview = await previewResponse.json() as { id: string };

    const firstApproval = app.request(`/api/v1/task-actions/${preview.id}/approve`, { method: 'POST', headers: { authorization } });
    await providerStarted;
    assert.equal(store.read().data.tasks[0].completed, true);
    const secondPreview = await app.request('/api/v1/task-actions/preview', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'linked-task', desiredState: 'open', idempotencyKey: 'delayed-reopen-1' }),
    });
    assert.equal(secondPreview.status, 409);
    assert.match((await secondPreview.json() as { error: string }).error, /still running/i);

    releaseProvider({
      outcome: 'succeeded', sourceStatus: 'completed', sourceVersion: 'etag-2',
      sourceUpdatedAt: '2026-09-13T10:01:00.000Z', completedAt: '2026-09-13T10:01:00.000Z',
    });
    assert.equal((await firstApproval).status, 200);
    assert.equal(store.read().data.tasks[0].completed, true);
    assert.equal(store.read().data.tasks[0].externalLinks?.[0].sourceVersion, 'etag-2');
  } finally {
    releaseProvider?.({ outcome: 'failed', notice: 'test cleanup', retryable: false });
    store.close();
  }
});

test('a task-action approval is rejected if the workspace changed after its exact preview', async () => {
  const store = openStore(':memory:', linkedTaskData());
  let providerWrites = 0;
  const integrations: IntegrationService = {
    ...unusedTaskCreation,
    overview: () => emptyIntegrationOverview(),
    startAuthorization: () => null,
    completeAuthorization: async () => ({ outcome: 'failed', notice: 'unused' }),
    sync: async () => ({ outcome: 'synced', recordCount: 0 }),
    syncConnected: async () => {},
    updateGoogleTaskCompletion: async () => {
      providerWrites += 1;
      return {
        outcome: 'succeeded', sourceStatus: 'completed', sourceVersion: 'etag-2',
        sourceUpdatedAt: '2026-09-13T10:00:00.000Z', completedAt: '2026-09-13T10:00:00.000Z',
      };
    },
  };
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [googleTaskRecord()]);
    const app = createApp(store, password, undefined, integrations, { now: () => new Date('2026-09-13T10:00:00.000Z') });
    const preview = await app.request('/api/v1/task-actions/preview', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'linked-task', desiredState: 'completed', idempotencyKey: 'stale-preview-1' }),
    });
    assert.equal(preview.status, 201);
    const action = await preview.json() as { id: string };

    const changed = store.read();
    changed.data.listAreas = { 'google:id:list-1': 'Personal' };
    const saved = await app.request('/api/v1/workspace', {
      method: 'PUT', headers: { authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(changed),
    });
    assert.equal(saved.status, 200);

    const approval = await app.request(`/api/v1/task-actions/${action.id}/approve`, {
      method: 'POST', headers: { authorization },
    });
    assert.equal(approval.status, 409);
    assert.equal(providerWrites, 0);
    assert.equal(store.read().data.tasks[0].completed, false);
    assert.equal(store.getTaskAction(action.id)?.status, 'conflict');
  } finally {
    store.close();
  }
});

function emptyIntegrationOverview(): ReturnType<IntegrationService['overview']> {
  return {
    providers: [
      {
        provider: 'google', displayName: 'Google', configured: false, connection: null,
        sync: { provider: 'google', state: 'idle', startedAt: null, completedAt: null, recordCount: 0, lastError: null },
        calendarEventCount: 0, taskCount: 0,
      },
      {
        provider: 'microsoft', displayName: 'Microsoft', configured: false, connection: null,
        sync: { provider: 'microsoft', state: 'idle', startedAt: null, completedAt: null, recordCount: 0, lastError: null },
        calendarEventCount: 0, taskCount: 0,
      },
    ],
    records: [],
  };
}

test('task creation exposes fresh destinations and durably queues the approved Google command', async () => {
  const store = openStore(':memory:', testData());
  let providerCreates = 0;
  let kicks = 0;
  let destinationAvailable = true;
  const integrations: IntegrationService = {
    overview: () => emptyIntegrationOverview(),
    listGoogleTaskDestinations: () => ({
      accountId: 'google-connection-1',
      connectionGeneration: 'google-generation-1',
      destinations: destinationAvailable ? [{
        accountId: 'google-connection-1', listId: 'list-personal', name: 'My Tasks',
        area: 'Personal', fallback: true, fresh: true, explicitMapping: false,
      }] : [],
      fallbackListId: destinationAvailable ? 'list-personal' : null,
    }),
    startAuthorization: () => null,
    completeAuthorization: async () => ({ outcome: 'failed', notice: 'unused' }),
    sync: async () => ({ outcome: 'synced', recordCount: 0 }),
    syncConnected: async () => {},
    updateGoogleTaskCompletion: async () => ({ outcome: 'failed', notice: 'unused', retryable: false }),
    createGoogleTask: async () => {
      providerCreates += 1;
      return { outcome: 'unknown', notice: 'unused' };
    },
    reconcileGoogleTaskCreate: async () => ({ outcome: 'unknown', notice: 'unused' }),
  };
  try {
    const app = createApp(store, password, undefined, integrations, {
      now: () => new Date('2026-09-14T10:00:00.000Z'),
      actionWorker: { kick: () => { kicks += 1; } },
    });
    const destinationsResponse = await app.request('/api/v1/task-destinations', { headers: { authorization } });
    assert.equal(destinationsResponse.status, 200);
    assert.deepEqual(await destinationsResponse.json(), {
      destinations: [{
        accountId: 'google-connection-1', listId: 'list-personal', listName: 'My Tasks',
        area: 'Personal', isFallback: true, explicitMapping: false,
      }],
      fallback: {
        accountId: 'google-connection-1', listId: 'list-personal', listName: 'My Tasks',
        area: 'Personal', isFallback: true, explicitMapping: false,
      },
    });
    const body = {
      destination: { accountId: 'google-connection-1', listId: 'list-personal' },
      nonce: 'nonce_api_create', title: 'Create through API', notes: 'Exact owner notes', doOn: '2026-09-20',
      plan: {
        priority: 'medium', waiting: false, deadlineOn: null, plannedOn: '2026-09-19',
        plannedAt: null, estimateMinutes: 20,
      },
    };
    const created = await app.request('/api/v1/tasks', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(created.status, 202);
    const value = await created.json() as { task: { id: string }; action: { state: string; payload: { notes: string } } };
    assert.equal(value.action.state, 'queued');
    assert.equal(value.action.payload.notes, 'Exact owner notes\n\nFox-Focus-ID: nonce_api_create');
    assert.equal(store.getTask(value.task.id)?.binding.kind, 'pending');
    assert.equal(providerCreates, 0, 'the request only persists and wakes the worker');
    assert.equal(kicks, 1);

    const replay = await app.request('/api/v1/tasks', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(replay.status, 200);
    assert.equal(kicks, 2);
    assert.equal(store.listActions().filter(action => action.payload.kind === 'task-create').length, 1);

    destinationAvailable = false;
    const stale = await app.request('/api/v1/tasks', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, nonce: 'nonce_stale_destination' }),
    });
    assert.equal(stale.status, 409);
    const forgedMarker = await app.request('/api/v1/tasks', {
      method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, nonce: 'nonce_marker', notes: 'Fox-Focus-ID: forged' }),
    });
    assert.equal(forgedMarker.status, 400);
  } finally { store.close(); }
});
