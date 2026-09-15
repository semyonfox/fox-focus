import { emailSendUiState, type EmailSendUiState } from "@shared/inbox-client";
import type { ActionRow, DraftRevision, InboxItemRow, Job, JobUpdate, TaskPlanRow, TaskRow } from "@shared/row-model";
import { buildWorkThreads, inboxStateLabel, jobStateLabel, latestSendActions, type WorkThread } from "@shared/work-threads";
import type { Rows } from "./api";
import { addDays, dayLabel, dublinDateKey, whenLabel } from "./dates";

export const isDone = (task: TaskRow) => task.observed?.status === "completed";

export function taskTitle(rows: Rows, task: TaskRow): string {
  if (task.observed) return task.observed.title;
  for (const action of rows.actions) {
    if (action.payload.kind === "task-create" && action.payload.taskId === task.id) return action.payload.title;
  }
  return "Untitled";
}

export function listName(rows: Rows, task: TaskRow): string {
  const listId = task.binding.kind === "google"
    ? task.binding.ref.listId
    : task.binding.kind === "pending" ? task.binding.destination.listId : null;
  if (!listId) return "Fox Focus";
  return rows.listNames[listId] ?? rows.destinations.find(destination => destination.listId === listId)?.listName ?? "Google Tasks";
}

export function planFor(rows: Rows, taskId: string): TaskPlanRow | null {
  return rows.taskPlans.find(plan => plan.taskId === taskId) ?? null;
}

// newest create or status action for a task
export function latestTaskAction(rows: Rows, taskId: string): ActionRow | null {
  let latest: ActionRow | null = null;
  for (const action of rows.actions) {
    const { payload } = action;
    if ((payload.kind !== "task-status" && payload.kind !== "task-create") || payload.taskId !== taskId) continue;
    if (!latest || action.createdAt > latest.createdAt) latest = action;
  }
  return latest;
}

export const isPending = (action: ActionRow | null) => action?.state === "queued" || action?.state === "running";
export const isStuck = (action: ActionRow | null) =>
  action?.state === "failed" || action?.state === "conflict" || action?.state === "unknown";

export const canTick = (task: TaskRow) => Boolean(task.observed?.completionWritable);

// earliest of planned day, google "do on" and deadline
export function whenKey(rows: Rows, task: TaskRow): string | null {
  const plan = planFor(rows, task.id);
  const planned = plan?.plannedAt ? dublinDateKey(new Date(plan.plannedAt)) : plan?.plannedOn;
  const keys = [planned, task.observed?.doOn, plan?.deadlineOn].filter((key): key is string => Boolean(key));
  return keys.length ? keys.sort()[0] : null;
}

export function dueLabel(rows: Rows, task: TaskRow): string | null {
  const plan = planFor(rows, task.id);
  if (plan?.plannedAt) return whenLabel(plan.plannedAt);
  if (plan?.deadlineOn) return `Due ${dayLabel(plan.deadlineOn)}`;
  if (task.observed?.doOn) return dayLabel(task.observed.doOn);
  if (plan?.plannedOn) return dayLabel(plan.plannedOn);
  return null;
}

const priorityRank = { high: 0, medium: 1, low: 2 } as const;

export function openTasks(rows: Rows): TaskRow[] {
  return rows.tasks
    .filter(task => !isDone(task) && !task.unavailableAt)
    .sort((a, b) => {
      const whenA = whenKey(rows, a) ?? "9999";
      const whenB = whenKey(rows, b) ?? "9999";
      if (whenA !== whenB) return whenA < whenB ? -1 : 1;
      const rankA = priorityRank[planFor(rows, a.id)?.priority ?? "medium"];
      const rankB = priorityRank[planFor(rows, b.id)?.priority ?? "medium"];
      return rankA - rankB || taskTitle(rows, a).localeCompare(taskTitle(rows, b));
    });
}

export function doneTasks(rows: Rows): TaskRow[] {
  return rows.tasks
    .filter(isDone)
    .sort((a, b) => (b.observed?.completedAt ?? "").localeCompare(a.observed?.completedAt ?? ""));
}

export function groupByWhen(rows: Rows, tasks: TaskRow[], today = dublinDateKey()) {
  const groups: Record<string, TaskRow[]> = { Overdue: [], Today: [], "This week": [], Later: [], "No date": [] };
  for (const task of tasks) {
    const key = whenKey(rows, task);
    const group = !key ? "No date" : key < today ? "Overdue" : key === today ? "Today" : key <= addDays(today, 7) ? "This week" : "Later";
    groups[group].push(task);
  }
  return Object.entries(groups).filter(([, data]) => data.length).map(([title, data]) => ({ title, data }));
}

export function currentDraft(rows: Rows, item: InboxItemRow): DraftRevision | null {
  if (!item.currentDraftId) return null;
  return rows.drafts.find(draft => draft.id === item.currentDraftId) ?? null;
}

export function sendActionFor(rows: Rows, item: InboxItemRow): ActionRow | undefined {
  return latestSendActions(rows.actions).get(item.id);
}

export function sendState(rows: Rows, item: InboxItemRow): EmailSendUiState {
  return emailSendUiState(item, currentDraft(rows, item), sendActionFor(rows, item), rows.capabilities.emailSendEnabled);
}

export function updatesFor(rows: Rows, jobId: string): JobUpdate[] {
  return rows.jobUpdates.filter(update => update.jobId === jobId).sort((a, b) => a.seq - b.seq);
}

export function jobsFor(rows: Rows, link: { taskId?: string; inboxId?: string }): Job[] {
  return rows.jobs
    .filter(job => (link.taskId && job.taskId === link.taskId) || (link.inboxId && job.inboxId === link.inboxId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function threads(rows: Rows, now = Date.now()): WorkThread[] {
  return buildWorkThreads(rows.inbox, rows.jobs, latestSendActions(rows.actions), now);
}

export const needsCount = (rows: Rows) => threads(rows).filter(thread => thread.group === "needs_you").length;

export function jobThread(job: Job): WorkThread {
  return {
    key: `job:${job.id}`, kind: "job", title: job.title, source: "Hermes", updatedAt: job.updatedAt,
    group: job.state === "settled" ? "settled" : job.state === "queued" || job.state === "working" ? "working" : "needs_you",
    item: null, job,
  };
}

export type DotTone = "amber" | "blue" | "light" | "faint";

export function threadTone(thread: WorkThread): DotTone {
  if (thread.job) {
    const { state } = thread.job;
    return state === "needs_you" ? "amber" : state === "review" ? "light" : state === "settled" ? "faint" : "blue";
  }
  return thread.group === "needs_you" ? "amber" : thread.group === "working" ? "blue" : "faint";
}

export function threadStatus(rows: Rows, thread: WorkThread): string {
  if (thread.item && !thread.job) return inboxStateLabel(thread.item, sendState(rows, thread.item));
  if (!thread.job) return "";
  const { job } = thread;
  if (job.state === "needs_you" && job.question) return job.question;
  if (job.state === "working") {
    const updates = updatesFor(rows, job.id);
    return updates.length ? updates[updates.length - 1].text : "Working";
  }
  return jobStateLabel(job);
}

export const updateKindLabel: Record<JobUpdate["kind"], string> = {
  progress: "update", question: "question", answer: "answer", result: "result", sent_back: "sent back", settled: "settled",
};
