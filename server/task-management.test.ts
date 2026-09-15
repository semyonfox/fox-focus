import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HermesFeed } from '../src/hermes-model.ts';
import { createInitialData } from '../src/model.ts';
import { openStore, type ImportedRecord } from './store.ts';
import {
  TaskManagementError,
  adoptedTaskIdForRecord,
  previewHermesTaskAdoption,
  previewProviderTaskAdoption,
  previewTaskAction,
  taskStatusProjection,
} from './task-management.ts';

const now = new Date('2026-09-13T10:00:00.000Z');

function providerTask(overrides: Partial<ImportedRecord> = {}): ImportedRecord {
  return {
    provider: 'google',
    connectionId: 'google-connection-1',
    kind: 'task',
    containerId: 'personal-list',
    containerName: 'Personal',
    externalId: 'google-task-1',
    title: 'Renew library book',
    status: 'needsAction',
    startsAt: null,
    endsAt: null,
    startsOn: null,
    endsOn: null,
    allDay: false,
    dueOn: '2026-09-14',
    completedAt: null,
    sourceUpdatedAt: '2026-09-12T09:00:00.000Z',
    sourceVersion: 'etag-1',
    completionWritable: true,
    sourceUrl: null,
    sourceTimeZone: null,
    ...overrides,
  };
}

function connectGoogle(store: ReturnType<typeof openStore>) {
  store.saveConnection({
    provider: 'google', connectionId: 'google-connection-1', state: 'connected', scopes: ['https://www.googleapis.com/auth/tasks'],
    tokenEnvelope: null, connectedAt: now.toISOString(), updatedAt: now.toISOString(), lastSyncedAt: null, lastError: null,
  });
}

test('adopts an imported task once and keeps it after the provider snapshot disappears', () => {
  const store = openStore(':memory:', createInitialData());
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [providerTask()]);
    const record = store.listProviderRecords()[0];
    const preview = previewProviderTaskAdoption(store, record.id, now);
    assert.equal(preview.before.ownership, 'google');
    assert.equal(preview.task.deadlineDate, undefined);
    assert.equal(preview.task.due, 'Tomorrow');
    assert.equal(preview.task.externalLinks?.[0].policy, 'completion_only');

    const approved = store.approveTaskAdoption(preview.id, '2026-09-13T10:01:00.000Z');
    assert.ok(approved);
    assert.equal(store.read().data.tasks.length, 1);
    assert.equal(adoptedTaskIdForRecord(store, store.read(), record), approved.adoptedTaskId);
    assert.equal(store.approveTaskAdoption(preview.id, '2026-09-13T10:02:00.000Z')?.adoptedTaskId, approved.adoptedTaskId);
    assert.equal(store.read().data.tasks.length, 1);
    assert.throws(() => previewProviderTaskAdoption(store, record.id, now), (error: unknown) =>
      error instanceof TaskManagementError && error.code === 'already_adopted');

    store.replaceProviderRecords('google', []);
    assert.equal(store.read().data.tasks[0].title, 'Renew library book');
  } finally {
    store.close();
  }
});

