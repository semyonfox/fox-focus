import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  areas,
  createInitialData,
  isInboxItem,
  isPrototypeData,
  isTask,
  type InboxItem,
  type PrototypeData,
  type Task,
} from '../src/model.ts';
import { hermesStatuses } from '../src/hermes-model.ts';
import type {
  HermesFeed,
  HermesMirrorSnapshot,
  HermesStatus,
  HermesTask,
  HermesTaskAnnotationInput,
} from '../src/hermes-model.ts';
import { isPushSubscription, type StoredPushDelivery, type StoredPushSubscription } from './push.ts';
import { createRowStore, initializeRowStore } from './row-store.ts';

export type Snapshot = { revision: number; data: PrototypeData };
export type Provider = 'google' | 'microsoft';
export type ProviderConnectionState = 'connected' | 'needs_reconnect';
export type ProviderRecordKind = 'calendar_event' | 'task';
export type ProviderSyncState = 'idle' | 'syncing' | 'failed';

export type ConnectionSummary = {
  provider: Provider;
  connectionId: string;
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
  sourceVersion?: string | null;
  connectionId?: string | null;
  completionWritable?: boolean;
  notes?: string | null;
  parentId?: string | null;
  position?: string | null;
  sourceUrl: string | null;
  sourceTimeZone: string | null;
};

export type StoredRecord = ImportedRecord & {
  id: number;
  importedAt: string;
  sourceVersion: string | null;
  connectionId: string | null;
  completionWritable: boolean;
};

export type TaskActionState = 'open' | 'completed';
export type TaskActionStatus = 'awaiting_approval' | 'running' | 'succeeded' | 'failed' | 'conflict';
export const TASK_ACTION_LEASE_MS = 2 * 60_000;

export type TaskActionRequest = {
  id: string;
  idempotencyKey: string;
  taskId: string;
  provider: 'google';
  connectionId: string;
  containerId: string;
  externalId: string;
  desiredState: TaskActionState;
  expectedVersion: string | null;
  workspaceRevision: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  status: TaskActionStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  finishedAt: string | null;
  attemptCount: number;
  leaseExpiresAt: string | null;
  result: Record<string, unknown> | null;
  lastError: string | null;
};

export type TaskAdoptionSource = 'google' | 'microsoft' | 'hermes';
export type TaskAdoptionStatus = 'awaiting_approval' | 'approved' | 'expired';

export type TaskAdoptionRequest = {
  id: string;
  source: TaskAdoptionSource;
  externalId: string;
  containerId: string;
  workspaceRevision: number;
  before: Record<string, unknown>;
  task: Task;
  status: TaskAdoptionStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  adoptedTaskId: string | null;
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

export type HermesActionRecord = {
  id: string;
  taskId: string;
  idempotencyKey: string;
  expectedVersion: number;
  approvalSummary: string;
  beforeStatus: HermesStatus;
  afterStatus: 'done';
  approvedAt: string;
  state: 'pending' | 'succeeded' | 'failed' | 'readback_failed';
};

export type BeginHermesCompletionResult =
  | { outcome: 'ready'; value: { task: HermesTask; action: HermesActionRecord } }
  | { outcome: 'not_found' }
  | { outcome: 'already_done'; task: HermesTask }
  | { outcome: 'conflict'; task: HermesTask };

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
    !row || !isProvider(row.provider) || typeof row.connection_id !== 'string' ||
    !connectionStates.has(row.state as ProviderConnectionState) ||
    typeof row.connected_at !== 'string' || typeof row.updated_at !== 'string'
  ) return null;

  return {
    provider: row.provider,
    connectionId: row.connection_id,
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
    sourceVersion: stringOrNull(row.source_version),
    connectionId: stringOrNull(row.connection_id),
    completionWritable: booleanFromInteger(row.completion_writable),
    notes: stringOrNull(row.notes),
    parentId: stringOrNull(row.parent_id),
    position: stringOrNull(row.position),
    sourceUrl: stringOrNull(row.source_url),
    sourceTimeZone: stringOrNull(row.source_time_zone),
    importedAt: row.imported_at,
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function rowToTaskAction(row: Record<string, unknown> | undefined): TaskActionRequest | null {
  const before = jsonRecord(row?.before_json);
  const after = jsonRecord(row?.after_json);
  const result = row?.result_json === null ? null : jsonRecord(row?.result_json);
  if (
    !row || typeof row.id !== 'string' || typeof row.idempotency_key !== 'string' ||
    typeof row.task_id !== 'string' || row.provider !== 'google' || typeof row.connection_id !== 'string' ||
    typeof row.container_id !== 'string' || typeof row.external_id !== 'string' ||
    (row.desired_state !== 'open' && row.desired_state !== 'completed') ||
    !['awaiting_approval', 'running', 'succeeded', 'failed', 'conflict'].includes(String(row.status)) ||
    typeof row.created_at !== 'string' || typeof row.expires_at !== 'string' ||
    typeof row.workspace_revision !== 'number' || typeof row.attempt_count !== 'number' || !before || !after
  ) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    provider: 'google',
    connectionId: row.connection_id,
    containerId: row.container_id,
    externalId: row.external_id,
    desiredState: row.desired_state,
    expectedVersion: stringOrNull(row.expected_version),
    workspaceRevision: row.workspace_revision,
    before,
    after,
    status: row.status as TaskActionStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: stringOrNull(row.approved_at),
    finishedAt: stringOrNull(row.finished_at),
    attemptCount: row.attempt_count,
    leaseExpiresAt: stringOrNull(row.lease_expires_at),
    result,
    lastError: stringOrNull(row.last_error),
  };
}

