import { isDateKey } from "./calendar-time.ts";
import { areas, isOneOf, isRecord, priorities, type Area } from "./model.ts";
import {
  isReplyEnvelope,
  isUtcInstant,
  type ActionRow,
  type DraftRevision,
  type InboxItemRow,
  type InboxOutcome,
  type Job,
  type JobOutcome,
  type JobUpdate,
  type ReplyEnvelope,
  type TaskCreateInput,
  type TaskCreatePayload,
} from "./row-model.ts";

export type TaskCreateActionRow = ActionRow & { payload: TaskCreatePayload };

export type TaskCreateConflictCandidate = {
  externalId: string;
  title: string;
  state: "open" | "completed";
  dueDate: string | null;
  updatedAt: string | null;
  version: string | null;
};

export type TaskDestination = {
  accountId: string;
  listId: string;
  listName: string;
  area: Area;
  isFallback: boolean;
  explicitMapping: boolean;
};

export type WorkRowsSnapshot = {
  inbox: InboxItemRow[];
  drafts: DraftRevision[];
  jobs: Job[];
  jobUpdates: JobUpdate[];
  actions: ActionRow[];
};

export type CreateTaskInput = TaskCreateInput;

export function preferredTaskDestination(
  destinations: readonly TaskDestination[],
  area: Area,
): TaskDestination | null {
  const explicit = destinations.filter(destination => destination.explicitMapping && destination.area === area);
  if (explicit.length === 1) return explicit[0];
  const fallbacks = destinations.filter(destination => destination.isFallback);
  return fallbacks.length === 1 ? fallbacks[0] : null;
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOneLine(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\r\n]/.test(value);
}

function isSafeResultUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 2_000) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function isInboxItemRow(value: unknown): value is InboxItemRow {
  if (!isRecord(value) || typeof value.id !== "string" || !isPositiveVersion(value.version) ||
    typeof value.title !== "string" || typeof value.summary !== "string" ||
    !["open", "waiting", "resolved"].includes(String(value.state)) ||
    !(value.outcome === null || ["sent", "task", "dismissed", "noise", "read"].includes(String(value.outcome))) ||
    !isNullableString(value.taskId) || !isNullableString(value.currentDraftId) ||
    typeof value.likelyNoise !== "boolean" || !(value.snoozedUntil === null || isUtcInstant(value.snoozedUntil)) ||
    !isUtcInstant(value.createdAt) || !isUtcInstant(value.updatedAt) || !isRecord(value.source) ||
    (value.state === "resolved" ? value.outcome === null : value.outcome !== null)) return false;

  if (value.source.kind === "email") {
    return typeof value.source.accountId === "string" && typeof value.source.messageId === "string" &&
      typeof value.source.threadId === "string";
  }
  return (value.source.kind === "hermes" || value.source.kind === "capture") &&
    typeof value.source.reference === "string";
}

function isDraftRevision(value: unknown): value is DraftRevision {
  return isRecord(value) && typeof value.id === "string" && typeof value.inboxId === "string" &&
    isPositiveVersion(value.revision) && (value.author === "owner" || value.author === "hermes") &&
    isReplyEnvelope(value.reply) && isUtcInstant(value.createdAt);
}

function isJob(value: unknown): value is Job {
  return isRecord(value) && typeof value.id === "string" && isPositiveVersion(value.version) &&
    isOneLine(value.title, 200) && typeof value.instruction === "string" && value.instruction.length <= 2_000 &&
    isNullableString(value.taskId) && isNullableString(value.inboxId) &&
    ["queued", "working", "needs_you", "review", "settled"].includes(String(value.state)) &&
    (value.outcome === null || value.outcome === "accepted" || value.outcome === "dropped") &&
    (value.question === null || isOneLine(value.question, 280)) && isNullableString(value.claimId) &&
    (value.leaseUntil === null || isUtcInstant(value.leaseUntil)) &&
    isUtcInstant(value.createdAt) && isUtcInstant(value.updatedAt) &&
    (value.state === "settled" ? value.outcome !== null : value.outcome === null) &&
    (value.state === "needs_you" ? value.question !== null : value.question === null);
}

function isJobUpdate(value: unknown): value is JobUpdate {
  return isRecord(value) && typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq >= 1 &&
    typeof value.jobId === "string" && (value.author === "hermes" || value.author === "owner") &&
    ["progress", "question", "answer", "result", "sent_back", "settled"].includes(String(value.kind)) &&
    isOneLine(value.text, 280) && isSafeResultUrl(value.url) && isUtcInstant(value.at);
}

function isDestination(value: unknown): value is { accountId: string; listId: string } {
  return isRecord(value) && typeof value.accountId === "string" && typeof value.listId === "string";
}

