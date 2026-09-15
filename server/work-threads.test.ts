import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRow, InboxItemRow, Job } from "../src/row-model.ts";
import { buildWorkThreads, inboxStateLabel, jobStateLabel, latestSendActions } from "../src/work-threads.ts";

const now = Date.parse("2026-09-14T12:00:00.000Z");
const at = "2026-09-14T10:00:00.000Z";

function item(id: string, fields: Partial<InboxItemRow> = {}): InboxItemRow {
  return {
    id, version: 1, source: { kind: "hermes", reference: id }, title: id, summary: "", state: "open", outcome: null,
    taskId: null, currentDraftId: null, likelyNoise: false, snoozedUntil: null, createdAt: at, updatedAt: at, ...fields,
  };
}

function job(id: string, fields: Partial<Job> = {}): Job {
  return {
    id, version: 1, title: id, instruction: "Do it", taskId: null, inboxId: null, state: "queued", outcome: null,
    question: null, claimId: null, leaseUntil: null, createdAt: at, updatedAt: at, ...fields,
  };
}

function sendAction(inboxId: string, state: ActionRow["state"], createdAt = at): ActionRow {
  return {
    id: `send-${inboxId}-${state}`,
    version: 1,
    payload: {
      kind: "email-send",
      inboxId,
      draftId: "draft-1",
      reply: {
        accountId: "account", threadId: "thread", replyToMessageId: "message", inReplyTo: "<message@example.com>",
        references: [], from: "me@example.com", to: ["you@example.com"], cc: [], bcc: [], subject: "Re: hi", bodyText: "Hi",
      },
      payloadHash: "a".repeat(43),
    },
    operationKey: `op-${inboxId}`,
    requestHash: "hash",
    approval: { actor: "owner", at: createdAt, previewText: "Send" },
    state,
    attemptCount: 1,
    nextAttemptAt: null,
    claimId: null,
    leaseUntil: null,
    receipt: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function groups(inbox: InboxItemRow[], jobs: Job[] = [], actions: ActionRow[] = []) {
  return Object.fromEntries(buildWorkThreads(inbox, jobs, latestSendActions(actions), now).map(thread => [thread.key, thread.group]));
}

test("Inbox items group by decision, snooze, noise and send state", () => {
  assert.deepEqual(groups([
    item("open"),
    item("snoozed", { state: "waiting", snoozedUntil: "2026-09-15T08:00:00.000Z" }),
    item("woke", { state: "waiting", snoozedUntil: "2026-09-14T11:00:00.000Z" }),
    item("done", { state: "resolved", outcome: "read" }),
    item("noise", { likelyNoise: true, state: "resolved", outcome: "noise" }),
    item("sending"),
    item("stuck"),
  ], [], [sendAction("sending", "running"), sendAction("stuck", "unknown")]), {
    "inbox:open": "needs_you",
    "inbox:snoozed": "working",
    "inbox:woke": "needs_you",
    "inbox:done": "settled",
    "inbox:noise": "noise",
    "inbox:sending": "working",
    "inbox:stuck": "needs_you",
  });
});

test("jobs that need an answer or review wait on the owner", () => {
  assert.deepEqual(groups([], [
    job("queued"),
    job("working", { state: "working" }),
    job("question", { state: "needs_you", question: "Which one?" }),
    job("review", { state: "review" }),
    job("settled", { state: "settled", outcome: "accepted" }),
  ]), {
    "job:queued": "working",
    "job:working": "working",
    "job:question": "needs_you",
    "job:review": "needs_you",
    "job:settled": "settled",
  });
});

test("a job linked to an Inbox item names its source", () => {
  const [thread] = buildWorkThreads([], [job("linked", { inboxId: "mail" })].map(entry => entry), new Map(), now);
  assert.equal(thread?.source, "Hermes");
  const threads = buildWorkThreads([item("mail", { source: { kind: "email", accountId: "gmail", messageId: "m", threadId: "t" } })],
    [job("linked", { inboxId: "mail" })], new Map(), now);
  assert.equal(threads.find(entry => entry.kind === "job")?.source, "Email · gmail · Hermes");
});

test("the newest send action wins and drives the label", () => {
  const actions = [sendAction("mail", "failed", "2026-09-14T09:00:00.000Z"), sendAction("mail", "succeeded", "2026-09-14T09:30:00.000Z")];
  assert.equal(latestSendActions(actions).get("mail")?.state, "succeeded");
  assert.equal(inboxStateLabel(item("mail", { state: "waiting", snoozedUntil: "2026-09-14T11:00:00.000Z" }), "disabled", now), "Ready");
  assert.equal(inboxStateLabel(item("mail"), "sending", now), "Sending");
  assert.equal(jobStateLabel(job("review", { state: "review" })), "Review");
});
