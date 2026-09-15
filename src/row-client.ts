import { apiFetch } from "./api-transport.ts";
import { isDateKey } from "./calendar-time.ts";
import { isOneOf, isRecord, priorities } from "./model.ts";
import { isNullableUtcInstant, isUtcInstant, type ActionRow, type TaskPlanRow, type TaskRow, type TaskStatusPayload } from "./row-model.ts";

export type TaskStatusActionRow = ActionRow & { payload: TaskStatusPayload };

export type TaskRowsSnapshot = {
  tasks: TaskRow[];
  taskPlans: TaskPlanRow[];
  actions: TaskStatusActionRow[];
};

export type TaskConflictSnapshot = {
  title: string;
  notes: string | null;
  state: "open" | "completed";
  completedAt: string | null;
  dueOn: string | null;
  parentId: string | null;
  position: string | null;
  sourceUrl: string | null;
  version: string | null;
  updatedAt: string | null;
  completionWritable: boolean;
};

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isTaskBinding(value: unknown): value is TaskRow["binding"] {
  if (!isRecord(value)) return false;
  if (value.kind === "legacy") return isRecord(value.source);
  if (value.kind === "pending") {
    return isRecord(value.destination) && typeof value.destination.accountId === "string" &&
      typeof value.destination.listId === "string" && typeof value.createActionId === "string";
  }
  return value.kind === "google" && isRecord(value.ref) && typeof value.ref.accountId === "string" &&
    typeof value.ref.listId === "string" && typeof value.ref.externalId === "string";
}

function isObservedTask(value: unknown): value is NonNullable<TaskRow["observed"]> {
  return isRecord(value) && typeof value.title === "string" && isNullableString(value.notes) &&
    (value.status === "open" || value.status === "completed") && isNullableUtcInstant(value.completedAt) &&
    (value.doOn === null || isDateKey(value.doOn)) && isNullableString(value.parentId) &&
    isNullableString(value.position) && isNullableString(value.sourceUrl) && isNullableString(value.etag) &&
    isUtcInstant(value.observedAt) && typeof value.completionWritable === "boolean";
}

export function isTaskRow(value: unknown): value is TaskRow {
  return isRecord(value) && typeof value.id === "string" && isPositiveVersion(value.version) &&
    isTaskBinding(value.binding) && (value.observed === null || isObservedTask(value.observed)) &&
    isNullableUtcInstant(value.unavailableAt) && typeof value.intentVersion === "number" &&
    Number.isSafeInteger(value.intentVersion) && value.intentVersion >= 0 &&
    isNullableString(value.originInboxId) && isUtcInstant(value.createdAt) && isUtcInstant(value.updatedAt);
}

export function isTaskPlanRow(value: unknown): value is TaskPlanRow {
  return isRecord(value) && typeof value.taskId === "string" && isPositiveVersion(value.version) &&
    isOneOf(value.priority, priorities) && typeof value.waiting === "boolean" &&
    (value.deadlineOn === null || isDateKey(value.deadlineOn)) &&
    (value.plannedOn === null || isDateKey(value.plannedOn)) && isNullableUtcInstant(value.plannedAt) &&
    (value.estimateMinutes === null || (
      typeof value.estimateMinutes === "number" && Number.isSafeInteger(value.estimateMinutes) &&
      value.estimateMinutes >= 1 && value.estimateMinutes <= 24 * 60
    )) && isUtcInstant(value.createdAt) && isUtcInstant(value.updatedAt);
}

export function isTaskStatusActionRow(value: unknown): value is TaskStatusActionRow {
  if (!isRecord(value) || !isPositiveVersion(value.version) || typeof value.id !== "string" ||
    !isRecord(value.payload) || value.payload.kind !== "task-status" || typeof value.payload.taskId !== "string" ||
    !isRecord(value.payload.target) || typeof value.payload.target.accountId !== "string" ||
    typeof value.payload.target.listId !== "string" || typeof value.payload.target.externalId !== "string" ||
    !isPositiveVersion(value.payload.expectedTaskVersion) || typeof value.payload.intentVersion !== "number" ||
    !Number.isSafeInteger(value.payload.intentVersion) || value.payload.intentVersion < 1 ||
    !isNullableString(value.payload.expectedEtag) ||
    (value.payload.before !== "open" && value.payload.before !== "completed") ||
    (value.payload.after !== "open" && value.payload.after !== "completed")) return false;
  return ["queued", "running", "succeeded", "failed", "conflict", "unknown", "superseded", "cancelled"].includes(String(value.state)) &&
    typeof value.operationKey === "string" && typeof value.requestHash === "string" &&
    isRecord(value.approval) && value.approval.actor === "owner" && isUtcInstant(value.approval.at) &&
    typeof value.approval.previewText === "string" && typeof value.attemptCount === "number" &&
    Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 0 && isNullableUtcInstant(value.nextAttemptAt) &&
    isNullableString(value.claimId) && isNullableUtcInstant(value.leaseUntil) &&
    (value.receipt === null || isRecord(value.receipt)) && isNullableString(value.error) &&
    isUtcInstant(value.createdAt) && isUtcInstant(value.updatedAt);
}

