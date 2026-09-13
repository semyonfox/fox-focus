import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  OAuthSecurityError,
  createOAuthAuthorizationRequest,
  hashOAuthState,
  isOAuthTokenMasterKey,
  mergeOAuthTokenSets,
  openOAuthTokenSet,
  openOAuthVerifier,
  parseOAuthCallback,
  sealOAuthTokenSet,
  sealOAuthVerifier,
  serializeOAuthTokenEnvelope,
  tokenSetFromOAuthResponse,
  type OAuthTokenSet,
} from './oauth.ts';
import {
  listGoogleCalendarEvents,
  listGoogleCalendars,
  listGoogleTaskLists,
  listGoogleTasks,
  listMicrosoftCalendarView,
  listMicrosoftCalendars,
  listMicrosoftTodoLists,
  listMicrosoftTodoTasks,
  updateGoogleTaskStatus,
  type ImportedCalendar,
  type ImportedCalendarEvent,
  type ImportedTask,
  type ProviderReadFailure,
  type ProviderReadResult,
} from './providers.ts';
import {
  TASK_ACTION_LEASE_MS,
  type ConnectionSummary,
  type ImportedRecord,
  type Provider,
  type StoredConnection,
  type Store,
  type SyncSummary,
} from './store.ts';
// Leave time for response handling and the final SQLite write before recovery.
const DEFAULT_TASK_ACTION_TIMEOUT_MS = TASK_ACTION_LEASE_MS - 30_000;

const googleScopes = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/tasks',
] as const;

const microsoftScopes = [
  'offline_access',
  'Calendars.ReadBasic',
  'Tasks.Read',
] as const;

const providerNames: Record<Provider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};

type ProviderOAuthConfig = {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: readonly string[];
  additionalAuthorizationParameters: Readonly<Record<string, string>>;
};

export type IntegrationConfig = {
  appBaseUrl: string;
  tokenMasterKey: string;
  providers: Partial<Record<Provider, ProviderOAuthConfig>>;
  fetch?: typeof fetch;
  now?: () => Date;
  syncWindowPastDays?: number;
  syncWindowFutureDays?: number;
  taskActionTimeoutMs?: number;
};

export type IntegrationProviderStatus = {
  provider: Provider;
  displayName: string;
  configured: boolean;
  connection: ConnectionSummary | null;
  sync: SyncSummary;
  calendarEventCount: number;
  taskCount: number;
};

export type IntegrationOverview = {
  providers: IntegrationProviderStatus[];
  records: ReturnType<Store['listProviderRecords']>;
};

export type OAuthCallbackResult =
  | { outcome: 'connected'; notice: string }
  | { outcome: 'declined'; notice: string }
  | { outcome: 'failed'; notice: string };

export type SyncResult =
  | { outcome: 'synced'; recordCount: number }
  | { outcome: 'failed'; notice: string };

export type GoogleTaskWriteResult =
  | {
      outcome: 'succeeded';
      sourceStatus: string;
      sourceVersion: string;
      sourceUpdatedAt: string | null;
      completedAt: string | null;
    }
  | { outcome: 'conflict'; notice: string }
  | { outcome: 'failed'; notice: string; retryable: boolean };

type TokenExchangeResult =
  | { kind: 'ok'; tokens: OAuthTokenSet }
  | { kind: 'failed'; needsReconnect: boolean };

type RuntimeConfig = IntegrationConfig & {
  fetch: typeof fetch;
  now: () => Date;
  syncWindowPastDays: number;
  syncWindowFutureDays: number;
  taskActionTimeoutMs: number;
};

class SyncFailure extends Error {
  readonly needsReconnect: boolean;

  constructor(needsReconnect = false) {
    super('Provider sync failed');
    this.name = 'SyncFailure';
    this.needsReconnect = needsReconnect;
  }
}

class ConnectionChanged extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function appBaseUrl(value: string | undefined): string | null {
  const parsed = value === undefined ? null : httpsUrl(value);
  if (!parsed) return null;
  return parsed.endsWith('/') ? parsed.slice(0, -1) : parsed;
}

