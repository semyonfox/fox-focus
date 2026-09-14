import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { createIntegrationService, integrationConfigFromEnvironment } from './integrations.ts';
import { openOAuthTokenSet, sealOAuthTokenSet, serializeOAuthTokenEnvelope } from './oauth.ts';
import { openStore } from './store.ts';

const masterKey = Buffer.alloc(32, 9).toString('base64url');

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function importedGoogleEvent(title = 'Imported event') {
  return {
    provider: 'google' as const,
    kind: 'calendar_event' as const,
    containerId: 'primary',
    containerName: 'Personal',
    externalId: 'event-1',
    title,
    status: 'active',
    startsAt: '2026-09-11T10:00:00.000Z',
    endsAt: '2026-09-11T11:00:00.000Z',
    startsOn: null,
    endsOn: null,
    allDay: false,
    dueOn: null,
    completedAt: null,
    sourceUpdatedAt: '2026-09-11T09:00:00.000Z',
    sourceUrl: null,
    sourceTimeZone: null,
  };
}

function importedGoogleTask(title = 'Imported task') {
  return {
    ...importedGoogleEvent(title),
    kind: 'task' as const,
    containerId: 'task-list',
    containerName: 'Tasks',
    externalId: 'task-1',
    status: 'needsAction',
    startsAt: null,
    endsAt: null,
    dueOn: '2026-09-14',
  };
}

test('runtime configuration accepts mounted files and rejects credential environment variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-focus-oauth-config-'));
  const googleFile = join(dir, 'google.json');
  const microsoftFile = join(dir, 'microsoft.json');
  const keyFile = join(dir, 'token-key');
  try {
    writeFileSync(googleFile, JSON.stringify({ web: { client_id: 'test-client-id', client_secret: 'test-client-secret' } }), { mode: 0o600 });
    writeFileSync(microsoftFile, JSON.stringify({ clientId: 'microsoft-client-id', clientSecret: 'microsoft-client-secret' }), { mode: 0o600 });
    writeFileSync(keyFile, masterKey, { mode: 0o600 });
    const configured = integrationConfigFromEnvironment({
      APP_BASE_URL: 'https://focus.example.test',
      GOOGLE_OAUTH_CLIENT_FILE: googleFile,
      MICROSOFT_OAUTH_CLIENT_FILE: microsoftFile,
      OAUTH_TOKEN_KEY_FILE: keyFile,
    });
    assert.equal(configured?.providers.google?.clientId, 'test-client-id');
    assert.equal(configured?.providers.microsoft?.clientId, 'microsoft-client-id');
    assert.equal(configured?.providers.microsoft?.authorizationEndpoint,
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    assert.equal(configured?.providers.microsoft?.tokenEndpoint,
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    assert.equal(configured?.tokenMasterKey, masterKey);
    assert.ok(configured?.providers.google?.scopes.includes('https://www.googleapis.com/auth/tasks'));
    assert.ok(!configured?.providers.google?.scopes.includes('https://www.googleapis.com/auth/tasks.readonly'));
    assert.equal(integrationConfigFromEnvironment({
      APP_BASE_URL: 'https://focus.example.test',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      OAUTH_TOKEN_KEY: masterKey,
    }), null);
    writeFileSync(keyFile, 'not-a-valid-key', { mode: 0o600 });
    assert.throws(() => integrationConfigFromEnvironment({
      APP_BASE_URL: 'https://focus.example.test',
      GOOGLE_OAUTH_CLIENT_FILE: googleFile,
      OAUTH_TOKEN_KEY_FILE: keyFile,
    }), /Invalid OAuth token-encryption key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy provider token envelopes are authenticated and resealed to the migrated connection generation', async () => {
  const store = openStore(':memory:');
  const scopes = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
  const connectionId = 'migrated-generation';
  const tokens = {
    accessToken: 'legacy-access-token',
    refreshToken: 'legacy-refresh-token',
    tokenType: 'Bearer',
    scopes,
    expiresAt: '2026-09-14T10:00:00.000Z',
  } as const;
  const legacyEnvelope = serializeOAuthTokenEnvelope(
    sealOAuthTokenSet(tokens, masterKey, { provider: 'google', connectionId: 'google' }),
  );
  try {
    store.saveConnection({
      provider: 'google',
      connectionId,
      state: 'connected',
      scopes,
      tokenEnvelope: legacyEnvelope,
      connectedAt: '2026-09-11T10:00:00.000Z',
      updatedAt: '2026-09-11T10:00:00.000Z',
      lastSyncedAt: null,
      lastError: null,
    });
    const authorizationHeaders: string[] = [];
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test',
      tokenMasterKey: masterKey,
      now: () => new Date('2026-09-13T10:00:00.000Z'),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '');
        if (url.pathname === '/calendar/v3/users/me/calendarList') return json({ items: [] });
        if (url.pathname === '/tasks/v1/users/@me/lists') return json({ items: [] });
        return json({ error: 'unexpected request' }, 404);
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes, additionalAuthorizationParameters: {},
        },
      },
    });

    assert.deepEqual(await integrations.sync('google'), { outcome: 'synced', recordCount: 0 });
    assert.deepEqual(authorizationHeaders, ['Bearer legacy-access-token', 'Bearer legacy-access-token']);
    const migrated = store.getConnection('google');
    assert.equal(migrated?.state, 'connected');
    assert.notEqual(migrated?.tokenEnvelope, legacyEnvelope);
    assert.deepEqual(
      openOAuthTokenSet(migrated?.tokenEnvelope ?? '', masterKey, { provider: 'google', connectionId }),
      tokens,
    );
  } finally {
    store.close();
  }
});