function isActionPayload(value: unknown): value is ActionRow["payload"] {
  if (!isRecord(value)) return false;
  if (value.kind === "task-create") {
    return typeof value.taskId === "string" && isDestination(value.destination) && typeof value.nonce === "string" &&
      typeof value.title === "string" && typeof value.notes === "string" && (value.doOn === null || isDateKey(value.doOn));
  }
  if (value.kind === "task-status") {
    return typeof value.taskId === "string" && isRecord(value.target) && typeof value.target.accountId === "string" &&
      typeof value.target.listId === "string" && typeof value.target.externalId === "string" &&
      isPositiveVersion(value.expectedTaskVersion) && typeof value.intentVersion === "number" &&
      Number.isSafeInteger(value.intentVersion) && value.intentVersion >= 1 && isNullableString(value.expectedEtag) &&
      (value.before === "open" || value.before === "completed") && (value.after === "open" || value.after === "completed");
  }
  if (value.kind === "email-send") {
    return typeof value.inboxId === "string" && typeof value.draftId === "string" &&
      isReplyEnvelope(value.reply) && typeof value.payloadHash === "string";
  }
  return value.kind === "task-migration" && typeof value.migrationId === "string" && typeof value.taskId === "string" &&
    isRecord(value.source) && isDestination(value.destination) && isNullableString(value.existingExternalId) &&
    isNullableString(value.nonce);
}

function isActionRow(value: unknown): value is ActionRow {
  return isRecord(value) && typeof value.id === "string" && isPositiveVersion(value.version) &&
    isActionPayload(value.payload) &&
    typeof value.operationKey === "string" && typeof value.requestHash === "string" && isRecord(value.approval) &&
    value.approval.actor === "owner" && isUtcInstant(value.approval.at) && typeof value.approval.previewText === "string" &&
    ["queued", "running", "succeeded", "failed", "conflict", "unknown", "superseded", "cancelled"].includes(String(value.state)) &&
    typeof value.attemptCount === "number" && Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 0 &&
    (value.nextAttemptAt === null || isUtcInstant(value.nextAttemptAt)) && isNullableString(value.claimId) &&
    (value.leaseUntil === null || isUtcInstant(value.leaseUntil)) && (value.receipt === null || isRecord(value.receipt)) &&
    isNullableString(value.error) && isUtcInstant(value.createdAt) && isUtcInstant(value.updatedAt);
}

export function isTaskCreateActionRow(action: ActionRow): action is TaskCreateActionRow {
  const payload = action.payload;
  return payload.kind === "task-create" && typeof payload.taskId === "string" &&
    typeof payload.destination.accountId === "string" && typeof payload.destination.listId === "string" &&
    typeof payload.nonce === "string" && typeof payload.title === "string" && typeof payload.notes === "string" &&
    (payload.doOn === null || isDateKey(payload.doOn));
}

export function taskCreateConflictCandidates(action: TaskCreateActionRow | undefined): TaskCreateConflictCandidate[] {
  if (action?.state !== "conflict" || !isRecord(action.receipt) || !Array.isArray(action.receipt.candidates)) return [];
  return action.receipt.candidates.flatMap((candidate): TaskCreateConflictCandidate[] => {
    if (!isRecord(candidate) || typeof candidate.externalId !== "string" || typeof candidate.title !== "string" ||
      (candidate.state !== "open" && candidate.state !== "completed") ||
      !(candidate.dueDate === null || isDateKey(candidate.dueDate)) ||
      !isNullableString(candidate.updatedAt) || !isNullableString(candidate.version)) return [];
    return [{
      externalId: candidate.externalId,
      title: candidate.title,
      state: candidate.state,
      dueDate: candidate.dueDate,
      updatedAt: candidate.updatedAt,
      version: candidate.version,
    }];
  });
}

function isTaskDestination(value: unknown): value is TaskDestination {
  return isRecord(value) && typeof value.accountId === "string" && typeof value.listId === "string" &&
    typeof value.listName === "string" && isOneOf(value.area, areas) && typeof value.isFallback === "boolean" &&
    typeof value.explicitMapping === "boolean";
}

function mergeVersioned<T extends { version: number }>(current: T[], incoming: T[], key: (row: T) => string): T[] {
  const merged = new Map(current.map((row) => [key(row), row]));
  for (const row of incoming) {
    const id = key(row);
    const previous = merged.get(id);
    if (!previous || row.version >= previous.version) merged.set(id, row);
  }
  return [...merged.values()];
}

