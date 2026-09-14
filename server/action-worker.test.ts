import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { createInitialData } from '../src/model.ts';
import type { ActionRow } from '../src/row-model.ts';
import type {
  TaskActionExecutor,
  TaskCreateExecutionResult,
  TaskCreateExecutor,
  TaskStatusExecutionResult,
} from './action-worker.ts';
import { createTaskStatusActionWorker } from './action-worker.ts';
import { createApp } from './app.ts';
import type { TaskCreateClaim, TaskCreateSettlement } from './row-store.ts';
import { openStore, type Store } from './store.ts';

const FIRST_OBSERVATION = '2026-09-14T09:00:00.000Z';
const OWNER_CLICK = '2026-09-14T10:00:00.000Z';

const unusedTaskCreateExecutor: TaskCreateExecutor = {
  createGoogleTask: async () => ({ outcome: 'failed', notice: 'unused', retryable: false }),
  reconcileGoogleTaskCreate: async () => ({ outcome: 'unknown', notice: 'unused' }),
};

function addGoogleTask(store: Store) {
  store.publishProviderScope({
    provider: 'google',
    resourceKind: 'task-list',
    accountId: 'google-account',
    connectionGeneration: 'google-account',
    containerId: 'my-tasks',
    containerName: 'My Tasks',
    records: [{
      provider: 'google',
      kind: 'task',
      accountId: 'google-account',
      containerId: 'my-tasks',
      containerName: 'My Tasks',
      externalId: 'google-task-1',
      title: 'Book dentist',
      status: 'needsAction',
      startsAt: null,
      endsAt: null,
      startsOn: null,
      endsOn: null,
      allDay: false,
      dueOn: '2026-09-21',
      completedAt: null,
      sourceUpdatedAt: FIRST_OBSERVATION,
      sourceVersion: 'etag-1',
      completionWritable: true,
      notes: 'Call in the morning',
      parentId: null,
      position: '0001',
      sourceUrl: 'https://tasks.google.com/task/1',
      sourceTimeZone: null,
    }],
    coverageFrom: null,
    coverageTo: null,
    fetchedAt: FIRST_OBSERVATION,
  });
  const task = store.listTasks()[0];
  assert.ok(task);
  return task;
}

function claimedTaskCreateAction(input: {
  claimId?: string;
  attemptCount?: number;
  receipt?: Record<string, unknown> | null;
  version?: number;
} = {}): TaskCreateClaim['action'] {
  return {
    id: 'create-action-1',
    version: input.version ?? 2,
    payload: {
      kind: 'task-create',
      taskId: 'local-task-1',
      destination: { accountId: 'google-account', listId: 'my-tasks' },
      nonce: 'create-nonce-1',
      title: 'Book dentist',
      notes: 'Call in the morning\n\nFox-Focus-ID: create-nonce-1',
      doOn: '2026-09-21',
    },
    operationKey: 'task-create:create-nonce-1',
    requestHash: 'request-hash',
    approval: {
      actor: 'owner',
      at: OWNER_CLICK,
      previewText: 'Create "Book dentist" in My Tasks',
    },
    state: 'running',
    attemptCount: input.attemptCount ?? 1,
    nextAttemptAt: null,
    claimId: input.claimId ?? 'create-claim-1',
    leaseUntil: '2026-09-14T10:02:00.000Z',
    receipt: input.receipt ?? null,
    error: null,
    createdAt: OWNER_CLICK,
    updatedAt: OWNER_CLICK,
  };
}

function actionAfterCreateSettlement(
  action: TaskCreateClaim['action'],
  result: TaskCreateSettlement,
): ActionRow {
  const state = result.outcome === 'succeeded'
    ? 'succeeded'
    : result.outcome === 'conflict'
      ? 'conflict'
      : result.outcome === 'unknown'
        ? 'unknown'
        : 'failed';
  const receipt = result.outcome === 'succeeded'
    ? { providerId: result.externalId, sourceVersion: result.current.version }
    : result.outcome === 'unknown' && result.candidateExternalId
      ? { candidateExternalId: result.candidateExternalId }
      : null;
  return {
    ...action,
    version: action.version + 1,
    state,
    claimId: null,
    leaseUntil: null,
    receipt,
    error: result.outcome === 'succeeded' ? null : result.notice,
  };
}

const unusedTaskStatusExecutor: Pick<TaskActionExecutor, 'updateGoogleTaskCompletion'> = {
  updateGoogleTaskCompletion: async () => ({
    outcome: 'failed',
    notice: 'unused',
    retryable: false,
  }),
};

type TaskCreateReadback = Extract<TaskCreateExecutionResult, { outcome: 'succeeded' }>['current'];