test('Google task writes abort before their action lease can be recovered', async () => {
  const store = openStore(':memory:');
  const connectionId = 'bounded-write-generation';
  const scopes = ['https://www.googleapis.com/auth/tasks'];
  let requestSignal: AbortSignal | null | undefined;
  let requests = 0;
  try {
    store.saveConnection({
      provider: 'google', connectionId, state: 'connected', scopes,
      tokenEnvelope: serializeOAuthTokenEnvelope(sealOAuthTokenSet({
        accessToken: 'bounded-write-access', refreshToken: 'bounded-write-refresh', scopes,
        expiresAt: '2026-09-14T10:00:00.000Z', tokenType: 'Bearer',
      }, masterKey, { provider: 'google', connectionId })),
      connectedAt: '2026-09-13T09:00:00.000Z', updatedAt: '2026-09-13T09:00:00.000Z',
      lastSyncedAt: null, lastError: null,
    });
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test', tokenMasterKey: masterKey,
      now: () => new Date('2026-09-13T10:00:00.000Z'), taskActionTimeoutMs: 10,
      fetch: async (_input, init) => {
        requests += 1;
        requestSignal = init?.signal;
        if (!requestSignal) throw new Error('missing task-action signal');
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new Error('test request aborted'));
          if (requestSignal?.aborted) abort();
          else requestSignal?.addEventListener('abort', abort, { once: true });
        });
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes, additionalAuthorizationParameters: {},
        },
      },
    });

    assert.deepEqual(await integrations.updateGoogleTaskCompletion({
      connectionId, containerId: 'list-1', externalId: 'task-1', desiredState: 'completed', expectedVersion: 'etag-1',
    }), {
      outcome: 'failed', notice: 'The Google task was not confirmed. Your Fox Focus task was kept.', retryable: true,
    });
    assert.equal(requests, 1);
    assert.equal(requestSignal?.aborted, true);
  } finally {
    store.close();
  }
});

test('Google completion write uses the connected write scope and preserves the exact linked IDs and ETag', async () => {
  const store = openStore(':memory:');
  const writes: Array<{ method: string; path: string; body: string | null; ifMatch: string | null }> = [];
  let upstreamCompleted = false;
  try {
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test',
      tokenMasterKey: masterKey,
      now: () => new Date('2026-09-13T10:00:00.000Z'),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const method = init?.method ?? 'GET';
        if (url.origin === 'https://oauth.example.test') {
          return json({
            access_token: 'write-access', refresh_token: 'write-refresh', token_type: 'Bearer',
            scope: 'https://www.googleapis.com/auth/tasks', expires_in: 3_600,
          });
        }
        if (url.pathname === '/calendar/v3/users/me/calendarList') return json({ items: [] });
        if (url.pathname === '/tasks/v1/users/@me/lists') return json({ items: [] });
        if (url.pathname === '/tasks/v1/lists/list-1/tasks/task-1') {
          writes.push({
            method,
            path: url.pathname,
            body: typeof init?.body === 'string' ? init.body : null,
            ifMatch: new Headers(init?.headers).get('If-Match'),
          });
          if (method === 'PATCH') {
            upstreamCompleted = true;
            return json({ id: 'ignored-by-readback' });
          }
          return upstreamCompleted
            ? json({
                id: 'task-1', title: 'Linked task', status: 'completed', etag: 'etag-2',
                completed: '2026-09-13T10:00:00.000Z', updated: '2026-09-13T10:00:00.000Z',
              })
            : json({
                id: 'task-1', title: 'Linked task', status: 'needsAction', etag: 'etag-1',
                updated: '2026-09-13T09:00:00.000Z',
              });
        }
        return json({ error: 'unexpected request' }, 404);
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes: ['https://www.googleapis.com/auth/tasks'], additionalAuthorizationParameters: {},
        },
      },
    });
    const state = new URL(integrations.startAuthorization('google') ?? '').searchParams.get('state');
    assert.ok(state);
    assert.equal((await integrations.completeAuthorization('google', new URLSearchParams({ state, code: 'write-code' }))).outcome, 'connected');
    const connectionId = store.getConnection('google')?.connectionId;
    assert.ok(connectionId);
    const result = await integrations.updateGoogleTaskCompletion({
      connectionId, containerId: 'list-1', externalId: 'task-1', desiredState: 'completed', expectedVersion: 'etag-1',
    });
    assert.deepEqual(result, {
      outcome: 'succeeded', sourceStatus: 'completed', sourceVersion: 'etag-2',
      sourceUpdatedAt: '2026-09-13T10:00:00.000Z', completedAt: '2026-09-13T10:00:00.000Z',
      current: {
        title: 'Linked task', notes: null, state: 'completed', completedAt: '2026-09-13T10:00:00.000Z',
        dueOn: null, parentId: null, position: null, sourceUrl: null, version: 'etag-2',
        updatedAt: '2026-09-13T10:00:00.000Z', completionWritable: true,
      },
    });
    assert.deepEqual(writes, [
      { method: 'GET', path: '/tasks/v1/lists/list-1/tasks/task-1', body: null, ifMatch: null },
      { method: 'PATCH', path: '/tasks/v1/lists/list-1/tasks/task-1', body: '{"status":"completed"}', ifMatch: 'etag-1' },
      { method: 'GET', path: '/tasks/v1/lists/list-1/tasks/task-1', body: null, ifMatch: null },
    ]);
  } finally {
    store.close();
  }
});