function readSecretText(path: string | undefined): string | null {
  if (!path) return null;
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function readGoogleWebClient(path: string | undefined): { clientId: string; clientSecret: string } | null {
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.web)) return null;
    const clientId = cleanNonEmptyString(parsed.web.client_id);
    const clientSecret = cleanNonEmptyString(parsed.web.client_secret);
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  } catch {
    return null;
  }
}

function readMicrosoftClient(path: string | undefined): { clientId: string; clientSecret: string } | null {
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) return null;
    const clientId = cleanNonEmptyString(parsed.clientId ?? parsed.client_id);
    const clientSecret = cleanNonEmptyString(parsed.clientSecret ?? parsed.client_secret);
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  } catch {
    return null;
  }
}

function providerConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
  provider: Provider,
): ProviderOAuthConfig | null {
  if (provider === 'google') {
    const fileClient = readGoogleWebClient(environment.GOOGLE_OAUTH_CLIENT_FILE);
    const clientId = fileClient?.clientId ?? null;
    const clientSecret = fileClient?.clientSecret ?? null;
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scopes: googleScopes,
      additionalAuthorizationParameters: {
        access_type: 'offline',
        // A new connection needs this to reliably receive its own refresh token.
        prompt: 'consent',
      },
    };
  }

  const fileClient = readMicrosoftClient(environment.MICROSOFT_OAUTH_CLIENT_FILE);
  const clientId = fileClient?.clientId ?? null;
  const clientSecret = fileClient?.clientSecret ?? null;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizationEndpoint: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    scopes: microsoftScopes,
    additionalAuthorizationParameters: { prompt: 'select_account' },
  };
}

/**
 * Reads only named private configuration inputs. It never reports their values
 * and leaves a provider unavailable when its own credentials are absent.
 */
export function integrationConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): IntegrationConfig | null {
  const baseUrl = appBaseUrl(environment.APP_BASE_URL);
  const tokenMasterKey = readSecretText(environment.OAUTH_TOKEN_KEY_FILE);
  if (!baseUrl || !tokenMasterKey) return null;
  if (!isOAuthTokenMasterKey(tokenMasterKey)) throw new Error('Invalid OAuth token-encryption key');

  const providers: Partial<Record<Provider, ProviderOAuthConfig>> = {};
  for (const provider of ['google', 'microsoft'] as const) {
    const config = providerConfigFromEnvironment(environment, provider);
    if (config) providers[provider] = config;
  }
  return Object.keys(providers).length > 0
    ? { appBaseUrl: baseUrl, tokenMasterKey, providers }
    : null;
}

function normalizeConfig(config: IntegrationConfig): RuntimeConfig {
  const baseUrl = appBaseUrl(config.appBaseUrl);
  if (!baseUrl || !isOAuthTokenMasterKey(config.tokenMasterKey)) throw new Error('Invalid integration configuration');
  const past = config.syncWindowPastDays ?? 14;
  const future = config.syncWindowFutureDays ?? 90;
  const taskActionTimeoutMs = config.taskActionTimeoutMs ?? DEFAULT_TASK_ACTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(past) || past < 0 || past > 366 || !Number.isSafeInteger(future) || future < 1 || future > 366) {
    throw new Error('Invalid integration sync window');
  }
  if (!Number.isSafeInteger(taskActionTimeoutMs) || taskActionTimeoutMs < 1 || taskActionTimeoutMs > DEFAULT_TASK_ACTION_TIMEOUT_MS) {
    throw new Error('Invalid task action timeout');
  }
  return {
    ...config,
    appBaseUrl: baseUrl,
    tokenMasterKey: config.tokenMasterKey,
    fetch: config.fetch ?? globalThis.fetch,
    now: config.now ?? (() => new Date()),
    syncWindowPastDays: past,
    syncWindowFutureDays: future,
    taskActionTimeoutMs,
  };
}

function callbackUrl(config: RuntimeConfig, provider: Provider): string {
  return `${config.appBaseUrl}/api/v1/integrations/${provider}/callback`;
}

function providerConfig(config: RuntimeConfig, provider: Provider): ProviderOAuthConfig | null {
  return config.providers[provider] ?? null;
}

function scopesStayWithinRequest(granted: readonly string[] | undefined, requested: readonly string[]): boolean {
  return granted === undefined || granted.every(scope => requested.includes(scope));
}

