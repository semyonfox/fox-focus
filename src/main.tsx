import "@fontsource-variable/instrument-sans";
import {
  Bell,
  Bot,
  CalendarDays,
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
import { type HermesTask } from "./hermes-model.ts";
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

function taskSortLabel(sort: TaskSort): string {
  return sort === "created" ? "Created newest" : "Due first";
}

function updateReminder(
  reminders: Reminder[],
  targetId: string,
  targetType: Reminder["targetType"],
  title: string,
  mode: ReminderMode,
): Reminder[] {
  const withoutTarget = reminders.filter(
    (reminder) => !(reminder.targetId === targetId && reminder.targetType === targetType),
  );

  if (mode === "none") return withoutTarget;

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

function TaskRow({
  task,
  onToggle,
  onEdit,
  onSchedule,
  plannedDate,
  compact = false,
}: {
  task: Task;
  onToggle: (task: Task) => void;
  onEdit: (task: Task) => void;
  onSchedule: (task: Task) => void;
  plannedDate?: string;
  compact?: boolean;
}) {
  const planned = task.scheduledTime && !task.completed
    ? `${plannedDate ? `${formatDublinDateKey(plannedDate, { weekday: "short", day: "numeric" })} ` : ""}${task.scheduledTime}`
    : null;

  return (
    <article className={`task-row${compact ? " task-row--compact" : ""}${task.completed ? " task-row--done" : ""}`}>
      <button
        className={`task-check task-check--${areaClass(task.area)}${task.completed ? " task-check--done" : ""}`}
        type="button"
        onClick={() => onToggle(task)}
        aria-label={`${task.completed ? "Reopen" : "Complete"} ${task.title}`}
      >
        {task.completed ? <Check size={14} strokeWidth={3} /> : <Circle size={16} strokeWidth={2} />}
      </button>
      <div className="task-copy">
        <strong className={task.completed ? "task-title--done" : undefined}>{task.title}</strong>
        <span>
          <i className={`area-dot area-dot--${areaClass(task.area)}`} />
          {task.area} · {task.duration}
          {planned ? <em className="task-planned"><CalendarDays size={11} /> {planned}</em> : null}
          {task.origin === "inbox" ? <em className="source-chip" title={task.source} aria-label={`From ${task.source ?? "Inbox"}`}>{task.source?.replace(/^Inbox · /, "") ?? "Inbox"}</em> : null}
        </span>
      </div>
      <time>{task.due}</time>
      <div className="task-row-actions">
        <button type="button" className="mini-action" onClick={() => onEdit(task)}>
          Edit
        </button>
        <button type="button" className="mini-action" onClick={() => onSchedule(task)}>
          {task.scheduledTime ? "Calendar" : "Schedule"}
        </button>
      </div>
    </article>
  );
}

function HermesTaskRow({ task }: { task: HermesTask }) {
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
    </article>
  );
}

function ImportedTaskRow({ task }: { task: ImportedRecord }) {
  const completed = task.status === "completed";
  const status = completed
    ? "Completed"
    : task.dueOn ? formatDublinDateKey(task.dueOn, { weekday: "short", day: "numeric", month: "short" }) : "";

  return (
    <article className={`task-row imported-task-row${completed ? " imported-task-row--done" : ""}`}>
      <div className="task-copy">
        <strong className={completed ? "task-title--done" : undefined}>{task.title}</strong>
        <span><em className="source-chip">{providerLabel(task.provider)} · {task.containerName}</em></span>
      </div>
      <time dateTime={task.dueOn ?? undefined}>{status}</time>
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

const allTaskSources = "__all_task_sources__";
const localTaskSource = "__local_task_source__";
const allTaskCategories = "__all_task_categories__";
const unclassifiedTaskCategory = "__unclassified_task_category__";

type TaskCategory = typeof allTaskCategories | typeof unclassifiedTaskCategory | Area;

function hermesSourceId(source: string): string {
  return `hermes:${source}`;
}

function importedSourceId(provider: string, name: string): string {
  return `imported:${provider}:${name}`;
}

function App({ initial }: { initial?: ServerSnapshot }) {
  const hermes = useHermesFeed(Boolean(initial));
  const integrations = useOverview(Boolean(initial));
  const [data, setData] = useState<PrototypeData>(() => initial?.data ?? loadData());
  const revision = useRef(initial?.revision ?? 0);
  const lastSaved = useRef(data);
  const saveQueue = useRef(Promise.resolve());
  const saveFailed = useRef(false);
  const [activeSection, setActiveSection] = useState<SectionAnchor>("today");
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
  const [taskSource, setTaskSource] = useState(allTaskSources);
  const [taskCategory, setTaskCategory] = useState<TaskCategory>(allTaskCategories);
  const [taskSort, setTaskSort] = useState<TaskSort>("due");
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("day");
  const [selectedDate, setSelectedDate] = useState(() => dublinDateKey(new Date()));
  const [calendarAnchor, setCalendarAnchor] = useState(() => dublinDateKey(new Date()));
  const [showTaskDetails, setShowTaskDetails] = useState(false);
  const [showReminderTray, setShowReminderTray] = useState(false);
  const [activeReminderId, setActiveReminderId] = useState<string | null>(null);
  const [completionUndo, setCompletionUndo] = useState<CompletionUndo | null>(null);
  const [reviewUndo, setReviewUndo] = useState<ReviewUndo | null>(null);
  const [showIntegrations, setShowIntegrations] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("integration"));
  const [agentRequest, setAgentRequest] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [modalError, setModalError] = useState("");
  const focusBeforeOverlay = useRef<HTMLElement | null>(null);
  const calendarTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => setSystemTheme(mediaQuery.matches ? "black" : "light");
    syncSystemTheme();
    mediaQuery.addEventListener("change", syncSystemTheme);
    return () => mediaQuery.removeEventListener("change", syncSystemTheme);
  }, []);

  const isOverlayOpen = Boolean(modal || showReminderTray || activeReminderId || showIntegrations);

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
    const nextSnoozedReminder = [...data.reminders]
      .filter((reminder) => reminder.state === "snoozed" && typeof reminder.snoozedUntil === "number")
      .sort((first, second) => (first.snoozedUntil ?? 0) - (second.snoozedUntil ?? 0))[0];

    if (!nextSnoozedReminder?.snoozedUntil) return;

    const delay = Math.max(0, nextSnoozedReminder.snoozedUntil - Date.now());
    const timeout = window.setTimeout(() => {
      setData((current) => ({
        ...current,
        reminders: current.reminders.map((reminder) =>
          reminder.id === nextSnoozedReminder.id
            ? { ...reminder, state: "scheduled", when: formatReminderMode(reminder.mode), snoozedUntil: undefined }
            : reminder,
        ),
      }));
      setActiveReminderId(nextSnoozedReminder.id);
    }, delay);

    return () => window.clearTimeout(timeout);
  }, [data.reminders]);

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
      setShowReminderTray(false);
      setActiveReminderId(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
  const sortedEvents = useMemo(
    () => [...data.events].sort((first, second) => compareCalendarEvents(first, second, todayDate)),
    [data.events, todayDate],
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
  const reviewItems = useMemo(
    () => [...data.inboxItems].sort((first, second) => Number(first.status === "handled") - Number(second.status === "handled")),
    [data.inboxItems],
  );
  const selectedInbox = reviewItems.find((item) => item.id === selectedInboxId) ?? reviewItems[0] ?? null;
  const selectedInboxIndex = selectedInbox ? reviewItems.findIndex((item) => item.id === selectedInbox.id) : -1;
  const activeTasks = data.tasks.filter((task) => !task.completed);
  const activeReminder = data.reminders.find((reminder) => reminder.id === activeReminderId) ?? null;
  const hermesBoard = hermes.feed?.state === "connected" ? hermes.feed.board : null;
  const hermesTasks = hermesBoard?.tasks ?? [];
  const hermesSources = hermesBoard?.sources ?? [];
  const importedTasks = integrations.overview?.records.filter((record) => record.kind === "task") ?? [];
  const importedLists = [...importedTasks.reduce((lists, task) => {
    const id = importedSourceId(task.provider, task.containerName);
    if (!lists.has(id)) lists.set(id, { id, provider: task.provider, name: task.containerName });
    return lists;
  }, new Map<string, { id: string; provider: ImportedRecord["provider"]; name: string }>()).values()];
  const categoryLocalTasks = taskCategory === allTaskCategories
    ? data.tasks
    : taskCategory === unclassifiedTaskCategory
      ? []
      : data.tasks.filter((task) => task.area === taskCategory);
  const categoryHermesTasks = taskCategory === allTaskCategories || taskCategory === unclassifiedTaskCategory
    ? hermesTasks
    : [];
  const categoryImportedTasks = taskCategory === allTaskCategories
    ? importedTasks
    : taskCategory === unclassifiedTaskCategory
      ? []
      : importedTasks.filter((task) => areaForList(data.listAreas, task.provider, task.containerName) === taskCategory);
  const taskCategoryOptions: Array<{ id: TaskCategory; label: string }> = [
    { id: allTaskCategories, label: "All" },
    ...areas.map((area) => ({ id: area, label: area })),
  ];
  if (hermesBoard) taskCategoryOptions.push({ id: unclassifiedTaskCategory, label: "Uncategorised" });

  const visibleTasks = useMemo(() => {
    const filtered = categoryLocalTasks.filter((task) => {
      if (taskFilter === "all") return true;
      if (taskFilter === "due-today") return task.due === "Today" && !task.completed;
      if (taskFilter === "planned") return Boolean(task.scheduledTime) && !task.completed;
      if (taskFilter === "waiting") return task.state === "waiting" && !task.completed;
      if (taskFilter === "done") return task.completed;
      return !task.completed;
    });

    return [...filtered].sort((first, second) => {
      if (taskFilter !== "done" && first.completed !== second.completed) return Number(first.completed) - Number(second.completed);
      return taskSort === "created" ? compareTasksByCreatedAt(first, second) : compareTasksByDue(first, second);
    });
  }, [categoryLocalTasks, taskFilter, taskSort]);

  const visibleHermesTasks = useMemo(() => {
    if (taskFilter === "done") return categoryHermesTasks.filter((task) => task.status === "done");
    if (taskFilter === "open") return categoryHermesTasks.filter((task) => task.status !== "done");
    return taskFilter === "all"
      ? [...categoryHermesTasks].sort((first, second) => Number(first.status === "done") - Number(second.status === "done"))
      : [];
  }, [categoryHermesTasks, taskFilter]);

  const visibleImportedTasks = useMemo(() => {
    if (taskFilter === "done") return categoryImportedTasks.filter((task) => task.status === "completed");
    if (taskFilter === "open") return categoryImportedTasks.filter((task) => task.status !== "completed");
    if (taskFilter === "due-today") return categoryImportedTasks.filter((task) => task.status !== "completed" && task.dueOn === todayDate);
    return taskFilter === "all"
      ? [...categoryImportedTasks].sort((first, second) => Number(first.status === "completed") - Number(second.status === "completed"))
      : [];
  }, [categoryImportedTasks, taskFilter, todayDate]);

  const taskSourceOptions = [
    { id: allTaskSources, label: "Everything", count: visibleTasks.length + visibleHermesTasks.length + visibleImportedTasks.length },
    { id: localTaskSource, label: "Local", count: visibleTasks.length },
    ...hermesSources.map((source) => ({
      id: hermesSourceId(source),
      label: source,
      count: visibleHermesTasks.filter((task) => task.source === source).length,
    })),
    ...importedLists.map((list) => ({
      id: list.id,
      label: `${providerLabel(list.provider)} · ${list.name}`,
      count: visibleImportedTasks.filter((task) => importedSourceId(task.provider, task.containerName) === list.id).length,
    })),
  ];
  const isHermesOnlyScope = taskSource.startsWith("hermes:");

  const shownLocalTasks = taskSource === allTaskSources || taskSource === localTaskSource ? visibleTasks : [];
  const shownHermesTasks = taskSource === allTaskSources
    ? visibleHermesTasks
    : taskSource.startsWith("hermes:")
      ? visibleHermesTasks.filter((task) => task.source === taskSource.slice("hermes:".length))
      : [];
  const shownImportedTasks = taskSource === allTaskSources
    ? visibleImportedTasks
    : taskSource.startsWith("imported:")
      ? visibleImportedTasks.filter((task) => importedSourceId(task.provider, task.containerName) === taskSource)
      : [];

  const reminderCount = data.reminders.length;
  const reviewCount = data.inboxItems.filter((item) => item.status !== "handled").length;
  const plannedTaskCount = activeTasks.filter((task) => Boolean(task.linkedEventId && eventById.has(task.linkedEventId))).length;
  const activeHermesTaskCount = hermesTasks.filter((task) => task.status !== "done").length;
  const activeImportedTaskCount = importedTasks.filter((task) => task.status !== "completed").length;
  const taskFilterCounts: Record<TaskFilter, number> = {
    all: categoryLocalTasks.length + categoryHermesTasks.length + categoryImportedTasks.length,
    open: categoryLocalTasks.filter((task) => !task.completed).length + categoryHermesTasks.filter((task) => task.status !== "done").length + categoryImportedTasks.filter((task) => task.status !== "completed").length,
    "due-today": categoryLocalTasks.filter((task) => task.due === "Today" && !task.completed).length + categoryImportedTasks.filter((task) => task.status !== "completed" && task.dueOn === todayDate).length,
    planned: categoryLocalTasks.filter((task) => Boolean(task.scheduledTime) && !task.completed).length,
    waiting: categoryLocalTasks.filter((task) => task.state === "waiting" && !task.completed).length,
    done: categoryLocalTasks.filter((task) => task.completed).length + categoryHermesTasks.filter((task) => task.status === "done").length + categoryImportedTasks.filter((task) => task.status === "completed").length,
  };
  const shownTaskCount = shownLocalTasks.length + shownHermesTasks.length + shownImportedTasks.length;
  const openTaskCount = activeTasks.length + activeHermesTaskCount + activeImportedTaskCount;

  useEffect(() => {
    if (!taskSource.startsWith("hermes:")) return;
    const source = taskSource.slice("hermes:".length);
    if (!hermesSources.includes(source)) setTaskSource(allTaskSources);
  }, [hermesSources, taskSource]);

  useEffect(() => {
    if (!taskSource.startsWith("imported:")) return;
    if (!importedLists.some((list) => list.id === taskSource)) setTaskSource(allTaskSources);
  }, [importedLists, taskSource]);

  useEffect(() => {
    if ((taskFilter === "all" || taskFilter === "open" || taskFilter === "done" || taskFilter === "due-today") || (!taskSource.startsWith("hermes:") && !taskSource.startsWith("imported:"))) return;
    setTaskSource(allTaskSources);
  }, [taskFilter, taskSource]);

  useEffect(() => {
    setAgentRequest(selectedInbox?.moreWork ?? "");
  }, [selectedInbox?.id, selectedInbox?.moreWork]);

  function scrollToSection(section: SectionAnchor) {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: "auto", block: "start" });
  }

  function selectTaskFilter(filter: TaskFilter) {
    setTaskFilter(filter);
    if ((filter === "planned" || filter === "waiting") && (taskSource.startsWith("hermes:") || taskSource.startsWith("imported:"))) setTaskSource(allTaskSources);
    if (filter === "due-today" && taskSource.startsWith("hermes:")) setTaskSource(allTaskSources);
  }

  function selectTaskCategory(category: TaskCategory) {
    setTaskCategory(category);
    if (category === unclassifiedTaskCategory && (taskSource === localTaskSource || taskSource.startsWith("imported:"))) {
      setTaskSource(allTaskSources);
      return;
    }
    if (category !== allTaskCategories && category !== unclassifiedTaskCategory && taskSource.startsWith("hermes:")) {
      setTaskSource(allTaskSources);
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

  function openTaskComposer(task?: Task, inboxItem?: InboxItem) {
    const linkedEvent = task?.linkedEventId
      ? data.events.find((event) => event.id === task.linkedEventId)
      : undefined;
    setTaskDraft({
      title: task?.title ?? inboxItem?.title ?? "",
      area: task?.area ?? inboxItem?.accent ?? (isOneOf(taskCategory, areas) ? taskCategory : "Personal"),
      priority: task?.priority ?? "medium",
      due: task?.due ?? "No deadline",
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
    const nowCompleted = !task.completed;
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((candidate) =>
        candidate.id === task.id
          ? { ...candidate, completed: nowCompleted, state: nowCompleted ? "done" : candidate.scheduledTime ? "scheduled" : "up-next" }
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
          ? { ...candidate, completed: false, state: completionUndo.state }
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
    scrollToSection("agenda");
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
      due: taskDraft.due,
      priority: taskDraft.priority,
      completed: existingTask?.completed ?? false,
      scheduledTime: taskDraft.scheduledTime || null,
      linkedEventId,
      origin,
      ...(source ? { source } : {}),
      ...(createdAt ? { createdAt } : {}),
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
        tasks,
        events,
        inboxItems: modal.inboxId
          ? current.inboxItems.map((item) => item.id === modal.inboxId ? { ...item, status: "handled" } : item)
          : current.inboxItems,
        reminders: updateReminder(current.reminders, taskId, "task", title, taskDraft.reminderMode),
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
      reminders: updateReminder(current.reminders, eventId, "event", title, eventDraft.reminderMode),
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
    const reminder = data.reminders.find((candidate) => candidate.state === "scheduled") ?? data.reminders[0];
    if (!reminder) {
      setStatusMessage("Add a reminder to a task or local calendar block first.");
      return;
    }
    setShowReminderTray(false);
    setActiveReminderId(reminder.id);
  }

  function snoozeReminder() {
    if (!activeReminder) return;
    setData((current) => ({
      ...current,
      reminders: current.reminders.map((reminder) =>
        reminder.id === activeReminder.id
          ? { ...reminder, state: "snoozed", when: "in 30 min", snoozedUntil: Date.now() + 30 * 60 * 1000 }
          : reminder,
      ),
    }));
    setActiveReminderId(null);
    setStatusMessage(`Snoozed “${activeReminder.title}” for 30 minutes while this prototype stays open.`);
  }

  const themeTarget = resolvedTheme === "black" ? "light" : "dark";

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

  function renderLifeboard() {
    return (
      <>
        <section className="lifeboard-strip" id="today">
          <div className="lifeboard-title">
            <h1>Today</h1>
            <p>{formatDublinDateKey(todayDate, { weekday: "long", day: "numeric", month: "long" })}</p>
          </div>
        </section>

        <section className="lifeboard-grid" aria-label="Fox Focus lifeboard">
          <div className="lifeboard-column lifeboard-column--agenda">
          <article className="pane lifeboard-agenda" id="agenda">
            <PaneHeader
              eyebrow="Calendar"
              title={calendarMode === "day"
                ? (selectedDate === todayDate ? `Today, ${formatDublinDateKey(selectedDate, { day: "numeric", month: "short" })}` : formatDublinDateKey(selectedDate))
                : `${formatDublinDateKey(calendarRangeStart, { day: "numeric", month: "short" })} – ${formatDublinDateKey(calendarRangeEnd, { day: "numeric", month: "short" })}`}
              action={<button className="pane-link" type="button" onClick={() => openEventComposer()}><Plus size={12} /> Add block</button>}
            />
            <div className="calendar-view-bar">
              <div className="calendar-view-switch" role="group" aria-label="Calendar view">
                <button className={calendarMode === "day" ? "calendar-view-option calendar-view-option--active" : "calendar-view-option"} type="button" aria-pressed={calendarMode === "day"} onClick={() => setCalendarMode("day")}>Day</button>
                <button className={calendarMode === "upcoming" ? "calendar-view-option calendar-view-option--active" : "calendar-view-option"} type="button" aria-pressed={calendarMode === "upcoming"} onClick={() => setCalendarMode("upcoming")}>Week</button>
              </div>
              <button className="calendar-today-action" type="button" onClick={returnCalendarToToday} disabled={selectedDate === todayDate && calendarMode === "day"}>Today</button>
              <div className="calendar-steps">
                <button className="calendar-step" type="button" onClick={() => moveCalendarDate(-1)} aria-label="Previous day"><ChevronLeft size={15} /></button>
                <button className="calendar-step" type="button" onClick={() => moveCalendarDate(1)} aria-label="Next day"><ChevronRight size={15} /></button>
              </div>
            </div>
            <div className="calendar-date-strip" role="tablist" aria-label="Choose a day">
              {calendarDays.map((date, index) => {
                const localCount = sortedEvents.filter((event) => eventDateKey(event, todayDate) === date).length;
                const fullLabel = formatDublinDateKey(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
                return <button
                  className={`calendar-date-tab${date === selectedDate ? " calendar-date-tab--selected" : ""}${date === todayDate ? " calendar-date-tab--today" : ""}`}
                  id={`calendar-date-${date}`}
                  key={date}
                  type="button"
                  role="tab"
                  aria-controls="calendar-day-panel"
                  aria-current={date === todayDate ? "date" : undefined}
                  aria-label={`${fullLabel}${date === todayDate ? ", today" : ""}, ${localCount} ${localCount === 1 ? "block" : "blocks"}`}
                  aria-selected={date === selectedDate}
                  tabIndex={date === selectedDate ? 0 : -1}
                  ref={(element) => { calendarTabRefs.current[index] = element; }}
                  onClick={() => selectCalendarDate(date)}
                  onKeyDown={(event) => handleCalendarTabKeyDown(event, index)}
                >
                  <span>{formatDublinDateKey(date, { weekday: "short" })}</span>
                  <strong>{formatDublinDateKey(date, { day: "numeric" })}</strong>
                  <i className={localCount ? "calendar-date-dot" : "calendar-date-dot calendar-date-dot--empty"} aria-hidden="true" />
                </button>;
              })}
            </div>
            <div className="schedule-list agenda-list" id="calendar-day-panel" role="tabpanel" aria-labelledby={`calendar-date-${selectedDate}`}>
              {calendarMode === "day"
                ? visibleCalendarEvents.map((event) => renderScheduleRow(event))
                : calendarDateWindow(selectedDate, 0, 6).map((date) => {
                    const dayEvents = visibleCalendarEvents.filter((event) => eventDateKey(event, todayDate) === date);
                    if (!dayEvents.length) return null;
                    return <section className="agenda-day-group" key={date}>
                      <button className="agenda-day-heading" type="button" onClick={() => selectCalendarDate(date)}><span>{date === todayDate ? "Today" : formatDublinDateKey(date, { weekday: "long" })}</span><strong>{formatDublinDateKey(date, { day: "numeric", month: "long" })}</strong><ChevronRight size={13} /></button>
                      {dayEvents.map((event) => renderScheduleRow(event, true))}
                    </section>;
                  })}
              {!visibleCalendarEvents.length ? <div className="calendar-empty"><CalendarDays size={16} /><span>{calendarMode === "day" ? "Nothing planned." : "Nothing planned this week."}</span></div> : null}
            </div>
            {selectedEvent ? (
              <div className="agenda-detail">
                <div className="agenda-detail-main">
                  <i className={`area-dot area-dot--${areaClass(selectedEvent.area)}`} />
                  <span>
                    <strong>{selectedEvent.title}</strong>
                    <small>{formatDublinDateKey(eventDateKey(selectedEvent, todayDate), { weekday: "short", day: "numeric", month: "short" })} · {eventTimeValue(selectedEvent)} · {formatDuration(selectedEvent.duration)} · {selectedEvent.area}{selectedEventTask?.completed ? " · done" : !selectedEvent.editable ? " · imported" : ""}</small>
                  </span>
                </div>
                <div className="agenda-detail-actions">
                  {selectedEventTask ? <button className="mini-action" type="button" onClick={() => openTaskComposer(selectedEventTask)}><Pencil size={12} /> Edit linked task</button> : null}
                  {selectedEvent.editable ? (
                    <button className="secondary-action" type="button" onClick={() => openEventComposer(selectedEvent)}><Pencil size={13} /> Edit</button>
                  ) : (
                    <button className="secondary-action" type="button" onClick={() => openEventComposer()}><Plus size={13} /> Capture local</button>
                  )}
                </div>
              </div>
            ) : null}
            {initial ? <IntegrationCalendarContext overviewState={integrations} onOpen={() => setShowIntegrations(true)} startDate={calendarRangeStart} endDate={calendarRangeEnd} /> : null}
          </article>

          <article className="pane lifeboard-tasks" id="tasks">
            <PaneHeader
              eyebrow={`${openTaskCount} open${plannedTaskCount ? ` · ${plannedTaskCount} planned` : ""}${hermesBoard ? " · Hermes connected" : ""}`}
              title="Tasks"
              action={<button className="pane-link" type="button" onClick={() => openTaskComposer()}><Plus size={12} /> Add task</button>}
            />
            <div className="task-toolbar-row">
              <nav className="task-category-strip" aria-label="Task categories">
                {taskCategoryOptions.map((category) => <button className={`task-category-tab${taskCategory === category.id ? " task-category-tab--active" : ""}`} type="button" aria-pressed={taskCategory === category.id} key={category.id} onClick={() => selectTaskCategory(category.id)}>{category.id !== allTaskCategories && category.id !== unclassifiedTaskCategory ? <i className={`area-dot area-dot--${areaClass(category.id)}`} /> : null}{category.label}</button>)}
              </nav>
              <div className="task-toolbar-controls">
                <label className="task-select"><span className="visually-hidden">Show</span><select value={taskFilter} aria-label="Show" onChange={(event) => { const value = event.target.value; if (isOneOf(value, taskFilters)) selectTaskFilter(value); }}>{taskFilters.map((filter) => <option value={filter} key={filter}>{taskFilterLabel(filter)} ({taskFilterCounts[filter]})</option>)}</select></label>
                {hermesBoard || importedTasks.length ? <label className="task-select"><span className="visually-hidden">Source</span><select value={taskSource} aria-label="Source" onChange={(event) => setTaskSource(event.target.value)}>{taskSourceOptions.map((source) => <option value={source.id} key={source.id} disabled={source.id.startsWith("hermes:") && source.count === 0}>{source.label} ({source.count})</option>)}</select></label> : null}
                <label className="task-select"><span className="visually-hidden">Sort</span><select value={taskSort} aria-label="Sort" disabled={isHermesOnlyScope} onChange={(event) => { const value = event.target.value; if (isOneOf(value, taskSorts)) setTaskSort(value); }}>{taskSorts.map((sort) => <option value={sort} key={sort}>{taskSortLabel(sort)}</option>)}</select></label>
                {initial && hermesBoard ? <button className="mini-action task-refresh" type="button" disabled={hermes.loading} onClick={hermes.refresh} aria-label="Refresh Hermes"><RotateCcw size={13} /></button> : null}
              </div>
            </div>
            {initial && hermes.failed ? <p className="task-filter-boundary"><Bot size={13} /> Hermes could not be refreshed. Local tasks are unaffected.</p> : null}
            {(hermesTasks.length || importedTasks.length) && (taskFilter === "planned" || taskFilter === "waiting") ? <p className="task-filter-boundary"><Bot size={13} /> Hermes and imported tasks only appear under All, Open, Done and Due today.</p> : null}
            <div className="task-browser-list task-browser-list--lifeboard" id="task-browser-panel" role="region" aria-label={`${taskFilterLabel(taskFilter)} tasks`} tabIndex={0}>
              {shownLocalTasks.map((task) => <TaskRow key={task.id} task={task} plannedDate={plannedDateForTask(task)} onToggle={toggleTask} onEdit={openTaskComposer} onSchedule={openTaskSchedule} />)}
              {shownHermesTasks.map((task) => <HermesTaskRow key={task.id} task={task} />)}
              {shownImportedTasks.map((task) => <ImportedTaskRow key={`${task.provider}:${task.id}`} task={task} />)}
              {!shownTaskCount ? <div className="empty-state"><ListTodo size={20} /><strong>{taskFilter === "done" ? "Nothing completed yet" : "Nothing here"}</strong><p>{taskFilter === "done" ? "Completed tasks will show up here." : "Try another category or add a task."}</p></div> : null}
            </div>
          </article>
          </div>

          <div className="lifeboard-column lifeboard-column--review">
          <article className="pane lifeboard-review" id="review">
            <PaneHeader eyebrow={reviewCount ? `${reviewCount} to review` : "Nothing waiting"} title="Inbox" />
            <div className="review-workbench">
              <div className="inbox-list inbox-list--lifeboard">
                {reviewItems.map((item) => (
                  <div className={`inbox-list-row${item.status === "handled" ? " inbox-list-row--handled" : ""}`} key={item.id}>
                    <button
                      className={`inbox-list-item${selectedInbox?.id === item.id ? " inbox-list-item--selected" : ""}`}
                      type="button"
                      aria-pressed={selectedInbox?.id === item.id}
                      onClick={() => selectInbox(item)}
                    >
                      <span className={`calendar-event-mark calendar-event-mark--${areaClass(item.accent)}`} />
                      <span><strong>{item.title}</strong><small>{item.source}</small></span>
                      <span className={`review-status review-status--${item.status}`}>{formatStatus(item.status)}</span>
                    </button>
                    <button className={`inbox-complete${item.status === "handled" ? " inbox-complete--done" : ""}`} type="button" onClick={() => toggleInboxHandled(item)} aria-label={`${item.status === "handled" ? "Return" : "Mark"} ${item.title} ${item.status === "handled" ? "to review" : "as handled"}`}>{item.status === "handled" ? <Check size={13} /> : <Circle size={15} />}</button>
                  </div>
                ))}
                {!reviewItems.length ? <p className="empty-line">Inbox is clear.</p> : null}
              </div>
              {selectedInbox ? (
                <div className="review-detail">
                  <div className="review-queue-nav">
                    <span>{selectedInboxIndex + 1} of {reviewItems.length}</span>
                    <div><button type="button" onClick={() => moveInboxSelection(-1)} disabled={selectedInboxIndex <= 0} aria-label="Previous review item"><ChevronLeft size={14} /></button><button type="button" onClick={() => moveInboxSelection(1)} disabled={selectedInboxIndex >= reviewItems.length - 1} aria-label="Next review item"><ChevronRight size={14} /></button></div>
                  </div>
                  <div className="review-item-meta">
                    <i className={`area-dot area-dot--${areaClass(selectedInbox.accent)}`} />
                    <span>{selectedInbox.actor}</span>
                    <span className={`review-status review-status--${selectedInbox.status}`}>{formatStatus(selectedInbox.status)}</span>
                  </div>
                  <h3>{selectedInbox.title}</h3>
                  <p>{selectedInbox.summary}</p>
                  <p className="review-source">{selectedInbox.source}</p>
                  {selectedInbox.draft ? <div className="saved-draft"><span>Draft · not sent</span><pre>{selectedInbox.draft}</pre></div> : null}
                  {selectedInbox.moreWork ? <div className="saved-request"><span>Note for Hermes · not delivered</span><p>{selectedInbox.moreWork}</p></div> : null}
                  {selectedInbox.status === "handled" ? <div className="review-detail-actions"><button className="secondary-action" type="button" onClick={() => toggleInboxHandled(selectedInbox)}><RotateCcw size={13} /> Return to review</button></div> : <div className="review-detail-actions">
                    <button className="page-primary-action" type="button" onClick={() => acceptInbox("task")}><ListTodo size={13} /> Create task</button>
                    <button className="secondary-action" type="button" onClick={() => openDraft(selectedInbox)}><Pencil size={13} /> Draft reply</button>
                    <button className="secondary-action" type="button" onClick={() => acceptInbox("event")}><CalendarDays size={13} /> Schedule block</button>
                    <button className="secondary-action" type="button" onClick={() => toggleInboxHandled(selectedInbox)}><CheckCircle2 size={13} /> No action</button>
                  </div>}
                  <details className="agent-request agent-request--compact">
                    <summary>Note for Hermes</summary>
                    <textarea id="more-work" aria-label="Note for Hermes" value={agentRequest} onChange={(event) => setAgentRequest(event.target.value)} placeholder="What should Hermes check or change later?" />
                    <button className="quiet-panel-action" type="button" onClick={saveMoreWork}>Save note</button>
                  </details>
                </div>
              ) : null}
            </div>
          </article>
          <aside className="pane lifeboard-signals" id="signals">
            <PaneHeader eyebrow="Read-only sources" title="Connections" />
            <div className="control-list">
              <button className="control-row control-row--button" type="button" onClick={() => setShowIntegrations(true)}>
                <span className="control-icon control-icon--blue"><Link2 size={14} /></span>
                <span><strong>Google &amp; Microsoft</strong><small>Calendars and tasks</small></span>
                <ChevronRight className="control-arrow" size={14} />
              </button>
              <button className="control-row control-row--button" type="button" onClick={() => scrollToSection("tasks")}>
                <span className="control-icon control-icon--stone"><Bot size={14} /></span>
                <span><strong>Hermes</strong><small>{initial ? hermes.feed?.state === "connected" ? `${activeHermesTaskCount} active tasks` : hermes.loading ? "Checking board…" : hermes.failed ? "Could not refresh" : "Not connected" : "Preview only"}</small></span>
                <ChevronRight className="control-arrow" size={14} />
              </button>
              <button className="control-row control-row--button" type="button" onClick={() => setShowReminderTray(true)}>
                <span className="control-icon control-icon--amber"><Bell size={14} /></span>
                <span><strong>Reminders</strong><small>{reminderCount ? `${reminderCount} saved` : "None saved"} · preview only</small></span>
                <ChevronRight className="control-arrow" size={14} />
              </button>
            </div>
          </aside>
          </div>
        </section>
      </>
    );
  }

  const taskModal = modal?.kind === "task" ? modal : null;
  const eventModal = modal?.kind === "event" ? modal : null;
  const draftModal = modal?.kind === "draft" ? modal : null;
  const modalInbox = taskModal?.inboxId
    ? data.inboxItems.find((item) => item.id === taskModal.inboxId)
    : eventModal?.inboxId
      ? data.inboxItems.find((item) => item.id === eventModal.inboxId)
      : null;

  return (
    <div className="control-room">
      <header className="command-bar" aria-hidden={isOverlayOpen}>
        <div className="brand-lockup">
          <span className="fox-mark" aria-hidden="true"><span /><span /></span>
          <div><strong>Fox Focus</strong></div>
        </div>
        <nav className="workspace-nav" aria-label="Jump to a section">
          <button className={activeSection === "today" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-pressed={activeSection === "today"} onClick={() => scrollToSection("today")}><Clock3 size={14} /><span>Today</span></button>
          <button className={activeSection === "agenda" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-pressed={activeSection === "agenda"} onClick={() => scrollToSection("agenda")}><CalendarDays size={14} /><span>Agenda</span></button>
          <button className={activeSection === "tasks" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-pressed={activeSection === "tasks"} onClick={() => scrollToSection("tasks")}><ListTodo size={14} /><span>Tasks</span></button>
          <button className={activeSection === "review" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-pressed={activeSection === "review"} onClick={() => scrollToSection("review")}><Inbox size={14} /><span>Review</span><b>{reviewCount}</b></button>
        </nav>
        <div className="command-actions">
          <button className="quiet-action notification-action" type="button" onClick={() => setShowReminderTray(true)} aria-label={`Open ${reminderCount} reminder previews`}><Bell size={15} /><b>{reminderCount}</b><span>Reminders</span></button>
          <button className="quiet-action theme-action" type="button" onClick={toggleTheme} aria-label={`Switch to ${themeTarget} theme`} title={`Switch to ${themeTarget} theme`}>{resolvedTheme === "black" ? <Sun size={15} /> : <Moon size={15} />}</button>
          <button className="capture-button" type="button" onClick={() => openTaskComposer()}><Plus size={15} /><span>Add task</span></button>
        </div>
      </header>

      {saveError || statusMessage || completionUndo || reviewUndo ? <div className={`status-footer${saveError ? " status-footer--error" : ""}`} role={saveError ? "alert" : "status"} aria-live={saveError ? "assertive" : "polite"} aria-hidden={isOverlayOpen}>
        <span />
        <p>{saveError ?? statusMessage}</p>
        {completionUndo ? <button className="status-undo" type="button" onClick={undoTaskCompletion}>Undo</button> : reviewUndo ? <button className="status-undo" type="button" onClick={undoInboxChange}>Undo</button> : null}
      </div> : null}
      <main aria-hidden={isOverlayOpen}>{renderLifeboard()}</main>

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
            <div className="editor-grid editor-grid--quick-task">
              <label className="field field--full"><span>Task</span><input autoFocus required value={taskDraft.title} onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))} placeholder="What needs doing?" /></label>
              <label className="field field--full"><span>Deadline</span><select value={taskDraft.due} onChange={(event) => setTaskDraft((current) => ({ ...current, due: event.target.value }))}><option value="Today">Today</option><option value="Tomorrow">Tomorrow</option><option value="Friday">Friday</option><option value="Waiting">Waiting</option><option value="No deadline">No deadline</option></select></label>
            </div>
            <button className="task-details-toggle" type="button" aria-expanded={showTaskDetails} aria-controls="task-more-options" onClick={() => setShowTaskDetails((current) => !current)}><SlidersHorizontal size={13} /><span>{showTaskDetails ? "Hide options" : "More options"}</span><ChevronDown size={13} /></button>
            {showTaskDetails ? <div className="editor-grid editor-grid--task-details" id="task-more-options">
              <label className="field"><span>Area</span><select value={taskDraft.area} onChange={(event) => { const value = event.target.value; if (isOneOf(value, areas)) setTaskDraft((current) => ({ ...current, area: value })); }}><option value="University">University</option><option value="Work">Work</option><option value="Personal">Personal</option><option value="Health">Health</option><option value="Admin">Admin</option></select></label>
              <label className="field"><span>Priority</span><select value={taskDraft.priority} onChange={(event) => { const value = event.target.value; if (isOneOf(value, priorities)) setTaskDraft((current) => ({ ...current, priority: value })); }}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
              <label className="field"><span>Duration</span><select value={taskDraft.duration} onChange={(event) => setTaskDraft((current) => ({ ...current, duration: event.target.value }))}><option value="5 min">5 min</option><option value="10 min">10 min</option><option value="20 min">20 min</option><option value="30 min">30 min</option><option value="40 min">40 min</option><option value="45 min">45 min</option><option value="60 min">60 min</option></select></label>
              <label className="field"><span>Task state</span><select value={taskDraft.state} onChange={(event) => { const value = event.target.value; if (isOneOf(value, activeTaskStates)) setTaskDraft((current) => ({ ...current, state: value })); }}><option value="up-next">Up next</option><option value="scheduled">Scheduled</option><option value="waiting">Waiting</option></select></label>
              <label className="field"><span>Planned day</span><input type="date" value={taskDraft.scheduledDate} onChange={(event) => setTaskDraft((current) => ({ ...current, scheduledDate: event.target.value }))} /></label>
              <label className="field"><span>Planned time</span><input type="time" value={taskDraft.scheduledTime} onChange={(event) => setTaskDraft((current) => ({ ...current, scheduledTime: event.target.value }))} /></label>
              <label className="field field--full"><span>Reminder preview · not scheduled</span><select value={taskDraft.reminderMode} onChange={(event) => { const value = event.target.value; if (isOneOf(value, reminderModes)) setTaskDraft((current) => ({ ...current, reminderMode: value })); }}><option value="none">No reminder preview</option><option value="one-hour">Preview 1 hour before</option><option value="morning">Preview 09:00 on the day</option></select></label>
            </div> : null}
            <div className="editor-footer"><span>{taskDraft.scheduledTime ? "This will create or update a local timetable block." : "Leave plan blank to keep it unscheduled."}</span><div><button className="secondary-action" type="button" onClick={() => setModal(null)}>Cancel</button><button className="submit-button" type="submit"><Check size={14} /> Save task</button></div></div>
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
              <label className="field"><span>Reminder preview · not scheduled</span><select value={eventDraft.reminderMode} onChange={(event) => { const value = event.target.value; if (isOneOf(value, reminderModes)) setEventDraft((current) => ({ ...current, reminderMode: value })); }}><option value="none">No reminder preview</option><option value="one-hour">Preview 1 hour before</option><option value="morning">Preview 09:00 on the day</option></select></label>
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
        <DialogFrame title="Reminder prototypes" onClose={() => setShowReminderTray(false)} className="editor-dialog--tray">
          <div className="editor-heading"><div className="composer-icon"><Bell size={17} /></div><div><p className="eyebrow">Manual preview only</p><h2>Reminder prototypes</h2></div><button className="close-composer" type="button" onClick={() => setShowReminderTray(false)} aria-label="Close reminders"><X size={17} /></button></div>
          <div className="reminder-list">
            {data.reminders.map((reminder) => <div className="reminder-row" key={reminder.id}><Bell size={14} /><span><strong>{reminder.title}</strong><small>{reminder.when} · {reminder.state === "snoozed" ? "preview snoozed" : "saved preview"}</small></span></div>)}
            {!data.reminders.length ? <p className="empty-line">No local reminders yet.</p> : null}
          </div>
          <div className="editor-footer"><span>No scheduler or system-notification delivery is wired yet. This only previews the first saved reminder.</span><button className="submit-button" type="button" onClick={testReminder}><Bell size={14} /> Preview first reminder</button></div>
        </DialogFrame>
      ) : null}

      {activeReminder ? (
        <DialogFrame title="Reminder" onClose={() => setActiveReminderId(null)} className="editor-dialog--alert">
          <div className="reminder-alert-icon"><Bell size={22} /></div>
          <p className="eyebrow">Reminder preview</p>
          <h2>{activeReminder.title}</h2>
          <p>This is a manual in-app preview. Intended timing: {formatReminderMode(activeReminder.mode)}.</p>
          <div className="alert-actions"><button className="secondary-action" type="button" onClick={() => setActiveReminderId(null)}>Dismiss</button><button className="submit-button" type="button" onClick={snoozeReminder}>Snooze 30 min</button></div>
        </DialogFrame>
      ) : null}

      <IntegrationsDrawer open={showIntegrations} onClose={() => setShowIntegrations(false)} overviewState={integrations} listAreas={data.listAreas} onListAreaChange={changeListArea} />
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing application root");
const root = createRoot(rootElement);
if (window.location.protocol !== "file:") {
  fetch("/api/v1/workspace").then(async (response) => {
    if (!response.ok) throw new Error("Could not load the server workspace");
    const initial: unknown = await response.json();
    if (!isRecord(initial) || typeof initial.revision !== "number" || !isPrototypeData(initial.data)) throw new Error("Invalid server workspace");
    root.render(<App initial={{ revision: initial.revision, data: initial.data }} />);
  }).catch(() => root.render(<main><h1>Workspace unavailable</h1><p>Your server data has not been replaced.</p><a href="/">Reload workspace</a></main>));
} else root.render(<App />);
