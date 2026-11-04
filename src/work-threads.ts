import type { EmailSendUiState } from "./inbox-client.ts";
import type { ActionRow, AssistantId, InboxItemRow, Job, JobUpdate, ThreadEntry } from "./row-model.ts";

// shared by the web Inbox and the Android app so both group and label work the same way
export type WorkThreadGroup = "needs_you" | "working" | "settled" | "noise";

// T3-style sidebar placement: active threads, then the collapsed shelves
export type WorkThreadShelf = "active" | "snoozed" | "settled" | "noise";
export type WorkThreadTone = "working" | "input" | "approval" | "done" | "failed" | "quiet";

export type WorkThread = {
  key: string;
  kind: "inbox" | "job";
  title: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  group: WorkThreadGroup;
  shelf: WorkThreadShelf;
  assistant: AssistantId;
  status: string;
  tone: WorkThreadTone;
  // counts toward the Inbox badge: the thread is waiting on the owner
  attention: boolean;
  item: InboxItemRow | null;
  job: Job | null;
};

// Hermes mirrors its cron jobs into the Inbox; they are routines, not decisions
export function isRoutineMirror(item: Pick<InboxItemRow, "source">): boolean {
  return item.source.kind === "hermes" && item.source.reference.startsWith("cron:");
}

type JobPresentation = Pick<WorkThread, "shelf" | "status" | "tone" | "attention">;

// snooze is only an overlay: newer agent output after the snooze wakes the thread early
export function jobPresentation(job: Job, now = Date.now()): JobPresentation {
  if (job.state === "settled") return { shelf: "settled", status: job.outcome === "dropped" ? "Dropped" : "Settled", tone: "quiet", attention: false };
  const base: JobPresentation = job.state === "needs_you"
    ? { shelf: "active", status: "Awaiting input", tone: "input", attention: true }
    : job.state === "review"
      ? job.resultKind === "failed"
        ? { shelf: "active", status: "Failed", tone: "failed", attention: true }
        : { shelf: "active", status: "Completed", tone: "done", attention: false }
      : { shelf: "active", status: job.state === "queued" ? "Queued" : "Working", tone: "working", attention: false };
  if (!job.snoozedUntil) return base;
  const raisedHand = job.snoozedAt !== null && job.attentionAt !== null && Date.parse(job.attentionAt) > Date.parse(job.snoozedAt);
  if (Date.parse(job.snoozedUntil) > now && !raisedHand) return { ...base, shelf: "snoozed", attention: false };
  return { shelf: "active", status: "Woke", tone: base.tone === "working" ? "working" : "input", attention: base.tone !== "working" };
}

export function inboxSourceLabel(item: InboxItemRow): string {
  if (item.source.kind === "email") return `Email · ${item.source.accountId}`;
  if (item.source.kind === "hermes") return "Hermes";
  return "Capture";
}

export function relativeTime(value: string, now = Date.now()): string {
  const difference = now - Date.parse(value);
  if (!Number.isFinite(difference)) return "";
  const future = difference < 0;
  const minutes = Math.max(0, Math.round(Math.abs(difference) / 60_000));
  const label = minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 24 * 60
        ? `${Math.round(minutes / 60)}h`
        : `${Math.round(minutes / (24 * 60))}d`;
  return future && label !== "now" ? `in ${label}` : label;
}

export function jobStateLabel(job: Job): string {
  if (job.state === "needs_you") return "Needs you";
  if (job.state === "review") return "Review";
  if (job.state === "working") return "Working";
  if (job.state === "queued") return "Queued";
  return job.outcome === "accepted" ? "Accepted" : "Dropped";
}

export function inboxStateLabel(item: InboxItemRow, sendState: EmailSendUiState, now = Date.now()): string {
  if (sendState === "sending") return "Sending";
  if (sendState === "reconciling") return "Reconciling";
  if (sendState === "unknown") return "Needs reconciliation";
  if (sendState === "failed") return "Send failed";
  if (item.state === "waiting") return item.snoozedUntil && Date.parse(item.snoozedUntil) <= now ? "Ready" : "Snoozed";
  if (item.state === "resolved") {
    if (item.outcome === "task") return "Task made";
    if (item.outcome === "noise") return "Noise";
    if (item.outcome === "dismissed") return "Not interested";
    if (item.outcome === "sent") return "Sent";
    return "Done";
  }
  return item.currentDraftId ? "Draft ready" : "New";
}

// newest email-send action per Inbox item
export function latestSendActions(actions: readonly ActionRow[]): Map<string, ActionRow> {
  const latest = new Map<string, ActionRow>();
  for (const action of actions) {
    if (action.payload.kind !== "email-send") continue;
    const current = latest.get(action.payload.inboxId);
    if (!current || action.createdAt > current.createdAt ||
      (action.createdAt === current.createdAt && action.version >= current.version)) latest.set(action.payload.inboxId, action);
  }
  return latest;
}