test('Google task snapshots and status writes serialize within one list', async () => {
  const store = openStore(':memory:');
  const connectionId = 'serialized-google-generation';
  const scopes = ['https://www.googleapis.com/auth/tasks'];
  let announceSnapshotFetch = () => {};
  const snapshotFetchStarted = new Promise<void>(resolve => { announceSnapshotFetch = resolve; });
  let releaseSnapshot = (_response: Response) => {};
  const snapshotResponse = new Promise<Response>(resolve => { releaseSnapshot = resolve; });
  let remoteCompleted = false;
  let taskItemRequests = 0;
  try {
    store.saveConnection({
      provider: 'google', connectionId, state: 'connected', scopes,
      tokenEnvelope: serializeOAuthTokenEnvelope(sealOAuthTokenSet({
        accessToken: 'serialized-access', refreshToken: 'serialized-refresh', scopes,
        expiresAt: '2027-09-14T10:00:00.000Z', tokenType: 'Bearer',
      }, masterKey, { provider: 'google', connectionId })),
      connectedAt: '2026-09-14T09:00:00.000Z', updatedAt: '2026-09-14T09:00:00.000Z',
      lastSyncedAt: null, lastError: null,
    });
    store.publishProviderScope({
      provider: 'google', resourceKind: 'task-list', accountId: connectionId,
      connectionGeneration: connectionId, containerId: 'list-1', containerName: 'My Tasks',
      records: [{
        provider: 'google', kind: 'task', connectionId, containerId: 'list-1', containerName: 'My Tasks',
        externalId: 'task-1', title: 'Serialized task', status: 'needsAction', startsAt: null, endsAt: null,
        startsOn: null, endsOn: null, allDay: false, dueOn: '2026-09-20', completedAt: null,
        sourceUpdatedAt: '2026-09-14T09:00:00.000Z', sourceVersion: 'etag-1', completionWritable: true,
        notes: null, parentId: null, position: '0001', sourceUrl: null, sourceTimeZone: null,
      }],
      coverageFrom: null, coverageTo: null, fetchedAt: '2026-09-14T09:00:00.000Z',
    });
    const task = store.listTasks()[0];
    assert.ok(task);
    const queued = store.queueTaskStatusAction(task.id, task.version, 'completed', '2026-09-14T10:00:00.000Z');
    assert.equal(queued.outcome, 'queued');
    if (queued.outcome !== 'queued') return;

    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test', tokenMasterKey: masterKey,
      now: () => new Date('2026-09-14T10:00:00.000Z'),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const method = init?.method ?? 'GET';
        if (url.pathname === '/calendar/v3/users/me/calendarList') return json({ items: [] });
        if (url.pathname === '/tasks/v1/users/@me/lists') {
          return json({ items: [{ id: 'list-1', title: 'My Tasks' }] });
        }
        if (url.pathname === '/tasks/v1/lists/list-1/tasks') {
          announceSnapshotFetch();
          return await snapshotResponse;
        }
        if (url.pathname === '/tasks/v1/lists/list-1/tasks/task-1') {
          taskItemRequests += 1;
          if (method === 'PATCH') {
            assert.equal(new Headers(init?.headers).get('If-Match'), 'etag-1');
            remoteCompleted = true;
            return json({ id: 'task-1' });
          }
          return remoteCompleted
            ? json({
                id: 'task-1', title: 'Serialized task', status: 'completed', etag: 'etag-2',
                due: '2026-09-20T00:00:00.000Z', position: '0001',
                completed: '2026-09-14T10:00:00.000Z', updated: '2026-09-14T10:00:01.000Z',
              })
            : json({
                id: 'task-1', title: 'Serialized task', status: 'needsAction', etag: 'etag-1',
                due: '2026-09-20T00:00:00.000Z', position: '0001', updated: '2026-09-14T09:00:00.000Z',
              });
        }
        return json({ error: 'unexpected request' }, 404);
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes, additionalAuthorizationParameters: {},
        },
      },
    });

    const sync = integrations.sync('google');
    await snapshotFetchStarted;
    const claimed = store.claimNextTaskStatusAction('2026-09-14T10:00:00.000Z', 120_000);
    assert.ok(claimed?.claimId);
    const writeAndSettle = (async () => {
      const result = await integrations.updateGoogleTaskCompletion({
        connectionId, containerId: 'list-1', externalId: 'task-1',
        desiredState: 'completed', expectedVersion: 'etag-1',
      });
      assert.equal(result.outcome, 'succeeded');
      if (result.outcome !== 'succeeded' || !claimed?.claimId) return null;
      return store.settleTaskStatusAction(
        claimed.id,
        claimed.claimId,
        result,
        '2026-09-14T10:00:01.000Z',
      );
    })();

    await waitForImmediate();
    const writeStartedBeforeSnapshotFinished = taskItemRequests > 0;
    releaseSnapshot(json({ items: [{
      id: 'task-1', title: 'Serialized task', status: 'needsAction', etag: 'etag-1',
      due: '2026-09-20T00:00:00.000Z', position: '0001', updated: '2026-09-14T09:00:00.000Z',
    }] }));

    const [syncResult, settled] = await Promise.all([sync, writeAndSettle]);
    assert.equal(writeStartedBeforeSnapshotFinished, false);
    assert.deepEqual(syncResult, { outcome: 'synced', recordCount: 1 });
    assert.equal(settled?.state, 'succeeded');
    assert.equal(taskItemRequests, 3);
    const finalTask = store.getTask(task.id);
    assert.equal(finalTask?.observed?.status, 'completed');
    assert.equal(finalTask?.observed?.etag, 'etag-2');
    assert.equal(finalTask?.observed?.observedAt, '2026-09-14T10:00:01.000Z');
    const finalProviderRecord = store.listProviderRecords(10, 'task')[0];
    assert.equal(finalProviderRecord?.status, 'completed');
    assert.equal(finalProviderRecord?.sourceVersion, 'etag-2');
  } finally {
    releaseSnapshot(json({ items: [] }));
    store.close();
  }
});

