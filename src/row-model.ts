import { isDateKey } from "./calendar-time.ts";
import { isIsoInstant, isOneOf, isRecord, priorities, type Area, type Priority } from "./model.ts";

export type Instant = string;
export type DateOnly = string;
export type TaskStatus = "open" | "completed";

export type GoogleTaskRef = {
  accountId: string;
  listId: string;
  externalId: string;
};

export type TaskRow = {
  id: string;
  version: number;
  binding:
    | { kind: "legacy"; source: Record<string, unknown> }
    | { kind: "pending"; destination: Omit<GoogleTaskRef, "externalId">; createActionId: string }
    | { kind: "google"; ref: GoogleTaskRef };
  observed: {
    title: string;
    notes: string | null;
    status: TaskStatus;
    completedAt: Instant | null;
    doOn: DateOnly | null;
    parentId: string | null;
    position: string | null;
    sourceUrl: string | null;
    etag: string | null;
    observedAt: Instant;
    completionWritable: boolean;
  } | null;
  unavailableAt: Instant | null;
  intentVersion: number;
  originInboxId: string | null;
  createdAt: Instant;
  updatedAt: Instant;
};

export type TaskPlanRow = {
  taskId: string;
  version: number;
  priority: Priority;
  waiting: boolean;
  deadlineOn: DateOnly | null;
  plannedOn: DateOnly | null;
  plannedAt: Instant | null;
  estimateMinutes: number | null;
  createdAt: Instant;
  updatedAt: Instant;
};

export type InboxSource =
  | { kind: "email"; accountId: string; messageId: string; threadId: string }
  | { kind: "hermes"; reference: string }
  | { kind: "capture"; reference: string };

export type InboxState = "open" | "waiting" | "resolved";
export type InboxOutcome = "sent" | "task" | "dismissed" | "noise" | "read";

export type InboxItemRow = {
  id: string;
  version: number;
  source: InboxSource;
  title: string;
  summary: string;
  state: InboxState;
  outcome: InboxOutcome | null;
  taskId: string | null;
  currentDraftId: string | null;
  likelyNoise: boolean;
  snoozedUntil: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
};

export type ReplyEnvelope = {
  accountId: string;
  threadId: string;
  replyToMessageId: string;
  inReplyTo: string;
  references: string[];
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
};

export type DraftRevision = {
  id: string;
  inboxId: string;
  revision: number;
  author: "owner" | "hermes";
  reply: ReplyEnvelope;
  createdAt: Instant;
};

export type TaskCreatePayload = {
  kind: "task-create";
  taskId: string;
  destination: { accountId: string; listId: string };
  nonce: string;
  title: string;
  notes: string;
  doOn: DateOnly | null;
};

export type TaskCreateInput = {
  destination: { accountId: string; listId: string };
  nonce: string;
  title: string;
  notes: string;
  doOn: DateOnly | null;
  plan: {
    priority: Priority;
    waiting: boolean;
    deadlineOn: DateOnly | null;
    plannedOn: DateOnly | null;
    plannedAt: Instant | null;
    estimateMinutes: number | null;
  };
  inbox?: { id: string; version: number };
  reminder?: { fireAt: Instant };
};

export type TaskStatusPayload = {
  kind: "task-status";
  taskId: string;
  target: GoogleTaskRef;
  expectedTaskVersion: number;
  intentVersion: number;
  expectedEtag: string | null;
  before: TaskStatus;
  after: TaskStatus;
};

export type EmailSendPayload = {
  kind: "email-send";
  inboxId: string;
  draftId: string;
  reply: ReplyEnvelope;
  payloadHash: string;
};

export type EmailSendReceiptInput = {
  kind: "email-send";
  payloadHash: string;
  providerMessageId: string;
  providerThreadId: string;
};

export type EmailSendApprovalInput = {
  version: number;
  draftId: string;
};

export type TaskMigrationSource =
  | { kind: "fox"; taskId: string; version: number }
  | { kind: "hermes"; boardSlug: string; taskId: string; version: number };

export type TaskMigrationPlan = {
  priority: Priority;
  waiting: boolean;
  deadlineOn: DateOnly | null;
  plannedOn: DateOnly | null;
  plannedAt: Instant | null;
  estimateMinutes: number | null;
};

export type TaskMigrationDestination = {
  accountId: string;
  listId: string;
  listName: string;
};