function connectionToken(
  store: Store,
  config: RuntimeConfig,
  provider: Provider,
): { connection: StoredConnection; tokens: OAuthTokenSet } | null {
  const connection = store.getConnection(provider);
  if (!connection || connection.state !== 'connected' || !connection.tokenEnvelope) return null;
  try {
    return {
      connection,
      tokens: openOAuthTokenSet(connection.tokenEnvelope, config.tokenMasterKey, { provider, connectionId: connection.connectionId }),
    };
  } catch {
    try {
      // Before connection generations existed, the provider name was the AAD
      // connection identifier. Open that authenticated legacy envelope once,
      // then immediately bind it to the migrated generation identifier.
      const tokens = openOAuthTokenSet(connection.tokenEnvelope, config.tokenMasterKey, { provider, connectionId: provider });
      const migratedConnection = {
        ...connection,
        tokenEnvelope: serializeOAuthTokenEnvelope(
          sealOAuthTokenSet(tokens, config.tokenMasterKey, { provider, connectionId: connection.connectionId }),
        ),
      };
      store.saveConnection(migratedConnection);
      return { connection: migratedConnection, tokens };
    } catch {
      store.markConnectionNeedsReconnect(provider, 'Stored authorization needs reconnection.');
      return null;
    }
  }
}

function recordToken(
  store: Store,
  config: RuntimeConfig,
  provider: Provider,
  tokens: OAuthTokenSet,
  existing: StoredConnection | null,
  resetSyncHistory = false,
): StoredConnection {
  const now = config.now().toISOString();
  const connectionId = resetSyncHistory || !existing ? randomUUID() : existing.connectionId;
  const tokenEnvelope = serializeOAuthTokenEnvelope(
    sealOAuthTokenSet(tokens, config.tokenMasterKey, { provider, connectionId }),
  );
  const connection: StoredConnection = {
    provider,
    connectionId,
    state: 'connected',
    scopes: [...(tokens.scopes ?? providerConfig(config, provider)?.scopes ?? [])],
    tokenEnvelope,
    connectedAt: existing?.connectedAt ?? now,
    updatedAt: now,
    lastSyncedAt: resetSyncHistory ? null : existing?.lastSyncedAt ?? null,
    lastError: null,
  };
  store.saveConnection(connection);
  return store.getConnection(provider) ?? connection;
}

async function tokenRequest(
  config: RuntimeConfig,
  provider: Provider,
  parameters: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenExchangeResult> {
  const settings = providerConfig(config, provider);
  if (!settings) return { kind: 'failed', needsReconnect: false };
  let response: Response;
  try {
    response = await config.fetch(settings.tokenEndpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        ...parameters,
      }),
      signal,
    });
  } catch {
    return { kind: 'failed', needsReconnect: false };
  }
  if (!response.ok) return { kind: 'failed', needsReconnect: response.status === 400 || response.status === 401 };
  try {
    return { kind: 'ok', tokens: tokenSetFromOAuthResponse(await response.json() as unknown, config.now()) };
  } catch {
    return { kind: 'failed', needsReconnect: false };
  }
}