export function buildWorkThreads(
  allInbox: readonly InboxItemRow[],
  jobs: readonly Job[],
  sendActions: ReadonlyMap<string, ActionRow>,
  now = Date.now(),
): WorkThread[] {
  const inbox = allInbox.filter(item => !isRoutineMirror(item));
  const inboxById = new Map(inbox.map((item) => [item.id, item]));
  const activeJobByInboxId = new Map<string, Job>();
  for (const job of jobs) {
    if (!job.inboxId || job.taskId || job.state === "settled" || !inboxById.has(job.inboxId)) continue;
    const current = activeJobByInboxId.get(job.inboxId);
    if (!current || job.updatedAt > current.updatedAt ||
      (job.updatedAt === current.updatedAt && job.id > current.id)) activeJobByInboxId.set(job.inboxId, job);
  }
  const inboxThreads = inbox.map<WorkThread>((item) => {
    const stillSnoozed = item.state === "waiting" &&
      (item.snoozedUntil === null || Date.parse(item.snoozedUntil) > now);
    const sendAction = sendActions.get(item.id);
    const sending = sendAction?.state === "queued" || sendAction?.state === "running";
    const sendProblem = sendAction?.state === "failed" || sendAction?.state === "conflict" || sendAction?.state === "unknown";
    const activeJob = activeJobByInboxId.get(item.id) ?? null;
    const latestItemUpdate = sendAction && sendAction.updatedAt > item.updatedAt ? sendAction.updatedAt : item.updatedAt;
    const presentation: JobPresentation = sending
      ? { shelf: "active", status: "Sending", tone: "working", attention: false }
      : sendProblem
        ? { shelf: "active", status: sendAction?.state === "unknown" ? "Needs reconciliation" : "Send failed", tone: "failed", attention: true }
        : activeJob
          ? jobPresentation(activeJob, now)
          : item.likelyNoise
            ? { shelf: "noise", status: "Likely noise", tone: "quiet", attention: false }
            : item.state === "resolved"
              ? { shelf: "settled", status: "Settled", tone: "quiet", attention: false }
              : stillSnoozed
                ? { shelf: "snoozed", status: "Snoozed", tone: "quiet", attention: false }
                : item.state === "waiting"
                  ? { shelf: "active", status: "Woke", tone: "input", attention: true }
                  : item.currentDraftId
                    ? { shelf: "active", status: "Draft ready", tone: "approval", attention: true }
                    : { shelf: "active", status: "New", tone: "input", attention: true };
    return {
      key: `inbox:${item.id}`,
      kind: activeJob ? "job" : "inbox",
      title: activeJob?.title ?? item.title,
      source: activeJob ? `${inboxSourceLabel(item)} · ${assistantName(activeJob.assistant)}` : inboxSourceLabel(item),
      createdAt: item.createdAt,
      updatedAt: activeJob && activeJob.updatedAt > latestItemUpdate ? activeJob.updatedAt : latestItemUpdate,
      group: sending
        ? "working"
        : sendProblem
          ? "needs_you"
          : activeJob
            ? activeJob.state === "queued" || activeJob.state === "working" ? "working" : "needs_you"
            : item.likelyNoise
              ? "noise"
              : item.state === "resolved"
                ? "settled"
                : stillSnoozed
                  ? "working"
                  : "needs_you",
      assistant: activeJob?.assistant ?? "hermes",
      ...presentation,
      item,
      job: activeJob,
    };
  });
  const jobThreads = jobs.flatMap<WorkThread>((job) => {
    const item = job.inboxId ? inboxById.get(job.inboxId) ?? null : null;
    if (item && !job.taskId && (job.state === "settled" || activeJobByInboxId.get(item.id)?.id === job.id)) return [];
    return [{
      key: `job:${job.id}`,
      kind: "job",
      title: job.title,
      source: item ? `${inboxSourceLabel(item)} · ${assistantName(job.assistant)}` : assistantName(job.assistant),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      group: job.state === "settled"
        ? "settled"
        : job.state === "queued" || job.state === "working"
          ? "working"
          : "needs_you",
      assistant: job.assistant,
      ...jobPresentation(job, now),
      item,
      job,
    }];
  });
  // newest first and stable, like T3: status changes recolour a row instead of moving it
  return [...inboxThreads, ...jobThreads]
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt) || first.key.localeCompare(second.key));
}

export function assistantName(assistant: AssistantId): string {
  return assistant === "fox" ? "Fox" : "Hermes";
}

// Hermes threads keep their one-line update timeline; show it in the same conversation shape
export function hermesThreadEntries(job: Job, updates: JobUpdate[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [{ seq: 0, role: "owner", kind: "message", text: job.instruction, options: [], url: null, at: job.createdAt }];
  for (const update of updates) {
    if (update.kind === "settled") continue;
    entries.push({
      seq: update.seq,
      role: update.author === "owner" ? "owner" : "assistant",
      kind: update.kind === "progress" ? "activity" : update.kind === "question" ? "question" : update.kind === "answer" ? "answer" : "message",
      text: update.text,
      options: [],
      url: update.url,
      at: update.at,
    });
  }
  return entries;
}
