import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dublinDateTimeToInstant, isDateKey } from '../src/calendar-time.ts';
import { areaForList } from '../src/integration-model.ts';
import {
  isInboxItem,
  isPrototypeData,
  isReminder,
  isTask,
  type Area,
  type InboxItem,
  type PrototypeData,
  type Reminder,
  type Task,
} from '../src/model.ts';
import type {
  ActionRow,
  ChangeRow,
  DraftRevision,
  InboxItemRow,
  InboxOutcome,
  InboxState,
  ReminderRow,
  ReplyEnvelope,
  SyncStateRow,
  TaskPlanRow,
  TaskRow,
  TaskWithPlan,
} from '../src/row-model.ts';
import { filterCalendarContextByDateRange } from '../src/integration-model.ts';
import type { ImportedRecord, Provider } from './store.ts';

export const ROW_SCHEMA_VERSION = 8;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().flatMap(key =>
      record[key] === undefined ? [] : [[key, canonicalValue(record[key])]]));
  }
  throw new TypeError('Value cannot be encoded as canonical JSON');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url');
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

function jsonStringList(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function parseDurationMinutes(value: string): number | null {
  const hours = value.match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hour)/i);
  if (hours) {
    const minutes = Math.round(Number(hours[1]) * 60);
    return minutes >= 1 && minutes <= 1_440 ? minutes : null;
  }
  const minutes = value.match(/^(\d+)\s*(?:m|min|minute)/i);
  if (minutes) {
    const parsed = Number(minutes[1]);
    return parsed >= 1 && parsed <= 1_440 ? parsed : null;
  }
  return null;
}

function taskPlanFromLegacy(task: Task, now: string): TaskPlanRow {
  const plannedAt = task.scheduledDate && task.scheduledTime
    ? dublinDateTimeToInstant(task.scheduledDate, task.scheduledTime)
    : null;
  const plannedOn = plannedAt === null && task.scheduledDate ? task.scheduledDate : null;
  return {
    taskId: task.id,
    version: 1,
    priority: task.priority,
    waiting: task.state === 'waiting',
    deadlineOn: task.deadlineDate ?? null,
    plannedOn,
    plannedAt,
    estimateMinutes: parseDurationMinutes(task.duration),
    createdAt: task.createdAt ?? now,
    updatedAt: now,
  };
}

function inboxSourceFromLegacy(item: InboxItem): InboxItemRow['source'] {
  return { kind: 'capture', reference: `legacy:${item.id}` };
}

function inboxStateFromLegacy(item: InboxItem): { state: InboxState; outcome: InboxOutcome | null } {
  return item.status === 'handled'
    ? { state: 'resolved', outcome: 'read' }
    : item.status === 'waiting-on-agent'
      ? { state: 'waiting', outcome: null }
      : { state: 'open', outcome: null };
}

function legacyReply(item: InboxItem): ReplyEnvelope {
  return {
    accountId: 'legacy',
    threadId: item.id,
    replyToMessageId: item.id,
    inReplyTo: item.id,
    references: [],
    from: 'legacy',
    to: [],
    cc: [],
    bcc: [],
    subject: item.title,
    bodyText: item.draft ?? '',
  };
}