test('Google task ETag conflicts include the exact current task snapshot', async () => {
  const store = openStore(':memory:');
  const connectionId = 'conflicted-google-generation';
  const scopes = ['https://www.googleapis.com/auth/tasks'];
  const methods: string[] = [];
  try {
    store.saveConnection({
      provider: 'google', connectionId, state: 'connected', scopes,
      tokenEnvelope: serializeOAuthTokenEnvelope(sealOAuthTokenSet({
        accessToken: 'conflict-access', refreshToken: 'conflict-refresh', scopes,
        expiresAt: '2027-09-14T10:00:00.000Z', tokenType: 'Bearer',
      }, masterKey, { provider: 'google', connectionId })),
      connectedAt: '2026-09-14T09:00:00.000Z', updatedAt: '2026-09-14T09:00:00.000Z',
      lastSyncedAt: null, lastError: null,
    });
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test', tokenMasterKey: masterKey,
      now: () => new Date('2026-09-14T10:00:00.000Z'),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        methods.push(init?.method ?? 'GET');
        if (url.pathname === '/tasks/v1/lists/list-1/tasks/task-1') {
          return json({
            id: 'task-1', title: 'Changed upstream', notes: 'Use the new details', parent: 'parent-1',
            position: '0002', webViewLink: 'https://tasks.google.com/task/task-1', status: 'needsAction',
            due: '2026-09-22T00:00:00.000Z',
            updated: '2026-09-14T09:46:00.000Z', etag: 'etag-current',
          });
        }
        return json({ error: 'unexpected request' }, 404);
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes, additionalAuthorizationParameters: {},
        },
      },
    });

    assert.deepEqual(await integrations.updateGoogleTaskCompletion({
      connectionId, containerId: 'list-1', externalId: 'task-1',
      desiredState: 'completed', expectedVersion: 'etag-imported',
    }), {
      outcome: 'conflict',
      notice: 'The Google task changed after it was imported. Refresh before trying again.',
      current: {
        title: 'Changed upstream', notes: 'Use the new details', state: 'open', completedAt: null,
        dueOn: '2026-09-22', parentId: 'parent-1', position: '0002',
        sourceUrl: 'https://tasks.google.com/task/task-1',
        updatedAt: '2026-09-14T09:46:00.000Z', version: 'etag-current',
        completionWritable: true,
      },
    });
    assert.deepEqual(methods, ['GET']);
  } finally {
    store.close();
  }
});

test('a callback sent to the wrong provider route does not consume another provider attempt', () => {
  const store = openStore(':memory:');
  try {
    const expiresAt = '2026-09-11T10:10:00.000Z';
    store.createOAuthAttempt({
      provider: 'google', stateHash: 'test-state-hash', verifierEnvelope: 'test-envelope', nonce: null, expiresAt,
    });
    assert.equal(store.consumeOAuthAttempt('microsoft', 'test-state-hash', '2026-09-11T10:00:00.000Z'), null);
    assert.deepEqual(store.consumeOAuthAttempt('google', 'test-state-hash', '2026-09-11T10:00:00.000Z'), {
      provider: 'google', stateHash: 'test-state-hash', verifierEnvelope: 'test-envelope', nonce: null, expiresAt,
    });
  } finally {
    store.close();
  }
});

test('a successful rolling snapshot removes provider records that are no longer returned', () => {
  const store = openStore(':memory:');
  try {
    store.replaceProviderRecords('google', [importedGoogleEvent()]);
    assert.equal(store.listProviderRecords().length, 1);
    store.replaceProviderRecords('google', []);
    assert.deepEqual(store.listProviderRecords(), []);
  } finally {
    store.close();
  }
});

test('provider overview keeps ordinary-sized task collections when calendar records fill the other limit', () => {
  const store = openStore(':memory:');
  try {
    const events = Array.from({ length: 300 }, (_, index) => ({
      ...importedGoogleEvent(`Event ${index}`),
      externalId: `event-${index}`,
    }));
    const tasks = Array.from({ length: 350 }, (_, index) => ({
      ...importedGoogleTask(`Task ${index}`),
      externalId: `task-${index}`,
    }));
    store.replaceProviderRecords('google', [...events, ...tasks]);

    const overview = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test',
      tokenMasterKey: masterKey,
      providers: {},
    }).overview();
    assert.equal(overview.records.filter(record => record.kind === 'calendar_event').length, 300);
    assert.equal(overview.records.filter(record => record.kind === 'task').length, 350);
  } finally {
    store.close();
  }
});

