import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HermesFeed, HermesMirrorSnapshot } from '../src/hermes-model.ts';
import type { PrototypeData, Task } from '../src/model.ts';
import { createApp } from './app.ts';
import type {
  GoogleTaskDestinationCatalogue,
  IntegrationOverview,
  IntegrationService,
} from './integrations.ts';
import type { HermesMirrorService } from './hermes.ts';
import {
  buildTaskMigrationPreview,
  migrationIdForIdempotencyKey,
  summarizeTaskMigration,
} from './task-migration.ts';
import { openStore, type Store } from './store.ts';

const NOW = '2026-09-14T10:00:00.000Z';
const ACCOUNT_ID = 'google-subject-1';
const GENERATION = 'google-generation-1';
const LIST_ID = 'university-list';

function nativeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'native-task-1',
    title: 'Prepare lab notes',
    area: 'University',
    state: 'up-next',
    duration: '30 min',
    due: 'No deadline',
    priority: 'medium',
    completed: false,
    scheduledTime: null,
    origin: 'manual',
    createdAt: '2026-09-10T08:00:00.000Z',
    ...overrides,
  };
}

function workspace(tasks: Task[]): PrototypeData {
  return {
    tasks,
    events: [],
    inboxItems: [],
    reminders: [],
    listAreas: { [`google:id:${LIST_ID}`]: 'University' },
  };
}

function catalogue(): GoogleTaskDestinationCatalogue {
  return {
    accountId: ACCOUNT_ID,
    connectionGeneration: GENERATION,
    destinations: [{
      accountId: ACCOUNT_ID,
      listId: LIST_ID,
      name: 'University',
      area: 'University',
      fallback: false,
      fresh: true,
      explicitMapping: true,
    }],
    fallbackListId: null,
  };
}

function emptyHermesFeed(): HermesFeed {
  return {
    state: 'connected',
    checkedAt: NOW,
    board: {
      slug: 'personal-tasks',
      name: 'Personal tasks',
      total: 0,
      tasks: [],
      sources: [],
    },
  };
}

function hermesSnapshot(version: number): HermesMirrorSnapshot {
  return {
    state: 'connected',
    checkedAt: NOW,
    complete: true,
    board: {
      slug: 'personal-tasks',
      name: 'Personal tasks',
      total: 1,
      sources: [],
      tasks: [{
        id: 'hermes-linked-task', title: 'Prepare lab notes', status: 'scheduled', priority: 2,
        createdAt: NOW, updatedAt: NOW, version, owner: 'human', source: 'Unsorted',
        parentTitle: null, sourceProvider: null, sourceExternalId: null, sourceDueOn: null,
        sourceStatus: null, sourceContainerId: null, sourceContainerName: null,
        sourceMatchUnique: false,
      }],
    },
  };
}

function publishList(store: Store, records: Parameters<Store['publishProviderScope']>[0]['records'] = []): void {
  store.publishProviderScope({
    provider: 'google',
    resourceKind: 'task-list',
    accountId: ACCOUNT_ID,
    connectionGeneration: GENERATION,
    containerId: LIST_ID,
    containerName: 'University',
    records,
    coverageFrom: null,
    coverageTo: null,
    fetchedAt: NOW,
  });
}

function providerTask(externalId: string, title = 'Prepare lab notes'):
Parameters<Store['publishProviderScope']>[0]['records'][number] {
  return {
    provider: 'google', kind: 'task', accountId: ACCOUNT_ID, connectionGeneration: GENERATION,
    containerId: LIST_ID, containerName: 'University', externalId, title, status: 'needsAction',
    startsAt: null, endsAt: null, startsOn: null, endsOn: null, allDay: false, dueOn: null,
    completedAt: null, sourceUpdatedAt: NOW, sourceVersion: 'etag-current-1',
    completionWritable: true, notes: null, parentId: null, position: '0001', sourceUrl: null,
    sourceTimeZone: null,
  };
}

function createdReadback(title: string, notes: string) {
  return {
    title,
    notes,
    state: 'open' as const,
    completedAt: null,
    dueOn: null,
    parentId: null,
    position: '0001',
    sourceUrl: 'https://tasks.google.com/task/created-task-1',
    version: 'etag-created-1',
    updatedAt: '2026-09-14T10:02:00.000Z',
    completionWritable: true,
  };
}