function rowToTaskAdoption(row: Record<string, unknown> | undefined): TaskAdoptionRequest | null {
  const before = jsonRecord(row?.before_json);
  let task: unknown;
  try { task = typeof row?.task_json === 'string' ? JSON.parse(row.task_json) : null; } catch { task = null; }
  if (
    !row || typeof row.id !== 'string' ||
    !['google', 'microsoft', 'hermes'].includes(String(row.source)) ||
    typeof row.external_id !== 'string' || typeof row.container_id !== 'string' ||
    !['awaiting_approval', 'approved', 'expired'].includes(String(row.status)) ||
    typeof row.created_at !== 'string' || typeof row.expires_at !== 'string' || typeof row.workspace_revision !== 'number' ||
    !before || !isTask(task)
  ) return null;
  return {
    id: row.id,
    source: row.source as TaskAdoptionSource,
    externalId: row.external_id,
    containerId: row.container_id,
    workspaceRevision: row.workspace_revision,
    before,
    task,
    status: row.status as TaskAdoptionStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: stringOrNull(row.approved_at),
    adoptedTaskId: stringOrNull(row.adopted_task_id),
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

function rowToHermesTask(row: Record<string, unknown>): HermesTask | null {
  if (
    typeof row.task_id !== 'string' || typeof row.title !== 'string' ||
    typeof row.remote_status !== 'string' || !hermesStatuses.includes(row.remote_status as HermesStatus) ||
    typeof row.priority !== 'number' || typeof row.owner !== 'string' ||
    !['human', 'agent', 'unassigned'].includes(row.owner) ||
    typeof row.source_label !== 'string' || typeof row.remote_created_at !== 'string' ||
    typeof row.remote_updated_at !== 'string' ||
    typeof row.remote_version !== 'number' || typeof row.area !== 'string' ||
    !areas.includes(row.area as (typeof areas)[number]) || typeof row.local_state !== 'string' ||
    !['up-next', 'scheduled', 'waiting'].includes(row.local_state) ||
    typeof row.duration !== 'string' || typeof row.due !== 'string' ||
    typeof row.reminder_mode !== 'string' || !['none', 'one-hour', 'morning'].includes(row.reminder_mode)
  ) return null;

  const sourceProvider = row.source_provider === 'google' ? 'google' : null;
  return {
    id: row.task_id,
    title: row.title,
    status: row.remote_status as HermesStatus,
    priority: row.priority,
    createdAt: row.remote_created_at,
    updatedAt: row.remote_updated_at,
    version: row.remote_version,
    owner: row.owner as HermesTask['owner'],
    source: row.source_label,
    parentTitle: stringOrNull(row.parent_title),
    sourceProvider,
    sourceExternalId: sourceProvider ? stringOrNull(row.source_external_id) : null,
    sourceDueOn: stringOrNull(row.source_due_on),
    sourceStatus: stringOrNull(row.source_status),
    sourceContainerId: stringOrNull(row.source_container_id),
    sourceContainerName: stringOrNull(row.source_container_name),
    sourceMatchUnique: row.source_match_unique === 1,
    area: row.area as HermesTask['area'],
    localState: row.local_state as HermesTask['localState'],
    duration: row.duration,
    due: row.due,
    scheduledAt: stringOrNull(row.scheduled_at),
    reminderMode: row.reminder_mode as HermesTask['reminderMode'],
    reminderFireAt: stringOrNull(row.reminder_fire_at),
    annotationUpdatedAt: stringOrNull(row.annotation_updated_at),
  };
}

// The workspace document is the native task store. Provider records live in
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
      connection_id TEXT NOT NULL,
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
      connection_id TEXT,
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
      source_version TEXT,
      completion_writable INTEGER NOT NULL DEFAULT 0 CHECK(completion_writable IN (0, 1)),
      source_url TEXT,
      source_time_zone TEXT,
      notes TEXT,
      parent_id TEXT,
      position TEXT,
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
    CREATE TABLE IF NOT EXISTS hermes_sync_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      state TEXT NOT NULL CHECK(state IN ('connected', 'stale', 'unavailable')),
      checked_at TEXT NOT NULL,
      last_successful_at TEXT,
      board_slug TEXT,
      board_name TEXT,
      total INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS hermes_task_mirrors (
      task_id TEXT PRIMARY KEY,
      board_slug TEXT NOT NULL,
      title TEXT NOT NULL,
      remote_status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      owner TEXT NOT NULL,
      source_label TEXT NOT NULL,
      parent_title TEXT,
      remote_created_at TEXT NOT NULL,
      remote_updated_at TEXT NOT NULL,
      remote_version INTEGER NOT NULL,
      source_provider TEXT,
      source_external_id TEXT,
      sync_marker TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hermes_task_source_identity
      ON hermes_task_mirrors(source_provider, source_external_id)
      WHERE source_provider IS NOT NULL AND source_external_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS hermes_task_annotations (
      task_id TEXT PRIMARY KEY,
      area TEXT NOT NULL CHECK(area IN ('University', 'Work', 'Personal', 'Health', 'Admin')),
      local_state TEXT NOT NULL CHECK(local_state IN ('up-next', 'scheduled', 'waiting')),
      duration TEXT NOT NULL,
      due TEXT NOT NULL,
      scheduled_at TEXT,
      reminder_mode TEXT NOT NULL CHECK(reminder_mode IN ('none', 'one-hour', 'morning')),
      reminder_fire_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hermes_actions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      expected_version INTEGER NOT NULL,
      approval_summary TEXT NOT NULL,
      before_json TEXT NOT NULL CHECK(json_valid(before_json)),
      after_json TEXT NOT NULL CHECK(json_valid(after_json)),
      approved_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'succeeded', 'failed', 'readback_failed')),
      response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
      error_code TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hermes_actions_task ON hermes_actions(task_id, approved_at DESC);
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
      ON push_subscription_deliveries(endpoint);
    CREATE TABLE IF NOT EXISTS task_action_requests (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider = 'google'),
      connection_id TEXT NOT NULL,
      container_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      desired_state TEXT NOT NULL CHECK(desired_state IN ('open', 'completed')),
      expected_version TEXT,
      workspace_revision INTEGER NOT NULL,
      before_json TEXT NOT NULL CHECK(json_valid(before_json)),
      after_json TEXT NOT NULL CHECK(json_valid(after_json)),
      status TEXT NOT NULL CHECK(status IN ('awaiting_approval', 'running', 'succeeded', 'failed', 'conflict')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      finished_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS task_action_requests_task ON task_action_requests(task_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS task_adoption_requests (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(source IN ('google', 'microsoft', 'hermes')),
      external_id TEXT NOT NULL,
      container_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      before_json TEXT NOT NULL CHECK(json_valid(before_json)),
      task_json TEXT NOT NULL CHECK(json_valid(task_json)),
      status TEXT NOT NULL CHECK(status IN ('awaiting_approval', 'approved', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      adopted_task_id TEXT
    );
    CREATE INDEX IF NOT EXISTS task_adoption_requests_source ON task_adoption_requests(source, container_id, external_id);
    CREATE TABLE IF NOT EXISTS agent_proposals (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      inbox_item_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
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
  if (!recordColumns.has('source_version')) db.exec('ALTER TABLE provider_records ADD COLUMN source_version TEXT');
  if (!recordColumns.has('connection_id')) db.exec('ALTER TABLE provider_records ADD COLUMN connection_id TEXT');
  if (!recordColumns.has('completion_writable')) db.exec('ALTER TABLE provider_records ADD COLUMN completion_writable INTEGER NOT NULL DEFAULT 0');
  if (!recordColumns.has('notes')) db.exec('ALTER TABLE provider_records ADD COLUMN notes TEXT');
  if (!recordColumns.has('parent_id')) db.exec('ALTER TABLE provider_records ADD COLUMN parent_id TEXT');
  if (!recordColumns.has('position')) db.exec('ALTER TABLE provider_records ADD COLUMN position TEXT');
  const connectionColumns = new Set((db.prepare('PRAGMA table_info(provider_connections)').all() as Record<string, unknown>[])
    .flatMap(column => typeof column.name === 'string' ? [column.name] : []));
  if (!connectionColumns.has('connection_id')) db.exec('ALTER TABLE provider_connections ADD COLUMN connection_id TEXT');
  const connectionsWithoutGeneration = db.prepare('SELECT provider FROM provider_connections WHERE connection_id IS NULL OR connection_id = ?')
    .all('') as Record<string, unknown>[];
  for (const row of connectionsWithoutGeneration) {
    if (isProvider(row.provider)) db.prepare('UPDATE provider_connections SET connection_id=? WHERE provider=?').run(randomUUID(), row.provider);
  }
  const actionColumns = new Set((db.prepare('PRAGMA table_info(task_action_requests)').all() as Record<string, unknown>[])
    .flatMap(column => typeof column.name === 'string' ? [column.name] : []));
  if (!actionColumns.has('connection_id')) db.exec("ALTER TABLE task_action_requests ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'legacy'");
  if (!actionColumns.has('workspace_revision')) db.exec('ALTER TABLE task_action_requests ADD COLUMN workspace_revision INTEGER NOT NULL DEFAULT 0');
  if (!actionColumns.has('lease_expires_at')) db.exec('ALTER TABLE task_action_requests ADD COLUMN lease_expires_at TEXT');
  const adoptionColumns = new Set((db.prepare('PRAGMA table_info(task_adoption_requests)').all() as Record<string, unknown>[])
    .flatMap(column => typeof column.name === 'string' ? [column.name] : []));
  if (!adoptionColumns.has('workspace_revision')) db.exec('ALTER TABLE task_adoption_requests ADD COLUMN workspace_revision INTEGER NOT NULL DEFAULT 0');
  if (!adoptionColumns.has('adopted_task_id')) db.exec('ALTER TABLE task_adoption_requests ADD COLUMN adopted_task_id TEXT');
  const proposalColumns = new Set((db.prepare('PRAGMA table_info(agent_proposals)').all() as Record<string, unknown>[])
    .flatMap(column => typeof column.name === 'string' ? [column.name] : []));
  if (!proposalColumns.has('request_hash')) db.exec("ALTER TABLE agent_proposals ADD COLUMN request_hash TEXT NOT NULL DEFAULT 'legacy'");
  if (previousSchemaVersion < 7) db.exec('PRAGMA user_version=7;');
  db.prepare('INSERT OR IGNORE INTO workspace VALUES (1, 0, ?, ?)')
    .run(JSON.stringify(initialData), new Date().toISOString());
  const workspaceForMigration = db.prepare('SELECT data FROM workspace WHERE id=1').get() as Record<string, unknown> | undefined;
  const parsedWorkspace: unknown = typeof workspaceForMigration?.data === 'string'
    ? JSON.parse(workspaceForMigration.data)
    : null;
  if (!isPrototypeData(parsedWorkspace)) throw new Error('Invalid stored workspace');
  initializeRowStore(db, previousSchemaVersion, parsedWorkspace);
  const rows = createRowStore(db);

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
      provider, connection_id, state, scopes, token_envelope, connected_at, updated_at, last_synced_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      connection_id=excluded.connection_id, state=excluded.state, scopes=excluded.scopes, token_envelope=excluded.token_envelope,
      updated_at=excluded.updated_at, last_synced_at=excluded.last_synced_at, last_error=excluded.last_error`)
      .run(
        connection.provider,
        connection.connectionId,
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
      provider, connection_id, kind, container_id, container_name, external_id, title, status,
      starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at, source_version,
      completion_writable, source_url, source_time_zone, imported_at, sync_marker, deleted_at,
      notes, parent_id, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(provider, kind, container_id, external_id) DO UPDATE SET
      connection_id=excluded.connection_id, container_name=excluded.container_name, title=excluded.title, status=excluded.status,
      starts_at=excluded.starts_at, ends_at=excluded.ends_at,
      starts_on=excluded.starts_on, ends_on=excluded.ends_on, all_day=excluded.all_day,
      due_on=excluded.due_on, completed_at=excluded.completed_at,
      source_updated_at=excluded.source_updated_at, source_version=excluded.source_version,
      completion_writable=excluded.completion_writable, source_url=excluded.source_url,
      source_time_zone=excluded.source_time_zone, imported_at=excluded.imported_at,
      sync_marker=excluded.sync_marker, deleted_at=NULL,
      notes=excluded.notes, parent_id=excluded.parent_id, position=excluded.position`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        upsert.run(
          record.provider, record.connectionId ?? null, record.kind, record.containerId, record.containerName,
          record.externalId, record.title, record.status, record.startsAt, record.endsAt,
          record.startsOn, record.endsOn, record.allDay ? 1 : 0, record.dueOn,
          record.completedAt, record.sourceUpdatedAt, record.sourceVersion ?? null,
          (record.completionWritable ?? (record.provider === 'google' && record.kind === 'task')) ? 1 : 0,
          record.sourceUrl, record.sourceTimeZone, now, marker,
          record.notes ?? null, record.parentId ?? null, record.position ?? null,
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

  function listProviderRecords(limit = 1000, kind?: ProviderRecordKind): StoredRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 5_000));
    const query = db.prepare(`SELECT id, provider, connection_id, kind, container_id, container_name, external_id, title, status,
      starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at, source_version,
      completion_writable, source_url, source_time_zone, imported_at
      FROM provider_records WHERE deleted_at IS NULL AND kind=?
      ORDER BY COALESCE(starts_at, due_on, source_updated_at, imported_at), title COLLATE NOCASE
      LIMIT ?`);
    const rows = (kind
      ? query.all(kind, safeLimit)
      : [...query.all('calendar_event', safeLimit), ...query.all('task', safeLimit)]) as Record<string, unknown>[];
    return rows.flatMap(row => {
      const record = rowToRecord(row);
      return record ? [record] : [];
    });
  }

  const hermesTaskSelect = `SELECT
      mirror.task_id, mirror.title, mirror.remote_status, mirror.priority, mirror.owner,
      mirror.source_label, mirror.parent_title, mirror.remote_created_at,
      mirror.remote_updated_at, mirror.remote_version,
      mirror.source_provider, mirror.source_external_id,
      COALESCE(annotation.area, 'Personal') AS area,
      COALESCE(annotation.local_state,
        CASE mirror.remote_status WHEN 'blocked' THEN 'waiting' ELSE 'up-next' END) AS local_state,
      COALESCE(annotation.duration, '30 min') AS duration,
      COALESCE(annotation.due, 'No deadline') AS due,
      annotation.scheduled_at, COALESCE(annotation.reminder_mode, 'none') AS reminder_mode,
      annotation.reminder_fire_at, annotation.updated_at AS annotation_updated_at,
      provider.due_on AS source_due_on, provider.status AS source_status,
      provider.container_id AS source_container_id,
      provider.container_name AS source_container_name,
      CASE WHEN provider.id IS NULL THEN 0 ELSE 1 END AS source_match_unique
    FROM hermes_task_mirrors mirror
    LEFT JOIN hermes_task_annotations annotation ON annotation.task_id=mirror.task_id
    LEFT JOIN provider_records provider ON provider.id=(
      SELECT CASE
        WHEN COUNT(*)=1 THEN MIN(candidate.id)
        WHEN SUM(CASE WHEN candidate.container_name=mirror.source_label COLLATE NOCASE THEN 1 ELSE 0 END)=1
          THEN MIN(CASE WHEN candidate.container_name=mirror.source_label COLLATE NOCASE THEN candidate.id END)
        ELSE NULL
      END
      FROM provider_records candidate
      WHERE candidate.deleted_at IS NULL AND candidate.kind='task'
        AND candidate.provider=mirror.source_provider
        AND candidate.external_id=mirror.source_external_id
    )`;

  function replaceHermesTasks(snapshot: HermesMirrorSnapshot): number {
    const marker = randomUUID();
    const nextState = snapshot.complete ? 'connected' : 'stale';
    const upsert = db.prepare(`INSERT INTO hermes_task_mirrors (
      task_id, board_slug, title, remote_status, priority, owner, source_label,
      parent_title, remote_created_at, remote_updated_at, remote_version, source_provider,
      source_external_id, sync_marker, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      board_slug=excluded.board_slug, title=excluded.title,
      remote_status=excluded.remote_status, priority=excluded.priority,
      owner=excluded.owner, source_label=excluded.source_label,
      parent_title=excluded.parent_title, remote_created_at=excluded.remote_created_at,
      remote_updated_at=excluded.remote_updated_at,
      remote_version=excluded.remote_version, source_provider=excluded.source_provider,
      source_external_id=excluded.source_external_id,
      sync_marker=excluded.sync_marker, last_seen_at=excluded.last_seen_at`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const task of snapshot.board.tasks) {
        upsert.run(
          task.id, snapshot.board.slug, task.title, task.status, task.priority, task.owner,
          task.source, task.parentTitle, task.createdAt, task.updatedAt, task.version, task.sourceProvider,
          task.sourceExternalId, marker, snapshot.checkedAt,
        );
      }
      // A failed or bounded read must never erase mirrors that the snapshot did
      // not have a chance to observe.
      if (snapshot.complete) {
        db.prepare('DELETE FROM hermes_task_mirrors WHERE board_slug=? AND sync_marker != ?')
          .run(snapshot.board.slug, marker);
      }
      db.prepare(`INSERT INTO hermes_sync_state
        (id, state, checked_at, last_successful_at, board_slug, board_name, total)
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state, checked_at=excluded.checked_at,
          last_successful_at=CASE WHEN excluded.state='connected'
            THEN excluded.last_successful_at ELSE hermes_sync_state.last_successful_at END,
          board_slug=excluded.board_slug,
          board_name=excluded.board_name, total=excluded.total`)
        .run(
          nextState,
          snapshot.checkedAt,
          snapshot.complete ? snapshot.checkedAt : null,
          snapshot.board.slug,
          snapshot.board.name,
          snapshot.board.total,
        );
      db.exec('COMMIT');
      return snapshot.board.tasks.length;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function markHermesUnavailable(checkedAt: string): void {
    db.prepare(`INSERT INTO hermes_sync_state
      (id, state, checked_at, last_successful_at, board_slug, board_name, total)
      VALUES (1, 'unavailable', ?, NULL, NULL, NULL, 0)
      ON CONFLICT(id) DO UPDATE SET
        state=CASE WHEN hermes_sync_state.board_slug IS NULL THEN 'unavailable' ELSE 'stale' END,
        checked_at=excluded.checked_at`)
      .run(checkedAt);
  }

  function getHermesTask(taskId: string): HermesTask | null {
    const row = db.prepare(`${hermesTaskSelect} WHERE mirror.task_id=?`).get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToHermesTask(row) : null;
  }

  function readHermesFeed(): HermesFeed {
    const state = db.prepare('SELECT * FROM hermes_sync_state WHERE id=1').get() as Record<string, unknown> | undefined;
    const checkedAt = typeof state?.checked_at === 'string' ? state.checked_at : new Date(0).toISOString();
    if (!state || (state.state !== 'connected' && state.state !== 'stale') || typeof state.board_slug !== 'string' ||
      typeof state.board_name !== 'string' || typeof state.total !== 'number') {
      return { state: 'unavailable', checkedAt, board: null };
    }
    const rows = db.prepare(`${hermesTaskSelect}
      WHERE mirror.board_slug=?
      ORDER BY CASE mirror.remote_status
        WHEN 'running' THEN 0 WHEN 'blocked' THEN 1 WHEN 'review' THEN 2
        WHEN 'ready' THEN 3 WHEN 'todo' THEN 4 WHEN 'triage' THEN 5
        WHEN 'scheduled' THEN 6 ELSE 7 END,
        mirror.priority DESC, mirror.remote_updated_at DESC, mirror.task_id`)
      .all(state.board_slug) as Record<string, unknown>[];
    const tasks = rows.flatMap(row => {
      const task = rowToHermesTask(row);
      return task ? [task] : [];
    });
    const board = {
      slug: state.board_slug,
      name: state.board_name,
      total: state.total,
      tasks,
      sources: [...new Set(tasks.map(task => task.source))].sort((first, second) => first.localeCompare(second)),
    };
    if (state.state === 'stale') return {
      state: 'stale',
      checkedAt,
      lastSuccessfulAt: typeof state.last_successful_at === 'string' ? state.last_successful_at : checkedAt,
      board,
    };
    return { state: 'connected', checkedAt, board };
  }

  function updateHermesTaskAnnotation(taskId: string, annotation: HermesTaskAnnotationInput): HermesTask | null {
    if (!getHermesTask(taskId)) return null;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO hermes_task_annotations (
      task_id, area, local_state, duration, due, scheduled_at,
      reminder_mode, reminder_fire_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET area=excluded.area, local_state=excluded.local_state,
      duration=excluded.duration, due=excluded.due, scheduled_at=excluded.scheduled_at,
      reminder_mode=excluded.reminder_mode, reminder_fire_at=excluded.reminder_fire_at,
      updated_at=excluded.updated_at`).run(
      taskId, annotation.area, annotation.scheduledAt ? 'scheduled' : annotation.localState,
      annotation.duration, annotation.due, annotation.scheduledAt,
      annotation.reminderMode, annotation.reminderFireAt, now,
    );
    return getHermesTask(taskId);
  }

  function listHermesReminders(includeStale = false) {
    const feed = readHermesFeed();
    if (feed.state === 'unavailable' || (feed.state === 'stale' && !includeStale)) return [];
    return feed.board.tasks.flatMap(task => task.status !== 'done' && task.reminderMode !== 'none'
      ? [{
          id: `reminder-hermes-${task.id}`,
          targetId: `hermes:${task.id}`,
          targetType: 'task' as const,
          title: task.title,
          mode: task.reminderMode as Exclude<typeof task.reminderMode, 'none'>,
          when: task.reminderMode === 'one-hour' ? '1 hour before' : '09:00 on the day',
          state: 'scheduled' as const,
          ...(task.reminderFireAt ? { fireAt: task.reminderFireAt } : {}),
        }]
      : []);
  }

  function beginHermesCompletion(
    taskId: string,
    expectedVersion: number,
    beforeStatus: HermesStatus,
    confirmedAt: string,
  ): BeginHermesCompletionResult {
    db.exec('BEGIN IMMEDIATE');
    try {
      const task = getHermesTask(taskId);
      if (!task) { db.exec('ROLLBACK'); return { outcome: 'not_found' }; }
      if (task.status === 'done') { db.exec('ROLLBACK'); return { outcome: 'already_done', task }; }
      if (task.version !== expectedVersion || task.status !== beforeStatus) {
        db.exec('ROLLBACK');
        return { outcome: 'conflict', task };
      }
      const idempotencyKey = `fox-focus:personal-tasks:${taskId}:complete:${expectedVersion}`;
      const existing = db.prepare('SELECT * FROM hermes_actions WHERE idempotency_key=?')
        .get(idempotencyKey) as Record<string, unknown> | undefined;
      const id = typeof existing?.id === 'string' ? existing.id : randomUUID();
      const approvedAt = typeof existing?.approved_at === 'string' ? existing.approved_at : confirmedAt;
      const summary = `Complete "${task.title}" in Hermes personal-tasks: status ${task.status} -> done.`;
      const before = JSON.stringify({ taskId, title: task.title, status: task.status, version: task.version });
      const after = JSON.stringify({ taskId, title: task.title, status: 'done' });
      db.prepare(`INSERT INTO hermes_actions (
        id, task_id, idempotency_key, expected_version, approval_summary,
        before_json, after_json, approved_at, state, response_json, error_code, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        state=CASE WHEN hermes_actions.state='succeeded' THEN 'succeeded' ELSE 'pending' END,
        error_code=NULL, updated_at=excluded.updated_at`)
        .run(id, taskId, idempotencyKey, expectedVersion, summary, before, after, approvedAt, new Date().toISOString());
      db.exec('COMMIT');
      return {
        outcome: 'ready',
        value: {
          task,
          action: {
            id, taskId, idempotencyKey, expectedVersion, approvalSummary: summary,
            beforeStatus: task.status, afterStatus: 'done', approvedAt,
            state: existing?.state === 'succeeded' ? 'succeeded' : 'pending',
          },
        },
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function finishHermesAction(
    id: string,
    state: HermesActionRecord['state'],
    response: unknown = null,
    errorCode: string | null = null,
  ): void {
    db.prepare(`UPDATE hermes_actions
      SET state=?, response_json=?, error_code=?, updated_at=?
      WHERE id=? AND (hermes_actions.state != 'succeeded' OR ?='succeeded')`)
      .run(state, response === null ? null : JSON.stringify(response), errorCode, new Date().toISOString(), id, state);
  }

  function listHermesActions(): HermesActionRecord[] {
    const rows = db.prepare('SELECT * FROM hermes_actions ORDER BY approved_at, id').all() as Record<string, unknown>[];
    return rows.flatMap(row => {
      if (typeof row.id !== 'string' || typeof row.task_id !== 'string' ||
        typeof row.idempotency_key !== 'string' || typeof row.expected_version !== 'number' ||
        typeof row.approval_summary !== 'string' || typeof row.before_json !== 'string' ||
        typeof row.after_json !== 'string' || typeof row.approved_at !== 'string' ||
        !['pending', 'succeeded', 'failed', 'readback_failed'].includes(String(row.state))) return [];
      const before: unknown = JSON.parse(row.before_json);
      if (typeof before !== 'object' || before === null || !('status' in before) ||
        typeof before.status !== 'string' || !hermesStatuses.includes(before.status as HermesStatus)) return [];
      return [{
        id: row.id,
        taskId: row.task_id,
        idempotencyKey: row.idempotency_key,
        expectedVersion: row.expected_version,
        approvalSummary: row.approval_summary,
        beforeStatus: before.status as HermesStatus,
        afterStatus: 'done',
        approvedAt: row.approved_at,
        state: row.state as HermesActionRecord['state'],
      }];
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

  function getProviderRecord(id: number): StoredRecord | null {
    const row = db.prepare(`SELECT id, provider, connection_id, kind, container_id, container_name, external_id, title, status,
      starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at, source_version,
      completion_writable, notes, parent_id, position,
      source_url, source_time_zone, imported_at
      FROM provider_records WHERE id=? AND deleted_at IS NULL`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  function findProviderRecord(
    provider: Provider,
    kind: ProviderRecordKind,
    connectionId: string,
    containerId: string,
    externalId: string,
  ): StoredRecord | null {
    const row = db.prepare(`SELECT id, provider, connection_id, kind, container_id, container_name, external_id, title, status,
      starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at, source_version,
      completion_writable, notes, parent_id, position, source_url, source_time_zone, imported_at
      FROM provider_records WHERE deleted_at IS NULL AND provider=? AND kind=? AND connection_id=? AND container_id=? AND external_id=?`)
      .get(provider, kind, connectionId, containerId, externalId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  function countProviderRecords(provider: Provider, kind: ProviderRecordKind): number {
    const row = db.prepare('SELECT COUNT(*) AS total FROM provider_records WHERE deleted_at IS NULL AND provider=? AND kind=?')
      .get(provider, kind) as Record<string, unknown> | undefined;
    return typeof row?.total === 'number' ? row.total : 0;
  }

  function createTaskAction(request: Omit<TaskActionRequest, 'status' | 'approvedAt' | 'finishedAt' | 'attemptCount' | 'leaseExpiresAt' | 'result' | 'lastError'>): TaskActionRequest {
    const existingRow = db.prepare('SELECT * FROM task_action_requests WHERE idempotency_key=?')
      .get(request.idempotencyKey) as Record<string, unknown> | undefined;
    const existing = rowToTaskAction(existingRow);
    if (existing) return existing;
    db.prepare(`INSERT INTO task_action_requests (
      id, idempotency_key, task_id, provider, connection_id, container_id, external_id, desired_state,
      expected_version, workspace_revision, before_json, after_json, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?)`).run(
      request.id,
      request.idempotencyKey,
      request.taskId,
      request.provider,
      request.connectionId,
      request.containerId,
      request.externalId,
      request.desiredState,
      request.expectedVersion,
      request.workspaceRevision,
      JSON.stringify(request.before),
      JSON.stringify(request.after),
      request.createdAt,
      request.expiresAt,
    );
    const created = getTaskAction(request.id);
    if (!created) throw new Error('Task action request was not stored');
    return created;
  }

  function getTaskAction(id: string): TaskActionRequest | null {
    return rowToTaskAction(db.prepare('SELECT * FROM task_action_requests WHERE id=?').get(id) as Record<string, unknown> | undefined);
  }

  function listTaskActions(taskId?: string, limit = 100): TaskActionRequest[] {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const rows = taskId
      ? db.prepare('SELECT * FROM task_action_requests WHERE task_id=? ORDER BY created_at DESC LIMIT ?').all(taskId, safeLimit)
      : db.prepare('SELECT * FROM task_action_requests ORDER BY created_at DESC LIMIT ?').all(safeLimit);
    return (rows as Record<string, unknown>[]).flatMap(row => {
      const action = rowToTaskAction(row);
      return action ? [action] : [];
    });
  }

  function hasRunningTaskAction(taskId: string, now: string, excludedId?: string): boolean {
    const row = excludedId
      ? db.prepare(`SELECT 1 AS active FROM task_action_requests
          WHERE task_id=? AND id<>? AND status='running' AND (lease_expires_at IS NULL OR lease_expires_at>?) LIMIT 1`)
        .get(taskId, excludedId, now) as Record<string, unknown> | undefined
      : db.prepare(`SELECT 1 AS active FROM task_action_requests
          WHERE task_id=? AND status='running' AND (lease_expires_at IS NULL OR lease_expires_at>?) LIMIT 1`)
        .get(taskId, now) as Record<string, unknown> | undefined;
    return row?.active === 1;
  }

  function beginTaskAction(id: string, now: string, retry = false): {
    outcome: 'started' | 'conflict';
    action: TaskActionRequest;
    snapshot: Snapshot;
  } | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getTaskAction(id);
      const staleRunning = current?.status === 'running' && current.leaseExpiresAt !== null && current.leaseExpiresAt <= now;
      const allowed = current?.status === 'awaiting_approval' || (retry && (current?.status === 'failed' || staleRunning));
      if (!current || !allowed) {
        db.exec('ROLLBACK');
        return null;
      }
      const snapshot = read();
      const rejectPreview = (reason: string) => {
        db.prepare(`UPDATE task_action_requests SET status='conflict', finished_at=?, lease_expires_at=NULL,
          result_json=?, last_error=? WHERE id=?`).run(now, JSON.stringify({ retryable: false }), reason, id);
        db.exec('COMMIT');
        const action = getTaskAction(id);
        if (!action) throw new Error('Task action disappeared');
        return { outcome: 'conflict' as const, action, snapshot: read() };
      };
      if (current.status === 'awaiting_approval' && current.expiresAt <= now) {
        return rejectPreview('The approval preview expired. Create and review a new preview.');
      }
      if (current.status === 'awaiting_approval' && snapshot.revision !== current.workspaceRevision) {
        return rejectPreview('The Fox Focus task changed after this preview. Create and review a new preview.');
      }
      if (hasRunningTaskAction(current.taskId, now, current.id)) {
        return rejectPreview('Another approved update for this task is still running. Wait for it to finish, then review the current state.');
      }
      const task = snapshot.data.tasks.find(candidate => candidate.id === current.taskId);
      const link = task?.externalLinks?.find(candidate =>
        candidate.provider === 'google_tasks' && candidate.policy === 'completion_only' &&
        candidate.connectionId === current.connectionId && candidate.containerId === current.containerId &&
        candidate.externalId === current.externalId);
      const providerRecord = db.prepare(`SELECT id, source_version FROM provider_records
        WHERE provider='google' AND kind='task' AND deleted_at IS NULL AND connection_id=? AND container_id=?
          AND external_id=? AND completion_writable=1`).get(
        current.connectionId, current.containerId, current.externalId,
      ) as Record<string, unknown> | undefined;
      const changedSincePreview = current.status === 'awaiting_approval' &&
        providerRecord?.source_version !== current.expectedVersion;
      if (!task || !link || !providerRecord || changedSincePreview) {
        return rejectPreview(changedSincePreview
          ? 'The imported Google task changed after this preview. Refresh and review a new preview.'
          : 'The exact linked Google task is no longer available. Refresh and review the link.');
      }
      const completed = current.desiredState === 'completed';
      const nextTask: Task = {
        ...task,
        completed,
        state: completed ? 'done' : task.scheduledTime ? 'scheduled' : 'up-next',
        ...(completed ? { completedAt: task.completedAt ?? now } : { completedAt: undefined }),
      };
      const data = {
        ...snapshot.data,
        tasks: snapshot.data.tasks.map(candidate => candidate.id === task.id ? nextTask : candidate),
        reminders: completed
          ? snapshot.data.reminders.filter(reminder => !(reminder.targetType === 'task' && reminder.targetId === task.id))
          : snapshot.data.reminders,
      };
      if (!isPrototypeData(data)) throw new Error('Task action produced an invalid workspace');
      if (task.completed !== completed || data.reminders.length !== snapshot.data.reminders.length) {
        db.prepare('UPDATE workspace SET revision=revision+1, data=?, updated_at=? WHERE id=1')
          .run(JSON.stringify(data), now);
      }
      const leaseExpiresAt = new Date(Date.parse(now) + TASK_ACTION_LEASE_MS).toISOString();
      db.prepare(`UPDATE task_action_requests SET status='running', approved_at=COALESCE(approved_at, ?),
        finished_at=NULL, attempt_count=attempt_count+1, lease_expires_at=?, result_json=NULL, last_error=NULL WHERE id=?`)
        .run(now, leaseExpiresAt, id);
      db.exec('COMMIT');
      const action = getTaskAction(id);
      if (!action) throw new Error('Task action disappeared');
      return { outcome: 'started', action, snapshot: read() };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function finishTaskAction(
    id: string,
    status: Extract<TaskActionStatus, 'succeeded' | 'failed' | 'conflict'>,
    result: Record<string, unknown> | null,
    lastError: string | null,
    now: string,
  ): TaskActionRequest | null {
    db.prepare(`UPDATE task_action_requests SET status=?, finished_at=?, lease_expires_at=NULL, result_json=?, last_error=?
      WHERE id=? AND status='running'`).run(status, now, result ? JSON.stringify(result) : null, lastError, id);
    return getTaskAction(id);
  }

  function updateTaskExternalState(input: {
    taskId: string;
    connectionId: string;
    containerId: string;
    externalId: string;
    sourceStatus: string;
    sourceVersion: string | null;
    sourceUpdatedAt: string | null;
    completedAt: string | null;
    now: string;
  }): Snapshot | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      const snapshot = read();
      const task = snapshot.data.tasks.find(candidate => candidate.id === input.taskId);
      if (!task) {
        db.exec('ROLLBACK');
        return null;
      }
      const links = task.externalLinks?.map(link => link.provider === 'google_tasks' &&
        link.connectionId === input.connectionId && link.containerId === input.containerId && link.externalId === input.externalId
        ? {
            ...link,
            sourceStatus: input.sourceStatus,
            ...(input.sourceVersion ? { sourceVersion: input.sourceVersion } : { sourceVersion: undefined }),
            ...(input.sourceUpdatedAt ? { sourceUpdatedAt: input.sourceUpdatedAt } : { sourceUpdatedAt: undefined }),
          }
        : link);
      const data = {
        ...snapshot.data,
        tasks: snapshot.data.tasks.map(candidate => candidate.id === task.id ? { ...task, externalLinks: links } : candidate),
      };
      if (!isPrototypeData(data)) throw new Error('Provider result produced an invalid workspace');
      db.prepare('UPDATE workspace SET revision=revision+1, data=?, updated_at=? WHERE id=1')
        .run(JSON.stringify(data), input.now);
      db.prepare(`UPDATE provider_records SET status=?, completed_at=?, source_updated_at=?, source_version=?, imported_at=?
        WHERE provider='google' AND kind='task' AND connection_id=? AND container_id=? AND external_id=?`).run(
        input.sourceStatus,
        input.completedAt,
        input.sourceUpdatedAt,
        input.sourceVersion,
        input.now,
        input.connectionId,
        input.containerId,
        input.externalId,
      );
      db.exec('COMMIT');
      return read();
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function createTaskAdoption(request: Omit<TaskAdoptionRequest, 'status' | 'approvedAt' | 'adoptedTaskId'>): TaskAdoptionRequest {
    db.prepare(`INSERT INTO task_adoption_requests (
      id, source, external_id, container_id, workspace_revision, before_json, task_json, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?)`).run(
      request.id,
      request.source,
      request.externalId,
      request.containerId,
      request.workspaceRevision,
      JSON.stringify(request.before),
      JSON.stringify(request.task),
      request.createdAt,
      request.expiresAt,
    );
    const created = getTaskAdoption(request.id);
    if (!created) throw new Error('Task adoption request was not stored');
    return created;
  }

  function getTaskAdoption(id: string): TaskAdoptionRequest | null {
    return rowToTaskAdoption(db.prepare('SELECT * FROM task_adoption_requests WHERE id=?').get(id) as Record<string, unknown> | undefined);
  }

  function approveTaskAdoption(id: string, now: string): { request: TaskAdoptionRequest; snapshot: Snapshot; adoptedTaskId: string } | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      const request = getTaskAdoption(id);
      if (!request || request.status === 'expired' || (request.status === 'awaiting_approval' && request.expiresAt <= now)) {
        if (request?.status === 'awaiting_approval') {
          db.prepare("UPDATE task_adoption_requests SET status='expired' WHERE id=?").run(id);
          db.exec('COMMIT');
        } else {
          db.exec('ROLLBACK');
        }
        return null;
      }
      const snapshot = read();
      if (request.status === 'awaiting_approval' && snapshot.revision !== request.workspaceRevision) {
        db.exec('ROLLBACK');
        return null;
      }
      const requestedProvider = request.source === 'google'
        ? 'google_tasks'
        : request.source === 'microsoft'
          ? 'microsoft_todo'
          : 'hermes';
      const sourceLink = request.task.externalLinks?.find(link =>
        link.provider === requestedProvider && link.containerId === request.containerId && link.externalId === request.externalId);
      const existing = sourceLink ? snapshot.data.tasks.find(task => task.externalLinks?.some(link =>
        link.provider === sourceLink.provider && link.connectionId === sourceLink.connectionId &&
        link.containerId === sourceLink.containerId && link.externalId === sourceLink.externalId)) : undefined;
      const target = snapshot.data.tasks.find(task => task.id === request.task.id);
      if (!existing && request.status === 'awaiting_approval') {
        const tasks = target
          ? snapshot.data.tasks.map(task => task.id === target.id ? request.task : task)
          : [request.task, ...snapshot.data.tasks];
        const data = { ...snapshot.data, tasks };
        if (!isPrototypeData(data)) throw new Error('Task adoption produced an invalid workspace');
        db.prepare('UPDATE workspace SET revision=revision+1, data=?, updated_at=? WHERE id=1')
          .run(JSON.stringify(data), now);
      }
      const adoptedTaskId = request.adoptedTaskId ?? existing?.id ?? request.task.id;
      db.prepare("UPDATE task_adoption_requests SET status='approved', approved_at=COALESCE(approved_at, ?), adopted_task_id=COALESCE(adopted_task_id, ?) WHERE id=?")
        .run(now, adoptedTaskId, id);
      db.exec('COMMIT');
      const approved = getTaskAdoption(id);
      if (!approved) throw new Error('Task adoption disappeared');
      return { request: approved, snapshot: read(), adoptedTaskId };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function findAdoptedTaskId(source: TaskAdoptionSource, connectionId: string | null, containerId: string, externalId: string): string | null {
    const row = db.prepare(`SELECT adopted_task_id FROM task_adoption_requests
      WHERE source=? AND container_id=? AND external_id=? AND status='approved' AND adopted_task_id IS NOT NULL
        AND COALESCE(json_extract(before_json, '$.connectionId'), '')=?
      ORDER BY approved_at DESC LIMIT 1`).get(source, containerId, externalId, connectionId ?? '') as Record<string, unknown> | undefined;
    return stringOrNull(row?.adopted_task_id);
  }

  function addAgentProposal(idempotencyKey: string, requestHash: string, item: InboxItem, now: string): { created: boolean; conflict: boolean; snapshot: Snapshot; inboxItemId: string } {
    if (!isInboxItem(item)) throw new Error('Invalid agent proposal');
    const result = rows.addLegacyProposal(idempotencyKey, requestHash, {
      id: item.id,
      version: 1,
      source: { kind: 'hermes', reference: `proposal:${idempotencyKey}` },
      title: item.title,
      summary: item.summary,
      state: 'open',
      outcome: null,
      taskId: null,
      currentDraftId: null,
      likelyNoise: false,
      snoozedUntil: null,
      createdAt: now,
      updatedAt: now,
    }, now);
    return {
      created: result.created,
      conflict: result.conflict,
      snapshot: read(),
      inboxItemId: result.item.id,
    };
  }

  return {
    ...rows,
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
    replaceHermesTasks,
    markHermesUnavailable,
    readHermesFeed,
    getHermesTask,
    updateHermesTaskAnnotation,
    listHermesReminders,
    beginHermesCompletion,
    finishHermesAction,
    listHermesActions,
    savePushSubscription,
    listPushSubscriptions,
    deletePushSubscription,
    listPushDeliveries,
    markPushDelivered,
    prunePushDeliveries,
    getProviderRecord,
    findProviderRecord,
    countProviderRecords,
    createTaskAction,
    getTaskAction,
    listTaskActions,
    hasRunningTaskAction,
    beginTaskAction,
    finishTaskAction,
    updateTaskExternalState,
    createTaskAdoption,
    getTaskAdoption,
    approveTaskAdoption,
    findAdoptedTaskId,
    addAgentProposal,
    close: () => db.close(),
  };
}

export type Store = ReturnType<typeof openStore>;