function createdTaskReadback(
  version: string | null = 'etag-created',
  updatedAt: string | null = '2026-09-14T10:00:01.000Z',
): TaskCreateReadback {
  return {
    title: 'Book dentist',
    notes: 'Call in the morning\n\nFox-Focus-ID: create-nonce-1',
    state: 'open',
    completedAt: null,
    dueOn: '2026-09-21',
    parentId: null,
    position: '0001',
    sourceUrl: 'https://tasks.google.com/task/created',
    version,
    updatedAt,
    completionWritable: true,
  };
}

test('an owner checkbox click stores approval and queues the row action without a preview', async () => {
  const store = openStore(':memory:', createInitialData());
  const password = 'test-password-at-least-24-characters';
  const authorization = `Basic ${Buffer.from(`fox:${password}`).toString('base64')}`;
  let kicks = 0;
  try {
    const task = addGoogleTask(store);
    const app = createApp(store, password, undefined, undefined, {
      now: () => new Date(OWNER_CLICK),
      actionWorker: { kick: () => { kicks += 1; } },
    });
    const response = await app.request(`/api/v1/tasks/${encodeURIComponent(task.id)}/status`, {
      method: 'POST',
      headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: task.version, state: 'completed' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { action: { id: string }; task: { version: number } };
    const action = store.getAction(body.action.id);
    assert.equal(kicks, 1);
    assert.equal(body.task.version, task.version + 1);
    assert.equal(action?.state, 'queued');
    assert.deepEqual(action?.payload, {
      kind: 'task-status',
      taskId: task.id,
      target: { accountId: 'google-account', listId: 'my-tasks', externalId: 'google-task-1' },
      expectedTaskVersion: task.version,
      intentVersion: 1,
      expectedEtag: 'etag-1',
      before: 'open',
      after: 'completed',
    });
    assert.match(action?.approval.previewText ?? '', /open -> completed.*google-account.*my-tasks.*google-task-1/);
    assert.equal(store.getTask(task.id)?.observed?.status, 'open', 'pending intent must not replace observed Google state');

    const stale = await app.request(`/api/v1/tasks/${encodeURIComponent(task.id)}/status`, {
      method: 'POST',
      headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: task.version, state: 'open' }),
    });
    assert.equal(stale.status, 409);
  } finally {
    store.close();
  }
});

test('task status worker passes the imported ETag and stores the verified readback', async () => {
  const store = openStore(':memory:', createInitialData());
  try {
    const task = addGoogleTask(store);
    const queued = store.queueTaskStatusAction(task.id, task.version, 'completed', OWNER_CLICK);
    assert.equal(queued.outcome, 'queued');
    const calls: Array<Record<string, unknown>> = [];
    const worker = createTaskStatusActionWorker(store, {
      ...unusedTaskCreateExecutor,
      updateGoogleTaskCompletion: async input => {
        calls.push(input);
        return {
          outcome: 'succeeded',
          sourceStatus: 'completed',
          sourceVersion: 'etag-2',
          sourceUpdatedAt: '2026-09-14T10:00:01.000Z',
          completedAt: '2026-09-14T10:00:00.000Z',
          current: {
            title: 'Book dentist this week',
            notes: 'Use the online form',
            state: 'completed',
            completedAt: '2026-09-14T10:00:00.000Z',
            dueOn: '2026-09-23',
            parentId: 'health-parent',
            position: '0003',
            sourceUrl: 'https://tasks.google.com/task/1',
            version: 'etag-2',
            updatedAt: '2026-09-14T10:00:01.000Z',
            completionWritable: true,
          },
        };
      },
    }, { now: () => new Date(OWNER_CLICK) });

    const settled = await worker.runOnce();

    assert.deepEqual(calls, [{
      accountId: 'google-account',
      containerId: 'my-tasks',
      externalId: 'google-task-1',
      desiredState: 'completed',
      expectedVersion: 'etag-1',
    }]);
    assert.equal(settled?.state, 'succeeded');
    assert.equal(settled?.attemptCount, 1);
    assert.deepEqual(settled?.receipt, {
      providerId: 'google-task-1',
      verifiedAt: OWNER_CLICK,
      sourceVersion: 'etag-2',
    });
    const updated = store.getTask(task.id);
    assert.equal(updated?.observed?.status, 'completed');
    assert.equal(updated?.observed?.etag, 'etag-2');
    assert.equal(updated?.observed?.observedAt, '2026-09-14T10:00:01.000Z');
    assert.equal(updated?.observed?.completedAt, '2026-09-14T10:00:00.000Z');
    assert.equal(updated?.observed?.title, 'Book dentist this week');
    assert.equal(updated?.observed?.notes, 'Use the online form');
    assert.equal(updated?.observed?.doOn, '2026-09-23');
    assert.equal(updated?.observed?.parentId, 'health-parent');
    assert.equal(updated?.observed?.position, '0003');
  } finally {
    store.close();
  }
});

