import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInitialData, isPrototypeData, type PrototypeData } from '../src/model.ts';
import { isPushSubscription, type StoredPushDelivery, type StoredPushSubscription } from './push.ts';

export type Snapshot = { revision: number; data: PrototypeData };
export type Provider = 'google' | 'microsoft';
export type ProviderConnectionState = 'connected' | 'needs_reconnect';
export type ProviderRecordKind = 'calendar_event' | 'task';
export type ProviderSyncState = 'idle' | 'syncing' | 'failed';

export type ConnectionSummary = {
  provider: Provider;
  state: ProviderConnectionState;
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type StoredConnection = ConnectionSummary & {
  tokenEnvelope: string | null;
};

export type OAuthAttempt = {
  provider: Provider;
  stateHash: string;
  verifierEnvelope: string;
  nonce: string | null;
  expiresAt: string;
};

export type ImportedRecord = {
  provider: Provider;
  kind: ProviderRecordKind;
  containerId: string;
  containerName: string;
  externalId: string;
  title: string;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
  startsOn: string | null;
  endsOn: string | null;
  allDay: boolean;
  dueOn: string | null;
  completedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceUrl: string | null;
  sourceTimeZone: string | null;
};

export type StoredRecord = ImportedRecord & {
  id: number;
  importedAt: string;
};

export type SyncSummary = {
  provider: Provider;
  state: ProviderSyncState;
  startedAt: string | null;
  completedAt: string | null;
  recordCount: number;
  lastError: string | null;
};

export type PushSubscriptionRecord = {
  subscription: StoredPushSubscription;
  userAgent: string | null;
  createdAt: string;
};

const providers = new Set<Provider>(['google', 'microsoft']);
const recordKinds = new Set<ProviderRecordKind>(['calendar_event', 'task']);
const connectionStates = new Set<ProviderConnectionState>(['connected', 'needs_reconnect']);
const syncStates = new Set<ProviderSyncState>(['idle', 'syncing', 'failed']);

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && providers.has(value as Provider);
}