export type TaskMigrationPreviewItem = {
  source: TaskMigrationSource;
  sourceAliases: TaskMigrationSource[];
  sourceKey: string;
  sourceSnapshot: Record<string, unknown>;
  expectedTaskVersion: number | null;
  expectedPlanVersion: number | null;
  title: string;
  status: TaskStatus;
  localTaskId: string;
  operation: "bind" | "create";
  destination: TaskMigrationDestination;
  existingExternalId: string | null;
  targetSnapshot: {
    title: string;
    status: TaskStatus;
    doOn: DateOnly | null;
    etag: string | null;
    observedAt: Instant | null;
  } | null;
  outgoing: { title: string; notes: string; doOn: DateOnly | null } | null;
  plan: TaskMigrationPlan;
  reminder: { id: string; fireAt: Instant } | null;
  preservedReminders: Array<{
    id: string;
    version: number;
    fireAt: Instant;
    state: ReminderRow['state'];
  }>;
  replacesActionId: string | null;
  resumeMode: "create" | "reconcile" | null;
  approvalText: string;
};

export type TaskMigrationBlockerCode =
  | "google_unavailable"
  | "hermes_unavailable"
  | "wrong_board"
  | "destination_missing"
  | "source_missing"
  | "ambiguous_source"
  | "duplicate_target"
  | "pending_create"
  | "status_conflict"
  | "planning_conflict"
  | "completed_create";

export type TaskMigrationBlocker = {
  sourceKey: string | null;
  code: TaskMigrationBlockerCode;
  message: string;
};

export type TaskMigrationPreview = {
  hash: string;
  accountId: string | null;
  connectionGeneration: string | null;
  generatedAt: Instant;
  items: TaskMigrationPreviewItem[];
  blockers: TaskMigrationBlocker[];
};

export type MigrationPayload = {
  kind: "task-migration";
  migrationId: string;
  previewHash: string;
  sourceKey: string;
  sourceSnapshot: Record<string, unknown>;
  operation: "bind" | "create";
  taskId: string;
  source: TaskMigrationSource;
  sourceAliases: TaskMigrationSource[];
  destination: { accountId: string; listId: string };
  destinationName: string;
  existingExternalId: string | null;
  targetSnapshot: TaskMigrationPreviewItem['targetSnapshot'];
  nonce: string | null;
  title: string;
  notes: string;
  doOn: DateOnly | null;
  plan: TaskMigrationPlan;
  reminder: { id: string; fireAt: Instant } | null;
  preservedReminders: TaskMigrationPreviewItem['preservedReminders'];
  resumedFromActionId: string | null;
};

export type ActionPayload = TaskCreatePayload | TaskStatusPayload | EmailSendPayload | MigrationPayload;
export type ActionState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "conflict"
  | "unknown"
  | "superseded"
  | "cancelled";

export type ActionRow = {
  id: string;
  version: number;
  payload: ActionPayload;
  operationKey: string;
  requestHash: string;
  approval: { actor: "owner"; at: Instant; previewText: string };
  state: ActionState;
  attemptCount: number;
  nextAttemptAt: Instant | null;
  claimId: string | null;
  leaseUntil: Instant | null;
  receipt: Record<string, unknown> | null;
  error: string | null;
  createdAt: Instant;
  updatedAt: Instant;
};

export type JobState = "queued" | "working" | "needs_you" | "review" | "settled";
export type JobOutcome = "accepted" | "dropped";

export type Job = {
  id: string;
  version: number;
  title: string;
  instruction: string;
  taskId: string | null;
  inboxId: string | null;
  state: JobState;
  outcome: JobOutcome | null;
  question: string | null;
  claimId: string | null;
  leaseUntil: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
};

export type JobUpdate = {
  seq: number;
  jobId: string;
  author: "hermes" | "owner";
  kind: "progress" | "question" | "answer" | "result" | "sent_back" | "settled";
  text: string;
  url: string | null;
  at: Instant;
};

export type HermesInboxUpsertInput = {
  expectedVersion: number | null;
  source:
    | { kind: "email"; accountId: string; messageId: string; threadId: string }
    | { kind: "hermes"; reference: string };
  title: string;
  summary: string;
  likelyNoise: boolean;
  draft?: ReplyEnvelope;
};

export type ReminderRow = {
  id: string;
  version: number;
  target: { kind: "task" | "local-event"; id: string };
  fireAt: Instant;
  state: "scheduled" | "fired" | "cancelled";
  createdAt: Instant;
  updatedAt: Instant;
};

