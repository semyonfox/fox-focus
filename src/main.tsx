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
  Inbox,
  Link2,
  ListTodo,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
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
  dublinDateKey,
  dublinDateTimeToInstant,
  dublinTimeValue,
  formatDublinDateKey,
  isDateKey,
} from "./calendar-time.ts";
import { hermesLabels, useHermesFeed } from "./hermes-feed.tsx";
import { deduplicatedProviderIdentity, type HermesTask, type HermesTaskAnnotationInput } from "./hermes-model.ts";
import { IntegrationCalendarContext, IntegrationsDrawer, providerLabel, useOverview, type ImportedRecord } from './integrations.tsx';
import { areaForList } from './integration-model.ts';

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
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function timeValueToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
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

type ClientTaskActionStatus = "awaiting_approval" | "running" | "succeeded" | "failed" | "conflict";
type ClientTaskAction = {
  id: string;
  taskId: string;
  desiredState: "open" | "completed";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  status: ClientTaskActionStatus;
  result: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: string;
  expiresAt?: string;
  leaseExpiresAt?: string | null;
};

type TaskActionPreview = ClientTaskAction & { status: "awaiting_approval"; expiresAt: string };
type HermesAdoptionPreview = {
  id: string;
  status: "awaiting_approval";
  before: Record<string, unknown>;
  after: Task;
  expiresAt: string;
};

function isClientTaskAction(value: unknown): value is ClientTaskAction {
  return isRecord(value) && typeof value.id === "string" && typeof value.taskId === "string" &&
    (value.desiredState === "open" || value.desiredState === "completed") &&
    ["awaiting_approval", "running", "succeeded", "failed", "conflict"].includes(String(value.status)) &&
    isRecord(value.before) && isRecord(value.after) &&
    (value.result === null || isRecord(value.result)) &&
    (value.lastError === null || typeof value.lastError === "string") && typeof value.createdAt === "string";
}

function isTaskActionPreview(value: unknown): value is TaskActionPreview {
  return isClientTaskAction(value) && value.status === "awaiting_approval" && typeof value.expiresAt === "string";
}

function isHermesAdoptionPreview(value: unknown): value is HermesAdoptionPreview {
  return isRecord(value) && typeof value.id === "string" && value.status === "awaiting_approval" &&
    isRecord(value.before) && isTask(value.after) && typeof value.expiresAt === "string";
}

function isServerSnapshot(value: unknown): value is ServerSnapshot {
  return isRecord(value) && typeof value.revision === "number" && Number.isSafeInteger(value.revision) &&
    value.revision >= 0 && isPrototypeData(value.data);
}

