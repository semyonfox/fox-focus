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
  createGoogleTask as insertGoogleTask,
  listGoogleCalendarEvents,
  listGoogleCalendars,
  listGoogleTaskLists,
  listGoogleTasks,
  listMicrosoftCalendarView,
  listMicrosoftCalendars,
  listMicrosoftTodoLists,
  listMicrosoftTodoTasks,
  reconcileGoogleTaskCreate as findGoogleTaskCreate,
  updateGoogleTaskStatus,
  type GoogleTaskCreateCandidate as ProviderGoogleTaskCreateCandidate,
  type ImportedCalendar,
  type ImportedCalendarEvent,
  type ImportedTask,
  type ProviderReadFailure,
  type ProviderReadResult,
} from './providers.ts';
import { areaForList, listAreaKey } from '../src/integration-model.ts';
import type { Area } from '../src/model.ts';
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
const DEFAULT_PROVIDER_READ_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_READ_TIMEOUT_MS = 5 * 60_000;

const googleScopes = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar',
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
  providerReadTimeoutMs?: number;
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

export type GoogleTaskSnapshot = {
  title: string;
  notes: string | null;
  state: 'open' | 'completed';
  completedAt: string | null;
  dueOn: string | null;
  parentId: string | null;
  position: string | null;
  sourceUrl: string | null;
  version: string | null;
  updatedAt: string | null;
  completionWritable: boolean;
};

export type GoogleTaskWriteResult =
  | {
      outcome: 'succeeded';
      sourceStatus: string;
      sourceVersion: string;
      sourceUpdatedAt: string | null;
      completedAt: string | null;
      current?: GoogleTaskSnapshot;
    }
  | {
      outcome: 'conflict';
      notice: string;
      current?: GoogleTaskSnapshot;
    }
  | { outcome: 'failed'; notice: string; retryable: boolean };

export type GoogleTaskDestination = {
  accountId: string;
  listId: string;
  name: string;
  area: Area;
  fallback: boolean;
  fresh: boolean;
  explicitMapping: boolean;
};

export type GoogleTaskDestinationCatalogue = {
  accountId: string | null;
  connectionGeneration: string | null;
  destinations: GoogleTaskDestination[];
  fallbackListId: string | null;
};

export type GoogleTaskCreateCandidate = ProviderGoogleTaskCreateCandidate;

export type GoogleTaskCreateWriteResult =
  | { outcome: 'succeeded'; externalId: string; current: GoogleTaskSnapshot }
  | { outcome: 'failed'; notice: string; retryable: boolean }
  | { outcome: 'unknown'; notice: string; candidateExternalId?: string }
  | { outcome: 'conflict'; notice: string; candidates: readonly GoogleTaskCreateCandidate[] };

type TokenExchangeResult =
  | { kind: 'ok'; tokens: OAuthTokenSet }
  | { kind: 'failed'; needsReconnect: boolean };

type RuntimeConfig = IntegrationConfig & {
  fetch: typeof fetch;
  now: () => Date;
  syncWindowPastDays: number;
  syncWindowFutureDays: number;
  providerReadTimeoutMs: number;
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
  const providerReadTimeoutMs = config.providerReadTimeoutMs ?? DEFAULT_PROVIDER_READ_TIMEOUT_MS;
  const taskActionTimeoutMs = config.taskActionTimeoutMs ?? DEFAULT_TASK_ACTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(past) || past < 0 || past > 366 || !Number.isSafeInteger(future) || future < 1 || future > 366) {
    throw new Error('Invalid integration sync window');
  }
  if (!Number.isSafeInteger(taskActionTimeoutMs) || taskActionTimeoutMs < 1 || taskActionTimeoutMs > DEFAULT_TASK_ACTION_TIMEOUT_MS) {
    throw new Error('Invalid task action timeout');
  }
  if (!Number.isSafeInteger(providerReadTimeoutMs) || providerReadTimeoutMs < 1 || providerReadTimeoutMs > MAX_PROVIDER_READ_TIMEOUT_MS) {
    throw new Error('Invalid provider read timeout');
  }
  return {
    ...config,
    appBaseUrl: baseUrl,
    tokenMasterKey: config.tokenMasterKey,
    fetch: config.fetch ?? globalThis.fetch,
    now: config.now ?? (() => new Date()),
    syncWindowPastDays: past,
    syncWindowFutureDays: future,
    providerReadTimeoutMs,
    taskActionTimeoutMs,
  };
}