test('Google publishes calendars and task lists independently and retains rows for failed scopes', async () => {
  const store = openStore(':memory:');
  const connectionId = 'scoped-google-generation';
  const scopes = ['https://www.googleapis.com/auth/tasks'];
  let attempt = 1;
  let currentTime = new Date('2026-09-13T10:00:00.000Z');
  try {
    store.saveConnection({
      provider: 'google', connectionId, state: 'connected', scopes,
      tokenEnvelope: serializeOAuthTokenEnvelope(sealOAuthTokenSet({
        accessToken: 'scoped-access', refreshToken: 'scoped-refresh', scopes,
        expiresAt: '2027-09-13T10:00:00.000Z', tokenType: 'Bearer',
      }, masterKey, { provider: 'google', connectionId })),
      connectedAt: currentTime.toISOString(), updatedAt: currentTime.toISOString(),
      lastSyncedAt: null, lastError: null,
    });
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test',
      tokenMasterKey: masterKey,
      now: () => currentTime,
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/calendar/v3/users/me/calendarList') {
          return json({ items: [
            { id: 'calendar-a', summary: 'Calendar A' },
            { id: 'calendar-b', summary: 'Calendar B' },
          ] });
        }
        if (url.pathname === '/calendar/v3/calendars/calendar-a/events') {
          return attempt === 1
            ? json({ items: [{
                id: 'event-a', status: 'confirmed', summary: 'Retained event',
                start: { dateTime: '2026-09-13T11:00:00.000Z' },
                end: { dateTime: '2026-09-13T12:00:00.000Z' },
              }] })
            : json({ error: 'temporary failure' }, 503);
        }
        if (url.pathname === '/calendar/v3/calendars/calendar-b/events') {
          return attempt === 1
            ? json({ items: [{
                id: 'event-b', status: 'confirmed', summary: 'Removed event',
                start: { dateTime: '2026-09-13T13:00:00.000Z' },
                end: { dateTime: '2026-09-13T14:00:00.000Z' },
              }] })
            : json({ items: [] });
        }
        if (url.pathname === '/tasks/v1/users/@me/lists') {
          return json({ items: [
            { id: 'list-a', title: 'List A' },
            { id: 'list-b', title: 'List B' },
          ] });
        }
        if (url.pathname === '/tasks/v1/lists/list-a/tasks') {
          return attempt === 1
            ? json({ items: [{
                id: 'task-a', title: 'Retained task', status: 'needsAction', etag: 'etag-a',
                updated: '2026-09-13T09:00:00.000Z',
              }] })
            : json({ error: 'temporary failure' }, 503);
        }
        if (url.pathname === '/tasks/v1/lists/list-b/tasks') {
          return attempt === 1
            ? json({ items: [{
                id: 'task-b', title: 'Removed task', status: 'needsAction', etag: 'etag-b',
                updated: '2026-09-13T09:00:00.000Z',
              }] })
            : json({ items: [] });
        }
        return json({ error: 'unexpected request' }, 404);
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes, additionalAuthorizationParameters: {},
        },
      },
    });

    assert.deepEqual(await integrations.sync('google'), { outcome: 'synced', recordCount: 4 });
    assert.deepEqual(store.listProviderRecords(10, 'task').map(record => record.externalId).sort(), ['task-a', 'task-b']);
    assert.deepEqual(store.listProviderRecords(10, 'calendar_event').map(record => record.externalId).sort(), ['event-a', 'event-b']);

    attempt = 2;
    currentTime = new Date('2026-09-13T10:05:00.000Z');
    const partial = await integrations.sync('google');
    assert.equal(partial.outcome, 'failed');
    assert.deepEqual(store.listProviderRecords(10, 'task').map(record => record.externalId), ['task-a']);
    assert.deepEqual(store.listProviderRecords(10, 'calendar_event').map(record => record.externalId), ['event-a']);

    const states = new Map(store.listSyncStates().map(state => [state.containerId, state]));
    assert.deepEqual(states.get('list-a') && {
      state: states.get('list-a')?.state,
      successfulFetchAt: states.get('list-a')?.successfulFetchAt,
      error: states.get('list-a')?.error,
      connectionGeneration: states.get('list-a')?.connectionGeneration,
    }, {
      state: 'failed',
      successfulFetchAt: '2026-09-13T10:00:00.000Z',
      error: 'google.tasks: remote-error',
      connectionGeneration: connectionId,
    });
    assert.deepEqual(states.get('list-b') && {
      state: states.get('list-b')?.state,
      successfulFetchAt: states.get('list-b')?.successfulFetchAt,
      error: states.get('list-b')?.error,
    }, {
      state: 'fresh',
      successfulFetchAt: '2026-09-13T10:05:00.000Z',
      error: null,
    });
    assert.deepEqual(states.get('calendar-a') && {
      state: states.get('calendar-a')?.state,
      successfulFetchAt: states.get('calendar-a')?.successfulFetchAt,
      coverageFrom: states.get('calendar-a')?.coverageFrom,
      coverageTo: states.get('calendar-a')?.coverageTo,
      error: states.get('calendar-a')?.error,
    }, {
      state: 'failed',
      successfulFetchAt: '2026-09-13T10:00:00.000Z',
      coverageFrom: '2026-08-30T10:05:00.000Z',
      coverageTo: '2026-12-12T10:05:00.000Z',
      error: 'google.calendar-events: remote-error',
    });
    assert.deepEqual(states.get('calendar-b') && {
      state: states.get('calendar-b')?.state,
      successfulFetchAt: states.get('calendar-b')?.successfulFetchAt,
      error: states.get('calendar-b')?.error,
    }, {
      state: 'fresh',
      successfulFetchAt: '2026-09-13T10:05:00.000Z',
      error: null,
    });
  } finally {
    store.close();
  }
});

