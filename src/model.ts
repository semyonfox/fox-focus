import { isDateKey, isTimeValue } from "./calendar-time.ts";

export type Area = "University" | "Work" | "Personal" | "Health" | "Admin";
export type Priority = "high" | "medium" | "low";
export type TaskState = "up-next" | "scheduled" | "waiting" | "done";
export type ActiveTaskState = Exclude<TaskState, "done">;

export type InboxStatus = "new" | "draft-ready" | "waiting-on-agent" | "handled";
export type ThemeMode = "system" | "light" | "black";
export type ResolvedTheme = Exclude<ThemeMode, "system">;
export type SectionAnchor = "today" | "agenda" | "tasks" | "review" | "signals";
export type TaskOrigin = "manual" | "inbox" | "migration";
export type TaskLinkProvider = "google_tasks" | "microsoft_todo" | "hermes";
export type TaskLinkPolicy = "read_only" | "completion_only";
export type EventOrigin = "fixture" | "local" | "task" | "inbox";
export type ReminderMode = "none" | "one-hour" | "morning";
export type ActiveReminderMode = Exclude<ReminderMode, "none">;
export type ReminderState = "scheduled" | "snoozed";
export type InboxDestination = "task" | "event";
export type TaskFilter = "all" | "open" | "due-today" | "planned" | "waiting" | "done";
export type TaskSort = "due" | "created";

export type Task = {
  id: string;
  title: string;
  area: Area;
  state: TaskState;
  duration: string;
  due: string;
  priority: Priority;
  completed: boolean;
  scheduledTime: string | null;
  /** Retained while dated week-planning rows are migrated to exact event instants. */
  scheduledDate?: string;
  linkedEventId?: string;
  origin: TaskOrigin;
  source?: string;
  /** Creation instant for ordering; omitted on legacy workspace records. */
  createdAt?: string;
  /** Exact local deadline. The legacy `due` label stays readable during migration. */
  deadlineDate?: string;
  /** Completion instant retained as part of Fox Focus task history. */
  completedAt?: string;
  /** Optional provenance. Native task behaviour never depends on this being present. */
  externalLinks?: TaskExternalLink[];
};

export type TaskExternalLink = {
  provider: TaskLinkProvider;
  externalId: string;
  containerId: string;
  containerName?: string;
  /** Opaque OAuth connection generation used to block writes after account changes. */
  connectionId?: string;
  policy: TaskLinkPolicy;
  sourceStatus?: string;
  sourceVersion?: string;
  sourceUpdatedAt?: string;
  linkedAt: string;
};

type TimelineEventBase = {
  id: string;
  title: string;
  subtitle: string;
  area: Area;
  duration: number;
  editable: boolean;
  origin: EventOrigin;
  source?: string;
  taskId?: string;
};

/** New calendar blocks store an exact instant. Dated and time-only legacy rows remain readable. */
export type TimelineEvent = TimelineEventBase & (
  | { startsAt: string; start?: never; date?: never }
  | { startsAt?: never; start: string; date?: string }
);

export type InboxItem = {
  id: string;
  title: string;
  summary: string;
  source: string;
  actor: string;
  status: InboxStatus;
  accent: Area;
  draft?: string;
  moreWork?: string;
};

export type Reminder = {
  id: string;
  targetId: string;
  targetType: "task" | "event";
  title: string;
  mode: ActiveReminderMode;
  when: string;
  state: ReminderState;
  snoozedUntil?: number;
  fireAt?: string;
  firedAt?: string;
};

export type PrototypeData = {
  tasks: Task[];
  events: TimelineEvent[];
  inboxItems: InboxItem[];
  reminders: Reminder[];
  listAreas?: Record<string, Area>;
};

export type TaskDraft = {
  title: string;
  area: Area;
  priority: Priority;
  due: string;
  deadlineDate: string;
  duration: string;
  state: ActiveTaskState;
  scheduledDate: string;
  scheduledTime: string;
  reminderMode: ReminderMode;
};

export type EventDraft = {
  title: string;
  subtitle: string;
  area: Area;
  date: string;
  time: string;
  duration: string;
  reminderMode: ReminderMode;
};

export type Modal =
  | { kind: "task"; taskId?: string; inboxId?: string }
  | { kind: "event"; eventId?: string; inboxId?: string }
  | { kind: "draft"; inboxId: string }
  | null;

export const areas = ["University", "Work", "Personal", "Health", "Admin"] as const;
export const priorities = ["high", "medium", "low"] as const;
export const taskStates = ["up-next", "scheduled", "waiting", "done"] as const;
export const activeTaskStates = ["up-next", "scheduled", "waiting"] as const;
export const inboxStatuses = ["new", "draft-ready", "waiting-on-agent", "handled"] as const;
export const eventOrigins = ["fixture", "local", "task", "inbox"] as const;
export const taskOrigins = ["manual", "inbox", "migration"] as const;
export const taskLinkProviders = ["google_tasks", "microsoft_todo", "hermes"] as const;
export const taskLinkPolicies = ["read_only", "completion_only"] as const;
export const reminderModes = ["none", "one-hour", "morning"] as const;
export const activeReminderModes = ["one-hour", "morning"] as const;
export const reminderStates = ["scheduled", "snoozed"] as const;
export const taskFilters = ["all", "open", "due-today", "planned", "waiting", "done"] as const;
export const taskSorts = ["due", "created"] as const;
export const storageKey = "fox-focus-prototype-v2";