test('adopts Hermes as read-only provenance without depending on Hermes afterwards', () => {
  const feed: HermesFeed = {
    state: 'connected',
    checkedAt: now.toISOString(),
    board: {
      slug: 'personal-tasks',
      name: 'Personal Tasks',
      total: 1,
      sources: ['Direct request'],
      tasks: [{
        id: 't_aaaaaaaa',
        title: 'Prepare timetable',
        status: 'scheduled',
        priority: 4,
        createdAt: '2026-09-11T08:00:00.000Z',
        updatedAt: '2026-09-12T08:00:00.000Z',
        version: 1,
        owner: 'human',
        source: 'Direct request',
        parentTitle: null,
        sourceProvider: null,
        sourceExternalId: null,
        sourceDueOn: null,
        sourceStatus: null,
        sourceContainerId: null,
        sourceContainerName: null,
        sourceMatchUnique: false,
        area: 'Personal',
        localState: 'scheduled',
        duration: '30 min',
        due: 'Tomorrow',
        scheduledAt: '2026-09-14T08:00:00.000Z',
        reminderMode: 'none',
        reminderFireAt: null,
        annotationUpdatedAt: null,
      }],
    },
  };
  const store = openStore(':memory:');
  try {
    connectGoogle(store);
    const preview = previewHermesTaskAdoption(store, feed, 't_aaaaaaaa', now);
    assert.equal(preview.task.priority, 'high');
    assert.equal(preview.task.externalLinks?.[0].policy, 'read_only');
    const hermesAdoption = store.approveTaskAdoption(preview.id, '2026-09-13T10:01:00.000Z');
    assert.ok(hermesAdoption);
    const hermesTask = store.read().data.tasks[0];
    assert.equal(hermesTask.source, 'Hermes · Direct request');

    store.replaceProviderRecords('google', [providerTask({
      title: 'Provider wording must not replace the native task',
      dueOn: '2026-10-01',
    })]);
    const providerAdoption = previewProviderTaskAdoption(
      store,
      store.listProviderRecords()[0].id,
      now,
      hermesAdoption.adoptedTaskId,
    );
    assert.equal(providerAdoption.before.targetTaskId, hermesAdoption.adoptedTaskId);
    assert.equal(providerAdoption.task.id, hermesTask.id);
    assert.deepEqual({
      title: providerAdoption.task.title,
      area: providerAdoption.task.area,
      state: providerAdoption.task.state,
      duration: providerAdoption.task.duration,
      due: providerAdoption.task.due,
      priority: providerAdoption.task.priority,
      completed: providerAdoption.task.completed,
      origin: providerAdoption.task.origin,
      source: providerAdoption.task.source,
      createdAt: providerAdoption.task.createdAt,
    }, {
      title: hermesTask.title,
      area: hermesTask.area,
      state: hermesTask.state,
      duration: hermesTask.duration,
      due: hermesTask.due,
      priority: hermesTask.priority,
      completed: hermesTask.completed,
      origin: hermesTask.origin,
      source: hermesTask.source,
      createdAt: hermesTask.createdAt,
    });
    assert.deepEqual(providerAdoption.task.externalLinks?.map(link => link.provider), ['hermes', 'google_tasks']);

    const approvedProvider = store.approveTaskAdoption(providerAdoption.id, '2026-09-13T10:02:00.000Z');
    assert.ok(approvedProvider);
    const finalTasks = store.read().data.tasks;
    assert.equal(finalTasks.length, 1);
    assert.equal(finalTasks[0].id, hermesAdoption.adoptedTaskId);
    assert.equal(finalTasks[0].title, 'Prepare timetable');
    assert.equal(finalTasks[0].source, 'Hermes · Direct request');
    assert.deepEqual(finalTasks[0].externalLinks?.map(link => link.provider), ['hermes', 'google_tasks']);
  } finally {
    store.close();
  }
});

test('an older-generation source link requires explicit selection of its existing native task', () => {
  const store = openStore(':memory:', {
    tasks: [{
      id: 'existing-native-task', title: 'Keep this native task', area: 'University', state: 'waiting', duration: '1 hr',
      due: 'Waiting', priority: 'high', completed: false, scheduledTime: null, origin: 'migration',
      source: 'Hermes · Direct request', createdAt: '2026-09-01T09:00:00.000Z',
      externalLinks: [{
        provider: 'google_tasks', connectionId: 'older-google-generation', containerId: 'personal-list',
        containerName: 'Personal', externalId: 'google-task-1', policy: 'completion_only', sourceStatus: 'needsAction',
        sourceVersion: 'old-etag', linkedAt: '2026-09-01T09:00:00.000Z',
      }],
    }],
    events: [], inboxItems: [], reminders: [],
  });
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [providerTask()]);
    const record = store.listProviderRecords()[0];
    assert.throws(
      () => previewProviderTaskAdoption(store, record.id, now),
      (error: unknown) => error instanceof TaskManagementError && error.code === 'invalid_source',
    );

    const reconciliation = previewProviderTaskAdoption(store, record.id, now, 'existing-native-task');
    assert.equal(reconciliation.task.id, 'existing-native-task');
    assert.equal(reconciliation.task.title, 'Keep this native task');
    assert.equal(reconciliation.task.source, 'Hermes · Direct request');
    const googleLinks = reconciliation.task.externalLinks?.filter(link => link.provider === 'google_tasks') ?? [];
    assert.equal(googleLinks.length, 1);
    assert.equal(googleLinks[0].connectionId, 'google-connection-1');
    assert.equal(googleLinks[0].sourceVersion, 'etag-1');

    const approved = store.approveTaskAdoption(reconciliation.id, '2026-09-13T10:01:00.000Z');
    assert.ok(approved);
    assert.equal(store.read().data.tasks.length, 1);
    assert.equal(approved.adoptedTaskId, 'existing-native-task');
  } finally {
    store.close();
  }
});