test('provider reads abort at their configured deadline without blocking other source discovery', async () => {
  const store = openStore(':memory:');
  const connectionId = 'timed-google-generation';
  const scopes = ['https://www.googleapis.com/auth/tasks'];
  let calendarSignal: AbortSignal | null | undefined;
  let taskListsRead = false;
  try {
    store.saveConnection({
      provider: 'google', connectionId, state: 'connected', scopes,
      tokenEnvelope: serializeOAuthTokenEnvelope(sealOAuthTokenSet({
        accessToken: 'timed-access', refreshToken: 'timed-refresh', scopes,
        expiresAt: '2027-09-13T10:00:00.000Z', tokenType: 'Bearer',
      }, masterKey, { provider: 'google', connectionId })),
      connectedAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
      lastSyncedAt: null, lastError: null,
    });
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test', tokenMasterKey: masterKey,
      now: () => new Date('2026-09-13T10:00:00.000Z'), providerReadTimeoutMs: 10,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/calendar/v3/users/me/calendarList') {
          calendarSignal = init?.signal;
          return await new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new Error('test request aborted'));
            if (calendarSignal?.aborted) abort();
            else calendarSignal?.addEventListener('abort', abort, { once: true });
          });
        }
        if (url.pathname === '/tasks/v1/users/@me/lists') {
          taskListsRead = true;
          return json({ items: [] });
        }
        return json({ error: 'unexpected request' }, 404);
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes, additionalAuthorizationParameters: {},
        },
      },
    });

    assert.equal((await integrations.sync('google')).outcome, 'failed');
    assert.equal(calendarSignal?.aborted, true);
    assert.equal(taskListsRead, true);
  } finally {
    store.close();
  }
});

test('Google callback stores encrypted offline credentials and imports only read-only calendar/task fields', async () => {
  let currentTime = new Date('2026-09-11T10:00:00.000Z');
  const calls: Array<{ url: URL; method: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const source = input instanceof Request ? input.url : input.toString();
    const url = new URL(source);
    calls.push({ url, method: init?.method ?? 'GET' });

    if (url.origin === 'https://oauth.example.test') {
      return json({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        expires_in: 3_600,
        scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/tasks.readonly',
      });
    }
    if (url.pathname === '/calendar/v3/users/me/calendarList') {
      return json({ items: [{ id: 'primary', summary: 'Personal', primary: true }] });
    }
    if (url.pathname === '/calendar/v3/calendars/primary/events') {
      return json({ items: [
        {
          id: 'all-day-event', status: 'confirmed', summary: 'All-day focus',
          start: { date: '2026-09-12' }, end: { date: '2026-09-13' }, updated: '2026-09-11T09:00:00Z',
          description: 'This must never be retained.',
        },
      ] });
    }
    if (url.pathname === '/tasks/v1/users/@me/lists') {
      return json({ items: [{ id: 'task-list', title: 'Personal tasks' }] });
    }
    if (url.pathname === '/tasks/v1/lists/task-list/tasks') {
      return json({ items: [
        {
          id: 'task-1', title: 'Renew library book', status: 'needsAction', due: '2026-09-14T00:00:00.000Z',
          notes: 'This must never be retained.', updated: '2026-09-11T09:00:00Z',
          assignmentInfo: { surfaceType: 'DOCUMENT' },
        },
      ] });
    }
    return json({ error: 'unexpected request' }, 404);
  };

  const store = openStore(':memory:');
  try {
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test',
      tokenMasterKey: masterKey,
      now: () => currentTime,
      fetch: fakeFetch,
      providers: {
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize',
          tokenEndpoint: 'https://oauth.example.test/token',
          scopes: [
            'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
            'https://www.googleapis.com/auth/calendar.events.readonly',
            'https://www.googleapis.com/auth/tasks.readonly',
          ],
          additionalAuthorizationParameters: { access_type: 'offline', prompt: 'consent' },
        },
      },
    });

    const authorizationUrl = integrations.startAuthorization('google');
    assert.ok(authorizationUrl);
    const authorization = new URL(authorizationUrl);
    assert.equal(authorization.searchParams.get('redirect_uri'), 'https://focus.example.test/api/v1/integrations/google/callback');
    assert.equal(authorization.searchParams.get('include_granted_scopes'), null);
    const state = authorization.searchParams.get('state');
    assert.ok(state);

    const result = await integrations.completeAuthorization('google', new URLSearchParams({ state, code: 'test-code' }));
    assert.equal(result.outcome, 'connected');
    const overview = integrations.overview();
    const google = overview.providers.find(provider => provider.provider === 'google');
    assert.deepEqual(google && {
      configured: google.configured,
      state: google.connection?.state,
      calendarEventCount: google.calendarEventCount,
      taskCount: google.taskCount,
      syncState: google.sync.state,
    }, {
      configured: true,
      state: 'connected',
      calendarEventCount: 1,
      taskCount: 1,
      syncState: 'idle',
    });
    assert.deepEqual(overview.records.map(record => ({
      kind: record.kind,
      title: record.title,
      startsOn: record.startsOn,
      dueOn: record.dueOn,
      allDay: record.allDay,
    })), [
      { kind: 'calendar_event', title: 'All-day focus', startsOn: '2026-09-12', dueOn: null, allDay: true },
      { kind: 'task', title: 'Renew library book', startsOn: null, dueOn: '2026-09-14', allDay: false },
    ]);
    const stored = store.getConnection('google');
    const calendarState = store.listSyncStates().find(state => state.resourceKind === 'calendar');
    const taskState = store.listSyncStates().find(state => state.resourceKind === 'task-list');
    assert.deepEqual(calendarState && {
      state: calendarState.state,
      accountId: calendarState.accountId,
      connectionGeneration: calendarState.connectionGeneration,
      containerId: calendarState.containerId,
      coverageFrom: calendarState.coverageFrom,
      coverageTo: calendarState.coverageTo,
      successfulFetchAt: calendarState.successfulFetchAt,
    }, {
      state: 'fresh',
      accountId: stored?.connectionId,
      connectionGeneration: stored?.connectionId,
      containerId: 'primary',
      coverageFrom: '2026-08-28T10:00:00.000Z',
      coverageTo: '2026-12-10T10:00:00.000Z',
      successfulFetchAt: '2026-09-11T10:00:00.000Z',
    });
    assert.deepEqual(taskState && {
      state: taskState.state,
      coverageFrom: taskState.coverageFrom,
      coverageTo: taskState.coverageTo,
      successfulFetchAt: taskState.successfulFetchAt,
    }, {
      state: 'fresh', coverageFrom: null, coverageTo: null,
      successfulFetchAt: '2026-09-11T10:00:00.000Z',
    });
    assert.ok(stored?.tokenEnvelope);
    assert.ok(!stored.tokenEnvelope.includes('test-access-token'));
    assert.ok(!stored.tokenEnvelope.includes('test-refresh-token'));
    assert.equal(overview.records.find(record => record.externalId === 'task-1')?.completionWritable, false);
    assert.ok(!JSON.stringify(overview).includes('client-secret'));
    assert.ok(!JSON.stringify(overview).includes('must never be retained'));

    const providerReads = calls.filter(call => call.url.origin !== 'https://oauth.example.test');
    assert.ok(providerReads.length > 0);
    assert.ok(providerReads.every(call => call.method === 'GET'));
    assert.equal(calls.filter(call => call.url.origin === 'https://oauth.example.test').length, 1);

    currentTime = new Date('2026-09-11T10:01:00.000Z');
    const replay = await integrations.completeAuthorization('google', new URLSearchParams({ state, code: 'different-code' }));
    assert.equal(replay.outcome, 'failed');
  } finally {
    store.close();
  }
});

