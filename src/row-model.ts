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

export type MigrationPayload = {
  kind: "task-migration";
  migrationId: string;
  taskId: string;
  source: Record<string, unknown>;
  destination: { accountId: string; listId: string };
  existingExternalId: string | null;
  nonce: string | null;
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

export type ReminderRow = {
  id: string;
  version: number;
  target: { kind: "task" | "local-event"; id: string };
  fireAt: Instant;
  state: "scheduled" | "fired" | "cancelled";
  createdAt: Instant;
  updatedAt: Instant;
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

function isShortText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.trim().length > 0);
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

export function isReplyEnvelope(value: unknown): value is ReplyEnvelope {
  if (!isRecord(value)) return false;
  const addressList = (candidate: unknown) => Array.isArray(candidate) && candidate.length <= 100 &&
    candidate.every(address => isShortText(address, 500));
  return isShortText(value.accountId, 200) &&
    isShortText(value.threadId, 500) &&
    isShortText(value.replyToMessageId, 998) &&
    isShortText(value.inReplyTo, 998) &&
    Array.isArray(value.references) && value.references.length <= 100 &&
    value.references.every(reference => isShortText(reference, 998)) &&
    isShortText(value.from, 500) &&
    addressList(value.to) && addressList(value.cc) && addressList(value.bcc) &&
    isShortText(value.subject, 998, true) && isShortText(value.bodyText, 200_000, true);
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
    (value.state === "resolved" ? value.outcome !== null : value.outcome === null);
}

export function isJobInstruction(value: unknown): value is { title: string; instruction: string; taskId?: string; inboxId?: string } {
  return isRecord(value) && isShortText(value.title, 200) && isShortText(value.instruction, 2_000) &&
    (value.taskId === undefined || isShortText(value.taskId, 200)) &&
    (value.inboxId === undefined || isShortText(value.inboxId, 200));
}

export function isJobResultInput(value: unknown): value is {
  claimId: string;
  kind: "progress" | "question" | "result";
  text: string;
  url: string | null;
} {
  return isRecord(value) && isShortText(value.claimId, 200) &&
    (value.kind === "progress" || value.kind === "question" || value.kind === "result") &&
    isShortText(value.text, 280) &&
    (value.url === null || (isShortText(value.url, 2_000) && (() => {
      try { return new URL(value.url).protocol === "https:"; } catch { return false; }
    })()));
}