function tokenNeedsRefresh(tokens: OAuthTokenSet, now: Date): boolean {
  if (!tokens.expiresAt) return false;
  const expiresAt = Date.parse(tokens.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime() + 60_000;
}

function resultRecords<T>(result: ProviderReadResult<{ records: readonly T[] }>): readonly T[] {
  if (result.status === 'ok') return result.value.records;
  throw providerReadFailure(result);
}

function providerReadFailure(failure: ProviderReadFailure): SyncFailure {
  return new SyncFailure(
    failure.status === 'reauthorization-required' || failure.status === 'permission-denied',
  );
}

function eventRecord(
  provider: Provider,
  calendar: ImportedCalendar,
  event: ImportedCalendarEvent,
): ImportedRecord | null {
  if (event.state !== 'active') return null;
  return {
    provider,
    kind: 'calendar_event',
    containerId: calendar.externalId,
    containerName: calendar.title,
    externalId: event.externalId,
    title: event.title,
    status: 'active',
    startsAt: event.start.kind === 'instant' ? event.start.value : null,
    endsAt: event.end.kind === 'instant' ? event.end.value : null,
    startsOn: event.start.kind === 'date' ? event.start.value : null,
    endsOn: event.end.kind === 'date' ? event.end.value : null,
    allDay: event.isAllDay,
    dueOn: null,
    completedAt: null,
    sourceUpdatedAt: event.updatedAt,
    sourceUrl: null,
    sourceTimeZone: null,
  };
}

function taskRecord(
  provider: Provider,
  containerId: string,
  containerName: string,
  task: ImportedTask,
): ImportedRecord | null {
  if (task.isDeleted) return null;
  return {
    provider,
    kind: 'task',
    containerId,
    containerName,
    externalId: task.externalId,
    title: task.title,
    status: task.sourceState,
    startsAt: null,
    endsAt: null,
    startsOn: null,
    endsOn: null,
    allDay: false,
    dueOn: task.dueDate,
    completedAt: task.completedAt,
    sourceUpdatedAt: task.updatedAt,
    sourceVersion: task.version,
    completionWritable: provider === 'google' && task.completionWritable !== false,
    sourceUrl: null,
    sourceTimeZone: null,
  };
}

function windowFor(config: RuntimeConfig): { timeMin: string; timeMax: string } {
  const now = config.now().getTime();
  return {
    timeMin: new Date(now - config.syncWindowPastDays * 86_400_000).toISOString(),
    timeMax: new Date(now + config.syncWindowFutureDays * 86_400_000).toISOString(),
  };
}

async function syncGoogle(config: RuntimeConfig, accessToken: string): Promise<ImportedRecord[]> {
  const client = { accessToken, fetch: config.fetch };
  const calendars = resultRecords(await listGoogleCalendars(client));
  const taskLists = resultRecords(await listGoogleTaskLists(client));
  const range = windowFor(config);
  const records: ImportedRecord[] = [];

  for (const calendar of calendars) {
    const events = await listGoogleCalendarEvents(client, { calendarId: calendar.externalId, ...range });
    if (events.status !== 'ok') throw providerReadFailure(events);
    for (const event of events.value.events) {
      const record = eventRecord('google', calendar, event);
      if (record) records.push(record);
    }
  }
  for (const list of taskLists) {
    const tasks = resultRecords(await listGoogleTasks(client, { taskListId: list.externalId }));
    for (const task of tasks) {
      const record = taskRecord('google', list.externalId, list.title, task);
      if (record) records.push(record);
    }
  }
  return records;
}

async function syncMicrosoft(config: RuntimeConfig, accessToken: string): Promise<ImportedRecord[]> {
  const client = { accessToken, fetch: config.fetch };
  const calendars = resultRecords(await listMicrosoftCalendars(client));
  const taskLists = resultRecords(await listMicrosoftTodoLists(client));
  const range = windowFor(config);
  const records: ImportedRecord[] = [];

  for (const calendar of calendars) {
    const events = resultRecords(await listMicrosoftCalendarView(client, {
      calendarId: calendar.externalId,
      startDateTime: range.timeMin,
      endDateTime: range.timeMax,
    }));
    for (const event of events) {
      const record = eventRecord('microsoft', calendar, event);
      if (record) records.push(record);
    }
  }
  for (const list of taskLists) {
    const tasks = resultRecords(await listMicrosoftTodoTasks(client, { taskListId: list.externalId }));
    for (const task of tasks) {
      const record = taskRecord('microsoft', list.externalId, list.title, task);
      if (record) records.push(record);
    }
  }
  return records;
}

export type IntegrationService = {
  overview: () => IntegrationOverview;
  startAuthorization: (provider: Provider) => string | null;
  completeAuthorization: (provider: Provider, search: URLSearchParams) => Promise<OAuthCallbackResult>;
  sync: (provider: Provider) => Promise<SyncResult>;
  syncConnected: () => Promise<void>;
  updateGoogleTaskCompletion: (input: {
    connectionId: string;
    containerId: string;
    externalId: string;
    desiredState: 'open' | 'completed';
    expectedVersion?: string;
  }) => Promise<GoogleTaskWriteResult>;
};

export function createIntegrationService(store: Store, input: IntegrationConfig): IntegrationService {
  const config = normalizeConfig(input);
  const activeSyncs = new Map<string, Promise<SyncResult>>();

  function overview(): IntegrationOverview {
    const records = [
      ...store.listProviderRecords(2_000, 'calendar_event'),
      ...store.listProviderRecords(2_000, 'task'),
    ];
    const connections = new Map(store.listConnections().map(connection => [connection.provider, connection]));
    return {
      providers: (['google', 'microsoft'] as const).map(provider => ({
        provider,
        displayName: providerNames[provider],
        configured: providerConfig(config, provider) !== null,
        connection: connections.get(provider) ?? null,
        sync: store.getSyncSummary(provider),
        calendarEventCount: store.countProviderRecords(provider, 'calendar_event'),
        taskCount: store.countProviderRecords(provider, 'task'),
      })),
      records,
    };
  }

  function startAuthorization(provider: Provider): string | null {
    const settings = providerConfig(config, provider);
    if (!settings) return null;
    try {
      const request = createOAuthAuthorizationRequest({
        provider,
        authorizationEndpoint: settings.authorizationEndpoint,
        clientId: settings.clientId,
        redirectUri: callbackUrl(config, provider),
        scopes: settings.scopes,
        additionalParameters: settings.additionalAuthorizationParameters,
        now: config.now(),
      });
      const stateHash = hashOAuthState(request.attempt.state);
      const nonce = null;
      store.createOAuthAttempt({
        provider,
        stateHash,
        verifierEnvelope: sealOAuthVerifier(request.attempt.codeVerifier, config.tokenMasterKey, { provider, stateHash, nonce }),
        nonce,
        expiresAt: request.attempt.expiresAt,
      });
      return request.authorizationUrl;
    } catch {
      return null;
    }
  }

  async function completeAuthorization(provider: Provider, search: URLSearchParams): Promise<OAuthCallbackResult> {
    const settings = providerConfig(config, provider);
    if (!settings) return { outcome: 'failed', notice: 'This provider is not configured on the server.' };
    try {
      const callback = parseOAuthCallback(search);
      const stateHash = hashOAuthState(callback.state);
      const attempt = store.consumeOAuthAttempt(provider, stateHash, config.now().toISOString());
      if (!attempt) return { outcome: 'failed', notice: 'This connection link has expired or was already used.' };
      if (callback.kind === 'error') return { outcome: 'declined', notice: 'Connection was not approved.' };
      const verifier = openOAuthVerifier(attempt.verifierEnvelope, config.tokenMasterKey, {
        provider,
        stateHash: attempt.stateHash,
        nonce: attempt.nonce,
      });
      const exchanged = await tokenRequest(config, provider, {
        grant_type: 'authorization_code',
        code: callback.code,
        redirect_uri: callbackUrl(config, provider),
        code_verifier: verifier,
      });
      if (exchanged.kind !== 'ok') return { outcome: 'failed', notice: 'The provider did not complete the connection. Try again.' };
      if (!scopesStayWithinRequest(exchanged.tokens.scopes, settings.scopes)) {
        return { outcome: 'failed', notice: 'The provider returned more access than Fox Focus requested. Review consent and try again.' };
      }
      const previous = connectionToken(store, config, provider);
      // A new authorization-code grant can represent a different account. Do
      // not silently retain the previous account's refresh token when this
      // grant did not provide its own offline authorization.
      const tokens = exchanged.tokens;
      if (!tokens.refreshToken) {
        if (previous?.connection) {
          store.markConnectionNeedsReconnect(provider, 'Provider authorization needs a new offline grant.');
        }
        return { outcome: 'failed', notice: 'The provider did not grant offline access. Reconnect and approve access again.' };
      }
      // A completed authorization can replace one account with another. Clear
      // the prior account's imported data before the new account's first sync.
      store.clearProviderRecords(provider);
      recordToken(store, config, provider, tokens, previous?.connection ?? null, true);
      const syncResult = await sync(provider);
      return syncResult.outcome === 'synced'
        ? { outcome: 'connected', notice: `${providerNames[provider]} connected and imported ${syncResult.recordCount} records.` }
        : store.getConnection(provider)?.state === 'needs_reconnect'
          ? { outcome: 'failed', notice: `${providerNames[provider]} needs to be reconnected before it can import data.` }
          : { outcome: 'connected', notice: `${providerNames[provider]} connected. The first import can be retried from Fox Focus.` };
    } catch (error) {
      // OAuth failures deliberately stay generic: callbacks can contain codes.
      if (error instanceof OAuthSecurityError) return { outcome: 'failed', notice: 'This connection link could not be verified. Start again.' };
      return { outcome: 'failed', notice: 'The provider connection could not be completed. Try again.' };
    }
  }

  async function freshAccessToken(provider: Provider, expectedConnectionId?: string, signal?: AbortSignal): Promise<{ accessToken: string; connectionId: string }> {
    const loaded = connectionToken(store, config, provider);
    if (!loaded) throw new SyncFailure(true);
    if (expectedConnectionId && loaded.connection.connectionId !== expectedConnectionId) throw new ConnectionChanged();
    if (!tokenNeedsRefresh(loaded.tokens, config.now())) {
      return { accessToken: loaded.tokens.accessToken, connectionId: loaded.connection.connectionId };
    }
    if (!loaded.tokens.refreshToken) {
      store.markConnectionNeedsReconnect(provider, 'Provider authorization needs reconnection.');
      throw new SyncFailure(true);
    }
    const refreshed = await tokenRequest(config, provider, {
      grant_type: 'refresh_token',
      refresh_token: loaded.tokens.refreshToken,
    }, signal);
    if (store.getConnection(provider)?.connectionId !== loaded.connection.connectionId) throw new ConnectionChanged();
    if (refreshed.kind !== 'ok') {
      if (refreshed.needsReconnect) store.markConnectionNeedsReconnect(provider, 'Provider authorization needs reconnection.');
      throw new SyncFailure(refreshed.needsReconnect);
    }
    const settings = providerConfig(config, provider);
    if (!settings || !scopesStayWithinRequest(refreshed.tokens.scopes, settings.scopes)) {
      store.markConnectionNeedsReconnect(provider, 'Provider authorization needs reconnection.');
      throw new SyncFailure(true);
    }
    const tokens = mergeOAuthTokenSets(loaded.tokens, refreshed.tokens);
    recordToken(store, config, provider, tokens, loaded.connection);
    return { accessToken: tokens.accessToken, connectionId: loaded.connection.connectionId };
  }

  async function syncNow(provider: Provider, expectedConnectionId: string | null): Promise<SyncResult> {
    if (!providerConfig(config, provider)) return { outcome: 'failed', notice: 'This provider is not configured on the server.' };
    store.setSyncState(provider, 'syncing');
    try {
      if (!expectedConnectionId) throw new SyncFailure(true);
      const grant = await freshAccessToken(provider, expectedConnectionId);
      const records = provider === 'google'
        ? await syncGoogle(config, grant.accessToken)
        : await syncMicrosoft(config, grant.accessToken);
      if (store.getConnection(provider)?.connectionId !== grant.connectionId) throw new ConnectionChanged();
      const recordCount = store.replaceProviderRecords(provider, records.map(record => ({ ...record, connectionId: grant.connectionId })));
      return { outcome: 'synced', recordCount };
    } catch (error) {
      if (error instanceof ConnectionChanged) {
        return { outcome: 'failed', notice: `${providerNames[provider]} connection changed while an older refresh was running.` };
      }
      if (store.getConnection(provider)?.connectionId !== expectedConnectionId) {
        return { outcome: 'failed', notice: `${providerNames[provider]} connection changed while an older refresh was running.` };
      }
      const needsReconnect = error instanceof SyncFailure && error.needsReconnect;
      const notice = needsReconnect
        ? `${providerNames[provider]} needs to be reconnected.`
        : `${providerNames[provider]} could not be refreshed right now.`;
      store.setSyncState(provider, 'failed', notice);
      const connection = store.getConnection(provider);
      if (connection) {
        store.saveConnection({
          ...connection,
          state: needsReconnect ? 'needs_reconnect' : connection.state,
          lastError: notice,
        });
      }
      return { outcome: 'failed', notice };
    }
  }

  function sync(provider: Provider): Promise<SyncResult> {
    const connectionId = store.getConnection(provider)?.connectionId ?? null;
    const key = `${provider}:${connectionId ?? 'none'}`;
    const current = activeSyncs.get(key);
    if (current) return current;
    const next = syncNow(provider, connectionId).finally(() => activeSyncs.delete(key));
    activeSyncs.set(key, next);
    return next;
  }

  async function syncConnected(): Promise<void> {
    await Promise.all((['google', 'microsoft'] as const)
      .filter(provider => store.getConnection(provider)?.state === 'connected')
      .map(async provider => { await sync(provider); }));
  }

  async function updateGoogleTaskCompletion(input: {
    connectionId: string;
    containerId: string;
    externalId: string;
    desiredState: 'open' | 'completed';
    expectedVersion?: string;
  }): Promise<GoogleTaskWriteResult> {
    const connection = store.getConnection('google');
    if (!providerConfig(config, 'google') || !connection || connection.state !== 'connected') {
      return { outcome: 'failed', notice: 'Google Tasks needs to be connected.', retryable: false };
    }
    if (connection.connectionId !== input.connectionId) {
      return { outcome: 'conflict', notice: 'The Google connection changed. Reconcile this task before updating it.' };
    }
    if (!connection.scopes.includes('https://www.googleapis.com/auth/tasks')) {
      store.markConnectionNeedsReconnect('google', 'Reconnect Google to approve task completion updates.');
      return { outcome: 'failed', notice: 'Reconnect Google before updating this linked task.', retryable: false };
    }
    try {
      const signal = AbortSignal.timeout(config.taskActionTimeoutMs);
      const grant = await freshAccessToken('google', input.connectionId, signal);
      if (store.getConnection('google')?.connectionId !== input.connectionId) {
        return { outcome: 'conflict', notice: 'The Google connection changed. Reconcile this task before updating it.' };
      }
      const result = await updateGoogleTaskStatus(
        { accessToken: grant.accessToken, fetch: config.fetch, signal },
        {
          taskListId: input.containerId,
          taskId: input.externalId,
          state: input.desiredState,
          ...(input.expectedVersion ? { expectedEtag: input.expectedVersion } : {}),
        },
      );
      if (store.getConnection('google')?.connectionId !== input.connectionId) {
        return { outcome: 'conflict', notice: 'The Google connection changed while the approved update was running. Refresh and reconcile this task.' };
      }
      if (result.status === 'ok') {
        return {
          outcome: 'succeeded',
          sourceStatus: result.value.task.sourceState,
          sourceVersion: result.value.etag,
          sourceUpdatedAt: result.value.task.updatedAt,
          completedAt: result.value.task.completedAt,
        };
      }
      if (result.status === 'conflict') {
        return { outcome: 'conflict', notice: 'The Google task changed after it was imported. Refresh before trying again.' };
      }
      const needsReconnect = result.status === 'reauthorization-required' || result.status === 'permission-denied';
      if (needsReconnect) store.markConnectionNeedsReconnect('google', 'Reconnect Google to update linked tasks.');
      const retryable = ['network-error', 'rate-limited', 'remote-error'].includes(result.status);
      return {
        outcome: 'failed',
        notice: needsReconnect
          ? 'Reconnect Google before updating this linked task.'
          : result.status === 'verification-failed'
            ? 'Google accepted the change but the readback did not match. Refresh before retrying.'
            : 'The Google task was not confirmed. Your Fox Focus task was kept.',
        retryable,
      };
    } catch (error) {
      if (error instanceof ConnectionChanged) {
        return { outcome: 'conflict', notice: 'The Google connection changed. Reconcile this task before updating it.' };
      }
      const needsReconnect = error instanceof SyncFailure && error.needsReconnect;
      return {
        outcome: 'failed',
        notice: needsReconnect
          ? 'Reconnect Google before updating this linked task.'
          : 'Google could not be reached. Your Fox Focus task was kept.',
        retryable: !needsReconnect,
      };
    }
  }

  return { overview, startAuthorization, completeAuthorization, sync, syncConnected, updateGoogleTaskCompletion };
}