function fakeIntegrations(destinationCatalogue: GoogleTaskDestinationCatalogue): IntegrationService {
  const overview: IntegrationOverview = { providers: [], records: [] };
  return {
    overview: () => overview,
    listGoogleTaskDestinations: () => destinationCatalogue,
    startAuthorization: () => null,
    completeAuthorization: async () => ({ outcome: 'failed', notice: 'unused' }),
    sync: async () => ({ outcome: 'failed', notice: 'unused' }),
    syncConnected: async () => undefined,
    updateGoogleTaskCompletion: async () => ({ outcome: 'failed', notice: 'unused', retryable: false }),
    createGoogleTask: async () => ({ outcome: 'failed', notice: 'unused', retryable: false }),
    reconcileGoogleTaskCreate: async () => ({ outcome: 'unknown', notice: 'unused' }),
  };
}

function fakeHermes(feed: HermesFeed): HermesMirrorService {
  return {
    feed: () => feed,
    poll: async () => feed,
    updateAnnotation: () => null,
    completeTask: async () => { throw new Error('unused'); },
  };
}

test('migration preview is read-only and owner approval creates an exact immutable batch', async () => {
  const data = workspace([nativeTask()]);
  data.reminders.push({
    id: 'native-reminder-1',
    targetId: 'native-task-1',
    targetType: 'task',
    title: 'Prepare lab notes',
    mode: 'morning',
    when: '09:00 on the day',
    state: 'scheduled',
    fireAt: '2026-09-16T08:00:00.000Z',
  });
  const store = openStore(':memory:', data);
  const password = 'test-password-at-least-24-characters';
  const authorization = `Basic ${Buffer.from(`fox:${password}`).toString('base64')}`;
  let kicks = 0;
  try {
    publishList(store);
    const app = createApp(
      store,
      password,
      fakeHermes(emptyHermesFeed()),
      fakeIntegrations(catalogue()),
      { now: () => new Date(NOW), actionWorker: { kick: () => { kicks += 1; } } },
    );
    const beforeTask = store.getTask('native-task-1');
    const beforeChanges = store.listChanges(0, 1_000).changes.length;
    const previewResponse = await app.request('/api/v1/task-migrations/preview', {
      headers: { authorization },
    });
    assert.equal(previewResponse.status, 200);
    const previewBody = await previewResponse.json() as {
      preview: ReturnType<typeof buildTaskMigrationPreview>;
    };
    assert.equal(previewBody.preview.blockers.length, 0);
    assert.equal(previewBody.preview.items.length, 1);
    assert.equal(previewBody.preview.items[0]?.operation, 'create');
    assert.match(previewBody.preview.items[0]?.approvalText ?? '', /Source status: open/);
    assert.match(previewBody.preview.items[0]?.approvalText ?? '', /Local priority: medium/);
    assert.match(previewBody.preview.items[0]?.approvalText ?? '', /Existing reminder unchanged: native-reminder-1 at 2026-09-16T08:00:00.000Z/);
    assert.deepEqual(previewBody.preview.items[0]?.sourceSnapshot.reminders, [{
      id: 'native-reminder-1', version: 1, fireAt: '2026-09-16T08:00:00.000Z', state: 'scheduled',
    }]);
    assert.deepEqual(store.getTask('native-task-1'), beforeTask);
    assert.equal(store.listActions().length, 0);
    assert.equal(store.listChanges(0, 1_000).changes.length, beforeChanges);

    const approval = await app.request('/api/v1/task-migrations/approve', {
      method: 'POST',
      headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewHash: previewBody.preview.hash, idempotencyKey: 'migration-approval-1' }),
    });
    assert.equal(approval.status, 202);
    assert.equal(kicks, 1);
    const migrationId = migrationIdForIdempotencyKey('migration-approval-1');
    const actions = store.migrationActions(migrationId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.state, 'queued');
    assert.equal(actions[0]?.payload.kind, 'task-migration');
    assert.equal(store.getTask('native-task-1')?.binding.kind, 'pending');
    assert.deepEqual(store.listReminders().map(reminder => ({
      id: reminder.id,
      target: reminder.target,
      fireAt: reminder.fireAt,
    })), [{
      id: 'native-reminder-1',
      target: { kind: 'task', id: 'native-task-1' },
      fireAt: '2026-09-16T08:00:00.000Z',
    }]);

    const replay = await app.request('/api/v1/task-migrations/approve', {
      method: 'POST',
      headers: { authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewHash: previewBody.preview.hash, idempotencyKey: 'migration-approval-1' }),
    });
    assert.equal(replay.status, 200);
    assert.equal(store.migrationActions(migrationId).length, 1);
  } finally {
    store.close();
  }
});