function isRecordKind(value: unknown): value is ProviderRecordKind {
  return typeof value === 'string' && recordKinds.has(value as ProviderRecordKind);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanFromInteger(value: unknown): boolean {
  return value === 1;
}

function stringList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(scope => typeof scope === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function rowToConnection(row: Record<string, unknown> | undefined): StoredConnection | null {
  if (
    !row || !isProvider(row.provider) || !connectionStates.has(row.state as ProviderConnectionState) ||
    typeof row.connected_at !== 'string' || typeof row.updated_at !== 'string'
  ) return null;

  return {
    provider: row.provider,
    state: row.state as ProviderConnectionState,
    scopes: stringList(row.scopes),
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    lastSyncedAt: stringOrNull(row.last_synced_at),
    lastError: stringOrNull(row.last_error),
    tokenEnvelope: stringOrNull(row.token_envelope),
  };
}

function rowToRecord(row: Record<string, unknown>): StoredRecord | null {
  if (
    !isProvider(row.provider) || !isRecordKind(row.kind) ||
    typeof row.id !== 'number' || typeof row.container_id !== 'string' ||
    typeof row.container_name !== 'string' || typeof row.external_id !== 'string' ||
    typeof row.title !== 'string' || typeof row.imported_at !== 'string'
  ) return null;

  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    containerId: row.container_id,
    containerName: row.container_name,
    externalId: row.external_id,
    title: row.title,
    status: stringOrNull(row.status),
    startsAt: stringOrNull(row.starts_at),
    endsAt: stringOrNull(row.ends_at),
    startsOn: stringOrNull(row.starts_on),
    endsOn: stringOrNull(row.ends_on),
    allDay: booleanFromInteger(row.all_day),
    dueOn: stringOrNull(row.due_on),
    completedAt: stringOrNull(row.completed_at),
    sourceUpdatedAt: stringOrNull(row.source_updated_at),
    sourceUrl: stringOrNull(row.source_url),
    sourceTimeZone: stringOrNull(row.source_time_zone),
    importedAt: row.imported_at,
  };
}

function rowToSync(row: Record<string, unknown> | undefined, provider: Provider): SyncSummary {
  if (
    !row || !isProvider(row.provider) || typeof row.state !== 'string' ||
    !syncStates.has(row.state as ProviderSyncState) || typeof row.record_count !== 'number'
  ) {
    return { provider, state: 'idle', startedAt: null, completedAt: null, recordCount: 0, lastError: null };
  }
  return {
    provider,
    state: row.state as ProviderSyncState,
    startedAt: stringOrNull(row.started_at),
    completedAt: stringOrNull(row.completed_at),
    recordCount: row.record_count,
    lastError: stringOrNull(row.last_error),
  };
}

// The prototype document remains the local-task store. Provider records live in
// normal tables, so an import cannot be edited through the workspace PUT route.
export function openStore(path: string, initialData: PrototypeData = createInitialData()) {
  const db = new DatabaseSync(path);
  const versionRow = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  const previousSchemaVersion = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0;
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS workspace (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_connections (
      provider TEXT PRIMARY KEY CHECK(provider IN ('google', 'microsoft')),
      state TEXT NOT NULL CHECK(state IN ('connected', 'needs_reconnect')),
      scopes TEXT NOT NULL CHECK(json_valid(scopes)),
      token_envelope TEXT,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_synced_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS provider_oauth_attempts (
      state_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('google', 'microsoft')),
      verifier_envelope TEXT NOT NULL,
      nonce TEXT,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_oauth_attempts_expiry ON provider_oauth_attempts(expires_at);
    CREATE TABLE IF NOT EXISTS provider_records (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('google', 'microsoft')),
      kind TEXT NOT NULL CHECK(kind IN ('calendar_event', 'task')),
      container_id TEXT NOT NULL,
      container_name TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT,
      starts_at TEXT,
      ends_at TEXT,
      starts_on TEXT,
      ends_on TEXT,
      all_day INTEGER NOT NULL CHECK(all_day IN (0, 1)),
      due_on TEXT,
      completed_at TEXT,
      source_updated_at TEXT,
      source_url TEXT,
      source_time_zone TEXT,
      imported_at TEXT NOT NULL,
      sync_marker TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE(provider, kind, container_id, external_id)
    );
    CREATE INDEX IF NOT EXISTS provider_records_visible ON provider_records(provider, kind, deleted_at, starts_at, due_on);
    CREATE TABLE IF NOT EXISTS provider_sync_state (
      provider TEXT PRIMARY KEY CHECK(provider IN ('google', 'microsoft')),
      state TEXT NOT NULL CHECK(state IN ('idle', 'syncing', 'failed')),
      started_at TEXT,
      completed_at TEXT,
      record_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS push_deliveries (
      delivery_key TEXT PRIMARY KEY,
      fired_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription_json TEXT NOT NULL CHECK(json_valid(subscription_json)),
      user_agent TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscription_deliveries (
      delivery_key TEXT NOT NULL,
      endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
      fired_at TEXT NOT NULL,
      PRIMARY KEY(delivery_key, endpoint)
    );
    CREATE INDEX IF NOT EXISTS push_subscription_deliveries_endpoint
      ON push_subscription_deliveries(endpoint);`);
  // A short-lived development build used the initial provider table without
  // date-only all-day columns. Keep that private SQLite shape upgrade-safe.
  const recordColumns = new Set((db.prepare('PRAGMA table_info(provider_records)').all() as Record<string, unknown>[])
    .flatMap(column => typeof column.name === 'string' ? [column.name] : []));
  if (!recordColumns.has('starts_on')) db.exec('ALTER TABLE provider_records ADD COLUMN starts_on TEXT');
  if (!recordColumns.has('ends_on')) db.exec('ALTER TABLE provider_records ADD COLUMN ends_on TEXT');
  if (previousSchemaVersion < 4) {
    db.exec('BEGIN');
    try {
      db.exec(`INSERT OR IGNORE INTO push_subscription_deliveries (delivery_key, endpoint, fired_at)
        SELECT deliveries.delivery_key, subscriptions.endpoint, deliveries.fired_at
        FROM push_deliveries AS deliveries CROSS JOIN push_subscriptions AS subscriptions;
        PRAGMA user_version=4;`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  db.prepare('INSERT OR IGNORE INTO workspace VALUES (1, 0, ?, ?)')
    .run(JSON.stringify(initialData), new Date().toISOString());

  function read(): Snapshot {
    const row = db.prepare('SELECT revision, data FROM workspace WHERE id=1').get() as Record<string, unknown> | undefined;
    if (!row || typeof row.data !== 'string' || typeof row.revision !== 'number') throw new Error('Invalid workspace row');
    const data: unknown = JSON.parse(row.data);
    if (!isPrototypeData(data)) throw new Error('Invalid stored workspace');
    return { revision: row.revision, data };
  }

  function save(revision: number, data: PrototypeData): Snapshot | null {
    const result = db.prepare('UPDATE workspace SET revision=revision+1, data=?, updated_at=? WHERE id=1 AND revision=?')
      .run(JSON.stringify(data), new Date().toISOString(), revision);
    return result.changes === 1 ? read() : null;
  }

  function getConnection(provider: Provider): StoredConnection | null {
    const row = db.prepare('SELECT * FROM provider_connections WHERE provider=?').get(provider) as Record<string, unknown> | undefined;
    return rowToConnection(row);
  }

  function listConnections(): ConnectionSummary[] {
    const rows = db.prepare('SELECT * FROM provider_connections ORDER BY provider').all() as Record<string, unknown>[];
    return rows.flatMap(row => {
      const connection = rowToConnection(row);
      if (!connection) return [];
      const { tokenEnvelope: _tokenEnvelope, ...summary } = connection;
      return [summary];
    });
  }

  function saveConnection(connection: StoredConnection): void {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO provider_connections (
      provider, state, scopes, token_envelope, connected_at, updated_at, last_synced_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      state=excluded.state, scopes=excluded.scopes, token_envelope=excluded.token_envelope,
      updated_at=excluded.updated_at, last_synced_at=excluded.last_synced_at, last_error=excluded.last_error`)
      .run(
        connection.provider,
        connection.state,
        JSON.stringify([...new Set(connection.scopes)].sort()),
        connection.tokenEnvelope,
        connection.connectedAt || now,
        now,
        connection.lastSyncedAt,
        connection.lastError,
      );
  }

  function markConnectionNeedsReconnect(provider: Provider, reason: string): void {
    const current = getConnection(provider);
    if (!current) return;
    saveConnection({ ...current, state: 'needs_reconnect', lastError: reason });
  }

  function createOAuthAttempt(attempt: OAuthAttempt): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM provider_oauth_attempts WHERE expires_at <= ?').run(new Date().toISOString());
      db.prepare(`INSERT INTO provider_oauth_attempts (state_hash, provider, verifier_envelope, nonce, expires_at)
        VALUES (?, ?, ?, ?, ?)`).run(
        attempt.stateHash,
        attempt.provider,
        attempt.verifierEnvelope,
        attempt.nonce,
        attempt.expiresAt,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function consumeOAuthAttempt(provider: Provider, stateHash: string, now = new Date().toISOString()): OAuthAttempt | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`SELECT state_hash, provider, verifier_envelope, nonce, expires_at
        FROM provider_oauth_attempts WHERE state_hash=? AND provider=?`).get(stateHash, provider) as Record<string, unknown> | undefined;
      db.prepare('DELETE FROM provider_oauth_attempts WHERE state_hash=? AND provider=?').run(stateHash, provider);
      db.prepare('DELETE FROM provider_oauth_attempts WHERE expires_at <= ?').run(now);
      db.exec('COMMIT');
      if (
        !row || !isProvider(row.provider) || typeof row.state_hash !== 'string' ||
        typeof row.verifier_envelope !== 'string' || typeof row.expires_at !== 'string' ||
        row.expires_at <= now
      ) return null;
      return {
        provider: row.provider,
        stateHash: row.state_hash,
        verifierEnvelope: row.verifier_envelope,
        nonce: stringOrNull(row.nonce),
        expiresAt: row.expires_at,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getSyncSummary(provider: Provider): SyncSummary {
    const row = db.prepare('SELECT * FROM provider_sync_state WHERE provider=?').get(provider) as Record<string, unknown> | undefined;
    return rowToSync(row, provider);
  }

  function setSyncState(provider: Provider, state: ProviderSyncState, lastError: string | null = null): void {
    const now = new Date().toISOString();
    const previous = getSyncSummary(provider);
    const startedAt = state === 'syncing' ? now : previous.startedAt;
    const completedAt = state === 'syncing' ? previous.completedAt : now;
    db.prepare(`INSERT INTO provider_sync_state (provider, state, started_at, completed_at, record_count, last_error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        state=excluded.state, started_at=excluded.started_at, completed_at=excluded.completed_at,
        record_count=excluded.record_count, last_error=excluded.last_error`).run(
      provider, state, startedAt, completedAt, previous.recordCount, lastError,
    );
  }

  function replaceProviderRecords(provider: Provider, records: ImportedRecord[]): number {
    const marker = randomUUID();
    const now = new Date().toISOString();
    const upsert = db.prepare(`INSERT INTO provider_records (
      provider, kind, container_id, container_name, external_id, title, status,
      starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at,
      source_url, source_time_zone, imported_at, sync_marker, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(provider, kind, container_id, external_id) DO UPDATE SET
      container_name=excluded.container_name, title=excluded.title, status=excluded.status,
      starts_at=excluded.starts_at, ends_at=excluded.ends_at,
      starts_on=excluded.starts_on, ends_on=excluded.ends_on, all_day=excluded.all_day,
      due_on=excluded.due_on, completed_at=excluded.completed_at,
      source_updated_at=excluded.source_updated_at, source_url=excluded.source_url,
      source_time_zone=excluded.source_time_zone, imported_at=excluded.imported_at,
      sync_marker=excluded.sync_marker, deleted_at=NULL`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        upsert.run(
          record.provider, record.kind, record.containerId, record.containerName,
          record.externalId, record.title, record.status, record.startsAt, record.endsAt,
          record.startsOn, record.endsOn, record.allDay ? 1 : 0, record.dueOn,
          record.completedAt, record.sourceUpdatedAt,
          record.sourceUrl, record.sourceTimeZone, now, marker,
        );
      }
      // Each provider read is a complete rolling snapshot. Retain only records
      // still returned by that snapshot, rather than building a hidden archive
      // of calendar context that has aged out of the requested window.
      db.prepare('DELETE FROM provider_records WHERE provider=? AND sync_marker != ?').run(provider, marker);
      db.prepare(`INSERT INTO provider_sync_state (provider, state, started_at, completed_at, record_count, last_error)
        VALUES (?, 'idle', ?, ?, ?, NULL)
        ON CONFLICT(provider) DO UPDATE SET
          state='idle', completed_at=excluded.completed_at, record_count=excluded.record_count, last_error=NULL`)
        .run(provider, now, now, records.length);
      db.prepare(`UPDATE provider_connections SET last_synced_at=?, last_error=NULL, updated_at=?
        WHERE provider=?`).run(now, now, provider);
      db.exec('COMMIT');
      return records.length;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function clearProviderRecords(provider: Provider): void {
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM provider_records WHERE provider=?').run(provider);
      db.prepare(`INSERT INTO provider_sync_state (provider, state, started_at, completed_at, record_count, last_error)
        VALUES (?, 'idle', NULL, ?, 0, NULL)
        ON CONFLICT(provider) DO UPDATE SET
          state='idle', started_at=NULL, completed_at=excluded.completed_at, record_count=0, last_error=NULL`)
        .run(provider, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function listProviderRecords(limit = 300): StoredRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const query = db.prepare(`SELECT id, provider, kind, container_id, container_name, external_id, title, status,
      starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at, source_url,
      source_time_zone, imported_at
      FROM provider_records WHERE deleted_at IS NULL AND kind=?
      ORDER BY COALESCE(starts_at, due_on, source_updated_at, imported_at), title COLLATE NOCASE
      LIMIT ?`);
    const rows = [
      ...query.all('calendar_event', safeLimit),
      ...query.all('task', safeLimit),
    ] as Record<string, unknown>[];
    return rows.flatMap(row => {
      const record = rowToRecord(row);
      return record ? [record] : [];
    });
  }

  function savePushSubscription(subscription: StoredPushSubscription, userAgent: string | null): void {
    db.prepare(`INSERT INTO push_subscriptions (endpoint, subscription_json, user_agent, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        subscription_json=excluded.subscription_json, user_agent=excluded.user_agent`)
      .run(subscription.endpoint, JSON.stringify(subscription), userAgent, new Date().toISOString());
  }

  function listPushSubscriptions(): PushSubscriptionRecord[] {
    const rows = db.prepare(`SELECT subscription_json, user_agent, created_at
      FROM push_subscriptions ORDER BY created_at`).all() as Record<string, unknown>[];
    return rows.flatMap(row => {
      if (typeof row.subscription_json !== 'string' || typeof row.created_at !== 'string') return [];
      try {
        const subscription: unknown = JSON.parse(row.subscription_json);
        return isPushSubscription(subscription)
          ? [{ subscription, userAgent: stringOrNull(row.user_agent), createdAt: row.created_at }]
          : [];
      } catch {
        return [];
      }
    });
  }

  function deletePushSubscription(endpoint: string): boolean {
    return db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint).changes === 1;
  }

  // Per-subscription state lets a failed device retry without duplicating a successful one.
  function listPushDeliveries(): StoredPushDelivery[] {
    const rows = db.prepare(`SELECT delivery_key, endpoint FROM push_subscription_deliveries
      ORDER BY delivery_key, endpoint`).all() as Record<string, unknown>[];
    return rows.flatMap(row => typeof row.delivery_key === 'string' && typeof row.endpoint === 'string'
      ? [{ deliveryKey: row.delivery_key, endpoint: row.endpoint }]
      : []);
  }

  function markPushDelivered(key: string, endpoint: string): void {
    db.prepare(`INSERT OR IGNORE INTO push_subscription_deliveries (delivery_key, endpoint, fired_at)
      VALUES (?, ?, ?)`).run(key, endpoint, new Date().toISOString());
  }

  function prunePushDeliveries(keepKeys: string[]): void {
    const keep = new Set(keepKeys);
    db.exec('BEGIN');
    try {
      for (const delivery of listPushDeliveries()) {
        if (!keep.has(delivery.deliveryKey)) {
          db.prepare('DELETE FROM push_subscription_deliveries WHERE delivery_key=? AND endpoint=?')
            .run(delivery.deliveryKey, delivery.endpoint);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    read,
    save,
    getConnection,
    listConnections,
    saveConnection,
    markConnectionNeedsReconnect,
    createOAuthAttempt,
    consumeOAuthAttempt,
    getSyncSummary,
    setSyncState,
    replaceProviderRecords,
    clearProviderRecords,
    listProviderRecords,
    savePushSubscription,
    listPushSubscriptions,
    deletePushSubscription,
    listPushDeliveries,
    markPushDelivered,
    prunePushDeliveries,
    close: () => db.close(),
  };
}

export type Store = ReturnType<typeof openStore>;
