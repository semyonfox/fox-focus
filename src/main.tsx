import "@fontsource-variable/instrument-sans";
import {
  Bell,
  Bot,
  CalendarDays,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  CornerUpLeft,
  Inbox,
  Link2,
  ListTodo,
  Mail,
  MessageSquare,
  Moon,
  Newspaper,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import {
  addCalendarDays,
  calendarDateWindow,
  currentEventProgress,
  dublinDateKey,
  dublinDateTimeToInstant,
  dublinDayBounds,
  dublinTimeValue,
  formatDublinDateKey,
  isDateKey,
} from "./calendar-time.ts";
import { hermesLabels, useHermesFeed } from "./hermes-feed.tsx";
import { deduplicatedProviderIdentity, type HermesTask, type HermesTaskAnnotationInput } from "./hermes-model.ts";
import { IntegrationCalendarContext, IntegrationsDrawer, providerLabel, useOverview, type ImportedRecord, type OverviewState } from './integrations.tsx';
import { areaForList } from './integration-model.ts';
import {
  answerJob,
  approveEmailSend,
  briefingReminderSuggestion,
  createGoogleTask,
  createJob,
  decideInboxItem,
  emailSendBlocksInboxMutation,
  emailSendUiState,
  dublinInstantLocalValue,
  dublinLocalReminderInstant,
  isTaskCreateActionRow,
  loadTaskDestinations,
  loadWorkRows,
  mergeWorkRows,
  preferredTaskDestination,
  saveOwnerDraft,
  sendBackJob,
  settleJob,
  taskCreateConflictCandidates,
  type TaskCreateActionRow,
  type TaskDestination,
  type WorkRowsSnapshot,
} from "./inbox-client.ts";
import {
  isTaskPlanRow,
  isTaskRow as isRowTask,
  isTaskStatusActionRow,
  loadTaskRows,
  mergeTaskRows,
  requestTaskPlan,
  requestTaskStatus,
  taskConflictFromAction,
  type TaskRowsSnapshot,
  type TaskStatusActionRow,
} from "./row-client.ts";
import type { ActionRow, BriefingEntry, DraftRevision, InboxItemRow, Job, JobUpdate, ReplyEnvelope, TaskPlanRow, TaskRow } from "./row-model.ts";
import {
  buildWorkThreads,
  inboxSourceLabel,
  inboxStateLabel,
  jobStateLabel,
  latestSendActions,
  relativeTime,
  type WorkThread,
} from "./work-threads.ts";

import { type Area, type Priority, type TaskState, type ActiveTaskState, type InboxStatus, type ThemeMode, type ResolvedTheme, type SectionAnchor, type TaskOrigin, type EventOrigin, type ReminderMode, type ActiveReminderMode, type ReminderState, type InboxDestination, type TaskFilter, type TaskSort, type Task, type TimelineEvent, type InboxItem, type Reminder, type PrototypeData, type TaskDraft, type EventDraft, type Modal, areas, priorities, taskStates, activeTaskStates, inboxStatuses, eventOrigins, taskOrigins, reminderModes, activeReminderModes, reminderStates, taskFilters, taskSorts, storageKey, defaultTaskDraft, defaultEventDraft, isOneOf, isRecord, isTask, isTimelineEvent, isInboxItem, isReminder, isPrototypeData, compareTasksByCreatedAt, compareTasksByDue, createInitialData } from "./model.ts";

function loadData(): PrototypeData {
  if (typeof window === "undefined") return createInitialData();

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return createInitialData();
    const parsed: unknown = JSON.parse(stored);
    return isPrototypeData(parsed) ? parsed : createInitialData();
  } catch {
    return createInitialData();
  }
}

const themeStorageKey = "fox-focus-theme";

function loadTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "black") return stored;
  } catch {
    // use the system preference when storage is restricted
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "black" : "light";
}

function makeId(prefix: string): string {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${randomPart}`;
}

function areaClass(area: Area): string {
  return area.toLowerCase();
}

function formatDuration(duration: number): string {
  return `${duration} min`;
}

function parseDuration(value: string, fallback = 30): number {
  const match = value.match(/\d+/);
  const parsed = match ? Number.parseInt(match[0], 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isValidTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function formatStatus(status: InboxStatus): string {
  if (status === "draft-ready") return "Draft ready";
  if (status === "waiting-on-agent") return "Saved locally";
  if (status === "handled") return "Handled";
  return "New";
}

function formatReminderMode(mode: ReminderMode): string {
  if (mode === "one-hour") return "1 hour before";
  if (mode === "morning") return "09:00 on the day";
  return "No reminder";
}

function formatCreatedAt(createdAt: string | undefined): string | null {
  if (!createdAt) return null;
  return new Intl.DateTimeFormat("en-IE", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Dublin",
  }).format(new Date(createdAt));
}

function formatDublinInstant(value: string | null): string {
  if (!value) return "Unknown time";
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-IE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Dublin",
  }).format(instant);
}

function reminderTimingLabel(reminder: DisplayReminder, now = Date.now()): string {
  if (reminder.firedAt) return "fired";
  if (!reminder.fireAt) return "needs a planned time";
  return Date.parse(reminder.fireAt) <= now ? "past" : "scheduled";
}

function legacyDeadlineDate(due: string, today: string): string {
  if (due === "Today") return today;
  if (due === "Tomorrow") return addCalendarDays(today, 1);
  if (due !== "Friday") return "";
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addCalendarDays(today, (5 - day + 7) % 7);
}

function deadlineDateLabel(deadlineDate: string, today: string): string {
  if (deadlineDate === today) return "Today";
  if (deadlineDate === addCalendarDays(today, 1)) return "Tomorrow";
  return formatDublinDateKey(deadlineDate, { day: "numeric", month: "short" });
}

function taskDeadlineLabel(task: Task, today: string): string {
  return task.deadlineDate ? deadlineDateLabel(task.deadlineDate, today) : task.due;
}

function taskFilterLabel(filter: TaskFilter): string {
  if (filter === "open") return "Open";
  if (filter === "due-today") return "Due today";
  if (filter === "planned") return "Planned";
  if (filter === "waiting") return "Waiting";
  if (filter === "done") return "Done";
  return "All";
}

function eventDateKey(event: TimelineEvent, legacyDate: string): string {
  if (typeof event.startsAt === "string") return dublinDateKey(new Date(event.startsAt));
  return event.date && isDateKey(event.date) ? event.date : legacyDate;
}

function eventTimeValue(event: TimelineEvent): string {
  return typeof event.startsAt === "string" ? dublinTimeValue(event.startsAt) : event.start;
}

function compareCalendarEvents(first: TimelineEvent, second: TimelineEvent, legacyDate: string): number {
  return eventDateKey(first, legacyDate).localeCompare(eventDateKey(second, legacyDate)) ||
    eventTimeValue(first).localeCompare(eventTimeValue(second)) ||
    first.title.localeCompare(second.title);
}

function eventStartInstant(event: TimelineEvent, legacyDate: string): string | null {
  if (typeof event.startsAt === "string") {
    return Number.isFinite(Date.parse(event.startsAt)) ? event.startsAt : null;
  }
  return dublinDateTimeToInstant(eventDateKey(event, legacyDate), eventTimeValue(event));
}

function eventIsCurrentAt(event: TimelineEvent, now: Date, legacyDate: string): boolean {
  const start = eventStartInstant(event, legacyDate);
  return start !== null && currentEventProgress(start, event.duration, now) !== null;
}

function eventOccursOnDate(event: TimelineEvent, date: string, legacyDate: string): boolean {
  const start = eventStartInstant(event, legacyDate);
  const bounds = dublinDayBounds(date);
  // Legacy wall times can be ambiguous during the repeated Dublin hour.
  // Keep those rows on their stored day even though they cannot be labelled
  // as current until the owner saves an exact instant.
  if (!start) return eventDateKey(event, legacyDate) === date;
  if (!bounds) return false;
  const startTime = Date.parse(start);
  const endTime = startTime + event.duration * 60_000;
  return startTime < Date.parse(bounds.end) && endTime > Date.parse(bounds.start);
}

function eventOverlapsDateRange(event: TimelineEvent, startDate: string, endDate: string, legacyDate: string): boolean {
  const start = eventStartInstant(event, legacyDate);
  const firstDay = dublinDayBounds(startDate);
  const lastDay = dublinDayBounds(endDate);
  if (!start) {
    const date = eventDateKey(event, legacyDate);
    return date >= startDate && date <= endDate;
  }
  if (!firstDay || !lastDay) return false;
  const startTime = Date.parse(start);
  const endTime = startTime + event.duration * 60_000;
  return startTime < Date.parse(lastDay.end) && endTime > Date.parse(firstDay.start);
}

type CalendarMode = "day" | "upcoming";
type WorkspaceView = Exclude<SectionAnchor, "signals">;

function workspaceViewFromLocation(): WorkspaceView {
  if (typeof window === "undefined") return "today";
  const value = window.location.hash.slice(1);
  return value === "agenda" || value === "tasks" || value === "review" ? value : "today";
}

function taskSortLabel(sort: TaskSort): string {
  return sort === "created" ? "Created newest" : "Due first";
}

function updateReminder(
  reminders: Reminder[],
  targetId: string,
  targetType: Reminder["targetType"],
  title: string,
  mode: ReminderMode,
  startsAt?: string | null,
): Reminder[] {
  const withoutTarget = reminders.filter(
    (reminder) => !(reminder.targetId === targetId && reminder.targetType === targetType),
  );

  if (mode === "none") return withoutTarget;

  let fireAt: string | undefined;
  if (startsAt) {
    if (mode === "one-hour") fireAt = new Date(Date.parse(startsAt) - 60 * 60 * 1000).toISOString();
    else fireAt = dublinDateTimeToInstant(dublinDateKey(new Date(startsAt)), "09:00") ?? undefined;
  }

  return [
    ...withoutTarget,
    {
      id: `reminder-${targetId}`,
      targetId,
      targetType,
      title,
      mode,
      when: formatReminderMode(mode),
      state: "scheduled",
      ...(fireAt ? { fireAt } : {}),
    },
  ];
}

function reminderModeFor(reminders: Reminder[], targetId: string): ReminderMode {
  return reminders.find((reminder) => reminder.targetId === targetId)?.mode ?? "none";
}

function PaneHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return (
    <header className="pane-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {action}
    </header>
  );
}

function WorkspaceUnavailable() {
  return (
    <main className="workspace-failure">
      <section className="workspace-failure-card" role="alert" aria-labelledby="workspace-failure-title">
        <span className="workspace-failure-mark" aria-hidden="true">
          <RefreshCw size={18} />
        </span>
        <p className="eyebrow">Connection problem</p>
        <h1 id="workspace-failure-title">Workspace unavailable</h1>
        <p>Fox Focus could not load the server workspace. Nothing was changed.</p>
        <button className="submit-button" type="button" onClick={() => window.location.reload()}>
          <RefreshCw size={14} /> Try again
        </button>
      </section>
    </main>
  );
}

type HermesAdoptionPreview = {
  id: string;
  status: "awaiting_approval";
  before: Record<string, unknown>;
  after: Task;
  expiresAt: string;
};

function isHermesAdoptionPreview(value: unknown): value is HermesAdoptionPreview {
  return isRecord(value) && typeof value.id === "string" && value.status === "awaiting_approval" &&
    isRecord(value.before) && isTask(value.after) && typeof value.expiresAt === "string";
}

function isServerSnapshot(value: unknown): value is ServerSnapshot {
  return isRecord(value) && typeof value.revision === "number" && Number.isSafeInteger(value.revision) &&
    value.revision >= 0 && isPrototypeData(value.data);
}

function actionStateLabel(action: Pick<ActionRow, "state"> | undefined): string | null {
  if (!action) return null;
  if (action.state === "queued" || action.state === "running") return "Google pending";
  if (action.state === "succeeded") return "Google confirmed";
  if (action.state === "failed") return "Google failed";
  if (action.state === "conflict") return "Google changed";
  if (action.state === "unknown") return "Google unknown";
  return null;
}

function TaskRow({
  task,
  onToggle,
  onEdit,
  plannedDate,
  compact = false,
  sourceBadge,
  toggleDisabled = false,
  toggleBusy = false,
  dueLabel,
  latestAction,
}: {
  task: Task;
  onToggle: (task: Task) => void;
  onEdit: (task: Task) => void;
  plannedDate?: string;
  compact?: boolean;
  sourceBadge?: ReactNode;
  toggleDisabled?: boolean;
  toggleBusy?: boolean;
  dueLabel?: string;
  latestAction?: TaskStatusActionRow;
}) {
  const createdAt = formatCreatedAt(task.createdAt);
  const planned = task.scheduledTime && !task.completed
    ? `${plannedDate ? `${formatDublinDateKey(plannedDate, { weekday: "short", day: "numeric" })} ` : ""}${task.scheduledTime}`
    : null;

  return (
    <article className={`task-row${compact ? " task-row--compact" : ""}${task.completed ? " task-row--done" : ""}`}>
      <button
        className={`task-check task-check--${areaClass(task.area)}${task.completed ? " task-check--done" : ""}`}
        type="button"
        onClick={() => onToggle(task)}
        disabled={toggleDisabled || toggleBusy}
        aria-busy={toggleBusy || undefined}
        aria-label={`${task.completed ? "Reopen" : "Complete"} ${task.title}`}
      >
        {task.completed ? <Check size={14} strokeWidth={3} /> : <Circle size={16} strokeWidth={2} />}
      </button>
      <button className="task-row-main" type="button" onClick={() => onEdit(task)} aria-label={`Open ${task.title}`}>
        <span className="task-copy">
          <strong className={task.completed ? "task-title--done" : undefined}>{task.title}</strong>
          <span>
            <i className={`area-dot area-dot--${areaClass(task.area)}`} />
            {task.area} · {task.duration}
            {planned ? <em className="task-sync-chip">{task.completed ? "Calendar done" : `${planned} on calendar`}</em> : null}
            {task.origin === "inbox" ? <em className="source-chip" title={task.source} aria-label={`From ${task.source ?? "Inbox"}`}>{task.source?.replace(/^Inbox · /, "") ?? "Inbox"}</em> : null}
            {sourceBadge ?? (task.externalLinks?.some((link) => link.provider === "google_tasks") ? <em className="source-chip">Google linked</em> : task.origin === "migration" ? <em className="source-chip">Imported</em> : null)}
            {actionStateLabel(latestAction) ? <em className={`task-action-state task-action-state--${latestAction?.state}`}>{actionStateLabel(latestAction)}</em> : null}
            {!compact && createdAt ? <em className="task-created">Added {createdAt}</em> : null}
          </span>
        </span>
        <time dateTime={task.deadlineDate}>{dueLabel ?? task.due}</time>
        <ChevronRight className="task-row-arrow" size={15} aria-hidden="true" />
      </button>
    </article>
  );
}

function ImportedTaskRow({ task, area }: { task: ImportedRecord; area: Area }) {
  const completed = task.status === "completed";
  const status = completed
    ? "Completed"
    : task.dueOn ? formatDublinDateKey(task.dueOn, { weekday: "short", day: "numeric", month: "short" }) : "";

  return (
    <article className={`task-row imported-task-row${completed ? " imported-task-row--done" : ""}`}>
      <span className="imported-task-mark" title="Read-only, managed by the provider"><i className={`area-dot area-dot--${areaClass(area)}`} /></span>
      <div className="task-copy">
        <strong className={completed ? "task-title--done" : undefined}>{task.title}</strong>
        <span>{area}<em className="source-chip" title={`${providerLabel(task.provider)} · ${task.containerName}`}>{providerLabel(task.provider)} · {task.containerName}</em></span>
      </div>
      <time dateTime={task.dueOn ?? undefined}>{status}</time>
    </article>
  );
}

function HermesTaskRow({ task, onAdopt, busy }: { task: HermesTask; onAdopt: (task: HermesTask) => void; busy: boolean }) {
  const updatedAt = formatCreatedAt(task.updatedAt);

  return (
    <article className={`task-row hermes-task-row${task.status === "done" ? " hermes-task-row--done" : ""}`}>
      <span className="hermes-task-mark" title="Managed in Hermes" aria-label="Managed in Hermes"><Bot size={16} /></span>
      <div className="task-copy">
        <strong className={task.status === "done" ? "task-title--done" : undefined}>{task.title}</strong>
        <span>
          <em className="source-chip source-chip--hermes">Hermes</em>
          <em className={`hermes-task-status hermes-task-status--${task.status}`}>{hermesLabels[task.status]}</em>
          {task.priority > 0 ? <em className="task-created">Priority {task.priority}</em> : null}
          {task.parentTitle ? <em className="task-created" title={`Part of ${task.parentTitle}`}>Part of {task.parentTitle}</em> : null}
        </span>
      </div>
      <time dateTime={task.updatedAt}>{updatedAt ? `Updated ${updatedAt}` : "Updated"}</time>
      <button className="mini-action hermes-adopt-action" type="button" disabled={busy} onClick={() => onAdopt(task)}>{busy ? "Preparing…" : "Adopt"}</button>
    </article>
  );
}

function DialogFrame({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className={`editor-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        {children}
      </section>
    </div>
  );
}

type ServerSnapshot = { revision: number; data: PrototypeData };
type CompletionUndo = { taskId: string; state: ActiveTaskState; reminder?: Reminder };

type DisplayReminder = {
  id: string;
  targetId: string;
  targetType: "task" | "event";
  title: string;
  when: string;
  state: ReminderState;
  fireAt?: string;
  firedAt?: string;
  source: "workspace" | "row" | "hermes";
};
type ReviewUndo = { itemId: string; status: InboxStatus };

function destinationKey(destination: Pick<TaskDestination, "accountId" | "listId">): string {
  return `${destination.accountId}\u0000${destination.listId}`;
}