export const defaultTaskDraft: TaskDraft = {
  title: "",
  area: "Personal",
  priority: "medium",
  due: "No deadline",
  deadlineDate: "",
  duration: "30 min",
  state: "up-next",
  scheduledDate: "",
  scheduledTime: "",
  reminderMode: "none",
};

export const defaultEventDraft: EventDraft = {
  title: "",
  subtitle: "",
  area: "Personal",
  date: "",
  time: "09:00",
  duration: "30",
  reminderMode: "none",
};

export function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.some((option) => option === value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !isoInstantPattern.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day] = value.match(/^(\d{4})-(\d{2})-(\d{2})T/) ?? [];
  if (!year || !month || !day) return false;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return calendarDate.getUTCFullYear() === Number(year) &&
    calendarDate.getUTCMonth() === Number(month) - 1 &&
    calendarDate.getUTCDate() === Number(day);
}

export function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isOneOf(value.area, areas) &&
    isOneOf(value.state, taskStates) &&
    typeof value.duration === "string" &&
    typeof value.due === "string" &&
    isOneOf(value.priority, priorities) &&
    typeof value.completed === "boolean" &&
    (value.scheduledTime === null || typeof value.scheduledTime === "string") &&
    (value.scheduledDate === undefined || isDateKey(value.scheduledDate)) &&
    (value.linkedEventId === undefined || typeof value.linkedEventId === "string") &&
    isOneOf(value.origin, taskOrigins) &&
    (value.source === undefined || typeof value.source === "string") &&
    (value.createdAt === undefined || isIsoInstant(value.createdAt)) &&
    (value.deadlineDate === undefined || isDateKey(value.deadlineDate)) &&
    (value.completedAt === undefined || isIsoInstant(value.completedAt)) &&
    (value.externalLinks === undefined || (
      Array.isArray(value.externalLinks) &&
      value.externalLinks.length <= 8 &&
      value.externalLinks.every(isTaskExternalLink) &&
      new Set(value.externalLinks.map(link => `${link.provider}:${link.connectionId ?? "legacy"}:${link.containerId}:${link.externalId}`)).size === value.externalLinks.length
    ))
  );
}

export function isTaskExternalLink(value: unknown): value is TaskExternalLink {
  if (!isRecord(value)) return false;
  return isOneOf(value.provider, taskLinkProviders) &&
    typeof value.externalId === "string" && value.externalId.length > 0 && value.externalId.length <= 512 &&
    typeof value.containerId === "string" && value.containerId.length > 0 && value.containerId.length <= 512 &&
    (value.containerName === undefined || (typeof value.containerName === "string" && value.containerName.length <= 500)) &&
    (value.connectionId === undefined || (typeof value.connectionId === "string" && value.connectionId.length > 0 && value.connectionId.length <= 200)) &&
    isOneOf(value.policy, taskLinkPolicies) &&
    (value.sourceStatus === undefined || (typeof value.sourceStatus === "string" && value.sourceStatus.length <= 100)) &&
    (value.sourceVersion === undefined || (typeof value.sourceVersion === "string" && value.sourceVersion.length <= 512)) &&
    (value.sourceUpdatedAt === undefined || isIsoInstant(value.sourceUpdatedAt)) &&
    isIsoInstant(value.linkedAt);
}

const dueOrdering: Record<string, number> = {
  Today: 0,
  Tomorrow: 1,
  Friday: 2,
  Waiting: 4,
  "No deadline": 5,
};

const monthIndex: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Keeps the existing human-readable deadline ordering used by the task UI. */
export function taskDueWeight(due: string): number {
  return dueOrdering[due] ?? 3;
}

/**
 * Hermes annotations currently store a concise display label rather than a
 * structured deadline. Recognise the date labels produced by Fox Focus so
 * `Due first` remains chronological instead of falling back to creation time.
 */
function taskDueTimestamp(due: string, referenceDate: string | undefined): number | null {
  if (!referenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) return null;
  const reference = new Date(`${referenceDate}T00:00:00Z`);
  if (!Number.isFinite(reference.getTime())) return null;
  if (due === "Today") return reference.getTime();
  if (due === "Tomorrow") return reference.getTime() + 86_400_000;
  if (due === "Friday") {
    const daysUntilFriday = (5 - reference.getUTCDay() + 7) % 7 || 7;
    return reference.getTime() + daysUntilFriday * 86_400_000;
  }
  const match = due.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/);
  if (!match) return null;
  const [, dayText, monthText] = match;
  const day = Number(dayText);
  const month = monthIndex[monthText];
  const candidate = new Date(Date.UTC(reference.getUTCFullYear(), month, day));
  return candidate.getUTCMonth() === month && candidate.getUTCDate() === day ? candidate.getTime() : null;
}