test('migration create resumes after restart and reconciles a lost response without reinserting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-focus-task-migration-'));
  const path = join(dir, 'focus.sqlite');
  let store = openStore(path, workspace([nativeTask()]));
  try {
    publishList(store);
    const preview = buildTaskMigrationPreview(store, catalogue(), emptyHermesFeed(), NOW);
    const approval = store.approveTaskMigration(preview, 'migration-approval-2', '2026-09-14T10:00:10.000Z');
    assert.equal(approval.outcome, 'queued');
    const firstClaim = store.claimNextTaskCreateAction('2026-09-14T10:00:11.000Z', 120_000);
    assert.equal(firstClaim?.mode, 'create');
    assert.equal(firstClaim?.action.payload.kind, 'task-migration');
    if (!firstClaim) return;
    store.settleTaskCreateAction(firstClaim.action.id, firstClaim.action.claimId ?? '', {
      outcome: 'unknown',
      notice: 'The create response was lost.',
    }, '2026-09-14T10:00:12.000Z');
    store.close();

    store = openStore(path);
    const reconcileClaim = store.claimNextTaskCreateAction('2026-09-14T10:01:00.000Z', 120_000);
    assert.equal(reconcileClaim?.mode, 'reconcile');
    if (!reconcileClaim) return;
    const payload = reconcileClaim.action.payload;
    assert.equal(payload.kind, 'task-migration');
    const settled = store.settleTaskCreateAction(reconcileClaim.action.id, reconcileClaim.action.claimId ?? '', {
      outcome: 'succeeded',
      externalId: 'created-task-1',
      current: createdReadback(payload.title, payload.notes),
    }, '2026-09-14T10:02:00.000Z');
    assert.equal(settled?.state, 'succeeded');
    assert.equal(store.getTask('native-task-1')?.binding.kind, 'google');
    assert.equal(store.listProviderRecordsForAccount('google', ACCOUNT_ID, 'task').length, 1);
    const summary = summarizeTaskMigration(
      store.migrationActions(migrationIdForIdempotencyKey('migration-approval-2')),
      migrationIdForIdempotencyKey('migration-approval-2'),
    );
    assert.equal(summary.state, 'settled');
    assert.equal(summary.mappings[0]?.externalId, 'created-task-1');
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test('terminal migration creates resume safely and keep prior action history', () => {
  const store = openStore(':memory:', workspace([nativeTask()]));
  try {
    publishList(store);
    const firstPreview = buildTaskMigrationPreview(store, catalogue(), emptyHermesFeed(), NOW);
    const first = store.approveTaskMigration(firstPreview, 'terminal-migration-one', '2026-09-14T10:00:01.000Z');
    assert.equal(first.outcome, 'queued');
    const firstClaim = store.claimNextTaskCreateAction('2026-09-14T10:00:02.000Z', 120_000);
    assert.equal(firstClaim?.mode, 'create');
    assert.ok(firstClaim?.action.claimId);
    if (!firstClaim?.action.claimId) return;
    store.settleTaskCreateAction(firstClaim.action.id, firstClaim.action.claimId, {
      outcome: 'failed', notice: 'Google rejected the insert before dispatch.', retryable: false,
    }, '2026-09-14T10:00:03.000Z');

    const failedPreview = buildTaskMigrationPreview(
      store,
      catalogue(),
      emptyHermesFeed(),
      '2026-09-14T10:00:04.000Z',
    );
    assert.equal(failedPreview.items[0]?.replacesActionId, firstClaim.action.id);
    assert.equal(failedPreview.items[0]?.resumeMode, 'create');
    const second = store.approveTaskMigration(
      failedPreview,
      'terminal-migration-two',
      '2026-09-14T10:00:05.000Z',
    );
    assert.equal(second.outcome, 'queued');
    assert.equal(store.getAction(firstClaim.action.id)?.state, 'superseded');
    assert.equal(summarizeTaskMigration(
      store.migrationActions(migrationIdForIdempotencyKey('terminal-migration-one')),
      migrationIdForIdempotencyKey('terminal-migration-one'),
    ).state, 'settled');
    const secondClaim = store.claimNextTaskCreateAction('2026-09-14T10:00:06.000Z', 120_000);
    assert.equal(secondClaim?.mode, 'create');
    assert.ok(secondClaim?.action.claimId);
    if (!secondClaim?.action.claimId) return;
    store.settleTaskCreateAction(secondClaim.action.id, secondClaim.action.claimId, {
      outcome: 'conflict', notice: 'The insert outcome needs reconciliation.', candidates: [],
    }, '2026-09-14T10:00:07.000Z');

    const conflictPreview = buildTaskMigrationPreview(
      store,
      catalogue(),
      emptyHermesFeed(),
      '2026-09-14T10:00:08.000Z',
    );
    assert.equal(conflictPreview.items[0]?.replacesActionId, secondClaim.action.id);
    assert.equal(conflictPreview.items[0]?.resumeMode, 'reconcile');
    const third = store.approveTaskMigration(
      conflictPreview,
      'terminal-migration-three',
      '2026-09-14T10:00:09.000Z',
    );
    assert.equal(third.outcome, 'queued');
    assert.equal(store.getAction(secondClaim.action.id)?.state, 'superseded');
    const reconcile = store.claimNextTaskCreateAction('2026-09-14T10:00:10.000Z', 120_000);
    assert.equal(reconcile?.mode, 'reconcile', 'a conflict resolution must never issue another insert');
    assert.ok(reconcile?.action.claimId);
    if (!reconcile?.action.claimId) return;
    store.settleTaskCreateAction(reconcile.action.id, reconcile.action.claimId, {
      outcome: 'succeeded',
      externalId: 'reconciled-terminal-task',
      current: createdReadback(reconcile.action.payload.title, reconcile.action.payload.notes),
    }, '2026-09-14T10:00:11.000Z');
    assert.equal(store.getTask('native-task-1')?.binding.kind, 'google');
    const runs = store.listTaskMigrationRuns();
    assert.equal(runs[0]?.migrationId, migrationIdForIdempotencyKey('terminal-migration-three'));
    assert.deepEqual(
      new Set(runs.map(run => run.migrationId)),
      new Set([
        migrationIdForIdempotencyKey('terminal-migration-one'),
        migrationIdForIdempotencyKey('terminal-migration-two'),
        migrationIdForIdempotencyKey('terminal-migration-three'),
      ]),
    );
  } finally {
    store.close();
  }
});

test('migration binds only an exact Google ID and preserves the native task row', () => {
  const linked = nativeTask({
    externalLinks: [{
      provider: 'google_tasks',
      externalId: 'google-task-1',
      containerId: LIST_ID,
      containerName: 'University',
      connectionId: '11111111-1111-4111-8111-111111111111',
      policy: 'completion_only',
      sourceStatus: 'needsAction',
      sourceVersion: 'etag-1',
      sourceUpdatedAt: NOW,
      linkedAt: NOW,
    }],
  });
  const store = openStore(':memory:', workspace([linked]));
  try {
    publishList(store, [{
      provider: 'google',
      kind: 'task',
      accountId: ACCOUNT_ID,
      connectionGeneration: GENERATION,
      containerId: LIST_ID,
      containerName: 'University',
      externalId: 'google-task-1',
      title: linked.title,
      status: 'needsAction',
      startsAt: null,
      endsAt: null,
      startsOn: null,
      endsOn: null,
      allDay: false,
      dueOn: null,
      completedAt: null,
      sourceUpdatedAt: NOW,
      sourceVersion: 'etag-1',
      completionWritable: true,
      notes: null,
      parentId: null,
      position: '0001',
      sourceUrl: null,
      sourceTimeZone: null,
    }]);
    assert.equal(store.listTasks().length, 2, 'the provider snapshot initially has its own row');
    const preview = buildTaskMigrationPreview(store, catalogue(), emptyHermesFeed(), NOW);
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.items[0]?.operation, 'bind');
    assert.equal(preview.items[0]?.existingExternalId, 'google-task-1');
    const result = store.approveTaskMigration(preview, 'migration-approval-3', '2026-09-14T10:00:10.000Z');
    assert.equal(result.outcome, 'queued');
    assert.equal(store.listTasks().length, 1);
    const preserved = store.getTask(linked.id);
    assert.equal(preserved?.binding.kind, 'google');
    if (preserved?.binding.kind === 'google') {
      assert.deepEqual(preserved.binding.ref, {
        accountId: ACCOUNT_ID,
        listId: LIST_ID,
        externalId: 'google-task-1',
      });
    }
    assert.equal(result.actions[0]?.state, 'succeeded');
  } finally {
    store.close();
  }
});