export type BriefingEntry = {
  kind: "news" | "event";
  title: string;
  summary: string;
  url: string | null;
  startsAt: Instant | null;
};

export type BriefingRow = {
  day: DateOnly;
  version: number;
  entries: BriefingEntry[];
  expiresAt: Instant;
  createdAt: Instant;
  updatedAt: Instant;
};

export type BriefingUpsertInput = {
  expectedVersion: number | null;
  entries: BriefingEntry[];
  expiresAt: Instant;
};

export type ChangeRow = {
  seq: number;
  actor: "owner" | "hermes" | "provider" | "system";
  mutationKey: string;
  mutationHash: string;
  entityKind: "task" | "task-plan" | "calendar" | "inbox" | "draft" | "action" | "job" | "reminder" | "briefing";
  entityId: string;
  entityVersion: number;
  operation: "upsert" | "transition" | "remove";
  snapshot: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  at: Instant;
};

export type SyncStateRow = {
  scopeKey: string;
  provider: "google" | "microsoft";
  resourceKind: "task-list" | "calendar";
  accountId: string;
  containerId: string;
  containerName: string;
  connectionGeneration: string;
  state: "fresh" | "failed";
  successfulFetchAt: Instant | null;
  coverageFrom: Instant | null;
  coverageTo: Instant | null;
  error: string | null;
  updatedAt: Instant;
};

export type TaskWithPlan = {
  task: TaskRow;
  plan: TaskPlanRow;
  area: Area;
  pendingAction: ActionRow | null;
};

export type TaskMigrationMapping = {
  sourceKey: string;
  source: TaskMigrationSource;
  localTaskId: string;
  destination: TaskMigrationDestination;
  externalId: string | null;
  actionId: string;
  state: ActionState;
};

export type TaskMigrationSummary = {
  migrationId: string;
  previewHash: string;
  state: "queued" | "working" | "needs_review" | "settled";
  counts: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    conflict: number;
    unknown: number;
    superseded?: number;
    cancelled?: number;
  };
  mappings: TaskMigrationMapping[];
  actions: ActionRow[];
};

function isShortText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}

function isOneLineText(value: unknown, maximum: number): value is string {
  return isShortText(value, maximum) && !/[\r\n]/.test(value);
}

function isMailHeaderText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return isShortText(value, maximum, allowEmpty) && !/[\u0000-\u001f\u007f]/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => allowed.has(key));
}

export function isUtcInstant(value: unknown): value is Instant {
  return typeof value === "string" && value.endsWith("Z") && isIsoInstant(value);
}

export function isNullableUtcInstant(value: unknown): value is Instant | null {
  return value === null || isUtcInstant(value);
}

export function isNullableDateOnly(value: unknown): value is DateOnly | null {
  return value === null || isDateKey(value);
}

function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_000 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0 &&
      parsed.username.length === 0 && parsed.password.length === 0;
  } catch {
    return false;
  }
}

export function isBriefingEntry(value: unknown): value is BriefingEntry {
  return isRecord(value) && hasExactKeys(value, ["kind", "title", "summary", "url", "startsAt"]) &&
    (value.kind === "news" || value.kind === "event") && isOneLineText(value.title, 500) &&
    isShortText(value.summary, 5_000, true) && (value.url === null || isSafeHttpsUrl(value.url)) &&
    isNullableUtcInstant(value.startsAt);
}

export function isBriefingRow(value: unknown): value is BriefingRow {
  return isRecord(value) && hasExactKeys(value, [
    "day", "version", "entries", "expiresAt", "createdAt", "updatedAt",
  ]) && isDateKey(value.day) && typeof value.version === "number" && Number.isSafeInteger(value.version) &&
    value.version >= 1 && Array.isArray(value.entries) && value.entries.length <= 50 &&
    value.entries.every(isBriefingEntry) && isUtcInstant(value.expiresAt) &&
    isUtcInstant(value.createdAt) && isUtcInstant(value.updatedAt);
}

export function isBriefingUpsertInput(value: unknown): value is BriefingUpsertInput {
  return isRecord(value) && hasExactKeys(value, ["expectedVersion", "entries", "expiresAt"]) &&
    (value.expectedVersion === null || (typeof value.expectedVersion === "number" &&
      Number.isSafeInteger(value.expectedVersion) && value.expectedVersion >= 1)) &&
    Array.isArray(value.entries) && value.entries.length <= 50 && value.entries.every(isBriefingEntry) &&
    isUtcInstant(value.expiresAt);
}

