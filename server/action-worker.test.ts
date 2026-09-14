import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { createInitialData } from '../src/model.ts';
import type { TaskStatusExecutionResult } from './action-worker.ts';
import { createTaskStatusActionWorker } from './action-worker.ts';
import { createApp } from './app.ts';
import { openStore, type Store } from './store.ts';

const FIRST_OBSERVATION = '2026-09-14T09:00:00.000Z';
const OWNER_CLICK = '2026-09-14T10:00:00.000Z';

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
      connectionId: 'google-account',
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
      connectionId: 'google-account',
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
