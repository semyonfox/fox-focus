import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ASK_USER, GET_CONTEXT, SETTLE_THREAD, createAgentWorker, threadEntries, usageCostUsd, type AgentModelResponse } from './agent-worker.ts';
import { openStore } from './store.ts';

type Params = Parameters<Parameters<typeof createAgentWorker>[1]['create']>[0];

const usage = { input_tokens: 1_000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function text(value: string): AgentModelResponse {
  return { content: [{ type: 'text', text: value }], stop_reason: 'end_turn', model: 'claude-opus-5-5', usage };
}

function tool(id: string, name: string, input: Record<string, unknown> = {}): AgentModelResponse {
  return { content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id, name, input }], stop_reason: 'tool_use', model: 'claude-opus-5-5', usage };
}

function scriptedClient(responses: Array<AgentModelResponse | Error>) {
  const calls: Params[] = [];
  return {
    calls,
    client: {
      create: async (params: Params) => {
        calls.push(params);
        const next = responses.shift();
        if (!next) throw new Error('No scripted response left');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

function clock(start: string) {
  let current = Date.parse(start);
  return { now: () => new Date(current), advance: (milliseconds: number) => { current += milliseconds; } };
}

function createFoxJob(store: ReturnType<typeof openStore>, instruction: string, at: string) {
  const created = store.createJob({ title: 'Book the NCT test', instruction, taskId: null, inboxId: null, assistant: 'fox' }, at);
  assert.equal(created.outcome, 'created');
  if (created.outcome !== 'created') throw new Error('Job was not created');
  return created.job;
}

test('a Fox thread asks, survives a restart, takes the answer, completes, reopens and settles from chat', async () => {
  const store = openStore(':memory:');
  try {
    const time = clock('2026-11-04T10:00:00.000Z');
    const job = createFoxJob(store, 'Book my NCT before the end of the month', time.now().toISOString());

    const first = scriptedClient([
      tool('toolu_context', GET_CONTEXT),
      tool('toolu_ask', ASK_USER, { question: 'Which slot?', options: ['Thu 19 Nov 10:20', 'Mon 23 Nov 15:40'] }),
    ]);
    await createAgentWorker(store, first.client, { now: time.now }).runUntilIdle();
    const asking = store.getJob(job.id);
    assert.equal(asking?.state, 'needs_you');
    assert.deepEqual(asking?.prompt, { kind: 'choice', toolUseId: 'toolu_ask', question: 'Which slot?', options: ['Thu 19 Nov 10:20', 'Mon 23 Nov 15:40'] });
    assert.equal(asking?.claimId, null);
    assert.equal(first.calls.length, 2);
    assert.deepEqual(first.calls[0].tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    assert.equal(first.calls[0].fallbacks, 'default');
    // the context tool result reached the model on the second call
    const contextResult = first.calls[1].messages.at(-1);
    assert.equal(contextResult?.role, 'user');
    assert.ok(Array.isArray(contextResult?.content) && contextResult.content.some(block => block.type === 'tool_result'));

    // a fresh worker (the restart) has nothing to do while the thread waits on the owner
    const idle = scriptedClient([]);
    await createAgentWorker(store, idle.client, { now: time.now }).runUntilIdle();
    assert.equal(idle.calls.length, 0);

    time.advance(60_000);
    assert.ok(asking);
    const answered = store.answerJob(job.id, asking.version, 'Thu 19 Nov 10:20', time.now().toISOString());
    assert.equal(answered.outcome, 'updated');
    assert.equal(store.getJob(job.id)?.state, 'queued');
    const replay = store.answerJob(job.id, asking.version, 'Thu 19 Nov 10:20', time.now().toISOString());
    assert.equal(replay.outcome, 'replayed');
    const different = store.answerJob(job.id, asking.version, 'Mon 23 Nov 15:40', time.now().toISOString());
    assert.equal(different.outcome, 'idempotency_conflict');

    const second = scriptedClient([text('Held Thursday 19 November at 10:20.')]);
    await createAgentWorker(store, second.client, { now: time.now }).runUntilIdle();
    const complete = store.getJob(job.id);
    assert.equal(complete?.state, 'review');
    assert.equal(complete?.resultKind, 'complete');
    const answerResult = second.calls[0].messages.at(-1);
    assert.deepEqual(answerResult, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'Thu 19 Nov 10:20' }] });
    // thinking blocks are replayed unchanged, as the API requires
    assert.ok(second.calls[0].messages.some(message => message.role === 'assistant' && Array.isArray(message.content) &&
      message.content.some(block => block.type === 'thinking')));

    assert.deepEqual(threadEntries(store.listJobMessages(job.id)).map(entry => [entry.role, entry.kind, entry.text]), [
      ['owner', 'message', 'Book my NCT before the end of the month'],
      ['assistant', 'activity', 'Checked your tasks, calendar and Inbox'],
      ['assistant', 'question', 'Which slot?'],
      ['owner', 'answer', 'Thu 19 Nov 10:20'],
      ['assistant', 'message', 'Held Thursday 19 November at 10:20.'],
    ]);

    assert.ok(complete);
    const settledByOwner = store.settleJob(job.id, complete.version, 'accepted', time.now().toISOString());
    assert.equal(settledByOwner.outcome, 'settled');
    const reopened = store.sendBackJob(job.id, store.getJob(job.id)?.version ?? 0, "thanks, we're done", time.now().toISOString());
    assert.equal(reopened.outcome, 'updated');
    assert.equal(store.getJob(job.id)?.state, 'queued');

    const third = scriptedClient([tool('toolu_settle', SETTLE_THREAD)]);
    await createAgentWorker(store, third.client, { now: time.now }).runUntilIdle();
    assert.equal(store.getJob(job.id)?.state, 'settled');
    assert.equal(store.getJob(job.id)?.outcome, 'accepted');
    assert.equal(store.listActions().length, 0);
  } finally { store.close(); }
});

test('a stale worker that lost its lease cannot write over the run that reclaimed the thread', async () => {
  const store = openStore(':memory:');
  try {
    const time = clock('2026-11-04T10:00:00.000Z');
    const job = createFoxJob(store, 'Compare broadband offers', time.now().toISOString());
    let release: (value: AgentModelResponse) => void = () => undefined;
    const stalled = { create: () => new Promise<AgentModelResponse>(resolve => { release = resolve; }) };
    const stale = createAgentWorker(store, stalled, { now: time.now, leaseMilliseconds: 1_000 });
    stale.kick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.getJob(job.id)?.state, 'working');

    time.advance(5_000);
    const fresh = scriptedClient([text('Eir is cheaper for your usage.')]);
    await createAgentWorker(store, fresh.client, { now: time.now, leaseMilliseconds: 1_000 }).runUntilIdle();
    assert.equal(store.getJob(job.id)?.state, 'review');

    release(text('A late answer that must be discarded.'));
    await stale.runUntilIdle();
    const entries = threadEntries(store.listJobMessages(job.id));
    assert.deepEqual(entries.filter(entry => entry.role === 'assistant').map(entry => entry.text), ['Eir is cheaper for your usage.']);
    assert.equal(store.getJob(job.id)?.state, 'review');
  } finally { store.close(); }
});

test('failures, refusals and the spend cap end the run as a Failed thread that a reply can retry', async () => {
  const store = openStore(':memory:');
  try {
    const time = clock('2026-11-04T10:00:00.000Z');
    const failing = createFoxJob(store, 'First request', time.now().toISOString());
    await createAgentWorker(store, scriptedClient([new Error('network down')]).client, { now: time.now }).runUntilIdle();
    assert.equal(store.getJob(failing.id)?.resultKind, 'failed');
    assert.equal(store.getJob(failing.id)?.resultNote, 'The model request failed. Reply to try again.');

    const refused = createFoxJob(store, 'Second request', time.now().toISOString());
    await createAgentWorker(store, scriptedClient([{ ...text(''), content: [], stop_reason: 'refusal' }]).client, { now: time.now }).runUntilIdle();
    assert.equal(store.getJob(refused.id)?.resultNote, 'The model declined this request.');

    const capped = createFoxJob(store, 'Third request', time.now().toISOString());
    const capClient = scriptedClient([]);
    await createAgentWorker(store, capClient.client, { now: time.now, dailyBudgetUsd: 0.000_001 }).runUntilIdle();
    assert.equal(capClient.calls.length, 0);
    assert.equal(store.getJob(capped.id)?.resultKind, 'failed');
    assert.match(store.getJob(capped.id)?.resultNote ?? '', /spend cap/);

    const retry = store.sendBackJob(failing.id, store.getJob(failing.id)?.version ?? 0, 'try again', time.now().toISOString());
    assert.equal(retry.outcome, 'updated');
    const retried = scriptedClient([text('Done this time.')]);
    await createAgentWorker(store, retried.client, { now: time.now }).runUntilIdle();
    assert.equal(store.getJob(failing.id)?.resultKind, 'complete');
    assert.equal(store.getJob(failing.id)?.resultNote, null);
  } finally { store.close(); }
});

test('a malformed question is returned to the model instead of suspending the thread', async () => {
  const store = openStore(':memory:');
  try {
    const time = clock('2026-11-04T10:00:00.000Z');
    const job = createFoxJob(store, 'Plan my week', time.now().toISOString());
    const scripted = scriptedClient([
      tool('toolu_bad', ASK_USER, { question: 'Which?', options: ['Only one'] }),
      text('I planned it without asking.'),
    ]);
    await createAgentWorker(store, scripted.client, { now: time.now }).runUntilIdle();
    assert.equal(store.getJob(job.id)?.state, 'review');
    const errorResult = scripted.calls[1].messages.at(-1);
    assert.ok(Array.isArray(errorResult?.content) && errorResult.content.some(block => block.type === 'tool_result' && block.is_error === true));
  } finally { store.close(); }
});

test('Hermes never sees or claims Fox threads, and Hermes answers keep their one-line limit', () => {
  const store = openStore(':memory:');
  try {
    const at = '2026-11-04T10:00:00.000Z';
    const fox = createFoxJob(store, 'Private request', at);
    const hermes = store.createJob({ title: 'Hermes request', instruction: 'Check the timetable.', taskId: null, inboxId: null }, at);
    assert.equal(hermes.outcome, 'created');
    if (hermes.outcome !== 'created') return;
    assert.equal(hermes.job.assistant, 'hermes');
    assert.deepEqual(store.readContext('2026-11-01', '2026-11-30', at).jobs.map(job => job.id), [hermes.job.id]);
    assert.equal(store.claimJob(fox.id, at, 60_000).outcome, 'not_found');
    assert.equal(store.listJobMessages(hermes.job.id).length, 0);

    const claim = store.claimJob(hermes.job.id, at, 60_000);
    assert.equal(claim.outcome, 'claimed');
    if (claim.outcome !== 'claimed') return;
    const question = store.postJobResult(hermes.job.id, claim.claimId, { kind: 'question', text: 'Which week?', url: null }, at, 60_000);
    assert.equal(question.outcome, 'updated');
    if (question.outcome !== 'updated') return;
    assert.equal(store.answerJob(hermes.job.id, question.job.version, 'line one\nline two', at).outcome, 'invalid_input');
    assert.equal(store.answerJob(hermes.job.id, question.job.version, 'Next week', at).outcome, 'updated');
    assert.equal(store.getJob(hermes.job.id)?.state, 'working');
  } finally { store.close(); }
});

test('snoozing hides a thread without pausing it and rejects a wake time in the past', () => {
  const store = openStore(':memory:');
  try {
    const at = '2026-11-04T10:00:00.000Z';
    const job = createFoxJob(store, 'Remind me about the gala', at);
    assert.equal(store.snoozeJob(job.id, job.version, '2026-11-04T09:00:00.000Z', at).outcome, 'invalid_state');
    const snoozed = store.snoozeJob(job.id, job.version, '2026-11-05T09:00:00.000Z', at);
    assert.equal(snoozed.outcome, 'updated');
    if (snoozed.outcome !== 'updated') return;
    assert.equal(snoozed.job.state, 'queued');
    assert.equal(snoozed.job.snoozedAt, at);
    const cleared = store.snoozeJob(job.id, snoozed.job.version, null, at);
    assert.equal(cleared.outcome, 'updated');
    if (cleared.outcome === 'updated') assert.equal(cleared.job.snoozedAt, null);
  } finally { store.close(); }
});

test('an existing schema 11 jobs table gains the new columns and keeps its rows', () => {
  const path = `${process.env.TMPDIR ?? '/tmp'}/fox-focus-migration-${process.pid}-${Date.now()}.sqlite`;
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, version INTEGER NOT NULL, title TEXT NOT NULL, instruction TEXT NOT NULL,
    task_id TEXT, inbox_id TEXT, state TEXT NOT NULL, outcome TEXT, question TEXT, claim_id TEXT, lease_until TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  INSERT INTO jobs VALUES ('job-old', 1, 'Old', 'Old request', NULL, NULL, 'queued', NULL, NULL, NULL, NULL,
    '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z');`);
  legacy.close();
  const store = openStore(path);
  try {
    const job = store.getJob('job-old');
    assert.equal(job?.assistant, 'hermes');
    assert.equal(job?.prompt, null);
    assert.equal(job?.snoozedUntil, null);
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
});

test('spend is priced per model and unknown fallback models use the higher rate', () => {
  assert.equal(usageCostUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 }), 4);
  assert.equal(usageCostUsd('claude-opus-4-8', { input_tokens: 0, output_tokens: 1_000_000 }), 25);
  assert.equal(usageCostUsd(null, { input_tokens: -5, output_tokens: 'many' }), 0);
});

test('a reply after a cut-off tool call answers the dangling call before the new text', async () => {
  const store = openStore(':memory:');
  try {
    const time = clock('2026-11-04T10:00:00.000Z');
    const job = createFoxJob(store, 'Plan the gala', time.now().toISOString());
    const cut = { ...tool('toolu_cut', ASK_USER, { question: 'Which' }), stop_reason: 'max_tokens' };
    await createAgentWorker(store, scriptedClient([cut]).client, { now: time.now }).runUntilIdle();
    assert.equal(store.getJob(job.id)?.resultKind, 'failed');

    const reply = store.sendBackJob(job.id, store.getJob(job.id)?.version ?? 0, 'try a shorter plan', time.now().toISOString());
    assert.equal(reply.outcome, 'updated');
    const retried = scriptedClient([text('Short plan ready.')]);
    await createAgentWorker(store, retried.client, { now: time.now }).runUntilIdle();
    assert.deepEqual(retried.calls[0].messages.at(-1), { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_cut', is_error: true, content: 'Not run.' },
      { type: 'text', text: 'try a shorter plan' },
    ] });
    assert.equal(store.getJob(job.id)?.resultKind, 'complete');
  } finally { store.close(); }
});
