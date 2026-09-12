import {
  activeTaskStates,
  areas,
  isIsoInstant,
  reminderModes,
  type ActiveTaskState,
  type Area,
  type ReminderMode,
} from "./model.ts";

export const hermesStatuses = [
  "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done",
] as const;

export type HermesStatus = (typeof hermesStatuses)[number];
export type HermesOwner = "human" | "agent" | "unassigned";
export type HermesSourceProvider = "google";

export type HermesRemoteTask = {
  id: string;
  title: string;
  status: HermesStatus;
  priority: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  owner: HermesOwner;
  source: string;
  parentTitle: string | null;
  sourceProvider: HermesSourceProvider | null;
  sourceExternalId: string | null;
  sourceDueOn: string | null;
  sourceStatus: string | null;
  sourceContainerId: string | null;
  sourceContainerName: string | null;
  sourceMatchUnique: boolean;
};

export type HermesTask = HermesRemoteTask & {
  area: Area;
  localState: ActiveTaskState;
  duration: string;
  due: string;
  scheduledAt: string | null;
  reminderMode: ReminderMode;
  reminderFireAt: string | null;
  annotationUpdatedAt: string | null;
};

export type HermesMirrorSnapshot = {
  state: "connected";
  checkedAt: string;
  complete: boolean;
  board: {
    slug: string;
    name: string;
    total: number;
    tasks: HermesRemoteTask[];
    sources: string[];
  };
};

export type HermesBoard = {
  slug: string;
  name: string;
  total: number;
  tasks: HermesTask[];
  sources: string[];
};

export type HermesFeed = (
  | { state: "connected"; checkedAt: string; board: HermesBoard }
  | { state: "stale"; checkedAt: string; lastSuccessfulAt: string; board: HermesBoard }
  | { state: "unavailable"; checkedAt: string; board: null }
) & { completionAvailable?: boolean };

export type HermesTaskAnnotationInput = {
  area: Area;
  localState: ActiveTaskState;
  duration: string;
  due: string;
  scheduledAt: string | null;
  reminderMode: ReminderMode;
  reminderFireAt: string | null;
};

export type HermesCompletionInput = {
  expectedVersion: number;
  confirmation: {
    beforeStatus: HermesStatus;
    afterStatus: "done";
    confirmedAt: string;
  };
};

export type HermesCompletionResult = {
  task: HermesTask;
  approval: { id: string; summary: string; approvedAt: string };
};

export function deduplicatedProviderIdentity(task: HermesRemoteTask): string | null {
  if (!task.sourceMatchUnique || !task.sourceProvider || !task.sourceExternalId) return null;
  // Show both records whenever their completion states disagree. Hiding one
  // would make an unfinished action disappear from either Open or Done.
  if (!task.sourceStatus || (task.status === "done") !== (task.sourceStatus === "completed")) return null;
  return `${task.sourceProvider}\u0000${task.sourceExternalId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHermesStatus(value: unknown): value is HermesStatus {
  return typeof value === "string" && hermesStatuses.includes(value as HermesStatus);
}

function isHermesOwner(value: unknown): value is HermesOwner {
  return value === "human" || value === "agent" || value === "unassigned";
}

function isNullableIsoInstant(value: unknown): value is string | null {
  return value === null || isIsoInstant(value);
}

export function isHermesTask(value: unknown): value is HermesTask {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isHermesStatus(value.status) &&
    typeof value.priority === "number" && Number.isInteger(value.priority) &&
    isIsoInstant(value.createdAt) &&
    isIsoInstant(value.updatedAt) &&
    typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version >= 0 &&
    isHermesOwner(value.owner) &&
    typeof value.source === "string" &&
    (value.parentTitle === null || typeof value.parentTitle === "string") &&
    (value.sourceProvider === null || value.sourceProvider === "google") &&
    (value.sourceExternalId === null || typeof value.sourceExternalId === "string") &&
    (value.sourceDueOn === null || typeof value.sourceDueOn === "string") &&
    (value.sourceStatus === null || typeof value.sourceStatus === "string") &&
    (value.sourceContainerId === null || typeof value.sourceContainerId === "string") &&
    (value.sourceContainerName === null || typeof value.sourceContainerName === "string") &&
    typeof value.sourceMatchUnique === "boolean" &&
    areas.includes(value.area as Area) &&
    activeTaskStates.includes(value.localState as ActiveTaskState) &&
    typeof value.duration === "string" &&
    typeof value.due === "string" &&
    isNullableIsoInstant(value.scheduledAt) &&
    reminderModes.includes(value.reminderMode as ReminderMode) &&
    isNullableIsoInstant(value.reminderFireAt) &&
    isNullableIsoInstant(value.annotationUpdatedAt);
}

export function isHermesTaskAnnotationInput(value: unknown): value is HermesTaskAnnotationInput {
  return isRecord(value) &&
    areas.includes(value.area as Area) &&
    activeTaskStates.includes(value.localState as ActiveTaskState) &&
    typeof value.duration === "string" && value.duration.trim().length > 0 && value.duration.length <= 100 &&
    typeof value.due === "string" && value.due.trim().length > 0 && value.due.length <= 100 &&
    isNullableIsoInstant(value.scheduledAt) &&
    reminderModes.includes(value.reminderMode as ReminderMode) &&
    isNullableIsoInstant(value.reminderFireAt);
}

export function isHermesCompletionInput(value: unknown): value is HermesCompletionInput {
  if (!isRecord(value) || !Number.isSafeInteger(value.expectedVersion) ||
    typeof value.expectedVersion !== "number" || value.expectedVersion < 0 ||
    !isRecord(value.confirmation)) return false;
  return isHermesStatus(value.confirmation.beforeStatus) &&
    value.confirmation.afterStatus === "done" &&
    isIsoInstant(value.confirmation.confirmedAt);
}

export function isHermesFeed(value: unknown): value is HermesFeed {
  if (!isRecord(value) || !isIsoInstant(value.checkedAt)) return false;
  if (value.completionAvailable !== undefined && typeof value.completionAvailable !== "boolean") return false;
  if (value.state === "unavailable") return value.board === null;
  if (value.state !== "connected" && value.state !== "stale") return false;
  if (value.state === "stale" && !isIsoInstant(value.lastSuccessfulAt)) return false;
  if (!isRecord(value.board)) return false;
  return typeof value.board.slug === "string" &&
    typeof value.board.name === "string" &&
    typeof value.board.total === "number" && Number.isInteger(value.board.total) &&
    Array.isArray(value.board.sources) && value.board.sources.every(source => typeof source === "string") &&
    Array.isArray(value.board.tasks) && value.board.tasks.every(isHermesTask);
}