function callbackUrl(config: RuntimeConfig, provider: Provider): string {
  return `${config.appBaseUrl}/api/v1/integrations/${provider}/callback`;
}

function providerConfig(config: RuntimeConfig, provider: Provider): ProviderOAuthConfig | null {
  return config.providers[provider] ?? null;
}

function scopesStayWithinRequest(
  provider: Provider,
  granted: readonly string[] | undefined,
  requested: readonly string[],
): boolean {
  if (granted === undefined) return true;
  const allowed = new Set(requested);
  // Google can return previously granted narrower scopes alongside the newer
  // requested write scopes on reconnect. Each exception below is strictly
  // narrower than a requested scope, so it adds no capability.
  if (provider === 'google') {
    if (requested.includes('https://www.googleapis.com/auth/tasks')) {
      allowed.add('https://www.googleapis.com/auth/tasks.readonly');
    }
    if (requested.includes('https://www.googleapis.com/auth/calendar')) {
      allowed.add('https://www.googleapis.com/auth/calendar.events');
      allowed.add('https://www.googleapis.com/auth/calendar.events.readonly');
      allowed.add('https://www.googleapis.com/auth/calendar.calendarlist.readonly');
    } else if (requested.includes('https://www.googleapis.com/auth/calendar.events')) {
      allowed.add('https://www.googleapis.com/auth/calendar.events.readonly');
    }
  }
  return granted.every(scope => allowed.has(scope));
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
  options: { accountId?: string; newGeneration?: boolean } = {},
): StoredConnection {
  const now = config.now().toISOString();
  const connectionId = options.newGeneration || !existing ? randomUUID() : existing.connectionId;
  const accountId = options.accountId ?? existing?.accountId ?? `legacy:${connectionId}`;
  const tokenEnvelope = serializeOAuthTokenEnvelope(
    sealOAuthTokenSet(tokens, config.tokenMasterKey, { provider, connectionId }),
  );
  const connection: StoredConnection = {
    provider,
    accountId,
    connectionId,
    state: 'connected',
    scopes: [...(tokens.scopes ?? providerConfig(config, provider)?.scopes ?? [])],
    tokenEnvelope,
    connectedAt: existing?.connectedAt ?? now,
    updatedAt: now,
    lastSyncedAt: options.newGeneration ? null : existing?.lastSyncedAt ?? null,
    lastError: null,
  };
  store.saveConnection(connection);
  return store.getConnection(provider) ?? connection;
}

async function readGoogleAccountId(
  config: RuntimeConfig,
  accessToken: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await config.fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(config.providerReadTimeoutMs),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* the identity read already failed */ }
    return null;
  }
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 255 ||
      /[\u0000-\u0020\u007f]/.test(payload.sub)) return null;
    return payload.sub;
  } catch {
    return null;
  }
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

function providerClient(config: RuntimeConfig, accessToken: string) {
  return {
    accessToken,
    fetch: config.fetch,
    signal: AbortSignal.timeout(config.providerReadTimeoutMs),
  };
}

function scopeError(failure: ProviderReadFailure): string {
  return `${failure.operation}: ${failure.status}`;
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
    notes: task.notes,
    parentId: task.parentId,
    position: task.position,
    sourceUrl: task.sourceUrl,
    sourceTimeZone: null,
  };
}

function googleTaskSnapshot(task: ImportedTask): GoogleTaskSnapshot {
  return {
    title: task.title,
    notes: task.notes,
    state: task.state,
    completedAt: task.completedAt,
    dueOn: task.dueDate,
    parentId: task.parentId,
    position: task.position,
    sourceUrl: task.sourceUrl,
    version: task.version,
    updatedAt: task.updatedAt,
    completionWritable: task.completionWritable !== false,
  };
}

function windowFor(config: RuntimeConfig): { timeMin: string; timeMax: string } {
  const now = config.now().getTime();
  return {
    timeMin: new Date(now - config.syncWindowPastDays * 86_400_000).toISOString(),
    timeMax: new Date(now + config.syncWindowFutureDays * 86_400_000).toISOString(),
  };
}

type ScopedSyncResult = {
  recordCount: number;
  failures: ProviderReadFailure[];
};