/** Sorts earlier/current deadlines first, then newest-created, then task ID. */
export function compareTasksByDue(first: Task, second: Task, referenceDate?: string): number {
  if (first.deadlineDate !== undefined || second.deadlineDate !== undefined) {
    if (first.deadlineDate === undefined) return 1;
    if (second.deadlineDate === undefined) return -1;
    const exactOrder = first.deadlineDate.localeCompare(second.deadlineDate);
    if (exactOrder !== 0) return exactOrder;
  }
  const firstTimestamp = taskDueTimestamp(first.due, referenceDate);
  const secondTimestamp = taskDueTimestamp(second.due, referenceDate);
  if (firstTimestamp !== null || secondTimestamp !== null) {
    if (firstTimestamp === null) return 1;
    if (secondTimestamp === null) return -1;
    if (firstTimestamp !== secondTimestamp) return firstTimestamp - secondTimestamp;
  }
  return taskDueWeight(first.due) - taskDueWeight(second.due) ||
    compareTasksByCreatedAt(first, second) || first.id.localeCompare(second.id);
}

/** Sorts newest tasks first; legacy tasks without timestamps sort after timestamped ones. */
export function compareTasksByCreatedAt(first: Task, second: Task): number {
  const firstTime = first.createdAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(first.createdAt);
  const secondTime = second.createdAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(second.createdAt);
  return secondTime - firstTime || first.id.localeCompare(second.id);
}

export function isTimelineEvent(value: unknown): value is TimelineEvent {
  if (!isRecord(value)) return false;

  const hasInstant = isIsoInstant(value.startsAt);
  const hasLegacyTime = isTimeValue(value.start);
  const hasValidLegacyDate = value.date === undefined || isDateKey(value.date);

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.subtitle === "string" &&
    isOneOf(value.area, areas) &&
    typeof value.duration === "number" && Number.isFinite(value.duration) && value.duration > 0 && value.duration <= 1440 &&
    ((hasInstant && value.start === undefined && value.date === undefined) ||
      (hasLegacyTime && value.startsAt === undefined && hasValidLegacyDate)) &&
    typeof value.editable === "boolean" &&
    isOneOf(value.origin, eventOrigins) &&
    (value.source === undefined || typeof value.source === "string") &&
    (value.taskId === undefined || typeof value.taskId === "string")
  );
}

export function isInboxItem(value: unknown): value is InboxItem {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    typeof value.source === "string" &&
    typeof value.actor === "string" &&
    isOneOf(value.status, inboxStatuses) &&
    isOneOf(value.accent, areas) &&
    (value.draft === undefined || typeof value.draft === "string") &&
    (value.moreWork === undefined || typeof value.moreWork === "string")
  );
}

export function isReminder(value: unknown): value is Reminder {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.targetId === "string" &&
    (value.targetType === "task" || value.targetType === "event") &&
    typeof value.title === "string" &&
    isOneOf(value.mode, activeReminderModes) &&
    typeof value.when === "string" &&
    isOneOf(value.state, reminderStates) &&
    (value.snoozedUntil === undefined || typeof value.snoozedUntil === "number") &&
    (value.fireAt === undefined || isIsoInstant(value.fireAt)) &&
    (value.firedAt === undefined || isIsoInstant(value.firedAt))
  );
}

export function isPrototypeData(value: unknown): value is PrototypeData {
  if (!isRecord(value)) return false;

  const listAreaEntries = value.listAreas === undefined
    ? []
    : isRecord(value.listAreas) ? Object.entries(value.listAreas) : null;

  const collectionsAreValid = (
    listAreaEntries !== null &&
    listAreaEntries.length <= 100 &&
    listAreaEntries.every(([key, area]) => key.length >= 1 && key.length <= 300 && isOneOf(area, areas)) &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isTask) &&
    Array.isArray(value.events) &&
    value.events.every(isTimelineEvent) &&
    Array.isArray(value.inboxItems) &&
    value.inboxItems.every(isInboxItem) &&
    Array.isArray(value.reminders) &&
    value.reminders.every(isReminder) &&
    [value.tasks, value.events, value.inboxItems, value.reminders].every(items =>
      items.length <= 500 && new Set(items.map(item => item.id)).size === items.length &&
      items.every(item => item.id.length > 0 && item.id.length <= 200 && item.title.trim().length > 0 && item.title.length <= 500))
  );
  if (!collectionsAreValid) return false;
  const tasks = value.tasks as Task[];
  const linkedSources = tasks.flatMap(task => task.externalLinks ?? [])
    .map(link => `${link.provider}:${link.connectionId ?? "legacy"}:${link.containerId}:${link.externalId}`);
  return new Set(linkedSources).size === linkedSources.length;
}

export function createInitialData(): PrototypeData {
  return { tasks: [], events: [], inboxItems: [], reminders: [], listAreas: {} };
}