test('migration preview blocks a replacement Google row with action history', () => {
  const linked = nativeTask({
    externalLinks: [{
      provider: 'google_tasks',
      externalId: 'google-task-with-history',
      containerId: LIST_ID,
      connectionId: '22222222-2222-4222-8222-222222222222',
      policy: 'completion_only',
      linkedAt: NOW,
    }],
  });
  const store = openStore(':memory:', workspace([linked]));
  try {
    publishList(store, [{
      provider: 'google', kind: 'task', accountId: ACCOUNT_ID, connectionGeneration: GENERATION,
      containerId: LIST_ID, containerName: 'University', externalId: 'google-task-with-history',
      title: linked.title, status: 'needsAction', startsAt: null, endsAt: null, startsOn: null,
      endsOn: null, allDay: false, dueOn: null, completedAt: null, sourceUpdatedAt: NOW,
      sourceVersion: 'etag-history-1', completionWritable: true, notes: null, parentId: null,
      position: '0001', sourceUrl: null, sourceTimeZone: null,
    }]);
    const replacement = store.listTasks().find(task => task.id !== linked.id);
    assert.ok(replacement);
    const queued = store.queueTaskStatusAction(
      replacement.id,
      replacement.version,
      'completed',
      '2026-09-14T10:00:01.000Z',
    );
    assert.equal(queued.outcome, 'queued');
    const preview = buildTaskMigrationPreview(store, catalogue(), emptyHermesFeed(), '2026-09-14T10:00:02.000Z');
    assert.ok(preview.blockers.some(blocker =>
      blocker.sourceKey === `fox:${linked.id}` && blocker.code === 'duplicate_target' &&
      blocker.message.includes('action history')));
    assert.ok(!preview.items.some(item => item.sourceKey === `fox:${linked.id}`));
  } finally {
    store.close();
  }
});