async function syncGoogle(
  store: Store,
  config: RuntimeConfig,
  accessToken: string,
  accountId: string,
  connectionGeneration: string,
  withTaskScope: <T>(accountId: string, listId: string, work: () => Promise<T>) => Promise<T>,
): Promise<ScopedSyncResult> {
  const range = windowFor(config);
  const failures: ProviderReadFailure[] = [];
  let recordCount = 0;

  const assertCurrentConnection = () => {
    const current = store.getConnection('google');
    if (current?.accountId !== accountId || current.connectionId !== connectionGeneration) throw new ConnectionChanged();
  };
  const markFailed = (
    resourceKind: 'calendar' | 'task-list',
    containerId: string,
    containerName: string,
    failure: ProviderReadFailure,
  ) => {
    assertCurrentConnection();
    const fetchedAt = config.now().toISOString();
    store.markScopeFailed({
      provider: 'google',
      resourceKind,
      accountId,
      connectionGeneration,
      containerId,
      containerName,
      coverageFrom: resourceKind === 'calendar' ? range.timeMin : null,
      coverageTo: resourceKind === 'calendar' ? range.timeMax : null,
      fetchedAt,
    }, scopeError(failure));
  };
  const markKnownScopesFailed = (
    resourceKind: 'calendar' | 'task-list',
    failure: ProviderReadFailure,
  ) => {
    for (const state of store.listSyncStates()) {
      if (
        state.provider === 'google' && state.resourceKind === resourceKind &&
        state.accountId === accountId && state.connectionGeneration === connectionGeneration
      ) markFailed(resourceKind, state.containerId, state.containerName, failure);
    }
  };

  const calendarResult = await listGoogleCalendars(providerClient(config, accessToken));
  if (calendarResult.status !== 'ok') {
    failures.push(calendarResult);
    markKnownScopesFailed('calendar', calendarResult);
  } else {
    const discovered = new Set(calendarResult.value.records.map(calendar => calendar.externalId));
    for (const calendar of calendarResult.value.records) {
      const events = await listGoogleCalendarEvents(providerClient(config, accessToken), {
        calendarId: calendar.externalId,
        ...range,
      });
      if (events.status !== 'ok') {
        failures.push(events);
        markFailed('calendar', calendar.externalId, calendar.title, events);
        continue;
      }
      const records = events.value.events.flatMap(event => {
        const record = eventRecord('google', calendar, event);
        return record ? [{ ...record, accountId, connectionGeneration, connectionId: accountId }] : [];
      });
      assertCurrentConnection();
      recordCount += store.publishProviderScope({
        provider: 'google',
        resourceKind: 'calendar',
        accountId,
        connectionGeneration,
        containerId: calendar.externalId,
        containerName: calendar.title,
        records,
        coverageFrom: range.timeMin,
        coverageTo: range.timeMax,
        fetchedAt: config.now().toISOString(),
      });
    }
    for (const state of store.listSyncStates()) {
      if (
        state.provider !== 'google' || state.resourceKind !== 'calendar' ||
        state.accountId !== accountId || state.connectionGeneration !== connectionGeneration ||
        discovered.has(state.containerId)
      ) continue;
      assertCurrentConnection();
      store.publishProviderScope({
        provider: 'google', resourceKind: 'calendar', accountId,
        connectionGeneration, containerId: state.containerId, containerName: state.containerName,
        records: [], coverageFrom: range.timeMin, coverageTo: range.timeMax, fetchedAt: config.now().toISOString(),
      });
    }
  }

  const taskListResult = await listGoogleTaskLists(providerClient(config, accessToken));
  if (taskListResult.status !== 'ok') {
    failures.push(taskListResult);
    markKnownScopesFailed('task-list', taskListResult);
  } else {
    const discovered = new Set(taskListResult.value.records.map(list => list.externalId));
    for (const list of taskListResult.value.records) {
      await withTaskScope(accountId, list.externalId, async () => {
        const tasks = await listGoogleTasks(providerClient(config, accessToken), { taskListId: list.externalId });
        if (tasks.status !== 'ok') {
          failures.push(tasks);
          markFailed('task-list', list.externalId, list.title, tasks);
          return;
        }
        const records = tasks.value.records.flatMap(task => {
          const record = taskRecord('google', list.externalId, list.title, task);
          return record ? [{ ...record, accountId, connectionGeneration, connectionId: accountId }] : [];
        });
        assertCurrentConnection();
        recordCount += store.publishProviderScope({
          provider: 'google',
          resourceKind: 'task-list',
          accountId,
          connectionGeneration,
          containerId: list.externalId,
          containerName: list.title,
          records,
          coverageFrom: null,
          coverageTo: null,
          fetchedAt: config.now().toISOString(),
        });
      });
    }
    for (const state of store.listSyncStates()) {
      if (
        state.provider !== 'google' || state.resourceKind !== 'task-list' ||
        state.accountId !== accountId || state.connectionGeneration !== connectionGeneration ||
        discovered.has(state.containerId)
      ) continue;
      await withTaskScope(accountId, state.containerId, async () => {
        assertCurrentConnection();
        store.publishProviderScope({
          provider: 'google', resourceKind: 'task-list', accountId,
          connectionGeneration, containerId: state.containerId, containerName: state.containerName,
          records: [], coverageFrom: null, coverageTo: null, fetchedAt: config.now().toISOString(),
        });
        store.retireProviderScope({
          provider: 'google', resourceKind: 'task-list', accountId,
          connectionGeneration, containerId: state.containerId,
        });
      });
    }
  }

  return { recordCount, failures };
}

