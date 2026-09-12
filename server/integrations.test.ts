import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegrationService, integrationConfigFromEnvironment } from './integrations.ts';
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
    assert.ok(stored?.tokenEnvelope);
    assert.ok(!stored.tokenEnvelope.includes('test-access-token'));
    assert.ok(!stored.tokenEnvelope.includes('test-refresh-token'));
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
