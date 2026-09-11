import { isDateKey, isTimeValue } from "./calendar-time.ts";

export type Area = "University" | "Work" | "Personal" | "Health" | "Admin";
export type Priority = "high" | "medium" | "low";
export type TaskState = "up-next" | "scheduled" | "waiting" | "done";
export type ActiveTaskState = Exclude<TaskState, "done">;

export type InboxStatus = "new" | "draft-ready" | "waiting-on-agent" | "handled";
export type ThemeMode = "system" | "light" | "black";
export type ResolvedTheme = Exclude<ThemeMode, "system">;
export type SectionAnchor = "today" | "agenda" | "tasks" | "review" | "signals";
export type TaskOrigin = "manual" | "inbox";
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
export const taskOrigins = ["manual", "inbox"] as const;
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
    (value.createdAt === undefined || isIsoInstant(value.createdAt))
  );
}

const dueOrdering: Record<string, number> = {
  Today: 0,
  Tomorrow: 1,
  Friday: 2,
  Waiting: 4,
  "No deadline": 5,
};

/** Keeps the existing human-readable deadline ordering used by the task UI. */
export function taskDueWeight(due: string): number {
  return dueOrdering[due] ?? 3;
}

/** Sorts earlier/current deadlines first, then newest-created, then task ID. */
export function compareTasksByDue(first: Task, second: Task): number {
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

  return (
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
}

export function createInitialData(): PrototypeData {
  return { tasks: [], events: [], inboxItems: [], reminders: [], listAreas: {} };
}
