import "@fontsource-variable/instrument-sans";
import {
  Bell,
  Bot,
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Inbox,
  ListTodo,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { hermesLabels, useHermesFeed } from './hermes-feed.tsx';
import { type HermesTask } from "./hermes-model.ts";

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

function formatCalendarDay(): string {
  return new Intl.DateTimeFormat("en-IE", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "Europe/Dublin",
  }).format(new Date());
}

function taskFilterLabel(filter: TaskFilter): string {
  if (filter === "due-today") return "Due today";
  if (filter === "planned") return "Planned";
  if (filter === "waiting") return "Waiting";
  if (filter === "done") return "Done";
  return "All";
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
  compact = false,
}: {
  task: Task;
  onToggle: (task: Task) => void;
  onEdit: (task: Task) => void;
  onSchedule: (task: Task) => void;
  compact?: boolean;
}) {
  const createdAt = formatCreatedAt(task.createdAt);

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
          {task.scheduledTime ? <em className="task-sync-chip">{task.completed ? "Calendar done" : `${task.scheduledTime} in calendar`}</em> : null}
          {task.origin === "inbox" ? <em className="source-chip" title={task.source} aria-label={`From ${task.source ?? "Inbox"}`}>{task.source?.replace(/^Inbox · /, "") ?? "Inbox"}</em> : null}
          <em className={`task-created${createdAt ? "" : " task-created--unknown"}`}>{createdAt ? `Added ${createdAt}` : "Created date unknown"}</em>
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

const allTaskSources = "__all_task_sources__";
const localTaskSource = "__local_task_source__";

type TaskBrowserSection =
  | { id: typeof localTaskSource; label: "Local"; kind: "local"; tasks: Task[] }
  | { id: string; label: string; kind: "hermes"; tasks: HermesTask[] };

function hermesSourceId(source: string): string {
  return `hermes:${source}`;
}

function App({ initial }: { initial?: ServerSnapshot }) {
  const hermes = useHermesFeed(Boolean(initial));
  const [data, setData] = useState<PrototypeData>(() => initial?.data ?? loadData());
  const revision = useRef(initial?.revision ?? 0);
  const lastSaved = useRef(data);
  const saveQueue = useRef(Promise.resolve());
  const saveFailed = useRef(false);
  const [activeSection, setActiveSection] = useState<SectionAnchor>("today");
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "black" : "light",
  );
  const [modal, setModal] = useState<Modal>(null);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(defaultTaskDraft);
  const [eventDraft, setEventDraft] = useState<EventDraft>(defaultEventDraft);
  const [draftText, setDraftText] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [taskSource, setTaskSource] = useState(allTaskSources);
  const [taskSort, setTaskSort] = useState<TaskSort>("due");
  const [showReminderTray, setShowReminderTray] = useState(false);
  const [activeReminderId, setActiveReminderId] = useState<string | null>(null);
  const [completionUndo, setCompletionUndo] = useState<CompletionUndo | null>(null);
  const [agentRequest, setAgentRequest] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const focusBeforeOverlay = useRef<HTMLElement | null>(null);
  const taskTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const taskTabStripRef = useRef<HTMLElement | null>(null);
  const previousTaskFilter = useRef<TaskFilter | null>(null);

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

  const isOverlayOpen = Boolean(modal || showReminderTray || activeReminderId);

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
    if (previousTaskFilter.current === null) {
      previousTaskFilter.current = taskFilter;
      return;
    }
    if (previousTaskFilter.current === taskFilter) return;
    previousTaskFilter.current = taskFilter;

    const activeIndex = taskFilters.indexOf(taskFilter);
    const strip = taskTabStripRef.current;
    const tab = taskTabRefs.current[activeIndex];
    if (!strip || !tab) return;

    const tabStart = tab.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
    const tabEnd = tabStart + tab.offsetWidth;
    if (tabStart < strip.scrollLeft) strip.scrollTo({ left: tabStart, behavior: "smooth" });
    else if (tabEnd > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: tabEnd - strip.clientWidth, behavior: "smooth" });
  }, [taskFilter]);

  const sortedEvents = useMemo(
    () => [...data.events].sort((first, second) => first.start.localeCompare(second.start)),
    [data.events],
  );
  const taskById = useMemo(() => new Map(data.tasks.map((task) => [task.id, task])), [data.tasks]);
  const selectedEvent = data.events.find((event) => event.id === selectedEventId) ?? sortedEvents[0] ?? null;
  const selectedEventTask = selectedEvent?.taskId ? taskById.get(selectedEvent.taskId) : undefined;
  const selectedInbox = data.inboxItems.find((item) => item.id === selectedInboxId) ?? data.inboxItems[0] ?? null;
  const activeTasks = data.tasks.filter((task) => !task.completed);
  const activeBlock = sortedEvents.find((event) => event.editable && !taskById.get(event.taskId ?? "")?.completed) ?? null;
  const activeReminder = data.reminders.find((reminder) => reminder.id === activeReminderId) ?? null;
  const hermesBoard = hermes.feed?.state === "connected" ? hermes.feed.board : null;
  const hermesTasks = hermesBoard?.tasks ?? [];
  const hermesSources = hermesBoard?.sources ?? [];

  const visibleTasks = useMemo(() => {
    const filtered = data.tasks.filter((task) => {
      if (taskFilter === "due-today") return task.due === "Today" && !task.completed;
      if (taskFilter === "planned") return Boolean(task.scheduledTime) && !task.completed;
      if (taskFilter === "waiting") return task.state === "waiting" && !task.completed;
      if (taskFilter === "done") return task.completed;
      return true;
    });

    return [...filtered].sort((first, second) => {
      if (taskFilter !== "done" && first.completed !== second.completed) return Number(first.completed) - Number(second.completed);
      return taskSort === "created" ? compareTasksByCreatedAt(first, second) : compareTasksByDue(first, second);
    });
  }, [data.tasks, taskFilter, taskSort]);

  const visibleHermesTasks = useMemo(() => {
    if (taskFilter === "done") return hermesTasks.filter((task) => task.status === "done");
    return taskFilter === "all" ? hermesTasks : [];
  }, [hermesTasks, taskFilter]);

  const taskSourceTabs = [
    { id: allTaskSources, label: "Everything", count: visibleTasks.length + visibleHermesTasks.length },
    { id: localTaskSource, label: "Local", count: visibleTasks.length },
    ...hermesSources.map((source) => ({
      id: hermesSourceId(source),
      label: source,
      count: visibleHermesTasks.filter((task) => task.source === source).length,
    })),
  ];
  const isHermesOnlyScope = taskSource.startsWith("hermes:");

  const taskBrowserSections = useMemo<TaskBrowserSection[]>(() => {
    const sections: TaskBrowserSection[] = [];
    if ((taskSource === allTaskSources || taskSource === localTaskSource) && visibleTasks.length) {
      sections.push({ id: localTaskSource, label: "Local", kind: "local", tasks: visibleTasks });
    }
    if (taskSource === allTaskSources) {
      for (const source of hermesSources) {
        const tasks = visibleHermesTasks.filter((task) => task.source === source);
        if (tasks.length) sections.push({ id: hermesSourceId(source), label: source, kind: "hermes", tasks });
      }
      return sections;
    }
    if (taskSource.startsWith("hermes:")) {
      const source = taskSource.slice("hermes:".length);
      const tasks = visibleHermesTasks.filter((task) => task.source === source);
      if (tasks.length) sections.push({ id: taskSource, label: source, kind: "hermes", tasks });
    }
    return sections;
  }, [hermesSources, taskSource, visibleHermesTasks, visibleTasks]);

  const reminderCount = data.reminders.length;
  const reviewCount = data.inboxItems.length;
  const plannedTaskCount = activeTasks.filter((task) => Boolean(task.scheduledTime)).length;
  const activeHermesTaskCount = hermesTasks.filter((task) => task.status !== "done").length;
  const activeTaskCount = activeTasks.length + activeHermesTaskCount;
  const taskFilterCounts: Record<TaskFilter, number> = {
    all: data.tasks.length + hermesTasks.length,
    "due-today": activeTasks.filter((task) => task.due === "Today").length,
    planned: plannedTaskCount,
    waiting: activeTasks.filter((task) => task.state === "waiting").length,
    done: data.tasks.filter((task) => task.completed).length + hermesTasks.filter((task) => task.status === "done").length,
  };

  useEffect(() => {
    if (!taskSource.startsWith("hermes:")) return;
    const source = taskSource.slice("hermes:".length);
    if (!hermesSources.includes(source)) setTaskSource(allTaskSources);
  }, [hermesSources, taskSource]);

  useEffect(() => {
    if ((taskFilter === "all" || taskFilter === "done") || !taskSource.startsWith("hermes:")) return;
    setTaskSource(allTaskSources);
  }, [taskFilter, taskSource]);

  const calendarDay = formatCalendarDay();

  function scrollToSection(section: SectionAnchor) {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: "auto", block: "start" });
  }

  function cycleTheme() {
    setThemeMode((current) => (current === "system" ? "light" : current === "light" ? "black" : "system"));
  }

  function selectTaskFilter(filter: TaskFilter) {
    setTaskFilter(filter);
    if (filter !== "all" && filter !== "done" && taskSource.startsWith("hermes:")) setTaskSource(allTaskSources);
  }

  function handleTaskTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % taskFilters.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + taskFilters.length) % taskFilters.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = taskFilters.length - 1;
    else return;

    const nextFilter = taskFilters[nextIndex];
    if (!nextFilter) return;
    event.preventDefault();
    selectTaskFilter(nextFilter);
    window.requestAnimationFrame(() => taskTabRefs.current[nextIndex]?.focus({ preventScroll: true }));
  }

  function openTaskComposer(task?: Task, inboxItem?: InboxItem) {
    setTaskDraft({
      title: task?.title ?? inboxItem?.title ?? "",
      area: task?.area ?? inboxItem?.accent ?? "Personal",
      priority: task?.priority ?? "medium",
      due: task?.due ?? "No deadline",
      duration: task?.duration ?? "30 min",
      state: task && task.state !== "done" ? task.state : "up-next",
      scheduledTime: task?.scheduledTime ?? "",
      reminderMode: task ? reminderModeFor(data.reminders, task.id) : "none",
    });
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
      time: event?.start ?? "09:00",
      duration: event ? String(event.duration) : "30",
      reminderMode: event ? reminderModeFor(data.reminders, event.id) : "none",
    });
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
    setSelectedEventId(task.linkedEventId);
    scrollToSection("agenda");
  }

  function saveTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal || modal.kind !== "task") return;

    const title = taskDraft.title.trim();
    if (!title) {
      setStatusMessage("Give the task a name before saving it.");
      return;
    }
    if (taskDraft.scheduledTime && !isValidTime(taskDraft.scheduledTime)) {
      setStatusMessage("Choose a valid planned time before saving the task.");
      return;
    }

    const existingTask = modal.taskId ? data.tasks.find((task) => task.id === modal.taskId) : undefined;
    const inboxItem = modal.inboxId ? data.inboxItems.find((item) => item.id === modal.inboxId) : undefined;
    const taskId = existingTask?.id ?? makeId("task");
    const origin: TaskOrigin = existingTask?.origin ?? (inboxItem ? "inbox" : "manual");
    const source = existingTask?.source ?? (inboxItem ? `Inbox · ${inboxItem.source}` : undefined);
    const linkedEventId = taskDraft.scheduledTime ? existingTask?.linkedEventId ?? makeId("event") : undefined;
    const linkedEvent = linkedEventId
      ? {
          id: linkedEventId,
          title,
          subtitle: `${taskDraft.area} task · ${taskDraft.duration}`,
          area: taskDraft.area,
          start: taskDraft.scheduledTime,
          duration: parseDuration(taskDraft.duration),
          editable: true,
          origin: (inboxItem ? "inbox" : "task") as EventOrigin,
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
        inboxItems: modal.inboxId ? current.inboxItems.filter((item) => item.id !== modal.inboxId) : current.inboxItems,
        reminders: updateReminder(current.reminders, taskId, "task", title, taskDraft.reminderMode),
      };
    });

    if (completionUndo?.taskId === taskId) setCompletionUndo(null);
    if (linkedEventId) setSelectedEventId(linkedEventId);
    setStatusMessage(inboxItem ? `Accepted “${title}” as a local task.` : `Saved “${title}”.`);
    setModal(null);
  }

  function saveEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal || modal.kind !== "event") return;

    const title = eventDraft.title.trim();
    if (!title) {
      setStatusMessage("Give the calendar block a name before saving it.");
      return;
    }
    if (!isValidTime(eventDraft.time)) {
      setStatusMessage("Choose a valid start time before saving the calendar block.");
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
      start: eventDraft.time,
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
      inboxItems: modal.inboxId ? current.inboxItems.filter((item) => item.id !== modal.inboxId) : current.inboxItems,
      reminders: updateReminder(current.reminders, eventId, "event", title, eventDraft.reminderMode),
    }));

    if (existingEvent?.taskId && completionUndo?.taskId === existingEvent.taskId) setCompletionUndo(null);
    setSelectedEventId(eventId);
    setStatusMessage(inboxItem ? `Accepted “${title}” as a local calendar block.` : `Saved “${title}”.`);
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

  function openInbox(item: InboxItem) {
    setSelectedInboxId(item.id);
    setAgentRequest(item.moreWork ?? "");
    scrollToSection("review");
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
    setModal({ kind: "draft", inboxId: item.id });
  }

  function saveDraft() {
    if (!modal || modal.kind !== "draft") return;
    const text = draftText.trim();
    if (!text) {
      setStatusMessage("Write a draft before saving it for review.");
      return;
    }
    setData((current) => ({
      ...current,
      inboxItems: current.inboxItems.map((item) =>
        item.id === modal.inboxId ? { ...item, draft: text, status: "draft-ready" } : item,
      ),
    }));
    setStatusMessage("Draft saved in the Inbox. Nothing was sent.");
    setModal(null);
  }

  function saveMoreWork() {
    if (!selectedInbox) return;
    const request = agentRequest.trim();
    if (!request) {
      setStatusMessage("Add a short request before sending it back for more work.");
      return;
    }
    setData((current) => ({
      ...current,
      inboxItems: current.inboxItems.map((item) =>
        item.id === selectedInbox.id ? { ...item, moreWork: request, status: "waiting-on-agent" } : item,
      ),
    }));
    setStatusMessage("More work request saved in this local prototype.");
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

  const themeIcon = themeMode === "system" ? <Monitor size={15} /> : themeMode === "light" ? <Sun size={15} /> : <Moon size={15} />;
  const themeLabel = themeMode === "system" ? `System (${systemTheme})` : themeMode === "light" ? "Light" : "Black";

  function renderLifeboard() {
    return (
      <>
        <section className="lifeboard-strip" id="today">
          <div className="lifeboard-title">
            <p className="eyebrow">{initial ? "Personal workspace · private" : "Personal workspace · on this device"}</p>
            <h1>Today</h1>
            <p>Tasks, calendar time, and decisions that need you—one surface, with no duplicate queues.</p>
          </div>
        </section>

        <section className="lifeboard-grid" aria-label="Fox Focus lifeboard">
          <div className="lifeboard-column lifeboard-column--agenda">
          <article className="pane lifeboard-agenda" id="agenda">
            <PaneHeader
              eyebrow="Calendar / local blocks"
              title="Today in time order"
              action={<button className="pane-link" type="button" onClick={() => openEventComposer()}><Plus size={12} /> Add to calendar</button>}
            />
            <div className="calendar-ribbon">
              <span>Calendar</span>
              <strong>{calendarDay}</strong>
              <small>{sortedEvents.length} block{sortedEvents.length === 1 ? "" : "s"} · local changes stay linked to their task</small>
            </div>
            {initial ? <p className="source-boundary">Calendar source not connected. Add and edit your own blocks here.</p> : null}
            {activeBlock ? (
              <div className={`active-block lifeboard-active-block selected-run--${areaClass(activeBlock.area)}`}>
                <div className="active-block-copy">
                  <span className="live-label"><span /> Next editable block</span>
                  <strong>{activeBlock.title}</strong>
                  <small>{activeBlock.start} · {formatDuration(activeBlock.duration)} · {activeBlock.taskId ? "linked task" : "local block"}</small>
                </div>
                <button className="open-note" type="button" onClick={() => setSelectedEventId(activeBlock.id)}>Inspect <ChevronRight size={12} /></button>
              </div>
            ) : null}
            <div className="schedule-list agenda-list">
              {sortedEvents.map((event) => {
                const linkedTask = event.taskId ? taskById.get(event.taskId) : undefined;
                const linkedTaskDone = linkedTask?.completed === true;
                return (
                  <button
                    className={`schedule-row${event.id === selectedEvent?.id ? " schedule-row--selected" : ""}${linkedTaskDone ? " schedule-row--done" : ""}${event.editable ? "" : " schedule-row--imported"}`}
                    key={event.id}
                    type="button"
                    aria-pressed={event.id === selectedEvent?.id}
                    onClick={() => setSelectedEventId(event.id)}
                  >
                    <time>{event.start}</time>
                    <i className={`area-dot area-dot--${areaClass(event.area)}`} />
                    <span className="schedule-row-copy">
                      <strong>{event.title}</strong>
                      <small><em className={`agenda-origin${event.editable ? " agenda-origin--local" : " agenda-origin--imported"}${linkedTaskDone ? " agenda-origin--done" : ""}`}>{linkedTaskDone ? "Done" : event.editable ? "Local" : "Imported"}</em>{event.subtitle}</small>
                    </span>
                    <span className="schedule-duration">{formatDuration(event.duration)}</span>
                    <ChevronRight className="schedule-arrow" size={14} />
                  </button>
                );
              })}
              {!sortedEvents.length ? <div className="calendar-empty"><CalendarDays size={17} /><span>No blocks yet. Add the first thing that has a time.</span></div> : null}
            </div>
            {selectedEvent ? (
              <div className="agenda-detail">
                <div className="agenda-detail-main">
                  <i className={`area-dot area-dot--${areaClass(selectedEvent.area)}`} />
                  <span>
                    <em className={`agenda-origin${selectedEvent.editable ? " agenda-origin--local" : " agenda-origin--imported"}${selectedEventTask?.completed ? " agenda-origin--done" : ""}`}>{selectedEventTask?.completed ? "Completed task" : selectedEvent.editable ? "Local block" : "Imported calendar"}</em>
                    <strong>{selectedEvent.title}</strong>
                    <small>{selectedEvent.start} · {formatDuration(selectedEvent.duration)} · {selectedEvent.area}</small>
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
          </article>
          </div>

          <article className="pane lifeboard-tasks" id="tasks">
            <PaneHeader eyebrow="Tasks / local and Hermes" title="Task browser" action={<button className="pane-link" type="button" onClick={() => openTaskComposer()}><Plus size={12} /> Add local task</button>} />
            <p className="task-sync-note"><CalendarDays size={13} /> {initial && hermes.failed ? "Hermes could not be refreshed; local tasks are still available." : initial && hermes.feed?.state === "unavailable" ? "Hermes is not connected. Local tasks can still be planned into the calendar." : initial && hermes.loading && !hermesBoard ? "Loading Hermes tasks into this browser…" : "Local tasks can be planned into the calendar. Hermes tasks stay managed on their source board."}</p>
            <nav className="task-tab-strip" aria-label="Task views" role="tablist" ref={taskTabStripRef}>
              {taskFilters.map((filter, index) => (
                <button
                  className={`task-browser-tab${taskFilter === filter ? " task-browser-tab--active" : ""}`}
                  id={`task-view-${filter}`}
                  key={filter}
                  type="button"
                  role="tab"
                  ref={(element) => { taskTabRefs.current[index] = element; }}
                  aria-controls="task-browser-panel"
                  aria-selected={taskFilter === filter}
                  tabIndex={taskFilter === filter ? 0 : -1}
                  onClick={() => selectTaskFilter(filter)}
                  onKeyDown={(event) => handleTaskTabKeyDown(event, index)}
                >
                  <span>{taskFilterLabel(filter)}</span><b>{taskFilterCounts[filter]}</b>
                </button>
              ))}
            </nav>
            {hermesBoard ? (
              <nav className="task-source-strip" aria-label="Task sources">
                <span className="task-source-label">Source</span>
                {taskSourceTabs.map((source) => (
                  <button
                    className={`task-source-tab${taskSource === source.id ? " task-source-tab--active" : ""}`}
                    key={source.id}
                    type="button"
                    aria-pressed={taskSource === source.id}
                    disabled={source.id.startsWith("hermes:") && source.count === 0}
                    onClick={() => setTaskSource(source.id)}
                  >
                    <span>{source.label}</span><b>{source.count}</b>
                  </button>
                ))}
              </nav>
            ) : null}
            {hermesBoard && taskFilter !== "all" && taskFilter !== "done" && activeHermesTaskCount ? <p className="task-filter-boundary"><Bot size={13} /> {activeHermesTaskCount} Hermes task{activeHermesTaskCount === 1 ? " is" : "s are"} in All. Hermes does not provide a due date or local plan for this view.</p> : null}
            <div className="task-toolbar task-toolbar--lifeboard">
              {isHermesOnlyScope ? <><span className="task-order-label">Hermes order</span><span className="task-source-order">Source priority</span></> : <>
                <span className="task-order-label">{taskSource === allTaskSources ? "Order local" : "Order by"}</span>
                <div className="filter-chips" aria-label="Local task order">
                  {taskSorts.map((sort) => (
                    <button className={`filter-chip${taskSort === sort ? " filter-chip--active" : ""}`} key={sort} type="button" aria-pressed={taskSort === sort} onClick={() => setTaskSort(sort)}>
                      {taskSortLabel(sort)}
                    </button>
                  ))}
                </div>
              </>}
              <span className="task-view-count">{taskBrowserSections.reduce((count, section) => count + section.tasks.length, 0)} shown</span>
              {initial && hermesBoard ? <button className="mini-action task-refresh" type="button" disabled={hermes.loading} onClick={hermes.refresh}>{hermes.loading ? "Refreshing…" : "Refresh Hermes"}</button> : null}
            </div>
            <p className="planned-note"><CalendarDays size={13} /> {plannedTaskCount ? `${plannedTaskCount} planned task${plannedTaskCount === 1 ? "" : "s"} appear in the calendar above.` : "Schedule a task to place it in the calendar."}</p>
            <div className="task-browser-list task-browser-list--lifeboard" id="task-browser-panel" role="tabpanel" aria-labelledby={`task-view-${taskFilter}`} tabIndex={0}>
              {taskBrowserSections.map((section) => (
                <section className="task-browser-section" key={section.id} aria-label={`${section.label} tasks`}>
                  <header className="task-browser-section-heading">
                    <div><span>{section.kind === "hermes" ? "Hermes" : "Your workspace"}</span><strong>{section.label}</strong></div>
                    <small>{section.tasks.length} task{section.tasks.length === 1 ? "" : "s"}{section.kind === "hermes" ? " · read-only" : ""}</small>
                  </header>
                  {section.kind === "local"
                    ? section.tasks.map((task) => <TaskRow key={task.id} task={task} onToggle={toggleTask} onEdit={openTaskComposer} onSchedule={openTaskSchedule} />)
                    : section.tasks.map((task) => <HermesTaskRow key={task.id} task={task} />)}
                </section>
              ))}
              {!taskBrowserSections.length ? <div className="empty-state"><ListTodo size={20} /><strong>{taskFilter === "done" ? "No completed tasks yet" : "Nothing in this view"}</strong><p>{taskFilter === "done" ? "Completed tasks stay here for review." : "Try another tab or add a local task."}</p></div> : null}
            </div>
          </article>

          <div className="lifeboard-column lifeboard-column--review">
          <article className="pane lifeboard-review" id="review">
            <PaneHeader eyebrow="Review / your decision" title="Inbox" action={<span className="count-pill">{reviewCount}</span>} />
            {initial ? <p className="source-boundary">No inbox source connected yet.</p> : null}
            <div className="review-workbench">
              <div className="inbox-list inbox-list--lifeboard">
                {data.inboxItems.map((item) => (
                  <button
                    className={`inbox-list-item${selectedInbox?.id === item.id ? " inbox-list-item--selected" : ""}`}
                    key={item.id}
                    type="button"
                    aria-pressed={selectedInbox?.id === item.id}
                    onClick={() => {
                      setSelectedInboxId(item.id);
                      setAgentRequest(item.moreWork ?? "");
                    }}
                  >
                    <span className={`calendar-event-mark calendar-event-mark--${areaClass(item.accent)}`} />
                    <span><strong>{item.title}</strong><small>{item.source}</small></span>
                    <span className={`review-status review-status--${item.status}`}>{formatStatus(item.status)}</span>
                  </button>
                ))}
                {!data.inboxItems.length ? <p className="empty-line">Inbox is clear.</p> : null}
              </div>
              {selectedInbox ? (
                <div className="review-detail">
                  <div className="review-item-meta">
                    <i className={`area-dot area-dot--${areaClass(selectedInbox.accent)}`} />
                    <span>{selectedInbox.actor}</span>
                    <span className={`review-status review-status--${selectedInbox.status}`}>{formatStatus(selectedInbox.status)}</span>
                  </div>
                  <h3>{selectedInbox.title}</h3>
                  <p>{selectedInbox.summary}</p>
                  <div className="evidence-card evidence-card--compact">
                    <span>Source evidence</span>
                    <strong>{selectedInbox.source}</strong>
                    <p>Fixture content only. No account or email body is connected.</p>
                  </div>
                  {selectedInbox.draft ? <div className="saved-draft"><span>Saved draft · not sent</span><pre>{selectedInbox.draft}</pre></div> : null}
                  {selectedInbox.moreWork ? <div className="saved-request"><span>Saved request · not delivered</span><p>{selectedInbox.moreWork}</p></div> : null}
                  <div className="review-detail-actions">
                    <button className="page-primary-action" type="button" onClick={() => acceptInbox("task")}><ListTodo size={13} /> Task</button>
                    <button className="secondary-action" type="button" onClick={() => acceptInbox("event")}><CalendarDays size={13} /> Block</button>
                    <button className="secondary-action" type="button" onClick={() => openDraft(selectedInbox)}><Pencil size={13} /> Draft</button>
                  </div>
                  <div className="agent-request agent-request--compact">
                    <label htmlFor="more-work">More work</label>
                    <textarea id="more-work" value={agentRequest} onChange={(event) => setAgentRequest(event.target.value)} placeholder="What should be checked next?" />
                    <button className="quiet-panel-action" type="button" onClick={saveMoreWork}><Bot size={13} /> Save request</button>
                  </div>
                </div>
              ) : null}
            </div>
          </article>
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
          <div><strong>Fox Focus</strong><span>private life cockpit</span></div>
        </div>
        <nav className="workspace-nav" aria-label="Jump to a section">
          <button className={activeSection === "today" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-pressed={activeSection === "today"} onClick={() => scrollToSection("today")}><Clock3 size={14} /><span>Today</span></button>
          <button className={activeSection === "agenda" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-pressed={activeSection === "agenda"} onClick={() => scrollToSection("agenda")}><CalendarDays size={14} /><span>Agenda</span></button>
          <button className={activeSection === "tasks" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-pressed={activeSection === "tasks"} onClick={() => scrollToSection("tasks")}><ListTodo size={14} /><span>Tasks</span><b>{activeTaskCount}</b></button>
          <button className={activeSection === "review" ? "workspace-nav-item workspace-nav-item--active" : "workspace-nav-item"} type="button" aria-pressed={activeSection === "review"} onClick={() => scrollToSection("review")}><Inbox size={14} /><span>Review</span><b>{reviewCount}</b></button>
        </nav>
        <div className="command-actions">
          <button className="quiet-action notification-action" type="button" onClick={() => setShowReminderTray(true)} aria-label={`Open ${reminderCount} reminders`}><Bell size={15} /><b>{reminderCount}</b><span>Reminders</span></button>
          <button className="quiet-action theme-action" type="button" onClick={cycleTheme} aria-label={`Theme: ${themeLabel}. Change theme.`}>{themeIcon}<span>{themeLabel}</span></button>
          <button className="capture-button" type="button" onClick={() => openTaskComposer()}><Plus size={15} /><span>New item</span></button>
        </div>
      </header>

      {saveError || statusMessage || completionUndo ? <div className={`status-footer${saveError ? " status-footer--error" : ""}`} role={saveError ? "alert" : "status"} aria-live={saveError ? "assertive" : "polite"} aria-hidden={isOverlayOpen}>
        <span />
        <p>{saveError ?? statusMessage}</p>
        {completionUndo ? <button className="status-undo" type="button" onClick={undoTaskCompletion}>Undo</button> : null}
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
            {modalInbox ? <div className="source-notice"><Inbox size={14} /> Accepting from <strong>{modalInbox.source}</strong>. It will stay on the created task.</div> : null}
            <div className="editor-grid">
              <label className="field field--full"><span>Task</span><input autoFocus value={taskDraft.title} onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))} placeholder="What needs doing?" /></label>
              <label className="field"><span>Area</span><select value={taskDraft.area} onChange={(event) => { const value = event.target.value; if (isOneOf(value, areas)) setTaskDraft((current) => ({ ...current, area: value })); }}><option value="University">University</option><option value="Work">Work</option><option value="Personal">Personal</option><option value="Health">Health</option><option value="Admin">Admin</option></select></label>
              <label className="field"><span>Priority</span><select value={taskDraft.priority} onChange={(event) => { const value = event.target.value; if (isOneOf(value, priorities)) setTaskDraft((current) => ({ ...current, priority: value })); }}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
              <label className="field"><span>Deadline</span><select value={taskDraft.due} onChange={(event) => setTaskDraft((current) => ({ ...current, due: event.target.value }))}><option value="Today">Today</option><option value="Tomorrow">Tomorrow</option><option value="Friday">Friday</option><option value="Waiting">Waiting</option><option value="No deadline">No deadline</option></select></label>
              <label className="field"><span>Duration</span><select value={taskDraft.duration} onChange={(event) => setTaskDraft((current) => ({ ...current, duration: event.target.value }))}><option value="5 min">5 min</option><option value="10 min">10 min</option><option value="20 min">20 min</option><option value="30 min">30 min</option><option value="40 min">40 min</option><option value="45 min">45 min</option><option value="60 min">60 min</option></select></label>
              <label className="field"><span>Task state</span><select value={taskDraft.state} onChange={(event) => { const value = event.target.value; if (isOneOf(value, activeTaskStates)) setTaskDraft((current) => ({ ...current, state: value })); }}><option value="up-next">Up next</option><option value="scheduled">Scheduled</option><option value="waiting">Waiting</option></select></label>
              <label className="field"><span>Plan into timetable</span><input type="time" value={taskDraft.scheduledTime} onChange={(event) => setTaskDraft((current) => ({ ...current, scheduledTime: event.target.value }))} /></label>
              <label className="field"><span>Reminder</span><select value={taskDraft.reminderMode} onChange={(event) => { const value = event.target.value; if (isOneOf(value, reminderModes)) setTaskDraft((current) => ({ ...current, reminderMode: value })); }}><option value="none">No reminder</option><option value="one-hour">1 hour before</option><option value="morning">09:00 on the day</option></select></label>
            </div>
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
            {modalInbox ? <div className="source-notice"><Inbox size={14} /> Capturing from <strong>{modalInbox.source}</strong>. The local block keeps that source.</div> : null}
            <div className="editor-grid">
              <label className="field field--full"><span>Block title</span><input autoFocus value={eventDraft.title} onChange={(event) => setEventDraft((current) => ({ ...current, title: event.target.value }))} placeholder="What belongs in the timetable?" /></label>
              <label className="field field--full"><span>Location or context</span><input value={eventDraft.subtitle} onChange={(event) => setEventDraft((current) => ({ ...current, subtitle: event.target.value }))} placeholder="Optional note, location, or call link" /></label>
              <label className="field"><span>Area</span><select value={eventDraft.area} onChange={(event) => { const value = event.target.value; if (isOneOf(value, areas)) setEventDraft((current) => ({ ...current, area: value })); }}><option value="University">University</option><option value="Work">Work</option><option value="Personal">Personal</option><option value="Health">Health</option><option value="Admin">Admin</option></select></label>
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
          <p className="draft-context">This stays in the local Inbox. It is not a send screen.</p>
          <label className="field"><span>Draft reply</span><textarea autoFocus value={draftText} onChange={(event) => setDraftText(event.target.value)} /></label>
          <div className="editor-footer"><span>Source remains attached for review.</span><div><button className="secondary-action" type="button" onClick={() => setModal(null)}>Keep reviewing</button><button className="submit-button" type="button" onClick={saveDraft}><Check size={14} /> Save draft</button></div></div>
        </DialogFrame>
      ) : null}

      {showReminderTray ? (
        <DialogFrame title="Local reminders" onClose={() => setShowReminderTray(false)} className="editor-dialog--tray">
          <div className="editor-heading"><div className="composer-icon"><Bell size={17} /></div><div><p className="eyebrow">In-app only</p><h2>Local reminders</h2></div><button className="close-composer" type="button" onClick={() => setShowReminderTray(false)} aria-label="Close reminders"><X size={17} /></button></div>
          <div className="reminder-list">
            {data.reminders.map((reminder) => <div className="reminder-row" key={reminder.id}><Bell size={14} /><span><strong>{reminder.title}</strong><small>{reminder.when} · {reminder.state}</small></span></div>)}
            {!data.reminders.length ? <p className="empty-line">No local reminders yet.</p> : null}
          </div>
          <div className="editor-footer"><span>Browser notifications are not enabled in this static prototype.</span><button className="submit-button" type="button" onClick={testReminder}><Bell size={14} /> Test first reminder</button></div>
        </DialogFrame>
      ) : null}

      {activeReminder ? (
        <DialogFrame title="Reminder" onClose={() => setActiveReminderId(null)} className="editor-dialog--alert">
          <div className="reminder-alert-icon"><Bell size={22} /></div>
          <p className="eyebrow">Test reminder</p>
          <h2>{activeReminder.title}</h2>
          <p>This is an in-app prototype alert. {formatReminderMode(activeReminder.mode)}.</p>
          <div className="alert-actions"><button className="secondary-action" type="button" onClick={() => setActiveReminderId(null)}>Dismiss</button><button className="submit-button" type="button" onClick={snoozeReminder}>Snooze 30 min</button></div>
        </DialogFrame>
      ) : null}

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