test('migration preview blocks referenced replacement rows and stale bind lists', () => {
  const linked = nativeTask({
    externalLinks: [{
      provider: 'google_tasks', externalId: 'google-task-referenced', containerId: LIST_ID,
      connectionId: '33333333-3333-4333-8333-333333333333', policy: 'completion_only', linkedAt: NOW,
    }],
  });
  const referencedStore = openStore(':memory:', workspace([linked]));
  const staleStore = openStore(':memory:', workspace([linked]));
  const approvalStore = openStore(':memory:', workspace([linked]));
  try {
    publishList(referencedStore, [providerTask('google-task-referenced')]);
    const replacement = referencedStore.listTasks().find(task => task.id !== linked.id);
    assert.ok(replacement);
    const job = referencedStore.createJob({
      title: 'Keep reference', instruction: 'Do not merge this row.', taskId: replacement.id, inboxId: null,
    }, '2026-09-14T10:00:01.000Z', 'replacement-reference-job');
    assert.equal(job.outcome, 'created');
    const referencedPreview = buildTaskMigrationPreview(
      referencedStore,
      catalogue(),
      emptyHermesFeed(),
      '2026-09-14T10:00:02.000Z',
    );
    assert.ok(referencedPreview.blockers.some(blocker =>
      blocker.sourceKey === `fox:${linked.id}` && blocker.code === 'duplicate_target' &&
      blocker.message.includes('referenced by local records')));

    publishList(staleStore, [providerTask('google-task-referenced')]);
    const staleCatalogue = catalogue();
    staleCatalogue.destinations = staleCatalogue.destinations.map(destination => ({
      ...destination,
      fresh: false,
    }));
    const stalePreview = buildTaskMigrationPreview(
      staleStore,
      staleCatalogue,
      emptyHermesFeed(),
      '2026-09-14T10:00:03.000Z',
    );
    assert.ok(stalePreview.blockers.some(blocker =>
      blocker.sourceKey === `fox:${linked.id}` && blocker.code === 'destination_missing'));
    assert.ok(!stalePreview.items.some(item => item.sourceKey === `fox:${linked.id}`));

    publishList(approvalStore, [providerTask('google-task-referenced')]);
    const freshPreview = buildTaskMigrationPreview(
      approvalStore,
      catalogue(),
      emptyHermesFeed(),
      '2026-09-14T10:00:04.000Z',
    );
    assert.equal(freshPreview.items[0]?.operation, 'bind');
    approvalStore.markScopeFailed({
      provider: 'google', resourceKind: 'task-list', accountId: ACCOUNT_ID,
      connectionGeneration: GENERATION, containerId: LIST_ID, containerName: 'University',
      coverageFrom: null, coverageTo: null, fetchedAt: '2026-09-14T10:00:05.000Z',
    }, 'list failed after preview');
    const rejected = approvalStore.approveTaskMigration(
      freshPreview,
      'migration-stale-bind',
      '2026-09-14T10:00:06.000Z',
    );
    assert.equal(rejected.outcome, 'conflict');
    assert.equal(rejected.actions.length, 0);
  } finally {
    referencedStore.close();
    staleStore.close();
    approvalStore.close();
  }
});