test('task status worker stores the current remote task when an ETag conflicts', async () => {
  const store = openStore(':memory:', createInitialData());
  try {
    const task = addGoogleTask(store);
    const queued = store.queueTaskStatusAction(task.id, task.version, 'completed', OWNER_CLICK);
    assert.equal(queued.outcome, 'queued');
    const worker = createTaskStatusActionWorker(store, {
      ...unusedTaskCreateExecutor,
      updateGoogleTaskCompletion: async () => ({
        outcome: 'conflict',
        notice: 'The Google task changed after it was imported.',
        current: {
          title: 'Book dentist and optician',
          notes: 'Remote edit',
          state: 'open',
          completedAt: null,
          dueOn: '2026-09-22',
          parentId: 'health',
          position: '0002',
          sourceUrl: 'https://tasks.google.com/task/1',
          version: 'etag-remote',
          updatedAt: '2026-09-14T10:00:02.000Z',
          completionWritable: true,
        },
      }),
    }, { now: () => new Date(OWNER_CLICK) });

    const settled = await worker.runOnce();

    assert.equal(settled?.state, 'conflict');
    assert.equal(settled?.error, 'The Google task changed after it was imported.');
    assert.deepEqual(settled?.receipt, {
      conflict: {
        title: 'Book dentist and optician',
        notes: 'Remote edit',
        state: 'open',
        completedAt: null,
        dueOn: '2026-09-22',
        parentId: 'health',
        position: '0002',
        sourceUrl: 'https://tasks.google.com/task/1',
        version: 'etag-remote',
        updatedAt: '2026-09-14T10:00:02.000Z',
        completionWritable: true,
      },
      verifiedAt: OWNER_CLICK,
    });
    const updated = store.getTask(task.id);
    assert.equal(updated?.observed?.title, 'Book dentist and optician');
    assert.equal(updated?.observed?.etag, 'etag-remote');
    assert.equal(updated?.observed?.doOn, '2026-09-22');
  } finally {
    store.close();
  }
});

test('a newer task intent supersedes an older failed action before it can retry', async () => {
  const store = openStore(':memory:', createInitialData());
  let currentTime = OWNER_CLICK;
  const results: TaskStatusExecutionResult[] = [
    { outcome: 'failed', notice: 'Temporary provider failure.', retryable: true },
    {
      outcome: 'succeeded',
      sourceStatus: 'needsAction',
      sourceVersion: 'etag-2',
      sourceUpdatedAt: '2026-09-14T10:00:02.000Z',
      completedAt: null,
    },
  ];
  let calls = 0;
  try {
    const task = addGoogleTask(store);
    const first = store.queueTaskStatusAction(task.id, task.version, 'completed', OWNER_CLICK);
    assert.equal(first.outcome, 'queued');
    const worker = createTaskStatusActionWorker(store, {
      ...unusedTaskCreateExecutor,
      updateGoogleTaskCompletion: async () => {
        const result = results[calls];
        calls += 1;
        assert.ok(result);
        return result;
      },
    }, { now: () => new Date(currentTime) });

    const failed = await worker.runOnce();
    assert.equal(failed?.state, 'failed');
    const currentTask = store.getTask(task.id);
    assert.ok(currentTask);
    const second = store.queueTaskStatusAction(task.id, currentTask.version, 'open', '2026-09-14T10:00:00.500Z');
    assert.equal(second.outcome, 'queued');
    assert.equal(store.getAction(first.action.id)?.state, 'superseded');

    currentTime = '2026-09-14T10:00:02.000Z';
    const succeeded = await worker.runOnce();
    assert.equal(succeeded?.id, second.action.id);
    assert.equal(succeeded?.state, 'succeeded');
    assert.equal(await worker.runOnce(), null);
    assert.equal(calls, 2, 'the obsolete failed action must not execute again');
  } finally {
    store.close();
  }
});