test('completion preview records exact states and an old failure cannot replace a newer status intent', () => {
  const store = openStore(':memory:');
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [providerTask()]);
    const adoption = previewProviderTaskAdoption(store, store.listProviderRecords()[0].id, now);
    const adopted = store.approveTaskAdoption(adoption.id, '2026-09-13T10:01:00.000Z');
    assert.ok(adopted);
    const reminderSnapshot = store.read();
    assert.ok(store.save(reminderSnapshot.revision, {
      ...reminderSnapshot.data,
      reminders: [{
        id: 'reminder-1', targetId: adopted.adoptedTaskId, targetType: 'task', title: 'Renew library book',
        mode: 'one-hour', when: '2026-09-14T08:00:00.000Z', state: 'scheduled',
      }],
    }));
    const action = previewTaskAction(store, adopted.adoptedTaskId, 'completed', 'complete-once-1', now);
    assert.deepEqual(action.before.google, {
      connection: 'Google connection google-c', list: 'Personal', taskId: 'google-task-1',
      title: 'Renew library book', state: 'needsAction', version: 'etag-1',
    });
    assert.deepEqual(action.after.google, {
      connection: 'Google connection google-c', list: 'Personal', taskId: 'google-task-1',
      title: 'Renew library book', state: 'completed',
    });
    const started = store.beginTaskAction(action.id, '2026-09-13T10:02:00.000Z');
    assert.ok(started);
    assert.equal(started.snapshot.data.tasks[0].completed, true);
    assert.deepEqual(started.snapshot.data.reminders, []);
    store.finishTaskAction(action.id, 'failed', { retryable: true }, 'Network unavailable', '2026-09-13T10:03:00.000Z');
    assert.equal(store.read().data.tasks[0].completed, true);
    assert.equal(store.getTaskAction(action.id)?.status, 'failed');
    const reopen = previewTaskAction(store, adopted.adoptedTaskId, 'open', 'newer-reopen-1', new Date('2026-09-13T10:04:00.000Z'));
    assert.equal(store.beginTaskAction(reopen.id, '2026-09-13T10:04:01.000Z')?.outcome, 'started');
    store.finishTaskAction(reopen.id, 'succeeded', { retryable: false }, null, '2026-09-13T10:04:02.000Z');
    const completeAgain = previewTaskAction(
      store,
      adopted.adoptedTaskId,
      'completed',
      'newer-complete-1',
      new Date('2026-09-13T10:05:00.000Z'),
    );
    assert.equal(store.beginTaskAction(completeAgain.id, '2026-09-13T10:05:01.000Z')?.outcome, 'started');
    store.finishTaskAction(completeAgain.id, 'succeeded', { retryable: false }, null, '2026-09-13T10:05:02.000Z');
    assert.equal(store.read().data.tasks[0].completed, true, 'the final state deliberately matches the old failed action');

    const retried = store.beginTaskAction(action.id, '2026-09-13T10:06:00.000Z', true);
    assert.equal(retried?.outcome, 'conflict');
    assert.match(retried?.action.lastError ?? '', /newer task status intent/i);
    assert.equal(store.read().data.tasks[0].completed, true);
  } finally {
    store.close();
  }
});