test('migration keeps a related Hermes alias in coverage and status mappings', () => {
  const linked = nativeTask({
    externalLinks: [{
      provider: 'hermes',
      externalId: 'hermes-linked-task',
      containerId: 'personal-tasks',
      policy: 'read_only',
      linkedAt: NOW,
    }],
  });
  const feed: HermesFeed = {
    state: 'connected',
    checkedAt: NOW,
    board: {
      slug: 'personal-tasks',
      name: 'Personal tasks',
      total: 1,
      sources: [],
      tasks: [{
        id: 'hermes-linked-task', title: linked.title, status: 'scheduled', priority: 2,
        createdAt: NOW, updatedAt: NOW, version: 4, owner: 'human', source: 'Unsorted',
        parentTitle: null, sourceProvider: null, sourceExternalId: null, sourceDueOn: null,
        sourceStatus: null, sourceContainerId: null, sourceContainerName: null,
        sourceMatchUnique: false, area: 'University', localState: 'up-next', duration: '30 min',
        due: 'No deadline', scheduledAt: null, reminderMode: 'none', reminderFireAt: null,
        annotationUpdatedAt: null,
      }],
    },
  };
  const store = openStore(':memory:', workspace([linked]));
  try {
    publishList(store);
    assert.equal(store.isHermesTaskCoveredByMigration('personal-tasks', 'hermes-linked-task'), false);
    const preview = buildTaskMigrationPreview(store, catalogue(), feed, NOW);
    assert.deepEqual(preview.items[0]?.sourceAliases, [{
      kind: 'hermes', boardSlug: 'personal-tasks', taskId: 'hermes-linked-task', version: 4,
    }]);
    const approved = store.approveTaskMigration(preview, 'migration-alias-approval', '2026-09-14T10:00:01.000Z');
    assert.equal(approved.outcome, 'queued');
    assert.equal(store.isHermesTaskCoveredByMigration('personal-tasks', 'hermes-linked-task'), true);
    assert.equal(store.isHermesTaskCoveredByMigration('another-board', 'hermes-linked-task'), false);
    const summary = summarizeTaskMigration(
      approved.actions,
      migrationIdForIdempotencyKey('migration-alias-approval'),
    );
    assert.deepEqual(summary.mappings.map(mapping => mapping.sourceKey).sort(), [
      'fox:native-task-1',
      'hermes:personal-tasks:hermes-linked-task',
    ]);
  } finally {
    store.close();
  }
});

test('migration create claim blocks a changed Hermes source before Google dispatch', () => {
  const linked = nativeTask({
    externalLinks: [{
      provider: 'hermes', externalId: 'hermes-linked-task', containerId: 'personal-tasks',
      policy: 'read_only', linkedAt: NOW,
    }],
  });
  const store = openStore(':memory:', workspace([linked]));
  try {
    publishList(store);
    store.replaceHermesTasks(hermesSnapshot(4));
    const preview = buildTaskMigrationPreview(store, catalogue(), store.readHermesFeed(), NOW);
    assert.equal(preview.blockers.length, 0);
    const approved = store.approveTaskMigration(
      preview,
      'migration-hermes-version',
      '2026-09-14T10:00:01.000Z',
    );
    assert.equal(approved.outcome, 'queued');
    store.replaceHermesTasks(hermesSnapshot(5));
    assert.equal(store.claimNextTaskCreateAction('2026-09-14T10:00:02.000Z', 120_000), null);
    assert.equal(store.getAction(approved.actions[0]?.id ?? '')?.state, 'conflict');
  } finally {
    store.close();
  }
});