function isTaskConflictSnapshot(value: unknown): value is TaskConflictSnapshot {
  return isRecord(value) && typeof value.title === "string" && isNullableString(value.notes) &&
    (value.state === "open" || value.state === "completed") && isNullableUtcInstant(value.completedAt) &&
    (value.dueOn === null || isDateKey(value.dueOn)) && isNullableString(value.parentId) &&
    isNullableString(value.position) && isNullableString(value.sourceUrl) && isNullableString(value.version) &&
    isNullableUtcInstant(value.updatedAt) && typeof value.completionWritable === "boolean";
}

export function taskConflictFromAction(action: TaskStatusActionRow): TaskConflictSnapshot | null {
  if (action.state !== "conflict" || !isRecord(action.receipt)) return null;
  return isTaskConflictSnapshot(action.receipt.conflict) ? action.receipt.conflict : null;
}

function mergeVersioned<T extends { version: number }>(current: T[], incoming: T[], key: (row: T) => string): T[] {
  const merged = new Map(current.map((row) => [key(row), row]));
  for (const row of incoming) {
    const id = key(row);
    const existing = merged.get(id);
    if (!existing || row.version >= existing.version) merged.set(id, row);
  }
  return [...merged.values()];
}

export function mergeTaskRows(current: TaskRowsSnapshot | null, incoming: TaskRowsSnapshot): TaskRowsSnapshot {
  if (!current) return incoming;
  return {
    tasks: mergeVersioned(current.tasks, incoming.tasks, (task) => task.id)
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt) || first.id.localeCompare(second.id)),
    taskPlans: mergeVersioned(current.taskPlans, incoming.taskPlans, (plan) => plan.taskId)
      .sort((first, second) => first.taskId.localeCompare(second.taskId)),
    actions: mergeVersioned(current.actions, incoming.actions, (action) => action.id)
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id)),
  };
}

export function parseTaskRows(value: unknown): TaskRowsSnapshot {
  if (!isRecord(value) || !Array.isArray(value.tasks) || !value.tasks.every(isTaskRow) ||
    !Array.isArray(value.taskPlans) || !value.taskPlans.every(isTaskPlanRow) || !Array.isArray(value.actions)) {
    throw new Error("Could not load task rows");
  }
  return {
    tasks: value.tasks,
    taskPlans: value.taskPlans,
    actions: value.actions.filter(isTaskStatusActionRow),
  };
}

export type TaskPlanInput = Pick<TaskPlanRow, "priority" | "waiting" | "deadlineOn" | "plannedOn" | "plannedAt" | "estimateMinutes"> & {
  version: number;
};

export type RowResponse = { ok: boolean; status: number; value: unknown };

async function sendRow(path: string, method: "POST" | "PUT", body: unknown): Promise<RowResponse> {
  const response = await apiFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let value: unknown = null;
  try { value = await response.json(); } catch { /* the status still identifies the failed request */ }
  return { ok: response.ok, status: response.status, value };
}

// the caller merges value.task or value.current either way, so the response is returned rather than thrown
export function requestTaskStatus(taskId: string, version: number, state: "open" | "completed"): Promise<RowResponse> {
  return sendRow(`/api/v1/tasks/${encodeURIComponent(taskId)}/status`, "POST", { version, state });
}

export function requestTaskPlan(taskId: string, plan: TaskPlanInput): Promise<RowResponse> {
  return sendRow(`/api/v1/tasks/${encodeURIComponent(taskId)}/plan`, "PUT", plan);
}

export async function loadTaskRows(signal?: AbortSignal): Promise<TaskRowsSnapshot> {
  const response = await apiFetch("/api/v1/rows", { cache: "no-store", signal });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error("Could not load task rows");
  return parseTaskRows(value);
}