export function isReplyEnvelope(value: unknown): value is ReplyEnvelope {
  if (!isRecord(value)) return false;
  const addressList = (candidate: unknown) => Array.isArray(candidate) && candidate.length <= 100 &&
    candidate.every(address => isMailHeaderText(address, 500));
  return hasExactKeys(value, [
    "accountId", "threadId", "replyToMessageId", "inReplyTo", "references", "from",
    "to", "cc", "bcc", "subject", "bodyText",
  ]) && isMailHeaderText(value.accountId, 200) &&
    isMailHeaderText(value.threadId, 500) &&
    isMailHeaderText(value.replyToMessageId, 998) &&
    isMailHeaderText(value.inReplyTo, 998) &&
    Array.isArray(value.references) && value.references.length <= 100 &&
    value.references.every(reference => isMailHeaderText(reference, 998)) &&
    isMailHeaderText(value.from, 500) &&
    addressList(value.to) && addressList(value.cc) && addressList(value.bcc) &&
    isMailHeaderText(value.subject, 998, true) && isShortText(value.bodyText, 200_000, true) &&
    !value.bodyText.includes("\u0000");
}

export function isEmailSendReceiptInput(value: unknown): value is EmailSendReceiptInput {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "payloadHash", "providerMessageId", "providerThreadId",
  ]) && value.kind === "email-send" &&
    typeof value.payloadHash === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.payloadHash) &&
    isMailHeaderText(value.providerMessageId, 998) && isMailHeaderText(value.providerThreadId, 998);
}

export function isEmailSendApprovalInput(value: unknown): value is EmailSendApprovalInput {
  return isRecord(value) && hasExactKeys(value, ["version", "draftId"]) &&
    typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version >= 1 &&
    isOneLineText(value.draftId, 200);
}

export function isTaskPlanInput(value: unknown): value is Omit<TaskPlanRow, "taskId" | "createdAt" | "updatedAt"> {
  return isRecord(value) &&
    Number.isSafeInteger(value.version) && typeof value.version === "number" && value.version >= 1 &&
    isOneOf(value.priority, priorities) && typeof value.waiting === "boolean" &&
    isNullableDateOnly(value.deadlineOn) && isNullableDateOnly(value.plannedOn) &&
    isNullableUtcInstant(value.plannedAt) &&
    (value.estimateMinutes === null || (
      Number.isSafeInteger(value.estimateMinutes) && typeof value.estimateMinutes === "number" &&
      value.estimateMinutes >= 1 && value.estimateMinutes <= 24 * 60
    )) && !(value.plannedOn !== null && value.plannedAt !== null);
}

export function isTaskStatusInput(value: unknown): value is { version: number; state: TaskStatus } {
  return isRecord(value) && Number.isSafeInteger(value.version) && typeof value.version === "number" &&
    value.version >= 1 && (value.state === "open" || value.state === "completed");
}

export function taskCreateNotes(notes: string, nonce: string): string {
  const trimmed = notes.trim();
  const marker = `Fox-Focus-ID: ${nonce}`;
  return trimmed ? `${trimmed}\n\n${marker}` : marker;
}

export function isTaskCreateInput(value: unknown): value is TaskCreateInput {
  if (!isRecord(value) || !isRecord(value.destination) || !isRecord(value.plan)) return false;
  const estimate = value.plan.estimateMinutes;
  const inbox = value.inbox;
  const reminder = value.reminder;
  return isShortText(value.destination.accountId, 200) && isShortText(value.destination.listId, 500) &&
    typeof value.nonce === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value.nonce) &&
    isOneLineText(value.title, 1_024) && isShortText(value.notes, 8_192, true) &&
    !/^\s*Fox-Focus-ID\s*:/im.test(value.notes) && isNullableDateOnly(value.doOn) &&
    isOneOf(value.plan.priority, priorities) && typeof value.plan.waiting === "boolean" &&
    isNullableDateOnly(value.plan.deadlineOn) && isNullableDateOnly(value.plan.plannedOn) &&
    isNullableUtcInstant(value.plan.plannedAt) &&
    (estimate === null || (typeof estimate === "number" && Number.isSafeInteger(estimate) && estimate >= 1 && estimate <= 1_440)) &&
    !(value.plan.plannedOn !== null && value.plan.plannedAt !== null) &&
    taskCreateNotes(value.notes, value.nonce).length <= 8_192 &&
    (inbox === undefined || (isRecord(inbox) && isShortText(inbox.id, 200) &&
      typeof inbox.version === "number" && Number.isSafeInteger(inbox.version) && inbox.version >= 1)) &&
    (reminder === undefined || (isRecord(reminder) && hasExactKeys(reminder, ["fireAt"]) &&
      isUtcInstant(reminder.fireAt)));
}