test('migration bind inventory ignores provider rows from an older connection generation', () => {
  const store = openStore(':memory:', workspace([]));
  try {
    publishList(store, [providerTask('generation-task', 'Current generation title')]);
    const current = store.listProviderRecordsForAccount('google', ACCOUNT_ID, 'task')[0];
    assert.ok(current);
    const stale = {
      ...current,
      id: current.id + 100,
      connectionGeneration: 'older-generation',
      connectionId: 'older-generation',
      title: 'Stale generation title',
      sourceVersion: 'etag-stale',
    };
    const inventoryStore: Store = {
      ...store,
      listProviderRecordsForAccount: () => [current, stale],
    };
    const feed: HermesFeed = {
      state: 'connected', checkedAt: NOW,
      board: {
        slug: 'personal-tasks', name: 'Personal tasks', total: 1, sources: [],
        tasks: [{
          id: 'generation-hermes', title: 'Current generation title', status: 'scheduled', priority: 2,
          createdAt: NOW, updatedAt: NOW, version: 1, owner: 'human', source: 'Google Tasks',
          parentTitle: null, sourceProvider: 'google', sourceExternalId: 'generation-task',
          sourceDueOn: null, sourceStatus: 'needsAction', sourceContainerId: LIST_ID,
          sourceContainerName: 'University', sourceMatchUnique: true, area: 'University',
          localState: 'up-next', duration: '30 min', due: 'No deadline', scheduledAt: null,
          reminderMode: 'none', reminderFireAt: null, annotationUpdatedAt: null,
        }],
      },
    };
    const preview = buildTaskMigrationPreview(inventoryStore, catalogue(), feed, NOW);
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.items[0]?.targetSnapshot?.title, 'Current generation title');
    assert.equal(preview.items[0]?.targetSnapshot?.etag, 'etag-current-1');
  } finally {
    store.close();
  }
});

