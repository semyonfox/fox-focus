import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRow, InboxItemRow, Job } from "../src/row-model.ts";
import { buildWorkThreads, inboxStateLabel, isRoutineMirror, jobPresentation, jobStateLabel, latestSendActions } from "../src/work-threads.ts";

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
    id, version: 1, title: id, instruction: "Do it", taskId: null, inboxId: null, assistant: "hermes", state: "queued", outcome: null,
    question: null, prompt: null, resultKind: null, resultNote: null, claimId: null, leaseUntil: null,
    snoozedUntil: null, snoozedAt: null, attentionAt: null, createdAt: at, updatedAt: at, ...fields,
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

test("a job whose Inbox item is missing remains a standalone Hermes thread", () => {
  const [thread] = buildWorkThreads([], [job("linked", { inboxId: "mail" })].map(entry => entry), new Map(), now);
  assert.equal(thread?.source, "Hermes");
  assert.equal(thread?.key, "job:linked");
});

test("the newest active Inbox job governs one stable Inbox thread", () => {
  const threads = buildWorkThreads([item("mail", { source: { kind: "email", accountId: "gmail", messageId: "m", threadId: "t" } })],
    [
      job("older", { inboxId: "mail", state: "needs_you", updatedAt: "2026-09-14T10:15:00.000Z" }),
      job("newer", { inboxId: "mail", title: "Hermes is handling mail", state: "working", updatedAt: "2026-09-14T10:30:00.000Z" }),
      job("settled", { inboxId: "mail", state: "settled", outcome: "accepted", updatedAt: "2026-09-14T10:45:00.000Z" }),
    ], new Map(), now);

  assert.deepEqual(threads.map(thread => thread.key).sort(), ["inbox:mail", "job:older"]);
  const governed = threads.find(thread => thread.key === "inbox:mail");
  assert.equal(governed?.kind, "job");
  assert.equal(governed?.item?.id, "mail");
  assert.equal(governed?.job?.id, "newer");
  assert.equal(governed?.title, "Hermes is handling mail");
  assert.equal(governed?.source, "Email · gmail · Hermes");
  assert.equal(governed?.updatedAt, "2026-09-14T10:30:00.000Z");
  assert.equal(governed?.group, "working");
});

test("a send problem stays in Needs you while Hermes work is active", () => {
  const [thread] = buildWorkThreads(
    [item("mail")],
    [job("active", { inboxId: "mail", state: "working" })],
    latestSendActions([sendAction("mail", "unknown")]),
    now,
  );

  assert.equal(thread?.key, "inbox:mail");
  assert.equal(thread?.job?.id, "active");
  assert.equal(thread?.group, "needs_you");
});

test("settled Inbox jobs stay in history without duplicating the Inbox thread", () => {
  const threads = buildWorkThreads(
    [item("mail")],
    [job("settled", { inboxId: "mail", state: "settled", outcome: "accepted" })],
    new Map(),
    now,
  );

  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.key, "inbox:mail");
  assert.equal(threads[0]?.kind, "inbox");
  assert.equal(threads[0]?.job, null);
});

test("task-linked jobs remain separate even when they also reference an Inbox item", () => {
  const threads = buildWorkThreads(
    [item("mail")],
    [job("task-job", { inboxId: "mail", taskId: "task-1", state: "working" })],
    new Map(),
    now,
  );

  assert.deepEqual(threads.map(thread => thread.key).sort(), ["inbox:mail", "job:task-job"]);
  assert.equal(threads.find(thread => thread.key === "inbox:mail")?.job, null);
  assert.equal(threads.find(thread => thread.key === "job:task-job")?.job?.id, "task-job");
});

test("the newest send action wins and drives the label", () => {
  const actions = [sendAction("mail", "failed", "2026-09-14T09:00:00.000Z"), sendAction("mail", "succeeded", "2026-09-14T09:30:00.000Z")];
  assert.equal(latestSendActions(actions).get("mail")?.state, "succeeded");
  assert.equal(inboxStateLabel(item("mail", { state: "waiting", snoozedUntil: "2026-09-14T11:00:00.000Z" }), "disabled", now), "Ready");
  assert.equal(inboxStateLabel(item("mail"), "sending", now), "Sending");
  assert.equal(jobStateLabel(job("review", { state: "review" })), "Review");
});

test("Hermes cron mirrors are routines, not Inbox threads", () => {
  const threads = buildWorkThreads(
    [item("decision"), item("routine", { source: { kind: "hermes", reference: "cron:abc123" } })],
    [],
    new Map(),
    now,
  );
  assert.deepEqual(threads.map(thread => thread.key), ["inbox:decision"]);
  assert.equal(isRoutineMirror({ source: { kind: "hermes", reference: "cron:camille:abc" } }), true);
  assert.equal(isRoutineMirror({ source: { kind: "hermes", reference: "email:abc" } }), false);
});

test("job status, shelf and attention follow the T3 rules, including an early wake", () => {
  assert.deepEqual(jobPresentation(job("asking", { state: "needs_you", question: "Which?" }), now),
    { shelf: "active", status: "Awaiting input", tone: "input", attention: true });
  assert.deepEqual(jobPresentation(job("done", { state: "review", resultKind: "complete" }), now),
    { shelf: "active", status: "Completed", tone: "done", attention: false });
  assert.deepEqual(jobPresentation(job("failed", { state: "review", resultKind: "failed" }), now),
    { shelf: "active", status: "Failed", tone: "failed", attention: true });
  assert.equal(jobPresentation(job("settled", { state: "settled", outcome: "accepted" }), now).shelf, "settled");

  const snoozed = { state: "needs_you" as const, question: "Which?", snoozedUntil: "2026-09-15T08:00:00.000Z", snoozedAt: "2026-09-14T11:00:00.000Z" };
  assert.equal(jobPresentation(job("quiet", { ...snoozed, attentionAt: "2026-09-14T10:30:00.000Z" }), now).shelf, "snoozed");
  // the agent asked again after the snooze, so the thread raises its hand early
  assert.deepEqual(jobPresentation(job("raised", { ...snoozed, attentionAt: "2026-09-14T11:30:00.000Z" }), now),
    { shelf: "active", status: "Woke", tone: "input", attention: true });
  // a snoozed thread that is still working wakes back to Working, not to a decision
  assert.deepEqual(jobPresentation(job("busy", { state: "working", snoozedUntil: "2026-09-14T11:00:00.000Z", snoozedAt: "2026-09-14T10:00:00.000Z" }), now),
    { shelf: "active", status: "Woke", tone: "working", attention: false });
});

test("active threads are ordered newest first by creation, not by their last update", () => {
  const threads = buildWorkThreads(
    [],
    [
      job("older-but-busy", { createdAt: "2026-09-14T08:00:00.000Z", updatedAt: "2026-09-14T11:59:00.000Z" }),
      job("newer", { createdAt: "2026-09-14T09:00:00.000Z", updatedAt: "2026-09-14T09:00:00.000Z" }),
    ],
    new Map(),
    now,
  );
  assert.deepEqual(threads.map(thread => thread.key), ["job:newer", "job:older-but-busy"]);
});