export function mergeWorkRows(current: WorkRowsSnapshot | null, incoming: WorkRowsSnapshot): WorkRowsSnapshot {
  if (!current) return incoming;
  const drafts = new Map(current.drafts.map((draft) => [draft.id, draft]));
  for (const draft of incoming.drafts) drafts.set(draft.id, draft);
  const updates = new Map(current.jobUpdates.map((update) => [`${update.jobId}:${update.seq}`, update]));
  for (const update of incoming.jobUpdates) updates.set(`${update.jobId}:${update.seq}`, update);
  return {
    inbox: mergeVersioned(current.inbox, incoming.inbox, (item) => item.id)
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt) || first.id.localeCompare(second.id)),
    drafts: [...drafts.values()].sort((first, second) =>
      first.inboxId.localeCompare(second.inboxId) || first.revision - second.revision),
    jobs: mergeVersioned(current.jobs, incoming.jobs, (job) => job.id)
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt) || first.id.localeCompare(second.id)),
    jobUpdates: [...updates.values()].sort((first, second) => first.seq - second.seq),
    actions: mergeVersioned(current.actions, incoming.actions, (action) => action.id)
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id)),
  };
}

export async function loadWorkRows(signal?: AbortSignal): Promise<WorkRowsSnapshot> {
  const response = await fetch("/api/v1/rows", { cache: "no-store", signal });
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || !Array.isArray(value.inbox) || !value.inbox.every(isInboxItemRow) ||
    !Array.isArray(value.drafts) || !value.drafts.every(isDraftRevision) || !Array.isArray(value.actions) ||
    !value.actions.every(isActionRow) || !Array.isArray(value.jobs) || !value.jobs.every(isJob) ||
    !Array.isArray(value.jobUpdates) || !value.jobUpdates.every(isJobUpdate)) {
    throw new Error("Could not load Inbox rows");
  }
  return {
    inbox: value.inbox,
    drafts: value.drafts,
    jobs: value.jobs,
    jobUpdates: value.jobUpdates,
    actions: value.actions,
  };
}

async function request(path: string, method: "POST" | "PUT", body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let value: unknown = null;
  try { value = await response.json(); } catch { /* the status still identifies the failed request */ }
  if (!response.ok) {
    throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : "The change could not be saved");
  }
  return value;
}

export async function loadTaskDestinations(signal?: AbortSignal): Promise<{
  destinations: TaskDestination[];
  fallback: TaskDestination | null;
}> {
  const response = await fetch("/api/v1/task-destinations", { cache: "no-store", signal });
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || !Array.isArray(value.destinations) ||
    !value.destinations.every(isTaskDestination) || !(value.fallback === null || isTaskDestination(value.fallback))) {
    throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : "Google task lists are unavailable");
  }
  const destinations = [...value.destinations];
  const fallback = value.fallback;
  if (fallback && !destinations.some((destination) =>
    destination.accountId === fallback.accountId && destination.listId === fallback.listId)) {
    destinations.push(fallback);
  }
  return { destinations, fallback };
}

export async function createGoogleTask(input: CreateTaskInput): Promise<unknown> {
  if (!isOneOf(input.plan.priority, priorities)) throw new Error("Choose a valid priority");
  return request("/api/v1/tasks", "POST", input);
}

export async function decideInboxItem(
  item: InboxItemRow,
  decision: { state: "open" | "waiting" | "resolved"; outcome: InboxOutcome | null; snoozedUntil: string | null },
): Promise<unknown> {
  return request(`/api/v1/inbox-items/${encodeURIComponent(item.id)}`, "PUT", {
    version: item.version,
    ...decision,
  });
}

export async function saveOwnerDraft(item: Pick<InboxItemRow, "id" | "version">, reply: ReplyEnvelope): Promise<unknown> {
  return request(`/api/v1/inbox-items/${encodeURIComponent(item.id)}/drafts`, "POST", {
    version: item.version,
    reply,
  });
}

export async function createJob(input: {
  idempotencyKey: string;
  title: string;
  instruction: string;
  taskId?: string;
  inboxId?: string;
}): Promise<Job> {
  const value = await request("/api/v1/jobs", "POST", {
    idempotencyKey: input.idempotencyKey,
    title: input.title,
    instruction: input.instruction,
    taskId: input.taskId ?? null,
    inboxId: input.inboxId ?? null,
  });
  if (!isRecord(value) || !isJob(value.job)) throw new Error("The queued job response was invalid");
  return value.job;
}

export async function answerJob(job: Job, text: string): Promise<unknown> {
  return request(`/api/v1/jobs/${encodeURIComponent(job.id)}/answer`, "POST", { version: job.version, text });
}

export async function sendBackJob(job: Job, text: string): Promise<unknown> {
  return request(`/api/v1/jobs/${encodeURIComponent(job.id)}/send-back`, "POST", { version: job.version, text });
}

export async function settleJob(job: Job, outcome: JobOutcome, taskVersion?: number): Promise<unknown> {
  return request(`/api/v1/jobs/${encodeURIComponent(job.id)}/settle`, "POST", {
    version: job.version,
    outcome,
    ...(taskVersion === undefined ? {} : { taskVersion }),
  });
}