test('migration blocks ambiguous IDs, parent flattening, and non-exact Hermes due labels', () => {
  const ambiguous = nativeTask({
    externalLinks: [
      {
        provider: 'google_tasks', externalId: 'same-id', containerId: 'list-1', connectionId: ACCOUNT_ID,
        policy: 'completion_only', linkedAt: NOW,
      },
      {
        provider: 'google_tasks', externalId: 'same-id', containerId: 'list-2', connectionId: ACCOUNT_ID,
        policy: 'completion_only', linkedAt: NOW,
      },
    ],
  });
  const store = openStore(':memory:', workspace([ambiguous]));
  try {
    publishList(store);
    const feed: HermesFeed = {
      state: 'connected',
      checkedAt: NOW,
      board: {
        slug: 'personal-tasks',
        name: 'Personal tasks',
        total: 6,
        sources: [],
        tasks: [
          {
            id: 'hermes-parented', title: 'Child task', status: 'scheduled', priority: 2,
            createdAt: NOW, updatedAt: NOW, version: 1, owner: 'human', source: 'Unsorted',
            parentTitle: 'Parent without ID', sourceProvider: null, sourceExternalId: null,
            sourceDueOn: null, sourceStatus: null, sourceContainerId: null, sourceContainerName: null,
            sourceMatchUnique: false, area: 'University', localState: 'up-next', duration: '30 min',
            due: 'No deadline', scheduledAt: null, reminderMode: 'none', reminderFireAt: null,
            annotationUpdatedAt: null,
          },
          {
            id: 'hermes-relative-due', title: 'Relative due task', status: 'scheduled', priority: 2,
            createdAt: NOW, updatedAt: NOW, version: 1, owner: 'human', source: 'Unsorted',
            parentTitle: null, sourceProvider: null, sourceExternalId: null, sourceDueOn: null,
            sourceStatus: null, sourceContainerId: null, sourceContainerName: null,
            sourceMatchUnique: false, area: 'University', localState: 'up-next', duration: '30 min',
            due: 'Tomorrow', scheduledAt: null, reminderMode: 'none', reminderFireAt: null,
            annotationUpdatedAt: NOW,
          },
          {
            id: 'hermes-bad-duration', title: 'Bad duration', status: 'scheduled', priority: 2,
            createdAt: NOW, updatedAt: NOW, version: 1, owner: 'human', source: 'Unsorted',
            parentTitle: null, sourceProvider: null, sourceExternalId: null, sourceDueOn: null,
            sourceStatus: null, sourceContainerId: null, sourceContainerName: null,
            sourceMatchUnique: false, area: 'University', localState: 'up-next', duration: 'a while',
            due: 'No deadline', scheduledAt: null, reminderMode: 'none', reminderFireAt: null,
            annotationUpdatedAt: NOW,
          },
          {
            id: 'hermes-bad-time', title: 'Bad time', status: 'scheduled', priority: 2,
            createdAt: NOW, updatedAt: NOW, version: 1, owner: 'human', source: 'Unsorted',
            parentTitle: null, sourceProvider: null, sourceExternalId: null, sourceDueOn: null,
            sourceStatus: null, sourceContainerId: null, sourceContainerName: null,
            sourceMatchUnique: false, area: 'University', localState: 'scheduled', duration: '30 min',
            due: 'No deadline', scheduledAt: '2026-09-15T09:00:00', reminderMode: 'none',
            reminderFireAt: null, annotationUpdatedAt: NOW,
          },
          {
            id: 'hermes-long-title', title: 'x'.repeat(1_025), status: 'scheduled', priority: 2,
            createdAt: NOW, updatedAt: NOW, version: 1, owner: 'human', source: 'Unsorted',
            parentTitle: null, sourceProvider: null, sourceExternalId: null, sourceDueOn: null,
            sourceStatus: null, sourceContainerId: null, sourceContainerName: null,
            sourceMatchUnique: false, area: 'University', localState: 'up-next', duration: '30 min',
            due: 'No deadline', scheduledAt: null, reminderMode: 'none', reminderFireAt: null,
            annotationUpdatedAt: null,
          },
          {
            id: 'hermes-offset-time', title: 'Offset time', status: 'scheduled', priority: 2,
            createdAt: NOW, updatedAt: NOW, version: 1, owner: 'human', source: 'Unsorted',
            parentTitle: null, sourceProvider: null, sourceExternalId: null, sourceDueOn: null,
            sourceStatus: null, sourceContainerId: null, sourceContainerName: null,
            sourceMatchUnique: false, area: 'University', localState: 'scheduled', duration: '1.5 hours',
            due: '2026-09-20', scheduledAt: '2026-09-15T09:00:00+01:00',
            reminderMode: 'one-hour', reminderFireAt: '2026-09-15T08:00:00+01:00',
            annotationUpdatedAt: NOW,
          },
        ],
      },
    };
    const preview = buildTaskMigrationPreview(store, catalogue(), feed, NOW);
    assert.ok(preview.blockers.some(blocker => blocker.sourceKey === 'fox:native-task-1' && blocker.code === 'ambiguous_source'));
    assert.ok(preview.blockers.some(blocker => blocker.sourceKey === 'hermes:personal-tasks:hermes-parented' && blocker.code === 'ambiguous_source'));
    assert.ok(preview.blockers.some(blocker => blocker.sourceKey === 'hermes:personal-tasks:hermes-relative-due' && blocker.code === 'planning_conflict'));
    assert.ok(preview.blockers.some(blocker => blocker.sourceKey === 'hermes:personal-tasks:hermes-bad-duration' && blocker.code === 'planning_conflict'));
    assert.ok(preview.blockers.some(blocker => blocker.sourceKey === 'hermes:personal-tasks:hermes-bad-time' && blocker.code === 'planning_conflict'));
    assert.ok(preview.blockers.some(blocker => blocker.sourceKey === 'hermes:personal-tasks:hermes-long-title' && blocker.code === 'source_missing'));
    const offset = preview.items.find(item => item.sourceKey === 'hermes:personal-tasks:hermes-offset-time');
    assert.equal(offset?.plan.plannedAt, '2026-09-15T08:00:00.000Z');
    assert.equal(offset?.plan.estimateMinutes, 90);
    assert.equal(offset?.reminder?.fireAt, '2026-09-15T07:00:00.000Z');
    assert.equal(store.listActions().length, 0);
  } finally {
    store.close();
  }
});