test('a failed authorization-code exchange leaves no imported provider data behind', async () => {
  const store = openStore(':memory:');
  try {
    const methods: string[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return json({ error: 'invalid_grant' }, 400);
    };
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test', tokenMasterKey: masterKey, now: () => new Date('2026-09-11T10:00:00.000Z'), fetch: fakeFetch,
      providers: {
        microsoft: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://login.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes: ['offline_access', 'Calendars.ReadBasic', 'Tasks.Read'], additionalAuthorizationParameters: {},
        },
      },
    });
    const authorizationUrl = integrations.startAuthorization('microsoft');
    assert.ok(authorizationUrl);
    const state = new URL(authorizationUrl).searchParams.get('state');
    assert.ok(state);
    // The initial exchange is deliberately rejected. No record is ever inserted.
    const result = await integrations.completeAuthorization('microsoft', new URLSearchParams({ state, code: 'test-code' }));
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(store.listProviderRecords(), []);
    assert.deepEqual(methods, ['POST']);
  } finally {
    store.close();
  }
});

test('a token response with an unrequested scope is never stored', async () => {
  const store = openStore(':memory:');
  try {
    const methods: string[] = [];
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test', tokenMasterKey: masterKey, now: () => new Date('2026-09-11T10:00:00.000Z'),
      fetch: async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        return json({
          access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer',
          scope: 'calendar.readonly calendar.write', expires_in: 3_600,
        });
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes: ['calendar.readonly'], additionalAuthorizationParameters: {},
        },
      },
    });
    const state = new URL(integrations.startAuthorization('google') ?? '').searchParams.get('state');
    assert.ok(state);
    assert.equal((await integrations.completeAuthorization('google', new URLSearchParams({ state, code: 'test-code' }))).outcome, 'failed');
    assert.equal(store.getConnection('google'), null);
    assert.deepEqual(store.listProviderRecords(), []);
    assert.deepEqual(methods, ['POST']);
  } finally {
    store.close();
  }
});

test('a provider permission failure offers reconnection and clears prior account context', async () => {
  const store = openStore(':memory:');
  try {
    store.replaceProviderRecords('google', [importedGoogleEvent('Old account event')]);
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test', tokenMasterKey: masterKey, now: () => new Date('2026-09-11T10:00:00.000Z'),
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.origin === 'https://oauth.example.test') {
          return json({ access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer', scope: 'calendar.readonly', expires_in: 3_600 });
        }
        return json({ error: 'permission denied' }, 403);
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes: ['calendar.readonly'], additionalAuthorizationParameters: {},
        },
      },
    });
    const state = new URL(integrations.startAuthorization('google') ?? '').searchParams.get('state');
    assert.ok(state);
    assert.equal((await integrations.completeAuthorization('google', new URLSearchParams({ state, code: 'test-code' }))).outcome, 'failed');
    assert.equal(store.getConnection('google')?.state, 'needs_reconnect');
    assert.deepEqual(store.listProviderRecords(), []);
  } finally {
    store.close();
  }
});

test('a reconnect requires its own refresh token instead of retaining a previous account', async () => {
  const store = openStore(':memory:');
  let exchanges = 0;
  try {
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test', tokenMasterKey: masterKey, now: () => new Date('2026-09-11T10:00:00.000Z'),
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.origin === 'https://oauth.example.test') {
          exchanges += 1;
          return json(exchanges === 1
            ? { access_token: 'first-access', refresh_token: 'first-refresh', token_type: 'Bearer', expires_in: 3_600 }
            : { access_token: 'second-access', token_type: 'Bearer', expires_in: 3_600 });
        }
        if (url.pathname === '/calendar/v3/users/me/calendarList') return json({ items: [] });
        if (url.pathname === '/tasks/v1/users/@me/lists') return json({ items: [] });
        return json({ error: 'unexpected request' }, 404);
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly'], additionalAuthorizationParameters: {},
        },
      },
    });
    const firstState = new URL(integrations.startAuthorization('google') ?? '').searchParams.get('state');
    assert.ok(firstState);
    assert.equal((await integrations.completeAuthorization('google', new URLSearchParams({ state: firstState, code: 'first-code' }))).outcome, 'connected');
    const secondState = new URL(integrations.startAuthorization('google') ?? '').searchParams.get('state');
    assert.ok(secondState);
    assert.equal((await integrations.completeAuthorization('google', new URLSearchParams({ state: secondState, code: 'second-code' }))).outcome, 'failed');
    assert.equal(store.getConnection('google')?.state, 'needs_reconnect');
  } finally {
    store.close();
  }
});

