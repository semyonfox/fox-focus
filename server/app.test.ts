import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.ts';
import type { IntegrationService } from './integrations.ts';
import { openStore } from './store.ts';
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

const password = 'test-only-password-at-least-24-characters';
const authorization = `Basic ${Buffer.from(`fox:${password}`).toString('base64')}`;

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
    snapshot.data.tasks[0].title = 'New fixture task title';
    assert.equal((await put(snapshot)).status, 200);
    assert.equal(store.read().data.tasks[0].title, 'New fixture task title');
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

test('integration routes keep browser OAuth callbacks authenticated and expose no token material', async () => {
  const store = openStore(':memory:');
  let callbackQuery = '';
  const integrations: IntegrationService = {
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
    const app = createApp(store, password, undefined, undefined, 'test-public-key');
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
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_deliveries'").get());
    } finally { db.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