test('an imported ETag change after preview becomes a recorded conflict', () => {
  const store = openStore(':memory:');
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [providerTask()]);
    const adoption = previewProviderTaskAdoption(store, store.listProviderRecords()[0].id, now);
    const adopted = store.approveTaskAdoption(adoption.id, '2026-09-13T10:01:00.000Z');
    assert.ok(adopted);
    const action = previewTaskAction(store, adopted.adoptedTaskId, 'completed', 'etag-changed-1', now);

    store.replaceProviderRecords('google', [providerTask({ sourceVersion: 'etag-2', sourceUpdatedAt: '2026-09-13T10:01:30.000Z' })]);
    const result = store.beginTaskAction(action.id, '2026-09-13T10:02:00.000Z');

    assert.equal(result?.outcome, 'conflict');
    assert.equal(result?.action.status, 'conflict');
    assert.match(result?.action.lastError ?? '', /changed after this preview/i);
    assert.equal(store.read().data.tasks[0].completed, false);
  } finally {
    store.close();
  }
});

test('exact task actions do not depend on the provider overview record limit', () => {
  const store = openStore(':memory:');
  try {
    connectGoogle(store);
    const calendarRecords: ImportedRecord[] = Array.from({ length: 320 }, (_, index) => ({
      provider: 'google', connectionId: 'google-connection-1', kind: 'calendar_event',
      containerId: 'calendar-1', containerName: 'Calendar', externalId: `event-${index}`,
      title: `Event ${index}`, status: 'active', startsAt: `2026-09-${String(1 + (index % 28)).padStart(2, '0')}T09:00:00.000Z`,
      endsAt: `2026-09-${String(1 + (index % 28)).padStart(2, '0')}T09:30:00.000Z`, startsOn: null, endsOn: null,
      allDay: false, dueOn: null, completedAt: null, sourceUpdatedAt: null, sourceUrl: null, sourceTimeZone: null,
    }));
    store.replaceProviderRecords('google', [...calendarRecords, providerTask()]);
    assert.equal(store.listProviderRecords(300).some(record => record.kind === 'task'), true);
    assert.equal(store.countProviderRecords('google', 'calendar_event'), 320);
    const taskRecord = store.listProviderRecords(10, 'task')[0];
    assert.ok(taskRecord);
    const adoption = previewProviderTaskAdoption(store, taskRecord.id, now);
    const adopted = store.approveTaskAdoption(adoption.id, '2026-09-13T10:01:00.000Z');
    assert.ok(adopted);
    assert.equal(previewTaskAction(store, adopted.adoptedTaskId, 'completed', 'beyond-list-limit-1', now).expectedVersion, 'etag-1');
  } finally {
    store.close();
  }
});

test('a Google assigned task is adopted read-only and cannot create a completion action', () => {
  const store = openStore(':memory:');
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [providerTask({
      externalId: 'assigned-task-1',
      title: 'Source-managed assignment',
      completionWritable: false,
    })]);
    const stored = store.listProviderRecords()[0];
    assert.equal(stored.completionWritable, false);

    const adoption = previewProviderTaskAdoption(store, stored.id, now);
    assert.equal(adoption.task.externalLinks?.[0].policy, 'read_only');
    const adopted = store.approveTaskAdoption(adoption.id, '2026-09-13T10:01:00.000Z');
    assert.ok(adopted);
    assert.throws(
      () => previewTaskAction(store, adopted.adoptedTaskId, 'completed', 'assigned-complete-1', now),
      (error: unknown) => error instanceof TaskManagementError && error.code === 'read_only',
    );
    assert.deepEqual(store.listTaskActions(adopted.adoptedTaskId), []);
  } finally {
    store.close();
  }
});