async function syncMicrosoft(config: RuntimeConfig, accessToken: string): Promise<ImportedRecord[]> {
  const calendars = resultRecords(await listMicrosoftCalendars(providerClient(config, accessToken)));
  const taskLists = resultRecords(await listMicrosoftTodoLists(providerClient(config, accessToken)));
  const range = windowFor(config);
  const records: ImportedRecord[] = [];

  for (const calendar of calendars) {
    const events = resultRecords(await listMicrosoftCalendarView(providerClient(config, accessToken), {
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
    const tasks = resultRecords(await listMicrosoftTodoTasks(providerClient(config, accessToken), { taskListId: list.externalId }));
    for (const task of tasks) {
      const record = taskRecord('microsoft', list.externalId, list.title, task);
      if (record) records.push(record);
    }
  }
  return records;
}

export type IntegrationService = {
  overview: () => IntegrationOverview;
  listGoogleTaskDestinations: () => GoogleTaskDestinationCatalogue;
  startAuthorization: (provider: Provider) => string | null;
  completeAuthorization: (provider: Provider, search: URLSearchParams) => Promise<OAuthCallbackResult>;
  sync: (provider: Provider) => Promise<SyncResult>;
  syncConnected: () => Promise<void>;
  updateGoogleTaskCompletion: (input: {
    accountId: string;
    containerId: string;
    externalId: string;
    desiredState: 'open' | 'completed';
    expectedVersion?: string;
  }) => Promise<GoogleTaskWriteResult>;
  createGoogleTask: (input: {
    accountId: string;
    containerId: string;
    title: string;
    notes: string;
    dueOn: string | null;
  }) => Promise<GoogleTaskCreateWriteResult>;
  reconcileGoogleTaskCreate: (input: {
    accountId: string;
    containerId: string;
    nonce: string;
    candidateExternalId?: string;
  }) => Promise<GoogleTaskCreateWriteResult>;
};

export function createIntegrationService(store: Store, input: IntegrationConfig): IntegrationService {
  const config = normalizeConfig(input);
  const activeSyncs = new Map<string, Promise<SyncResult>>();
  const taskScopeTails = new Map<string, Promise<void>>();

  async function withTaskScope<T>(
    connectionId: string,
    listId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([connectionId, listId]);
    const previous = taskScopeTails.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    taskScopeTails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (taskScopeTails.get(key) === tail) taskScopeTails.delete(key);
    }
  }

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

  function listGoogleTaskDestinations(): GoogleTaskDestinationCatalogue {
    const connection = store.getConnection('google');
    if (!providerConfig(config, 'google') || !connection || connection.state !== 'connected') {
      return { accountId: null, connectionGeneration: null, destinations: [], fallbackListId: null };
    }
    const listAreas = store.read().data.listAreas;
    const states = store.listSyncStates().filter(state =>
      state.provider === 'google' && state.resourceKind === 'task-list' &&
      state.accountId === connection.accountId && state.connectionGeneration === connection.connectionId &&
      state.containerId !== '@default' && state.state === 'fresh' && state.successfulFetchAt !== null);
    const exactFallbacks = states.filter(state => state.containerName === 'My Tasks');
    const fallbackListId = exactFallbacks.length === 1 ? exactFallbacks[0].containerId : null;
    const destinations = states.map(state => ({
      accountId: connection.accountId,
      listId: state.containerId,
      name: state.containerName,
      area: areaForList(listAreas, 'google', state.containerId, state.containerName),
      fallback: state.containerId === fallbackListId,
      fresh: true,
      explicitMapping: Object.prototype.hasOwnProperty.call(
        listAreas,
        listAreaKey('google', state.containerId),
      ),
    })).sort((first, second) =>
      Number(second.fallback) - Number(first.fallback) ||
      first.name.localeCompare(second.name) || first.listId.localeCompare(second.listId));
    return {
      accountId: connection.accountId,
      connectionGeneration: connection.connectionId,
      destinations,
      fallbackListId,
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
      if (!scopesStayWithinRequest(provider, exchanged.tokens.scopes, settings.scopes)) {
        return { outcome: 'failed', notice: 'The provider returned more access than Fox Focus requested. Review consent and try again.' };
      }
      // A new authorization-code grant can represent a different account. Do
      // not silently retain the previous account's refresh token when this
      // grant did not provide its own offline authorization.
      const tokens = exchanged.tokens;
      if (!tokens.refreshToken) {
        return { outcome: 'failed', notice: 'The provider did not grant offline access. Reconnect and approve access again.' };
      }
      const accountId = provider === 'google'
        ? await readGoogleAccountId(config, tokens.accessToken)
        : `legacy:${randomUUID()}`;
      if (!accountId) {
        return { outcome: 'failed', notice: 'Google did not return a stable account identity. The previous connection was kept.' };
      }
      const previous = store.getConnection(provider);
      if (previous && previous.accountId !== accountId) {
        store.retireProviderAccount(provider, previous.accountId, config.now().toISOString());
      }
      recordToken(store, config, provider, tokens, previous, { accountId, newGeneration: true });
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

  async function freshAccessToken(
    provider: Provider,
    expected: { accountId?: string; connectionId?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ accessToken: string; accountId: string; connectionId: string }> {
    const loaded = connectionToken(store, config, provider);
    if (!loaded) throw new SyncFailure(true);
    if ((expected.accountId && loaded.connection.accountId !== expected.accountId) ||
      (expected.connectionId && loaded.connection.connectionId !== expected.connectionId)) throw new ConnectionChanged();
    if (!tokenNeedsRefresh(loaded.tokens, config.now())) {
      return {
        accessToken: loaded.tokens.accessToken,
        accountId: loaded.connection.accountId,
        connectionId: loaded.connection.connectionId,
      };
    }
    if (!loaded.tokens.refreshToken) {
      store.markConnectionNeedsReconnect(provider, 'Provider authorization needs reconnection.');
      throw new SyncFailure(true);
    }
    const refreshed = await tokenRequest(config, provider, {
      grant_type: 'refresh_token',
      refresh_token: loaded.tokens.refreshToken,
    }, signal);
    const current = store.getConnection(provider);
    if (current?.accountId !== loaded.connection.accountId || current.connectionId !== loaded.connection.connectionId) {
      throw new ConnectionChanged();
    }
    if (refreshed.kind !== 'ok') {
      if (refreshed.needsReconnect) store.markConnectionNeedsReconnect(provider, 'Provider authorization needs reconnection.');
      throw new SyncFailure(refreshed.needsReconnect);
    }
    const settings = providerConfig(config, provider);
    if (!settings || !scopesStayWithinRequest(provider, refreshed.tokens.scopes, settings.scopes)) {
      store.markConnectionNeedsReconnect(provider, 'Provider authorization needs reconnection.');
      throw new SyncFailure(true);
    }
    const tokens = mergeOAuthTokenSets(loaded.tokens, refreshed.tokens);
    recordToken(store, config, provider, tokens, loaded.connection);
    return {
      accessToken: tokens.accessToken,
      accountId: loaded.connection.accountId,
      connectionId: loaded.connection.connectionId,
    };
  }

  async function syncNow(provider: Provider, expectedConnectionId: string | null): Promise<SyncResult> {
    if (!providerConfig(config, provider)) return { outcome: 'failed', notice: 'This provider is not configured on the server.' };
    store.setSyncState(provider, 'syncing');
    try {
      if (!expectedConnectionId) throw new SyncFailure(true);
      const grant = await freshAccessToken(
        provider,
        { connectionId: expectedConnectionId },
        AbortSignal.timeout(config.providerReadTimeoutMs),
      );
      if (provider === 'google') {
        const result = await syncGoogle(
          store,
          config,
          grant.accessToken,
          grant.accountId,
          grant.connectionId,
          withTaskScope,
        );
        const current = store.getConnection(provider);
        if (current?.accountId !== grant.accountId || current.connectionId !== grant.connectionId) {
          throw new ConnectionChanged();
        }
        if (result.failures.length > 0) {
          const needsReconnect = result.failures.some(failure =>
            failure.status === 'reauthorization-required' || failure.status === 'permission-denied');
          const notice = needsReconnect
            ? 'Google needs to be reconnected.'
            : `Google refreshed ${result.recordCount} records, but ${result.failures.length} source${result.failures.length === 1 ? '' : 's'} failed.`;
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
        store.setSyncState(provider, 'idle');
        const connection = store.getConnection(provider);
        if (connection) {
          store.saveConnection({
            ...connection,
            lastSyncedAt: config.now().toISOString(),
            lastError: null,
          });
        }
        return { outcome: 'synced', recordCount: result.recordCount };
      }
      const records = await syncMicrosoft(config, grant.accessToken);
      const current = store.getConnection(provider);
      if (current?.accountId !== grant.accountId || current.connectionId !== grant.connectionId) {
        throw new ConnectionChanged();
      }
      const recordCount = store.replaceProviderRecords(provider, records.map(record => ({
        ...record,
        accountId: grant.accountId,
        connectionGeneration: grant.connectionId,
        connectionId: grant.accountId,
      })));
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
    accountId: string;
    containerId: string;
    externalId: string;
    desiredState: 'open' | 'completed';
    expectedVersion?: string;
  }): Promise<GoogleTaskWriteResult> {
    const connection = store.getConnection('google');
    if (!providerConfig(config, 'google') || !connection || connection.state !== 'connected') {
      return { outcome: 'failed', notice: 'Google Tasks needs to be connected.', retryable: false };
    }
    if (connection.accountId !== input.accountId) {
      return { outcome: 'conflict', notice: 'The Google connection changed. Reconcile this task before updating it.' };
    }
    if (!connection.scopes.includes('https://www.googleapis.com/auth/tasks')) {
      store.markConnectionNeedsReconnect('google', 'Reconnect Google to approve task completion updates.');
      return { outcome: 'failed', notice: 'Reconnect Google before updating this linked task.', retryable: false };
    }
    return withTaskScope(input.accountId, input.containerId, async () => {
      try {
        const signal = AbortSignal.timeout(config.taskActionTimeoutMs);
        const grant = await freshAccessToken('google', { accountId: input.accountId }, signal);
        const beforeWrite = store.getConnection('google');
        if (beforeWrite?.accountId !== input.accountId || beforeWrite.connectionId !== grant.connectionId) {
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
        const afterWrite = store.getConnection('google');
        if (afterWrite?.accountId !== input.accountId) {
          return {
            outcome: 'failed',
            notice: 'The Google account changed while the approved update was running. The old task remains unavailable.',
            retryable: false,
          };
        }
        if (result.status === 'ok') {
          return {
            outcome: 'succeeded',
            sourceStatus: result.value.task.sourceState,
            sourceVersion: result.value.etag,
            sourceUpdatedAt: result.value.task.updatedAt,
            completedAt: result.value.task.completedAt,
            current: googleTaskSnapshot(result.value.task),
          };
        }
        if (result.status === 'conflict') {
          const current = result.currentTask;
          return {
            outcome: 'conflict',
            notice: 'The Google task changed after it was imported. Refresh before trying again.',
            ...(current ? { current: googleTaskSnapshot(current) } : {}),
          };
        }
        const needsReconnect = result.status === 'reauthorization-required' || result.status === 'permission-denied';
        const current = store.getConnection('google');
        if (needsReconnect && current?.accountId === input.accountId && current.connectionId === grant.connectionId) {
          store.markConnectionNeedsReconnect('google', 'Reconnect Google to update linked tasks.');
        }
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
    });
  }

  const safeCreateRetry = (status: string) => status === 'rate-limited';

  async function createGoogleTask(input: {
    accountId: string;
    containerId: string;
    title: string;
    notes: string;
    dueOn: string | null;
  }): Promise<GoogleTaskCreateWriteResult> {
    const connection = store.getConnection('google');
    if (!providerConfig(config, 'google') || !connection || connection.state !== 'connected') {
      return { outcome: 'failed', notice: 'Google Tasks needs to be connected.', retryable: false };
    }
    if (connection.accountId !== input.accountId) {
      return { outcome: 'conflict', notice: 'The Google connection changed. Choose the destination again.', candidates: [] };
    }
    if (!connection.scopes.includes('https://www.googleapis.com/auth/tasks')) {
      store.markConnectionNeedsReconnect('google', 'Reconnect Google to create tasks.');
      return { outcome: 'failed', notice: 'Reconnect Google before creating this task.', retryable: false };
    }
    if (input.containerId === '@default') {
      return { outcome: 'conflict', notice: 'Choose the discovered My Tasks list instead of an alias.', candidates: [] };
    }
    const approvedList = store.listSyncStates().find(state =>
      state.provider === 'google' && state.resourceKind === 'task-list' &&
      state.accountId === input.accountId && state.connectionGeneration === connection.connectionId &&
      state.containerId === input.containerId && state.state === 'fresh' && state.successfulFetchAt !== null);
    if (!approvedList) {
      return { outcome: 'conflict', notice: 'This Google task list is no longer in the current catalogue.', candidates: [] };
    }

    return withTaskScope(input.accountId, input.containerId, async () => {
      let insertStarted = false;
      try {
        const signal = AbortSignal.timeout(config.taskActionTimeoutMs);
        const grant = await freshAccessToken('google', { accountId: input.accountId }, signal);
        const taskLists = await listGoogleTaskLists({ accessToken: grant.accessToken, fetch: config.fetch, signal });
        const afterListRead = store.getConnection('google');
        if (afterListRead?.accountId !== input.accountId || afterListRead.connectionId !== grant.connectionId) {
          return { outcome: 'conflict', notice: 'The Google connection changed before creation.', candidates: [] };
        }
        if (taskLists.status !== 'ok') {
          const needsReconnect = taskLists.status === 'reauthorization-required' || taskLists.status === 'permission-denied';
          const current = store.getConnection('google');
          if (needsReconnect && current?.accountId === input.accountId && current.connectionId === grant.connectionId) {
            store.markConnectionNeedsReconnect('google', 'Reconnect Google to create tasks.');
          }
          return {
            outcome: 'failed',
            notice: needsReconnect
              ? 'Reconnect Google before creating this task.'
              : 'The Google task-list catalogue could not be checked.',
            retryable: !needsReconnect && taskLists.status !== 'invalid-request' && taskLists.status !== 'not-found',
          };
        }
        const liveList = taskLists.value.records.find(list => list.externalId === input.containerId);
        if (!liveList || liveList.title !== approvedList.containerName) {
          return {
            outcome: 'conflict',
            notice: liveList
              ? 'The destination list was renamed. Refresh it before creating the task.'
              : 'The destination list no longer exists. Choose another list.',
            candidates: [],
          };
        }
        const currentList = store.listSyncStates().find(state =>
          state.provider === 'google' && state.resourceKind === 'task-list' &&
          state.accountId === input.accountId && state.connectionGeneration === grant.connectionId &&
          state.containerId === input.containerId && state.state === 'fresh' && state.successfulFetchAt !== null);
        const beforeInsert = store.getConnection('google');
        if (
          beforeInsert?.accountId !== input.accountId || beforeInsert.connectionId !== grant.connectionId ||
          !currentList || currentList.containerName !== approvedList.containerName ||
          currentList.containerName !== liveList.title
        ) {
          return {
            outcome: 'conflict',
            notice: 'The destination list changed while creation was waiting. Refresh it before creating the task.',
            candidates: [],
          };
        }

        insertStarted = true;
        const result = await insertGoogleTask(
          { accessToken: grant.accessToken, fetch: config.fetch, signal },
          { taskListId: input.containerId, title: input.title, notes: input.notes, dueOn: input.dueOn },
        );
        const currentConnection = store.getConnection('google');
        const connectionChanged = currentConnection?.accountId !== input.accountId ||
          currentConnection.connectionId !== grant.connectionId;
        if (result.status === 'ok') {
          return {
            outcome: 'succeeded',
            externalId: result.value.taskId,
            current: googleTaskSnapshot(result.value.task),
          };
        }
        if (result.status === 'unknown') {
          return {
            outcome: 'unknown',
            notice: connectionChanged
              ? 'The Google connection changed after dispatch. Reconcile the original account before any new insert.'
              : 'Google may have created the task. Reconciliation is required before any new insert.',
            ...(result.candidateTaskId === undefined ? {} : { candidateExternalId: result.candidateTaskId }),
          };
        }
        const needsReconnect = result.failure === 'reauthorization-required' || result.failure === 'permission-denied';
        if (needsReconnect && currentConnection?.accountId === input.accountId &&
          currentConnection.connectionId === grant.connectionId) {
          store.markConnectionNeedsReconnect('google', 'Reconnect Google to create tasks.');
        }
        return {
          outcome: 'failed',
          notice: needsReconnect
            ? 'Reconnect Google before creating this task.'
            : 'Google rejected the task before creating it.',
          retryable: !needsReconnect && safeCreateRetry(result.failure),
        };
      } catch (error) {
        if (insertStarted) {
          return {
            outcome: 'unknown',
            notice: 'Google may have created the task. Reconciliation is required before any new insert.',
          };
        }
        if (error instanceof ConnectionChanged) {
          return { outcome: 'conflict', notice: 'The Google connection changed before creation.', candidates: [] };
        }
        const needsReconnect = error instanceof SyncFailure && error.needsReconnect;
        return {
          outcome: 'failed',
          notice: needsReconnect
            ? 'Reconnect Google before creating this task.'
            : 'Google could not be reached before creation.',
          retryable: !needsReconnect,
        };
      }
    });
  }

  async function reconcileGoogleTaskCreate(input: {
    accountId: string;
    containerId: string;
    nonce: string;
    candidateExternalId?: string;
  }): Promise<GoogleTaskCreateWriteResult> {
    const connection = store.getConnection('google');
    if (!providerConfig(config, 'google') || !connection || connection.state !== 'connected') {
      return { outcome: 'unknown', notice: 'Reconnect the original Google account to reconcile this create.' };
    }
    if (connection.accountId !== input.accountId) {
      return { outcome: 'conflict', notice: 'The Google connection changed. Reconcile the original account.', candidates: [] };
    }
    return withTaskScope(input.accountId, input.containerId, async () => {
      try {
        const signal = AbortSignal.timeout(config.taskActionTimeoutMs);
        const grant = await freshAccessToken('google', { accountId: input.accountId }, signal);
        const beforeRead = store.getConnection('google');
        if (beforeRead?.accountId !== input.accountId || beforeRead.connectionId !== grant.connectionId) {
          return { outcome: 'unknown', notice: 'The Google connection changed before reconciliation. Do not insert it again.' };
        }
        const result = await findGoogleTaskCreate(
          { accessToken: grant.accessToken, fetch: config.fetch, signal },
          {
            taskListId: input.containerId,
            nonce: input.nonce,
            ...(input.candidateExternalId === undefined ? {} : { candidateTaskId: input.candidateExternalId }),
          },
        );
        if (result.status === 'ok') {
          return {
            outcome: 'succeeded',
            externalId: result.value.taskId,
            current: googleTaskSnapshot(result.value.task),
          };
        }
        if (result.status === 'conflict') {
          return {
            outcome: 'conflict',
            notice: 'More than one Google task could match this create. Review the candidates.',
            candidates: result.candidates,
          };
        }
        if (result.status === 'failed') {
          return { outcome: 'failed', notice: 'The create reconciliation request is invalid.', retryable: false };
        }
        const needsReconnect = result.failure === 'reauthorization-required' || result.failure === 'permission-denied';
        const current = store.getConnection('google');
        if (needsReconnect && current?.accountId === input.accountId && current.connectionId === grant.connectionId) {
          store.markConnectionNeedsReconnect('google', 'Reconnect Google to reconcile task creation.');
        }
        return {
          outcome: 'unknown',
          notice: result.failure === 'not-found'
            ? 'No matching Google task is visible yet. Do not insert it again.'
            : 'The Google task could not be reconciled. Do not insert it again.',
          ...(result.candidateTaskId === undefined ? {} : { candidateExternalId: result.candidateTaskId }),
        };
      } catch (error) {
        if (error instanceof ConnectionChanged) {
          return { outcome: 'conflict', notice: 'The Google connection changed during reconciliation.', candidates: [] };
        }
        return {
          outcome: 'unknown',
          notice: 'The Google task could not be reconciled. Do not insert it again.',
          ...(input.candidateExternalId === undefined ? {} : { candidateExternalId: input.candidateExternalId }),
        };
      }
    });
  }

  return {
    overview,
    listGoogleTaskDestinations,
    startAuthorization,
    completeAuthorization,
    sync,
    syncConnected,
    updateGoogleTaskCompletion,
    createGoogleTask,
    reconcileGoogleTaskCreate,
  };
}