test('reauthorization isolates a failing old-generation sync and starts a distinct new-generation sync', async () => {
  const store = openStore(':memory:');
  let oldCalendarReads = 0;
  let releaseOldCalendar!: (response: Response) => void;
  let releaseNewCalendar!: (response: Response) => void;
  let signalOldSyncRead!: () => void;
  const oldCalendarResponse = new Promise<Response>(resolve => { releaseOldCalendar = resolve; });
  const newCalendarResponse = new Promise<Response>(resolve => { releaseNewCalendar = resolve; });
  const oldSyncReadStarted = new Promise<void>(resolve => { signalOldSyncRead = resolve; });
  const pending: Promise<unknown>[] = [];

  const calendarList = (id: string, title: string) => json({ items: [{ id, summary: title }] });
  const calendarEvent = (id: string, title: string) => json({ items: [{
    id,
    status: 'confirmed',
    summary: title,
    start: { dateTime: '2026-09-13T10:00:00Z' },
    end: { dateTime: '2026-09-13T11:00:00Z' },
    updated: '2026-09-13T09:00:00Z',
  }] });

  try {
    const integrations = createIntegrationService(store, {
      appBaseUrl: 'https://focus.example.test',
      tokenMasterKey: masterKey,
      now: () => new Date('2026-09-13T09:00:00.000Z'),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.origin === 'https://oauth.example.test') {
          const parameters = new URLSearchParams(String(init?.body ?? ''));
          const code = parameters.get('code');
          const generation = code === 'new-code' ? 'new' : 'old';
          return json({
            access_token: `${generation}-access`,
            refresh_token: `${generation}-refresh`,
            token_type: 'Bearer',
            scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
            expires_in: 3_600,
          });
        }

        const token = new Headers(init?.headers).get('Authorization');
        if (url.pathname === '/calendar/v3/users/me/calendarList') {
          if (token === 'Bearer old-access') {
            oldCalendarReads += 1;
            if (oldCalendarReads === 1) return json({ items: [] });
            signalOldSyncRead();
            return oldCalendarResponse;
          }
          if (token === 'Bearer new-access') return newCalendarResponse;
        }
        if (url.pathname === '/calendar/v3/calendars/old-calendar/events') {
          return calendarEvent('old-account-event', 'Old account event');
        }
        if (url.pathname === '/calendar/v3/calendars/new-calendar/events') {
          return calendarEvent('new-account-event', 'New account event');
        }
        if (url.pathname === '/tasks/v1/users/@me/lists') return json({ items: [] });
        return json({ error: 'unexpected request' }, 404);
      },
      providers: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizationEndpoint: 'https://accounts.example.test/authorize', tokenEndpoint: 'https://oauth.example.test/token',
          scopes: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly'], additionalAuthorizationParameters: {},
        },
      },
    });

    const firstState = new URL(integrations.startAuthorization('google') ?? '').searchParams.get('state');
    assert.ok(firstState);
    assert.equal((await integrations.completeAuthorization('google', new URLSearchParams({
      state: firstState,
      code: 'old-code',
    }))).outcome, 'connected');
    const oldConnectionId = store.getConnection('google')?.connectionId;
    assert.ok(oldConnectionId);

    const oldSync = integrations.sync('google');
    pending.push(oldSync);
    await oldSyncReadStarted;

    const secondState = new URL(integrations.startAuthorization('google') ?? '').searchParams.get('state');
    assert.ok(secondState);
    const newAuthorization = integrations.completeAuthorization('google', new URLSearchParams({
      state: secondState,
      code: 'new-code',
    }));
    pending.push(newAuthorization);

    let newConnection = store.getConnection('google');
    for (let attempt = 0; attempt < 100 && newConnection?.connectionId === oldConnectionId; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      newConnection = store.getConnection('google');
    }
    assert.ok(newConnection);
    assert.notEqual(newConnection.connectionId, oldConnectionId);

    const newSync = integrations.sync('google');
    pending.push(newSync);
    assert.notStrictEqual(newSync, oldSync, 'a new connection generation must not reuse the old in-flight promise');

    releaseNewCalendar(calendarList('new-calendar', 'New account'));
    releaseOldCalendar(json({ error: 'old authorization was revoked' }, 401));
    const [oldResult, newResult, authorizationResult] = await Promise.all([oldSync, newSync, newAuthorization]);

    assert.equal(oldResult.outcome, 'failed');
    assert.match(oldResult.outcome === 'failed' ? oldResult.notice : '', /connection changed/i);
    assert.deepEqual(newResult, { outcome: 'synced', recordCount: 1 });
    assert.equal(authorizationResult.outcome, 'connected');
    assert.equal(store.getConnection('google')?.state, 'connected');
    assert.deepEqual(store.listProviderRecords().map(record => ({
      externalId: record.externalId,
      title: record.title,
      connectionId: record.connectionId,
    })), [{
      externalId: 'new-account-event',
      title: 'New account event',
      connectionId: newConnection.connectionId,
    }]);
  } finally {
    releaseNewCalendar(calendarList('new-calendar', 'New account'));
    releaseOldCalendar(calendarList('old-calendar', 'Old account'));
    await Promise.allSettled(pending);
    store.close();
  }
});
