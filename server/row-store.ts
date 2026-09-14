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
import {
  isUtcInstant,
  taskCreateNotes,
  type ActionRow,
  type ChangeRow,
  type DraftRevision,
  type HermesInboxUpsertInput,
  type InboxItemRow,
  type InboxOutcome,
  type InboxState,
  type Job,
  type JobOutcome,
  type JobUpdate,
  type ReminderRow,
  type ReplyEnvelope,
  type SyncStateRow,
  type TaskCreateInput,
  type TaskPlanRow,
  type TaskRow,
  type TaskWithPlan,
} from '../src/row-model.ts';
import { filterCalendarContextByDateRange } from '../src/integration-model.ts';
import type { ImportedRecord, Provider } from './store.ts';

export const ROW_SCHEMA_VERSION = 9;

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

function draftSnapshot(row: DraftRevision): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

function jobSnapshot(row: Job): Record<string, unknown> {
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

function jobFromSql(row: Record<string, unknown>): Job | null {
  if (
    typeof row.id !== 'string' || typeof row.version !== 'number' ||
    typeof row.title !== 'string' || typeof row.instruction !== 'string' ||
    !['queued', 'working', 'needs_you', 'review', 'settled'].includes(String(row.state)) ||
    typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
  ) return null;
  const outcome = row.outcome === null
    ? null
    : row.outcome === 'accepted' || row.outcome === 'dropped'
      ? row.outcome
      : undefined;
  if (outcome === undefined) return null;
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    instruction: row.instruction,
    taskId: stringOrNull(row.task_id),
    inboxId: stringOrNull(row.inbox_id),
    state: row.state as Job['state'],
    outcome,
    question: stringOrNull(row.question),
    claimId: stringOrNull(row.claim_id),
    leaseUntil: stringOrNull(row.lease_until),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jobUpdateFromSql(row: Record<string, unknown>): JobUpdate | null {
  if (
    typeof row.seq !== 'number' || typeof row.job_id !== 'string' ||
    (row.author !== 'hermes' && row.author !== 'owner') ||
    !['progress', 'question', 'answer', 'result', 'sent_back', 'settled'].includes(String(row.kind)) ||
    typeof row.text !== 'string' || typeof row.at !== 'string'
  ) return null;
  return {
    seq: row.seq,
    jobId: row.job_id,
    author: row.author,
    kind: row.kind as JobUpdate['kind'],
    text: row.text,
    url: stringOrNull(row.url),
    at: row.at,
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

function insertDraft(db: DatabaseSync, draft: DraftRevision): void {
  db.prepare(`INSERT INTO reply_drafts (id, inbox_id, revision, author, reply_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    draft.id,
    draft.inboxId,
    draft.revision,
    draft.author,
    canonicalJson(draft.reply),
    draft.createdAt,
  );
}

function replyMatchesInboxSource(reply: ReplyEnvelope, source: InboxItemRow['source']): boolean {
  return source.kind === 'email' && reply.accountId === source.accountId &&
    reply.threadId === source.threadId && reply.replyToMessageId === source.messageId;
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

function providerTaskId(accountId: string, record: ImportedRecord): string {
  return `task-google-${createHash('sha256').update(`${accountId}\0${record.containerId}\0${record.externalId}`).digest('hex').slice(0, 32)}`;
}

function hasTaskCreateMarker(notes: string | null | undefined, nonce: string): boolean {
  if (typeof notes !== 'string') return false;
  const marker = `Fox-Focus-ID: ${nonce}`;
  return notes.split(/\r\n|\r|\n/).some(line => line === marker);
}

function taskCreateSnapshotFromRecord(record: ImportedRecord, observedAt: string): TaskStatusRemoteSnapshot {
  return {
    title: record.title,
    notes: record.notes ?? null,
    state: record.status === 'completed' ? 'completed' : 'open',
    completedAt: record.completedAt,
    dueOn: record.dueOn,
    parentId: record.parentId ?? null,
    position: record.position ?? null,
    sourceUrl: record.sourceUrl,
    version: record.sourceVersion ?? null,
    updatedAt: record.sourceUpdatedAt ?? observedAt,
    completionWritable: record.completionWritable ?? true,
  };
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

export type TaskStatusRemoteSnapshot = {
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

export type TaskStatusSettlement =
  | {
      outcome: 'succeeded';
      sourceStatus: string;
      sourceVersion: string;
      sourceUpdatedAt: string | null;
      completedAt: string | null;
      current?: TaskStatusRemoteSnapshot;
    }
  | {
      outcome: 'conflict';
      notice: string;
      current: TaskStatusRemoteSnapshot | null;
    }
  | { outcome: 'failed'; notice: string; retryable: boolean };

export type TaskCreateRemoteSnapshot = Omit<TaskStatusRemoteSnapshot, 'version'> & { version: string };

export type TaskCreateCandidate = {
  externalId: string;
  title: string;
  state: 'open' | 'completed';
  dueDate: string | null;
  updatedAt: string | null;
  version: string | null;
};

export type TaskCreateSettlement =
  | { outcome: 'succeeded'; externalId: string; current: TaskCreateRemoteSnapshot }
  | { outcome: 'failed'; notice: string; retryable: boolean }
  | { outcome: 'unknown'; notice: string; candidateExternalId?: string }
  | { outcome: 'conflict'; notice: string; candidates: readonly TaskCreateCandidate[] };

export type TaskCreateClaim = {
  action: ActionRow & { payload: Extract<ActionRow['payload'], { kind: 'task-create' }> };
  mode: 'create' | 'reconcile';
};

export type TaskCreateQueueInput = TaskCreateInput & { destinationName: string; finalNotes: string };

export type TaskCreateQueueResult =
  | { outcome: 'queued' | 'replayed'; task: TaskRow; plan: TaskPlanRow; action: ActionRow; inbox: InboxItemRow | null }
  | { outcome: 'idempotency_conflict'; action: ActionRow }
  | { outcome: 'inbox_not_found'; inbox: null }
  | { outcome: 'inbox_conflict'; inbox: InboxItemRow };

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

  function wakeDueInboxItems(now: string): number {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare(`SELECT * FROM inbox_items
        WHERE state='waiting' AND outcome IS NULL AND snoozed_until IS NOT NULL AND snoozed_until<=?
        ORDER BY snoozed_until, id`).all(now) as Record<string, unknown>[];
      let count = 0;
      for (const row of rows) {
        const item = inboxRowFromSql(row);
        if (!item) continue;
        const version = item.version + 1;
        db.prepare(`UPDATE inbox_items SET version=?, state='open', snoozed_until=NULL, updated_at=?
          WHERE id=? AND version=?`).run(version, now, item.id, item.version);
        const next = getInboxItem(item.id);
        if (!next) throw new Error('Woken Inbox item disappeared');
        insertChange(db, {
          actor: 'system', mutationKey: `system:inbox-wake:${item.id}:${version}`, entityKind: 'inbox',
          entityId: item.id, entityVersion: version, operation: 'transition', snapshot: inboxSnapshot(next),
          details: { before: 'waiting', after: 'open', snoozedUntil: item.snoozedUntil }, at: now,
        });
        count += 1;
      }
      db.exec('COMMIT');
      return count;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
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

  function getDraft(id: string): DraftRevision | null {
    const row = db.prepare('SELECT * FROM reply_drafts WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? draftFromSql(row) : null;
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

  function listJobs(includeSettled = true): Job[] {
    const rows = includeSettled
      ? db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, id').all()
      : db.prepare("SELECT * FROM jobs WHERE state<>'settled' ORDER BY updated_at DESC, id").all();
    return (rows as Record<string, unknown>[]).flatMap(row => {
      const job = jobFromSql(row);
      return job ? [job] : [];
    });
  }

  function getJob(id: string): Job | null {
    const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? jobFromSql(row) : null;
  }

  function listJobUpdates(jobId?: string): JobUpdate[] {
    const rows = jobId
      ? db.prepare('SELECT * FROM job_updates WHERE job_id=? ORDER BY seq').all(jobId)
      : db.prepare('SELECT * FROM job_updates ORDER BY seq').all();
    return (rows as Record<string, unknown>[]).flatMap(row => {
      const update = jobUpdateFromSql(row);
      return update ? [update] : [];
    });
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
    if (input.outcome === 'sent' || input.outcome === 'task') return null;
    const snoozeIsValid = input.state === 'waiting'
      ? isUtcInstant(input.snoozedUntil) && Date.parse(input.snoozedUntil) > Date.parse(now)
      : input.snoozedUntil === null;
    if (!snoozeIsValid) return null;
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

  type HermesInboxUpsertResult =
    | {
        outcome: 'created' | 'updated' | 'replayed';
        item: InboxItemRow;
        draft: DraftRevision | null;
        draftOutcome: 'created' | 'updated' | 'unchanged' | 'kept_owner' | 'none';
      }
    | { outcome: 'conflict'; reason: 'idempotency' | 'version' | 'source'; item: InboxItemRow | null }
    | { outcome: 'invalid_draft'; item: InboxItemRow | null };

  function upsertHermesInbox(
    proposalKey: string,
    requestHash: string,
    input: HermesInboxUpsertInput,
    now: string,
  ): HermesInboxUpsertResult {
    const proposalMutationKey = `hermes:inbox:proposal:${proposalKey}`;
    const draftMutationKey = `hermes:inbox:draft:${proposalKey}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare('SELECT mutation_hash, entity_id, details_json FROM changes WHERE mutation_key=?')
        .get(proposalMutationKey) as Record<string, unknown> | undefined;
      if (replay) {
        const item = typeof replay.entity_id === 'string' ? getInboxItem(replay.entity_id) : null;
        if (!item) throw new Error('Inbox upsert points to a missing item');
        if (replay.mutation_hash !== requestHash) {
          db.exec('COMMIT');
          return { outcome: 'conflict', reason: 'idempotency', item };
        }
        const details = jsonRecord(replay.details_json);
        const storedDraftOutcome = details?.draftOutcome;
        const draft = item.currentDraftId ? getDraft(item.currentDraftId) : null;
        const draftOutcome = input.draft && draft?.author === 'owner'
          ? 'kept_owner'
          : storedDraftOutcome === 'created' || storedDraftOutcome === 'updated' || storedDraftOutcome === 'unchanged' ||
              storedDraftOutcome === 'kept_owner'
            ? storedDraftOutcome
            : 'none';
        db.exec('COMMIT');
        return {
          outcome: 'replayed',
          item,
          draft,
          draftOutcome,
        };
      }

      const source = input.source;
      const sourceRow = source.kind === 'email'
        ? db.prepare("SELECT * FROM inbox_items WHERE source_kind='email' AND account_id=? AND message_id=?")
            .get(source.accountId, source.messageId)
        : db.prepare("SELECT * FROM inbox_items WHERE source_kind='hermes' AND source_reference=?")
            .get(source.reference);
      const current = sourceRow ? inboxRowFromSql(sourceRow as Record<string, unknown>) : null;
      if (current?.source.kind === 'email' && source.kind === 'email' && current.source.threadId !== source.threadId) {
        db.exec('COMMIT');
        return { outcome: 'conflict', reason: 'source', item: current };
      }
      if ((current === null) !== (input.expectedVersion === null) ||
        (current !== null && current.version !== input.expectedVersion)) {
        db.exec('COMMIT');
        return { outcome: 'conflict', reason: 'version', item: current };
      }
      if (input.draft && !replyMatchesInboxSource(input.draft, source)) {
        db.exec('COMMIT');
        return { outcome: 'invalid_draft', item: current };
      }

      const id = current?.id ?? `inbox-${randomUUID()}`;
      const previousDraft = current?.currentDraftId ? getDraft(current.currentDraftId) : null;
      let draft: DraftRevision | null = previousDraft;
      let draftOutcome: 'created' | 'updated' | 'unchanged' | 'kept_owner' | 'none' = 'none';
      if (input.draft) {
        if (previousDraft?.author === 'owner') {
          draftOutcome = 'kept_owner';
        } else if (previousDraft && canonicalJson(previousDraft.reply) === canonicalJson(input.draft)) {
          draftOutcome = 'unchanged';
        } else {
          const revisionRow = db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM reply_drafts WHERE inbox_id=?')
            .get(id) as Record<string, unknown>;
          const revision = typeof revisionRow.revision === 'number' ? revisionRow.revision + 1 : 1;
          draft = {
            id: `draft-${randomUUID()}`,
            inboxId: id,
            revision,
            author: 'hermes',
            reply: input.draft,
            createdAt: now,
          };
          draftOutcome = current ? 'updated' : 'created';
        }
      }

      const item: InboxItemRow = current
        ? {
            ...current,
            version: current.version + 1,
            title: input.title,
            summary: input.summary,
            likelyNoise: input.likelyNoise,
            currentDraftId: draft?.id ?? current.currentDraftId,
            updatedAt: now,
          }
        : {
            id,
            version: 1,
            source,
            title: input.title,
            summary: input.summary,
            state: 'open',
            outcome: null,
            taskId: null,
            currentDraftId: draft?.id ?? null,
            likelyNoise: input.likelyNoise,
            snoozedUntil: null,
            createdAt: now,
            updatedAt: now,
          };

      if (current) {
        db.prepare(`UPDATE inbox_items SET version=?, title=?, summary=?, current_draft_id=?, likely_noise=?, updated_at=?
          WHERE id=? AND version=?`).run(
          item.version,
          item.title,
          item.summary,
          item.currentDraftId,
          item.likelyNoise ? 1 : 0,
          item.updatedAt,
          item.id,
          current.version,
        );
      } else {
        insertInbox(db, item);
      }
      if (draft && draft.id !== previousDraft?.id) {
        insertDraft(db, draft);
        insertChange(db, {
          actor: 'hermes', mutationKey: draftMutationKey, entityKind: 'draft', entityId: draft.id,
          entityVersion: draft.revision, operation: 'upsert', snapshot: draftSnapshot(draft),
          details: { inboxId: item.id }, at: now,
        });
      }
      insertChange(db, {
        actor: 'hermes', mutationKey: proposalMutationKey, mutationHash: requestHash, entityKind: 'inbox', entityId: item.id,
        entityVersion: item.version, operation: current ? 'transition' : 'upsert', snapshot: inboxSnapshot(item),
        details: { proposalKey, draftOutcome }, at: now,
      });
      db.exec('COMMIT');
      return { outcome: current ? 'updated' : 'created', item, draft, draftOutcome };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function appendOwnerDraft(
    inboxId: string,
    expectedVersion: number,
    reply: ReplyEnvelope,
    now: string,
  ):
    | { outcome: 'updated'; item: InboxItemRow; draft: DraftRevision }
    | { outcome: 'not_found'; item: null }
    | { outcome: 'conflict' | 'not_email'; item: InboxItemRow } {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getInboxItem(inboxId);
      if (!current) {
        db.exec('COMMIT');
        return { outcome: 'not_found', item: null };
      }
      if (current.version !== expectedVersion) {
        db.exec('COMMIT');
        return { outcome: 'conflict', item: current };
      }
      if (!replyMatchesInboxSource(reply, current.source)) {
        db.exec('COMMIT');
        return { outcome: 'not_email', item: current };
      }
      const revisionRow = db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM reply_drafts WHERE inbox_id=?')
        .get(inboxId) as Record<string, unknown>;
      const revision = typeof revisionRow.revision === 'number' ? revisionRow.revision + 1 : 1;
      const draft: DraftRevision = {
        id: `draft-${randomUUID()}`,
        inboxId,
        revision,
        author: 'owner',
        reply,
        createdAt: now,
      };
      insertDraft(db, draft);
      const version = current.version + 1;
      db.prepare('UPDATE inbox_items SET version=?, current_draft_id=?, updated_at=? WHERE id=? AND version=?')
        .run(version, draft.id, now, inboxId, expectedVersion);
      const item = getInboxItem(inboxId);
      if (!item) throw new Error('Inbox item disappeared after draft update');
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:draft:${draft.id}`, entityKind: 'draft', entityId: draft.id,
        entityVersion: draft.revision, operation: 'upsert', snapshot: draftSnapshot(draft),
        details: { inboxId }, at: now,
      });
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:inbox-draft:${inboxId}:${version}`, entityKind: 'inbox', entityId: inboxId,
        entityVersion: version, operation: 'transition', snapshot: inboxSnapshot(item),
        details: { beforeDraftId: current.currentDraftId, afterDraftId: draft.id }, at: now,
      });
      db.exec('COMMIT');
      return { outcome: 'updated', item, draft };
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

  function transitionTaskCreateAction(
    action: ActionRow & { payload: Extract<ActionRow['payload'], { kind: 'task-create' }> },
    state: 'succeeded' | 'failed' | 'conflict' | 'unknown',
    now: string,
    receipt: Record<string, unknown> | null,
    error: string | null,
    nextAttemptAt: string | null = null,
    actor: 'provider' | 'system' = 'system',
  ): ActionRow {
    const version = action.version + 1;
    db.prepare(`UPDATE actions SET version=?, state=?, next_attempt_at=?, claim_id=NULL, lease_until=NULL,
      receipt_json=?, error=?, updated_at=? WHERE id=? AND version=?`).run(
      version, state, nextAttemptAt, receipt ? canonicalJson(receipt) : null, error, now, action.id, action.version,
    );
    const next = getAction(action.id);
    if (!next) throw new Error('Task create action disappeared');
    insertChange(db, {
      actor, mutationKey: `${actor}:task-create-action:${action.id}:${version}`, entityKind: 'action',
      entityId: action.id, entityVersion: version, operation: 'transition', snapshot: actionSnapshot(next),
      details: { before: action.state, after: state }, at: now,
    });
    return next;
  }

  function bindCreatedTask(
    action: ActionRow & { payload: Extract<ActionRow['payload'], { kind: 'task-create' }> },
    externalId: string,
    current: TaskStatusRemoteSnapshot,
    now: string,
    via: 'worker' | 'snapshot',
    forceConflict: string | null = null,
  ): ActionRow {
    const task = getTask(action.payload.taskId);
    if (!task) {
      return transitionTaskCreateAction(action, 'conflict', now, null, 'The pending task no longer exists.', null, 'provider');
    }
    const occupiedRow = db.prepare(`SELECT * FROM tasks WHERE binding_kind='google' AND account_id=? AND list_id=? AND external_id=?`)
      .get(action.payload.destination.accountId, action.payload.destination.listId, externalId) as Record<string, unknown> | undefined;
    const occupied = occupiedRow ? taskRowFromSql(occupiedRow) : null;
    if (occupied && occupied.id !== task.id) {
      return transitionTaskCreateAction(action, 'conflict', now, {
        providerId: externalId, matchingTaskId: occupied.id, verifiedAt: now, via,
      }, 'The created Google task is already bound to another Fox Focus row.', null, 'provider');
    }
    if (task.binding.kind !== 'pending' && !(
      task.binding.kind === 'google' && task.binding.ref.accountId === action.payload.destination.accountId &&
      task.binding.ref.listId === action.payload.destination.listId && task.binding.ref.externalId === externalId
    )) {
      return transitionTaskCreateAction(action, 'conflict', now, { providerId: externalId, verifiedAt: now, via },
        'The pending task binding changed before creation was confirmed.', null, 'provider');
    }

    const syncRow = db.prepare(`SELECT container_name, connection_generation FROM sync_state
      WHERE provider='google' AND resource_kind='task-list' AND account_id=?
        AND container_id=? AND state='fresh' AND successful_fetch_at IS NOT NULL`).get(
      action.payload.destination.accountId,
      action.payload.destination.listId,
    ) as Record<string, unknown> | undefined;
    const destinationUnavailable = via === 'worker' && !syncRow;
    const observed: NonNullable<TaskRow['observed']> = {
      title: current.title,
      notes: current.notes,
      status: current.state,
      completedAt: current.completedAt,
      doOn: current.dueOn,
      parentId: current.parentId,
      position: current.position,
      sourceUrl: current.sourceUrl,
      etag: current.version,
      observedAt: current.updatedAt ?? now,
      completionWritable: current.completionWritable,
    };
    const taskVersion = task.version + 1;
    db.prepare(`UPDATE tasks SET version=?, binding_kind='google', account_id=?, list_id=?, external_id=?,
      create_action_id=NULL, legacy_source_json=NULL, title=?, notes=?, status=?, completed_at=?, do_on=?,
      parent_id=?, position=?, source_url=?, etag=?, observed_at=?, completion_writable=?, unavailable_at=?,
      updated_at=? WHERE id=? AND version=?`).run(
      taskVersion,
      action.payload.destination.accountId,
      action.payload.destination.listId,
      externalId,
      observed.title,
      observed.notes,
      observed.status,
      observed.completedAt,
      observed.doOn,
      observed.parentId,
      observed.position,
      observed.sourceUrl,
      observed.etag,
      observed.observedAt,
      observed.completionWritable ? 1 : 0,
      destinationUnavailable ? now : null,
      now,
      task.id,
      task.version,
    );
    const bound = getTask(task.id);
    if (!bound) throw new Error('Bound task disappeared');

    if (typeof syncRow?.connection_generation === 'string') {
      db.prepare(`INSERT INTO provider_records (
        provider, account_id, connection_id, kind, container_id, container_name, external_id, title, status,
        starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at,
        source_version, completion_writable, source_url, source_time_zone, notes, parent_id, position,
        imported_at, sync_marker, deleted_at
      ) VALUES ('google', ?, ?, 'task', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(provider, kind, account_id, container_id, external_id) DO UPDATE SET
        connection_id=excluded.connection_id, container_name=excluded.container_name, title=excluded.title,
        status=excluded.status, due_on=excluded.due_on, completed_at=excluded.completed_at,
        source_updated_at=excluded.source_updated_at, source_version=excluded.source_version,
        completion_writable=excluded.completion_writable, source_url=excluded.source_url, notes=excluded.notes,
        parent_id=excluded.parent_id, position=excluded.position, imported_at=excluded.imported_at,
        deleted_at=excluded.deleted_at`).run(
        action.payload.destination.accountId,
        syncRow.connection_generation,
        action.payload.destination.listId,
        typeof syncRow.container_name === 'string' ? syncRow.container_name : action.payload.destination.listId,
        externalId,
        observed.title,
        observed.status === 'completed' ? 'completed' : 'needsAction',
        observed.doOn,
        observed.completedAt,
        observed.observedAt,
        observed.etag,
        observed.completionWritable ? 1 : 0,
        observed.sourceUrl,
        observed.notes,
        observed.parentId,
        observed.position,
        now,
        randomUUID(),
      );
    }
    insertChange(db, {
      actor: 'provider', mutationKey: `provider:task-create-bind:${task.id}:${taskVersion}`, entityKind: 'task',
      entityId: task.id, entityVersion: taskVersion, operation: 'transition', snapshot: taskSnapshot(bound),
      details: { actionId: action.id, externalId, via, destinationUnavailable }, at: now,
    });

    const conflict = forceConflict ?? (destinationUnavailable
      ? 'The destination list disappeared while Google task creation was being confirmed.'
      : null);
    return transitionTaskCreateAction(
      action,
      conflict ? 'conflict' : 'succeeded',
      now,
      { providerId: externalId, verifiedAt: now, sourceVersion: current.version, via, destinationUnavailable },
      conflict,
      null,
      'provider',
    );
  }

  function retireProviderAccount(provider: Provider, accountId: string, now: string): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (provider === 'google') {
        const taskRows = db.prepare(`SELECT * FROM tasks
          WHERE binding_kind='google' AND account_id=? AND unavailable_at IS NULL`).all(accountId) as Record<string, unknown>[];
        for (const row of taskRows) {
          const task = taskRowFromSql(row);
          if (!task) continue;
          const version = task.version + 1;
          db.prepare('UPDATE tasks SET version=?, unavailable_at=?, updated_at=? WHERE id=? AND version=?')
            .run(version, now, now, task.id, task.version);
          const next = getTask(task.id);
          if (!next) throw new Error('Retired task disappeared');
          insertChange(db, {
            actor: 'provider', mutationKey: `provider:${accountId}:${task.id}:account-retired:${version}`,
            entityKind: 'task', entityId: task.id, entityVersion: version, operation: 'transition',
            snapshot: taskSnapshot(next), details: { unavailable: true, accountReauthorized: true }, at: now,
          });
        }
      }

      const calendarRows = db.prepare(`SELECT container_id, external_id FROM provider_records
        WHERE provider=? AND account_id=? AND kind='calendar_event' AND deleted_at IS NULL`)
        .all(provider, accountId) as Record<string, unknown>[];
      for (const row of calendarRows) {
        if (typeof row.container_id !== 'string' || typeof row.external_id !== 'string') continue;
        const entityId = `${provider}:${accountId}:${row.container_id}:${row.external_id}`;
        const versionRow = db.prepare(`SELECT COALESCE(MAX(entity_version), 0) AS version FROM changes
          WHERE entity_kind='calendar' AND entity_id=?`).get(entityId) as Record<string, unknown>;
        const version = (typeof versionRow.version === 'number' ? versionRow.version : 0) + 1;
        insertChange(db, {
          actor: 'provider', mutationKey: `provider-calendar:${entityId}:${version}`,
          entityKind: 'calendar', entityId, entityVersion: version, operation: 'remove', snapshot: null,
          details: { accountReauthorized: true }, at: now,
        });
      }
      db.prepare('DELETE FROM provider_records WHERE provider=? AND account_id=?').run(provider, accountId);
      db.prepare('DELETE FROM sync_state WHERE provider=? AND account_id=?').run(provider, accountId);
      db.exec('COMMIT');
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
        provider, account_id, connection_id, kind, container_id, container_name, external_id, title, status,
        starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at, source_version,
        completion_writable, source_url, source_time_zone, imported_at, sync_marker, deleted_at,
        notes, parent_id, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(provider, kind, account_id, container_id, external_id) DO UPDATE SET
        connection_id=excluded.connection_id, container_name=excluded.container_name, title=excluded.title,
        status=excluded.status, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
        starts_on=excluded.starts_on, ends_on=excluded.ends_on, all_day=excluded.all_day,
        due_on=excluded.due_on, completed_at=excluded.completed_at, source_updated_at=excluded.source_updated_at,
        source_version=excluded.source_version, completion_writable=excluded.completion_writable,
        source_url=excluded.source_url, source_time_zone=excluded.source_time_zone, imported_at=excluded.imported_at,
        sync_marker=excluded.sync_marker, deleted_at=NULL, notes=excluded.notes, parent_id=excluded.parent_id,
        position=excluded.position`);

      if (input.provider === 'google' && input.resourceKind === 'task-list') {
        const pendingRows = db.prepare(`SELECT actions.* FROM actions
          JOIN tasks ON tasks.id=actions.task_id AND tasks.binding_kind='pending'
          WHERE actions.kind='task-create' AND actions.state IN ('running', 'unknown')
            AND tasks.account_id=? AND tasks.list_id=?`).all(input.accountId, input.containerId) as Record<string, unknown>[];
        for (const row of pendingRows) {
          const parsed = actionFromSql(row);
          if (!parsed || parsed.payload.kind !== 'task-create') continue;
          const action = parsed as ActionRow & { payload: Extract<ActionRow['payload'], { kind: 'task-create' }> };
          const matches = input.records.filter(record => record.provider === 'google' && record.kind === 'task' &&
            record.containerId === input.containerId &&
            hasTaskCreateMarker(record.notes, action.payload.nonce));
          if (matches.length > 1) {
            transitionTaskCreateAction(action, 'conflict', input.fetchedAt, {
              candidates: matches.map(record => ({
                externalId: record.externalId,
                title: record.title,
                state: record.status === 'completed' ? 'completed' : 'open',
                dueDate: record.dueOn,
                updatedAt: record.sourceUpdatedAt,
                version: record.sourceVersion ?? null,
              })),
              verifiedAt: input.fetchedAt,
              via: 'snapshot',
            }, 'More than one Google task has the create nonce. Review the candidates.', null, 'provider');
            continue;
          }
          const match = matches[0];
          if (!match) continue;
          const current = taskCreateSnapshotFromRecord(match, input.fetchedAt);
          const unsafeReadback = current.version === null || !current.completionWritable ||
            (current.state === 'open' && current.completedAt !== null);
          const changed = current.state !== 'open' || current.completedAt !== null ||
            current.title !== action.payload.title || current.notes !== action.payload.notes ||
            current.dueOn !== action.payload.doOn;
          const conflict = unsafeReadback
            ? 'The nonce-matched Google task cannot be safely updated. Review it.'
            : changed
              ? 'The nonce-matched Google task changed before creation was confirmed. Review it.'
              : null;
          bindCreatedTask(action, match.externalId, current, input.fetchedAt, 'snapshot', conflict);
        }
      }
      for (const record of input.records) {
        const previousProvider = db.prepare(`SELECT title, status, starts_at, ends_at, starts_on, ends_on,
          all_day, due_on, completed_at, source_updated_at, source_version, source_url, notes, parent_id, position
          FROM provider_records WHERE provider=? AND kind=? AND account_id=? AND container_id=? AND external_id=?`)
          .get(record.provider, record.kind, input.accountId, record.containerId, record.externalId) as Record<string, unknown> | undefined;
        upsertProvider.run(
          record.provider, input.accountId, input.connectionGeneration, record.kind, record.containerId, record.containerName,
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
            const entityId = `${record.provider}:${input.accountId}:${record.containerId}:${record.externalId}`;
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
              actor: 'provider', mutationKey: `provider:${input.accountId}:${record.containerId}:${record.externalId}:bind:${version}`,
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
            actor: 'provider', mutationKey: `provider:${input.accountId}:${record.containerId}:${record.externalId}:${version}`,
            entityKind: 'task', entityId: existing.id, entityVersion: version, operation: 'upsert',
            snapshot: taskSnapshot(next), details: { scope: scopeKey(input) }, at: input.fetchedAt,
          });
        } else {
          const task: TaskRow = {
            id: providerTaskId(input.accountId, record),
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
            actor: 'provider', mutationKey: `provider:${input.accountId}:${record.containerId}:${record.externalId}:1`,
            entityKind: 'task', entityId: task.id, entityVersion: 1, operation: 'upsert',
            snapshot: taskSnapshot(task), details: { scope: scopeKey(input) }, at: input.fetchedAt,
          });
          insertChange(db, {
            actor: 'provider', mutationKey: `provider:${input.accountId}:${record.containerId}:${record.externalId}:plan:1`,
            entityKind: 'task-plan', entityId: task.id, entityVersion: 1, operation: 'upsert',
            snapshot: planSnapshot(plan), details: { default: true }, at: input.fetchedAt,
          });
        }
      }

      const providerKind = input.resourceKind === 'task-list' ? 'task' : 'calendar_event';
      const absentRows = db.prepare(`SELECT external_id FROM provider_records
        WHERE provider=? AND kind=? AND account_id=? AND container_id=? AND sync_marker<>?`).all(
        input.provider, providerKind, input.accountId, input.containerId, marker,
      ) as Record<string, unknown>[];
      db.prepare(`DELETE FROM provider_records
        WHERE provider=? AND kind=? AND account_id=? AND container_id=? AND sync_marker<>?`).run(
        input.provider, providerKind, input.accountId, input.containerId, marker,
      );
      if (input.resourceKind === 'calendar') {
        for (const absent of absentRows) {
          if (typeof absent.external_id !== 'string') continue;
          const entityId = `${input.provider}:${input.accountId}:${input.containerId}:${absent.external_id}`;
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
            actor: 'provider', mutationKey: `provider:${input.accountId}:${input.containerId}:${task.id}:unavailable:${version}`,
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
    jobs: Job[];
    jobUpdates: JobUpdate[];
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
        const googleRef = task.binding.kind === 'google' ? task.binding.ref
          : task.binding.kind === 'pending' ? task.binding.destination : null;
        const listName = googleRef
          ? db.prepare(`SELECT container_name FROM sync_state
              WHERE provider='google' AND resource_kind='task-list' AND account_id=? AND container_id=? LIMIT 1`)
              .get(googleRef.accountId, googleRef.listId) as Record<string, unknown> | undefined
          : undefined;
        const area = legacyArea ?? (googleRef
          ? areaForList(workspace.listAreas, 'google', googleRef.listId,
              typeof listName?.container_name === 'string' ? listName.container_name : googleRef.listId)
          : 'Personal');
        return [{ task, plan, area, pendingAction: actionByTask.get(task.id) ?? null }];
      });
      const draftMap = new Map(listDrafts().map(draft => [draft.id, draft]));
      const inbox = listInboxItems().map(item => ({ item, draft: item.currentDraftId ? draftMap.get(item.currentDraftId) ?? null : null }));
      const providerCalendar = (db.prepare(`SELECT title, starts_at, ends_at, starts_on, ends_on, all_day,
        provider, account_id, container_id, container_name, external_id, source_updated_at
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
            accountId: stringOrNull(row.account_id),
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
      const jobs = listJobs(false);
      const jobIds = new Set(jobs.map(job => job.id));
      const jobUpdates = listJobUpdates().filter(update => jobIds.has(update.jobId));
      const cursorRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS cursor FROM changes').get() as Record<string, unknown>;
      const cursor = typeof cursorRow.cursor === 'number' ? cursorRow.cursor : 0;
      const freshness = listSyncStates();
      db.exec('COMMIT');
      return { cursor, tasks, calendar, inbox, jobs, jobUpdates, actions, freshness };
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

  function queueTaskCreateAction(input: TaskCreateQueueInput, now: string): TaskCreateQueueResult {
    if (input.finalNotes !== taskCreateNotes(input.notes, input.nonce) || input.finalNotes.length > 8_192) {
      throw new Error('Invalid task create notes');
    }
    const operationKey = `task-create:${input.nonce}`;
    const taskId = `task-create-${createHash('sha256').update(input.nonce).digest('hex').slice(0, 32)}`;
    const actionId = randomUUID();
    const payload: Extract<ActionRow['payload'], { kind: 'task-create' }> = {
      kind: 'task-create',
      taskId,
      destination: input.destination,
      nonce: input.nonce,
      title: input.title.trim(),
      notes: input.finalNotes,
      doOn: input.doOn,
    };
    const requestHash = canonicalHash({ payload, plan: input.plan, inbox: input.inbox ?? null });

    db.exec('BEGIN IMMEDIATE');
    try {
      const existingRow = db.prepare('SELECT * FROM actions WHERE operation_key=?').get(operationKey) as Record<string, unknown> | undefined;
      const existing = existingRow ? actionFromSql(existingRow) : null;
      if (existing) {
        if (existing.requestHash !== requestHash || existing.payload.kind !== 'task-create') {
          db.exec('COMMIT');
          return { outcome: 'idempotency_conflict', action: existing };
        }
        const task = getTask(existing.payload.taskId);
        const plan = task ? getTaskPlan(task.id) : null;
        if (!task || !plan) throw new Error('Task create replay points to missing rows');
        const inbox = task.originInboxId ? getInboxItem(task.originInboxId) : null;
        db.exec('COMMIT');
        return { outcome: 'replayed', task, plan, action: existing, inbox };
      }

      let inbox: InboxItemRow | null = null;
      if (input.inbox) {
        inbox = getInboxItem(input.inbox.id);
        if (!inbox) {
          db.exec('COMMIT');
          return { outcome: 'inbox_not_found', inbox: null };
        }
        if (inbox.version !== input.inbox.version || inbox.state === 'resolved') {
          db.exec('COMMIT');
          return { outcome: 'inbox_conflict', inbox };
        }
      }

      const task: TaskRow = {
        id: taskId,
        version: 1,
        binding: { kind: 'pending', destination: input.destination, createActionId: actionId },
        observed: null,
        unavailableAt: null,
        intentVersion: 0,
        originInboxId: inbox?.id ?? null,
        createdAt: now,
        updatedAt: now,
      };
      const plan: TaskPlanRow = {
        taskId,
        version: 1,
        ...input.plan,
        createdAt: now,
        updatedAt: now,
      };
      const previewLines = [
        `Create Google task in account ${input.destination.accountId}, list "${input.destinationName}" (${input.destination.listId}).`,
        `Title: ${payload.title}`,
        `Notes: ${payload.notes}`,
        `Due: ${payload.doOn ?? 'none'}`,
      ];
      const action: ActionRow = {
        id: actionId,
        version: 1,
        payload,
        operationKey,
        requestHash,
        approval: { actor: 'owner', at: now, previewText: previewLines.join('\n') },
        state: 'queued',
        attemptCount: 0,
        nextAttemptAt: now,
        claimId: null,
        leaseUntil: null,
        receipt: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      insertTask(db, task);
      insertPlan(db, plan);
      insertApprovedAction(action);
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:task-create:${task.id}:1`, entityKind: 'task', entityId: task.id,
        entityVersion: 1, operation: 'upsert', snapshot: taskSnapshot(task),
        details: { actionId: action.id, destination: input.destination }, at: now,
      });
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:task-create-plan:${task.id}:1`, entityKind: 'task-plan', entityId: task.id,
        entityVersion: 1, operation: 'upsert', snapshot: planSnapshot(plan),
        details: { actionId: action.id }, at: now,
      });
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:action:${action.id}:1`, entityKind: 'action', entityId: action.id,
        entityVersion: 1, operation: 'upsert', snapshot: actionSnapshot(action),
        details: { destinationName: input.destinationName, clickApproval: true }, at: now,
      });

      if (inbox) {
        const version = inbox.version + 1;
        db.prepare(`UPDATE inbox_items SET version=?, state='resolved', outcome='task', task_id=?,
          snoozed_until=NULL, updated_at=? WHERE id=? AND version=?`).run(version, task.id, now, inbox.id, inbox.version);
        const resolved = getInboxItem(inbox.id);
        if (!resolved) throw new Error('Resolved Inbox item disappeared');
        insertChange(db, {
          actor: 'owner', mutationKey: `owner:inbox-task:${inbox.id}:${version}`, entityKind: 'inbox', entityId: inbox.id,
          entityVersion: version, operation: 'transition', snapshot: inboxSnapshot(resolved),
          details: { before: inbox.state, after: 'resolved', outcome: 'task', taskId: task.id }, at: now,
        });
        inbox = resolved;
      }

      db.exec('COMMIT');
      return { outcome: 'queued', task, plan, action, inbox };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function addJobUpdate(
    jobId: string,
    author: JobUpdate['author'],
    kind: JobUpdate['kind'],
    text: string,
    url: string | null,
    at: string,
  ): JobUpdate {
    const result = db.prepare(`INSERT INTO job_updates (job_id, author, kind, text, url, at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(jobId, author, kind, text, url, at);
    return { seq: Number(result.lastInsertRowid), jobId, author, kind, text, url, at };
  }

  function createJob(
    input: { title: string; instruction: string; taskId: string | null; inboxId: string | null },
    now: string,
    idempotencyKey: string = randomUUID(),
  ):
    | { outcome: 'created'; job: Job }
    | { outcome: 'replayed'; job: Job }
    | { outcome: 'idempotency_conflict'; job: Job }
    | { outcome: 'missing_task' | 'missing_inbox'; job: null } {
    const requestHash = canonicalHash(input);
    const mutationKey = `owner:job-create:${createHash('sha256').update(idempotencyKey).digest('base64url')}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare('SELECT mutation_hash, entity_id FROM changes WHERE mutation_key=?')
        .get(mutationKey) as Record<string, unknown> | undefined;
      if (replay) {
        const job = typeof replay.entity_id === 'string' ? getJob(replay.entity_id) : null;
        if (!job) throw new Error('Job creation replay points to a missing job');
        db.exec('COMMIT');
        return replay.mutation_hash === requestHash
          ? { outcome: 'replayed', job }
          : { outcome: 'idempotency_conflict', job };
      }
      if (input.taskId && !getTask(input.taskId)) {
        db.exec('COMMIT');
        return { outcome: 'missing_task', job: null };
      }
      if (input.inboxId && !getInboxItem(input.inboxId)) {
        db.exec('COMMIT');
        return { outcome: 'missing_inbox', job: null };
      }
      const job: Job = {
        id: `job-${randomUUID()}`,
        version: 1,
        title: input.title,
        instruction: input.instruction,
        taskId: input.taskId,
        inboxId: input.inboxId,
        state: 'queued',
        outcome: null,
        question: null,
        claimId: null,
        leaseUntil: null,
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(`INSERT INTO jobs (
        id, version, title, instruction, task_id, inbox_id, state, outcome, question,
        claim_id, lease_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`).run(
        job.id, job.version, job.title, job.instruction, job.taskId, job.inboxId, job.state,
        job.createdAt, job.updatedAt,
      );
      insertChange(db, {
        actor: 'owner', mutationKey, mutationHash: requestHash, entityKind: 'job', entityId: job.id,
        entityVersion: 1, operation: 'upsert', snapshot: jobSnapshot(job),
        details: { idempotency: true }, at: now,
      });
      db.exec('COMMIT');
      return { outcome: 'created', job };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function claimJob(id: string, now: string, leaseMilliseconds: number):
    | { outcome: 'claimed'; job: Job; claimId: string }
    | { outcome: 'not_found'; job: null }
    | { outcome: 'unavailable'; job: Job } {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getJob(id);
      if (!current) {
        db.exec('COMMIT');
        return { outcome: 'not_found', job: null };
      }
      const reclaimable = current.state === 'working' && (
        current.claimId === null || current.leaseUntil === null || current.leaseUntil <= now
      );
      if (current.state !== 'queued' && !reclaimable) {
        db.exec('COMMIT');
        return { outcome: 'unavailable', job: current };
      }
      const claimId = randomUUID();
      const leaseUntil = new Date(Date.parse(now) + leaseMilliseconds).toISOString();
      const version = current.version + 1;
      db.prepare(`UPDATE jobs SET version=?, state='working', claim_id=?, lease_until=?, updated_at=?
        WHERE id=? AND version=?`).run(version, claimId, leaseUntil, now, id, current.version);
      const job = getJob(id);
      if (!job) throw new Error('Claimed job disappeared');
      insertChange(db, {
        actor: 'hermes', mutationKey: `hermes:job-claim:${id}:${claimId}`, entityKind: 'job', entityId: id,
        entityVersion: version, operation: 'transition', snapshot: jobSnapshot(job),
        details: { before: current.state, after: 'working', reclaimed: reclaimable }, at: now,
      });
      db.exec('COMMIT');
      return { outcome: 'claimed', job, claimId };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function postJobResult(
    id: string,
    claimId: string,
    input: { kind: 'progress' | 'question' | 'result'; text: string; url: string | null },
    now: string,
    leaseMilliseconds: number,
  ):
    | { outcome: 'updated' | 'replayed'; job: Job; update: JobUpdate }
    | { outcome: 'not_found'; job: null }
    | { outcome: 'invalid_claim' | 'invalid_state'; job: Job } {
    const requestHash = canonicalHash(input);
    const mutationKey = `hermes:job-result:${id}:${claimId}:${requestHash}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare('SELECT details_json FROM changes WHERE mutation_key=?').get(mutationKey) as Record<string, unknown> | undefined;
      if (replay) {
        const details = jsonRecord(replay.details_json);
        const updateDetails = details?.update;
        const updateRecord = typeof updateDetails === 'object' && updateDetails !== null && !Array.isArray(updateDetails)
          ? updateDetails as Record<string, unknown>
          : null;
        const seq = typeof updateRecord?.seq === 'number' ? updateRecord.seq : null;
        const updateRow = seq === null ? undefined : db.prepare('SELECT * FROM job_updates WHERE seq=?').get(seq) as Record<string, unknown> | undefined;
        const update = updateRow ? jobUpdateFromSql(updateRow) : null;
        const job = getJob(id);
        if (!update || !job) throw new Error('Job result replay points to missing rows');
        db.exec('COMMIT');
        return { outcome: 'replayed', job, update };
      }
      const current = getJob(id);
      if (!current) {
        db.exec('COMMIT');
        return { outcome: 'not_found', job: null };
      }
      if (current.state !== 'working') {
        db.exec('COMMIT');
        return { outcome: 'invalid_state', job: current };
      }
      if (current.claimId !== claimId || current.leaseUntil === null || current.leaseUntil <= now) {
        db.exec('COMMIT');
        return { outcome: 'invalid_claim', job: current };
      }
      const version = current.version + 1;
      const state = input.kind === 'question' ? 'needs_you' : input.kind === 'result' ? 'review' : 'working';
      const question = input.kind === 'question' ? input.text : null;
      const releasesClaim = input.kind === 'question' || input.kind === 'result';
      const leaseUntil = releasesClaim ? null : new Date(Date.parse(now) + leaseMilliseconds).toISOString();
      const nextClaimId = releasesClaim ? null : claimId;
      db.prepare(`UPDATE jobs SET version=?, state=?, question=?, claim_id=?, lease_until=?, updated_at=?
        WHERE id=? AND version=?`).run(version, state, question, nextClaimId, leaseUntil, now, id, current.version);
      const job = getJob(id);
      if (!job) throw new Error('Updated job disappeared');
      const update = addJobUpdate(id, 'hermes', input.kind, input.text, input.url, now);
      insertChange(db, {
        actor: 'hermes', mutationKey, mutationHash: requestHash, entityKind: 'job', entityId: id,
        entityVersion: version, operation: 'transition', snapshot: jobSnapshot(job),
        details: { before: current.state, after: state, update }, at: now,
      });
      db.exec('COMMIT');
      return { outcome: 'updated', job, update };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function answerJob(id: string, expectedVersion: number, text: string, now: string):
    | { outcome: 'updated'; job: Job; update: JobUpdate }
    | { outcome: 'not_found'; job: null }
    | { outcome: 'conflict' | 'invalid_state'; job: Job } {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getJob(id);
      if (!current) {
        db.exec('COMMIT');
        return { outcome: 'not_found', job: null };
      }
      if (current.version !== expectedVersion) {
        db.exec('COMMIT');
        return { outcome: 'conflict', job: current };
      }
      if (current.state !== 'needs_you') {
        db.exec('COMMIT');
        return { outcome: 'invalid_state', job: current };
      }
      const version = current.version + 1;
      db.prepare(`UPDATE jobs SET version=?, state='working', question=NULL, claim_id=NULL,
        lease_until=NULL, updated_at=? WHERE id=? AND version=?`).run(version, now, id, current.version);
      const job = getJob(id);
      if (!job) throw new Error('Answered job disappeared');
      const update = addJobUpdate(id, 'owner', 'answer', text, null, now);
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:job-answer:${id}:${version}`, entityKind: 'job', entityId: id,
        entityVersion: version, operation: 'transition', snapshot: jobSnapshot(job),
        details: { before: 'needs_you', after: 'working', update }, at: now,
      });
      db.exec('COMMIT');
      return { outcome: 'updated', job, update };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function sendBackJob(id: string, expectedVersion: number, text: string, now: string):
    | { outcome: 'updated'; job: Job; update: JobUpdate }
    | { outcome: 'not_found'; job: null }
    | { outcome: 'conflict' | 'invalid_state'; job: Job } {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getJob(id);
      if (!current) {
        db.exec('COMMIT');
        return { outcome: 'not_found', job: null };
      }
      if (current.version !== expectedVersion) {
        db.exec('COMMIT');
        return { outcome: 'conflict', job: current };
      }
      if (current.state !== 'review') {
        db.exec('COMMIT');
        return { outcome: 'invalid_state', job: current };
      }
      const version = current.version + 1;
      db.prepare(`UPDATE jobs SET version=?, state='queued', outcome=NULL, question=NULL,
        claim_id=NULL, lease_until=NULL, updated_at=? WHERE id=? AND version=?`).run(
        version, now, id, current.version,
      );
      const job = getJob(id);
      if (!job) throw new Error('Returned job disappeared');
      const update = addJobUpdate(id, 'owner', 'sent_back', text, null, now);
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:job-send-back:${id}:${version}`, entityKind: 'job', entityId: id,
        entityVersion: version, operation: 'transition', snapshot: jobSnapshot(job),
        details: { before: 'review', after: 'queued', update }, at: now,
      });
      db.exec('COMMIT');
      return { outcome: 'updated', job, update };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function settleJob(
    id: string,
    expectedVersion: number,
    outcome: JobOutcome,
    now: string,
    taskVersion?: number,
  ):
    | { outcome: 'settled'; job: Job; update: JobUpdate; action: ActionRow | null }
    | { outcome: 'not_found'; job: null }
    | { outcome: 'conflict' | 'invalid_state'; job: Job }
    | { outcome: 'task_not_found'; job: Job }
    | { outcome: 'task_conflict' | 'task_read_only' | 'task_version_required'; job: Job; task: TaskRow } {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getJob(id);
      if (!current) {
        db.exec('COMMIT');
        return { outcome: 'not_found', job: null };
      }
      if (current.version !== expectedVersion) {
        db.exec('COMMIT');
        return { outcome: 'conflict', job: current };
      }
      if (current.state !== 'review') {
        db.exec('COMMIT');
        return { outcome: 'invalid_state', job: current };
      }

      let action: ActionRow | null = null;
      if (outcome === 'accepted' && current.taskId) {
        const task = getTask(current.taskId);
        if (!task) {
          db.exec('COMMIT');
          return { outcome: 'task_not_found', job: current };
        }
        const runningReopen = (db.prepare(`SELECT * FROM actions
          WHERE task_id=? AND kind='task-status' AND state='running'`).all(task.id) as Record<string, unknown>[])
          .some(row => {
            const running = actionFromSql(row);
            return running?.payload.kind === 'task-status' && running.payload.after === 'open';
          });
        if (runningReopen) {
          db.exec('COMMIT');
          return { outcome: 'task_conflict', job: current, task };
        }
        const contradictoryIntent = (db.prepare(`SELECT * FROM actions
          WHERE task_id=? AND kind='task-status' AND state IN ('queued', 'failed')`).all(task.id) as Record<string, unknown>[])
          .some(row => {
            const pending = actionFromSql(row);
            return pending?.payload.kind === 'task-status' && pending.payload.after !== 'completed';
          });
        if (task.observed?.status !== 'completed' || contradictoryIntent) {
          if (taskVersion === undefined) {
            db.exec('COMMIT');
            return { outcome: 'task_version_required', job: current, task };
          }
          const queued = queueTaskStatusActionInTransaction(current.taskId, taskVersion, 'completed', now);
          if (queued.outcome !== 'queued') {
            db.exec('ROLLBACK');
            return queued.outcome === 'not_found'
              ? { outcome: 'task_not_found', job: current }
              : { outcome: queued.outcome === 'conflict' ? 'task_conflict' : 'task_read_only', job: current, task: queued.task };
          }
          action = queued.action;
        }
      }

      const version = current.version + 1;
      db.prepare(`UPDATE jobs SET version=?, state='settled', outcome=?, question=NULL,
        claim_id=NULL, lease_until=NULL, updated_at=? WHERE id=? AND version=?`).run(
        version, outcome, now, id, current.version,
      );
      const job = getJob(id);
      if (!job) throw new Error('Settled job disappeared');
      const text = outcome === 'accepted' ? 'Accepted' : 'Dropped';
      const update = addJobUpdate(id, 'owner', 'settled', text, null, now);
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:job-settle:${id}:${version}`, entityKind: 'job', entityId: id,
        entityVersion: version, operation: 'transition', snapshot: jobSnapshot(job),
        details: { before: current.state, after: 'settled', outcome, actionId: action?.id ?? null, update }, at: now,
      });
      db.exec('COMMIT');
      return { outcome: 'settled', job, update, action };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function queueTaskStatusActionInTransaction(
    taskId: string,
    expectedTaskVersion: number,
    desiredState: 'open' | 'completed',
    now: string,
  ):
    | { outcome: 'queued'; action: ActionRow; task: TaskRow }
    | { outcome: 'not_found'; task: null }
    | { outcome: 'read_only'; task: TaskRow }
    | { outcome: 'conflict'; task: TaskRow } {
    const task = getTask(taskId);
    if (!task) return { outcome: 'not_found', task: null };
    if (task.version !== expectedTaskVersion) return { outcome: 'conflict', task };
    if (task.binding.kind !== 'google' || !task.observed || !task.observed.completionWritable || task.unavailableAt) {
      return { outcome: 'read_only', task };
    }

    const obsoleteRows = db.prepare(`SELECT * FROM actions
      WHERE task_id=? AND kind='task-status' AND state IN ('queued', 'failed')`).all(taskId) as Record<string, unknown>[];
    for (const row of obsoleteRows) {
      const obsolete = actionFromSql(row);
      if (!obsolete) continue;
      const version = obsolete.version + 1;
      db.prepare(`UPDATE actions SET version=?, state='superseded', next_attempt_at=NULL,
        claim_id=NULL, lease_until=NULL, error=?, updated_at=? WHERE id=?`).run(
        version, 'A newer owner status intent replaced this action.', now, obsolete.id,
      );
      const superseded = getAction(obsolete.id);
      if (!superseded) throw new Error('Superseded action disappeared');
      insertChange(db, {
        actor: 'owner', mutationKey: `owner:action:${obsolete.id}:${version}`, entityKind: 'action',
        entityId: obsolete.id, entityVersion: version, operation: 'transition', snapshot: actionSnapshot(superseded),
        details: { before: obsolete.state, after: 'superseded', replacedByIntent: task.intentVersion + 1 }, at: now,
      });
    }

    const intentVersion = task.intentVersion + 1;
    const nextTaskVersion = task.version + 1;
    db.prepare('UPDATE tasks SET version=?, intent_version=?, updated_at=? WHERE id=? AND version=?')
      .run(nextTaskVersion, intentVersion, now, task.id, task.version);
    const updatedTask = getTask(task.id);
    if (!updatedTask) throw new Error('Task intent disappeared');
    const payload: ActionRow['payload'] = {
      kind: 'task-status',
      taskId: task.id,
      target: task.binding.ref,
      expectedTaskVersion: task.version,
      intentVersion,
      expectedEtag: task.observed.etag,
      before: task.observed.status,
      after: desiredState,
    };
    const action: ActionRow = {
      id: randomUUID(),
      version: 1,
      payload,
      operationKey: `task-status:${task.id}:${intentVersion}`,
      requestHash: canonicalHash(payload),
      approval: {
        actor: 'owner',
        at: now,
        previewText: `${task.observed.status} -> ${desiredState} for "${task.observed.title}" in Google Tasks account ${task.binding.ref.accountId}, list ${task.binding.ref.listId}, task ${task.binding.ref.externalId}`,
      },
      state: 'queued',
      attemptCount: 0,
      nextAttemptAt: now,
      claimId: null,
      leaseUntil: null,
      receipt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    insertApprovedAction(action);
    insertChange(db, {
      actor: 'owner', mutationKey: `owner:task-intent:${task.id}:${intentVersion}`, entityKind: 'task',
      entityId: task.id, entityVersion: updatedTask.version, operation: 'transition', snapshot: taskSnapshot(updatedTask),
      details: { observed: task.observed.status, intended: desiredState, actionId: action.id }, at: now,
    });
    insertChange(db, {
      actor: 'owner', mutationKey: `owner:action:${action.id}:1`, entityKind: 'action', entityId: action.id,
      entityVersion: 1, operation: 'upsert', snapshot: actionSnapshot(action), details: { clickApproval: true }, at: now,
    });
    return { outcome: 'queued', action, task: updatedTask };
  }

  function queueTaskStatusAction(
    taskId: string,
    expectedTaskVersion: number,
    desiredState: 'open' | 'completed',
    now: string,
  ): ReturnType<typeof queueTaskStatusActionInTransaction> {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = queueTaskStatusActionInTransaction(taskId, expectedTaskVersion, desiredState, now);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function recoverExpiredTaskCreateActions(now: string): number {
    const rows = db.prepare(`SELECT * FROM actions
      WHERE kind='task-create' AND state='running' AND lease_until IS NOT NULL AND lease_until<=?`).all(now) as Record<string, unknown>[];
    let recovered = 0;
    for (const row of rows) {
      const parsed = actionFromSql(row);
      if (!parsed || parsed.payload.kind !== 'task-create') continue;
      const action = parsed as ActionRow & { payload: Extract<ActionRow['payload'], { kind: 'task-create' }> };
      transitionTaskCreateAction(
        action,
        'unknown',
        now,
        action.receipt,
        'The create worker stopped after dispatch may have begun. Reconciliation is required before any new insert.',
        now,
      );
      recovered += 1;
    }
    return recovered;
  }

  function claimNextTaskCreateAction(now: string, leaseMilliseconds: number): TaskCreateClaim | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      recoverExpiredTaskCreateActions(now);
      const row = db.prepare(`SELECT candidate.* FROM actions AS candidate
        WHERE candidate.kind='task-create'
          AND (
            candidate.state='queued' OR candidate.state='unknown' OR
            (candidate.state='failed' AND candidate.next_attempt_at IS NOT NULL)
          )
          AND candidate.next_attempt_at IS NOT NULL AND candidate.next_attempt_at<=?
          AND NOT EXISTS (
            SELECT 1 FROM actions AS active
            WHERE active.task_id=candidate.task_id AND active.id<>candidate.id AND active.state='running'
              AND active.lease_until>?
          )
        ORDER BY candidate.created_at, candidate.id LIMIT 1`).get(now, now) as Record<string, unknown> | undefined;
      const parsed = row ? actionFromSql(row) : null;
      if (!parsed || parsed.payload.kind !== 'task-create') {
        db.exec('COMMIT');
        return null;
      }
      const action = parsed as ActionRow & { payload: Extract<ActionRow['payload'], { kind: 'task-create' }> };
      const task = getTask(action.payload.taskId);
      if (!task || task.binding.kind !== 'pending' || task.binding.createActionId !== action.id) {
        transitionTaskCreateAction(action, 'conflict', now, action.receipt,
          'The pending task changed before its create action could run.');
        db.exec('COMMIT');
        return null;
      }
      const mode = action.state === 'unknown' ? 'reconcile' as const : 'create' as const;
      const claimId = randomUUID();
      const leaseUntil = new Date(Date.parse(now) + leaseMilliseconds).toISOString();
      const version = action.version + 1;
      db.prepare(`UPDATE actions SET version=?, state='running', attempt_count=attempt_count+1,
        next_attempt_at=NULL, claim_id=?, lease_until=?, error=NULL, updated_at=? WHERE id=? AND version=?`).run(
        version, claimId, leaseUntil, now, action.id, action.version,
      );
      const claimed = getAction(action.id);
      if (!claimed || claimed.payload.kind !== 'task-create') throw new Error('Claimed task create disappeared');
      insertChange(db, {
        actor: 'system', mutationKey: `system:task-create-claim:${action.id}:${version}`, entityKind: 'action',
        entityId: action.id, entityVersion: version, operation: 'transition', snapshot: actionSnapshot(claimed),
        details: { before: action.state, after: 'running', mode, attempt: claimed.attemptCount }, at: now,
      });
      db.exec('COMMIT');
      return {
        action: claimed as ActionRow & { payload: Extract<ActionRow['payload'], { kind: 'task-create' }> },
        mode,
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function settleTaskCreateAction(
    id: string,
    claimId: string,
    result: TaskCreateSettlement,
    now: string,
  ): ActionRow | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      const parsed = getAction(id);
      if (!parsed || parsed.payload.kind !== 'task-create') {
        db.exec('ROLLBACK');
        return null;
      }
      const action = parsed as ActionRow & { payload: Extract<ActionRow['payload'], { kind: 'task-create' }> };
      if (action.state !== 'running' || action.claimId !== claimId) {
        const task = getTask(action.payload.taskId);
        const sameSettledCreate = result.outcome === 'succeeded' && task?.binding.kind === 'google' &&
          task.binding.ref.externalId === result.externalId &&
          (action.state === 'succeeded' || action.state === 'conflict');
        if (sameSettledCreate) {
          db.exec('COMMIT');
          return action;
        }
        db.exec('ROLLBACK');
        return null;
      }

      let settled: ActionRow;
      if (result.outcome === 'succeeded') {
        const invalid = !result.externalId || !result.current.version || !result.current.completionWritable ||
          (result.current.state === 'open' && result.current.completedAt !== null);
        const changed = result.current.state !== 'open' || result.current.completedAt !== null ||
          result.current.title !== action.payload.title || result.current.notes !== action.payload.notes ||
          result.current.dueOn !== action.payload.doOn;
        settled = invalid
          ? transitionTaskCreateAction(action, 'unknown', now, {
              ...(action.receipt ?? {}),
              providerId: result.externalId || null,
              candidateExternalId: result.externalId || null,
              verifiedAt: now,
            }, 'Google returned an incomplete create readback. Reconciliation is required.', now)
          : bindCreatedTask(
              action,
              result.externalId,
              result.current,
              now,
              'worker',
              changed ? 'The created Google task changed before reconciliation completed. Review its current values.' : null,
            );
      } else if (result.outcome === 'unknown') {
        const nextAttemptAt = new Date(Date.parse(now) + Math.min(60_000, 2_000 * 2 ** Math.min(5, action.attemptCount))).toISOString();
        settled = transitionTaskCreateAction(action, 'unknown', now, {
          ...(action.receipt ?? {}),
          ...(result.candidateExternalId ? { candidateExternalId: result.candidateExternalId } : {}),
          lastCheckedAt: now,
        }, result.notice, nextAttemptAt);
      } else if (result.outcome === 'conflict') {
        settled = transitionTaskCreateAction(action, 'conflict', now, {
          candidates: result.candidates,
          verifiedAt: now,
        }, result.notice);
      } else {
        const nextAttemptAt = result.retryable && action.attemptCount < 5
          ? new Date(Date.parse(now) + Math.min(60_000, 1_000 * 2 ** Math.max(0, action.attemptCount - 1))).toISOString()
          : null;
        settled = transitionTaskCreateAction(action, 'failed', now, null, result.notice, nextAttemptAt);
      }
      db.exec('COMMIT');
      return settled;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function recoverExpiredTaskActions(now: string): number {
    const rows = db.prepare(`SELECT * FROM actions
      WHERE kind='task-status' AND state='running' AND lease_until IS NOT NULL AND lease_until<=?`).all(now) as Record<string, unknown>[];
    let recovered = 0;
    for (const row of rows) {
      const action = actionFromSql(row);
      if (!action) continue;
      const version = action.version + 1;
      db.prepare(`UPDATE actions SET version=?, state='queued', next_attempt_at=?, claim_id=NULL,
        lease_until=NULL, error=?, updated_at=? WHERE id=? AND version=?`).run(
        version, now, 'The worker stopped before recording a result. Readback will reconcile before another write.',
        now, action.id, action.version,
      );
      const next = getAction(action.id);
      if (!next) throw new Error('Recovered action disappeared');
      insertChange(db, {
        actor: 'system', mutationKey: `system:action:${action.id}:${version}`, entityKind: 'action',
        entityId: action.id, entityVersion: version, operation: 'transition', snapshot: actionSnapshot(next),
        details: { before: 'running', after: 'queued', recovery: 'expired-lease' }, at: now,
      });
      recovered += 1;
    }
    return recovered;
  }

  function claimNextTaskStatusAction(now: string, leaseMilliseconds: number): ActionRow | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      recoverExpiredTaskActions(now);
      for (let checked = 0; checked < 500; checked += 1) {
        const row = db.prepare(`SELECT candidate.* FROM actions AS candidate
          WHERE candidate.kind='task-status'
            AND (candidate.state='queued' OR (candidate.state='failed' AND candidate.next_attempt_at IS NOT NULL))
            AND candidate.next_attempt_at IS NOT NULL AND candidate.next_attempt_at<=?
            AND NOT EXISTS (
              SELECT 1 FROM actions AS active
              WHERE active.task_id=candidate.task_id AND active.id<>candidate.id AND active.state='running'
                AND active.lease_until>?
            )
          ORDER BY candidate.created_at, candidate.id LIMIT 1`).get(now, now) as Record<string, unknown> | undefined;
        const action = row ? actionFromSql(row) : null;
        if (!action || action.payload.kind !== 'task-status') {
          db.exec('COMMIT');
          return null;
        }
        const task = getTask(action.payload.taskId);
        if (!task || task.intentVersion !== action.payload.intentVersion) {
          const version = action.version + 1;
          db.prepare(`UPDATE actions SET version=?, state='superseded', next_attempt_at=NULL,
            claim_id=NULL, lease_until=NULL, error=?, updated_at=? WHERE id=?`).run(
            version, 'The task has a newer status intent.', now, action.id,
          );
          const next = getAction(action.id);
          if (!next) throw new Error('Superseded action disappeared');
          insertChange(db, {
            actor: 'system', mutationKey: `system:action:${action.id}:${version}`, entityKind: 'action',
            entityId: action.id, entityVersion: version, operation: 'transition', snapshot: actionSnapshot(next),
            details: { before: action.state, after: 'superseded' }, at: now,
          });
          continue;
        }
        const claimId = randomUUID();
        const leaseUntil = new Date(Date.parse(now) + leaseMilliseconds).toISOString();
        const version = action.version + 1;
        db.prepare(`UPDATE actions SET version=?, state='running', attempt_count=attempt_count+1,
          next_attempt_at=NULL, claim_id=?, lease_until=?, error=NULL, updated_at=? WHERE id=? AND version=?`).run(
          version, claimId, leaseUntil, now, action.id, action.version,
        );
        const claimed = getAction(action.id);
        if (!claimed) throw new Error('Claimed action disappeared');
        insertChange(db, {
          actor: 'system', mutationKey: `system:action:${action.id}:${version}`, entityKind: 'action',
          entityId: action.id, entityVersion: version, operation: 'transition', snapshot: actionSnapshot(claimed),
          details: { before: action.state, after: 'running', attempt: claimed.attemptCount }, at: now,
        });
        db.exec('COMMIT');
        return claimed;
      }
      db.exec('COMMIT');
      return null;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  function settleTaskStatusAction(
    id: string,
    claimId: string,
    result: TaskStatusSettlement,
    now: string,
  ): ActionRow | null {
    db.exec('BEGIN IMMEDIATE');
    try {
      const action = getAction(id);
      if (!action || action.state !== 'running' || action.claimId !== claimId || action.payload.kind !== 'task-status') {
        db.exec('ROLLBACK');
        return null;
      }
      const task = getTask(action.payload.taskId);
      let nextTask: TaskRow | null = null;
      const remote = result.outcome === 'failed' ? null : result.current ?? null;
      if (task && task.observed && (result.outcome === 'succeeded' || remote)) {
        const status = result.outcome === 'succeeded'
          ? action.payload.after
          : remote?.state ?? task.observed.status;
        const observed = {
          ...task.observed,
          ...(remote ? {
            title: remote.title,
            notes: remote.notes,
            doOn: remote.dueOn,
            parentId: remote.parentId,
            position: remote.position,
            sourceUrl: remote.sourceUrl,
            completionWritable: remote.completionWritable,
          } : {}),
          status,
          completedAt: remote ? remote.completedAt : result.outcome === 'succeeded' ? result.completedAt : task.observed.completedAt,
          etag: remote?.version ?? (result.outcome === 'succeeded' ? result.sourceVersion : task.observed.etag),
          observedAt: remote?.updatedAt ?? (result.outcome === 'succeeded' ? result.sourceUpdatedAt ?? now : now),
        };
        const version = task.version + 1;
        db.prepare(`UPDATE tasks SET version=?, title=?, notes=?, status=?, completed_at=?, do_on=?, parent_id=?,
          position=?, source_url=?, etag=?, observed_at=?, completion_writable=?, unavailable_at=NULL, updated_at=? WHERE id=?`).run(
          version, observed.title, observed.notes, observed.status, observed.completedAt, observed.doOn,
          observed.parentId, observed.position, observed.sourceUrl, observed.etag, observed.observedAt,
          observed.completionWritable ? 1 : 0, now, task.id,
        );
        if (task.binding.kind === 'google') {
          db.prepare(`UPDATE provider_records SET title=?, status=?, due_on=?, completed_at=?, source_updated_at=?,
            source_version=?, completion_writable=?, notes=?, parent_id=?, position=?, source_url=?, imported_at=?, deleted_at=NULL
            WHERE provider='google' AND kind='task' AND account_id=? AND container_id=? AND external_id=?`).run(
            observed.title,
            result.outcome === 'succeeded' ? result.sourceStatus : observed.status === 'completed' ? 'completed' : 'needsAction',
            observed.doOn,
            observed.completedAt,
            observed.observedAt,
            observed.etag,
            observed.completionWritable ? 1 : 0,
            observed.notes,
            observed.parentId,
            observed.position,
            observed.sourceUrl,
            now,
            task.binding.ref.accountId,
            task.binding.ref.listId,
            task.binding.ref.externalId,
          );
        }
        nextTask = getTask(task.id);
        if (!nextTask) throw new Error('Settled task disappeared');
        insertChange(db, {
          actor: 'provider', mutationKey: `provider:task-readback:${task.id}:${version}`, entityKind: 'task',
          entityId: task.id, entityVersion: version, operation: 'transition', snapshot: taskSnapshot(nextTask),
          details: {
            actionId: action.id,
            before: task.observed.status,
            after: nextTask.observed?.status,
            result: result.outcome,
          }, at: now,
        });
      }

      const version = action.version + 1;
      const state = result.outcome === 'succeeded' ? 'succeeded' : result.outcome === 'conflict' ? 'conflict' : 'failed';
      const retryAt = result.outcome === 'failed' && result.retryable && action.attemptCount < 5
        ? new Date(Date.parse(now) + Math.min(60_000, 1_000 * 2 ** Math.max(0, action.attemptCount - 1))).toISOString()
        : null;
      const receipt = result.outcome === 'succeeded'
        ? { providerId: action.payload.target.externalId, verifiedAt: now, sourceVersion: result.sourceVersion }
        : result.outcome === 'conflict' && result.current
          ? { conflict: result.current, verifiedAt: now }
          : null;
      const error = result.outcome === 'succeeded' ? null : result.notice;
      db.prepare(`UPDATE actions SET version=?, state=?, next_attempt_at=?, claim_id=NULL, lease_until=NULL,
        receipt_json=?, error=?, updated_at=? WHERE id=? AND version=?`).run(
        version, state, retryAt, receipt ? canonicalJson(receipt) : null, error, now, action.id, action.version,
      );
      const settled = getAction(action.id);
      if (!settled) throw new Error('Settled action disappeared');
      insertChange(db, {
        actor: 'system', mutationKey: `system:action:${action.id}:${version}`, entityKind: 'action',
        entityId: action.id, entityVersion: version, operation: 'transition', snapshot: actionSnapshot(settled),
        details: { before: 'running', after: state, taskVersion: nextTask?.version ?? task?.version ?? null }, at: now,
      });
      db.exec('COMMIT');
      return settled;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  return {
    listTasks,
    getTask,
    listTaskPlans,
    getTaskPlan,
    listInboxItems,
    getInboxItem,
    wakeDueInboxItems,
    listDrafts,
    getDraft,
    listActions,
    getAction,
    listJobs,
    getJob,
    listJobUpdates,
    listReminders,
    listSyncStates,
    updateTaskPlan,
    updateInboxDecision,
    appendCaptureInbox,
    upsertHermesInbox,
    appendOwnerDraft,
    addLegacyProposal,
    retireProviderAccount,
    markScopeFailed,
    publishProviderScope,
    listChanges,
    readContext,
    insertApprovedAction,
    queueTaskCreateAction,
    createJob,
    claimJob,
    postJobResult,
    answerJob,
    sendBackJob,
    settleJob,
    queueTaskStatusAction,
    claimNextTaskCreateAction,
    settleTaskCreateAction,
    claimNextTaskStatusAction,
    settleTaskStatusAction,
    insertChange: (input: Parameters<typeof insertChange>[1]) => insertChange(db, input),
  };
}

export type RowStore = ReturnType<typeof createRowStore>;
