import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { InboxItemRow } from '../src/row-model.ts';
import type { PrototypeData } from '../src/model.ts';
import { createApp } from './app.ts';
import { ROW_SCHEMA_VERSION } from './row-store.ts';
import { openStore } from './store.ts';

const fixturePath = new URL('./fixtures/workspace-v7.json', import.meta.url);

function workspaceFixture(): PrototypeData {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as PrototypeData;
}

function createVersionSevenDatabase(path: string, data: PrototypeData): void {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=7;
    CREATE TABLE workspace (
      id INTEGER PRIMARY KEY CHECK(id=1),
      revision INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)),
      updated_at TEXT NOT NULL
    );`);
  db.prepare('INSERT INTO workspace VALUES (1, 12, ?, ?)')
    .run(JSON.stringify(data), '2026-09-13T20:00:00.000Z');
  db.close();
}

function capture(index: number): InboxItemRow {
  const timestamp = new Date(Date.UTC(2026, 8, 14, 8, 0, index % 60)).toISOString();
  return {
    id: `capture-${index}`,
    version: 1,
    source: { kind: 'capture', reference: `test:${index}` },
    title: `Capture ${index}`,
    summary: 'Test capture',
    state: 'open',
    outcome: null,
    taskId: null,
    currentDraftId: null,
    likelyNoise: false,
    snoozedUntil: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test('user_version migration moves workspace rows without losing IDs, completion history, drafts, or reminders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-focus-row-migration-'));
  const path = join(dir, 'focus.sqlite');
  createVersionSevenDatabase(path, workspaceFixture());
  let store = openStore(path);
  try {
    assert.equal(store.read().revision, 12);
    assert.deepEqual(store.listTasks().map(task => task.id).sort(), ['legacy-completed', 'legacy-open']);
    assert.equal(store.getTask('legacy-completed')?.observed?.status, 'completed');
    assert.equal(store.getTask('legacy-completed')?.observed?.completedAt, '2026-09-12T17:40:00.000Z');
    assert.equal(store.getTaskPlan('legacy-open')?.plannedAt, '2026-10-24T08:30:00.000Z');
    assert.equal(store.getTaskPlan('legacy-open')?.estimateMinutes, 45);
    assert.equal(store.listInboxItems()[0]?.id, 'legacy-inbox');
    assert.equal(store.listDrafts('legacy-inbox')[0]?.reply.bodyText, 'Thanks, I can help.');
    assert.equal(store.listReminders()[0]?.id, 'legacy-reminder');
    assert.equal(store.listReminders()[0]?.fireAt, '2026-10-24T07:30:00.000Z');
    const completion = store.listChanges(0, 100).changes.find(change =>
      change.entityId === 'legacy-completed' && change.operation === 'transition');
    assert.deepEqual(completion?.details, {
      after: 'completed',
      before: 'open',
      completedAt: '2026-09-12T17:40:00.000Z',
    });
    store.close();
    store = openStore(path);
    assert.equal(store.listTasks().length, 2, 'reopening must not migrate rows twice');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, ROW_SCHEMA_VERSION);
      const strict = new Map((db.prepare('PRAGMA table_list').all() as Array<{ name: string; strict: number }>)
        .map(row => [row.name, row.strict]));
      for (const table of [
        'tasks', 'task_plans', 'inbox_items', 'reply_drafts', 'actions', 'jobs',
        'job_updates', 'reminders', 'changes', 'sync_state',
      ]) assert.equal(strict.get(table), 1, `${table} must be STRICT`);
    } finally { db.close(); }
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test('Inbox row ingestion accepts more than 600 items without changing task or workspace revisions', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const taskVersion = store.getTask('legacy-open')?.version;
    const workspaceRevision = store.read().revision;
    for (let index = 0; index < 601; index += 1) {
      const item = capture(index);
      const result = store.appendCaptureInbox(item, `test:inbox:${index}`, 'hermes', item.createdAt);
      assert.equal(result.created, true);
    }
    assert.equal(store.listInboxItems().length, 602);
    assert.equal(store.getTask('legacy-open')?.version, taskVersion);
    assert.equal(store.read().revision, workspaceRevision);
    const replay = store.appendCaptureInbox(capture(0), 'test:inbox:0', 'hermes', capture(0).createdAt);
    assert.equal(replay.created, false);
    assert.equal(store.listInboxItems().length, 602);
  } finally { store.close(); }
});

test('row updates use expected versions and old change snapshots stay immutable', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const original = store.getTaskPlan('legacy-open');
    assert.ok(original);
    const originalChange = store.listChanges(0, 100).changes.find(change =>
      change.entityKind === 'task-plan' && change.entityId === 'legacy-open');
    assert.equal(originalChange?.snapshot?.priority, 'high');
    const updated = store.updateTaskPlan('legacy-open', original.version, {
      priority: 'low',
      waiting: true,
      deadlineOn: '2026-10-30',
      plannedOn: null,
      plannedAt: '2026-10-24T09:30:00.000Z',
      estimateMinutes: 60,
    }, '2026-09-14T10:00:00.000Z');
    assert.equal(updated?.version, 2);
    assert.equal(updated?.priority, 'low');
    assert.equal(store.updateTaskPlan('legacy-open', original.version, {
      priority: 'medium', waiting: false, deadlineOn: null, plannedOn: null, plannedAt: null, estimateMinutes: null,
    }, '2026-09-14T10:01:00.000Z'), null);
    assert.equal(originalChange?.snapshot?.priority, 'high');
    assert.equal(store.listChanges(0, 100).changes.find(change => change.seq === originalChange?.seq)?.snapshot?.priority, 'high');
  } finally { store.close(); }
});

test('a complete Google list snapshot binds an existing mirror and maps due to doOn', () => {
  const data = workspaceFixture();
  data.tasks[0].externalLinks = [{
    provider: 'google_tasks',
    connectionId: 'google-generation',
    containerId: 'uni-list',
    containerName: 'Study',
    externalId: 'google-task-1',
    policy: 'completion_only',
    sourceStatus: 'needsAction',
    sourceVersion: 'etag-old',
    linkedAt: '2026-09-01T08:00:00.000Z',
  }];
  const store = openStore(':memory:', data);
  try {
    store.publishProviderScope({
      provider: 'google',
      resourceKind: 'task-list',
      accountId: 'google-generation',
      connectionGeneration: 'google-generation',
      containerId: 'uni-list',
      containerName: 'Study',
      records: [{
        provider: 'google', kind: 'task', connectionId: 'google-generation',
        containerId: 'uni-list', containerName: 'Study', externalId: 'google-task-1',
        title: 'Plan autumn term', status: 'needsAction', startsAt: null, endsAt: null,
        startsOn: null, endsOn: null, allDay: false, dueOn: '2026-10-24', completedAt: null,
        sourceUpdatedAt: '2026-09-14T09:00:00.000Z', sourceVersion: 'etag-new',
        completionWritable: true, notes: 'Bring timetable', parentId: 'parent-1', position: '0001',
        sourceUrl: 'https://tasks.google.com/task/1', sourceTimeZone: null,
      }],
      coverageFrom: null,
      coverageTo: null,
      fetchedAt: '2026-09-14T10:00:00.000Z',
    });
    const task = store.getTask('legacy-open');
    assert.equal(task?.binding.kind, 'google');
    assert.equal(task?.observed?.doOn, '2026-10-24');
    assert.equal(task?.observed?.notes, 'Bring timetable');
    assert.equal(task?.observed?.parentId, 'parent-1');
    assert.equal(task?.observed?.position, '0001');
    assert.equal(store.listTasks().length, 2, 'the linked mirror must not become a duplicate row');
    assert.equal(store.getTaskPlan('legacy-open')?.deadlineOn, null, 'Google due is not a Fox Focus deadline');
    assert.equal(store.readContext('2026-09-01', '2026-10-31').tasks.find(row => row.task.id === 'legacy-open')?.area, 'University');
  } finally { store.close(); }
});

test('Hermes context and changes share a cursor while its bearer cannot open owner routes', async () => {
  const store = openStore(':memory:', workspaceFixture());
  const password = 'test-only-password-at-least-24-characters';
  const basic = `Basic ${Buffer.from(`fox:${password}`).toString('base64')}`;
  const token = 'hermes-test-token-at-least-24-characters';
  const bearer = `Bearer ${token}`;
  try {
    const app = createApp(store, password, undefined, undefined, {
      taskStatusToken: token,
      now: () => new Date('2026-09-14T10:00:00.000Z'),
    });
    const contextResponse = await app.request('/api/v1/context?from=2026-09-01&to=2026-10-31', {
      headers: { authorization: bearer },
    });
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json() as { cursor: number; tasks: unknown[] };
    const changesResponse = await app.request(`/api/v1/changes?after=0&limit=100`, {
      headers: { authorization: bearer },
    });
    assert.equal(changesResponse.status, 200);
    const changes = await changesResponse.json() as { changes: Array<{ seq: number }> };
    assert.equal(context.cursor, changes.changes.at(-1)?.seq);
    assert.equal(context.tasks.length, 2);

    for (const path of ['/api/v1/workspace', '/api/v1/rows', '/api/v1/integrations', '/api/v1/hermes']) {
      assert.equal((await app.request(path, { headers: { authorization: bearer } })).status, 401, path);
    }
    assert.equal((await app.request('/api/v1/rows', { headers: { authorization: basic } })).status, 200);

    const plan = store.getTaskPlan('legacy-open');
    assert.ok(plan);
    const update = await app.request('/api/v1/tasks/legacy-open/plan', {
      method: 'PUT',
      headers: { authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: plan.version,
        priority: 'medium',
        waiting: false,
        deadlineOn: null,
        plannedOn: '2026-10-24',
        plannedAt: null,
        estimateMinutes: 30,
      }),
    });
    assert.equal(update.status, 200);
    assert.equal((await app.request('/api/v1/tasks/legacy-open/plan', {
      method: 'PUT',
      headers: { authorization: basic, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: plan.version,
        priority: 'medium',
        waiting: false,
        deadlineOn: null,
        plannedOn: null,
        plannedAt: null,
        estimateMinutes: 30,
      }),
    })).status, 409);
  } finally { store.close(); }
});
