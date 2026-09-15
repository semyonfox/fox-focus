import type { EmailSendUiState } from "./inbox-client.ts";
import type { ActionRow, InboxItemRow, Job } from "./row-model.ts";

// shared by the web Inbox and the Android app so both group and label work the same way
export type WorkThreadGroup = "needs_you" | "working" | "settled" | "noise";

export type WorkThread = {
  key: string;
  kind: "inbox" | "job";
  title: string;
  source: string;
  updatedAt: string;
  group: WorkThreadGroup;
  item: InboxItemRow | null;
  job: Job | null;
};

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
  inbox: readonly InboxItemRow[],
  jobs: readonly Job[],
  sendActions: ReadonlyMap<string, ActionRow>,
  now = Date.now(),
): WorkThread[] {
  const inboxById = new Map(inbox.map((item) => [item.id, item]));
  const inboxThreads = inbox.map<WorkThread>((item) => {
    const stillSnoozed = item.state === "waiting" &&
      (item.snoozedUntil === null || Date.parse(item.snoozedUntil) > now);
    const sendAction = sendActions.get(item.id);
    const sending = sendAction?.state === "queued" || sendAction?.state === "running";
    const sendProblem = sendAction?.state === "failed" || sendAction?.state === "conflict" || sendAction?.state === "unknown";
    return {
      key: `inbox:${item.id}`,
      kind: "inbox",
      title: item.title,
      source: inboxSourceLabel(item),
      updatedAt: sendAction && sendAction.updatedAt > item.updatedAt ? sendAction.updatedAt : item.updatedAt,
      group: sending
        ? "working"
        : sendProblem
          ? "needs_you"
          : item.likelyNoise
            ? "noise"
            : item.state === "resolved"
              ? "settled"
              : stillSnoozed
                ? "working"
                : "needs_you",
      item,
      job: null,
    };
  });
  const jobThreads = jobs.map<WorkThread>((job) => {
    const item = job.inboxId ? inboxById.get(job.inboxId) ?? null : null;
    return {
      key: `job:${job.id}`,
      kind: "job",
      title: job.title,
      source: item ? `${inboxSourceLabel(item)} · Hermes` : "Hermes",
      updatedAt: job.updatedAt,
      group: job.state === "settled"
        ? "settled"
        : job.state === "queued" || job.state === "working"
          ? "working"
          : "needs_you",
      item,
      job,
    };
  });
  return [...inboxThreads, ...jobThreads]
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt) || first.key.localeCompare(second.key));
}