test('claiming recovers an expired lease after a worker restart', async () => {
  const store = openStore(':memory:', createInitialData());
  try {
    const task = addGoogleTask(store);
    const queued = store.queueTaskStatusAction(task.id, task.version, 'completed', OWNER_CLICK);
    assert.equal(queued.outcome, 'queued');
    const abandoned = store.claimNextTaskStatusAction(OWNER_CLICK, 1_000);
    assert.equal(abandoned?.state, 'running');
    assert.equal(abandoned?.attemptCount, 1);

    const worker = createTaskStatusActionWorker(store, {
      ...unusedTaskCreateExecutor,
      updateGoogleTaskCompletion: async () => ({
        outcome: 'succeeded',
        sourceStatus: 'completed',
        sourceVersion: 'etag-2',
        sourceUpdatedAt: '2026-09-14T10:00:02.000Z',
        completedAt: '2026-09-14T10:00:01.000Z',
      }),
    }, {
      now: () => new Date('2026-09-14T10:00:02.000Z'),
      leaseMilliseconds: 1_000,
    });

    const settled = await worker.runOnce();

    assert.equal(settled?.id, queued.action.id);
    assert.equal(settled?.state, 'succeeded');
    assert.equal(settled?.attemptCount, 2);
    const recovery = store.listChanges(0, 100).changes.find(change =>
      change.entityId === queued.action.id && change.details?.recovery === 'expired-lease');
    assert.ok(recovery);
  } finally {
    store.close();
  }
});

test('task create worker sends the approved payload once and stores the verified readback', async () => {
  const action = claimedTaskCreateAction();
  let available = true;
  const calls: Array<Record<string, unknown>> = [];
  const settlements: TaskCreateSettlement[] = [];
  const worker = createTaskStatusActionWorker({
    claimNextTaskStatusAction: () => null,
    settleTaskStatusAction: () => null,
    claimNextTaskCreateAction: (): TaskCreateClaim | null => {
      if (!available) return null;
      available = false;
      return { action, mode: 'create' };
    },
    settleTaskCreateAction: (
      _id: string,
      _claimId: string,
      result: TaskCreateSettlement,
      _now: string,
    ) => {
      settlements.push(result);
      return actionAfterCreateSettlement(action, result);
    },
  }, {
    ...unusedTaskStatusExecutor,
    createGoogleTask: async input => {
      calls.push(input);
      return {
        outcome: 'succeeded',
        externalId: 'google-task-created',
        current: createdTaskReadback(),
      };
    },
    reconcileGoogleTaskCreate: async () => ({ outcome: 'unknown', notice: 'unused' }),
  }, { now: () => new Date(OWNER_CLICK) });

  const settled = await worker.runOnce();

  assert.deepEqual(calls, [{
    accountId: 'google-account',
    containerId: 'my-tasks',
    title: 'Book dentist',
    notes: 'Call in the morning\n\nFox-Focus-ID: create-nonce-1',
    dueOn: '2026-09-21',
  }]);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.outcome, 'succeeded');
  assert.equal(settled?.state, 'succeeded');
  assert.equal(await worker.runOnce(), null);
});

test('an expired task create lease reconciles after a crash without another POST', async () => {
  const firstClaim = claimedTaskCreateAction({ claimId: 'create-claim-1', attemptCount: 1, version: 2 });
  const recoveredClaim = claimedTaskCreateAction({ claimId: 'reconcile-claim-2', attemptCount: 2, version: 4 });
  let claimCount = 0;
  let postCalls = 0;
  const reconcileCalls: Array<Record<string, unknown>> = [];
  const worker = createTaskStatusActionWorker({
    claimNextTaskStatusAction: () => null,
    settleTaskStatusAction: () => null,
    claimNextTaskCreateAction: (): TaskCreateClaim | null => {
      claimCount += 1;
      if (claimCount === 1) return { action: firstClaim, mode: 'create' };
      if (claimCount === 2) return { action: recoveredClaim, mode: 'reconcile' };
      return null;
    },
    settleTaskCreateAction: (
      _id: string,
      claimId: string,
      result: TaskCreateSettlement,
      _now: string,
    ) => {
      if (claimId === 'create-claim-1') throw new Error('worker stopped before settlement');
      return actionAfterCreateSettlement(recoveredClaim, result);
    },
  }, {
    ...unusedTaskStatusExecutor,
    createGoogleTask: async () => {
      postCalls += 1;
      return {
        outcome: 'succeeded',
        externalId: 'google-task-created',
        current: createdTaskReadback(),
      };
    },
    reconcileGoogleTaskCreate: async input => {
      reconcileCalls.push(input);
      return {
        outcome: 'succeeded',
        externalId: 'google-task-created',
        current: createdTaskReadback('etag-created', '2026-09-14T10:00:02.000Z'),
      };
    },
  }, { now: () => new Date(OWNER_CLICK) });

  await assert.rejects(worker.runOnce(), /worker stopped before settlement/);
  const settled = await worker.runOnce();

  assert.equal(postCalls, 1);
  assert.deepEqual(reconcileCalls, [{
    accountId: 'google-account',
    containerId: 'my-tasks',
    nonce: 'create-nonce-1',
  }]);
  assert.equal(settled?.state, 'succeeded');
});