export function isTaskMigrationApprovalInput(value: unknown): value is {
  previewHash: string;
  idempotencyKey: string;
} {
  return isRecord(value) && /^[a-f0-9]{64}$/.test(String(value.previewHash)) &&
    isOneLineText(value.idempotencyKey, 200) && value.idempotencyKey.length >= 8;
}

export function isInboxDecisionInput(value: unknown): value is {
  version: number;
  state: InboxState;
  outcome: InboxOutcome | null;
  snoozedUntil: Instant | null;
} {
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || typeof value.version !== "number" || value.version < 1) return false;
  const state = value.state === "open" || value.state === "waiting" || value.state === "resolved";
  const outcome = value.outcome === null || ["sent", "task", "dismissed", "noise", "read"].includes(String(value.outcome));
  return state && outcome && isNullableUtcInstant(value.snoozedUntil) &&
    (value.state === "resolved" ? value.outcome !== null : value.outcome === null) &&
    (value.state === "waiting" ? value.snoozedUntil !== null : value.snoozedUntil === null);
}

export function isHermesInboxUpsertInput(value: unknown): value is HermesInboxUpsertInput {
  if (!isRecord(value) || !isRecord(value.source)) return false;
  const source = value.source.kind === "email"
    ? isShortText(value.source.accountId, 200) && isShortText(value.source.messageId, 998) &&
      isShortText(value.source.threadId, 998)
    : value.source.kind === "hermes" && isShortText(value.source.reference, 500);
  return source &&
    (value.expectedVersion === null || (
      Number.isSafeInteger(value.expectedVersion) && typeof value.expectedVersion === "number" && value.expectedVersion >= 1
    )) &&
    isOneLineText(value.title, 500) && isShortText(value.summary, 10_000, true) &&
    typeof value.likelyNoise === "boolean" &&
    (value.draft === undefined || isReplyEnvelope(value.draft));
}

export function isJobInstruction(value: unknown): value is {
  idempotencyKey: string;
  title: string;
  instruction: string;
  taskId?: string | null;
  inboxId?: string | null;
} {
  return isRecord(value) && isShortText(value.idempotencyKey, 200) && !/[\r\n]/.test(value.idempotencyKey) &&
    isOneLineText(value.title, 200) && isShortText(value.instruction, 2_000) &&
    (value.taskId === undefined || value.taskId === null || isShortText(value.taskId, 200)) &&
    (value.inboxId === undefined || value.inboxId === null || isShortText(value.inboxId, 200));
}

export function isJobResultInput(value: unknown): value is {
  kind: "progress" | "question" | "result";
  text: string;
  url: string | null;
} {
  return isRecord(value) && (value.kind === "progress" || value.kind === "question" || value.kind === "result") &&
    isOneLineText(value.text, 280) &&
    (value.url === null || (isShortText(value.url, 2_000) && (() => {
      try { return new URL(value.url).protocol === "https:"; } catch { return false; }
    })()));
}

export function isJobAnswerInput(value: unknown): value is { version: number; text: string } {
  return isRecord(value) && Number.isSafeInteger(value.version) && typeof value.version === "number" &&
    value.version >= 1 && isOneLineText(value.text, 280);
}

export function isJobSendBackInput(value: unknown): value is { version: number; text: string } {
  return isJobAnswerInput(value);
}

export function isJobSettleInput(value: unknown): value is {
  version: number;
  outcome: JobOutcome;
  taskVersion?: number;
} {
  return isRecord(value) && Number.isSafeInteger(value.version) && typeof value.version === "number" && value.version >= 1 &&
    (value.outcome === "accepted" || value.outcome === "dropped") &&
    (value.taskVersion === undefined || (
      Number.isSafeInteger(value.taskVersion) && typeof value.taskVersion === "number" && value.taskVersion >= 1
    ));
}