function outgoingTaskNotes(notes: string, nonce: string): string {
  const trimmed = notes.trim();
  const marker = `Fox-Focus-ID: ${nonce}`;
  return trimmed ? `${trimmed}\n\n${marker}` : marker;
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const decoded = window.atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

async function saveDevicePushSubscription(subscription: PushSubscription): Promise<void> {
  const response = await fetch("/api/v1/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) throw new Error("Could not save browser subscription");
}

const allTaskSources = "__all_task_sources__";
const localTaskSource = "__local_task_source__";
const hermesTaskSource = "__hermes_task_source__";
const googleTaskSource = "__google_task_source__";
const microsoftTaskSource = "__microsoft_task_source__";
const taskSources = [allTaskSources, localTaskSource, hermesTaskSource, googleTaskSource, microsoftTaskSource] as const;
const allTaskCategories = "__all_task_categories__";
const unclassifiedTaskCategory = "__unclassified_task_category__";

type TaskSource = (typeof taskSources)[number];
type TaskCategory = typeof allTaskCategories | typeof unclassifiedTaskCategory | Area;

function providerTaskSource(provider: ImportedRecord["provider"]): TaskSource {
  return provider === "google" ? googleTaskSource : microsoftTaskSource;
}

function hermesTaskArea(task: HermesTask, listAreas: Record<string, Area> | undefined): Area {
  if (task.annotationUpdatedAt) return task.area;
  if (task.sourceMatchUnique && task.sourceProvider && task.sourceContainerId && task.sourceContainerName) {
    return areaForList(listAreas, task.sourceProvider, task.sourceContainerId, task.sourceContainerName);
  }
  return task.area;
}

function hermesTaskDue(task: HermesTask, today: string): string {
  if (task.due !== "No deadline") return task.due;
  if (!task.sourceDueOn) return "No deadline";
  if (task.sourceDueOn === today) return "Today";
  if (task.sourceDueOn === addCalendarDays(today, 1)) return "Tomorrow";
  return formatDublinDateKey(task.sourceDueOn, { day: "numeric", month: "short" });
}

function hermesTaskProjection(task: HermesTask, today: string, effectiveArea = task.area): Task {
  const completed = task.status === "done";
  const scheduledTime = task.scheduledAt ? dublinTimeValue(task.scheduledAt) : null;
  const state: TaskState = completed
    ? "done"
    : task.scheduledAt
      ? "scheduled"
      : task.status === "blocked" || task.localState === "waiting"
        ? "waiting"
        : "up-next";
  return {
    id: `hermes:${task.id}`,
    title: task.title,
    area: effectiveArea,
    state,
    duration: task.duration,
    due: hermesTaskDue(task, today),
    priority: task.priority >= 4 ? "high" : task.priority >= 2 ? "medium" : "low",
    completed,
    scheduledTime,
    ...(task.scheduledAt ? { scheduledDate: dublinDateKey(new Date(task.scheduledAt)) } : {}),
    origin: "manual",
    source: `Hermes · ${task.source}`,
    createdAt: task.createdAt,
  };
}

function rowTaskProjection(
  row: TaskRow,
  plan: TaskPlanRow | undefined,
  legacyTask: Task | undefined,
  area: Area,
  today: string,
  createAction?: TaskCreateActionRow,
): Task | null {
  if (row.binding.kind === "legacy") {
    const sourceTask = isTask(row.binding.source) ? row.binding.source : legacyTask;
    if (!sourceTask) return null;
    const plannedInstant = plan?.plannedAt ? new Date(plan.plannedAt) : null;
    const plannedAtIsValid = plannedInstant !== null && !Number.isNaN(plannedInstant.getTime());
    const scheduledDate = plannedAtIsValid
      ? dublinDateKey(plannedInstant)
      : plan?.plannedOn ?? undefined;
    const scheduledTime = plannedAtIsValid && plan?.plannedAt ? dublinTimeValue(plan.plannedAt) : null;
    return {
      ...sourceTask,
      priority: plan?.priority ?? sourceTask.priority,
      duration: plan?.estimateMinutes ? `${plan.estimateMinutes} min` : sourceTask.duration,
      state: sourceTask.completed ? "done" : plan?.waiting ? "waiting" : scheduledDate ? "scheduled" : "up-next",
      scheduledTime,
      scheduledDate,
      deadlineDate: plan?.deadlineOn ?? undefined,
      linkedEventId: undefined,
    };
  }
  if (!row.observed && row.binding.kind === "pending" && createAction) {
    const plannedInstant = plan?.plannedAt ? new Date(plan.plannedAt) : null;
    const plannedAtIsValid = plannedInstant !== null && !Number.isNaN(plannedInstant.getTime());
    const scheduledDate = plannedAtIsValid ? dublinDateKey(plannedInstant) : plan?.plannedOn ?? undefined;
    const scheduledTime = plannedAtIsValid && plan?.plannedAt ? dublinTimeValue(plan.plannedAt) : null;
    return {
      id: row.id,
      title: createAction.payload.title,
      area,
      state: plan?.waiting ? "waiting" : scheduledDate ? "scheduled" : "up-next",
      duration: plan?.estimateMinutes ? `${plan.estimateMinutes} min` : "30 min",
      due: createAction.payload.doOn ? deadlineDateLabel(createAction.payload.doOn, today) : "No deadline",
      priority: plan?.priority ?? "medium",
      completed: false,
      scheduledTime,
      ...(scheduledDate ? { scheduledDate } : {}),
      origin: row.originInboxId ? "inbox" : "manual",
      source: "Google Tasks · pending",
      createdAt: row.createdAt,
      ...(plan?.deadlineOn ? { deadlineDate: plan.deadlineOn } : {}),
    };
  }
  if (!row.observed) return legacyTask ?? null;

  const completed = row.observed.status === "completed";
  const plannedInstant = plan?.plannedAt ? new Date(plan.plannedAt) : null;
  const plannedAtIsValid = plannedInstant !== null && !Number.isNaN(plannedInstant.getTime());
  const scheduledDate = plannedAtIsValid
    ? dublinDateKey(plannedInstant)
    : plan?.plannedOn ?? undefined;
  const scheduledTime = plannedAtIsValid && plan?.plannedAt ? dublinTimeValue(plan.plannedAt) : null;
  const state: TaskState = completed
    ? "done"
    : plan?.waiting
      ? "waiting"
      : scheduledDate
        ? "scheduled"
        : "up-next";

  return {
    id: row.id,
    title: row.observed.title,
    area,
    state,
    duration: plan?.estimateMinutes ? `${plan.estimateMinutes} min` : legacyTask?.duration ?? "30 min",
    due: row.observed.doOn ? deadlineDateLabel(row.observed.doOn, today) : "No deadline",
    priority: plan?.priority ?? legacyTask?.priority ?? "medium",
    completed,
    scheduledTime,
    ...(scheduledDate ? { scheduledDate } : {}),
    origin: legacyTask?.origin ?? (row.originInboxId ? "inbox" : "migration"),
    source: legacyTask?.source ?? "Google Tasks",
    createdAt: row.createdAt,
    ...(plan?.deadlineOn ? { deadlineDate: plan.deadlineOn } : {}),
    ...(row.observed.completedAt ? { completedAt: row.observed.completedAt } : {}),
    ...(legacyTask?.externalLinks ? { externalLinks: legacyTask.externalLinks } : {}),
  };
}

function App({ initial }: { initial?: ServerSnapshot }) {
  const hermes = useHermesFeed(Boolean(initial));
  const integrations = useOverview(Boolean(initial));
  const [data, setData] = useState<PrototypeData>(() => initial?.data ?? loadData());
  const revision = useRef(initial?.revision ?? 0);
  const lastSaved = useRef(data);
  const saveQueue = useRef(Promise.resolve());
  const saveFailed = useRef(false);
  const [activeSection, setActiveSection] = useState<WorkspaceView>(workspaceViewFromLocation);
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "black" : "light",
  );
  const [modal, setModal] = useState<Modal>(null);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(defaultTaskDraft);
  const [eventDraft, setEventDraft] = useState<EventDraft>(defaultEventDraft);
  const [now, setNow] = useState(() => new Date());
  const [draftText, setDraftText] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("open");
  const [taskSource, setTaskSource] = useState<TaskSource>(allTaskSources);
  const [taskCategory, setTaskCategory] = useState<TaskCategory>(allTaskCategories);
  const [taskSort, setTaskSort] = useState<TaskSort>("due");
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("day");
  const [selectedDate, setSelectedDate] = useState(() => dublinDateKey(new Date()));
  const [calendarAnchor, setCalendarAnchor] = useState(() => dublinDateKey(new Date()));
  const [showTaskDetails, setShowTaskDetails] = useState(false);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [showReminderTray, setShowReminderTray] = useState(false);
  const [activeReminderId, setActiveReminderId] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported",
  );
  const [pushSupported, setPushSupported] = useState<boolean | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const serviceWorkerRegistration = useRef<ServiceWorkerRegistration | null>(null);
  const [completionUndo, setCompletionUndo] = useState<CompletionUndo | null>(null);
  const [editingHermesTaskId, setEditingHermesTaskId] = useState<string | null>(null);
  const [hermesCompletionApproval, setHermesCompletionApproval] = useState<HermesTask | null>(null);
  const [hermesTaskDraft, setHermesTaskDraft] = useState<TaskDraft>(defaultTaskDraft);
  const [hermesCompletionPending, setHermesCompletionPending] = useState<string | null>(null);
  const [taskRows, setTaskRows] = useState<TaskRowsSnapshot | null>(null);
  const [taskRowsError, setTaskRowsError] = useState(false);
  const [workRows, setWorkRows] = useState<WorkRowsSnapshot | null>(null);
  const [workRowsError, setWorkRowsError] = useState(false);
  const [selectedWorkKey, setSelectedWorkKey] = useState<string | null>(null);
  const [workDetailOpen, setWorkDetailOpen] = useState(false);
  const workDetailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const workThreadListRef = useRef<HTMLElement | null>(null);
  const workThreadRefs = useRef(new Map<string, HTMLButtonElement>());
  const workDetailWasOpen = useRef(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const [noiseOpen, setNoiseOpen] = useState(false);
  const [workBusyKey, setWorkBusyKey] = useState<string | null>(null);
  const [jobComposer, setJobComposer] = useState<{ idempotencyKey: string; title: string; taskId?: string; inboxId?: string; context?: string } | null>(null);
  const [jobInstruction, setJobInstruction] = useState("");
  const [jobReply, setJobReply] = useState("");
  const [editingReply, setEditingReply] = useState<{ inboxId: string; inboxVersion: number; reply: ReplyEnvelope } | null>(null);
  const [taskDestinations, setTaskDestinations] = useState<TaskDestination[]>([]);
  const [taskDestinationKey, setTaskDestinationKey] = useState("");
  const [taskDestinationError, setTaskDestinationError] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [taskGoogleDue, setTaskGoogleDue] = useState("");
  const [taskReminderLocal, setTaskReminderLocal] = useState("");
  const [taskReminderInstant, setTaskReminderInstant] = useState<{ localValue: string; instant: string } | null>(null);
  const [taskReminderRequired, setTaskReminderRequired] = useState(false);
  const [taskPlannedInstant, setTaskPlannedInstant] = useState<{ localValue: string; instant: string } | null>(null);
  const [taskCreateNonce, setTaskCreateNonce] = useState("");
  const [taskInboxVersion, setTaskInboxVersion] = useState<number | null>(null);
  const [taskPlanVersion, setTaskPlanVersion] = useState<number | null>(null);
  const [busyTaskIds, setBusyTaskIds] = useState<Set<string>>(() => new Set());
  const [taskPlanBusy, setTaskPlanBusy] = useState(false);
  const [taskConflictActionId, setTaskConflictActionId] = useState<string | null>(null);
  const [taskCreateConflictActionId, setTaskCreateConflictActionId] = useState<string | null>(null);
  const taskRowsRefresh = useRef<Promise<void> | null>(null);
  const workRowsRefresh = useRef<Promise<void> | null>(null);
  const [hermesAdoption, setHermesAdoption] = useState<HermesAdoptionPreview | null>(null);
  const [adoptingHermesId, setAdoptingHermesId] = useState<string | null>(null);
  const [reviewUndo, setReviewUndo] = useState<ReviewUndo | null>(null);
  const [showIntegrations, setShowIntegrations] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("integration"));
  const [agentRequest, setAgentRequest] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [modalError, setModalError] = useState("");
  const focusBeforeOverlay = useRef<HTMLElement | null>(null);
  const calendarTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const firedTransientReminderIds = useRef(new Set<string>());
  const hermesBoard = hermes.feed && hermes.feed.state !== "unavailable" ? hermes.feed.board : null;
  const adoptedHermesIds = new Set(data.tasks.flatMap((task) => task.externalLinks ?? [])
    .filter((link) => link.provider === "hermes")
    .map((link) => link.externalId));
  const hermesTasks = (hermesBoard?.tasks ?? []).filter((task) => !adoptedHermesIds.has(task.id));
  const hermesReminders = useMemo<DisplayReminder[]>(() =>
    (hermes.feed?.state === "connected" ? hermesTasks : []).flatMap(task =>
    task.status !== "done" && task.reminderMode !== "none"
      ? [{
          id: `reminder-hermes-${task.id}`,
          targetId: `hermes:${task.id}`,
          targetType: "task" as const,
          title: task.title,
          mode: task.reminderMode,
          when: task.reminderMode === "one-hour" ? "1 hour before" : "09:00 on the day",
          state: "scheduled" as const,
          source: "hermes" as const,
          ...(task.reminderFireAt ? { fireAt: task.reminderFireAt } : {}),
        }]
      : []), [hermes.feed?.state, hermesTasks]);
  const rowReminders = useMemo<DisplayReminder[]>(() => (workRows?.reminders ?? []).flatMap((reminder) => {
    if (reminder.state === "cancelled") return [];
    let title = "Reminder";
    if (reminder.target.kind === "task") {
      const task = taskRows?.tasks.find((candidate) => candidate.id === reminder.target.id);
      const createActionId = task?.binding.kind === "pending" ? task.binding.createActionId : null;
      const action = createActionId
        ? workRows?.actions.find((candidate) => candidate.id === createActionId)
        : null;
      const legacyTitle = task?.binding.kind === "legacy" ? task.binding.source.title : null;
      title = task?.observed?.title ??
        (action?.payload.kind === "task-create" ? action.payload.title : null) ??
        (typeof legacyTitle === "string" ? legacyTitle : null) ??
        "Task reminder";
    } else {
      title = data.events.find((event) => event.id === reminder.target.id)?.title ?? "Calendar reminder";
    }
    return [{
      id: reminder.id,
      targetId: `row:${reminder.target.kind}:${reminder.target.id}`,
      targetType: reminder.target.kind === "task" ? "task" as const : "event" as const,
      title,
      when: formatDublinInstant(reminder.fireAt),
      state: "scheduled" as const,
      source: "row" as const,
      fireAt: reminder.fireAt,
      ...(reminder.state === "fired" ? { firedAt: reminder.updatedAt } : {}),
    }];
  }), [data.events, taskRows?.tasks, workRows?.actions, workRows?.reminders]);
  const allReminders = useMemo<DisplayReminder[]>(() => {
    const reminders = new Map<string, DisplayReminder>();
    for (const reminder of data.reminders) reminders.set(reminder.id, { ...reminder, source: "workspace" });
    for (const reminder of [...rowReminders, ...hermesReminders]) {
      if (!reminders.has(reminder.id)) reminders.set(reminder.id, reminder);
    }
    return [...reminders.values()];
  }, [data.reminders, hermesReminders, rowReminders]);
  const activeReminders = useMemo(() => {
    const now = Date.now();
    return allReminders.filter((reminder) => reminder.state === "scheduled" && !reminder.firedAt &&
      (!reminder.fireAt || Date.parse(reminder.fireAt) > now));
  }, [allReminders]);

  useEffect(() => {
    if (initial) {
      if (data === lastSaved.current) return;
      lastSaved.current = data;
      saveQueue.current = saveQueue.current.then(async () => {
        if (saveFailed.current) return;
        try {
          const response = await fetch("/api/v1/workspace", {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ revision: revision.current, data }),
          });
          if (!response.ok) throw new Error(response.status === 409 ? "Another tab changed this workspace. Reload before editing." : "Save failed. Keep this tab open and copy your changes before reloading.");
          const saved: unknown = await response.json();
          if (!isRecord(saved) || typeof saved.revision !== "number") throw new Error("Invalid save response");
          revision.current = saved.revision;
        } catch (error) {
          saveFailed.current = true;
          setSaveError(error instanceof Error ? error.message : "Save failed");
        }
      });
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {
      // A restricted browser can still use the prototype for the current session.
    }
  }, [data, initial]);

  const hasUnsettledTaskAction = taskRows?.actions.some((action) =>
    action.state === "queued" || action.state === "running" ||
    (action.state === "failed" && action.nextAttemptAt !== null)) === true;

  useEffect(() => {
    if (!initial) return;
    const controller = new AbortController();
    let active = true;
    const refresh = () => {
      if (taskRowsRefresh.current) return taskRowsRefresh.current;
      const request = loadTaskRows(controller.signal).then((rows) => {
        if (!active) return;
        setTaskRows((current) => mergeTaskRows(current, rows));
        setTaskRowsError(false);
      }).catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        setTaskRowsError(true);
      }).finally(() => {
        if (taskRowsRefresh.current === request) taskRowsRefresh.current = null;
      });
      taskRowsRefresh.current = request;
      return request;
    };
    void refresh();
    const interval = window.setInterval(refresh, hasUnsettledTaskAction ? 800 : 15_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [hasUnsettledTaskAction, initial]);

  const hasLiveWork = workRows?.jobs.some((job) => job.state === "queued" || job.state === "working") === true ||
    workRows?.actions.some((action) => (action.payload.kind === "task-create" || action.payload.kind === "email-send") &&
      (action.state === "queued" || action.state === "running" ||
        (action.payload.kind === "email-send" && action.state === "unknown"))) === true;

  useEffect(() => {
    if (!initial) return;
    const controller = new AbortController();
    let active = true;
    const refresh = () => {
      if (workRowsRefresh.current) return workRowsRefresh.current;
      const request = loadWorkRows(controller.signal).then((rows) => {
        if (!active) return;
        setWorkRows((current) => mergeWorkRows(current, rows));
        setWorkRowsError(false);
      }).catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        setWorkRowsError(true);
      }).finally(() => {
        if (workRowsRefresh.current === request) workRowsRefresh.current = null;
      });
      workRowsRefresh.current = request;
      return request;
    };
    void refresh();
    const interval = window.setInterval(refresh, hasLiveWork ? 800 : 15_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [hasLiveWork, initial]);

  useEffect(() => {
    if (!initial) return;
    const controller = new AbortController();
    void loadTaskDestinations(controller.signal).then(({ destinations, fallback }) => {
      setTaskDestinations(destinations);
      setTaskDestinationKey((current) => current || (fallback ? destinationKey(fallback) : ""));
      setTaskDestinationError("");
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setTaskDestinationError(error instanceof Error ? error.message : "Google task lists are unavailable");
    });
    return () => controller.abort();
  }, [initial]);

  useEffect(() => {
    if (!initial || modal?.kind !== "task" || modal.taskId) return;
    const destination = taskDestinations.find((candidate) => destinationKey(candidate) === taskDestinationKey);
    if (!destination || taskDraft.area === destination.area) return;
    setTaskDraft((current) => ({ ...current, area: destination.area }));
  }, [initial, modal, taskDestinationKey, taskDestinations, taskDraft.area]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => setSystemTheme(mediaQuery.matches ? "black" : "light");
    syncSystemTheme();
    mediaQuery.addEventListener("change", syncSystemTheme);
    return () => mediaQuery.removeEventListener("change", syncSystemTheme);
  }, []);

  useEffect(() => {
    const updateClock = () => setNow(new Date());
    const updateVisibleClock = () => {
      if (document.visibilityState === "visible") updateClock();
    };
    const interval = window.setInterval(updateClock, 30_000);
    window.addEventListener("focus", updateClock);
    document.addEventListener("visibilitychange", updateVisibleClock);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", updateClock);
      document.removeEventListener("visibilitychange", updateVisibleClock);
    };
  }, []);

  useEffect(() => {
    const wasOpen = workDetailWasOpen.current;
    workDetailWasOpen.current = workDetailOpen;
    if (activeSection !== "review" || !window.matchMedia("(max-width: 820px)").matches) return;
    const frame = window.requestAnimationFrame(() => {
      if (workDetailOpen) {
        workDetailHeadingRef.current?.focus({ preventScroll: true });
        workDetailHeadingRef.current?.scrollIntoView({ block: "start" });
      } else if (wasOpen) {
        const selected = selectedWorkKey ? workThreadRefs.current.get(selectedWorkKey) : null;
        const target = selected ?? workThreadListRef.current;
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: "nearest" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, selectedWorkKey, workDetailOpen]);

  // Match the dialog paint order so reminders and drawer transitions keep focus.
  const activeOverlay = showIntegrations ? "integrations"
    : hermesAdoption ? "adoption"
    : taskCreateConflictActionId ? "create-conflict"
    : taskConflictActionId ? "task-conflict"
    : activeReminderId ? `reminder-${activeReminderId}`
    : showReminderTray ? "reminders"
    : modal?.kind === "draft" || modal?.kind === "event" ? modal.kind
    : editingReply ? "reply"
    : jobComposer ? "job"
    : modal ? modal.kind
    : editingHermesTaskId ? "hermes-editor"
    : hermesCompletionApproval ? "hermes-completion"
    : null;
  const isOverlayOpen = activeOverlay !== null;

  useEffect(() => {
    if (!activeOverlay) {
      if (focusBeforeOverlay.current?.isConnected) focusBeforeOverlay.current.focus();
      else if (focusBeforeOverlay.current) document.querySelector<HTMLElement>(".workspace-nav-item--active")?.focus();
      focusBeforeOverlay.current = null;
      return;
    }

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusBeforeOverlay.current ??= previousFocus;
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>(".editor-dialog"));
    const dialog = dialogs.at(-1);
    if (!dialog) return;
    const backgroundOverlays = dialogs.slice(0, -1).map((element) => element.closest<HTMLElement>(".overlay")).filter((element) => element !== null);
    backgroundOverlays.forEach((element) => { element.inert = true; });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
    const focusFirstControl = () => {
      if (dialog.contains(document.activeElement)) return;
      const preferred = dialog.querySelector<HTMLElement>('[data-autofocus="true"]');
      const available = controls();
      (preferred && available.includes(preferred) ? preferred : available[0])?.focus();
    };
    const frame = window.requestAnimationFrame(focusFirstControl);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const available = controls();
      if (!available.length) { event.preventDefault(); return; }
      const first = available[0];
      const last = available.at(-1) ?? first;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", trapFocus);
      document.body.style.overflow = previousOverflow;
      backgroundOverlays.forEach((element) => { element.inert = false; });
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [activeOverlay]);

  useEffect(() => {
    if (!("Notification" in window)) {
      setPushSupported(false);
      setNotificationPermission("unsupported");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushSupported(false);
      return;
    }
    let active = true;
    void navigator.serviceWorker.register("/sw.js").then(async (registration) => {
      if (!active) return;
      serviceWorkerRegistration.current = registration;
      setPushSupported(true);
      setNotificationPermission(Notification.permission);
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        try {
          await saveDevicePushSubscription(subscription);
        } catch {
          if (active) {
            setPushSubscribed(false);
            setStatusMessage("Could not restore device notifications. Turn them on again to retry.");
          }
          return;
        }
      }
      if (active) setPushSubscribed(Boolean(subscription));
    }).catch(() => {
      if (active) setPushSupported(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let timeout: number | undefined;
    const scheduleNext = () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      const now = Date.now();
      const nextReminder = [...allReminders]
        .filter((reminder) => reminder.state === "scheduled" && reminder.fireAt && !reminder.firedAt &&
          !firedTransientReminderIds.current.has(`${reminder.id}\u0000${reminder.fireAt}`) && Date.parse(reminder.fireAt) > now)
        .sort((first, second) => Date.parse(first.fireAt ?? "") - Date.parse(second.fireAt ?? ""))[0];
      if (!nextReminder?.fireAt) return;

      const fireTime = Date.parse(nextReminder.fireAt);
      timeout = window.setTimeout(() => {
        if (fireTime > Date.now()) {
          scheduleNext();
          return;
        }
        setActiveReminderId(nextReminder.id);
        if (nextReminder.source !== "workspace") {
          firedTransientReminderIds.current.add(`${nextReminder.id}\u0000${nextReminder.fireAt}`);
        }
        let showedNotification = false;
        if (!pushSubscribed && "Notification" in window && Notification.permission === "granted") {
          try {
            new Notification(nextReminder.title, { body: nextReminder.when, tag: nextReminder.id });
            showedNotification = true;
          } catch {
            // the in-app reminder still fires if the browser notification fails
          }
        }
        if (showedNotification) {
          const firedAt = new Date().toISOString();
          if (nextReminder.source === "workspace") setData((current) => ({
            ...current,
            reminders: current.reminders.map((reminder) => reminder.id === nextReminder.id && !reminder.firedAt
              ? { ...reminder, firedAt }
              : reminder),
          }));
        }
      }, Math.min(fireTime - now, 6 * 60 * 60 * 1000));
    };

    scheduleNext();
    const interval = window.setInterval(scheduleNext, 60 * 1000);
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [allReminders, pushSubscribed]);

  const resolvedTheme: ResolvedTheme = themeMode === "system" ? systemTheme : themeMode;

  function toggleTheme() {
    const nextTheme: ResolvedTheme = resolvedTheme === "black" ? "light" : "black";
    setThemeMode(nextTheme);
    try {
      window.localStorage.setItem(themeStorageKey, nextTheme);
    } catch {
      // a restricted browser can still switch theme for this session
    }
  }

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeOverlay === "integrations") document.querySelector<HTMLButtonElement>(".integrations-drawer .close-composer")?.click();
      else if (activeOverlay === "adoption") { if (!adoptingHermesId) setHermesAdoption(null); }
      else if (activeOverlay === "create-conflict") setTaskCreateConflictActionId(null);
      else if (activeOverlay === "task-conflict") setTaskConflictActionId(null);
      else if (activeOverlay?.startsWith("reminder-")) setActiveReminderId(null);
      else if (activeOverlay === "reminders") setShowReminderTray(false);
      else if (activeOverlay === "reply") { if (!workBusyKey) setEditingReply(null); }
      else if (activeOverlay === "job") { if (!workBusyKey) setJobComposer(null); }
      else if (modal) setModal(null);
      else if (activeOverlay === "hermes-editor") setEditingHermesTaskId(null);
      else if (activeOverlay === "hermes-completion") setHermesCompletionApproval(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeOverlay, adoptingHermesId, workBusyKey, modal]);

  useEffect(() => {
    if (!completionUndo) return;
    const timeout = window.setTimeout(() => setCompletionUndo(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [completionUndo]);

  useEffect(() => {
    if (!reviewUndo) return;
    const timeout = window.setTimeout(() => setReviewUndo(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [reviewUndo]);

  const todayDate = dublinDateKey(now);
  const hermesPlannedEvents = useMemo<TimelineEvent[]>(() => hermesTasks.flatMap(task => {
    const area = hermesTaskArea(task, data.listAreas) ?? "Personal";
    return task.scheduledAt && task.status !== "done"
      ? [{
          id: `hermes-event:${task.id}`,
          title: task.title,
          subtitle: `Hermes · ${area} · ${task.duration}`,
          area,
          startsAt: task.scheduledAt,
          duration: parseDuration(task.duration),
          editable: true,
          origin: "task" as const,
          taskId: `hermes:${task.id}`,
          source: `Hermes · ${task.source}`,
        }]
      : [];
  }), [data.listAreas, hermesTasks]);
  const calendarDays = useMemo(() => calendarDateWindow(calendarAnchor, 3, 3), [calendarAnchor]);
  const calendarRangeStart = selectedDate;
  const calendarRangeEnd = calendarMode === "day" ? selectedDate : addCalendarDays(selectedDate, 6);
  const providerTaskRecords = useMemo(
    () => integrations.overview?.records.filter((record) => record.kind === "task") ?? [],
    [integrations.overview?.records],
  );
  const taskRowById = useMemo(
    () => new Map((taskRows?.tasks ?? []).map((task) => [task.id, task])),
    [taskRows?.tasks],
  );
  const taskPlanById = useMemo(
    () => new Map((taskRows?.taskPlans ?? []).map((plan) => [plan.taskId, plan])),
    [taskRows?.taskPlans],
  );
  const createActionByTask = useMemo(() => {
    const actions = new Map<string, TaskCreateActionRow>();
    for (const action of workRows?.actions ?? []) {
      if (!isTaskCreateActionRow(action)) continue;
      const current = actions.get(action.payload.taskId);
      if (!current || action.version >= current.version) actions.set(action.payload.taskId, action);
    }
    return actions;
  }, [workRows?.actions]);
  const displayTasks = useMemo(() => {
    if (!initial || !taskRows) return data.tasks;
    const legacyById = new Map(data.tasks.map((task) => [task.id, task]));
    return taskRows.tasks.flatMap((row) => {
      const listId = row.binding.kind === "google"
        ? row.binding.ref.listId
        : row.binding.kind === "pending"
          ? row.binding.destination.listId
          : "";
      const listName = providerTaskRecords.find((record) =>
        record.provider === "google" && record.containerId === listId)?.containerName ?? listId;
      const area = row.binding.kind === "legacy"
        ? "Personal"
        : areaForList(data.listAreas, "google", listId, listName);
      const projected = rowTaskProjection(row, taskPlanById.get(row.id), legacyById.get(row.id), area, todayDate, createActionByTask.get(row.id));
      return projected ? [projected] : [];
    });
  }, [createActionByTask, data.listAreas, data.tasks, initial, providerTaskRecords, taskPlanById, taskRows, todayDate]);
  const googleTaskIds = useMemo(() => new Set((taskRows?.tasks ?? [])
    .filter((task) => task.binding.kind === "google" || task.binding.kind === "pending")
    .map((task) => task.id)), [taskRows?.tasks]);
  const taskById = useMemo(() => new Map(displayTasks.map((task) => [task.id, task])), [displayTasks]);
  const rowTaskIds = useMemo(() => new Set((taskRows?.tasks ?? []).map((task) => task.id)), [taskRows?.tasks]);
  const rowPlannedEvents = useMemo<TimelineEvent[]>(() => (taskRows?.taskPlans ?? []).flatMap((plan) => {
    if (!plan.plannedAt) return [];
    const task = taskById.get(plan.taskId);
    if (!task) return [];
    return [{
      id: `row-plan:${plan.taskId}`,
      title: task.title,
      subtitle: `Fox Focus plan · ${task.area}`,
      area: task.area,
      startsAt: plan.plannedAt,
      duration: plan.estimateMinutes ?? 30,
      editable: true,
      origin: "task" as const,
      taskId: task.id,
      source: "Fox Focus task plan",
    }];
  }), [taskById, taskRows?.taskPlans]);
  const staleRowEventIds = useMemo(() => new Set(data.tasks.flatMap((task) =>
    rowTaskIds.has(task.id) && task.linkedEventId ? [task.linkedEventId] : [])), [data.tasks, rowTaskIds]);
  const importedCalendarEvents = useMemo<TimelineEvent[]>(() => (integrations.overview?.records ?? []).flatMap((record) => {
    if (record.kind !== "calendar_event" || record.allDay || !record.startsAt || !record.endsAt || record.status === "cancelled") return [];
    const duration = (Date.parse(record.endsAt) - Date.parse(record.startsAt)) / 60_000;
    if (!Number.isFinite(duration) || duration <= 0) return [];
    const source = `${providerLabel(record.provider)} · ${record.containerName || "Calendar"}`;
    return [{
      id: `imported:${record.provider}:${record.connectionId ?? "connection"}:${record.containerId}:${record.externalId}`,
      title: record.title,
      subtitle: source,
      area: areaForList(data.listAreas, record.provider, record.containerId, record.containerName),
      startsAt: record.startsAt,
      duration,
      editable: false,
      origin: "imported" as const,
      source,
    }];
  }), [data.listAreas, integrations.overview?.records]);
  const sortedEvents = useMemo(() => [
    ...data.events.filter((event) => !staleRowEventIds.has(event.id) && (!event.taskId || !rowTaskIds.has(event.taskId))),
    ...rowPlannedEvents,
    ...hermesPlannedEvents,
    ...importedCalendarEvents,
  ].sort((first, second) => compareCalendarEvents(first, second, todayDate)), [data.events, hermesPlannedEvents, importedCalendarEvents, rowPlannedEvents, rowTaskIds, staleRowEventIds, todayDate]);
  const visibleCalendarEvents = useMemo(
    () => sortedEvents.filter((event) => eventOverlapsDateRange(event, calendarRangeStart, calendarRangeEnd, todayDate)),
    [calendarRangeEnd, calendarRangeStart, sortedEvents, todayDate],
  );
  const eventById = useMemo(() => new Map(sortedEvents.map((event) => [event.id, event])), [sortedEvents]);
  const isCurrentCalendarEvent = (event: TimelineEvent) =>
    taskById.get(event.taskId ?? "")?.completed !== true && eventIsCurrentAt(event, now, todayDate);
  const selectedEvent = visibleCalendarEvents.find((event) => event.id === selectedEventId) ??
    visibleCalendarEvents.find(isCurrentCalendarEvent) ??
    visibleCalendarEvents.find((event) => {
      const start = eventStartInstant(event, todayDate);
      return start !== null && Date.parse(start) > now.getTime();
    }) ?? visibleCalendarEvents[0] ?? null;
  const selectedEventTask = selectedEvent?.taskId ? taskById.get(selectedEvent.taskId) : undefined;
  const selectedEventHermesTask = selectedEvent?.taskId?.startsWith("hermes:")
    ? hermesTasks.find(task => `hermes:${task.id}` === selectedEvent.taskId)
    : undefined;
  const reviewItems = useMemo(
    () => [...data.inboxItems].sort((first, second) => Number(first.status === "handled") - Number(second.status === "handled")),
    [data.inboxItems],
  );
  const selectedInbox = reviewItems.find((item) => item.id === selectedInboxId) ?? reviewItems[0] ?? null;
  const selectedInboxIndex = selectedInbox ? reviewItems.findIndex((item) => item.id === selectedInbox.id) : -1;
  const inboxRowById = useMemo(
    () => new Map((workRows?.inbox ?? []).map((item) => [item.id, item])),
    [workRows?.inbox],
  );
  const draftByInboxId = useMemo(() => {
    const byId = new Map((workRows?.drafts ?? []).map((draft) => [draft.id, draft]));
    const drafts = new Map<string, DraftRevision>();
    for (const item of workRows?.inbox ?? []) {
      if (!item.currentDraftId) continue;
      const current = byId.get(item.currentDraftId);
      if (current) drafts.set(item.id, current);
    }
    return drafts;
  }, [workRows?.drafts, workRows?.inbox]);
  const latestSendActionByInbox = useMemo(() => latestSendActions(workRows?.actions ?? []), [workRows?.actions]);
  const problemSendInboxIds = useMemo(() => new Set([...latestSendActionByInbox]
    .flatMap(([inboxId, action]) => action.state === "failed" || action.state === "conflict" || action.state === "unknown" ? [inboxId] : [])), [latestSendActionByInbox]);
  const workThreads = useMemo(
    () => buildWorkThreads(workRows?.inbox ?? [], workRows?.jobs ?? [], latestSendActionByInbox),
    [latestSendActionByInbox, workRows?.inbox, workRows?.jobs],
  );
  const needsYouThreads = workThreads.filter((thread) => thread.group === "needs_you");
  const workingThreads = workThreads.filter((thread) => thread.group === "working");
  const settledThreads = workThreads.filter((thread) => thread.group === "settled");
  const noiseThreads = workThreads.filter((thread) => thread.group === "noise");
  const selectedWorkThread = workThreads.find((thread) => thread.key === selectedWorkKey) ??
    needsYouThreads[0] ?? workingThreads[0] ?? (noiseOpen ? noiseThreads[0] : null) ??
    (settledOpen ? settledThreads[0] : null) ?? null;
  const visibleWorkThreads = [
    ...needsYouThreads,
    ...workingThreads,
    ...(noiseOpen ? noiseThreads : []),
    ...(settledOpen ? settledThreads : []),
  ];
  const selectedWorkIndex = selectedWorkThread
    ? visibleWorkThreads.findIndex((thread) => thread.key === selectedWorkThread.key)
    : -1;
  const selectedWorkItem = selectedWorkThread?.item ?? null;
  const selectedWorkJob = selectedWorkThread?.job ?? null;
  const selectedWorkDraft = selectedWorkItem ? draftByInboxId.get(selectedWorkItem.id) ?? null : null;
  const selectedWorkUpdates = selectedWorkJob
    ? (workRows?.jobUpdates ?? []).filter((update) => update.jobId === selectedWorkJob.id)
    : selectedWorkItem
      ? (workRows?.jobs ?? []).filter((job) => job.inboxId === selectedWorkItem.id)
        .flatMap((job) => (workRows?.jobUpdates ?? []).filter((update) => update.jobId === job.id))
        .sort((first, second) => first.at.localeCompare(second.at) || first.seq - second.seq)
      : [];
  const activeTasks = displayTasks.filter((task) => !task.completed);
  const activeBlock = selectedDate === todayDate
    ? visibleCalendarEvents.find(isCurrentCalendarEvent) ?? null
    : null;
  const activeReminder = allReminders.find((reminder) => reminder.id === activeReminderId) ?? null;
  const microsoftConfigured = integrations.overview?.providers.some((status) =>
    status.provider === "microsoft" && status.configured) === true;
  const importedTasks = (taskRows ? providerTaskRecords.filter((record) => record.provider !== "google") : providerTaskRecords)
    .filter((record) => record.provider !== "microsoft" || microsoftConfigured);
  const providerIsAvailable = (provider: ImportedRecord["provider"]) =>
    importedTasks.some((task) => task.provider === provider) ||
    integrations.overview?.providers.some((status) => status.provider === provider && status.connection?.state === "connected") === true;
  const googleTasksAvailable = providerIsAvailable("google");
  const microsoftTasksAvailable = microsoftConfigured;
  const dailyIntegrations: OverviewState = {
    ...integrations,
    overview: integrations.overview ? {
      providers: integrations.overview.providers.filter((status) => status.provider !== "microsoft" || status.configured),
      records: integrations.overview.records.filter((record) => record.provider !== "microsoft" || microsoftConfigured),
    } : null,
  };
  const latestActionByTask = new Map<string, TaskStatusActionRow>();
  for (const action of taskRows?.actions ?? []) {
    const current = latestActionByTask.get(action.payload.taskId);
    if (!current || action.payload.intentVersion > current.payload.intentVersion ||
      (action.payload.intentVersion === current.payload.intentVersion && action.version > current.version)) {
      latestActionByTask.set(action.payload.taskId, action);
    }
  }
  const categoryLocalTasks = taskCategory === allTaskCategories
    ? displayTasks
    : taskCategory === unclassifiedTaskCategory
      ? []
      : displayTasks.filter((task) => task.area === taskCategory);
  const categoryHermesTasks = taskCategory === allTaskCategories
    ? hermesTasks
    : taskCategory === unclassifiedTaskCategory
      ? hermesTasks.filter(task => hermesTaskArea(task, data.listAreas) === null)
      : hermesTasks.filter(task => hermesTaskArea(task, data.listAreas) === taskCategory);
  const categoryImportedTasks = taskCategory === allTaskCategories
    ? importedTasks
    : taskCategory === unclassifiedTaskCategory
      ? []
      : importedTasks.filter((task) => areaForList(data.listAreas, task.provider, task.containerId, task.containerName) === taskCategory);
  const taskCategoryOptions: Array<{ id: TaskCategory; label: string }> = [
    { id: allTaskCategories, label: "All" },
    ...areas.map((area) => ({ id: area, label: area })),
  ];

  const visibleTasks = useMemo(() => {
    const filtered = categoryLocalTasks.filter((task) => {
      if (taskFilter === "all") return true;
      if (taskFilter === "due-today") return (task.deadlineDate ? task.deadlineDate === todayDate : task.due === "Today") && !task.completed;
      if (taskFilter === "planned") return Boolean(task.scheduledTime || task.scheduledDate) && !task.completed;
      if (taskFilter === "waiting") return task.state === "waiting" && !task.completed;
      if (taskFilter === "done") return task.completed;
      return !task.completed;
    });

    return [...filtered].sort((first, second) => {
      if (taskFilter !== "done" && first.completed !== second.completed) return Number(first.completed) - Number(second.completed);
      return taskSort === "created" ? compareTasksByCreatedAt(first, second) : compareTasksByDue(first, second, todayDate);
    });
  }, [categoryLocalTasks, taskFilter, taskSort, todayDate]);

  const visibleHermesTasks = useMemo(() => {
    const filtered = categoryHermesTasks.filter(task => {
      const projected = hermesTaskProjection(task, todayDate, hermesTaskArea(task, data.listAreas) ?? "Personal");
      if (taskFilter === "all") return true;
      if (taskFilter === "due-today") return projected.due === "Today" && !projected.completed;
      if (taskFilter === "planned") return Boolean(task.scheduledAt) && !projected.completed;
      if (taskFilter === "waiting") return projected.state === "waiting" && !projected.completed;
      if (taskFilter === "done") return projected.completed;
      return !projected.completed;
    });
    return [...filtered].sort((first, second) => {
      const firstTask = hermesTaskProjection(first, todayDate, hermesTaskArea(first, data.listAreas) ?? "Personal");
      const secondTask = hermesTaskProjection(second, todayDate, hermesTaskArea(second, data.listAreas) ?? "Personal");
      if (taskFilter !== "done" && firstTask.completed !== secondTask.completed) return Number(firstTask.completed) - Number(secondTask.completed);
      return taskSort === "created" ? compareTasksByCreatedAt(firstTask, secondTask) : compareTasksByDue(firstTask, secondTask, todayDate);
    });
  }, [categoryHermesTasks, data.listAreas, taskFilter, taskSort, todayDate]);

  const visibleImportedTasks = useMemo(() => {
    if (taskFilter === "done") return categoryImportedTasks.filter((task) => task.status === "completed");
    if (taskFilter === "open") return categoryImportedTasks.filter((task) => task.status !== "completed");
    if (taskFilter === "due-today") return categoryImportedTasks.filter((task) => task.status !== "completed" && task.dueOn === todayDate);
    return taskFilter === "all"
      ? [...categoryImportedTasks].sort((first, second) => Number(first.status === "completed") - Number(second.status === "completed"))
      : [];
  }, [categoryImportedTasks, taskFilter, todayDate]);

  // Stable provider IDs survive title and list changes. A completed Hermes
  // mirror must not hide a still-open authoritative provider task.
  const hermesProviderIdentities = new Set(hermesTasks.flatMap(task => {
    const identity = deduplicatedProviderIdentity(task);
    return identity ? [identity] : [];
  }));
  const combinedImportedTasks = visibleImportedTasks.filter((task) =>
    !hermesProviderIdentities.has(`${task.provider}\u0000${task.externalId}`));
  const visibleFoxTasks = visibleTasks.filter((task) => !googleTaskIds.has(task.id));
  const visibleGoogleTasks = visibleTasks.filter((task) => googleTaskIds.has(task.id));
  const taskSourceOptions: Array<{ id: TaskSource; label: string; count: number }> = [
    { id: allTaskSources, label: "All sources", count: visibleTasks.length + visibleHermesTasks.length + combinedImportedTasks.length },
    { id: localTaskSource, label: "Fox Focus", count: visibleFoxTasks.length },
  ];
  if (hermesBoard) taskSourceOptions.push({ id: hermesTaskSource, label: "Hermes", count: visibleHermesTasks.length });
  if (googleTasksAvailable || visibleGoogleTasks.length) taskSourceOptions.push({ id: googleTaskSource, label: "Google Tasks", count: visibleGoogleTasks.length });
  if (microsoftTasksAvailable) taskSourceOptions.push({ id: microsoftTaskSource, label: "Microsoft To Do", count: visibleImportedTasks.filter((task) => task.provider === "microsoft").length });
  const isExternalOnlyScope = taskSource === microsoftTaskSource;
  const isHermesOnlyScope = taskSource === hermesTaskSource;

  const shownLocalTasks = taskSource === allTaskSources
    ? visibleTasks
    : taskSource === localTaskSource
      ? visibleFoxTasks
      : taskSource === googleTaskSource
        ? visibleGoogleTasks
        : [];
  const shownHermesTasks = taskSource === allTaskSources || taskSource === hermesTaskSource ? visibleHermesTasks : [];
  const shownImportedTasks = taskSource === allTaskSources
    ? combinedImportedTasks
    : taskSource === googleTaskSource || taskSource === microsoftTaskSource
      ? visibleImportedTasks.filter((task) => providerTaskSource(task.provider) === taskSource)
      : [];

  const reminderCount = activeReminders.length;
  const reviewCount = initial ? needsYouThreads.length : data.inboxItems.filter((item) => item.status !== "handled").length;
  const plannedTaskCount = activeTasks.filter((task) => Boolean(task.scheduledTime || task.scheduledDate ||
    (task.linkedEventId && eventById.has(task.linkedEventId)))).length +
    hermesTasks.filter(task => task.status !== "done" && Boolean(task.scheduledAt)).length;
  const activeHermesTaskCount = hermesTasks.filter((task) => task.status !== "done").length;
  const activeImportedTaskCount = importedTasks.filter((task) => task.status !== "completed" &&
    !hermesProviderIdentities.has(`${task.provider}\u0000${task.externalId}`)).length;
  const openTaskCount = activeTasks.length + activeHermesTaskCount + activeImportedTaskCount;
  const selectedTaskSourceLabel = taskSourceOptions.find((source) => source.id === taskSource)?.label ?? "All sources";
  const selectedTaskCategoryLabel = taskCategory === allTaskCategories ? "all areas" : taskCategory === unclassifiedTaskCategory ? "uncategorised" : taskCategory;
  const taskFilterCounts: Record<TaskFilter, number> = {
    all: categoryLocalTasks.length + categoryHermesTasks.length,
    open: categoryLocalTasks.filter((task) => !task.completed).length + categoryHermesTasks.filter((task) => task.status !== "done").length,
    "due-today": categoryLocalTasks.filter((task) => (task.deadlineDate ? task.deadlineDate === todayDate : task.due === "Today") && !task.completed).length,
    planned: categoryLocalTasks.filter((task) => Boolean(task.scheduledTime || task.scheduledDate) && !task.completed).length,
    waiting: categoryLocalTasks.filter((task) => task.state === "waiting" && !task.completed).length,
    done: categoryLocalTasks.filter((task) => task.completed).length + categoryHermesTasks.filter((task) => task.status === "done").length,
  };
  const activeTaskFilterCount = Number(taskFilter !== "all") + Number(taskSource !== allTaskSources) + Number(taskSort !== "due");
  const shownTaskCount = shownLocalTasks.length + shownHermesTasks.length + shownImportedTasks.length;
  const todayBriefing = (workRows?.briefings ?? []).find((briefing) =>
    briefing.day === todayDate && Date.parse(briefing.expiresAt) > Date.now()) ?? null;
  const briefingNewsCount = todayBriefing?.entries.filter((entry) => entry.kind === "news").length ?? 0;
  const briefingEventCount = todayBriefing?.entries.filter((entry) => entry.kind === "event").length ?? 0;
  const todayEvents = sortedEvents.filter((event) => eventOccursOnDate(event, todayDate, todayDate));
  const currentEvents = todayEvents.filter(isCurrentCalendarEvent);
  const currentEvent = currentEvents[0];
  const nextEvents = todayEvents.filter((event) => {
    const start = eventStartInstant(event, todayDate);
    return start !== null && Date.parse(start) > now.getTime();
  });
  const todayFocusEvents = [...currentEvents, ...nextEvents].slice(0, 3);
  const priorityOrder: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  const attentionDueOrder: Record<string, number> = { Today: 0, Tomorrow: 1, Friday: 2, Waiting: 4, "No deadline": 5 };
  const attentionTasks = [...activeTasks]
    .sort((first, second) => {
      const firstWaiting = Number(first.state === "waiting");
      const secondWaiting = Number(second.state === "waiting");
      return firstWaiting - secondWaiting ||
        (first.deadlineDate ?? "9999-12-31").localeCompare(second.deadlineDate ?? "9999-12-31") ||
        (attentionDueOrder[first.due] ?? 3) - (attentionDueOrder[second.due] ?? 3) ||
        priorityOrder[first.priority] - priorityOrder[second.priority] || compareTasksByCreatedAt(first, second);
    })
    .slice(0, 5);
  const dueTodayCount = activeTasks.filter((task) => task.deadlineDate ? task.deadlineDate === todayDate : task.due === "Today").length;
  const tomorrowDate = addCalendarDays(todayDate, 1);
  const dueTomorrowCount = activeTasks.filter((task) => task.deadlineDate ? task.deadlineDate === tomorrowDate : task.due === "Tomorrow").length;
  const waitingTaskCount = activeTasks.filter((task) => task.state === "waiting").length;

  useEffect(() => {
    if ((taskSource === hermesTaskSource && !hermesBoard) ||
      (taskSource === googleTaskSource && !googleTasksAvailable && visibleGoogleTasks.length === 0) ||
      (taskSource === microsoftTaskSource && !microsoftTasksAvailable)) setTaskSource(allTaskSources);
  }, [googleTasksAvailable, hermesBoard, microsoftTasksAvailable, taskSource, visibleGoogleTasks.length]);

  useEffect(() => {
    if ((taskFilter === "planned" || taskFilter === "waiting") && isExternalOnlyScope) setTaskSource(allTaskSources);
  }, [taskFilter, taskSource]);

  useEffect(() => {
    setAgentRequest(selectedInbox?.moreWork ?? "");
  }, [selectedInbox?.id, selectedInbox?.moreWork]);

  function openWorkspaceView(section: WorkspaceView) {
    setActiveSection(section);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${section}`);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function selectTaskFilter(filter: TaskFilter) {
    setTaskFilter(filter);
    if ((filter === "planned" || filter === "waiting") && isExternalOnlyScope) setTaskSource(allTaskSources);
  }

  function resetTaskFilters() {
    setTaskFilter("all");
    setTaskSource(allTaskSources);
    setTaskSort("due");
  }

  function selectTaskCategory(category: TaskCategory) {
    setTaskCategory(category);
    if (category === unclassifiedTaskCategory && taskSource !== allTaskSources && taskSource !== hermesTaskSource) {
      setTaskSource(hermesBoard ? hermesTaskSource : allTaskSources);
      return;
    }
  }

  function changeListArea(key: string, area: Area) {
    setData((current) => ({ ...current, listAreas: { ...current.listAreas, [key]: area } }));
  }

  function selectCalendarDate(date: string) {
    setSelectedDate(date);
    setCalendarAnchor(date);
    setCalendarMode("day");
    setSelectedEventId(null);
  }

  function moveCalendarDate(delta: number) {
    const nextDate = addCalendarDays(selectedDate, delta);
    setSelectedDate(nextDate);
    setCalendarAnchor(nextDate);
    setCalendarMode("day");
    setSelectedEventId(null);
  }

  function returnCalendarToToday() {
    setSelectedDate(todayDate);
    setCalendarAnchor(todayDate);
    setCalendarMode("day");
    setSelectedEventId(null);
  }

  function handleCalendarTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = Math.min(index + 1, calendarDays.length - 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = calendarDays.length - 1;
    else return;

    const nextDate = calendarDays[nextIndex];
    if (!nextDate) return;
    event.preventDefault();
    selectCalendarDate(nextDate);
    window.requestAnimationFrame(() => calendarTabRefs.current[3]?.focus({ preventScroll: true }));
  }

  function openHermesTaskEditor(task: HermesTask) {
    setHermesTaskDraft({
      title: task.title,
      area: hermesTaskArea(task, data.listAreas) ?? task.area,
      priority: task.priority >= 4 ? "high" : task.priority >= 2 ? "medium" : "low",
      due: task.due,
      deadlineDate: task.sourceDueOn ?? "",
      duration: task.duration,
      state: task.localState === "scheduled" ? "up-next" : task.localState,
      scheduledDate: task.scheduledAt ? dublinDateKey(new Date(task.scheduledAt)) : "",
      scheduledTime: task.scheduledAt ? dublinTimeValue(task.scheduledAt) : "",
      reminderMode: task.reminderMode,
    });
    setModalError("");
    setEditingHermesTaskId(task.id);
  }

  async function saveHermesTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const task = hermesTasks.find(candidate => candidate.id === editingHermesTaskId);
    if (!task) return;
    const hasPlan = Boolean(hermesTaskDraft.scheduledDate || hermesTaskDraft.scheduledTime);
    if (hasPlan && (!isDateKey(hermesTaskDraft.scheduledDate) || !isValidTime(hermesTaskDraft.scheduledTime))) {
      setModalError("Choose both a valid planned day and time, or clear both.");
      return;
    }
    const scheduledAt = hasPlan
      ? dublinDateTimeToInstant(hermesTaskDraft.scheduledDate, hermesTaskDraft.scheduledTime)
      : null;
    if (hasPlan && !scheduledAt) {
      setModalError("That Dublin time does not exist or repeats at a clock change. Choose another time.");
      return;
    }
    if (hermesTaskDraft.reminderMode !== "none" && !scheduledAt) {
      setModalError("Plan the task before adding a reminder.");
      return;
    }
    const reminderFireAt = scheduledAt && hermesTaskDraft.reminderMode !== "none"
      ? hermesTaskDraft.reminderMode === "one-hour"
        ? new Date(Date.parse(scheduledAt) - 60 * 60_000).toISOString()
        : dublinDateTimeToInstant(dublinDateKey(new Date(scheduledAt)), "09:00")
      : null;
    const annotation: HermesTaskAnnotationInput = {
      area: hermesTaskDraft.area,
      localState: scheduledAt ? "scheduled" : hermesTaskDraft.state,
      duration: hermesTaskDraft.duration,
      due: hermesTaskDraft.due,
      scheduledAt,
      reminderMode: hermesTaskDraft.reminderMode,
      reminderFireAt,
    };
    try {
      await hermes.updateAnnotation(task.id, annotation);
      setEditingHermesTaskId(null);
      setModalError("");
      setSaveError(null);
      setStatusMessage(`Saved Fox Focus details for “${task.title}”. Hermes still owns its title and completion state.`);
    } catch (error) {
      setModalError(error instanceof Error ? error.message : "Could not save this task's details.");
    }
  }

  async function completeHermesTask(task: HermesTask) {
    if (task.status === "done" || hermesCompletionPending) return;
    setHermesCompletionApproval(null);
    setHermesCompletionPending(task.id);
    setSaveError(null);
    try {
      const completed = await hermes.completeTask(task.id, {
        expectedVersion: task.version,
        confirmation: { beforeStatus: task.status, afterStatus: "done", confirmedAt: new Date().toISOString() },
      });
      setStatusMessage(completed.sourceProvider === "google" && completed.sourceStatus !== "completed"
        ? `Completed “${task.title}” in Hermes and verified it. Google Tasks is unchanged.`
        : `Completed “${task.title}” in Hermes and verified the result.`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Hermes could not complete this task. It remains open.");
    } finally {
      setHermesCompletionPending(null);
    }
  }

  async function waitForWorkspaceSaves() {
    await saveQueue.current;
    if (saveFailed.current) throw new Error("Fix the workspace save error before changing a linked source.");
  }

  function applyServerSnapshot(snapshot: ServerSnapshot) {
    revision.current = snapshot.revision;
    lastSaved.current = snapshot.data;
    saveFailed.current = false;
    setSaveError(null);
    setData(snapshot.data);
  }

  async function previewHermesAdoption(task: HermesTask) {
    if (!initial) return;
    setAdoptingHermesId(task.id);
    setStatusMessage("");
    try {
      await waitForWorkspaceSaves();
      const response = await fetch("/api/v1/task-adoptions/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "hermes", externalId: task.id }),
      });
      const value: unknown = await response.json();
      if (!response.ok || !isHermesAdoptionPreview(value)) {
        throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : "Could not prepare this Hermes task.");
      }
      setHermesAdoption(value);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not prepare this Hermes task.");
    } finally {
      setAdoptingHermesId(null);
    }
  }

  async function approveHermesAdoption() {
    if (!hermesAdoption) return;
    setAdoptingHermesId(hermesAdoption.after.id);
    try {
      await waitForWorkspaceSaves();
      const response = await fetch(`/api/v1/task-adoptions/${encodeURIComponent(hermesAdoption.id)}/approve`, { method: "POST" });
      const value: unknown = await response.json();
      const snapshot = isRecord(value) && isServerSnapshot(value.snapshot) ? value.snapshot : null;
      if (!response.ok || !snapshot) {
        throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : "Could not adopt this task.");
      }
      applyServerSnapshot(snapshot);
      setHermesAdoption(null);
      setStatusMessage("Task adopted. Fox Focus now owns its history.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not adopt this task.");
    } finally {
      setAdoptingHermesId(null);
    }
  }

  function openTaskComposer(task?: Task, inboxItem?: InboxItem, inboxRow?: InboxItemRow) {
    const row = task ? taskRowById.get(task.id) : undefined;
    const plan = task ? taskPlanById.get(task.id) : undefined;
    setTaskPlanVersion(plan?.version ?? null);
    setTaskInboxVersion(inboxRow?.version ?? null);
    const linkedEvent = task?.linkedEventId
      ? data.events.find((event) => event.id === task.linkedEventId)
      : undefined;
    const plannedInstant = plan?.plannedAt ?? linkedEvent?.startsAt ?? null;
    setTaskPlannedInstant(plannedInstant ? dublinInstantLocalValue(plannedInstant) : null);
    setTaskReminderInstant(null);
    setTaskReminderRequired(false);
    const startingArea = task?.area ?? inboxItem?.accent ?? (isOneOf(taskCategory, areas) ? taskCategory : "Personal");
    const mappedDestination = preferredTaskDestination(taskDestinations, startingArea);
    setTaskDraft({
      title: task?.title ?? inboxItem?.title ?? inboxRow?.title ?? "",
      area: mappedDestination && isOneOf(mappedDestination.area, areas) ? mappedDestination.area : startingArea,
      priority: plan?.priority ?? task?.priority ?? "medium",
      due: task?.due ?? "No deadline",
      deadlineDate: plan?.deadlineOn ?? task?.deadlineDate ?? (task ? legacyDeadlineDate(task.due, todayDate) : ""),
      duration: plan?.estimateMinutes ? `${plan.estimateMinutes} min` : task?.duration ?? "30 min",
      state: plan?.waiting ? "waiting" : task && task.state !== "done" ? task.state : "up-next",
      scheduledDate: plan?.plannedAt
        ? dublinDateKey(new Date(plan.plannedAt))
        : plan?.plannedOn ?? (linkedEvent ? eventDateKey(linkedEvent, todayDate) : task?.scheduledDate ?? (task ? "" : selectedDate)),
      scheduledTime: plan?.plannedAt
        ? dublinTimeValue(plan.plannedAt)
        : linkedEvent ? eventTimeValue(linkedEvent) : task?.scheduledTime ?? "",
      reminderMode: row?.binding.kind === "google" ? "none" : task ? reminderModeFor(data.reminders, task.id) : "none",
    });
    if (!task) {
      setTaskCreateNonce(globalThis.crypto?.randomUUID?.() ?? makeId("task"));
      setTaskNotes("");
      setTaskGoogleDue("");
      setTaskReminderLocal("");
      setTaskDestinationKey(mappedDestination ? destinationKey(mappedDestination) : "");
    }
    setModalError("");
    setShowTaskDetails(Boolean(task || inboxItem || inboxRow));
    setModal({ kind: "task", taskId: task?.id, inboxId: inboxItem?.id ?? inboxRow?.id });
  }

  function openBriefingTask(entry: BriefingEntry, withReminder: boolean) {
    openTaskComposer();
    const futureStart = entry.startsAt && Date.parse(entry.startsAt) > Date.now() ? entry.startsAt : null;
    const exactPlan = futureStart ? dublinInstantLocalValue(futureStart) : null;
    const reminder = withReminder ? briefingReminderSuggestion(entry, new Date()) : null;
    setTaskDraft((current) => ({
      ...current,
      title: entry.title,
      state: futureStart ? "scheduled" : "up-next",
      scheduledDate: futureStart ? dublinDateKey(new Date(futureStart)) : "",
      scheduledTime: futureStart ? dublinTimeValue(futureStart) : "",
    }));
    setTaskPlannedInstant(exactPlan);
    setTaskNotes([entry.summary.trim(), entry.url ? `Source: ${entry.url}` : ""].filter(Boolean).join("\n\n"));
    setTaskReminderLocal(reminder?.localValue ?? "");
    setTaskReminderInstant(reminder
      ? { localValue: reminder.localValue, instant: reminder.fireAt }
      : null);
    setTaskReminderRequired(withReminder);
    if (withReminder && !reminder) {
      setModalError("This event starts too soon for the default reminder. Choose another future time.");
    }
    setShowTaskDetails(true);
  }

  function openEventComposer(event?: TimelineEvent, inboxItem?: InboxItem) {
    if (event?.taskId && taskRowById.has(event.taskId)) {
      const task = taskById.get(event.taskId);
      if (task) openTaskComposer(task);
      return;
    }
    if (event && !event.editable) {
      setStatusMessage("Imported calendar context is read-only. Capture a local block if you need to change it.");
      return;
    }

    setEventDraft({
      title: event?.title ?? inboxItem?.title ?? "",
      subtitle: event?.subtitle ?? "",
      area: event?.area ?? inboxItem?.accent ?? "Personal",
      date: event ? eventDateKey(event, todayDate) : selectedDate,
      time: event ? eventTimeValue(event) : "09:00",
      duration: event ? String(event.duration) : "30",
      reminderMode: event ? reminderModeFor(data.reminders, event.id) : "none",
    });
    setModalError("");
    setModal({ kind: "event", eventId: event?.id, inboxId: inboxItem?.id });
  }

  async function queueTaskStatus(task: Task, row: TaskRow) {
    const desiredState = task.completed ? "open" : "completed";
    setBusyTaskIds((current) => new Set(current).add(task.id));
    setStatusMessage("");
    try {
      const { ok, value } = await requestTaskStatus(task.id, row.version, desiredState);
      const nextTask = isRecord(value) && isRowTask(value.task)
        ? value.task
        : isRecord(value) && isRowTask(value.current)
          ? value.current
          : null;
      const action = isRecord(value) && isTaskStatusActionRow(value.action) ? value.action : null;
      if (nextTask) setTaskRows((current) => current ? mergeTaskRows(current, {
        tasks: [nextTask],
        taskPlans: [],
        actions: action ? [action] : [],
      }) : current);
      if (!ok || !action) {
        throw new Error(isRecord(value) && typeof value.error === "string"
          ? value.error
          : "Could not record the Google task change.");
      }
      setStatusMessage(desiredState === "completed"
        ? `Completing "${task.title}" in Google Tasks.`
        : `Reopening "${task.title}" in Google Tasks.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not record the Google task change.");
    } finally {
      setBusyTaskIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  }

  function toggleTask(task: Task) {
    const row = taskRowById.get(task.id);
    if (initial) {
      if (!row) {
        setStatusMessage("Task rows are still loading.");
        return;
      }
      if (row.binding.kind === "google") {
        const action = latestActionByTask.get(task.id);
        if (action?.state === "queued" || action?.state === "running" || busyTaskIds.has(task.id)) return;
        if (action?.state === "conflict") {
          if (taskConflictFromAction(action)) setTaskConflictActionId(action.id);
          else setStatusMessage("Google changed, but its conflict snapshot is unavailable. Refresh sources before trying again.");
          return;
        }
        void queueTaskStatus(task, row);
        return;
      }
      setStatusMessage("This task stays with its current owner until migration.");
      return;
    }
    const nowCompleted = !task.completed;
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((candidate) =>
        candidate.id === task.id
          ? {
              ...candidate,
              completed: nowCompleted,
              state: nowCompleted ? "done" : candidate.scheduledTime ? "scheduled" : "up-next",
              completedAt: nowCompleted ? new Date().toISOString() : undefined,
            }
          : candidate,
      ),
      reminders: nowCompleted
        ? current.reminders.filter((reminder) => !(reminder.targetType === "task" && reminder.targetId === task.id))
        : current.reminders,
    }));
    if (nowCompleted) {
      const reminder = data.reminders.find((candidate) => candidate.targetType === "task" && candidate.targetId === task.id);
      const state: ActiveTaskState = task.state === "done" ? task.scheduledTime ? "scheduled" : "up-next" : task.state;
      setCompletionUndo({ taskId: task.id, state, ...(reminder ? { reminder } : {}) });
    } else setCompletionUndo(null);
    setStatusMessage(nowCompleted
      ? `Completed “${task.title}”. Reminder removed and linked calendar block marked done.`
      : `Reopened “${task.title}”. Its reminder stays off.`);
  }

  function approveTaskConflict() {
    if (!taskConflictActionId || !taskRows) return;
    const action = taskRows.actions.find((candidate) => candidate.id === taskConflictActionId);
    if (!action || action.state !== "conflict" || !taskConflictFromAction(action)) return;
    if (latestActionByTask.get(action.payload.taskId)?.id !== action.id) {
      setTaskConflictActionId(null);
      setStatusMessage("The task changed again. Review its latest state before approving.");
      return;
    }
    const task = taskById.get(action.payload.taskId);
    const row = taskRowById.get(action.payload.taskId);
    if (!task || row?.binding.kind !== "google") return;
    setTaskConflictActionId(null);
    void queueTaskStatus(task, row);
  }

  function undoTaskCompletion() {
    if (!completionUndo) return;
    const task = data.tasks.find((candidate) => candidate.id === completionUndo.taskId);
    if (!task?.completed) {
      setCompletionUndo(null);
      return;
    }

    setData((current) => ({
      ...current,
      tasks: current.tasks.map((candidate) =>
        candidate.id === task.id
          ? { ...candidate, completed: false, state: completionUndo.state, completedAt: undefined }
          : candidate,
      ),
      reminders: completionUndo.reminder
        ? [...current.reminders.filter((reminder) => !(reminder.targetType === "task" && reminder.targetId === task.id)), completionUndo.reminder]
        : current.reminders,
    }));
    setCompletionUndo(null);
    setStatusMessage(completionUndo.reminder
      ? `Reopened “${task.title}”. Its reminder was restored.`
      : `Reopened “${task.title}”. It had no reminder.`);
  }

  function openTaskSchedule(task: Task) {
    if (taskRowById.has(task.id)) {
      openTaskComposer(task);
      return;
    }
    if (!task.linkedEventId) {
      openTaskComposer(task);
      return;
    }
    const linkedEvent = data.events.find((event) => event.id === task.linkedEventId);
    if (!linkedEvent) {
      openTaskComposer(task);
      return;
    }
    const date = eventDateKey(linkedEvent, todayDate);
    setSelectedDate(date);
    setCalendarAnchor(date);
    setCalendarMode("day");
    setSelectedEventId(task.linkedEventId);
    openWorkspaceView("agenda");
  }

  async function refreshRowSnapshots(): Promise<void> {
    const [tasks, work] = await Promise.all([loadTaskRows(), loadWorkRows()]);
    setTaskRows((current) => mergeTaskRows(current, tasks));
    setWorkRows((current) => mergeWorkRows(current, work));
    setTaskRowsError(false);
    setWorkRowsError(false);
  }

  async function saveTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal || modal.kind !== "task") return;

    const title = taskDraft.title.trim();
    if (!title) {
      setModalError("Give the task a name before saving it.");
      return;
    }
    if (taskDraft.scheduledTime && !isValidTime(taskDraft.scheduledTime)) {
      setModalError("Choose a valid planned time before saving the task.");
      return;
    }
    const scheduledDate = taskDraft.scheduledDate || selectedDate;
    const plannedLocalValue = taskDraft.scheduledTime ? `${scheduledDate}T${taskDraft.scheduledTime}` : null;
    const plannedStartAt = plannedLocalValue
      ? taskPlannedInstant?.localValue === plannedLocalValue
        ? taskPlannedInstant.instant
        : dublinDateTimeToInstant(scheduledDate, taskDraft.scheduledTime)
      : null;
    if (taskDraft.scheduledTime && (!isDateKey(scheduledDate) || !plannedStartAt)) {
      setModalError("Choose a valid Dublin date and time. Times skipped or repeated at a clock change need another time.");
      return;
    }
    if (taskDraft.deadlineDate && !isDateKey(taskDraft.deadlineDate)) {
      setModalError("Choose a valid deadline or leave it blank.");
      return;
    }

    const existingTask = modal.taskId ? data.tasks.find((task) => task.id === modal.taskId) : undefined;
    const displayTask = modal.taskId ? taskById.get(modal.taskId) : undefined;
    const row = modal.taskId ? taskRowById.get(modal.taskId) : undefined;
    const plan = modal.taskId ? taskPlanById.get(modal.taskId) : undefined;
    if (displayTask && row) {
      if (!plan || taskPlanVersion === null) {
        setModalError("The local task plan is unavailable. Reload before saving.");
        return;
      }
      if (plan.version !== taskPlanVersion) {
        setModalError("The task plan changed while this editor was open. Close it and review the latest plan.");
        return;
      }
      const estimateMinutes = plan.estimateMinutes === null && taskDraft.duration === "30 min"
        ? null
        : parseDuration(taskDraft.duration);
      setTaskPlanBusy(true);
      setModalError("");
      try {
        const { ok, value } = await requestTaskPlan(row.id, {
          version: taskPlanVersion,
          priority: taskDraft.priority,
          waiting: taskDraft.state === "waiting",
          deadlineOn: taskDraft.deadlineDate || null,
          plannedOn: taskDraft.scheduledDate && !plannedStartAt ? taskDraft.scheduledDate : null,
          plannedAt: plannedStartAt,
          estimateMinutes,
        });
        const nextPlan = isRecord(value) && isTaskPlanRow(value.plan)
          ? value.plan
          : isRecord(value) && isTaskPlanRow(value.current)
            ? value.current
            : null;
        if (nextPlan) setTaskRows((current) => current ? mergeTaskRows(current, {
          tasks: [],
          taskPlans: [nextPlan],
          actions: [],
        }) : current);
        if (!ok || !nextPlan) {
          throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : "Could not save the task plan.");
        }
        setStatusMessage(`Saved the plan for "${displayTask.title}".`);
        setModal(null);
      } catch (error) {
        setModalError(error instanceof Error ? error.message : "Could not save the task plan.");
      } finally {
        setTaskPlanBusy(false);
      }
      return;
    }

    if (initial && !modal.taskId) {
      const destination = taskDestinations.find((candidate) => destinationKey(candidate) === taskDestinationKey);
      const inboxRow = modal.inboxId ? inboxRowById.get(modal.inboxId) : undefined;
      if (!destination) {
        setModalError(taskDestinationError || "Choose a Google task list before creating this task.");
        return;
      }
      if (!taskCreateNonce) {
        setModalError("The task identity is missing. Close this form and try again.");
        return;
      }
      if (taskGoogleDue && !isDateKey(taskGoogleDue)) {
        setModalError("Choose a valid Google due date or leave it blank.");
        return;
      }
      if (taskReminderRequired && !taskReminderLocal) {
        setModalError("Choose a future reminder time.");
        return;
      }
      const reminderAt = taskReminderLocal
        ? taskReminderInstant?.localValue === taskReminderLocal
          ? taskReminderInstant.instant
          : dublinLocalReminderInstant(taskReminderLocal)
        : null;
      if (taskReminderLocal && (!reminderAt || Date.parse(reminderAt) <= Date.now())) {
        setModalError("Choose a future reminder time that occurs once in Dublin time.");
        return;
      }
      if (/^\s*Fox-Focus-ID\s*:/im.test(taskNotes)) {
        setModalError("Remove the Fox-Focus-ID line from notes. Fox Focus adds it.");
        return;
      }
      if (modal.inboxId && (taskInboxVersion === null || !inboxRow || inboxRow.version !== taskInboxVersion)) {
        setModalError("The Inbox item changed while this editor was open. Close it and review the latest item.");
        return;
      }
      setTaskPlanBusy(true);
      setModalError("");
      try {
        await createGoogleTask({
          destination: { accountId: destination.accountId, listId: destination.listId },
          nonce: taskCreateNonce,
          title,
          notes: taskNotes.trim(),
          doOn: taskGoogleDue || null,
          plan: {
            priority: taskDraft.priority,
            waiting: taskDraft.state === "waiting",
            deadlineOn: taskDraft.deadlineDate || null,
            plannedOn: taskDraft.scheduledDate && !plannedStartAt ? taskDraft.scheduledDate : null,
            plannedAt: plannedStartAt,
            estimateMinutes: parseDuration(taskDraft.duration),
          },
          ...(modal.inboxId && taskInboxVersion !== null
            ? { inbox: { id: modal.inboxId, version: taskInboxVersion } }
            : {}),
          ...(reminderAt ? { reminder: { fireAt: reminderAt } } : {}),
        });
        await refreshRowSnapshots();
        setStatusMessage(`Creating "${title}" in ${destination.listName}.`);
        setModal(null);
      } catch (error) {
        try { await refreshRowSnapshots(); } catch { /* the original error is more useful */ }
        setModalError(error instanceof Error ? error.message : "Could not create the Google task.");
      } finally {
        setTaskPlanBusy(false);
      }
      return;
    }

    const inboxItem = modal.inboxId ? data.inboxItems.find((item) => item.id === modal.inboxId) : undefined;
    const taskId = existingTask?.id ?? makeId("task");
    const origin: TaskOrigin = existingTask?.origin ?? (inboxItem ? "inbox" : "manual");
    const source = existingTask?.source ?? (inboxItem ? `Inbox · ${inboxItem.source}` : undefined);
    const linkedEventId = taskDraft.scheduledTime ? existingTask?.linkedEventId ?? makeId("event") : undefined;
    const linkedEventOrigin: EventOrigin = inboxItem ? "inbox" : "task";
    const linkedEvent = linkedEventId && plannedStartAt
      ? {
          id: linkedEventId,
          title,
          subtitle: `${taskDraft.area} task · ${taskDraft.duration}`,
          area: taskDraft.area,
          startsAt: plannedStartAt,
          duration: parseDuration(taskDraft.duration),
          editable: true,
          origin: linkedEventOrigin,
          taskId,
          source: source ? `Local task schedule · ${source}` : "Local task schedule",
        }
      : null;
    const createdAt = existingTask?.createdAt ?? (existingTask ? undefined : new Date().toISOString());
    const nextTask: Task = {
      id: taskId,
      title,
      area: taskDraft.area,
      state: existingTask?.completed ? "done" : taskDraft.scheduledTime ? "scheduled" : taskDraft.state,
      duration: taskDraft.duration,
      due: taskDraft.deadlineDate ? deadlineDateLabel(taskDraft.deadlineDate, todayDate) : "No deadline",
      priority: taskDraft.priority,
      completed: existingTask?.completed ?? false,
      scheduledTime: taskDraft.scheduledTime || null,
      ...(taskDraft.scheduledTime ? { scheduledDate } : {}),
      linkedEventId,
      origin,
      ...(source ? { source } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(taskDraft.deadlineDate ? { deadlineDate: taskDraft.deadlineDate } : {}),
      ...(existingTask?.completedAt ? { completedAt: existingTask.completedAt } : {}),
      ...(existingTask?.externalLinks ? { externalLinks: existingTask.externalLinks } : {}),
    };

    setData((current) => {
      const tasks = existingTask
        ? current.tasks.map((candidate) => (candidate.id === existingTask.id ? nextTask : candidate))
        : [nextTask, ...current.tasks];
      const removedOldLinkedEvent = existingTask?.linkedEventId && !linkedEvent
        ? current.events.filter((candidate) => candidate.id !== existingTask.linkedEventId)
        : current.events;
      const events = linkedEvent
        ? removedOldLinkedEvent.some((candidate) => candidate.id === linkedEvent.id)
          ? removedOldLinkedEvent.map((candidate) => (candidate.id === linkedEvent.id ? linkedEvent : candidate))
          : [...removedOldLinkedEvent, linkedEvent]
        : removedOldLinkedEvent;

      return {
        ...current,
        tasks,
        events,
        inboxItems: modal.inboxId
          ? current.inboxItems.map((item) => item.id === modal.inboxId ? { ...item, status: "handled" } : item)
          : current.inboxItems,
        reminders: updateReminder(current.reminders, taskId, "task", title, taskDraft.reminderMode, plannedStartAt),
      };
    });

    if (completionUndo?.taskId === taskId) setCompletionUndo(null);
    if (linkedEventId) {
      setSelectedDate(scheduledDate);
      setCalendarAnchor(scheduledDate);
      setCalendarMode("day");
      setSelectedEventId(linkedEventId);
    }
    if (inboxItem) {
      setSelectedInboxId(reviewItems.find((item) => item.id !== inboxItem.id && item.status !== "handled")?.id ?? inboxItem.id);
    }
    setStatusMessage(inboxItem ? `Accepted “${title}” as a local task.` : `Saved “${title}”.`);
    setModalError("");
    setModal(null);
  }

  function saveEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal || modal.kind !== "event") return;

    const displayedEvent = modal.eventId ? eventById.get(modal.eventId) : undefined;
    if (displayedEvent?.taskId && taskRowById.has(displayedEvent.taskId)) {
      const task = taskById.get(displayedEvent.taskId);
      if (task) openTaskComposer(task);
      return;
    }

    const title = eventDraft.title.trim();
    if (!title) {
      setModalError("Give the calendar block a name before saving it.");
      return;
    }
    if (!isValidTime(eventDraft.time)) {
      setModalError("Choose a valid start time before saving the calendar block.");
      return;
    }
    const startsAt = isDateKey(eventDraft.date)
      ? dublinDateTimeToInstant(eventDraft.date, eventDraft.time)
      : null;
    if (!startsAt) {
      setModalError("Choose a valid Dublin date and time. Times skipped or repeated at a clock change need another time.");
      return;
    }

    const existingEvent = modal.eventId ? data.events.find((candidate) => candidate.id === modal.eventId) : undefined;
    if (existingEvent?.taskId && taskRowById.has(existingEvent.taskId)) {
      const task = taskById.get(existingEvent.taskId);
      if (task) openTaskComposer(task);
      return;
    }
    const inboxItem = modal.inboxId ? data.inboxItems.find((item) => item.id === modal.inboxId) : undefined;
    const eventId = existingEvent?.id ?? makeId("event");
    const source = existingEvent?.source ?? (inboxItem ? `Inbox · ${inboxItem.source}` : "Local calendar block");
    const nextEvent: TimelineEvent = {
      id: eventId,
      title,
      subtitle: eventDraft.subtitle.trim() || "Local calendar block",
      area: eventDraft.area,
      startsAt,
      duration: parseDuration(eventDraft.duration),
      editable: true,
      origin: existingEvent?.origin === "task" ? "task" : inboxItem ? "inbox" : "local",
      ...(existingEvent?.taskId ? { taskId: existingEvent.taskId } : {}),
      source,
    };

    setData((current) => ({
      ...current,
      tasks: existingEvent?.taskId && !rowTaskIds.has(existingEvent.taskId)
        ? current.tasks.map((task) =>
            task.id === existingEvent.taskId
              ? {
                  ...task,
                  title,
                  area: eventDraft.area,
                  duration: formatDuration(nextEvent.duration),
                  scheduledTime: eventDraft.time,
                  state: task.completed ? "done" : "scheduled",
                }
              : task,
          )
        : current.tasks,
      events: existingEvent
        ? current.events.map((candidate) => (candidate.id === existingEvent.id ? nextEvent : candidate))
        : [...current.events, nextEvent],
      inboxItems: modal.inboxId
        ? current.inboxItems.map((item) => item.id === modal.inboxId ? { ...item, status: "handled" } : item)
        : current.inboxItems,
      reminders: updateReminder(current.reminders, eventId, "event", title, eventDraft.reminderMode, startsAt),
    }));

    if (existingEvent?.taskId && completionUndo?.taskId === existingEvent.taskId) setCompletionUndo(null);
    setSelectedDate(eventDraft.date);
    setCalendarAnchor(eventDraft.date);
    setCalendarMode("day");
    setSelectedEventId(eventId);
    if (inboxItem) {
      setSelectedInboxId(reviewItems.find((item) => item.id !== inboxItem.id && item.status !== "handled")?.id ?? inboxItem.id);
    }
    setStatusMessage(inboxItem ? `Accepted “${title}” as a local calendar block.` : `Saved “${title}”.`);
    setModalError("");
    setModal(null);
  }

  function deleteEvent() {
    if (!modal || modal.kind !== "event" || !modal.eventId) return;
    const eventToRemove = data.events.find((event) => event.id === modal.eventId);
    if (!eventToRemove?.editable) return;
    if (eventToRemove.taskId && taskRowById.has(eventToRemove.taskId)) {
      const task = taskById.get(eventToRemove.taskId);
      if (task) openTaskComposer(task);
      return;
    }

    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.linkedEventId === eventToRemove.id && !rowTaskIds.has(task.id)
          ? { ...task, linkedEventId: undefined, scheduledTime: null, state: task.completed ? "done" : "up-next" }
          : task,
      ),
      events: current.events.filter((event) => event.id !== eventToRemove.id),
      inboxItems: current.inboxItems,
      reminders: current.reminders.filter((reminder) => reminder.targetId !== eventToRemove.id),
    }));
    if (eventToRemove.taskId && completionUndo?.taskId === eventToRemove.taskId) setCompletionUndo(null);
    setSelectedEventId(null);
    setStatusMessage(`Removed local block “${eventToRemove.title}”.`);
    setModal(null);
  }

  function selectWorkThread(thread: WorkThread) {
    setSelectedWorkKey(thread.key);
    setWorkDetailOpen(true);
    setJobReply("");
  }

  function moveWorkSelection(delta: number) {
    const index = selectedWorkIndex >= 0 ? selectedWorkIndex : 0;
    const next = visibleWorkThreads[Math.max(0, Math.min(visibleWorkThreads.length - 1, index + delta))];
    if (next) selectWorkThread(next);
  }

  async function runWorkMutation(key: string, operation: () => Promise<unknown>, message: string): Promise<boolean> {
    if (workBusyKey) return false;
    setWorkBusyKey(key);
    setStatusMessage("");
    try {
      await operation();
      setStatusMessage(message);
    } catch (error) {
      try { await refreshRowSnapshots(); } catch {
        setTaskRowsError(true);
        setWorkRowsError(true);
      }
      setStatusMessage(error instanceof Error ? error.message : "The Inbox change could not be saved.");
      return false;
    } finally {
      setWorkBusyKey(null);
    }
    try { await refreshRowSnapshots(); } catch {
      setTaskRowsError(true);
      setWorkRowsError(true);
    }
    return true;
  }

  function sendWorkItem(item: InboxItemRow) {
    const draft = draftByInboxId.get(item.id);
    const state = emailSendUiState(
      item,
      draft,
      latestSendActionByInbox.get(item.id),
      workRows?.capabilities.emailSendEnabled ?? false,
    );
    if (!draft || state !== "ready") {
      setStatusMessage(state === "sending"
        ? "This reply is already with Hermes."
        : state === "reconciling"
          ? "Hermes is reconciling this send."
          : state === "unknown"
            ? "Hermes must reconcile this send before anything else changes."
            : state === "failed"
              ? "This send failed and needs review."
              : "Email sending is not available.");
      return;
    }
    void runWorkMutation(
      `inbox:${item.id}:send`,
      () => approveEmailSend(item, draft),
      "Approved reply handed to Hermes.",
    );
  }

  function chooseNextWorkThread(currentKey: string): boolean {
    const next = [...needsYouThreads, ...workingThreads].find((thread) => thread.key !== currentKey);
    if (next) {
      setSelectedWorkKey(next.key);
      return true;
    }
    setSelectedWorkKey(null);
    setWorkDetailOpen(false);
    return false;
  }

  function dismissWorkItem(item: InboxItemRow) {
    const key = `inbox:${item.id}`;
    chooseNextWorkThread(key);
    void runWorkMutation(key, () => decideInboxItem(item, {
      state: "resolved",
      outcome: "dismissed",
      snoozedUntil: null,
    }), "Dismissed from the Inbox.");
  }

  function canMutateInboxItem(item: InboxItemRow): boolean {
    return item.state !== "resolved" &&
      !emailSendBlocksInboxMutation(latestSendActionByInbox.get(item.id)) && workBusyKey === null;
  }

  function openReplyEditor(item: InboxItemRow) {
    const draft = draftByInboxId.get(item.id);
    if (!draft) {
      setStatusMessage("There is no reply draft to edit yet.");
      return;
    }
    setEditingReply({
      inboxId: item.id,
      inboxVersion: item.version,
      reply: {
        ...draft.reply,
        references: [...draft.reply.references],
        to: [...draft.reply.to],
        cc: [...draft.reply.cc],
        bcc: [...draft.reply.bcc],
      },
    });
    setModalError("");
  }

  async function saveReplyEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingReply) return;
    const item = inboxRowById.get(editingReply.inboxId);
    if (!item) {
      setModalError("This Inbox item is no longer available.");
      return;
    }
    if (item.version !== editingReply.inboxVersion) {
      setModalError("The Inbox item changed while this draft was open. Close it and review the latest draft.");
      return;
    }
    const reply = {
      ...editingReply.reply,
      from: editingReply.reply.from.trim(),
      to: editingReply.reply.to.map((address) => address.trim()).filter(Boolean),
      cc: editingReply.reply.cc.map((address) => address.trim()).filter(Boolean),
      bcc: editingReply.reply.bcc.map((address) => address.trim()).filter(Boolean),
    };
    if (!reply.from || !reply.to.length) {
      setModalError("Add the sender and at least one recipient.");
      return;
    }
    setWorkBusyKey(`draft:${item.id}`);
    setModalError("");
    try {
      await saveOwnerDraft({ id: item.id, version: editingReply.inboxVersion }, reply);
      await refreshRowSnapshots();
      setEditingReply(null);
      setStatusMessage("Saved a new owner draft revision.");
    } catch (error) {
      try { await refreshRowSnapshots(); } catch { /* the original error is more useful */ }
      setModalError(error instanceof Error ? error.message : "The draft could not be saved.");
    } finally {
      setWorkBusyKey(null);
    }
  }

  function openJobComposer(
    input: { title: string; taskId?: string; inboxId?: string; context?: string },
    initialInstruction = "",
  ) {
    const existing = (workRows?.jobs ?? []).find((job) => job.state !== "settled" && (
      (input.inboxId !== undefined && job.inboxId === input.inboxId) ||
      (input.taskId !== undefined && job.taskId === input.taskId)
    ));
    if (existing) {
      setModal(null);
      setSelectedWorkKey(existing.inboxId && !existing.taskId ? `inbox:${existing.inboxId}` : `job:${existing.id}`);
      setWorkDetailOpen(true);
      openWorkspaceView("review");
      setStatusMessage("Hermes already has an active request for this item.");
      return;
    }
    setEditingHermesTaskId(null);
    setJobComposer({ ...input, idempotencyKey: makeId("job-request") });
    setJobInstruction(initialInstruction);
    setModalError("");
    setModal(null);
  }

  function openTaskJobComposer(task: Task, initialInstruction = "") {
    const row = taskRowById.get(task.id);
    const canCompleteFromResult = row?.binding.kind === "google" && row.observed !== null &&
      row.unavailableAt === null && (row.observed.completionWritable || row.observed.status === "completed");
    const plannedDate = plannedDateForTask(task);
    const context = [
      `Task: ${task.title}`,
      `Area: ${task.area}`,
      `State: ${task.completed ? "completed" : task.state}`,
      task.deadlineDate ? `Deadline: ${task.deadlineDate}` : task.due ? `Due: ${task.due}` : "",
      plannedDate ? `Planned: ${plannedDate}${task.scheduledTime ? ` at ${task.scheduledTime}` : ""}` : "",
      task.duration ? `Estimate: ${task.duration}` : "",
    ].filter(Boolean).join(" · ");
    openJobComposer({
      title: task.title,
      ...(canCompleteFromResult ? { taskId: task.id } : {}),
      context,
    }, initialInstruction);
  }

  async function submitJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!jobComposer || !jobComposer.title.trim() || !jobInstruction.trim()) {
      setModalError("Add a one-line title and short instruction for Hermes.");
      return;
    }
    const context = jobComposer.context?.trim();
    const instruction = `${jobInstruction.trim()}${context ? `\n\nContext: ${context}` : ""}`;
    if (instruction.length > 2_000) {
      setModalError("Shorten the request so its context fits within 2,000 characters.");
      return;
    }
    setWorkBusyKey("job:create");
    setModalError("");
    try {
      const job = await createJob({
        idempotencyKey: jobComposer.idempotencyKey,
        title: jobComposer.title.trim(),
        instruction,
        taskId: jobComposer.taskId,
        inboxId: jobComposer.inboxId,
      });
      setWorkRows((current) => mergeWorkRows(current, {
        inbox: [],
        drafts: [],
        jobs: [job],
        jobUpdates: [],
        actions: [],
        reminders: [],
        briefings: [],
        capabilities: current?.capabilities ?? { emailSendEnabled: false },
      }));
      setJobComposer(null);
      setStatusMessage("Queued for Hermes. It will show as Working when claimed.");
      try { await refreshRowSnapshots(); } catch { setWorkRowsError(true); }
    } catch (error) {
      setModalError(error instanceof Error ? error.message : "The job could not be queued.");
    } finally {
      setWorkBusyKey(null);
    }
  }

  function answerSelectedJob(job: Job) {
    const answer = jobReply.trim();
    if (!answer) {
      setStatusMessage("Write a one-line answer first.");
      return;
    }
    void runWorkMutation(`job:${job.id}`, () => answerJob(job, answer), "Answer sent to Hermes.");
    setJobReply("");
  }

  function sendBackSelectedJob(job: Job) {
    const note = jobReply.trim();
    if (!note) {
      setStatusMessage("Write a one-line send-back note first.");
      return;
    }
    void runWorkMutation(`job:${job.id}`, () => sendBackJob(job, note), "Sent back to Hermes.");
    setJobReply("");
  }

  function settleSelectedJob(job: Job, outcome: "accepted" | "dropped") {
    const task = job.taskId ? taskRowById.get(job.taskId) : undefined;
    if (outcome === "accepted" && !canAcceptJob(job)) {
      setStatusMessage("The linked Google task is not ready for completion.");
      return;
    }
    const threadKey = selectedWorkThread?.job?.id === job.id
      ? selectedWorkThread.key
      : job.inboxId && !job.taskId && inboxRowById.has(job.inboxId)
        ? `inbox:${job.inboxId}`
        : `job:${job.id}`;
    void runWorkMutation(threadKey, () => settleJob(job, outcome, outcome === "accepted" ? task?.version : undefined),
      outcome === "accepted" ? "Accepted the result." : "Dropped the job.").then((settled) => {
      if (settled) chooseNextWorkThread(threadKey);
    });
  }

  function canAcceptJob(job: Job): boolean {
    if (!job.taskId) return true;
    const task = taskRowById.get(job.taskId);
    if (!task?.observed) return false;
    const runningStatusAction = (taskRows?.actions ?? []).some((action) => action.state === "running" &&
      action.payload.kind === "task-status" && action.payload.taskId === task.id);
    if (runningStatusAction) return false;
    const queuedReopen = (taskRows?.actions ?? []).some((action) => action.payload.taskId === task.id &&
      action.payload.after === "open" && (action.state === "queued" || action.state === "failed"));
    if (task.observed.status === "completed" && !queuedReopen) return true;
    return task.binding.kind === "google" && task.observed.completionWritable && task.unavailableAt === null;
  }

  function selectInbox(item: InboxItem) {
    setSelectedInboxId(item.id);
    setAgentRequest(item.moreWork ?? "");
  }

  function moveInboxSelection(delta: number) {
    if (selectedInboxIndex < 0) return;
    const next = reviewItems[Math.max(0, Math.min(reviewItems.length - 1, selectedInboxIndex + delta))];
    if (next) selectInbox(next);
  }

  function toggleInboxHandled(item: InboxItem) {
    const nextStatus: InboxStatus = item.status === "handled" ? "new" : "handled";
    setData((current) => ({
      ...current,
      inboxItems: current.inboxItems.map((candidate) => candidate.id === item.id ? { ...candidate, status: nextStatus } : candidate),
    }));
    setReviewUndo({ itemId: item.id, status: item.status });
    setCompletionUndo(null);
    if (nextStatus === "handled") {
      const next = reviewItems.find((candidate) => candidate.id !== item.id && candidate.status !== "handled");
      if (next) selectInbox(next);
    } else selectInbox(item);
    setStatusMessage(nextStatus === "handled" ? `Marked “${item.title}” as handled. Nothing changed at its source.` : `Returned “${item.title}” to review.`);
  }

  function undoInboxChange() {
    if (!reviewUndo) return;
    setData((current) => ({
      ...current,
      inboxItems: current.inboxItems.map((item) => item.id === reviewUndo.itemId ? { ...item, status: reviewUndo.status } : item),
    }));
    setSelectedInboxId(reviewUndo.itemId);
    setReviewUndo(null);
    setStatusMessage("Review decision undone.");
  }

  function acceptInbox(destination: InboxDestination) {
    if (!selectedInbox) return;
    if (destination === "task") openTaskComposer(undefined, selectedInbox);
    else openEventComposer(undefined, selectedInbox);
  }

  function openDraft(item: InboxItem) {
    setSelectedInboxId(item.id);
    setDraftText(
      item.draft ??
        `Hi,\n\nI’ve reviewed the details and can take the next step once you confirm the preferred option.\n\nThanks,`,
    );
    setModalError("");
    setModal({ kind: "draft", inboxId: item.id });
  }

  function saveDraft() {
    if (!modal || modal.kind !== "draft") return;
    const text = draftText.trim();
    if (!text) {
      setModalError("Write a draft before saving it for review.");
      return;
    }
    setData((current) => ({
      ...current,
      inboxItems: current.inboxItems.map((item) =>
        item.id === modal.inboxId ? { ...item, draft: text, status: "draft-ready" } : item,
      ),
    }));
    setStatusMessage("Draft saved in the Inbox. Nothing was sent.");
    setModalError("");
    setModal(null);
  }

  function saveMoreWork() {
    if (!selectedInbox) return;
    const request = agentRequest.trim();
    if (!request) {
      setStatusMessage("Add a short feedback note before saving it.");
      return;
    }
    setData((current) => ({
      ...current,
      inboxItems: current.inboxItems.map((item) =>
        item.id === selectedInbox.id ? { ...item, moreWork: request, status: "waiting-on-agent" } : item,
      ),
    }));
    setStatusMessage("Feedback saved locally. It has not been delivered to Hermes.");
  }

  useEffect(() => {
    const onInboxKeyDown = (event: KeyboardEvent) => {
      if (activeSection !== "review" || isOverlayOpen || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!(event.target instanceof HTMLElement) || !event.target.closest(".work-inbox") || event.target.isContentEditable ||
        event.target.closest("input, textarea, select, [contenteditable='true']")) return;
      const thread = selectedWorkThread;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        moveWorkSelection(event.key === "j" ? 1 : -1);
        return;
      }
      if (!thread) return;
      const item = thread.kind === "inbox" ? thread.item : null;
      const job = thread.job;
      const canAct = item ? canMutateInboxItem(item) : false;
      const canAskHermes = Boolean(item && !job && canAct);
      if (event.key === "h" && canAskHermes && item) {
        event.preventDefault();
        openJobComposer({ title: item.title, inboxId: item.id });
      } else if (event.key === "x" && canAct && item) {
        event.preventDefault();
        dismissWorkItem(item);
      } else if (event.key === "a" && job?.state === "review" && workBusyKey === null) {
        event.preventDefault();
        settleSelectedJob(job, "accepted");
      } else if (event.key === "b" && job?.state === "review" && workBusyKey === null) {
        event.preventDefault();
        document.getElementById("job-reply")?.focus();
      }
    };
    window.addEventListener("keydown", onInboxKeyDown);
    return () => window.removeEventListener("keydown", onInboxKeyDown);
  });

  function testReminder() {
    const reminder = activeReminders[0];
    if (!reminder) {
      setStatusMessage("There are no upcoming reminders to preview.");
      return;
    }
    setShowReminderTray(false);
    setActiveReminderId(reminder.id);
  }

  function snoozeReminder() {
    if (!activeReminder) return;
    if (activeReminder.source !== "workspace") {
      setActiveReminderId(null);
      setStatusMessage(activeReminder.source === "hermes"
        ? "Edit the Hermes task plan to change this reminder."
        : "This task reminder is already fixed to its approved time.");
      return;
    }
    setData((current) => ({
      ...current,
      reminders: current.reminders.map((reminder) =>
        reminder.id === activeReminder.id
          ? { ...reminder, state: "scheduled", when: "in 30 min", fireAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), firedAt: undefined, snoozedUntil: undefined }
          : reminder,
      ),
    }));
    setActiveReminderId(null);
    setStatusMessage(`Snoozed “${activeReminder.title}” for 30 minutes.`);
  }

  async function requestNotificationPermission() {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      setPushSupported(false);
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission !== "granted") return;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushSupported(false);
        return;
      }
      const registration = serviceWorkerRegistration.current ?? await navigator.serviceWorker.register("/sw.js");
      serviceWorkerRegistration.current = registration;
      const keyResponse = await fetch("/api/v1/push/public-key");
      if (!keyResponse.ok) throw new Error("Could not load the notification key");
      const keyBody: unknown = await keyResponse.json();
      if (!isRecord(keyBody) || typeof keyBody.publicKey !== "string") throw new Error("Invalid notification key");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(keyBody.publicKey),
      });
      try {
        await saveDevicePushSubscription(subscription);
      } catch {
        await subscription.unsubscribe();
        throw new Error("Could not save this browser subscription");
      }
      setPushSupported(true);
      setPushSubscribed(true);
    } catch {
      setNotificationPermission(Notification.permission);
      setStatusMessage("Could not enable device notifications.");
    }
  }

  async function turnOffDeviceNotifications() {
    const subscription = await serviceWorkerRegistration.current?.pushManager.getSubscription();
    if (!subscription) {
      setPushSubscribed(false);
      return;
    }
    const endpoint = subscription.endpoint;
    const unsubscribed = await subscription.unsubscribe();
    if (!unsubscribed) {
      setStatusMessage("Could not turn off device notifications.");
      return;
    }
    setPushSubscribed(false);
    try {
      const response = await fetch("/api/v1/push/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      if (!response.ok) throw new Error("Delete failed");
    } catch {
      setStatusMessage("Notifications are off here. The server will remove the old subscription later.");
    }
  }

  const themeTarget = resolvedTheme === "black" ? "light" : "dark";
  const notificationStatus = pushSubscribed
    ? "Device notifications on for this browser"
      : notificationPermission === "denied"
      ? "Blocked in browser settings"
      : notificationPermission === "unsupported" || pushSupported === false
        ? "Not supported in this browser"
        : null;

  function plannedDateForTask(task: Task): string | undefined {
    const linkedEvent = task.linkedEventId ? eventById.get(task.linkedEventId) : undefined;
    return linkedEvent ? eventDateKey(linkedEvent, todayDate) : task.scheduledDate;
  }

  function renderTaskRow(task: Task, compact = false) {
    const row = taskRowById.get(task.id);
    const action = latestActionByTask.get(task.id);
    const googleOwned = row?.binding.kind === "google";
    const createAction = createActionByTask.get(task.id);
    const pendingCreate = row?.binding.kind === "pending" ? createAction : undefined;
    const createNeedsReview = createAction?.state === "failed" || createAction?.state === "conflict" || createAction?.state === "unknown";
    const pending = action?.state === "queued" || action?.state === "running" ||
      pendingCreate?.state === "queued" || pendingCreate?.state === "running";
    const unavailable = googleOwned && (row.observed?.completionWritable !== true || row.unavailableAt !== null);
    return <TaskRow
      compact={compact}
      key={task.id}
      task={task}
      dueLabel={taskDeadlineLabel(task, todayDate)}
      latestAction={action}
      plannedDate={plannedDateForTask(task)}
      sourceBadge={createNeedsReview ? <em className={`task-action-state task-action-state--${createAction.state}`}>{actionStateLabel(createAction)}</em> : googleOwned ? <em className="source-chip">Google Tasks</em> : pendingCreate ? <em className={`task-action-state task-action-state--${pendingCreate.state}`}>Google {pendingCreate.state}</em> : undefined}
      toggleBusy={busyTaskIds.has(task.id) || pending}
      toggleDisabled={Boolean(initial && (!googleOwned || unavailable))}
      onToggle={toggleTask}
      onEdit={openTaskComposer}
    />;
  }

  function renderScheduleRow(event: TimelineEvent, displayDate: string, showDate = false, isNext = false) {
    const linkedTask = event.taskId ? taskById.get(event.taskId) : undefined;
    const linkedTaskDone = linkedTask?.completed === true;
    const date = eventDateKey(event, todayDate);
    const time = eventTimeValue(event);
    const continuesFromEarlierDay = displayDate !== date;
    const isCurrent = isCurrentCalendarEvent(event);

    return (
      <button
        className={`schedule-row${showDate ? " schedule-row--dated" : ""}${event.id === selectedEvent?.id ? " schedule-row--selected" : ""}${isCurrent ? " schedule-row--now" : ""}${linkedTaskDone ? " schedule-row--done" : ""}${event.editable ? "" : " schedule-row--imported"}`}
        key={event.id}
        type="button"
        aria-pressed={event.id === selectedEvent?.id}
        aria-current={isCurrent ? "time" : undefined}
        onClick={() => setSelectedEventId(event.id)}
      >
        <time dateTime={event.startsAt ?? time}>
          {showDate
            ? <><span>{formatDublinDateKey(displayDate, { weekday: "short", day: "numeric" })}</span><small>{continuesFromEarlierDay ? "Continues" : time}</small></>
            : continuesFromEarlierDay ? "Continues" : time}
        </time>
        <i className={`area-dot area-dot--${areaClass(event.area)}`} />
        <span className="schedule-row-copy">
          <strong>{isCurrent ? <em className="event-now-label">Now</em> : isNext ? <em className="event-next-label">Next</em> : null}{event.title}</strong>
          <small>{!event.editable ? <em className="agenda-origin agenda-origin--imported">Imported</em> : null}{event.subtitle}</small>
        </span>
        <span className="schedule-duration">{formatDuration(event.duration)}</span>
        <ChevronRight className="schedule-arrow" size={14} />
      </button>
    );
  }

  function renderDaySchedule(events: TimelineEvent[], date: string, showDate = false): ReactNode[] {
    const nextIndex = date === todayDate
      ? events.findIndex((event) => {
          const start = eventStartInstant(event, todayDate);
          return start !== null && Date.parse(start) > now.getTime();
        })
      : -1;
    const rows: ReactNode[] = events.map((event, index) => renderScheduleRow(event, date, showDate, index === nextIndex));
    if (date !== todayDate) return rows;
    const lineIndex = nextIndex === -1 ? rows.length : nextIndex;
    rows.splice(lineIndex, 0, <div className="calendar-now-line" role="separator" aria-label={`Now ${dublinTimeValue(now)}`} key={`now:${date}`}><span>Now {dublinTimeValue(now)}</span><i /></div>);
    return rows;
  }

  function askHermesAboutEvent(event: TimelineEvent) {
    const date = eventDateKey(event, todayDate);
    const context = `${event.title} · ${formatDublinDateKey(date, { weekday: "long", day: "numeric", month: "long" })} at ${eventTimeValue(event)} · ${formatDuration(event.duration)} · ${event.source ?? event.subtitle}`;
    openJobComposer({ title: `Review ${event.title}`, context }, "Review this calendar event and tell me the useful next step.");
  }

  function openTodayEvent(event: TimelineEvent) {
    returnCalendarToToday();
    setSelectedEventId(event.id);
    openWorkspaceView("agenda");
  }

  function openTodayInbox(item: InboxItem) {
    selectInbox(item);
    openWorkspaceView("review");
  }

  function openTodayWorkThread(thread: WorkThread) {
    selectWorkThread(thread);
    setWorkDetailOpen(true);
    openWorkspaceView("review");
  }

  function renderTodayView() {
    const openReviewItems = reviewItems.filter((item) => item.status !== "handled").slice(0, 3);
    const todayWorkThreads = needsYouThreads.slice(0, 3);

    return <section className="workspace-page workspace-page--today" aria-labelledby="today-heading">
      <header className="workspace-heading today-heading">
        <div>
          <p className="eyebrow">{formatDublinDateKey(todayDate, { weekday: "long", day: "numeric", month: "long" })}</p>
          <h1 id="today-heading">Today</h1>
          <p>A short view of what needs your attention now.</p>
        </div>
      </header>

      {initial && hermes.failed ? <p className="workspace-alert"><Bot size={14} /> Hermes could not refresh. Your Fox Focus tasks are still available.</p> : null}

      {todayBriefing ? <article className={`pane today-briefing${briefingOpen ? " today-briefing--open" : ""}`}>
        <button className="today-briefing-toggle" type="button" aria-expanded={briefingOpen} onClick={() => setBriefingOpen((open) => !open)}>
          <span className="today-briefing-title"><Newspaper size={14} /><strong>Briefing</strong><small>{relativeTime(todayBriefing.updatedAt)}</small></span>
          <span className="today-briefing-counts">{[
            briefingNewsCount ? `${briefingNewsCount} news` : "",
            briefingEventCount ? `${briefingEventCount} event${briefingEventCount === 1 ? "" : "s"}` : "",
          ].filter(Boolean).join(" · ")}</span>
          <ChevronDown size={14} />
        </button>
        {briefingOpen ? <div className="today-briefing-entries">
          {todayBriefing.entries.map((entry, index) => <article className="today-briefing-entry" key={`${entry.kind}:${entry.title}:${index}`}>
            <i className={`inbox-thread-dot inbox-thread-dot--${entry.kind === "event" ? "working" : "settled"}`} />
            <div className="today-briefing-copy">
              <header><span>{entry.kind}</span>{entry.startsAt ? <time dateTime={entry.startsAt}>{formatDublinInstant(entry.startsAt)}</time> : null}</header>
              <strong>{entry.url ? <a href={entry.url} target="_blank" rel="noreferrer">{entry.title}</a> : entry.title}</strong>
              {entry.summary ? <p>{entry.summary}</p> : null}
            </div>
            <div className="today-briefing-actions">
              <button type="button" onClick={() => openBriefingTask(entry, false)}><ListTodo size={12} /> Save as task</button>
              <button type="button" onClick={() => openBriefingTask(entry, true)}><Bell size={12} /> Remind me</button>
            </div>
          </article>)}
          {!todayBriefing.entries.length ? <p className="empty-line">No briefing items.</p> : null}
        </div> : null}
      </article> : null}

      <div className="today-grid">
        <article className="pane today-card today-card--schedule">
          <PaneHeader eyebrow="Calendar" title={currentEvent ? "Now and next" : "Next today"} action={<button className="pane-link" type="button" onClick={() => openWorkspaceView("agenda")}>Full calendar <ChevronRight size={12} /></button>} />
          <div className="today-event-list">
            {todayFocusEvents.map((event) => <button className={`today-event-row${isCurrentCalendarEvent(event) ? " today-event-row--now" : ""}`} type="button" key={event.id} onClick={() => openTodayEvent(event)}>
              <time dateTime={event.startsAt ?? eventTimeValue(event)}><span>{isCurrentCalendarEvent(event) ? "Now" : event.id === nextEvents[0]?.id ? "Next" : "Then"}</span><strong>{eventDateKey(event, todayDate) === todayDate ? eventTimeValue(event) : "Continues"}</strong></time>
              <i className={`calendar-event-mark calendar-event-mark--${areaClass(event.area)}`} />
              <span><strong>{event.title}</strong><small>{event.subtitle || `${formatDuration(event.duration)} · ${event.area}`}</small></span>
              <ChevronRight size={14} />
            </button>)}
            {!todayFocusEvents.length ? <div className="today-empty"><CalendarDays size={17} /><span><strong>Nothing else on today</strong><small>Add a block only if it helps.</small></span></div> : null}
          </div>
        </article>

        <article className="pane today-card today-card--tasks">
          <PaneHeader eyebrow="Attention" title={attentionTasks.length ? `${attentionTasks.length} task${attentionTasks.length === 1 ? "" : "s"}` : "All clear"} action={<button className="pane-link" type="button" onClick={() => openWorkspaceView("tasks")}>All tasks <ChevronRight size={12} /></button>} />
          <div className="task-browser-list today-task-list">
            {attentionTasks.map((task) => renderTaskRow(task, true))}
            {!attentionTasks.length ? <div className="today-empty"><CheckCircle2 size={17} /><span><strong>No open local tasks</strong><small>Add one when something comes up.</small></span></div> : null}
          </div>
        </article>

        <article className="pane today-card today-card--due">
          <PaneHeader eyebrow="Due soon" title="Coming up" />
          <div className="today-stat-list">
            <button type="button" onClick={() => { selectTaskFilter("due-today"); openWorkspaceView("tasks"); }}><span>Today</span><strong>{dueTodayCount}</strong></button>
            <button type="button" onClick={() => { selectTaskFilter("open"); openWorkspaceView("tasks"); }}><span>Tomorrow</span><strong>{dueTomorrowCount}</strong></button>
            <button type="button" onClick={() => { selectTaskFilter("waiting"); openWorkspaceView("tasks"); }}><span>Waiting</span><strong>{waitingTaskCount}</strong></button>
          </div>
        </article>

        <article className="pane today-card today-card--inbox">
          <PaneHeader eyebrow="Inbox" title={reviewCount ? `${reviewCount} decision${reviewCount === 1 ? "" : "s"}` : "Nothing waiting"} action={<button className="pane-link" type="button" onClick={() => { setWorkDetailOpen(false); openWorkspaceView("review"); }}>Open Inbox <ChevronRight size={12} /></button>} />
          <div className="today-inbox-list">
            {initial ? todayWorkThreads.map((thread) => <button type="button" key={thread.key} onClick={() => openTodayWorkThread(thread)}><i className={`inbox-thread-dot inbox-thread-dot--${thread.group}`} /><span><strong>{thread.title}</strong><small>{thread.source}</small></span><ChevronRight size={14} /></button>) : openReviewItems.map((item) => <button type="button" key={item.id} onClick={() => openTodayInbox(item)}><i className={`area-dot area-dot--${areaClass(item.accent)}`} /><span><strong>{item.title}</strong><small>{item.source}</small></span><ChevronRight size={14} /></button>)}
            {!(initial ? todayWorkThreads.length : openReviewItems.length) ? <div className="today-empty"><Inbox size={17} /><span><strong>Inbox is clear</strong><small>New proposals will appear here.</small></span></div> : null}
          </div>
        </article>
      </div>

      <div className="today-tools" aria-label="Workspace tools">
        <button type="button" onClick={() => setShowIntegrations(true)}><Link2 size={14} /><span>Sources</span></button>
        <button type="button" onClick={() => setShowReminderTray(true)}><Bell size={14} /><span>Reminders</span>{reminderCount ? <b>{reminderCount}</b> : null}</button>
      </div>
    </section>;
  }

  function renderCalendarView() {
    return <section className="workspace-page workspace-page--calendar" aria-labelledby="calendar-heading">
      <header className="workspace-heading">
        <div><p className="eyebrow">Calendar / Dublin time</p><h1 id="calendar-heading">Calendar</h1><p>See your time, then add a local block when it is useful.</p></div>
        <button className="page-primary-action" type="button" onClick={() => openEventComposer()}><Plus size={13} /> Add block</button>
      </header>
      <article className="pane calendar-workspace">
        <PaneHeader eyebrow={calendarMode === "day" ? "Selected day" : "Seven day view"} title={calendarMode === "day" ? formatDublinDateKey(selectedDate) : "Upcoming seven days"} />
        <div className="calendar-view-bar">
          <div className="calendar-view-switch" role="group" aria-label="Calendar view">
            <button className={calendarMode === "day" ? "calendar-view-option calendar-view-option--active" : "calendar-view-option"} type="button" aria-pressed={calendarMode === "day"} onClick={() => setCalendarMode("day")}><CalendarDays size={13} /> Day</button>
            <button className={calendarMode === "upcoming" ? "calendar-view-option calendar-view-option--active" : "calendar-view-option"} type="button" aria-pressed={calendarMode === "upcoming"} onClick={() => setCalendarMode("upcoming")}><CalendarRange size={13} /> Upcoming</button>
          </div>
          <button className="calendar-today-action" type="button" onClick={returnCalendarToToday} disabled={selectedDate === todayDate && calendarMode === "day"}>Today</button>
          <span className="calendar-range-copy">{calendarMode === "day" ? `${visibleCalendarEvents.length} event${visibleCalendarEvents.length === 1 ? "" : "s"}` : `${formatDublinDateKey(calendarRangeStart, { day: "numeric", month: "short" })} to ${formatDublinDateKey(calendarRangeEnd, { day: "numeric", month: "short" })}`}</span>
        </div>
        <div className="calendar-date-shell">
          <button className="calendar-step" type="button" onClick={() => moveCalendarDate(-1)} aria-label="Previous day"><ChevronLeft size={16} /></button>
          <div className="calendar-date-strip" role="tablist" aria-label="Choose a day">
            {calendarDays.map((date, index) => {
              const eventCount = sortedEvents.filter((event) => eventOccursOnDate(event, date, todayDate)).length;
              const fullLabel = formatDublinDateKey(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
              return <button className={`calendar-date-tab${date === selectedDate ? " calendar-date-tab--selected" : ""}${date === todayDate ? " calendar-date-tab--today" : ""}`} id={`calendar-date-${date}`} key={date} type="button" role="tab" aria-controls="calendar-day-panel" aria-current={date === todayDate ? "date" : undefined} aria-label={`${fullLabel}${date === todayDate ? ", today" : ""}, ${eventCount} ${eventCount === 1 ? "event" : "events"}`} aria-selected={date === selectedDate} tabIndex={date === selectedDate ? 0 : -1} ref={(element) => { calendarTabRefs.current[index] = element; }} onClick={() => selectCalendarDate(date)} onKeyDown={(event) => handleCalendarTabKeyDown(event, index)}>
                <span>{formatDublinDateKey(date, { weekday: "short" })}</span><strong>{formatDublinDateKey(date, { day: "numeric" })}</strong><small>{date === todayDate ? "Today" : eventCount ? `${eventCount} event${eventCount === 1 ? "" : "s"}` : "Clear"}</small>
              </button>;
            })}
          </div>
          <button className="calendar-step" type="button" onClick={() => moveCalendarDate(1)} aria-label="Next day"><ChevronRight size={16} /></button>
        </div>
        {initial ? <IntegrationCalendarContext overviewState={dailyIntegrations} onOpen={() => setShowIntegrations(true)} startDate={calendarRangeStart} endDate={calendarRangeEnd} /> : null}
        {activeBlock ? <div className={`active-block lifeboard-active-block selected-run--${areaClass(activeBlock.area)}`}><div className="active-block-copy"><span className="live-label"><span /> Happening now</span><strong>{activeBlock.title}</strong><small>{eventTimeValue(activeBlock)} · {formatDuration(activeBlock.duration)} · {activeBlock.source ?? activeBlock.area}</small></div><button className="open-note" type="button" onClick={() => setSelectedEventId(activeBlock.id)}>Open <ChevronRight size={12} /></button></div> : null}
        <div className="schedule-list agenda-list" id="calendar-day-panel" role="tabpanel" aria-labelledby={`calendar-date-${selectedDate}`}>
          {calendarMode === "day" ? renderDaySchedule(visibleCalendarEvents, selectedDate) : calendarDateWindow(selectedDate, 0, 6).map((date) => {
            const dayEvents = visibleCalendarEvents.filter((event) => eventOccursOnDate(event, date, todayDate));
            if (!dayEvents.length) return null;
            return <section className="agenda-day-group" key={date}><button className="agenda-day-heading" type="button" onClick={() => selectCalendarDate(date)}><span>{date === todayDate ? "Today" : formatDublinDateKey(date, { weekday: "long" })}</span><strong>{formatDublinDateKey(date, { day: "numeric", month: "long" })}</strong><ChevronRight size={13} /></button>{renderDaySchedule(dayEvents, date, true)}</section>;
          })}
          {!visibleCalendarEvents.length ? <div className="calendar-empty"><CalendarDays size={17} /><span>{calendarMode === "day" ? "No events on this day." : "No events in these seven days."}</span></div> : null}
        </div>
        {selectedEvent ? <div className="agenda-detail"><div className="agenda-detail-main"><i className={`area-dot area-dot--${areaClass(selectedEvent.area)}`} /><span><em className={`agenda-origin${selectedEvent.editable ? " agenda-origin--local" : " agenda-origin--imported"}${selectedEventTask?.completed ? " agenda-origin--done" : ""}`}>{selectedEventTask?.completed ? "Completed task" : selectedEventTask && taskRowById.has(selectedEventTask.id) ? "Task plan" : selectedEvent.editable ? "Local block" : "Imported calendar"}</em><strong>{selectedEvent.title}</strong><small>{formatDublinDateKey(eventDateKey(selectedEvent, todayDate), { weekday: "short", day: "numeric", month: "short" })} · {eventTimeValue(selectedEvent)} · {formatDuration(selectedEvent.duration)} · {selectedEvent.source ?? selectedEvent.area}</small></span></div><div className="agenda-detail-actions">{selectedEventTask && taskRowById.has(selectedEventTask.id) ? <><button className="page-primary-action" type="button" onClick={() => openTaskJobComposer(selectedEventTask, "Help me plan or update this task.")}><MessageSquare size={13} /> Ask Hermes</button><button className="secondary-action" type="button" onClick={() => openTaskComposer(selectedEventTask)}><Pencil size={13} /> Edit task plan</button></> : <>{selectedEventTask ? <button className="secondary-action" type="button" onClick={() => openTaskComposer(selectedEventTask)}><Pencil size={12} /> Edit linked task</button> : null}{selectedEvent.editable ? <button className="secondary-action" type="button" onClick={() => openEventComposer(selectedEvent)}><Pencil size={13} /> Edit block</button> : <button className="page-primary-action" type="button" onClick={() => askHermesAboutEvent(selectedEvent)}><MessageSquare size={13} /> Ask Hermes</button>}</>}</div></div> : null}
      </article>
    </section>;
  }

  function renderTasksView() {
    return <section className="workspace-page workspace-page--tasks" aria-labelledby="tasks-heading">
      <header className="workspace-heading"><div><p className="eyebrow">Your work</p><h1 id="tasks-heading">Tasks</h1><p>Check off a task to complete it, or open it to edit the details.</p></div><button className="page-primary-action" type="button" onClick={() => openTaskComposer()}><Plus size={13} /> Add task</button></header>
      <article className="pane tasks-workspace">
        {initial && hermes.failed ? <p className="task-sync-note task-sync-note--warning"><Bot size={13} /> Hermes could not refresh. Fox Focus tasks are unaffected.</p> : initial && hermes.loading && !hermesBoard ? <p className="task-sync-note"><Bot size={13} /> Checking Hermes tasks…</p> : null}
        {initial && taskRowsError ? <p className="task-sync-note task-sync-note--warning"><RefreshCw size={13} /> Task rows could not refresh. Showing the last loaded state.</p> : null}
        <nav className="task-category-strip" aria-label="Task categories">{taskCategoryOptions.map((category) => <button className={`task-category-tab${taskCategory === category.id ? " task-category-tab--active" : ""}`} type="button" aria-pressed={taskCategory === category.id} key={category.id} onClick={() => selectTaskCategory(category.id)}>{category.id !== allTaskCategories && category.id !== unclassifiedTaskCategory ? <i className={`area-dot area-dot--${areaClass(category.id)}`} /> : null}{category.label}</button>)}</nav>
        {hermesBoard && (taskCategory === allTaskCategories || taskCategory === unclassifiedTaskCategory) && taskFilter !== "all" && taskFilter !== "open" && taskFilter !== "done" && activeHermesTaskCount ? <p className="task-filter-boundary"><Bot size={13} /> Hermes tasks appear in All, Open, or Done because they do not have Fox Focus deadlines yet.</p> : null}
        <div className="task-compact-toolbar">
          <details className="task-filter-menu"><summary><SlidersHorizontal size={14} /><span>Filter &amp; sort</span>{activeTaskFilterCount ? <b aria-label={`${activeTaskFilterCount} active filters`}>{activeTaskFilterCount}</b> : null}<ChevronDown className="filter-chevron" size={13} /></summary><div className="task-filter-popover"><label><span>Show</span><select value={taskFilter} onChange={(event) => { const value = event.target.value; if (isOneOf(value, taskFilters)) selectTaskFilter(value); }}>{taskFilters.map((filter) => <option value={filter} key={filter}>{taskFilterLabel(filter)} · {taskFilterCounts[filter]}</option>)}</select></label>{taskSourceOptions.length > 2 ? <label><span>Source</span><select value={taskSource} onChange={(event) => { const value = event.target.value; if (isOneOf(value, taskSources)) setTaskSource(value); }}>{taskSourceOptions.map((source) => <option value={source.id} key={source.id} disabled={source.id === hermesTaskSource && source.count === 0}>{source.label} · {source.count}</option>)}</select></label> : null}<label><span>Order tasks</span><select value={taskSort} disabled={isHermesOnlyScope} onChange={(event) => { const value = event.target.value; if (isOneOf(value, taskSorts)) setTaskSort(value); }}>{taskSorts.map((sort) => <option value={sort} key={sort}>{taskSortLabel(sort)}</option>)}</select></label>{isHermesOnlyScope ? <p>Hermes keeps source priority order.</p> : null}<button className="task-filter-reset" type="button" disabled={!activeTaskFilterCount} onClick={resetTaskFilters}><RotateCcw size={12} /> Reset</button></div></details>
          <span className="task-view-count" role="status" aria-live="polite">{taskFilterLabel(taskFilter)} · {shownTaskCount} task{shownTaskCount === 1 ? "" : "s"}</span>
          {initial && hermesBoard ? <button className="mini-action task-refresh" type="button" disabled={hermes.loading} onClick={hermes.refresh}>{hermes.loading ? "Refreshing…" : "Refresh Hermes"}</button> : null}
        </div>
        <p className="planned-note"><CalendarDays size={13} /> {plannedTaskCount ? `${plannedTaskCount} task${plannedTaskCount === 1 ? "" : "s"} planned locally.` : "Open a task to plan it."}</p>
        <div className="task-browser-list task-browser-list--lifeboard" id="task-browser-panel" role="region" aria-label={`${taskFilterLabel(taskFilter)} tasks`}>
          {shownLocalTasks.map((task) => renderTaskRow(task))}
          {shownHermesTasks.map((task) => <HermesTaskRow key={task.id} task={task} busy={adoptingHermesId === task.id} onAdopt={(candidate) => void previewHermesAdoption(candidate)} />)}
          {shownImportedTasks.map((task) => <ImportedTaskRow key={`${task.provider}:${task.containerId}:${task.externalId}`} task={task} area={areaForList(data.listAreas, task.provider, task.containerId, task.containerName)} />)}
          {!shownTaskCount ? <div className="empty-state"><ListTodo size={20} /><strong>{taskFilter === "done" ? "No completed tasks yet" : "Nothing in this view"}</strong><p>{taskFilter === "done" ? "Completed tasks stay here for review." : "Change the category or filters, or add a task."}</p></div> : null}
        </div>
      </article>
    </section>;
  }

  function renderLegacyReviewView() {
    return <section className="workspace-page workspace-page--review" aria-labelledby="review-heading">
      <header className="workspace-heading"><div><p className="eyebrow">One decision at a time</p><h1 id="review-heading">Inbox</h1><p>Turn a proposal into a task, a calendar block, a draft, or nothing.</p></div><span className="review-page-count">{reviewCount} open</span></header>
      <article className="pane review-workspace">
        <div className="review-workbench">
          <div className="inbox-list inbox-list--lifeboard">
            {reviewItems.map((item) => <div className={`inbox-list-row${item.status === "handled" ? " inbox-list-row--handled" : ""}`} key={item.id}><button className={`inbox-list-item${selectedInbox?.id === item.id ? " inbox-list-item--selected" : ""}`} type="button" aria-pressed={selectedInbox?.id === item.id} onClick={() => selectInbox(item)}><span className={`calendar-event-mark calendar-event-mark--${areaClass(item.accent)}`} /><span><strong>{item.title}</strong><small>{item.source}</small></span><span className={`review-status review-status--${item.status}`}>{formatStatus(item.status)}</span></button><button className={`inbox-complete${item.status === "handled" ? " inbox-complete--done" : ""}`} type="button" onClick={() => toggleInboxHandled(item)} aria-label={`${item.status === "handled" ? "Return" : "Mark"} ${item.title} ${item.status === "handled" ? "to review" : "as handled"}`}>{item.status === "handled" ? <Check size={13} /> : <Circle size={15} />}</button></div>)}
            {!reviewItems.length ? <div className="empty-state"><Inbox size={22} /><strong>Inbox is clear</strong><p>New captures and proposals will appear here.</p></div> : null}
          </div>
          {selectedInbox ? <div className="review-detail"><div className="review-queue-nav"><span>{selectedInboxIndex + 1} of {reviewItems.length}</span><div><button type="button" onClick={() => moveInboxSelection(-1)} disabled={selectedInboxIndex <= 0} aria-label="Previous review item"><ChevronLeft size={14} /></button><button type="button" onClick={() => moveInboxSelection(1)} disabled={selectedInboxIndex >= reviewItems.length - 1} aria-label="Next review item"><ChevronRight size={14} /></button></div></div><div className="review-item-meta"><i className={`area-dot area-dot--${areaClass(selectedInbox.accent)}`} /><span>{selectedInbox.actor}</span><span className={`review-status review-status--${selectedInbox.status}`}>{formatStatus(selectedInbox.status)}</span></div><h2>{selectedInbox.title}</h2><p>{selectedInbox.summary}</p><div className="evidence-card evidence-card--compact"><span>Source evidence</span><strong>{selectedInbox.source}</strong><p>No connected email body is available in this review surface.</p></div>{selectedInbox.draft ? <div className="saved-draft"><span>Saved draft · not sent</span><pre>{selectedInbox.draft}</pre></div> : null}{selectedInbox.moreWork ? <div className="saved-request"><span>Feedback note · not delivered</span><p>{selectedInbox.moreWork}</p></div> : null}<div className="review-next-step"><span>Choose the next step</span><p>Local outcomes happen now. Nothing is sent back to its source.</p></div>{selectedInbox.status === "handled" ? <div className="review-detail-actions"><button className="secondary-action" type="button" onClick={() => toggleInboxHandled(selectedInbox)}><RotateCcw size={13} /> Return to review</button></div> : <div className="review-detail-actions"><button className="page-primary-action" type="button" onClick={() => acceptInbox("task")}><ListTodo size={13} /> Create task</button><button className="secondary-action" type="button" onClick={() => openDraft(selectedInbox)}><Pencil size={13} /> Draft reply</button><button className="secondary-action" type="button" onClick={() => acceptInbox("event")}><CalendarDays size={13} /> Schedule block</button><button className="secondary-action" type="button" onClick={() => toggleInboxHandled(selectedInbox)}><CheckCircle2 size={13} /> No action</button></div>}<div className="agent-request agent-request--compact"><label htmlFor="more-work">Feedback note</label><textarea id="more-work" value={agentRequest} onChange={(event) => setAgentRequest(event.target.value)} placeholder="What should Hermes check or change later?" /><button className="quiet-panel-action" type="button" onClick={saveMoreWork}>Save note</button></div></div> : null}
        </div>
      </article>
    </section>;
  }

  function renderWorkInboxView() {
    function renderThread(thread: WorkThread) {
      const sendState = thread.item
        ? emailSendUiState(
            thread.item,
            draftByInboxId.get(thread.item.id),
            latestSendActionByInbox.get(thread.item.id),
            workRows?.capabilities.emailSendEnabled ?? false,
          )
        : "disabled";
      const state = thread.job ? jobStateLabel(thread.job) : thread.item ? inboxStateLabel(thread.item, sendState) : "";
      return <button
        className={`work-thread${selectedWorkThread?.key === thread.key ? " work-thread--selected" : ""}`}
        data-thread-key={thread.key}
        ref={(element) => {
          if (element) workThreadRefs.current.set(thread.key, element);
          else workThreadRefs.current.delete(thread.key);
        }}
        type="button"
        aria-pressed={selectedWorkThread?.key === thread.key}
        key={thread.key}
        onClick={() => selectWorkThread(thread)}
      >
        <i className={`inbox-thread-dot inbox-thread-dot--${thread.group}`} />
        <span className="work-thread-copy"><strong>{thread.title}</strong><small>{thread.source}</small></span>
        <span className="work-thread-tail"><small>{relativeTime(thread.updatedAt)}</small><em>{state}</em></span>
      </button>;
    }

    function renderAlwaysOpenGroup(label: string, threads: WorkThread[]) {
      return <section className="work-thread-group" aria-label={label}>
        <header><strong>{label}</strong><span>{threads.length}</span></header>
        {threads.map(renderThread)}
      </section>;
    }

    function renderCollapsibleGroup(label: string, threads: WorkThread[], open: boolean, setOpen: (open: boolean) => void) {
      if (!threads.length) return null;
      return <section className="work-thread-group work-thread-group--collapsed" aria-label={label}>
        <button className="work-thread-group-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDown size={12} /><strong>{label}</strong><span>{threads.length}</span>
        </button>
        {open ? threads.map(renderThread) : null}
      </section>;
    }

    const actionItem = selectedWorkThread?.kind === "inbox" ? selectedWorkItem : null;
    const problemSend = selectedWorkItem ? problemSendInboxIds.has(selectedWorkItem.id) : false;
    const sendState = selectedWorkItem
      ? emailSendUiState(
          selectedWorkItem,
          selectedWorkDraft,
          latestSendActionByInbox.get(selectedWorkItem.id),
          workRows?.capabilities.emailSendEnabled ?? false,
        )
      : "disabled";
    const detailState = selectedWorkJob
      ? jobStateLabel(selectedWorkJob)
      : selectedWorkItem
        ? inboxStateLabel(selectedWorkItem, sendState)
        : "";
    const itemCanAct = actionItem ? canMutateInboxItem(actionItem) : false;
    const jobBusy = workBusyKey !== null;
    const itemCanAskHermes = Boolean(actionItem && !selectedWorkJob && itemCanAct);
    const itemShowsSendAction = Boolean(actionItem?.source.kind === "email" && selectedWorkDraft && sendState !== "disabled");
    const sendButtonLabel = sendState === "sending"
      ? "Sending"
      : sendState === "reconciling"
        ? "Reconciling"
        : sendState === "unknown"
          ? "Needs reconciliation"
          : sendState === "failed"
            ? "Send failed"
            : "Send";
    const linkedJobTaskUnavailable = selectedWorkJob ? !canAcceptJob(selectedWorkJob) : false;

    return <section className="workspace-page workspace-page--review" aria-labelledby="review-heading">
      <header className="workspace-heading"><div><p className="eyebrow">Forward and back</p><h1 id="review-heading">Inbox</h1></div><span className="review-page-count">{reviewCount ? `${reviewCount} ${reviewCount === 1 ? "needs" : "need"} you` : "Clear"}</span></header>
      <article className="pane review-workspace work-inbox">
        {workRowsError ? <p className="task-sync-note task-sync-note--warning"><RefreshCw size={13} /> Inbox rows could not refresh.</p> : null}
        <div className={`review-workbench${workDetailOpen ? " review-workbench--detail" : ""}`}>
          <aside className="work-thread-list" aria-label="Inbox threads" ref={workThreadListRef} tabIndex={-1}>
            {renderAlwaysOpenGroup("Needs you", needsYouThreads)}
            {renderAlwaysOpenGroup("Working", workingThreads)}
            {renderCollapsibleGroup("Likely noise", noiseThreads, noiseOpen, setNoiseOpen)}
            {renderCollapsibleGroup("Settled", settledThreads, settledOpen, setSettledOpen)}
            {!workThreads.length && workRows ? <p className="empty-line">Inbox is clear.</p> : null}
            {!workRows ? <p className="empty-line">Loading Inbox…</p> : null}
          </aside>
          {selectedWorkThread ? <section className="work-thread-detail" aria-label={selectedWorkThread.title}>
            <div className="review-queue-nav">
              <button className="work-inbox-back" type="button" onClick={() => setWorkDetailOpen(false)}><ChevronLeft size={16} /> Inbox</button>
              <span>{selectedWorkIndex >= 0 ? `${selectedWorkIndex + 1} of ${visibleWorkThreads.length}` : detailState}</span>
              <div><button type="button" onClick={() => moveWorkSelection(-1)} disabled={selectedWorkIndex <= 0} aria-label="Previous thread"><ChevronLeft size={14} /><b>Previous</b></button><button type="button" onClick={() => moveWorkSelection(1)} disabled={selectedWorkIndex < 0 || selectedWorkIndex >= visibleWorkThreads.length - 1} aria-label="Next thread"><b>Next</b><ChevronRight size={14} /></button></div>
            </div>
            <header className="work-thread-heading">
              <div><span>{selectedWorkThread.source}</span><time dateTime={selectedWorkThread.updatedAt}>{relativeTime(selectedWorkThread.updatedAt)}</time></div>
              <h2 ref={workDetailHeadingRef} tabIndex={-1}>{selectedWorkThread.title}</h2>
              <em className={`work-state work-state--${selectedWorkThread.group}`}>{detailState}</em>
            </header>
            <p className="work-thread-summary">{selectedWorkJob?.instruction ?? selectedWorkItem?.summary}</p>
            {selectedWorkJob?.question ? <blockquote className="job-question"><span>Hermes asks</span>{selectedWorkJob.question}</blockquote> : null}
            {selectedWorkJob?.taskId ? <p className="work-link-note"><ListTodo size={12} /> Linked task</p> : null}
            {problemSend ? <p className="work-warning"><RefreshCw size={12} /> {sendState === "unknown" ? "Send outcome needs reconciliation." : "Send failed and needs review."}</p> : null}
            {selectedWorkDraft ? <section className="reply-preview">
              <header><span>Reply draft</span><em>{selectedWorkDraft.author} · r{selectedWorkDraft.revision}</em></header>
              <dl>
                <div><dt>Account</dt><dd>{selectedWorkDraft.reply.accountId}</dd></div>
                <div><dt>From</dt><dd>{selectedWorkDraft.reply.from}</dd></div>
                <div><dt>To</dt><dd>{selectedWorkDraft.reply.to.join(", ") || "None"}</dd></div>
                {selectedWorkDraft.reply.cc.length ? <div><dt>Cc</dt><dd>{selectedWorkDraft.reply.cc.join(", ")}</dd></div> : null}
                {selectedWorkDraft.reply.bcc.length ? <div><dt>Bcc</dt><dd>{selectedWorkDraft.reply.bcc.join(", ")}</dd></div> : null}
                <div><dt>Subject</dt><dd>{selectedWorkDraft.reply.subject}</dd></div>
                <div><dt>Thread</dt><dd>{selectedWorkDraft.reply.threadId}</dd></div>
                <div><dt>Reply to</dt><dd>{selectedWorkDraft.reply.replyToMessageId}</dd></div>
                <div><dt>In reply to</dt><dd>{selectedWorkDraft.reply.inReplyTo}</dd></div>
                <div><dt>References</dt><dd>{selectedWorkDraft.reply.references.join(" ") || "None"}</dd></div>
              </dl>
              <pre>{selectedWorkDraft.reply.bodyText}</pre>
            </section> : null}
            <section className="job-timeline" aria-label="Updates">
              <header><span>Updates</span><small>{selectedWorkUpdates.length}</small></header>
              {selectedWorkUpdates.map((update: JobUpdate) => <article className={`job-update job-update--${update.author}`} key={`${update.jobId}:${update.seq}`}>
                <i />
                <div><header><strong>{update.author === "hermes" ? "Hermes" : "You"}</strong><span>{update.kind.replace("_", " ")} · {relativeTime(update.at)}</span></header><p>{update.text}</p>{update.url ? <a href={update.url} target="_blank" rel="noreferrer">Open result <ChevronRight size={11} /></a> : null}</div>
              </article>)}
              {!selectedWorkUpdates.length ? <p className="timeline-empty">No updates yet.</p> : null}
            </section>
            {selectedWorkJob?.state === "needs_you" ? <div className="job-response"><label htmlFor="job-reply">One-line answer</label><div><input id="job-reply" maxLength={280} value={jobReply} onChange={(event) => setJobReply(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); answerSelectedJob(selectedWorkJob); } }} /><button className="page-primary-action" type="button" disabled={jobBusy} onClick={() => answerSelectedJob(selectedWorkJob)}>Answer</button></div></div> : null}
            {selectedWorkJob?.state === "review" ? <div className="job-response"><label htmlFor="job-reply">Send-back note</label><div><input id="job-reply" maxLength={280} value={jobReply} onChange={(event) => setJobReply(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); sendBackSelectedJob(selectedWorkJob); } }} /><button className="secondary-action" type="button" disabled={jobBusy} onClick={() => sendBackSelectedJob(selectedWorkJob)}><CornerUpLeft size={12} /> Send back <kbd>b</kbd></button></div></div> : null}
            <footer className="work-thread-actions">
              {actionItem && !selectedWorkJob && actionItem.state !== "resolved" ? <>
                {itemShowsSendAction ? <button className="page-primary-action" type="button" disabled={sendState !== "ready" || jobBusy} onClick={() => sendWorkItem(actionItem)}><Send size={12} /> {sendButtonLabel}</button> : null}
                <button className={itemShowsSendAction ? "secondary-action" : "page-primary-action"} type="button" disabled={!itemCanAskHermes} onClick={() => openJobComposer({ title: actionItem.title, inboxId: actionItem.id })}><MessageSquare size={13} /> Ask Hermes <kbd>h</kbd></button>
                <button className="secondary-action" type="button" disabled={!itemCanAct} onClick={() => dismissWorkItem(actionItem)}><X size={13} /> Dismiss <kbd>x</kbd></button>
              </> : null}
              {selectedWorkJob?.state === "review" ? <>
                {selectedWorkItem?.source.kind === "email" && selectedWorkDraft && sendState !== "disabled" ? <button className="page-primary-action" type="button" disabled={sendState !== "ready" || jobBusy} onClick={() => sendWorkItem(selectedWorkItem)}><Send size={12} /> {sendButtonLabel}</button> : null}
                {selectedWorkItem && !selectedWorkItem.taskId ? <button className="secondary-action" type="button" disabled={jobBusy} onClick={() => openTaskComposer(undefined, undefined, selectedWorkItem)}><ListTodo size={12} /> Review task</button> : null}
                <button className={selectedWorkJob.taskId ? "page-primary-action" : "secondary-action"} type="button" disabled={jobBusy || linkedJobTaskUnavailable} title={linkedJobTaskUnavailable ? "The linked Google task is not ready" : undefined} onClick={() => settleSelectedJob(selectedWorkJob, "accepted")}><Check size={12} /> {selectedWorkJob.taskId ? "Accept & complete" : "Accept result"} <kbd>a</kbd></button>
                <button className="danger-button" type="button" disabled={jobBusy} onClick={() => settleSelectedJob(selectedWorkJob, "dropped")}><Trash2 size={12} /> Drop</button>
              </> : null}
            </footer>
          </section> : <section className="work-thread-detail work-thread-detail--empty"><Inbox size={19} /><span>{workThreads.length ? "Choose a thread." : "Inbox is clear."}</span></section>}
        </div>
      </article>
    </section>;
  }

  function renderWorkspaceView() {
    if (activeSection === "agenda") return renderCalendarView();
    if (activeSection === "tasks") return renderTasksView();
    if (activeSection === "review") return initial ? renderWorkInboxView() : renderLegacyReviewView();
    return renderTodayView();
  }

  const taskModal = modal?.kind === "task" ? modal : null;
  const eventModal = modal?.kind === "event" ? modal : null;
  const draftModal = modal?.kind === "draft" ? modal : null;
  const editingHermesTask = hermesTasks.find(task => task.id === editingHermesTaskId) ?? null;
  const modalTask = taskModal?.taskId ? taskById.get(taskModal.taskId) ?? null : null;
  const modalTaskRow = modalTask ? taskRowById.get(modalTask.id) : undefined;
  const modalGoogleOwned = modalTaskRow?.binding.kind === "google";
  const modalPendingGoogle = modalTaskRow?.binding.kind === "pending";
  const modalCreateAction = modalTask ? createActionByTask.get(modalTask.id) : undefined;
  const modalRowOwned = Boolean(initial && modalTaskRow);
  const modalCreatingGoogle = Boolean(initial && taskModal && !taskModal.taskId);
  const selectedTaskDestination = taskDestinations.find((destination) => destinationKey(destination) === taskDestinationKey) ?? null;
  const modalTaskAction = modalTask ? latestActionByTask.get(modalTask.id) : undefined;
  const taskConflictAction = taskConflictActionId
    ? taskRows?.actions.find((action) => action.id === taskConflictActionId) ?? null
    : null;
  const taskConflictCurrent = taskConflictAction ? taskConflictFromAction(taskConflictAction) : null;
  const taskConflictTask = taskConflictAction ? taskById.get(taskConflictAction.payload.taskId) ?? null : null;
  const taskConflictRow = taskConflictAction ? taskRowById.get(taskConflictAction.payload.taskId) ?? null : null;
  const taskConflictDesired = taskConflictTask?.completed ? "open" : "completed";
  const taskCreateConflictAction = taskCreateConflictActionId
    ? workRows?.actions.find((action): action is TaskCreateActionRow =>
        action.id === taskCreateConflictActionId && isTaskCreateActionRow(action)) ?? null
    : null;
  const taskCreateCandidates = taskCreateConflictCandidates(taskCreateConflictAction ?? undefined);
  const taskCreateConflictTask = taskCreateConflictAction
    ? taskById.get(taskCreateConflictAction.payload.taskId) ?? null
    : null;
  const modalInbox = taskModal?.inboxId
    ? data.inboxItems.find((item) => item.id === taskModal.inboxId)
    : eventModal?.inboxId
      ? data.inboxItems.find((item) => item.id === eventModal.inboxId)
      : null;
  const modalInboxRow = taskModal?.inboxId ? inboxRowById.get(taskModal.inboxId) ?? null : null;
  const jobPromptPresets = jobComposer?.inboxId
    ? [
        ["Edit draft", "Revise the current reply draft. Keep the verified thread and recipients, and leave it ready for my approval."],
        ["Make task", "Turn this into a concrete task proposal with a clear title, next action, deadline, and realistic duration."],
        ["Plan time", "Find a realistic time for this around my current calendar and explain any conflict."],
        ["Prepare to send", "Prepare or improve the reply for my review. Do not send it; leave the exact draft for my approval."],
      ]
    : jobComposer?.taskId
      ? [
          ["Plan it", "Plan a realistic time for this task around my calendar and note any conflict."],
          ["Break it down", "Break this task into the smallest useful next steps."],
          ["Check context", "Check the available context and tell me what is missing or likely to block this task."],
          ["Reschedule", "Suggest a better day and time for this task based on my current schedule."],
        ]
      : [
          ["Check details", "Check the details and tell me the useful next step."],
          ["Plan around it", "Help me plan around this using my current tasks and calendar."],
        ];
  return (
    <div className="control-room">
      <header className="command-bar" aria-hidden={isOverlayOpen} inert={isOverlayOpen}>
        <div className="brand-lockup">
          <span className="fox-mark" aria-hidden="true"><span /><span /></span>
          <div><strong>Fox Focus</strong></div>
        </div>
        <nav className="workspace-nav" aria-label="Workspace views">
          <button className={activeSection === "today" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-current={activeSection === "today" ? "page" : undefined} onClick={() => openWorkspaceView("today")}><Clock3 size={14} /><span>Today</span></button>
          <button className={activeSection === "agenda" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-current={activeSection === "agenda" ? "page" : undefined} onClick={() => openWorkspaceView("agenda")}><CalendarDays size={14} /><span>Calendar</span></button>
          <button className={activeSection === "tasks" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-current={activeSection === "tasks" ? "page" : undefined} onClick={() => openWorkspaceView("tasks")}><ListTodo size={14} /><span>Tasks</span></button>
          <button className={activeSection === "review" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-current={activeSection === "review" ? "page" : undefined} onClick={() => { setWorkDetailOpen(false); openWorkspaceView("review"); }}><Inbox size={14} /><span>Inbox</span>{reviewCount ? <b>{reviewCount}</b> : null}</button>
        </nav>
        <div className="command-actions">
          <button className="quiet-action notification-action" type="button" onClick={() => setShowReminderTray(true)} aria-label={`Open ${reminderCount} reminders`}><Bell size={15} />{reminderCount ? <b>{reminderCount}</b> : null}<span>Reminders</span></button>
          <button className="quiet-action theme-action" type="button" onClick={toggleTheme} aria-label={`Switch to ${themeTarget} theme`} title={`Switch to ${themeTarget} theme`}>{resolvedTheme === "black" ? <Sun size={15} /> : <Moon size={15} />}</button>
          <button className="capture-button" type="button" onClick={() => openTaskComposer()}><Plus size={15} /><span>Add task</span></button>
        </div>
      </header>

      {saveError || statusMessage || completionUndo || reviewUndo ? <div className={`status-footer${saveError ? " status-footer--error" : ""}`} role={saveError ? "alert" : "status"} aria-live={saveError ? "assertive" : "polite"} aria-hidden={isOverlayOpen} inert={isOverlayOpen}>
        <span />
        <p>{saveError ?? statusMessage}</p>
        {completionUndo ? <button className="status-undo" type="button" onClick={undoTaskCompletion}>Undo</button> : reviewUndo ? <button className="status-undo" type="button" onClick={undoInboxChange}>Undo</button> : null}
        {!saveError ? <button className="status-dismiss" type="button" aria-label="Dismiss notification" onClick={() => { setStatusMessage(""); setCompletionUndo(null); setReviewUndo(null); }}><X size={16} /></button> : null}
      </div> : null}
      <main aria-hidden={isOverlayOpen} inert={isOverlayOpen}>{renderWorkspaceView()}</main>

      {hermesCompletionApproval ? (
        <DialogFrame title="Confirm Hermes completion" onClose={() => setHermesCompletionApproval(null)} className="editor-dialog--confirmation">
          <div className="editor-heading">
            <div className="composer-icon"><CheckCircle2 size={17} /></div>
            <div><p className="eyebrow">External change</p><h2>Complete this task?</h2></div>
            <button className="close-composer" type="button" onClick={() => setHermesCompletionApproval(null)} aria-label="Cancel completion"><X size={17} /></button>
          </div>
          <p className="completion-task-title">{hermesCompletionApproval.title}</p>
          <div className="completion-preview" aria-label="Exact completion changes">
            <span>Hermes</span><strong>{hermesCompletionApproval.status} → Completed</strong>
            {hermesCompletionApproval.sourceProvider === "google" ? <><span>Google Tasks</span><strong>No change</strong></> : null}
          </div>
          <div className="editor-footer"><span>{hermesCompletionApproval.sourceProvider === "google" ? "Managed in Hermes · From Google Tasks" : "Fox Focus will verify Hermes before checking the row."}</span><div><button className="secondary-action" type="button" onClick={() => setHermesCompletionApproval(null)}>Cancel</button><button className="submit-button" type="button" disabled={hermesCompletionPending !== null} onClick={() => { void completeHermesTask(hermesCompletionApproval); }}><Check size={14} /> Complete in Hermes</button></div></div>
        </DialogFrame>
      ) : null}

      {editingHermesTask ? (
        <DialogFrame title="Organise Hermes task" onClose={() => setEditingHermesTaskId(null)}>
          <form onSubmit={(event) => { void saveHermesTask(event); }}>
            <div className="editor-heading">
              <div className="composer-icon"><Bot size={17} /></div>
              <div><p className="eyebrow">Hermes task</p><h2>Organise in Fox Focus</h2></div>
              <button className="close-composer" type="button" onClick={() => setEditingHermesTaskId(null)} aria-label="Close task editor"><X size={17} /></button>
            </div>
            {modalError ? <p className="editor-error" role="alert">{modalError}</p> : null}
            <div className="source-notice"><Bot size={14} /> Hermes owns the title and completion state. These planning details stay in Fox Focus.</div>
            <div className="editor-grid">
              <label className="field field--full"><span>Task · managed in Hermes</span><input value={editingHermesTask.title} readOnly /></label>
              <label className="field field--full"><span>Status · managed in Hermes</span><input value={hermesLabels[editingHermesTask.status]} readOnly /></label>
              <label className="field"><span>Area</span><select data-autofocus value={hermesTaskDraft.area} onChange={(event) => { const value = event.target.value; if (isOneOf(value, areas)) setHermesTaskDraft(current => ({ ...current, area: value })); }}>{areas.map(area => <option value={area} key={area}>{area}</option>)}</select></label>
              <label className="field"><span>Deadline</span><select value={hermesTaskDraft.due} onChange={(event) => setHermesTaskDraft(current => ({ ...current, due: event.target.value }))}><option value="Today">Today</option><option value="Tomorrow">Tomorrow</option><option value="Friday">Friday</option><option value="Waiting">Waiting</option><option value="No deadline">No deadline</option></select></label>
              <label className="field"><span>Duration</span><select value={hermesTaskDraft.duration} onChange={(event) => setHermesTaskDraft(current => ({ ...current, duration: event.target.value }))}><option value="5 min">5 min</option><option value="10 min">10 min</option><option value="20 min">20 min</option><option value="30 min">30 min</option><option value="40 min">40 min</option><option value="45 min">45 min</option><option value="60 min">60 min</option></select></label>
              <label className="field"><span>Task state</span><select value={hermesTaskDraft.state} onChange={(event) => { const value = event.target.value; if (value === "up-next" || value === "waiting") setHermesTaskDraft(current => ({ ...current, state: value })); }}><option value="up-next">Up next</option><option value="waiting">Waiting</option></select></label>
              <label className="field"><span>Planned day</span><input type="date" value={hermesTaskDraft.scheduledDate} onChange={(event) => setHermesTaskDraft(current => ({ ...current, scheduledDate: event.target.value }))} /></label>
              <label className="field"><span>Planned time</span><input type="time" value={hermesTaskDraft.scheduledTime} onChange={(event) => setHermesTaskDraft(current => ({ ...current, scheduledTime: event.target.value }))} /></label>
              <label className="field field--full"><span>Reminder</span><select value={hermesTaskDraft.reminderMode} onChange={(event) => { const value = event.target.value; if (isOneOf(value, reminderModes)) setHermesTaskDraft(current => ({ ...current, reminderMode: value })); }}><option value="none">No reminder</option><option value="one-hour">1 hour before</option><option value="morning">09:00 on the day</option></select></label>
            </div>
            <div className="editor-footer"><span>{editingHermesTask.sourceDueOn ? `Google due date: ${formatDublinDateKey(editingHermesTask.sourceDueOn, { day: "numeric", month: "short" })}.` : "Planning and reminders are local to Fox Focus."}</span><div><button className="secondary-action" type="button" onClick={() => openJobComposer({ title: editingHermesTask.title, context: `Hermes task: ${editingHermesTask.title}` })}><MessageSquare size={13} /> Ask Hermes</button><button className="secondary-action" type="button" onClick={() => setEditingHermesTaskId(null)}>Cancel</button><button className="submit-button" type="submit"><Check size={14} /> Save details</button></div></div>
          </form>
        </DialogFrame>
      ) : null}

      {taskModal ? (
        <DialogFrame title={taskModal.taskId ? "Edit task" : "Add task"} onClose={() => setModal(null)}>
          <form onSubmit={(event) => { void saveTask(event); }}>
            <div className="editor-heading">
              <div className="composer-icon"><ListTodo size={17} /></div>
              <div><p className="eyebrow">{modalGoogleOwned || modalPendingGoogle || modalCreatingGoogle ? "Google task" : modalRowOwned ? "Legacy task" : taskModal.taskId ? "Local task" : "Capture task"}</p><h2>{modalRowOwned ? "Plan task" : taskModal.taskId ? "Edit task" : "Add a task"}</h2></div>
              <button className="close-composer" type="button" onClick={() => setModal(null)} aria-label="Close task editor"><X size={17} /></button>
            </div>
            {modalError ? <p className="editor-error" role="alert">{modalError}</p> : null}
            {modalInbox ? <div className="source-notice"><Inbox size={14} /> Accepting from <strong>{modalInbox.source}</strong>. It will stay on the created task.</div> : null}
            {modalInboxRow ? <div className="source-notice"><Inbox size={14} /> From <strong>{inboxSourceLabel(modalInboxRow)}</strong>.</div> : null}
            {modalGoogleOwned ? <div className="source-notice"><Link2 size={14} /> Google owns the title, due date, and completion. Planning stays in Fox Focus.</div> : modalPendingGoogle ? <div className="source-notice"><Clock3 size={14} /> Waiting for Google creation confirmation.</div> : modalRowOwned ? <div className="source-notice"><Bot size={14} /> The current task owner keeps its content and completion until migration. Planning stays in Fox Focus.</div> : modalTask?.origin === "migration" ? <div className="source-notice"><Bot size={14} /> Adopted from {modalTask.source ?? "a legacy source"}. The source link is read-only.</div> : null}
            {modalTaskAction && actionStateLabel(modalTaskAction) ? <div className={`task-action-notice task-action-notice--${modalTaskAction.state}`}><strong>{actionStateLabel(modalTaskAction)}</strong><span>{modalTaskAction.error ?? (modalTaskAction.state === "succeeded" ? "Google readback matched the approved change." : "The approved change is waiting for Google readback.")}</span></div> : null}
            {modalCreateAction && actionStateLabel(modalCreateAction) ? <div className={`task-action-notice task-action-notice--${modalCreateAction.state}`}><strong>{actionStateLabel(modalCreateAction)}</strong><span>{modalCreateAction.error ?? (modalCreateAction.state === "succeeded" ? "Google readback matched the approved task." : "The approved creation is waiting for Google readback.")}</span></div> : null}
            <div className="editor-grid editor-grid--quick-task">
              {modalCreatingGoogle ? <label className="field field--full"><span>Destination</span><select data-autofocus required value={taskDestinationKey} disabled={!taskDestinations.length} onChange={(event) => {
                const destination = taskDestinations.find((candidate) => destinationKey(candidate) === event.target.value);
                const area = destination?.area;
                setTaskDestinationKey(event.target.value);
                if (isOneOf(area, areas)) setTaskDraft((current) => ({ ...current, area }));
              }}>{taskDestinations.map((destination) => <option value={destinationKey(destination)} key={destinationKey(destination)}>{destination.area} · {destination.listName}{destination.isFallback ? " · fallback" : ""}</option>)}</select>{taskDestinationError ? <small>{taskDestinationError}</small> : null}</label> : null}
              <label className="field field--full"><span>{modalGoogleOwned || modalPendingGoogle ? "Task · managed in Google" : modalRowOwned ? "Task · managed at source" : "Task"}</span><input data-autofocus={!modalCreatingGoogle || undefined} required readOnly={modalRowOwned} value={taskDraft.title} onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))} placeholder="What needs doing?" /></label>
              {modalCreatingGoogle ? <><label className="field field--full"><span>Google due</span><input type="date" value={taskGoogleDue} onChange={(event) => setTaskGoogleDue(event.target.value)} /></label><label className="field field--full"><span>Notes</span><textarea className="task-notes-field" value={taskNotes} onChange={(event) => setTaskNotes(event.target.value)} /></label></> : null}
              {modalGoogleOwned ? <label className="field field--full"><span>Google due</span><input type="date" readOnly value={modalTaskRow?.observed?.doOn ?? ""} /></label> : null}
              {modalPendingGoogle ? <label className="field field--full"><span>Google due · pending</span><input type="date" readOnly value={modalCreateAction?.payload.doOn ?? ""} /></label> : null}
              <label className="field field--full"><span>{modalGoogleOwned ? "Local deadline" : "Deadline"}</span><input type="date" value={taskDraft.deadlineDate} onChange={(event) => setTaskDraft((current) => ({ ...current, deadlineDate: event.target.value, due: event.target.value ? deadlineDateLabel(event.target.value, todayDate) : "No deadline" }))} /></label>
            </div>
            {modalCreatingGoogle ? <div className="task-create-preview"><header><span>Outgoing task</span><strong>{selectedTaskDestination?.listName ?? "No destination"}</strong></header><dl><div><dt>Account</dt><dd>{selectedTaskDestination?.accountId ?? ""}</dd></div><div><dt>List ID</dt><dd>{selectedTaskDestination?.listId ?? ""}</dd></div><div><dt>Title</dt><dd>{taskDraft.title.trim() || "Untitled"}</dd></div><div><dt>Due</dt><dd>{taskGoogleDue || "None"}</dd></div><div><dt>Local reminder</dt><dd>{taskReminderLocal ? `${taskReminderLocal.replace("T", " ")} Dublin${taskReminderInstant?.localValue === taskReminderLocal ? ` · ${taskReminderInstant.instant}` : ""}` : "None"}</dd></div></dl><pre>{outgoingTaskNotes(taskNotes, taskCreateNonce)}</pre></div> : null}
            <button className="task-details-toggle" type="button" aria-expanded={showTaskDetails} aria-controls="task-more-options" onClick={() => setShowTaskDetails((current) => !current)}><SlidersHorizontal size={13} /><span>{showTaskDetails ? "Hide options" : "More options"}</span><ChevronDown size={13} /></button>
            {showTaskDetails ? <div className="editor-grid editor-grid--task-details" id="task-more-options">
              <label className="field"><span>{modalGoogleOwned || modalPendingGoogle || modalCreatingGoogle ? "Area · from list" : modalRowOwned ? "Area · from source" : "Area"}</span><select disabled={modalRowOwned || modalCreatingGoogle} value={taskDraft.area} onChange={(event) => { const value = event.target.value; if (isOneOf(value, areas)) setTaskDraft((current) => ({ ...current, area: value })); }}><option value="University">University</option><option value="Work">Work</option><option value="Personal">Personal</option><option value="Health">Health</option><option value="Admin">Admin</option></select></label>
              <label className="field"><span>Priority</span><select value={taskDraft.priority} onChange={(event) => { const value = event.target.value; if (isOneOf(value, priorities)) setTaskDraft((current) => ({ ...current, priority: value })); }}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
              <label className="field"><span>Duration</span><select value={taskDraft.duration} onChange={(event) => setTaskDraft((current) => ({ ...current, duration: event.target.value }))}><option value="5 min">5 min</option><option value="10 min">10 min</option><option value="20 min">20 min</option><option value="30 min">30 min</option><option value="40 min">40 min</option><option value="45 min">45 min</option><option value="60 min">60 min</option></select></label>
              <label className="field"><span>Task state</span><select value={taskDraft.state} onChange={(event) => { const value = event.target.value; if (isOneOf(value, activeTaskStates)) setTaskDraft((current) => ({ ...current, state: value })); }}><option value="up-next">Up next</option><option value="scheduled">Scheduled</option><option value="waiting">Waiting</option></select></label>
              <label className="field"><span>Planned day</span><input type="date" value={taskDraft.scheduledDate} onChange={(event) => { setTaskPlannedInstant(null); setTaskDraft((current) => ({ ...current, scheduledDate: event.target.value })); }} /></label>
              <label className="field"><span>Planned time{taskPlannedInstant ? " · exact source" : ""}</span><input type="time" value={taskDraft.scheduledTime} onChange={(event) => { setTaskPlannedInstant(null); setTaskDraft((current) => ({ ...current, scheduledTime: event.target.value })); }} /></label>
              {modalCreatingGoogle ? <label className="field field--full"><span>Local reminder · Dublin</span><input type="datetime-local" value={taskReminderLocal} onChange={(event) => { setTaskReminderInstant(null); setTaskReminderLocal(event.target.value); }} /></label> : modalRowOwned ? null : <label className="field field--full"><span>Reminder</span><select value={taskDraft.reminderMode} onChange={(event) => { const value = event.target.value; if (isOneOf(value, reminderModes)) setTaskDraft((current) => ({ ...current, reminderMode: value })); }}><option value="none">No reminder</option><option value="one-hour">1 hour before</option><option value="morning">09:00 on the day</option></select></label>}
            </div> : null}
            <div className="editor-footer"><span>{modalCreatingGoogle ? selectedTaskDestination ? `${selectedTaskDestination.accountId} · ${selectedTaskDestination.listName}` : "Choose a destination." : modalGoogleOwned ? "The checkbox records completion approval." : modalRowOwned ? "Fox Focus stores planning only." : taskDraft.scheduledTime ? "This will create or update a local timetable block." : "Leave plan blank to keep it unscheduled."}</span><div>{initial && modalTask && modalTaskRow ? <button className="secondary-action" type="button" disabled={modalPendingGoogle} title={modalPendingGoogle ? "Wait for Google creation confirmation" : undefined} onClick={() => openTaskJobComposer(modalTask)}><MessageSquare size={13} /> Ask Hermes</button> : null}{modalCreateAction?.state === "conflict" && taskCreateConflictCandidates(modalCreateAction).length ? <button className="secondary-action" type="button" onClick={() => { setModal(null); setTaskCreateConflictActionId(modalCreateAction.id); }}><RefreshCw size={13} /> Review matches</button> : modalTaskAction?.state === "conflict" || modalCreateAction?.state === "conflict" ? <button className="secondary-action" type="button" onClick={() => { setModal(null); setShowIntegrations(true); }}><RefreshCw size={13} /> Sources</button> : null}{modalTask?.linkedEventId ? <button className="secondary-action" type="button" onClick={() => { setModal(null); openTaskSchedule(modalTask); }}><CalendarDays size={13} /> View calendar</button> : null}<button className="secondary-action" type="button" disabled={taskPlanBusy} onClick={() => setModal(null)}>Cancel</button><button className="submit-button" type="submit" disabled={taskPlanBusy || (modalCreatingGoogle && !selectedTaskDestination)}><Check size={14} /> {taskPlanBusy ? "Saving…" : modalCreatingGoogle ? "Create in Google" : modalRowOwned ? "Save plan" : "Save task"}</button></div></div>
          </form>
        </DialogFrame>
      ) : null}

      {jobComposer ? (
        <DialogFrame title="Ask Hermes" onClose={() => setJobComposer(null)} className="editor-dialog--job">
          <form onSubmit={submitJob}>
            <div className="editor-heading">
              <div className="composer-icon"><MessageSquare size={17} /></div>
              <div><p className="eyebrow">Hermes request</p><h2>What should Hermes do?</h2></div>
              <button className="close-composer" type="button" onClick={() => setJobComposer(null)} aria-label="Close job editor"><X size={17} /></button>
            </div>
            {modalError ? <p className="editor-error" role="alert">{modalError}</p> : null}
            <div className="editor-grid">
              <label className="field field--full"><span>Title</span><input required value={jobComposer.title} maxLength={200} onChange={(event) => setJobComposer((current) => current ? { ...current, title: event.target.value } : current)} /></label>
              {jobComposer.context ? <p className="job-composer-context">{jobComposer.context}</p> : null}
              <div className="job-prompt-presets" role="group" aria-label="Suggested requests">{jobPromptPresets.map(([label, instruction]) => <button className="secondary-action" type="button" key={label} onClick={() => setJobInstruction(instruction)}>{label}</button>)}</div>
              <label className="field field--full"><span>Request</span><textarea data-autofocus required maxLength={2000} value={jobInstruction} onChange={(event) => setJobInstruction(event.target.value)} placeholder="Ask for a draft, a task, a plan, or a check…" /></label>
            </div>
            <div className="editor-footer"><span>{jobComposer.taskId ? "Hermes receives this task's context." : jobComposer.inboxId ? "Hermes receives this Inbox item's context." : "Hermes receives the context shown above."}</span><div><button className="secondary-action" type="button" onClick={() => setJobComposer(null)}>Cancel</button><button className="submit-button" type="submit" disabled={workBusyKey === "job:create"}><CornerUpLeft size={14} /> Send to Hermes</button></div></div>
          </form>
        </DialogFrame>
      ) : null}

      {editingReply ? (
        <DialogFrame title="Edit reply draft" onClose={() => setEditingReply(null)} className="editor-dialog--draft">
          <form onSubmit={saveReplyEditor}>
            <div className="editor-heading">
              <div className="composer-icon"><Mail size={17} /></div>
              <div><p className="eyebrow">Reply revision</p><h2>Edit draft</h2></div>
              <button className="close-composer" type="button" onClick={() => setEditingReply(null)} aria-label="Close reply editor"><X size={17} /></button>
            </div>
            {modalError ? <p className="editor-error" role="alert">{modalError}</p> : null}
            <div className="editor-grid reply-editor-grid">
              <label className="field"><span>Account</span><input readOnly value={editingReply.reply.accountId} /></label>
              <label className="field"><span>From</span><input required value={editingReply.reply.from} onChange={(event) => setEditingReply((current) => current ? { ...current, reply: { ...current.reply, from: event.target.value } } : current)} /></label>
              <label className="field field--full"><span>To · one recipient per line</span><textarea className="reply-recipient-field" required value={editingReply.reply.to.join("\n")} onChange={(event) => setEditingReply((current) => current ? { ...current, reply: { ...current.reply, to: event.target.value.split(/\r?\n/) } } : current)} /></label>
              <label className="field"><span>Cc · one per line</span><textarea className="reply-recipient-field" value={editingReply.reply.cc.join("\n")} onChange={(event) => setEditingReply((current) => current ? { ...current, reply: { ...current.reply, cc: event.target.value.split(/\r?\n/) } } : current)} /></label>
              <label className="field"><span>Bcc · one per line</span><textarea className="reply-recipient-field" value={editingReply.reply.bcc.join("\n")} onChange={(event) => setEditingReply((current) => current ? { ...current, reply: { ...current.reply, bcc: event.target.value.split(/\r?\n/) } } : current)} /></label>
              <label className="field field--full"><span>Subject</span><input value={editingReply.reply.subject} onChange={(event) => setEditingReply((current) => current ? { ...current, reply: { ...current.reply, subject: event.target.value } } : current)} /></label>
              <label className="field field--full"><span>Body</span><textarea data-autofocus maxLength={200000} value={editingReply.reply.bodyText} onChange={(event) => setEditingReply((current) => current ? { ...current, reply: { ...current.reply, bodyText: event.target.value } } : current)} /></label>
            </div>
            <div className="reply-envelope-ids"><span>Reply to {editingReply.reply.replyToMessageId}</span><span>Thread {editingReply.reply.threadId}</span></div>
            <div className="editor-footer"><span>Creates a new owner revision.</span><div><button className="secondary-action" type="button" onClick={() => setEditingReply(null)}>Cancel</button><button className="submit-button" type="submit" disabled={workBusyKey === `draft:${editingReply.inboxId}`}><Check size={14} /> Save revision</button></div></div>
          </form>
        </DialogFrame>
      ) : null}

      {eventModal ? (
        <DialogFrame title={eventModal.eventId ? "Edit local calendar block" : "Add calendar block"} onClose={() => setModal(null)}>
          <form onSubmit={saveEvent}>
            <div className="editor-heading">
              <div className="composer-icon"><CalendarDays size={17} /></div>
              <div><p className="eyebrow">{eventModal.eventId ? "Local calendar block" : "Capture into calendar"}</p><h2>{eventModal.eventId ? "Edit block" : "Add calendar block"}</h2></div>
              <button className="close-composer" type="button" onClick={() => setModal(null)} aria-label="Close calendar editor"><X size={17} /></button>
            </div>
            {modalError ? <p className="editor-error" role="alert">{modalError}</p> : null}
            {modalInbox ? <div className="source-notice"><Inbox size={14} /> Capturing from <strong>{modalInbox.source}</strong>. The local block keeps that source.</div> : null}
            <div className="editor-grid">
              <label className="field field--full"><span>Block title</span><input data-autofocus value={eventDraft.title} onChange={(event) => setEventDraft((current) => ({ ...current, title: event.target.value }))} placeholder="What belongs in the timetable?" /></label>
              <label className="field field--full"><span>Location or context</span><input value={eventDraft.subtitle} onChange={(event) => setEventDraft((current) => ({ ...current, subtitle: event.target.value }))} placeholder="Optional note, location, or call link" /></label>
              <label className="field"><span>Area</span><select value={eventDraft.area} onChange={(event) => { const value = event.target.value; if (isOneOf(value, areas)) setEventDraft((current) => ({ ...current, area: value })); }}><option value="University">University</option><option value="Work">Work</option><option value="Personal">Personal</option><option value="Health">Health</option><option value="Admin">Admin</option></select></label>
              <label className="field"><span>Day</span><input type="date" required value={eventDraft.date} onChange={(event) => setEventDraft((current) => ({ ...current, date: event.target.value }))} /></label>
              <label className="field"><span>Start time</span><input type="time" required value={eventDraft.time} onChange={(event) => setEventDraft((current) => ({ ...current, time: event.target.value }))} /></label>
              <label className="field"><span>Duration</span><select value={eventDraft.duration} onChange={(event) => setEventDraft((current) => ({ ...current, duration: event.target.value }))}><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option><option value="90">90 min</option></select></label>
              <label className="field"><span>Reminder</span><select value={eventDraft.reminderMode} onChange={(event) => { const value = event.target.value; if (isOneOf(value, reminderModes)) setEventDraft((current) => ({ ...current, reminderMode: value })); }}><option value="none">No reminder</option><option value="one-hour">1 hour before</option><option value="morning">09:00 on the day</option></select></label>
            </div>
            <div className="editor-footer"><span>Local only. No provider calendar is being written to.</span><div>{eventModal.eventId ? <button className="danger-button" type="button" onClick={deleteEvent}><Trash2 size={13} /> Delete</button> : null}<button className="secondary-action" type="button" onClick={() => setModal(null)}>Cancel</button><button className="submit-button" type="submit"><Check size={14} /> Save block</button></div></div>
          </form>
        </DialogFrame>
      ) : null}

      {draftModal ? (
        <DialogFrame title="Draft for review" onClose={() => setModal(null)} className="editor-dialog--draft">
          <div className="editor-heading">
            <div className="composer-icon"><Pencil size={17} /></div>
            <div><p className="eyebrow">Inbox draft</p><h2>Draft for review</h2></div>
            <button className="close-composer" type="button" onClick={() => setModal(null)} aria-label="Close draft editor"><X size={17} /></button>
          </div>
          {modalError ? <p className="editor-error" role="alert">{modalError}</p> : null}
          <p className="draft-context">This stays in the local Inbox. It is not a send screen.</p>
          <label className="field"><span>Draft reply</span><textarea data-autofocus value={draftText} onChange={(event) => setDraftText(event.target.value)} /></label>
          <div className="editor-footer"><span>Source remains attached for review.</span><div><button className="secondary-action" type="button" onClick={() => setModal(null)}>Keep reviewing</button><button className="submit-button" type="button" onClick={saveDraft}><Check size={14} /> Save draft</button></div></div>
        </DialogFrame>
      ) : null}

      {showReminderTray ? (
        <DialogFrame title="Reminders" onClose={() => setShowReminderTray(false)} className="editor-dialog--tray">
          <div className="editor-heading"><div className="composer-icon"><Bell size={17} /></div><div><p className="eyebrow">On this device</p><h2>Reminders</h2></div><button className="close-composer" type="button" onClick={() => setShowReminderTray(false)} aria-label="Close reminders"><X size={17} /></button></div>
          <div className="reminder-list">
            {allReminders.map((reminder) => <div className="reminder-row" key={reminder.id}><Bell size={14} /><span><strong>{reminder.title}</strong><small>{reminder.when} · {reminder.source === "hermes" ? "Hermes task · " : reminder.source === "row" ? "Fox Focus task · " : ""}{reminderTimingLabel(reminder)}</small></span></div>)}
            {!allReminders.length ? <p className="empty-line">No local reminders yet.</p> : null}
          </div>
          <div className="editor-footer"><span>{pushSubscribed ? "Notifications can arrive when Fox Focus is closed." : "In-tab reminders still work while Fox Focus is open."}</span><div className="reminder-footer-actions">{notificationStatus ? <p className="notification-status">{notificationStatus}</p> : null}{pushSubscribed ? <button className="mini-action" type="button" onClick={() => void turnOffDeviceNotifications()}>Turn off</button> : <button className="secondary-action" type="button" disabled={notificationPermission === "denied" || notificationPermission === "unsupported"} onClick={() => void requestNotificationPermission()}>Enable device notifications</button>}<button className="submit-button" type="button" disabled={!allReminders.length} onClick={testReminder}><Bell size={14} /> Preview first reminder</button></div></div>
        </DialogFrame>
      ) : null}

      {activeReminder ? (
        <DialogFrame title="Reminder" onClose={() => setActiveReminderId(null)} className="editor-dialog--alert">
          <div className="reminder-alert-icon"><Bell size={22} /></div>
          <p className="eyebrow">Reminder</p>
          <h2>{activeReminder.title}</h2>
          <p>{activeReminder.when}.</p>
          <div className="alert-actions"><button className="secondary-action" type="button" onClick={() => setActiveReminderId(null)}>Dismiss</button>{activeReminder.source === "workspace" ? <button className="submit-button" type="button" onClick={snoozeReminder}>Snooze 30 min</button> : null}</div>
        </DialogFrame>
      ) : null}

      {taskConflictActionId ? (
        <DialogFrame title="Review Google conflict" onClose={() => setTaskConflictActionId(null)} className="editor-dialog--alert">
          <div className="editor-heading"><div className="composer-icon"><RefreshCw size={17} /></div><div><p className="eyebrow">Remote conflict</p><h2>Google changed this task</h2></div><button className="close-composer" type="button" onClick={() => setTaskConflictActionId(null)} aria-label="Close conflict review"><X size={17} /></button></div>
          {taskConflictAction && taskConflictCurrent && taskConflictTask && taskConflictRow?.binding.kind === "google" ? <>
            <div className="task-action-preview task-conflict-preview">
              <div><span>Approved {formatDublinInstant(taskConflictAction.approval.at)}</span><strong>{taskConflictAction.payload.before} → {taskConflictAction.payload.after}</strong><small>{taskConflictAction.approval.previewText}</small><small>Expected ETag {taskConflictAction.payload.expectedEtag ?? "none"}</small></div>
              <ChevronRight size={16} aria-hidden="true" />
              <div><span>Google at conflict</span><strong>{taskConflictCurrent.title}</strong><small>{taskConflictCurrent.state}{taskConflictCurrent.dueOn ? ` · due ${formatDublinDateKey(taskConflictCurrent.dueOn, { day: "numeric", month: "short" })}` : " · no due day"}</small><small>ETag {taskConflictCurrent.version ?? "none"} · {formatDublinInstant(taskConflictCurrent.updatedAt)}</small></div>
            </div>
            <div className="conflict-next-change"><span>New approval</span><strong>{taskConflictRow.observed?.status ?? taskConflictCurrent.state} → {taskConflictDesired}</strong><small>Current ETag {taskConflictRow.observed?.etag ?? "none"}</small></div>
            <p className="draft-context">The first approval no longer matches Google. Approve this new before-and-after pair to try again.</p>
            <div className="alert-actions"><button className="secondary-action" type="button" onClick={() => setTaskConflictActionId(null)}>Cancel</button><button className="submit-button" type="button" disabled={busyTaskIds.has(taskConflictTask.id) || taskConflictRow.observed?.completionWritable !== true || taskConflictRow.unavailableAt !== null} onClick={approveTaskConflict}>{taskConflictDesired === "completed" ? "Approve complete" : "Approve reopen"}</button></div>
          </> : <><p className="draft-context">The stored conflict details are unavailable. Refresh sources before trying again.</p><div className="alert-actions"><button className="secondary-action" type="button" onClick={() => setTaskConflictActionId(null)}>Close</button></div></>}
        </DialogFrame>
      ) : null}

      {taskCreateConflictActionId ? (
        <DialogFrame title="Review Google task matches" onClose={() => setTaskCreateConflictActionId(null)} className="editor-dialog--alert editor-dialog--create-conflict">
          <div className="editor-heading"><div className="composer-icon"><RefreshCw size={17} /></div><div><p className="eyebrow">Create conflict</p><h2>More than one Google task matches</h2></div><button className="close-composer" type="button" onClick={() => setTaskCreateConflictActionId(null)} aria-label="Close task creation conflict"><X size={17} /></button></div>
          {taskCreateConflictAction && taskCreateCandidates.length ? <>
            <div className="create-conflict-approval">
              <span>Approved {formatDublinInstant(taskCreateConflictAction.approval.at)}</span>
              <strong>{taskCreateConflictAction.payload.title}</strong>
              <small>Account {taskCreateConflictAction.payload.destination.accountId}</small>
              <small>List {taskCreateConflictAction.payload.destination.listId} · due {taskCreateConflictAction.payload.doOn ?? "none"}</small>
              <pre>{taskCreateConflictAction.payload.notes}</pre>
            </div>
            <div className="create-conflict-candidates" aria-label="Matching Google tasks">
              {taskCreateCandidates.map((candidate) => <article key={candidate.externalId}>
                <i className={`inbox-thread-dot inbox-thread-dot--${candidate.state === "completed" ? "settled" : "needs_you"}`} aria-hidden="true" />
                <div><strong>{candidate.title}</strong><small>{candidate.state} · due {candidate.dueDate ?? "none"}</small><small>Task {candidate.externalId} · ETag {candidate.version ?? "none"}</small>{candidate.updatedAt ? <small>{formatDublinInstant(candidate.updatedAt)}</small> : null}</div>
              </article>)}
            </div>
            <div className="editor-footer"><span>{taskCreateConflictTask?.title ?? "Pending Google task"} remains unbound.</span><div><button className="secondary-action" type="button" onClick={() => setTaskCreateConflictActionId(null)}>Close</button><button className="submit-button" type="button" onClick={() => { setTaskCreateConflictActionId(null); setShowIntegrations(true); }}><RefreshCw size={13} /> Sources</button></div></div>
          </> : <><p className="draft-context">The stored candidate details are unavailable.</p><div className="alert-actions"><button className="secondary-action" type="button" onClick={() => setTaskCreateConflictActionId(null)}>Close</button></div></>}
        </DialogFrame>
      ) : null}

      {hermesAdoption ? (
        <DialogFrame title="Adopt Hermes task" onClose={() => { if (!adoptingHermesId) setHermesAdoption(null); }} className="editor-dialog--alert">
          <div className="editor-heading"><div className="composer-icon"><Bot size={17} /></div><div><p className="eyebrow">Legacy task handover</p><h2>Move this task home?</h2></div><button className="close-composer" type="button" disabled={Boolean(adoptingHermesId)} onClick={() => setHermesAdoption(null)} aria-label="Cancel task adoption"><X size={17} /></button></div>
          <div className="task-action-preview"><div><span>Before</span><strong>Hermes owns it</strong><small>{String(hermesAdoption.before.state ?? "open")} · {String(hermesAdoption.before.source ?? "Unsorted")}</small></div><ChevronRight size={16} aria-hidden="true" /><div><span>After</span><strong>Fox Focus owns it</strong><small>{hermesAdoption.after.title} · Hermes link kept as provenance</small></div></div>
          <p className="draft-context">Approving this is the cutover for this task. Fox Focus becomes its working home, while Hermes is unchanged and remains canonical for every task not adopted.</p>
          <div className="alert-actions"><button className="secondary-action" type="button" disabled={Boolean(adoptingHermesId)} onClick={() => setHermesAdoption(null)}>Cancel</button><button className="submit-button" type="button" disabled={Boolean(adoptingHermesId)} onClick={() => void approveHermesAdoption()}>{adoptingHermesId ? "Adopting…" : "Adopt into Fox Focus"}</button></div>
        </DialogFrame>
      ) : null}

      <IntegrationsDrawer
        open={showIntegrations}
        onClose={() => setShowIntegrations(false)}
        overviewState={integrations}
        listAreas={data.listAreas}
        onListAreaChange={changeListArea}
        beforeWorkspaceMutation={waitForWorkspaceSaves}
        onWorkspaceChanged={applyServerSnapshot}
        localTasks={data.tasks}
      />
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing application root");
const root = createRoot(rootElement);
if (import.meta.env.DEV || window.location.protocol === "file:") {
  root.render(<App />);
} else {
  fetch("/api/v1/workspace").then(async (response) => {
    if (!response.ok) throw new Error("Could not load the server workspace");
    const initial: unknown = await response.json();
    if (!isServerSnapshot(initial)) throw new Error("Invalid server workspace");
    root.render(<App initial={initial} />);
  }).catch(() => {
    document.documentElement.dataset.theme = loadTheme();
    root.render(<WorkspaceUnavailable />);
  });
}