test('a create readback without an ETag stays unknown and retains its candidate id', async () => {
  const action = claimedTaskCreateAction();
  let settlement: TaskCreateSettlement | null = null;
  const worker = createTaskStatusActionWorker({
    claimNextTaskStatusAction: () => null,
    settleTaskStatusAction: () => null,
    claimNextTaskCreateAction: () => ({ action, mode: 'create' }),
    settleTaskCreateAction: (
      _id: string,
      _claimId: string,
      result: TaskCreateSettlement,
      _now: string,
    ) => {
      settlement = result;
      return actionAfterCreateSettlement(action, result);
    },
  }, {
    ...unusedTaskStatusExecutor,
    createGoogleTask: async () => ({
      outcome: 'succeeded',
      externalId: 'unverified-google-task',
      current: createdTaskReadback(null, null),
    }),
    reconcileGoogleTaskCreate: async () => ({ outcome: 'unknown', notice: 'unused' }),
  }, { now: () => new Date(OWNER_CLICK) });

  await worker.runOnce();

  assert.deepEqual(settlement, {
    outcome: 'unknown',
    notice: 'Google returned the created task without an ETag. Reconciliation is required before any new insert.',
    candidateExternalId: 'unverified-google-task',
  });
});

test('the worker wakes due Inbox items once before draining actions', async () => {
  const wakeTimes: string[] = [];
  const worker = createTaskStatusActionWorker({
    wakeDueInboxItems: now => {
      wakeTimes.push(now);
      return 0;
    },
    claimNextTaskStatusAction: () => null,
    settleTaskStatusAction: () => null,
    claimNextTaskCreateAction: () => null,
    settleTaskCreateAction: () => null,
  }, {
    ...unusedTaskStatusExecutor,
    ...unusedTaskCreateExecutor,
  }, { now: () => new Date(OWNER_CLICK) });

  assert.equal(await worker.runUntilIdle(), 0);
  assert.deepEqual(wakeTimes, [OWNER_CLICK]);
});

test('accepting a linked job completes its Google task through the normal worker path', async () => {
  const store = openStore(':memory:', createInitialData());
  try {
    const task = addGoogleTask(store);
    const created = store.createJob({
      title: 'Finish the booking', instruction: 'Confirm the booking details.', taskId: task.id, inboxId: null,
    }, '2026-09-14T10:00:00.000Z');
    assert.equal(created.outcome, 'created');
    if (created.outcome !== 'created') return;
    const claim = store.claimJob(created.job.id, '2026-09-14T10:00:01.000Z', 120_000);
    assert.equal(claim.outcome, 'claimed');
    if (claim.outcome !== 'claimed') return;
    const review = store.postJobResult(created.job.id, claim.claimId, {
      kind: 'result', text: 'The booking details are confirmed.', url: null,
    }, '2026-09-14T10:00:02.000Z', 120_000);
    assert.equal(review.outcome, 'updated');
    if (review.outcome !== 'updated') return;
    const accepted = store.settleJob(
      created.job.id, review.job.version, 'accepted', '2026-09-14T10:00:03.000Z', task.version,
    );
    assert.equal(accepted.outcome, 'settled');
    if (accepted.outcome !== 'settled') return;
    assert.equal(accepted.action?.payload.kind, 'task-status');

    const worker = createTaskStatusActionWorker(store, {
      ...unusedTaskCreateExecutor,
      updateGoogleTaskCompletion: async input => ({
        outcome: 'succeeded', sourceStatus: 'completed', sourceVersion: 'etag-job-complete',
        sourceUpdatedAt: '2026-09-14T10:00:04.000Z', completedAt: '2026-09-14T10:00:04.000Z',
        current: {
          title: 'Book dentist', notes: 'Call in the morning', state: input.desiredState,
          completedAt: '2026-09-14T10:00:04.000Z', dueOn: '2026-09-21', parentId: null,
          position: '0001', sourceUrl: 'https://tasks.google.com/task/1', version: 'etag-job-complete',
          updatedAt: '2026-09-14T10:00:04.000Z', completionWritable: true,
        },
      }),
    }, { now: () => new Date('2026-09-14T10:00:04.000Z') });
    const settledAction = await worker.runOnce();
    assert.equal(settledAction?.state, 'succeeded');
    assert.equal(store.getTask(task.id)?.observed?.status, 'completed');
    assert.equal(store.getJob(created.job.id)?.outcome, 'accepted');
  } finally { store.close(); }
});