function taskSnapshot(row: TaskRow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

function planSnapshot(row: TaskPlanRow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

function inboxSnapshot(row: InboxItemRow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

function reminderSnapshot(row: ReminderRow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

function actionSnapshot(row: ActionRow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

function taskRowFromSql(row: Record<string, unknown>): TaskRow | null {
  if (
    typeof row.id !== 'string' || typeof row.version !== 'number' ||
    typeof row.binding_kind !== 'string' || typeof row.intent_version !== 'number' ||
    typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
  ) return null;
  const binding = row.binding_kind === 'google' && typeof row.account_id === 'string' &&
      typeof row.list_id === 'string' && typeof row.external_id === 'string'
    ? { kind: 'google' as const, ref: { accountId: row.account_id, listId: row.list_id, externalId: row.external_id } }
    : row.binding_kind === 'pending' && typeof row.account_id === 'string' &&
        typeof row.list_id === 'string' && typeof row.create_action_id === 'string'
      ? { kind: 'pending' as const, destination: { accountId: row.account_id, listId: row.list_id }, createActionId: row.create_action_id }
      : row.binding_kind === 'legacy'
        ? { kind: 'legacy' as const, source: jsonRecord(row.legacy_source_json) ?? {} }
        : null;
  if (!binding) return null;
  const observed: TaskRow['observed'] = row.observed_at === null
    ? null
    : typeof row.title === 'string' && typeof row.status === 'string' &&
        (row.status === 'open' || row.status === 'completed') && typeof row.observed_at === 'string'
      ? {
          title: row.title,
          notes: stringOrNull(row.notes),
          status: row.status === 'open' ? 'open' : 'completed',
          completedAt: stringOrNull(row.completed_at),
          doOn: stringOrNull(row.do_on),
          parentId: stringOrNull(row.parent_id),
          position: stringOrNull(row.position),
          sourceUrl: stringOrNull(row.source_url),
          etag: stringOrNull(row.etag),
          observedAt: row.observed_at,
          completionWritable: row.completion_writable === 1,
        }
      : null;
  if (row.observed_at !== null && !observed) return null;
  return {
    id: row.id,
    version: row.version,
    binding,
    observed,
    unavailableAt: stringOrNull(row.unavailable_at),
    intentVersion: row.intent_version,
    originInboxId: stringOrNull(row.origin_inbox_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskPlanFromSql(row: Record<string, unknown>): TaskPlanRow | null {
  if (
    typeof row.task_id !== 'string' || typeof row.version !== 'number' ||
    !['low', 'medium', 'high'].includes(String(row.priority)) ||
    typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
  ) return null;
  return {
    taskId: row.task_id,
    version: row.version,
    priority: row.priority as TaskPlanRow['priority'],
    waiting: row.waiting === 1,
    deadlineOn: stringOrNull(row.deadline_on),
    plannedOn: stringOrNull(row.planned_on),
    plannedAt: stringOrNull(row.planned_at),
    estimateMinutes: numberOrNull(row.estimate_minutes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function inboxRowFromSql(row: Record<string, unknown>): InboxItemRow | null {
  if (
    typeof row.id !== 'string' || typeof row.version !== 'number' ||
    typeof row.source_kind !== 'string' || typeof row.title !== 'string' ||
    typeof row.summary !== 'string' || !['open', 'waiting', 'resolved'].includes(String(row.state)) ||
    typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
  ) return null;
  const source = row.source_kind === 'email' && typeof row.account_id === 'string' &&
      typeof row.message_id === 'string' && typeof row.thread_id === 'string'
    ? { kind: 'email' as const, accountId: row.account_id, messageId: row.message_id, threadId: row.thread_id }
    : row.source_kind === 'hermes' && typeof row.source_reference === 'string'
      ? { kind: 'hermes' as const, reference: row.source_reference }
      : row.source_kind === 'capture' && typeof row.source_reference === 'string'
        ? { kind: 'capture' as const, reference: row.source_reference }
        : null;
  if (!source) return null;
  const outcome = row.outcome === null ? null : ['sent', 'task', 'dismissed', 'noise', 'read'].includes(String(row.outcome))
    ? row.outcome as InboxOutcome
    : undefined;
  if (outcome === undefined) return null;
  return {
    id: row.id,
    version: row.version,
    source,
    title: row.title,
    summary: row.summary,
    state: row.state as InboxState,
    outcome,
    taskId: stringOrNull(row.task_id),
    currentDraftId: stringOrNull(row.current_draft_id),
    likelyNoise: row.likely_noise === 1,
    snoozedUntil: stringOrNull(row.snoozed_until),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function draftFromSql(row: Record<string, unknown>): DraftRevision | null {
  if (
    typeof row.id !== 'string' || typeof row.inbox_id !== 'string' || typeof row.revision !== 'number' ||
    (row.author !== 'owner' && row.author !== 'hermes') || typeof row.created_at !== 'string'
  ) return null;
  const reply = jsonRecord(row.reply_json);
  if (!reply) return null;
  const references = Array.isArray(reply.references) && reply.references.every(value => typeof value === 'string')
    ? reply.references
    : null;
  const to = Array.isArray(reply.to) && reply.to.every(value => typeof value === 'string') ? reply.to : null;
  const cc = Array.isArray(reply.cc) && reply.cc.every(value => typeof value === 'string') ? reply.cc : null;
  const bcc = Array.isArray(reply.bcc) && reply.bcc.every(value => typeof value === 'string') ? reply.bcc : null;
  if (
    typeof reply.accountId !== 'string' || typeof reply.threadId !== 'string' ||
    typeof reply.replyToMessageId !== 'string' || typeof reply.inReplyTo !== 'string' ||
    typeof reply.from !== 'string' || typeof reply.subject !== 'string' || typeof reply.bodyText !== 'string' ||
    !references || !to || !cc || !bcc
  ) return null;
  return {
    id: row.id,
    inboxId: row.inbox_id,
    revision: row.revision,
    author: row.author,
    reply: { ...reply, references, to, cc, bcc } as ReplyEnvelope,
    createdAt: row.created_at,
  };
}

function actionFromSql(row: Record<string, unknown>): ActionRow | null {
  if (
    typeof row.id !== 'string' || typeof row.version !== 'number' ||
    typeof row.operation_key !== 'string' || typeof row.request_hash !== 'string' ||
    typeof row.payload_json !== 'string' || typeof row.approval_json !== 'string' ||
    typeof row.state !== 'string' || typeof row.attempt_count !== 'number' ||
    typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
  ) return null;
  const payload = jsonRecord(row.payload_json);
  const approval = jsonRecord(row.approval_json);
  if (!payload || typeof payload.kind !== 'string' || !approval || approval.actor !== 'owner' ||
    typeof approval.at !== 'string' || typeof approval.previewText !== 'string') return null;
  return {
    id: row.id,
    version: row.version,
    payload: payload as ActionRow['payload'],
    operationKey: row.operation_key,
    requestHash: row.request_hash,
    approval: { actor: 'owner', at: approval.at, previewText: approval.previewText },
    state: row.state as ActionRow['state'],
    attemptCount: row.attempt_count,
    nextAttemptAt: stringOrNull(row.next_attempt_at),
    claimId: stringOrNull(row.claim_id),
    leaseUntil: stringOrNull(row.lease_until),
    receipt: row.receipt_json === null ? null : jsonRecord(row.receipt_json),
    error: stringOrNull(row.error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reminderFromSql(row: Record<string, unknown>): ReminderRow | null {
  if (
    typeof row.id !== 'string' || typeof row.version !== 'number' ||
    (row.target_kind !== 'task' && row.target_kind !== 'local-event') ||
    typeof row.target_id !== 'string' || typeof row.fire_at !== 'string' ||
    !['scheduled', 'fired', 'cancelled'].includes(String(row.state)) ||
    typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
  ) return null;
  return {
    id: row.id,
    version: row.version,
    target: { kind: row.target_kind, id: row.target_id },
    fireAt: row.fire_at,
    state: row.state as ReminderRow['state'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function syncStateFromSql(row: Record<string, unknown>): SyncStateRow | null {
  if (
    typeof row.scope_key !== 'string' || (row.provider !== 'google' && row.provider !== 'microsoft') ||
    (row.resource_kind !== 'task-list' && row.resource_kind !== 'calendar') ||
    typeof row.account_id !== 'string' || typeof row.container_id !== 'string' ||
    typeof row.container_name !== 'string' || typeof row.connection_generation !== 'string' ||
    (row.state !== 'fresh' && row.state !== 'failed') || typeof row.updated_at !== 'string'
  ) return null;
  return {
    scopeKey: row.scope_key,
    provider: row.provider,
    resourceKind: row.resource_kind,
    accountId: row.account_id,
    containerId: row.container_id,
    containerName: row.container_name,
    connectionGeneration: row.connection_generation,
    state: row.state,
    successfulFetchAt: stringOrNull(row.successful_fetch_at),
    coverageFrom: stringOrNull(row.coverage_from),
    coverageTo: stringOrNull(row.coverage_to),
    error: stringOrNull(row.error),
    updatedAt: row.updated_at,
  };
}

function insertChange(
  db: DatabaseSync,
  input: Omit<ChangeRow, 'seq' | 'mutationHash'> & { mutationHash?: string },
): number {
  const mutationHash = input.mutationHash ?? canonicalHash({
    actor: input.actor,
    entityKind: input.entityKind,
    entityId: input.entityId,
    entityVersion: input.entityVersion,
    operation: input.operation,
    snapshot: input.snapshot,
    details: input.details,
  });
  const result = db.prepare(`INSERT INTO changes (
    actor, mutation_key, mutation_hash, entity_kind, entity_id, entity_version,
    operation, snapshot_json, details_json, at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.actor,
    input.mutationKey,
    mutationHash,
    input.entityKind,
    input.entityId,
    input.entityVersion,
    input.operation,
    input.snapshot === null ? null : canonicalJson(input.snapshot),
    input.details === null ? null : canonicalJson(input.details),
    input.at,
  );
  return Number(result.lastInsertRowid);
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version >= 1),
      binding_kind TEXT NOT NULL CHECK(binding_kind IN ('legacy', 'pending', 'google')),
      account_id TEXT,
      list_id TEXT,
      external_id TEXT,
      create_action_id TEXT,
      legacy_source_json TEXT CHECK(legacy_source_json IS NULL OR json_valid(legacy_source_json)),
      title TEXT,
      notes TEXT,
      status TEXT CHECK(status IS NULL OR status IN ('open', 'completed')),
      completed_at TEXT,
      do_on TEXT,
      parent_id TEXT,
      position TEXT,
      source_url TEXT,
      etag TEXT,
      observed_at TEXT,
      completion_writable INTEGER NOT NULL DEFAULT 0 CHECK(completion_writable IN (0, 1)),
      unavailable_at TEXT,
      intent_version INTEGER NOT NULL DEFAULT 0 CHECK(intent_version >= 0),
      origin_inbox_id TEXT REFERENCES inbox_items(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (binding_kind='legacy' AND legacy_source_json IS NOT NULL AND account_id IS NULL AND list_id IS NULL AND external_id IS NULL AND create_action_id IS NULL) OR
        (binding_kind='pending' AND legacy_source_json IS NULL AND account_id IS NOT NULL AND list_id IS NOT NULL AND external_id IS NULL AND create_action_id IS NOT NULL AND observed_at IS NULL) OR
        (binding_kind='google' AND legacy_source_json IS NULL AND account_id IS NOT NULL AND list_id IS NOT NULL AND external_id IS NOT NULL AND create_action_id IS NULL AND observed_at IS NOT NULL)
      ),
      CHECK((observed_at IS NULL AND title IS NULL AND status IS NULL) OR
        (observed_at IS NOT NULL AND title IS NOT NULL AND status IS NOT NULL)),
      CHECK(do_on IS NULL OR (length(do_on)=10 AND substr(do_on,5,1)='-' AND substr(do_on,8,1)='-'))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_google_identity
      ON tasks(account_id, list_id, external_id) WHERE binding_kind='google';

    CREATE TABLE IF NOT EXISTS task_plans (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version >= 1),
      priority TEXT NOT NULL CHECK(priority IN ('low', 'medium', 'high')),
      waiting INTEGER NOT NULL CHECK(waiting IN (0, 1)),
      deadline_on TEXT,
      planned_on TEXT,
      planned_at TEXT,
      estimate_minutes INTEGER CHECK(estimate_minutes IS NULL OR estimate_minutes BETWEEN 1 AND 1440),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(NOT(planned_on IS NOT NULL AND planned_at IS NOT NULL))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS inbox_items (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version >= 1),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('email', 'hermes', 'capture')),
      account_id TEXT,
      message_id TEXT,
      thread_id TEXT,
      source_reference TEXT,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
      summary TEXT NOT NULL CHECK(length(summary) <= 10000),
      state TEXT NOT NULL CHECK(state IN ('open', 'waiting', 'resolved')),
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('sent', 'task', 'dismissed', 'noise', 'read')),
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      current_draft_id TEXT,
      likely_noise INTEGER NOT NULL DEFAULT 0 CHECK(likely_noise IN (0, 1)),
      snoozed_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (source_kind='email' AND account_id IS NOT NULL AND message_id IS NOT NULL AND thread_id IS NOT NULL AND source_reference IS NULL) OR
        (source_kind IN ('hermes', 'capture') AND account_id IS NULL AND message_id IS NULL AND thread_id IS NULL AND source_reference IS NOT NULL)
      ),
      CHECK((state='resolved' AND outcome IS NOT NULL) OR (state<>'resolved' AND outcome IS NULL))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS inbox_email_identity
      ON inbox_items(account_id, message_id) WHERE source_kind='email';
    CREATE UNIQUE INDEX IF NOT EXISTS inbox_reference_identity
      ON inbox_items(source_kind, source_reference) WHERE source_kind<>'email';

    CREATE TABLE IF NOT EXISTS reply_drafts (
      id TEXT PRIMARY KEY,
      inbox_id TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      author TEXT NOT NULL CHECK(author IN ('owner', 'hermes')),
      reply_json TEXT NOT NULL CHECK(json_valid(reply_json)),
      created_at TEXT NOT NULL,
      UNIQUE(inbox_id, revision)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('task-create', 'task-status', 'email-send', 'task-migration')),
      task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
      inbox_id TEXT REFERENCES inbox_items(id) ON DELETE RESTRICT,
      operation_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      approval_json TEXT NOT NULL CHECK(json_valid(approval_json)),
      state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'conflict', 'unknown', 'superseded', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      next_attempt_at TEXT,
      claim_id TEXT,
      lease_until TEXT,
      receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((claim_id IS NULL AND lease_until IS NULL) OR (claim_id IS NOT NULL AND lease_until IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS actions_ready ON actions(state, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS actions_task_intent ON actions(task_id, kind, created_at);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version >= 1),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      instruction TEXT NOT NULL CHECK(length(instruction) BETWEEN 1 AND 2000),
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      inbox_id TEXT REFERENCES inbox_items(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK(state IN ('queued', 'working', 'needs_you', 'review', 'settled')),
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('accepted', 'dropped')),
      question TEXT CHECK(question IS NULL OR length(question) BETWEEN 1 AND 280),
      claim_id TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((state='settled' AND outcome IS NOT NULL) OR (state<>'settled' AND outcome IS NULL)),
      CHECK((state='needs_you' AND question IS NOT NULL) OR (state<>'needs_you' AND question IS NULL)),
      CHECK((claim_id IS NULL AND lease_until IS NULL) OR (claim_id IS NOT NULL AND lease_until IS NOT NULL))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS job_updates (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      author TEXT NOT NULL CHECK(author IN ('hermes', 'owner')),
      kind TEXT NOT NULL CHECK(kind IN ('progress', 'question', 'answer', 'result', 'sent_back', 'settled')),
      text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 280),
      url TEXT,
      at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS job_updates_job ON job_updates(job_id, seq);

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version >= 1),
      target_kind TEXT NOT NULL CHECK(target_kind IN ('task', 'local-event')),
      target_id TEXT NOT NULL,
      fire_at TEXT,
      state TEXT NOT NULL CHECK(state IN ('scheduled', 'fired', 'cancelled')),
      legacy_json TEXT CHECK(legacy_json IS NULL OR json_valid(legacy_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(fire_at IS NOT NULL OR legacy_json IS NOT NULL)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS reminders_due ON reminders(state, fire_at);

    CREATE TABLE IF NOT EXISTS changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL CHECK(actor IN ('owner', 'hermes', 'provider', 'system')),
      mutation_key TEXT NOT NULL UNIQUE,
      mutation_hash TEXT NOT NULL,
      entity_kind TEXT NOT NULL CHECK(entity_kind IN ('task', 'task-plan', 'calendar', 'inbox', 'draft', 'action', 'job', 'reminder', 'briefing')),
      entity_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL CHECK(entity_version >= 0),
      operation TEXT NOT NULL CHECK(operation IN ('upsert', 'transition', 'remove')),
      snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
      details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json)),
      at TEXT NOT NULL,
      CHECK((operation='remove' AND snapshot_json IS NULL) OR (operation<>'remove' AND snapshot_json IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS changes_entity ON changes(entity_kind, entity_id, seq);

    CREATE TABLE IF NOT EXISTS sync_state (
      scope_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('google', 'microsoft')),
      resource_kind TEXT NOT NULL CHECK(resource_kind IN ('task-list', 'calendar')),
      account_id TEXT NOT NULL,
      container_id TEXT NOT NULL,
      container_name TEXT NOT NULL,
      connection_generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('fresh', 'failed')),
      successful_fetch_at TEXT,
      coverage_from TEXT,
      coverage_to TEXT,
      error TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, resource_kind, account_id, container_id)
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS changes_immutable_update BEFORE UPDATE ON changes
    BEGIN SELECT RAISE(ABORT, 'changes are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS changes_immutable_delete BEFORE DELETE ON changes
    BEGIN SELECT RAISE(ABORT, 'changes are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reply_drafts_immutable_update BEFORE UPDATE ON reply_drafts
    BEGIN SELECT RAISE(ABORT, 'draft revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reply_drafts_immutable_delete BEFORE DELETE ON reply_drafts
    BEGIN SELECT RAISE(ABORT, 'draft revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS job_updates_immutable_update BEFORE UPDATE ON job_updates
    BEGIN SELECT RAISE(ABORT, 'job updates are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS job_updates_immutable_delete BEFORE DELETE ON job_updates
    BEGIN SELECT RAISE(ABORT, 'job updates are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS action_payload_immutable BEFORE UPDATE OF kind, task_id, inbox_id, operation_key, request_hash, payload_json, approval_json ON actions
    WHEN OLD.kind<>NEW.kind OR OLD.task_id IS NOT NEW.task_id OR OLD.inbox_id IS NOT NEW.inbox_id OR
      OLD.operation_key<>NEW.operation_key OR OLD.request_hash<>NEW.request_hash OR
      OLD.payload_json<>NEW.payload_json OR OLD.approval_json<>NEW.approval_json
    BEGIN SELECT RAISE(ABORT, 'action payloads are immutable'); END;
  `);
}

function legacyTaskRow(task: Task, now: string): TaskRow {
  return {
    id: task.id,
    version: 1,
    binding: { kind: 'legacy', source: JSON.parse(JSON.stringify(task)) as Record<string, unknown> },
    observed: {
      title: task.title,
      notes: null,
      status: task.completed ? 'completed' : 'open',
      completedAt: task.completedAt ?? null,
      doOn: null,
      parentId: null,
      position: null,
      sourceUrl: null,
      etag: null,
      observedAt: task.createdAt ?? now,
      completionWritable: false,
    },
    unavailableAt: null,
    intentVersion: 0,
    originInboxId: null,
    createdAt: task.createdAt ?? now,
    updatedAt: now,
  };
}

function insertTask(db: DatabaseSync, task: TaskRow): void {
  const binding = task.binding;
  const observed = task.observed;
  db.prepare(`INSERT INTO tasks (
    id, version, binding_kind, account_id, list_id, external_id, create_action_id, legacy_source_json,
    title, notes, status, completed_at, do_on, parent_id, position, source_url, etag, observed_at,
    completion_writable, unavailable_at, intent_version, origin_inbox_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    task.id,
    task.version,
    binding.kind,
    binding.kind === 'google' ? binding.ref.accountId : binding.kind === 'pending' ? binding.destination.accountId : null,
    binding.kind === 'google' ? binding.ref.listId : binding.kind === 'pending' ? binding.destination.listId : null,
    binding.kind === 'google' ? binding.ref.externalId : null,
    binding.kind === 'pending' ? binding.createActionId : null,
    binding.kind === 'legacy' ? canonicalJson(binding.source) : null,
    observed?.title ?? null,
    observed?.notes ?? null,
    observed?.status ?? null,
    observed?.completedAt ?? null,
    observed?.doOn ?? null,
    observed?.parentId ?? null,
    observed?.position ?? null,
    observed?.sourceUrl ?? null,
    observed?.etag ?? null,
    observed?.observedAt ?? null,
    observed?.completionWritable ? 1 : 0,
    task.unavailableAt,
    task.intentVersion,
    task.originInboxId,
    task.createdAt,
    task.updatedAt,
  );
}

function insertPlan(db: DatabaseSync, plan: TaskPlanRow): void {
  db.prepare(`INSERT INTO task_plans (
    task_id, version, priority, waiting, deadline_on, planned_on, planned_at,
    estimate_minutes, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    plan.taskId,
    plan.version,
    plan.priority,
    plan.waiting ? 1 : 0,
    plan.deadlineOn,
    plan.plannedOn,
    plan.plannedAt,
    plan.estimateMinutes,
    plan.createdAt,
    plan.updatedAt,
  );
}

function insertInbox(db: DatabaseSync, item: InboxItemRow): void {
  const source = item.source;
  db.prepare(`INSERT INTO inbox_items (
    id, version, source_kind, account_id, message_id, thread_id, source_reference,
    title, summary, state, outcome, task_id, current_draft_id, likely_noise,
    snoozed_until, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    item.id,
    item.version,
    source.kind,
    source.kind === 'email' ? source.accountId : null,
    source.kind === 'email' ? source.messageId : null,
    source.kind === 'email' ? source.threadId : null,
    source.kind === 'email' ? null : source.reference,
    item.title,
    item.summary,
    item.state,
    item.outcome,
    item.taskId,
    item.currentDraftId,
    item.likelyNoise ? 1 : 0,
    item.snoozedUntil,
    item.createdAt,
    item.updatedAt,
  );
}

function reminderFireAt(reminder: Reminder, data: PrototypeData): string | null {
  if (reminder.fireAt) return reminder.fireAt;
  if (typeof reminder.snoozedUntil === 'number' && Number.isFinite(reminder.snoozedUntil)) {
    return new Date(reminder.snoozedUntil).toISOString();
  }
  if (reminder.targetType === 'task') {
    const task = data.tasks.find(candidate => candidate.id === reminder.targetId);
    if (task?.scheduledDate && task.scheduledTime) {
      const startsAt = dublinDateTimeToInstant(task.scheduledDate, task.scheduledTime);
      if (startsAt) {
        if (reminder.mode === 'one-hour') return new Date(Date.parse(startsAt) - 3_600_000).toISOString();
        return dublinDateTimeToInstant(task.scheduledDate, '09:00');
      }
    }
  }
  const event = data.events.find(candidate => candidate.id === reminder.targetId);
  if (!event) return null;
  const startsAt = typeof event.startsAt === 'string'
    ? event.startsAt
    : event.date ? dublinDateTimeToInstant(event.date, event.start) : null;
  if (!startsAt) return null;
  if (reminder.mode === 'one-hour') return new Date(Date.parse(startsAt) - 3_600_000).toISOString();
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(startsAt));
  return dublinDateTimeToInstant(day, '09:00');
}

function migrateWorkspace(db: DatabaseSync, data: PrototypeData, now: string): void {
  for (const legacyItem of data.inboxItems) {
    if (!isInboxItem(legacyItem)) continue;
    const state = inboxStateFromLegacy(legacyItem);
    const hasDraft = legacyItem.draft !== undefined;
    const draftId = hasDraft ? `draft-${legacyItem.id}-1` : null;
    const item: InboxItemRow = {
      id: legacyItem.id,
      version: 1,
      source: inboxSourceFromLegacy(legacyItem),
      title: legacyItem.title,
      summary: legacyItem.summary,
      ...state,
      taskId: null,
      currentDraftId: draftId,
      likelyNoise: false,
      snoozedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    insertInbox(db, item);
    insertChange(db, {
      actor: 'system', mutationKey: `migration:inbox:${item.id}`, entityKind: 'inbox', entityId: item.id,
      entityVersion: item.version, operation: 'upsert', snapshot: inboxSnapshot(item), details: { source: 'workspace-v7' }, at: now,
    });
    if (draftId) {
      const draft: DraftRevision = { id: draftId, inboxId: item.id, revision: 1, author: 'owner', reply: legacyReply(legacyItem), createdAt: now };
      db.prepare(`INSERT INTO reply_drafts (id, inbox_id, revision, author, reply_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(draft.id, draft.inboxId, draft.revision, draft.author, canonicalJson(draft.reply), draft.createdAt);
      insertChange(db, {
        actor: 'system', mutationKey: `migration:draft:${draft.id}`, entityKind: 'draft', entityId: draft.id,
        entityVersion: draft.revision, operation: 'upsert', snapshot: JSON.parse(JSON.stringify(draft)) as Record<string, unknown>,
        details: { source: 'workspace-v7' }, at: now,
      });
    }
  }

  for (const legacyTask of data.tasks) {
    if (!isTask(legacyTask)) continue;
    const task = legacyTaskRow(legacyTask, now);
    insertTask(db, task);
    const plan = taskPlanFromLegacy(legacyTask, now);
    insertPlan(db, plan);
    insertChange(db, {
      actor: 'system', mutationKey: `migration:task:${task.id}`, entityKind: 'task', entityId: task.id,
      entityVersion: task.version, operation: 'upsert', snapshot: taskSnapshot(task), details: { source: 'workspace-v7' }, at: now,
    });
    insertChange(db, {
      actor: 'system', mutationKey: `migration:task-plan:${task.id}`, entityKind: 'task-plan', entityId: task.id,
      entityVersion: plan.version, operation: 'upsert', snapshot: planSnapshot(plan), details: { source: 'workspace-v7' }, at: now,
    });
    if (task.observed?.status === 'completed') {
      insertChange(db, {
        actor: 'system', mutationKey: `migration:completion:${task.id}`, entityKind: 'task', entityId: task.id,
        entityVersion: task.version, operation: 'transition', snapshot: taskSnapshot(task),
        details: { before: 'open', after: 'completed', completedAt: task.observed.completedAt },
        at: task.observed.completedAt ?? now,
      });
    }
  }

  for (const legacyReminder of data.reminders) {
    if (!isReminder(legacyReminder)) continue;
    const fireAt = reminderFireAt(legacyReminder, data);
    db.prepare(`INSERT INTO reminders (
      id, version, target_kind, target_id, fire_at, state, legacy_json, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(
      legacyReminder.id,
      legacyReminder.targetType === 'task' ? 'task' : 'local-event',
      legacyReminder.targetId,
      fireAt,
      legacyReminder.firedAt ? 'fired' : 'scheduled',
      canonicalJson(legacyReminder),
      now,
      now,
    );
    const migrated = fireAt ? {
      id: legacyReminder.id,
      version: 1,
      target: { kind: legacyReminder.targetType === 'task' ? 'task' as const : 'local-event' as const, id: legacyReminder.targetId },
      fireAt,
      state: legacyReminder.firedAt ? 'fired' as const : 'scheduled' as const,
      createdAt: now,
      updatedAt: now,
    } : null;
    insertChange(db, {
      actor: 'system', mutationKey: `migration:reminder:${legacyReminder.id}`, entityKind: 'reminder', entityId: legacyReminder.id,
      entityVersion: 1, operation: 'upsert',
      snapshot: migrated ? reminderSnapshot(migrated) : { ...legacyReminder, fireAt: null },
      details: { source: 'workspace-v7', deliveryReady: fireAt !== null }, at: now,
    });
  }
}

export function initializeRowStore(
  db: DatabaseSync,
  previousSchemaVersion: number,
  workspace: PrototypeData,
  now = new Date().toISOString(),
): void {
  ensureSchema(db);
  if (previousSchemaVersion >= ROW_SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const count = db.prepare('SELECT COUNT(*) AS total FROM tasks').get() as Record<string, unknown>;
    if (count.total === 0) migrateWorkspace(db, workspace, now);
    db.exec(`PRAGMA user_version=${ROW_SCHEMA_VERSION}; COMMIT;`);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    throw error;
  }
}

function providerTaskId(record: ImportedRecord): string {
  return `task-google-${createHash('sha256').update(`${record.connectionId}\0${record.containerId}\0${record.externalId}`).digest('hex').slice(0, 32)}`;
}

function linkedLegacyTask(
  rows: Record<string, unknown>[],
  accountId: string,
  listId: string,
  externalId: string,
): TaskRow | null {
  for (const row of rows) {
    const task = taskRowFromSql(row);
    if (!task || task.binding.kind !== 'legacy') continue;
    const links = task.binding.source.externalLinks;
    if (!Array.isArray(links)) continue;
    const match = links.some(link => {
      if (typeof link !== 'object' || link === null || Array.isArray(link)) return false;
      const record = link as Record<string, unknown>;
      return record.provider === 'google_tasks' && record.connectionId === accountId &&
        record.containerId === listId && record.externalId === externalId;
    });
    if (match) return task;
  }
  return null;
}

function scopeKey(input: {
  provider: Provider;
  resourceKind: 'task-list' | 'calendar';
  accountId: string;
  containerId: string;
}): string {
  return [input.provider, input.resourceKind, input.accountId, input.containerId].join(':');
}

export type ProviderScopePublication = {
  provider: Provider;
  resourceKind: 'task-list' | 'calendar';
  accountId: string;
  connectionGeneration: string;
  containerId: string;
  containerName: string;
  records: ImportedRecord[];
  coverageFrom: string | null;
  coverageTo: string | null;
  fetchedAt: string;
};

export function createRowStore(db: DatabaseSync) {
  function listTasks(): TaskRow[] {
    return (db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, id').all() as Record<string, unknown>[])
      .flatMap(row => {
        const task = taskRowFromSql(row);
        return task ? [task] : [];
      });
  }

  function getTask(id: string): TaskRow | null {
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? taskRowFromSql(row) : null;
  }

  function listTaskPlans(): TaskPlanRow[] {
    return (db.prepare('SELECT * FROM task_plans ORDER BY task_id').all() as Record<string, unknown>[])
      .flatMap(row => {
        const plan = taskPlanFromSql(row);
        return plan ? [plan] : [];
      });
  }

  function getTaskPlan(taskId: string): TaskPlanRow | null {
    const row = db.prepare('SELECT * FROM task_plans WHERE task_id=?').get(taskId) as Record<string, unknown> | undefined;
    return row ? taskPlanFromSql(row) : null;
  }

  function listInboxItems(): InboxItemRow[] {
    return (db.prepare('SELECT * FROM inbox_items ORDER BY updated_at DESC, id').all() as Record<string, unknown>[])
      .flatMap(row => {
        const item = inboxRowFromSql(row);
        return item ? [item] : [];
      });
  }

  function getInboxItem(id: string): InboxItemRow | null {
    const row = db.prepare('SELECT * FROM inbox_items WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? inboxRowFromSql(row) : null;
  }

  function listDrafts(inboxId?: string): DraftRevision[] {
    const rows = inboxId
      ? db.prepare('SELECT * FROM reply_drafts WHERE inbox_id=? ORDER BY revision').all(inboxId)
      : db.prepare('SELECT * FROM reply_drafts ORDER BY inbox_id, revision').all();
    return (rows as Record<string, unknown>[]).flatMap(row => {
      const draft = draftFromSql(row);
      return draft ? [draft] : [];
    });
  }

  function listActions(states?: readonly ActionRow['state'][]): ActionRow[] {
    const rows = db.prepare('SELECT * FROM actions ORDER BY created_at, id').all() as Record<string, unknown>[];
    return rows.flatMap(row => {
      const action = actionFromSql(row);
      return action && (!states || states.includes(action.state)) ? [action] : [];
    });
  }

  function getAction(id: string): ActionRow | null {
    const row = db.prepare('SELECT * FROM actions WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? actionFromSql(row) : null;
  }

  function listReminders(): ReminderRow[] {
    return (db.prepare('SELECT * FROM reminders WHERE fire_at IS NOT NULL ORDER BY fire_at, id').all() as Record<string, unknown>[])
      .flatMap(row => {
        const reminder = reminderFromSql(row);
        return reminder ? [reminder] : [];
      });
  }

  function listSyncStates(): SyncStateRow[] {
    return (db.prepare('SELECT * FROM sync_state ORDER BY provider, resource_kind, container_name, container_id').all() as Record<string, unknown>[])
      .flatMap(row => {
        const state = syncStateFromSql(row);
        return state ? [state] : [];
      });
  }

  function updateTaskPlan(taskId: string, expectedVersion: number, input: Omit<TaskPlanRow, 'taskId' | 'version' | 'createdAt' | 'updatedAt'>, now: string): TaskPlanRow | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getTaskPlan(taskId);
      if (!current || current.version !== expectedVersion) {
        db.exec('ROLLBACK');
        return null;
      }
      const next: TaskPlanRow = { ...current, ...input, version: current.version + 1, updatedAt: now };
      const result = db.prepare(`UPDATE task_plans SET version=?, priority=?, waiting=?, deadline_on=?, planned_on=?,
        planned_at=?, estimate_minutes=?, updated_at=? WHERE task_id=? AND version=?`).run(
        next.version, next.priority, next.waiting ? 1 : 0, next.deadlineOn, next.plannedOn,
        next.plannedAt, next.estimateMinutes, next.updatedAt, taskId, expectedVersion,
      );
      if (result.changes !== 1) {
        db.exec('ROLLBACK');
        return null;
      }
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:task-plan:${taskId}:${next.version}`, entityKind: 'task-plan', entityId: taskId,
        entityVersion: next.version, operation: 'upsert', snapshot: planSnapshot(next),
        details: { expectedVersion }, at: now,
      });
      db.exec('COMMIT');
      return getTaskPlan(taskId);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function updateInboxDecision(
    id: string,
    expectedVersion: number,
    input: { state: InboxState; outcome: InboxOutcome | null; snoozedUntil: string | null },
    now: string,
  ): InboxItemRow | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getInboxItem(id);
      if (!current || current.version !== expectedVersion) {
        db.exec('ROLLBACK');
        return null;
      }
      const version = current.version + 1;
      const result = db.prepare(`UPDATE inbox_items SET version=?, state=?, outcome=?, snoozed_until=?, updated_at=?
        WHERE id=? AND version=?`).run(version, input.state, input.outcome, input.snoozedUntil, now, id, expectedVersion);
      if (result.changes !== 1) {
        db.exec('ROLLBACK');
        return null;
      }
      const next = getInboxItem(id);
      if (!next) throw new Error('Inbox item disappeared');
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:inbox:${id}:${version}`, entityKind: 'inbox', entityId: id,
        entityVersion: version, operation: 'transition', snapshot: inboxSnapshot(next),
        details: { before: { state: current.state, outcome: current.outcome }, after: { state: next.state, outcome: next.outcome } }, at: now,
      });
      db.exec('COMMIT');
      return getInboxItem(id);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function appendCaptureInbox(item: InboxItemRow, mutationKey: string, actor: 'owner' | 'hermes', now: string): { created: boolean; item: InboxItemRow } {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existingChange = db.prepare('SELECT entity_id FROM changes WHERE mutation_key=?').get(mutationKey) as Record<string, unknown> | undefined;
      if (typeof existingChange?.entity_id === 'string') {
        const existing = getInboxItem(existingChange.entity_id);
        if (!existing) throw new Error('Inbox mutation points to a missing item');
        db.exec('COMMIT');
        return { created: false, item: existing };
      }
      insertInbox(db, item);
      insertChange(db, {
        actor, mutationKey, entityKind: 'inbox', entityId: item.id, entityVersion: item.version,
        operation: 'upsert', snapshot: inboxSnapshot(item), details: null, at: now,
      });
      db.exec('COMMIT');
      return { created: true, item };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function addLegacyProposal(
    idempotencyKey: string,
    requestHash: string,
    item: InboxItemRow,
    now: string,
  ): { created: boolean; conflict: boolean; item: InboxItemRow } {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT inbox_item_id, request_hash FROM agent_proposals WHERE idempotency_key=?')
        .get(idempotencyKey) as Record<string, unknown> | undefined;
      if (typeof existing?.inbox_item_id === 'string') {
        const current = getInboxItem(existing.inbox_item_id);
        if (!current) throw new Error('Proposal points to a missing Inbox item');
        db.exec('COMMIT');
        return { created: false, conflict: existing.request_hash !== requestHash, item: current };
      }
      insertInbox(db, item);
      db.prepare('INSERT INTO agent_proposals (idempotency_key, request_hash, inbox_item_id, created_at) VALUES (?, ?, ?, ?)')
        .run(idempotencyKey, requestHash, item.id, now);
      insertChange(db, {
        actor: 'hermes', mutationKey: `legacy-proposal:${idempotencyKey}`, entityKind: 'inbox',
        entityId: item.id, entityVersion: item.version, operation: 'upsert', snapshot: inboxSnapshot(item),
        details: { requestHash }, at: now,
      });
      db.exec('COMMIT');
      return { created: true, conflict: false, item };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function markScopeFailed(input: Omit<ProviderScopePublication, 'records'>, error: string): void {
    const key = scopeKey(input);
    db.prepare(`INSERT INTO sync_state (
      scope_key, provider, resource_kind, account_id, container_id, container_name, connection_generation,
      state, successful_fetch_at, coverage_from, coverage_to, error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', NULL, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      container_name=excluded.container_name, connection_generation=excluded.connection_generation,
      state='failed', coverage_from=excluded.coverage_from, coverage_to=excluded.coverage_to,
      error=excluded.error, updated_at=excluded.updated_at`).run(
      key, input.provider, input.resourceKind, input.accountId, input.containerId, input.containerName,
      input.connectionGeneration, input.coverageFrom, input.coverageTo, error, input.fetchedAt,
    );
  }

  function publishProviderScope(input: ProviderScopePublication): number {
    const marker = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      const upsertProvider = db.prepare(`INSERT INTO provider_records (
        provider, connection_id, kind, container_id, container_name, external_id, title, status,
        starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at, source_version,
        completion_writable, source_url, source_time_zone, imported_at, sync_marker, deleted_at,
        notes, parent_id, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(provider, kind, container_id, external_id) DO UPDATE SET
        connection_id=excluded.connection_id, container_name=excluded.container_name, title=excluded.title,
        status=excluded.status, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
        starts_on=excluded.starts_on, ends_on=excluded.ends_on, all_day=excluded.all_day,
        due_on=excluded.due_on, completed_at=excluded.completed_at, source_updated_at=excluded.source_updated_at,
        source_version=excluded.source_version, completion_writable=excluded.completion_writable,
        source_url=excluded.source_url, source_time_zone=excluded.source_time_zone, imported_at=excluded.imported_at,
        sync_marker=excluded.sync_marker, deleted_at=NULL, notes=excluded.notes, parent_id=excluded.parent_id,
        position=excluded.position`);
      for (const record of input.records) {
        const previousProvider = db.prepare(`SELECT title, status, starts_at, ends_at, starts_on, ends_on,
          all_day, due_on, completed_at, source_updated_at, source_version, source_url, notes, parent_id, position
          FROM provider_records WHERE provider=? AND kind=? AND connection_id=? AND container_id=? AND external_id=?`)
          .get(record.provider, record.kind, input.connectionGeneration, record.containerId, record.externalId) as Record<string, unknown> | undefined;
        upsertProvider.run(
          record.provider, input.connectionGeneration, record.kind, record.containerId, record.containerName,
          record.externalId, record.title, record.status, record.startsAt, record.endsAt, record.startsOn,
          record.endsOn, record.allDay ? 1 : 0, record.dueOn, record.completedAt, record.sourceUpdatedAt,
          record.sourceVersion ?? null, record.completionWritable ? 1 : 0, record.sourceUrl,
          record.sourceTimeZone, input.fetchedAt, marker, record.notes ?? null, record.parentId ?? null,
          record.position ?? null,
        );
        if (record.kind === 'calendar_event') {
          const snapshot = {
            source: {
              provider: record.provider,
              accountId: input.accountId,
              calendarId: record.containerId,
              externalId: record.externalId,
            },
            title: record.title,
            startsAt: record.startsAt,
            endsAt: record.endsAt,
            startsOn: record.startsOn,
            endsOn: record.endsOn,
            allDay: record.allDay,
            updatedAt: record.sourceUpdatedAt,
          };
          const previousSnapshot = previousProvider ? {
            source: snapshot.source,
            title: previousProvider.title,
            startsAt: stringOrNull(previousProvider.starts_at),
            endsAt: stringOrNull(previousProvider.ends_at),
            startsOn: stringOrNull(previousProvider.starts_on),
            endsOn: stringOrNull(previousProvider.ends_on),
            allDay: previousProvider.all_day === 1,
            updatedAt: stringOrNull(previousProvider.source_updated_at),
          } : null;
          if (canonicalJson(previousSnapshot) !== canonicalJson(snapshot)) {
            const entityId = `${record.provider}:${input.connectionGeneration}:${record.containerId}:${record.externalId}`;
            const versionRow = db.prepare("SELECT COALESCE(MAX(entity_version), 0) AS version FROM changes WHERE entity_kind='calendar' AND entity_id=?")
              .get(entityId) as Record<string, unknown>;
            const version = (typeof versionRow.version === 'number' ? versionRow.version : 0) + 1;
            insertChange(db, {
              actor: 'provider', mutationKey: `provider-calendar:${entityId}:${version}`, entityKind: 'calendar',
              entityId, entityVersion: version, operation: 'upsert', snapshot,
              details: { scope: scopeKey(input) }, at: input.fetchedAt,
            });
          }
        }
        if (input.provider !== 'google' || record.kind !== 'task') continue;
        const existingRow = db.prepare(`SELECT * FROM tasks WHERE binding_kind='google' AND account_id=? AND list_id=? AND external_id=?`)
          .get(input.accountId, record.containerId, record.externalId) as Record<string, unknown> | undefined;
        const existing = existingRow ? taskRowFromSql(existingRow) : null;
        const observed: NonNullable<TaskRow['observed']> = {
          title: record.title,
          notes: record.notes ?? null,
          status: record.status === 'completed' ? 'completed' : 'open',
          completedAt: record.completedAt,
          doOn: record.dueOn,
          parentId: record.parentId ?? null,
          position: record.position ?? null,
          sourceUrl: record.sourceUrl,
          etag: record.sourceVersion ?? null,
          observedAt: input.fetchedAt,
          completionWritable: record.completionWritable ?? true,
        };
        if (!existing) {
          const legacy = linkedLegacyTask(
            db.prepare("SELECT * FROM tasks WHERE binding_kind='legacy'").all() as Record<string, unknown>[],
            input.accountId,
            record.containerId,
            record.externalId,
          );
          if (legacy) {
            const version = legacy.version + 1;
            db.prepare(`UPDATE tasks SET version=?, binding_kind='google', account_id=?, list_id=?, external_id=?,
              create_action_id=NULL, legacy_source_json=NULL, title=?, notes=?, status=?, completed_at=?, do_on=?,
              parent_id=?, position=?, source_url=?, etag=?, observed_at=?, completion_writable=?, unavailable_at=NULL,
              updated_at=? WHERE id=?`).run(
              version, input.accountId, record.containerId, record.externalId, observed.title, observed.notes,
              observed.status, observed.completedAt, observed.doOn, observed.parentId, observed.position,
              observed.sourceUrl, observed.etag, observed.observedAt, observed.completionWritable ? 1 : 0,
              input.fetchedAt, legacy.id,
            );
            const next = getTask(legacy.id);
            if (!next) throw new Error('Bound task disappeared');
            insertChange(db, {
              actor: 'provider', mutationKey: `provider:${input.connectionGeneration}:${record.containerId}:${record.externalId}:bind:${version}`,
              entityKind: 'task', entityId: legacy.id, entityVersion: version, operation: 'transition',
              snapshot: taskSnapshot(next), details: { binding: 'existing-google', scope: scopeKey(input) }, at: input.fetchedAt,
            });
            continue;
          }
        }
        if (existing) {
          const unchanged = canonicalJson(existing.observed) === canonicalJson(observed) && existing.unavailableAt === null;
          if (unchanged) continue;
          const version = existing.version + 1;
          db.prepare(`UPDATE tasks SET version=?, title=?, notes=?, status=?, completed_at=?, do_on=?, parent_id=?,
            position=?, source_url=?, etag=?, observed_at=?, completion_writable=?, unavailable_at=NULL, updated_at=? WHERE id=?`).run(
            version, observed.title, observed.notes, observed.status, observed.completedAt, observed.doOn,
            observed.parentId, observed.position, observed.sourceUrl, observed.etag, observed.observedAt,
            observed.completionWritable ? 1 : 0, input.fetchedAt, existing.id,
          );
          const next = getTask(existing.id);
          if (!next) throw new Error('Imported task disappeared');
          insertChange(db, {
            actor: 'provider', mutationKey: `provider:${input.connectionGeneration}:${record.containerId}:${record.externalId}:${version}`,
            entityKind: 'task', entityId: existing.id, entityVersion: version, operation: 'upsert',
            snapshot: taskSnapshot(next), details: { scope: scopeKey(input) }, at: input.fetchedAt,
          });
        } else {
          const task: TaskRow = {
            id: providerTaskId({ ...record, connectionId: input.connectionGeneration }),
            version: 1,
            binding: { kind: 'google', ref: { accountId: input.accountId, listId: record.containerId, externalId: record.externalId } },
            observed,
            unavailableAt: null,
            intentVersion: 0,
            originInboxId: null,
            createdAt: record.sourceUpdatedAt ?? input.fetchedAt,
            updatedAt: input.fetchedAt,
          };
          insertTask(db, task);
          const plan: TaskPlanRow = {
            taskId: task.id, version: 1, priority: 'medium', waiting: false, deadlineOn: null,
            plannedOn: null, plannedAt: null, estimateMinutes: null,
            createdAt: task.createdAt, updatedAt: input.fetchedAt,
          };
          insertPlan(db, plan);
          insertChange(db, {
            actor: 'provider', mutationKey: `provider:${input.connectionGeneration}:${record.containerId}:${record.externalId}:1`,
            entityKind: 'task', entityId: task.id, entityVersion: 1, operation: 'upsert',
            snapshot: taskSnapshot(task), details: { scope: scopeKey(input) }, at: input.fetchedAt,
          });
          insertChange(db, {
            actor: 'provider', mutationKey: `provider:${input.connectionGeneration}:${record.containerId}:${record.externalId}:plan:1`,
            entityKind: 'task-plan', entityId: task.id, entityVersion: 1, operation: 'upsert',
            snapshot: planSnapshot(plan), details: { default: true }, at: input.fetchedAt,
          });
        }
      }

      const providerKind = input.resourceKind === 'task-list' ? 'task' : 'calendar_event';
      const absentRows = db.prepare(`SELECT external_id FROM provider_records
        WHERE provider=? AND kind=? AND connection_id=? AND container_id=? AND sync_marker<>?`).all(
        input.provider, providerKind, input.connectionGeneration, input.containerId, marker,
      ) as Record<string, unknown>[];
      db.prepare(`DELETE FROM provider_records
        WHERE provider=? AND kind=? AND connection_id=? AND container_id=? AND sync_marker<>?`).run(
        input.provider, providerKind, input.connectionGeneration, input.containerId, marker,
      );
      if (input.resourceKind === 'calendar') {
        for (const absent of absentRows) {
          if (typeof absent.external_id !== 'string') continue;
          const entityId = `${input.provider}:${input.connectionGeneration}:${input.containerId}:${absent.external_id}`;
          const versionRow = db.prepare("SELECT COALESCE(MAX(entity_version), 0) AS version FROM changes WHERE entity_kind='calendar' AND entity_id=?")
            .get(entityId) as Record<string, unknown>;
          const version = (typeof versionRow.version === 'number' ? versionRow.version : 0) + 1;
          insertChange(db, {
            actor: 'provider', mutationKey: `provider-calendar:${entityId}:${version}`, entityKind: 'calendar',
            entityId, entityVersion: version, operation: 'remove', snapshot: null,
            details: { scope: scopeKey(input), absentAfterCompleteSnapshot: true }, at: input.fetchedAt,
          });
        }
      }
      if (input.provider === 'google' && input.resourceKind === 'task-list') {
        for (const absent of absentRows) {
          if (typeof absent.external_id !== 'string') continue;
          const row = db.prepare(`SELECT * FROM tasks WHERE binding_kind='google' AND account_id=? AND list_id=? AND external_id=?`)
            .get(input.accountId, input.containerId, absent.external_id) as Record<string, unknown> | undefined;
          const task = row ? taskRowFromSql(row) : null;
          if (!task || task.unavailableAt !== null) continue;
          const version = task.version + 1;
          db.prepare('UPDATE tasks SET version=?, unavailable_at=?, updated_at=? WHERE id=?')
            .run(version, input.fetchedAt, input.fetchedAt, task.id);
          const next = getTask(task.id);
          if (!next) throw new Error('Unavailable task disappeared');
          insertChange(db, {
            actor: 'provider', mutationKey: `provider:${input.connectionGeneration}:${input.containerId}:${task.id}:unavailable:${version}`,
            entityKind: 'task', entityId: task.id, entityVersion: version, operation: 'transition',
            snapshot: taskSnapshot(next), details: { unavailable: true, scope: scopeKey(input) }, at: input.fetchedAt,
          });
        }
      }
      const key = scopeKey(input);
      db.prepare(`INSERT INTO sync_state (
        scope_key, provider, resource_kind, account_id, container_id, container_name, connection_generation,
        state, successful_fetch_at, coverage_from, coverage_to, error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'fresh', ?, ?, ?, NULL, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        container_name=excluded.container_name, connection_generation=excluded.connection_generation,
        state='fresh', successful_fetch_at=excluded.successful_fetch_at, coverage_from=excluded.coverage_from,
        coverage_to=excluded.coverage_to, error=NULL, updated_at=excluded.updated_at`).run(
        key, input.provider, input.resourceKind, input.accountId, input.containerId, input.containerName,
        input.connectionGeneration, input.fetchedAt, input.coverageFrom, input.coverageTo, input.fetchedAt,
      );
      db.exec('COMMIT');
      return input.records.length;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function listChanges(after: number, limit: number): { changes: ChangeRow[]; cursor: number; resetRequired: boolean } {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const bounds = db.prepare('SELECT MIN(seq) AS first_seq, MAX(seq) AS last_seq FROM changes').get() as Record<string, unknown>;
    const first = typeof bounds.first_seq === 'number' ? bounds.first_seq : 0;
    const last = typeof bounds.last_seq === 'number' ? bounds.last_seq : 0;
    if (after > 0 && first > 0 && after < first - 1) return { changes: [], cursor: last, resetRequired: true };
    const rows = db.prepare('SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(after, safeLimit) as Record<string, unknown>[];
    const changes = rows.flatMap(row => {
      if (
        typeof row.seq !== 'number' || typeof row.actor !== 'string' || typeof row.mutation_key !== 'string' ||
        typeof row.mutation_hash !== 'string' || typeof row.entity_kind !== 'string' || typeof row.entity_id !== 'string' ||
        typeof row.entity_version !== 'number' || typeof row.operation !== 'string' || typeof row.at !== 'string'
      ) return [];
      const snapshot = row.snapshot_json === null ? null : jsonRecord(row.snapshot_json);
      const details = row.details_json === null ? null : jsonRecord(row.details_json);
      return [{
        seq: row.seq,
        actor: row.actor,
        mutationKey: row.mutation_key,
        mutationHash: row.mutation_hash,
        entityKind: row.entity_kind,
        entityId: row.entity_id,
        entityVersion: row.entity_version,
        operation: row.operation,
        snapshot,
        details,
        at: row.at,
      } as ChangeRow];
    });
    return { changes, cursor: changes.at(-1)?.seq ?? after, resetRequired: false };
  }

  function readContext(from: string, to: string): {
    cursor: number;
    tasks: TaskWithPlan[];
    calendar: Array<Record<string, unknown>>;
    inbox: Array<{ item: InboxItemRow; draft: DraftRevision | null }>;
    jobs: Array<Record<string, unknown>>;
    actions: ActionRow[];
    freshness: SyncStateRow[];
  } {
    db.exec('BEGIN');
    try {
      const workspaceRow = db.prepare('SELECT data FROM workspace WHERE id=1').get() as Record<string, unknown> | undefined;
      const workspaceValue: unknown = typeof workspaceRow?.data === 'string' ? JSON.parse(workspaceRow.data) : null;
      const workspace = isPrototypeData(workspaceValue) ? workspaceValue : { tasks: [], events: [], inboxItems: [], reminders: [], listAreas: {} };
      const plans = new Map(listTaskPlans().map(plan => [plan.taskId, plan]));
      const actions = listActions(['queued', 'running', 'failed', 'conflict', 'unknown']);
      const actionByTask = new Map<string, ActionRow>();
      for (const action of actions) {
        const taskId = 'taskId' in action.payload && typeof action.payload.taskId === 'string'
          ? action.payload.taskId
          : null;
        if (taskId) actionByTask.set(taskId, action);
      }
      const tasks = listTasks().flatMap(task => {
        const plan = plans.get(task.id);
        if (!plan) return [];
        const legacyArea = task.binding.kind === 'legacy' && typeof task.binding.source.area === 'string'
          ? task.binding.source.area as Area
          : null;
        const listName = task.binding.kind === 'google'
          ? db.prepare(`SELECT container_name FROM provider_records WHERE provider='google' AND kind='task' AND connection_id=? AND container_id=? LIMIT 1`)
              .get(task.binding.ref.accountId, task.binding.ref.listId) as Record<string, unknown> | undefined
          : undefined;
        const area = legacyArea ?? (task.binding.kind === 'google'
          ? areaForList(workspace.listAreas, 'google', task.binding.ref.listId,
              typeof listName?.container_name === 'string' ? listName.container_name : task.binding.ref.listId)
          : 'Personal');
        return [{ task, plan, area, pendingAction: actionByTask.get(task.id) ?? null }];
      });
      const draftMap = new Map(listDrafts().map(draft => [draft.id, draft]));
      const inbox = listInboxItems().map(item => ({ item, draft: item.currentDraftId ? draftMap.get(item.currentDraftId) ?? null : null }));
      const providerCalendar = (db.prepare(`SELECT title, starts_at, ends_at, starts_on, ends_on, all_day,
        provider, connection_id, container_id, container_name, external_id, source_updated_at
        FROM provider_records WHERE kind='calendar_event' AND deleted_at IS NULL`).all() as Record<string, unknown>[])
        .flatMap(row => typeof row.title === 'string' ? [{
          title: row.title,
          startsAt: stringOrNull(row.starts_at),
          endsAt: stringOrNull(row.ends_at),
          startsOn: stringOrNull(row.starts_on),
          endsOn: stringOrNull(row.ends_on),
          allDay: row.all_day === 1,
          source: {
            provider: stringOrNull(row.provider),
            accountId: stringOrNull(row.connection_id),
            calendarId: stringOrNull(row.container_id),
            calendarName: stringOrNull(row.container_name),
            externalId: stringOrNull(row.external_id),
          },
          updatedAt: stringOrNull(row.source_updated_at),
        }] : []);
      const localCalendar = workspace.events.map(event => ({
        title: event.title,
        startsAt: typeof event.startsAt === 'string' ? event.startsAt : null,
        startsOn: typeof event.startsAt === 'string' ? null : event.date ?? null,
        allDay: false,
        source: { kind: 'local', id: event.id, taskId: event.taskId ?? null },
      }));
      const calendar = filterCalendarContextByDateRange([...providerCalendar, ...localCalendar], from, to) as Array<Record<string, unknown>>;
      const jobs = db.prepare(`SELECT * FROM jobs WHERE state<>'settled' ORDER BY updated_at DESC`).all() as Record<string, unknown>[];
      const cursorRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS cursor FROM changes').get() as Record<string, unknown>;
      const cursor = typeof cursorRow.cursor === 'number' ? cursorRow.cursor : 0;
      const freshness = listSyncStates();
      db.exec('COMMIT');
      return { cursor, tasks, calendar, inbox, jobs, actions, freshness };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function insertApprovedAction(action: ActionRow): void {
    db.prepare(`INSERT INTO actions (
      id, version, kind, task_id, inbox_id, operation_key, request_hash, payload_json, approval_json,
      state, attempt_count, next_attempt_at, claim_id, lease_until, receipt_json, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      action.id,
      action.version,
      action.payload.kind,
      'taskId' in action.payload ? action.payload.taskId : null,
      'inboxId' in action.payload ? action.payload.inboxId : null,
      action.operationKey,
      action.requestHash,
      canonicalJson(action.payload),
      canonicalJson(action.approval),
      action.state,
      action.attemptCount,
      action.nextAttemptAt,
      action.claimId,
      action.leaseUntil,
      action.receipt ? canonicalJson(action.receipt) : null,
      action.error,
      action.createdAt,
      action.updatedAt,
    );
  }

  return {
    listTasks,
    getTask,
    listTaskPlans,
    getTaskPlan,
    listInboxItems,
    getInboxItem,
    listDrafts,
    listActions,
    getAction,
    listReminders,
    listSyncStates,
    updateTaskPlan,
    updateInboxDecision,
    appendCaptureInbox,
    addLegacyProposal,
    markScopeFailed,
    publishProviderScope,
    listChanges,
    readContext,
    insertApprovedAction,
    insertChange: (input: Parameters<typeof insertChange>[1]) => insertChange(db, input),
  };
}

export type RowStore = ReturnType<typeof createRowStore>;