function actionStateLabel(action: ClientTaskAction | undefined): string | null {
  if (!action) return null;
  if (action.status === "awaiting_approval" || action.status === "running") return "Google pending";
  if (action.status === "failed") return "Google retry needed";
  if (action.status === "conflict") return "Google changed";
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
  latestAction?: ClientTaskAction;
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
            {task.externalLinks?.some((link) => link.provider === "google_tasks") ? <em className="source-chip">Google linked</em> : task.origin === "migration" ? <em className="source-chip">Imported</em> : null}
            {sourceBadge}
            {actionStateLabel(latestAction) ? <em className={`task-action-state task-action-state--${latestAction?.status}`}>{actionStateLabel(latestAction)}</em> : null}
            {!compact ? <em className={`task-created${createdAt ? "" : " task-created--unknown"}`}>{createdAt ? `Added ${createdAt}` : "Created date unknown"}</em> : null}
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
type ReviewUndo = { itemId: string; status: InboxStatus };

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
  const [taskActions, setTaskActions] = useState<ClientTaskAction[]>([]);
  const [taskActionPreview, setTaskActionPreview] = useState<TaskActionPreview | null>(null);
  const [taskActionBusy, setTaskActionBusy] = useState(false);
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
  const firedHermesReminderIds = useRef(new Set<string>());
  const hermesBoard = hermes.feed && hermes.feed.state !== "unavailable" ? hermes.feed.board : null;
  const adoptedHermesIds = new Set(data.tasks.flatMap((task) => task.externalLinks ?? [])
    .filter((link) => link.provider === "hermes")
    .map((link) => link.externalId));
  const hermesTasks = (hermesBoard?.tasks ?? []).filter((task) => !adoptedHermesIds.has(task.id));
  const hermesReminders = useMemo<Reminder[]>(() =>
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
          ...(task.reminderFireAt ? { fireAt: task.reminderFireAt } : {}),
        }]
      : []), [hermes.feed?.state, hermesTasks]);
  const allReminders = useMemo(() => [...data.reminders, ...hermesReminders], [data.reminders, hermesReminders]);

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

  useEffect(() => {
    if (!initial) return;
    void refreshTaskActions();
  }, [initial]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => setSystemTheme(mediaQuery.matches ? "black" : "light");
    syncSystemTheme();
    mediaQuery.addEventListener("change", syncSystemTheme);
    return () => mediaQuery.removeEventListener("change", syncSystemTheme);
  }, []);

  const isOverlayOpen = Boolean(modal || editingHermesTaskId || hermesCompletionApproval || showReminderTray || activeReminderId || showIntegrations || taskActionPreview || hermesAdoption);

  useEffect(() => {
    if (!isOverlayOpen) {
      if (focusBeforeOverlay.current?.isConnected) focusBeforeOverlay.current.focus();
      return;
    }

    focusBeforeOverlay.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusFirstControl = () => {
      const dialog = document.querySelector<HTMLElement>(".editor-dialog");
      const preferred = dialog?.querySelector<HTMLElement>("[autofocus]");
      const first = dialog?.querySelector<HTMLElement>(focusableSelector);
      (preferred ?? first)?.focus();
    };
    const frame = window.requestAnimationFrame(focusFirstControl);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".editor-dialog");
      if (!dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (!controls.length) return;
      const first = controls[0];
      const last = controls.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
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
    };
  }, [isOverlayOpen]);

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
          !firedHermesReminderIds.current.has(`${reminder.id}\u0000${reminder.fireAt}`) && Date.parse(reminder.fireAt) > now)
        .sort((first, second) => Date.parse(first.fireAt ?? "") - Date.parse(second.fireAt ?? ""))[0];
      if (!nextReminder?.fireAt) return;

      const fireTime = Date.parse(nextReminder.fireAt);
      timeout = window.setTimeout(() => {
        if (fireTime > Date.now()) {
          scheduleNext();
          return;
        }
        setActiveReminderId(nextReminder.id);
        if (nextReminder.targetId.startsWith("hermes:")) {
          firedHermesReminderIds.current.add(`${nextReminder.id}\u0000${nextReminder.fireAt}`);
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
          if (!nextReminder.targetId.startsWith("hermes:")) setData((current) => ({
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
      setModal(null);
      setEditingHermesTaskId(null);
      setHermesCompletionApproval(null);
      setShowReminderTray(false);
      setActiveReminderId(null);
      setShowIntegrations(false);
      if (!taskActionBusy) setTaskActionPreview(null);
      if (!adoptingHermesId) setHermesAdoption(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [adoptingHermesId, taskActionBusy]);

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

  const todayDate = dublinDateKey(new Date());
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
  const sortedEvents = useMemo(
    () => [...data.events, ...hermesPlannedEvents].sort((first, second) => compareCalendarEvents(first, second, todayDate)),
    [data.events, hermesPlannedEvents, todayDate],
  );
  const calendarDays = useMemo(() => calendarDateWindow(calendarAnchor, 3, 3), [calendarAnchor]);
  const calendarRangeStart = selectedDate;
  const calendarRangeEnd = calendarMode === "day" ? selectedDate : addCalendarDays(selectedDate, 6);
  const visibleCalendarEvents = useMemo(
    () => sortedEvents.filter((event) => {
      const date = eventDateKey(event, todayDate);
      return date >= calendarRangeStart && date <= calendarRangeEnd;
    }),
    [calendarRangeEnd, calendarRangeStart, sortedEvents, todayDate],
  );
  const taskById = useMemo(() => new Map(data.tasks.map((task) => [task.id, task])), [data.tasks]);
  const eventById = useMemo(() => new Map(data.events.map((event) => [event.id, event])), [data.events]);
  const selectedEvent = visibleCalendarEvents.find((event) => event.id === selectedEventId) ?? visibleCalendarEvents[0] ?? null;
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
  const activeTasks = data.tasks.filter((task) => !task.completed);
  const activeBlock = visibleCalendarEvents.find((event) => event.editable && !taskById.get(event.taskId ?? "")?.completed) ?? null;
  const activeReminder = allReminders.find((reminder) => reminder.id === activeReminderId) ?? null;
  const importedTasks = integrations.overview?.records.filter((record) => record.kind === "task") ?? [];
  const providerIsAvailable = (provider: ImportedRecord["provider"]) =>
    importedTasks.some((task) => task.provider === provider) ||
    integrations.overview?.providers.some((status) => status.provider === provider && status.connection?.state === "connected") === true;
  const googleTasksAvailable = providerIsAvailable("google");
  const microsoftTasksAvailable = providerIsAvailable("microsoft");
  const latestActionByTask = new Map<string, ClientTaskAction>();
  for (const action of taskActions) {
    if (!latestActionByTask.has(action.taskId)) latestActionByTask.set(action.taskId, action);
  }
  const categoryLocalTasks = taskCategory === allTaskCategories
    ? data.tasks
    : taskCategory === unclassifiedTaskCategory
      ? []
      : data.tasks.filter((task) => task.area === taskCategory);
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
      if (taskFilter === "planned") return Boolean(task.scheduledTime) && !task.completed;
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
  const taskSourceOptions: Array<{ id: TaskSource; label: string; count: number }> = [
    { id: allTaskSources, label: "All sources", count: visibleTasks.length + visibleHermesTasks.length + combinedImportedTasks.length },
    { id: localTaskSource, label: "Fox Focus", count: visibleTasks.length },
  ];
  if (hermesBoard) taskSourceOptions.push({ id: hermesTaskSource, label: "Hermes", count: visibleHermesTasks.length });
  if (googleTasksAvailable) taskSourceOptions.push({ id: googleTaskSource, label: "Google Tasks", count: visibleImportedTasks.filter((task) => task.provider === "google").length });
  if (microsoftTasksAvailable) taskSourceOptions.push({ id: microsoftTaskSource, label: "Microsoft To Do", count: visibleImportedTasks.filter((task) => task.provider === "microsoft").length });
  const isExternalOnlyScope = taskSource === googleTaskSource || taskSource === microsoftTaskSource;
  const isHermesOnlyScope = taskSource === hermesTaskSource;

  const shownLocalTasks = taskSource === allTaskSources || taskSource === localTaskSource ? visibleTasks : [];
  const shownHermesTasks = taskSource === allTaskSources || taskSource === hermesTaskSource ? visibleHermesTasks : [];
  const shownImportedTasks = taskSource === allTaskSources
    ? combinedImportedTasks
    : taskSource === googleTaskSource || taskSource === microsoftTaskSource
      ? visibleImportedTasks.filter((task) => providerTaskSource(task.provider) === taskSource)
      : [];

  const reminderCount = allReminders.length;
  const reviewCount = data.inboxItems.filter((item) => item.status !== "handled").length;
  const plannedTaskCount = activeTasks.filter((task) => Boolean(task.linkedEventId && eventById.has(task.linkedEventId))).length +
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
    planned: categoryLocalTasks.filter((task) => Boolean(task.scheduledTime) && !task.completed).length,
    waiting: categoryLocalTasks.filter((task) => task.state === "waiting" && !task.completed).length,
    done: categoryLocalTasks.filter((task) => task.completed).length + categoryHermesTasks.filter((task) => task.status === "done").length,
  };
  const activeTaskFilterCount = Number(taskFilter !== "all") + Number(taskSource !== allTaskSources) + Number(taskSort !== "due");
  const shownTaskCount = shownLocalTasks.length + shownHermesTasks.length;
  const todayEvents = sortedEvents.filter((event) => eventDateKey(event, todayDate) === todayDate);
  const currentTime = timeValueToMinutes(dublinTimeValue(new Date()));
  const currentEvent = todayEvents.find((event) => {
    const startsAt = timeValueToMinutes(eventTimeValue(event));
    return startsAt <= currentTime && startsAt + event.duration > currentTime;
  });
  const nextEvents = todayEvents.filter((event) => timeValueToMinutes(eventTimeValue(event)) >= currentTime && event.id !== currentEvent?.id);
  const todayFocusEvents = [...(currentEvent ? [currentEvent] : []), ...nextEvents].slice(0, 3);
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
      (taskSource === googleTaskSource && !googleTasksAvailable) ||
      (taskSource === microsoftTaskSource && !microsoftTasksAvailable)) setTaskSource(allTaskSources);
  }, [googleTasksAvailable, hermesBoard, microsoftTasksAvailable, taskSource]);

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

  async function refreshTaskActions() {
    if (!initial) return;
    try {
      const response = await fetch("/api/v1/task-actions");
      const value: unknown = await response.json();
      if (!response.ok || !isRecord(value) || !Array.isArray(value.actions) || !value.actions.every(isClientTaskAction)) return;
      setTaskActions(value.actions);
    } catch {
      // Task data remains usable when the optional action ledger cannot load.
    }
  }

  async function previewLinkedTaskAction(task: Task, desiredState: "open" | "completed" = task.completed ? "open" : "completed") {
    if (!initial) return;
    setTaskActionBusy(true);
    setStatusMessage("");
    try {
      await waitForWorkspaceSaves();
      const response = await fetch("/api/v1/task-actions/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id, desiredState, idempotencyKey: makeId("task-action") }),
      });
      const value: unknown = await response.json();
      if (!response.ok || !isTaskActionPreview(value)) {
        throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : "Could not prepare the Google task preview.");
      }
      setTaskActionPreview(value);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not prepare the Google task preview.");
    } finally {
      setTaskActionBusy(false);
    }
  }

  async function executeTaskAction(action: ClientTaskAction, retry: boolean) {
    setTaskActionBusy(true);
    try {
      await waitForWorkspaceSaves();
      const suffix = retry ? "retry" : "approve";
      const response = await fetch(`/api/v1/task-actions/${encodeURIComponent(action.id)}/${suffix}`, { method: "POST" });
      const value: unknown = await response.json();
      const snapshot = isRecord(value) && isServerSnapshot(value.snapshot) ? value.snapshot : null;
      const resultAction = isRecord(value) && isClientTaskAction(value.action) ? value.action : null;
      if (snapshot) applyServerSnapshot(snapshot);
      if (resultAction) {
        setTaskActions(current => [resultAction, ...current.filter(candidate => candidate.id !== resultAction.id)]);
      }
      setTaskActionPreview(null);
      if (!resultAction) {
        throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : "The linked action could not be recorded.");
      }
      if (resultAction.status === "succeeded") {
        setStatusMessage(resultAction.desiredState === "completed"
          ? "Completed here and confirmed in Google Tasks."
          : "Reopened here and confirmed in Google Tasks.");
      } else {
        setStatusMessage(resultAction.lastError ?? (response.status === 409
          ? "Google changed after the preview. Your Fox Focus task was kept."
          : "Your Fox Focus task was kept, but Google still needs attention."));
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "The linked task action did not finish.");
    } finally {
      setTaskActionBusy(false);
    }
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

  function openTaskComposer(task?: Task, inboxItem?: InboxItem) {
    const linkedEvent = task?.linkedEventId
      ? data.events.find((event) => event.id === task.linkedEventId)
      : undefined;
    setTaskDraft({
      title: task?.title ?? inboxItem?.title ?? "",
      area: task?.area ?? inboxItem?.accent ?? (isOneOf(taskCategory, areas) ? taskCategory : "Personal"),
      priority: task?.priority ?? "medium",
      due: task?.due ?? "No deadline",
      deadlineDate: task?.deadlineDate ?? (task ? legacyDeadlineDate(task.due, todayDate) : ""),
      duration: task?.duration ?? "30 min",
      state: task && task.state !== "done" ? task.state : "up-next",
      scheduledDate: linkedEvent ? eventDateKey(linkedEvent, todayDate) : task?.scheduledDate ?? selectedDate,
      scheduledTime: linkedEvent ? eventTimeValue(linkedEvent) : task?.scheduledTime ?? "",
      reminderMode: task ? reminderModeFor(data.reminders, task.id) : "none",
    });
    setModalError("");
    setShowTaskDetails(Boolean(task || inboxItem));
    setModal({ kind: "task", taskId: task?.id, inboxId: inboxItem?.id });
  }

  function openEventComposer(event?: TimelineEvent, inboxItem?: InboxItem) {
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

  function toggleTask(task: Task) {
    if (initial && task.externalLinks?.some(link => link.provider === "google_tasks" && link.policy === "completion_only")) {
      if (!taskActionBusy) void previewLinkedTaskAction(task);
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

  function saveTask(event: FormEvent<HTMLFormElement>) {
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
    const plannedStartAt = taskDraft.scheduledTime
      ? dublinDateTimeToInstant(scheduledDate, taskDraft.scheduledTime)
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
      tasks: existingEvent?.taskId
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

    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.linkedEventId === eventToRemove.id
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

  function testReminder() {
    const reminder = allReminders.find((candidate) => candidate.state === "scheduled") ?? allReminders[0];
    if (!reminder) {
      setStatusMessage("Add a reminder to a task or local calendar block first.");
      return;
    }
    setShowReminderTray(false);
    setActiveReminderId(reminder.id);
  }

  function snoozeReminder() {
    if (!activeReminder) return;
    if (activeReminder.targetId.startsWith("hermes:")) {
      setActiveReminderId(null);
      setStatusMessage("Edit the Hermes task plan to change this reminder.");
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

  function renderScheduleRow(event: TimelineEvent, showDate = false) {
    const linkedTask = event.taskId ? taskById.get(event.taskId) : undefined;
    const linkedTaskDone = linkedTask?.completed === true;
    const date = eventDateKey(event, todayDate);
    const time = eventTimeValue(event);

    return (
      <button
        className={`schedule-row${showDate ? " schedule-row--dated" : ""}${event.id === selectedEvent?.id ? " schedule-row--selected" : ""}${linkedTaskDone ? " schedule-row--done" : ""}${event.editable ? "" : " schedule-row--imported"}`}
        key={event.id}
        type="button"
        aria-pressed={event.id === selectedEvent?.id}
        onClick={() => setSelectedEventId(event.id)}
      >
        <time dateTime={event.startsAt ?? time}>
          {showDate ? <><span>{formatDublinDateKey(date, { weekday: "short", day: "numeric" })}</span><small>{time}</small></> : time}
        </time>
        <i className={`area-dot area-dot--${areaClass(event.area)}`} />
        <span className="schedule-row-copy">
          <strong>{event.title}</strong>
          <small>{!event.editable ? <em className="agenda-origin agenda-origin--imported">Imported</em> : null}{event.subtitle}</small>
        </span>
        <span className="schedule-duration">{formatDuration(event.duration)}</span>
        <ChevronRight className="schedule-arrow" size={14} />
      </button>
    );
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

  function renderTodayView() {
    const openReviewItems = reviewItems.filter((item) => item.status !== "handled").slice(0, 3);

    return <section className="workspace-page workspace-page--today" aria-labelledby="today-heading">
      <header className="workspace-heading today-heading">
        <div>
          <p className="eyebrow">{formatDublinDateKey(todayDate, { weekday: "long", day: "numeric", month: "long" })}</p>
          <h1 id="today-heading">Today</h1>
          <p>A short view of what needs your attention now.</p>
        </div>
      </header>

      {initial && hermes.failed ? <p className="workspace-alert"><Bot size={14} /> Hermes could not refresh. Your Fox Focus tasks are still available.</p> : null}

      <div className="today-grid">
        <article className="pane today-card today-card--schedule">
          <PaneHeader eyebrow="Calendar" title={currentEvent ? "Now and next" : "Next today"} action={<button className="pane-link" type="button" onClick={() => openWorkspaceView("agenda")}>Full calendar <ChevronRight size={12} /></button>} />
          <div className="today-event-list">
            {todayFocusEvents.map((event, index) => <button className="today-event-row" type="button" key={event.id} onClick={() => openTodayEvent(event)}>
              <time dateTime={event.startsAt ?? eventTimeValue(event)}><span>{event.id === currentEvent?.id ? "Now" : index === 0 ? "Next" : "Then"}</span><strong>{eventTimeValue(event)}</strong></time>
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
            {attentionTasks.map((task) => <TaskRow compact key={task.id} task={task} dueLabel={taskDeadlineLabel(task, todayDate)} latestAction={latestActionByTask.get(task.id)} plannedDate={plannedDateForTask(task)} onToggle={toggleTask} onEdit={openTaskComposer} />)}
            {!attentionTasks.length ? <div className="today-empty"><CheckCircle2 size={17} /><span><strong>No open local tasks</strong><small>Add one when something comes up.</small></span></div> : null}
          </div>
        </article>

        <article className="pane today-card today-card--due">
          <PaneHeader eyebrow="Due soon" title="What is coming" />
          <div className="today-stat-list">
            <button type="button" onClick={() => { selectTaskFilter("due-today"); openWorkspaceView("tasks"); }}><span>Today</span><strong>{dueTodayCount}</strong></button>
            <button type="button" onClick={() => { selectTaskFilter("open"); openWorkspaceView("tasks"); }}><span>Tomorrow</span><strong>{dueTomorrowCount}</strong></button>
            <button type="button" onClick={() => { selectTaskFilter("waiting"); openWorkspaceView("tasks"); }}><span>Waiting</span><strong>{waitingTaskCount}</strong></button>
          </div>
        </article>

        <article className="pane today-card today-card--inbox">
          <PaneHeader eyebrow="Inbox" title={reviewCount ? `${reviewCount} decision${reviewCount === 1 ? "" : "s"}` : "Nothing waiting"} action={<button className="pane-link" type="button" onClick={() => openWorkspaceView("review")}>Open Inbox <ChevronRight size={12} /></button>} />
          <div className="today-inbox-list">
            {openReviewItems.map((item) => <button type="button" key={item.id} onClick={() => openTodayInbox(item)}><i className={`area-dot area-dot--${areaClass(item.accent)}`} /><span><strong>{item.title}</strong><small>{item.source}</small></span><ChevronRight size={14} /></button>)}
            {!openReviewItems.length ? <div className="today-empty"><Inbox size={17} /><span><strong>Inbox is clear</strong><small>New proposals will appear here.</small></span></div> : null}
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
          <span className="calendar-range-copy">{calendarMode === "day" ? `${visibleCalendarEvents.length} local block${visibleCalendarEvents.length === 1 ? "" : "s"}` : `${formatDublinDateKey(calendarRangeStart, { day: "numeric", month: "short" })} to ${formatDublinDateKey(calendarRangeEnd, { day: "numeric", month: "short" })}`}</span>
        </div>
        <div className="calendar-date-shell">
          <button className="calendar-step" type="button" onClick={() => moveCalendarDate(-1)} aria-label="Previous day"><ChevronLeft size={16} /></button>
          <div className="calendar-date-strip" role="tablist" aria-label="Choose a day">
            {calendarDays.map((date, index) => {
              const localCount = sortedEvents.filter((event) => eventDateKey(event, todayDate) === date).length;
              const fullLabel = formatDublinDateKey(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
              return <button className={`calendar-date-tab${date === selectedDate ? " calendar-date-tab--selected" : ""}${date === todayDate ? " calendar-date-tab--today" : ""}`} id={`calendar-date-${date}`} key={date} type="button" role="tab" aria-controls="calendar-day-panel" aria-current={date === todayDate ? "date" : undefined} aria-label={`${fullLabel}${date === todayDate ? ", today" : ""}, ${localCount} local ${localCount === 1 ? "block" : "blocks"}`} aria-selected={date === selectedDate} tabIndex={date === selectedDate ? 0 : -1} ref={(element) => { calendarTabRefs.current[index] = element; }} onClick={() => selectCalendarDate(date)} onKeyDown={(event) => handleCalendarTabKeyDown(event, index)}>
                <span>{formatDublinDateKey(date, { weekday: "short" })}</span><strong>{formatDublinDateKey(date, { day: "numeric" })}</strong><small>{date === todayDate ? "Today" : localCount ? `${localCount} local` : "No local"}</small>
              </button>;
            })}
          </div>
          <button className="calendar-step" type="button" onClick={() => moveCalendarDate(1)} aria-label="Next day"><ChevronRight size={16} /></button>
        </div>
        {initial ? <IntegrationCalendarContext overviewState={integrations} onOpen={() => setShowIntegrations(true)} startDate={calendarRangeStart} endDate={calendarRangeEnd} /> : null}
        {activeBlock ? <div className={`active-block lifeboard-active-block selected-run--${areaClass(activeBlock.area)}`}><div className="active-block-copy"><span className="live-label"><span /> Local block in this view</span><strong>{activeBlock.title}</strong><small>{eventTimeValue(activeBlock)} · {formatDuration(activeBlock.duration)} · {activeBlock.taskId ? "linked task" : "local block"}</small></div><button className="open-note" type="button" onClick={() => setSelectedEventId(activeBlock.id)}>Inspect <ChevronRight size={12} /></button></div> : null}
        <div className="schedule-list agenda-list" id="calendar-day-panel" role="tabpanel" aria-labelledby={`calendar-date-${selectedDate}`}>
          {calendarMode === "day" ? visibleCalendarEvents.map((event) => renderScheduleRow(event)) : calendarDateWindow(selectedDate, 0, 6).map((date) => {
            const dayEvents = visibleCalendarEvents.filter((event) => eventDateKey(event, todayDate) === date);
            if (!dayEvents.length) return null;
            return <section className="agenda-day-group" key={date}><button className="agenda-day-heading" type="button" onClick={() => selectCalendarDate(date)}><span>{date === todayDate ? "Today" : formatDublinDateKey(date, { weekday: "long" })}</span><strong>{formatDublinDateKey(date, { day: "numeric", month: "long" })}</strong><ChevronRight size={13} /></button>{dayEvents.map((event) => renderScheduleRow(event, true))}</section>;
          })}
          {!visibleCalendarEvents.length ? <div className="calendar-empty"><CalendarDays size={17} /><span>{calendarMode === "day" ? "No local blocks on this day." : "No local blocks in these seven days."}</span></div> : null}
        </div>
        {selectedEvent ? <div className="agenda-detail"><div className="agenda-detail-main"><i className={`area-dot area-dot--${areaClass(selectedEvent.area)}`} /><span><em className={`agenda-origin${selectedEvent.editable ? " agenda-origin--local" : " agenda-origin--imported"}${selectedEventTask?.completed ? " agenda-origin--done" : ""}`}>{selectedEventTask?.completed ? "Completed task" : selectedEvent.editable ? "Local block" : "Imported calendar"}</em><strong>{selectedEvent.title}</strong><small>{formatDublinDateKey(eventDateKey(selectedEvent, todayDate), { weekday: "short", day: "numeric", month: "short" })} · {eventTimeValue(selectedEvent)} · {formatDuration(selectedEvent.duration)} · {selectedEvent.area}</small></span></div><div className="agenda-detail-actions">{selectedEventTask ? <button className="mini-action" type="button" onClick={() => openTaskComposer(selectedEventTask)}><Pencil size={12} /> Edit linked task</button> : null}{selectedEvent.editable ? <button className="secondary-action" type="button" onClick={() => openEventComposer(selectedEvent)}><Pencil size={13} /> Edit</button> : <button className="secondary-action" type="button" onClick={() => openEventComposer()}><Plus size={13} /> Capture local</button>}</div></div> : null}
      </article>
    </section>;
  }

  function renderTasksView() {
    return <section className="workspace-page workspace-page--tasks" aria-labelledby="tasks-heading">
      <header className="workspace-heading"><div><p className="eyebrow">Your work</p><h1 id="tasks-heading">Tasks</h1><p>Everything stays visible here. Complete with the checkbox or open a task to change it.</p></div><button className="page-primary-action" type="button" onClick={() => openTaskComposer()}><Plus size={13} /> Add task</button></header>
      <article className="pane tasks-workspace">
        {initial && hermes.failed ? <p className="task-sync-note task-sync-note--warning"><Bot size={13} /> Hermes could not refresh. Fox Focus tasks are unaffected.</p> : initial && hermes.loading && !hermesBoard ? <p className="task-sync-note"><Bot size={13} /> Checking Hermes tasks…</p> : null}
        <nav className="task-category-strip" aria-label="Task categories">{taskCategoryOptions.map((category) => <button className={`task-category-tab${taskCategory === category.id ? " task-category-tab--active" : ""}`} type="button" aria-pressed={taskCategory === category.id} key={category.id} onClick={() => selectTaskCategory(category.id)}>{category.id !== allTaskCategories && category.id !== unclassifiedTaskCategory ? <i className={`area-dot area-dot--${areaClass(category.id)}`} /> : null}{category.label}</button>)}</nav>
        {hermesBoard && (taskCategory === allTaskCategories || taskCategory === unclassifiedTaskCategory) && taskFilter !== "all" && taskFilter !== "open" && taskFilter !== "done" && activeHermesTaskCount ? <p className="task-filter-boundary"><Bot size={13} /> Hermes tasks appear in All, Open, or Done because they do not have Fox Focus deadlines yet.</p> : null}
        <div className="task-compact-toolbar">
          <details className="task-filter-menu"><summary><SlidersHorizontal size={14} /><span>Filter &amp; sort</span>{activeTaskFilterCount ? <b aria-label={`${activeTaskFilterCount} active filters`}>{activeTaskFilterCount}</b> : null}<ChevronDown className="filter-chevron" size={13} /></summary><div className="task-filter-popover"><label><span>Show</span><select value={taskFilter} onChange={(event) => { const value = event.target.value; if (isOneOf(value, taskFilters)) selectTaskFilter(value); }}>{taskFilters.map((filter) => <option value={filter} key={filter}>{taskFilterLabel(filter)} · {taskFilterCounts[filter]}</option>)}</select></label>{hermesBoard ? <label><span>Source</span><select value={taskSource} onChange={(event) => { const value = event.target.value; if (isOneOf(value, taskSources)) setTaskSource(value); }}>{taskSourceOptions.map((source) => <option value={source.id} key={source.id} disabled={source.id === hermesTaskSource && source.count === 0}>{source.label} · {source.count}</option>)}</select></label> : null}<label><span>Order local tasks</span><select value={taskSort} disabled={isHermesOnlyScope} onChange={(event) => { const value = event.target.value; if (isOneOf(value, taskSorts)) setTaskSort(value); }}>{taskSorts.map((sort) => <option value={sort} key={sort}>{taskSortLabel(sort)}</option>)}</select></label>{isHermesOnlyScope ? <p>Hermes keeps source priority order.</p> : null}<button className="task-filter-reset" type="button" disabled={!activeTaskFilterCount} onClick={resetTaskFilters}><RotateCcw size={12} /> Reset</button></div></details>
          <span className="task-view-count" role="status" aria-live="polite">{shownTaskCount} task{shownTaskCount === 1 ? "" : "s"}</span>
          {initial && hermesBoard ? <button className="mini-action task-refresh" type="button" disabled={hermes.loading} onClick={hermes.refresh}>{hermes.loading ? "Refreshing…" : "Refresh Hermes"}</button> : null}
        </div>
        <p className="planned-note"><CalendarDays size={13} /> {plannedTaskCount ? `${plannedTaskCount} planned task${plannedTaskCount === 1 ? "" : "s"} on the local calendar.` : "Open a task to give it calendar time."}</p>
        <div className="task-browser-list task-browser-list--lifeboard" id="task-browser-panel" role="region" aria-label={`${taskFilterLabel(taskFilter)} tasks`}>
          {shownLocalTasks.map((task) => <TaskRow key={task.id} task={task} dueLabel={taskDeadlineLabel(task, todayDate)} latestAction={latestActionByTask.get(task.id)} plannedDate={plannedDateForTask(task)} onToggle={toggleTask} onEdit={openTaskComposer} />)}
          {shownHermesTasks.map((task) => <HermesTaskRow key={task.id} task={task} busy={adoptingHermesId === task.id} onAdopt={(candidate) => void previewHermesAdoption(candidate)} />)}
          {!shownTaskCount ? <div className="empty-state"><ListTodo size={20} /><strong>{taskFilter === "done" ? "No completed tasks yet" : "Nothing in this view"}</strong><p>{taskFilter === "done" ? "Completed tasks stay here for review." : "Change the category or filters, or add a task."}</p></div> : null}
        </div>
      </article>
    </section>;
  }

  function renderReviewView() {
    return <section className="workspace-page workspace-page--review" aria-labelledby="review-heading">
      <header className="workspace-heading"><div><p className="eyebrow">One decision at a time</p><h1 id="review-heading">Inbox</h1><p>Turn a proposal into a task, a calendar block, a draft, or nothing.</p></div><span className="review-page-count">{reviewCount} open</span></header>
      <article className="pane review-workspace">
        <div className="review-workbench">
          <div className="inbox-list inbox-list--lifeboard">
            {reviewItems.map((item) => <div className={`inbox-list-row${item.status === "handled" ? " inbox-list-row--handled" : ""}`} key={item.id}><button className={`inbox-list-item${selectedInbox?.id === item.id ? " inbox-list-item--selected" : ""}`} type="button" aria-pressed={selectedInbox?.id === item.id} onClick={() => selectInbox(item)}><span className={`calendar-event-mark calendar-event-mark--${areaClass(item.accent)}`} /><span><strong>{item.title}</strong><small>{item.source}</small></span><span className={`review-status review-status--${item.status}`}>{formatStatus(item.status)}</span></button><button className={`inbox-complete${item.status === "handled" ? " inbox-complete--done" : ""}`} type="button" onClick={() => toggleInboxHandled(item)} aria-label={`${item.status === "handled" ? "Return" : "Mark"} ${item.title} ${item.status === "handled" ? "to review" : "as handled"}`}>{item.status === "handled" ? <Check size={13} /> : <Circle size={15} />}</button></div>)}
            {!reviewItems.length ? <p className="empty-line">Inbox is clear.</p> : null}
          </div>
          {selectedInbox ? <div className="review-detail"><div className="review-queue-nav"><span>{selectedInboxIndex + 1} of {reviewItems.length}</span><div><button type="button" onClick={() => moveInboxSelection(-1)} disabled={selectedInboxIndex <= 0} aria-label="Previous review item"><ChevronLeft size={14} /></button><button type="button" onClick={() => moveInboxSelection(1)} disabled={selectedInboxIndex >= reviewItems.length - 1} aria-label="Next review item"><ChevronRight size={14} /></button></div></div><div className="review-item-meta"><i className={`area-dot area-dot--${areaClass(selectedInbox.accent)}`} /><span>{selectedInbox.actor}</span><span className={`review-status review-status--${selectedInbox.status}`}>{formatStatus(selectedInbox.status)}</span></div><h3>{selectedInbox.title}</h3><p>{selectedInbox.summary}</p><div className="evidence-card evidence-card--compact"><span>Source evidence</span><strong>{selectedInbox.source}</strong><p>No connected email body is available in this review surface.</p></div>{selectedInbox.draft ? <div className="saved-draft"><span>Saved draft · not sent</span><pre>{selectedInbox.draft}</pre></div> : null}{selectedInbox.moreWork ? <div className="saved-request"><span>Feedback note · not delivered</span><p>{selectedInbox.moreWork}</p></div> : null}<div className="review-next-step"><span>Choose the next step</span><p>Local outcomes happen now. Nothing is sent back to its source.</p></div>{selectedInbox.status === "handled" ? <div className="review-detail-actions"><button className="secondary-action" type="button" onClick={() => toggleInboxHandled(selectedInbox)}><RotateCcw size={13} /> Return to review</button></div> : <div className="review-detail-actions"><button className="page-primary-action" type="button" onClick={() => acceptInbox("task")}><ListTodo size={13} /> Create task</button><button className="secondary-action" type="button" onClick={() => openDraft(selectedInbox)}><Pencil size={13} /> Draft reply</button><button className="secondary-action" type="button" onClick={() => acceptInbox("event")}><CalendarDays size={13} /> Schedule block</button><button className="secondary-action" type="button" onClick={() => toggleInboxHandled(selectedInbox)}><CheckCircle2 size={13} /> No action</button></div>}<div className="agent-request agent-request--compact"><label htmlFor="more-work">Feedback note</label><textarea id="more-work" value={agentRequest} onChange={(event) => setAgentRequest(event.target.value)} placeholder="What should Hermes check or change later?" /><button className="quiet-panel-action" type="button" onClick={saveMoreWork}>Save note</button></div></div> : null}
        </div>
      </article>
    </section>;
  }

  function renderWorkspaceView() {
    if (activeSection === "agenda") return renderCalendarView();
    if (activeSection === "tasks") return renderTasksView();
    if (activeSection === "review") return renderReviewView();
    return renderTodayView();
  }

  const taskModal = modal?.kind === "task" ? modal : null;
  const eventModal = modal?.kind === "event" ? modal : null;
  const draftModal = modal?.kind === "draft" ? modal : null;
  const editingHermesTask = hermesTasks.find(task => task.id === editingHermesTaskId) ?? null;
  const modalTask = taskModal?.taskId ? data.tasks.find((task) => task.id === taskModal.taskId) : null;
  const modalTaskAction = modalTask ? latestActionByTask.get(modalTask.id) : undefined;
  const modalTaskGoogleLink = modalTask?.externalLinks?.find(link => link.provider === "google_tasks");
  const modalInbox = taskModal?.inboxId
    ? data.inboxItems.find((item) => item.id === taskModal.inboxId)
    : eventModal?.inboxId
      ? data.inboxItems.find((item) => item.id === eventModal.inboxId)
      : null;
  const actionBeforeGoogle = taskActionPreview && isRecord(taskActionPreview.before.google) ? taskActionPreview.before.google : null;
  const actionAfterGoogle = taskActionPreview && isRecord(taskActionPreview.after.google) ? taskActionPreview.after.google : null;
  const actionBeforeFox = taskActionPreview && isRecord(taskActionPreview.before.foxFocus) ? taskActionPreview.before.foxFocus : null;
  const actionAfterFox = taskActionPreview && isRecord(taskActionPreview.after.foxFocus) ? taskActionPreview.after.foxFocus : null;

  return (
    <div className="control-room">
      <header className="command-bar" aria-hidden={isOverlayOpen}>
        <div className="brand-lockup">
          <span className="fox-mark" aria-hidden="true"><span /><span /></span>
          <div><strong>Fox Focus</strong></div>
        </div>
        <nav className="workspace-nav" aria-label="Workspace views">
          <button className={activeSection === "today" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-current={activeSection === "today" ? "page" : undefined} onClick={() => openWorkspaceView("today")}><Clock3 size={14} /><span>Today</span></button>
          <button className={activeSection === "agenda" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-current={activeSection === "agenda" ? "page" : undefined} onClick={() => openWorkspaceView("agenda")}><CalendarDays size={14} /><span>Calendar</span></button>
          <button className={activeSection === "tasks" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-current={activeSection === "tasks" ? "page" : undefined} onClick={() => openWorkspaceView("tasks")}><ListTodo size={14} /><span>Tasks</span></button>
          <button className={activeSection === "review" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-current={activeSection === "review" ? "page" : undefined} onClick={() => openWorkspaceView("review")}><Inbox size={14} /><span>Inbox</span>{reviewCount ? <b>{reviewCount}</b> : null}</button>
        </nav>
        <div className="command-actions">
          <button className="quiet-action notification-action" type="button" onClick={() => setShowReminderTray(true)} aria-label={`Open ${reminderCount} reminders`}><Bell size={15} /><b>{reminderCount}</b><span>Reminders</span></button>
          <button className="quiet-action theme-action" type="button" onClick={toggleTheme} aria-label={`Switch to ${themeTarget} theme`} title={`Switch to ${themeTarget} theme`}>{resolvedTheme === "black" ? <Sun size={15} /> : <Moon size={15} />}</button>
          <button className="capture-button" type="button" onClick={() => openTaskComposer()}><Plus size={15} /><span>Add task</span></button>
        </div>
      </header>

      {saveError || statusMessage || completionUndo || reviewUndo ? <div className={`status-footer${saveError ? " status-footer--error" : ""}`} role={saveError ? "alert" : "status"} aria-live={saveError ? "assertive" : "polite"} aria-hidden={isOverlayOpen}>
        <span />
        <p>{saveError ?? statusMessage}</p>
        {completionUndo ? <button className="status-undo" type="button" onClick={undoTaskCompletion}>Undo</button> : reviewUndo ? <button className="status-undo" type="button" onClick={undoInboxChange}>Undo</button> : null}
      </div> : null}
      <main aria-hidden={isOverlayOpen}>{renderWorkspaceView()}</main>

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
              <label className="field"><span>Area</span><select autoFocus value={hermesTaskDraft.area} onChange={(event) => { const value = event.target.value; if (isOneOf(value, areas)) setHermesTaskDraft(current => ({ ...current, area: value })); }}>{areas.map(area => <option value={area} key={area}>{area}</option>)}</select></label>
              <label className="field"><span>Deadline</span><select value={hermesTaskDraft.due} onChange={(event) => setHermesTaskDraft(current => ({ ...current, due: event.target.value }))}><option value="Today">Today</option><option value="Tomorrow">Tomorrow</option><option value="Friday">Friday</option><option value="Waiting">Waiting</option><option value="No deadline">No deadline</option></select></label>
              <label className="field"><span>Duration</span><select value={hermesTaskDraft.duration} onChange={(event) => setHermesTaskDraft(current => ({ ...current, duration: event.target.value }))}><option value="5 min">5 min</option><option value="10 min">10 min</option><option value="20 min">20 min</option><option value="30 min">30 min</option><option value="40 min">40 min</option><option value="45 min">45 min</option><option value="60 min">60 min</option></select></label>
              <label className="field"><span>Task state</span><select value={hermesTaskDraft.state} onChange={(event) => { const value = event.target.value; if (value === "up-next" || value === "waiting") setHermesTaskDraft(current => ({ ...current, state: value })); }}><option value="up-next">Up next</option><option value="waiting">Waiting</option></select></label>
              <label className="field"><span>Planned day</span><input type="date" value={hermesTaskDraft.scheduledDate} onChange={(event) => setHermesTaskDraft(current => ({ ...current, scheduledDate: event.target.value }))} /></label>
              <label className="field"><span>Planned time</span><input type="time" value={hermesTaskDraft.scheduledTime} onChange={(event) => setHermesTaskDraft(current => ({ ...current, scheduledTime: event.target.value }))} /></label>
              <label className="field field--full"><span>Reminder</span><select value={hermesTaskDraft.reminderMode} onChange={(event) => { const value = event.target.value; if (isOneOf(value, reminderModes)) setHermesTaskDraft(current => ({ ...current, reminderMode: value })); }}><option value="none">No reminder</option><option value="one-hour">1 hour before</option><option value="morning">09:00 on the day</option></select></label>
            </div>
            <div className="editor-footer"><span>{editingHermesTask.sourceDueOn ? `Google due date: ${formatDublinDateKey(editingHermesTask.sourceDueOn, { day: "numeric", month: "short" })}.` : "Planning and reminders are local to Fox Focus."}</span><div><button className="secondary-action" type="button" onClick={() => setEditingHermesTaskId(null)}>Cancel</button><button className="submit-button" type="submit"><Check size={14} /> Save details</button></div></div>
          </form>
        </DialogFrame>
      ) : null}

      {taskModal ? (
        <DialogFrame title={taskModal.taskId ? "Edit task" : "Add task"} onClose={() => setModal(null)}>
          <form onSubmit={saveTask}>
            <div className="editor-heading">
              <div className="composer-icon"><ListTodo size={17} /></div>
              <div><p className="eyebrow">{taskModal.taskId ? "Local task" : "Capture task"}</p><h2>{taskModal.taskId ? "Edit task" : "Add a task"}</h2></div>
              <button className="close-composer" type="button" onClick={() => setModal(null)} aria-label="Close task editor"><X size={17} /></button>
            </div>
            {modalError ? <p className="editor-error" role="alert">{modalError}</p> : null}
            {modalInbox ? <div className="source-notice"><Inbox size={14} /> Accepting from <strong>{modalInbox.source}</strong>. It will stay on the created task.</div> : null}
            {modalTaskGoogleLink ? <div className="source-notice"><Link2 size={14} /> Fox Focus owns this task. Its existing Google task can only be completed or reopened after a preview.</div> : modalTask?.origin === "migration" ? <div className="source-notice"><Bot size={14} /> Adopted from {modalTask.source ?? "a legacy source"}. The source link is read-only.</div> : null}
            {modalTaskAction && modalTaskAction.status !== "succeeded" ? <div className={`task-action-notice task-action-notice--${modalTaskAction.status}`}><strong>{actionStateLabel(modalTaskAction)}</strong><span>{modalTaskAction.lastError ?? "The approved Google update is still being checked."}</span></div> : null}
            <div className="editor-grid editor-grid--quick-task">
              <label className="field field--full"><span>Task</span><input autoFocus required value={taskDraft.title} onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))} placeholder="What needs doing?" /></label>
              <label className="field field--full"><span>Deadline</span><input type="date" value={taskDraft.deadlineDate} onChange={(event) => setTaskDraft((current) => ({ ...current, deadlineDate: event.target.value, due: event.target.value ? deadlineDateLabel(event.target.value, todayDate) : "No deadline" }))} /></label>
            </div>
            <button className="task-details-toggle" type="button" aria-expanded={showTaskDetails} aria-controls="task-more-options" onClick={() => setShowTaskDetails((current) => !current)}><SlidersHorizontal size={13} /><span>{showTaskDetails ? "Hide options" : "More options"}</span><ChevronDown size={13} /></button>
            {showTaskDetails ? <div className="editor-grid editor-grid--task-details" id="task-more-options">
              <label className="field"><span>Area</span><select value={taskDraft.area} onChange={(event) => { const value = event.target.value; if (isOneOf(value, areas)) setTaskDraft((current) => ({ ...current, area: value })); }}><option value="University">University</option><option value="Work">Work</option><option value="Personal">Personal</option><option value="Health">Health</option><option value="Admin">Admin</option></select></label>
              <label className="field"><span>Priority</span><select value={taskDraft.priority} onChange={(event) => { const value = event.target.value; if (isOneOf(value, priorities)) setTaskDraft((current) => ({ ...current, priority: value })); }}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
              <label className="field"><span>Duration</span><select value={taskDraft.duration} onChange={(event) => setTaskDraft((current) => ({ ...current, duration: event.target.value }))}><option value="5 min">5 min</option><option value="10 min">10 min</option><option value="20 min">20 min</option><option value="30 min">30 min</option><option value="40 min">40 min</option><option value="45 min">45 min</option><option value="60 min">60 min</option></select></label>
              <label className="field"><span>Task state</span><select value={taskDraft.state} onChange={(event) => { const value = event.target.value; if (isOneOf(value, activeTaskStates)) setTaskDraft((current) => ({ ...current, state: value })); }}><option value="up-next">Up next</option><option value="scheduled">Scheduled</option><option value="waiting">Waiting</option></select></label>
              <label className="field"><span>Planned day</span><input type="date" value={taskDraft.scheduledDate} onChange={(event) => setTaskDraft((current) => ({ ...current, scheduledDate: event.target.value }))} /></label>
              <label className="field"><span>Planned time</span><input type="time" value={taskDraft.scheduledTime} onChange={(event) => setTaskDraft((current) => ({ ...current, scheduledTime: event.target.value }))} /></label>
              <label className="field field--full"><span>Reminder</span><select value={taskDraft.reminderMode} onChange={(event) => { const value = event.target.value; if (isOneOf(value, reminderModes)) setTaskDraft((current) => ({ ...current, reminderMode: value })); }}><option value="none">No reminder</option><option value="one-hour">1 hour before</option><option value="morning">09:00 on the day</option></select></label>
            </div> : null}
            <div className="editor-footer"><span>{taskDraft.scheduledTime ? "This will create or update a local timetable block." : "Leave plan blank to keep it unscheduled."}</span><div>{modalTaskAction?.status === "failed" && modalTaskAction.result?.retryable === true ? <button className="secondary-action" type="button" disabled={taskActionBusy} onClick={() => { setModal(null); void executeTaskAction(modalTaskAction, true); }}><RotateCcw size={13} /> Retry Google</button> : null}{modalTaskAction?.status === "running" ? <button className="secondary-action" type="button" disabled={taskActionBusy} onClick={() => { setModal(null); void executeTaskAction(modalTaskAction, true); }}><RotateCcw size={13} /> Check Google</button> : null}{modalTask && modalTaskGoogleLink && (modalTaskAction?.status === "failed" || modalTaskAction?.status === "conflict") ? <button className="secondary-action" type="button" disabled={taskActionBusy} onClick={() => { setModal(null); void previewLinkedTaskAction(modalTask, modalTask.completed ? "completed" : "open"); }}><Link2 size={13} /> Send current state</button> : null}{modalTaskAction?.status === "conflict" ? <button className="secondary-action" type="button" onClick={() => { setModal(null); setShowIntegrations(true); }}><RefreshCw size={13} /> Refresh Google</button> : null}{modalTask?.linkedEventId ? <button className="secondary-action" type="button" onClick={() => { setModal(null); openTaskSchedule(modalTask); }}><CalendarDays size={13} /> View calendar</button> : null}<button className="secondary-action" type="button" onClick={() => setModal(null)}>Cancel</button><button className="submit-button" type="submit"><Check size={14} /> Save task</button></div></div>
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
              <label className="field field--full"><span>Block title</span><input autoFocus value={eventDraft.title} onChange={(event) => setEventDraft((current) => ({ ...current, title: event.target.value }))} placeholder="What belongs in the timetable?" /></label>
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
          <label className="field"><span>Draft reply</span><textarea autoFocus value={draftText} onChange={(event) => setDraftText(event.target.value)} /></label>
          <div className="editor-footer"><span>Source remains attached for review.</span><div><button className="secondary-action" type="button" onClick={() => setModal(null)}>Keep reviewing</button><button className="submit-button" type="button" onClick={saveDraft}><Check size={14} /> Save draft</button></div></div>
        </DialogFrame>
      ) : null}

      {showReminderTray ? (
        <DialogFrame title="Reminders" onClose={() => setShowReminderTray(false)} className="editor-dialog--tray">
          <div className="editor-heading"><div className="composer-icon"><Bell size={17} /></div><div><p className="eyebrow">On this device</p><h2>Reminders</h2></div><button className="close-composer" type="button" onClick={() => setShowReminderTray(false)} aria-label="Close reminders"><X size={17} /></button></div>
          <div className="reminder-list">
            {allReminders.map((reminder) => <div className="reminder-row" key={reminder.id}><Bell size={14} /><span><strong>{reminder.title}</strong><small>{reminder.when} · {reminder.targetId.startsWith("hermes:") ? "Hermes task · " : ""}{reminder.firedAt ? "fired" : reminder.fireAt ? "scheduled" : "needs a planned time"}</small></span></div>)}
            {!allReminders.length ? <p className="empty-line">No local reminders yet.</p> : null}
          </div>
          <div className="editor-footer"><span>{pushSubscribed ? "Notifications can arrive when Fox Focus is closed." : "In-tab reminders still work while Fox Focus is open."}</span><div className="reminder-footer-actions">{notificationStatus ? <p className="notification-status">{notificationStatus}</p> : null}{pushSubscribed ? <button className="mini-action" type="button" onClick={() => void turnOffDeviceNotifications()}>Turn off</button> : <button className="secondary-action" type="button" disabled={notificationPermission === "denied" || notificationPermission === "unsupported"} onClick={() => void requestNotificationPermission()}>Enable device notifications</button>}<button className="submit-button" type="button" onClick={testReminder}><Bell size={14} /> Preview first reminder</button></div></div>
        </DialogFrame>
      ) : null}

      {activeReminder ? (
        <DialogFrame title="Reminder" onClose={() => setActiveReminderId(null)} className="editor-dialog--alert">
          <div className="reminder-alert-icon"><Bell size={22} /></div>
          <p className="eyebrow">Reminder</p>
          <h2>{activeReminder.title}</h2>
          <p>{activeReminder.when}.</p>
          <div className="alert-actions"><button className="secondary-action" type="button" onClick={() => setActiveReminderId(null)}>Dismiss</button>{activeReminder.targetId.startsWith("hermes:") ? null : <button className="submit-button" type="button" onClick={snoozeReminder}>Snooze 30 min</button>}</div>
        </DialogFrame>
      ) : null}

      {taskActionPreview ? (
        <DialogFrame title="Confirm linked task change" onClose={() => { if (!taskActionBusy) setTaskActionPreview(null); }} className="editor-dialog--alert">
          <div className="editor-heading"><div className="composer-icon"><Link2 size={17} /></div><div><p className="eyebrow">Exact Google change</p><h2>{taskActionPreview.desiredState === "completed" ? "Complete linked task?" : "Reopen linked task?"}</h2></div><button className="close-composer" type="button" disabled={taskActionBusy} onClick={() => setTaskActionPreview(null)} aria-label="Cancel linked task change"><X size={17} /></button></div>
          <div className="task-action-preview">
            <div><span>Before</span><strong>{String(actionBeforeGoogle?.title ?? actionBeforeFox?.title ?? "Linked task")}</strong><small>Fox Focus: {String(actionBeforeFox?.state ?? "unknown")} · Google: {String(actionBeforeGoogle?.state ?? "unknown")}</small><small>{String(actionBeforeGoogle?.connection ?? "Current Google connection")} · {String(actionBeforeGoogle?.list ?? "task list")}</small><small>Task {String(actionBeforeGoogle?.taskId ?? "unknown")} · ETag {String(actionBeforeGoogle?.version ?? "unknown")}</small></div>
            <ChevronRight size={16} aria-hidden="true" />
            <div><span>After</span><strong>{String(actionAfterGoogle?.title ?? actionAfterFox?.title ?? "Linked task")}</strong><small>Fox Focus: {String(actionAfterFox?.state ?? taskActionPreview.desiredState)} · Google: {String(actionAfterGoogle?.state ?? "unknown")}</small><small>Same connection, list, task ID, and ETag shown at left.</small></div>
          </div>
          <p className="draft-context">Fox Focus changes first and keeps that result even if Google is unavailable. This approval cannot create, delete, or clear Google tasks.</p>
          <div className="alert-actions"><button className="secondary-action" type="button" disabled={taskActionBusy} onClick={() => setTaskActionPreview(null)}>Cancel</button><button className="submit-button" type="button" disabled={taskActionBusy} onClick={() => void executeTaskAction(taskActionPreview, false)}>{taskActionBusy ? "Confirming…" : taskActionPreview.desiredState === "completed" ? "Complete both" : "Reopen both"}</button></div>
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