test('a crashed running action can resume only after its lease expires without repeating the local transition', () => {
  const store = openStore(':memory:');
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [providerTask()]);
    const adoption = previewProviderTaskAdoption(store, store.listProviderRecords()[0].id, now);
    const adopted = store.approveTaskAdoption(adoption.id, '2026-09-13T10:00:30.000Z');
    assert.ok(adopted);
    const action = previewTaskAction(store, adopted.adoptedTaskId, 'completed', 'crash-recovery-1', now);

    const firstAttempt = store.beginTaskAction(action.id, '2026-09-13T10:01:00.000Z');
    assert.ok(firstAttempt);
    assert.equal(firstAttempt.action.status, 'running');
    assert.equal(firstAttempt.action.attemptCount, 1);
    assert.equal(firstAttempt.action.leaseExpiresAt, '2026-09-13T10:03:00.000Z');
    assert.equal(firstAttempt.snapshot.data.tasks[0].completed, true);
    const revisionAfterLocalTransition = firstAttempt.snapshot.revision;

    assert.equal(store.beginTaskAction(action.id, '2026-09-13T10:02:59.999Z', true), null);
    const recovered = store.beginTaskAction(action.id, '2026-09-13T10:03:00.000Z', true);
    assert.ok(recovered);
    assert.equal(recovered.action.status, 'running');
    assert.equal(recovered.action.attemptCount, 2);
    assert.equal(recovered.action.approvedAt, '2026-09-13T10:01:00.000Z');
    assert.equal(recovered.action.leaseExpiresAt, '2026-09-13T10:05:00.000Z');
    assert.equal(recovered.action.connectionId, action.connectionId);
    assert.equal(recovered.action.containerId, action.containerId);
    assert.equal(recovered.action.externalId, action.externalId);
    assert.equal(recovered.action.expectedVersion, action.expectedVersion);
    assert.equal(recovered.snapshot.revision, revisionAfterLocalTransition);
    assert.equal(recovered.snapshot.data.tasks[0].completed, true);
  } finally {
    store.close();
  }
});

test('only one non-expired action can run for a linked task', () => {
  const store = openStore(':memory:');
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [providerTask()]);
    const adoption = previewProviderTaskAdoption(store, store.listProviderRecords()[0].id, now);
    const adopted = store.approveTaskAdoption(adoption.id, '2026-09-13T10:00:30.000Z');
    assert.ok(adopted);
    const first = previewTaskAction(store, adopted.adoptedTaskId, 'open', 'overlap-first-1', now);
    const second = previewTaskAction(store, adopted.adoptedTaskId, 'completed', 'overlap-second-1', now);

    assert.equal(store.beginTaskAction(first.id, '2026-09-13T10:01:00.000Z')?.outcome, 'started');
    const blocked = store.beginTaskAction(second.id, '2026-09-13T10:01:01.000Z');
    assert.equal(blocked?.outcome, 'conflict');
    assert.match(blocked?.action.lastError ?? '', /still running/i);
    assert.throws(
      () => previewTaskAction(store, adopted.adoptedTaskId, 'open', 'overlap-third-1', new Date('2026-09-13T10:01:02.000Z')),
      (error: unknown) => error instanceof TaskManagementError && error.code === 'action_in_progress',
    );
  } finally {
    store.close();
  }
});

test('status projection exposes only native task planning fields', () => {
  const store = openStore(':memory:');
  try {
    connectGoogle(store);
    store.replaceProviderRecords('google', [providerTask()]);
    const adoption = previewProviderTaskAdoption(store, store.listProviderRecords()[0].id, now);
    store.approveTaskAdoption(adoption.id, '2026-09-13T10:01:00.000Z');
    const status = taskStatusProjection(store.read(), '2026-09-13T10:02:00.000Z');
    assert.equal(status.counts.open, 1);
    assert.equal(status.tasks[0].deadlineDate, null);
    assert.ok(!JSON.stringify(status).includes('google-task-1'));
    assert.ok(!JSON.stringify(status).includes('etag-1'));
  } finally {
    store.close();
  }
});
