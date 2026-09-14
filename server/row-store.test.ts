import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  isEmailSendReceiptInput,
  isInboxDecisionInput,
  isReplyEnvelope,
  type ActionRow,
  type HermesInboxUpsertInput,
  type InboxItemRow,
  type ReplyEnvelope,
} from '../src/row-model.ts';
import type { PrototypeData } from '../src/model.ts';
import { createApp } from './app.ts';
import { canonicalHash, emailSendPayloadHash, ROW_SCHEMA_VERSION } from './row-store.ts';
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

function createVersionEightProviderDatabase(path: string, data: PrototypeData): void {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=8;
    CREATE TABLE workspace (
      id INTEGER PRIMARY KEY CHECK(id=1),
      revision INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE provider_connections (
      provider TEXT PRIMARY KEY CHECK(provider IN ('google', 'microsoft')),
      connection_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('connected', 'needs_reconnect')),
      scopes TEXT NOT NULL CHECK(json_valid(scopes)),
      token_envelope TEXT,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_synced_at TEXT,
      last_error TEXT
    );
    CREATE TABLE provider_records (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('google', 'microsoft')),
      connection_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('calendar_event', 'task')),
      container_id TEXT NOT NULL,
      container_name TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT,
      starts_at TEXT,
      ends_at TEXT,
      starts_on TEXT,
      ends_on TEXT,
      all_day INTEGER NOT NULL CHECK(all_day IN (0, 1)),
      due_on TEXT,
      completed_at TEXT,
      source_updated_at TEXT,
      source_version TEXT,
      completion_writable INTEGER NOT NULL DEFAULT 0 CHECK(completion_writable IN (0, 1)),
      source_url TEXT,
      source_time_zone TEXT,
      notes TEXT,
      parent_id TEXT,
      position TEXT,
      imported_at TEXT NOT NULL,
      sync_marker TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE(provider, kind, container_id, external_id)
    );
    CREATE INDEX provider_records_visible
      ON provider_records(provider, kind, deleted_at, starts_at, due_on);`);
  db.prepare('INSERT INTO workspace VALUES (1, 12, ?, ?)')
    .run(JSON.stringify(data), '2026-09-13T20:00:00.000Z');
  db.prepare(`INSERT INTO provider_connections VALUES (
    'google', 'old-generation', 'connected', '[]', NULL,
    '2026-09-13T19:00:00.000Z', '2026-09-13T20:00:00.000Z', NULL, NULL
  )`).run();
  db.prepare(`INSERT INTO provider_records (
    id, provider, connection_id, kind, container_id, container_name, external_id, title, status,
    starts_at, ends_at, starts_on, ends_on, all_day, due_on, completed_at, source_updated_at,
    source_version, completion_writable, source_url, source_time_zone, notes, parent_id, position,
    imported_at, sync_marker, deleted_at
  ) VALUES (41, 'google', NULL, 'task', 'shared-list', 'Old list', 'shared-task',
    'Preserved task', 'needsAction', NULL, NULL, NULL, NULL, 0, '2026-09-20', NULL,
    '2026-09-13T19:00:00.000Z', 'old-etag', 1, NULL, NULL, 'old notes', NULL, '0001',
    '2026-09-13T20:00:00.000Z', 'old-marker', NULL)`).run();
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

function emailInput(messageId: string, threadId = 'thread-1', bodyText = 'First draft'): HermesInboxUpsertInput {
  return {
    expectedVersion: null,
    source: { kind: 'email', accountId: 'mail-account', messageId, threadId },
    title: `Message ${messageId}`,
    summary: 'A message that needs a decision.',
    likelyNoise: false,
    draft: replyEnvelope(messageId, threadId, bodyText),
  };
}

function replyEnvelope(messageId: string, threadId = 'thread-1', bodyText = 'First draft'): ReplyEnvelope {
  return {
    accountId: 'mail-account',
    threadId,
    replyToMessageId: messageId,
    inReplyTo: `<${messageId}@example.test>`,
    references: ['<earlier@example.test>'],
    from: 'owner@example.test',
    to: ['sender@example.test'],
    cc: [],
    bcc: [],
    subject: `Re: Message ${messageId}`,
    bodyText,
  };
}

function publishFreshGoogleList(store: ReturnType<typeof openStore>, fetchedAt = '2026-09-14T10:00:00.000Z'): void {
  store.publishProviderScope({
    provider: 'google', resourceKind: 'task-list', accountId: 'google-generation',
    connectionGeneration: 'google-generation', containerId: 'my-tasks', containerName: 'My Tasks',
    records: [], coverageFrom: null, coverageTo: null, fetchedAt,
  });
}

function queueGoogleCreate(store: ReturnType<typeof openStore>, extras: {
  nonce?: string;
  inbox?: { id: string; version: number };
} = {}) {
  const nonce = extras.nonce ?? 'nonce_create_1';
  return store.queueTaskCreateAction({
    destination: { accountId: 'google-generation', listId: 'my-tasks' },
    destinationName: 'My Tasks', nonce, title: 'Created once', notes: 'Owner notes',
    finalNotes: `Owner notes\n\nFox-Focus-ID: ${nonce}`, doOn: '2026-09-20',
    plan: {
      priority: 'high', waiting: false, deadlineOn: '2026-09-21', plannedOn: null,
      plannedAt: '2026-09-18T08:00:00.000Z', estimateMinutes: 30,
    },
    ...(extras.inbox ? { inbox: extras.inbox } : {}),
  }, '2026-09-14T10:01:00.000Z');
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

test('provider record migration adopts nullable legacy generations and isolates remote IDs by account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-focus-provider-identity-'));
  const path = join(dir, 'focus.sqlite');
  createVersionEightProviderDatabase(path, workspaceFixture());
  let store = openStore(path);
  try {
    const preserved = store.findProviderRecord('google', 'task', 'old-generation', 'shared-list', 'shared-task');
    assert.equal(preserved?.id, 41);
    assert.equal(preserved?.title, 'Preserved task');
    assert.equal(preserved?.connectionGeneration, 'old-generation');
    assert.equal(store.getConnection('google')?.accountId, 'old-generation');
    assert.equal(store.getConnection('google')?.connectionId, 'old-generation');

    store.publishProviderScope({
      provider: 'google',
      resourceKind: 'task-list',
      accountId: 'new-generation',
      connectionGeneration: 'new-generation',
      containerId: 'shared-list',
      containerName: 'New list',
      records: [{
        provider: 'google', kind: 'task', connectionId: 'new-generation',
        containerId: 'shared-list', containerName: 'New list', externalId: 'shared-task',
        title: 'New account task', status: 'needsAction', startsAt: null, endsAt: null,
        startsOn: null, endsOn: null, allDay: false, dueOn: '2026-09-21', completedAt: null,
        sourceUpdatedAt: '2026-09-14T09:00:00.000Z', sourceVersion: 'new-etag',
        completionWritable: true, notes: 'new notes', parentId: null, position: '0002',
        sourceUrl: null, sourceTimeZone: null,
      }],
      coverageFrom: null,
      coverageTo: null,
      fetchedAt: '2026-09-14T10:00:00.000Z',
    });

    assert.equal(store.findProviderRecord(
      'google', 'task', 'old-generation', 'shared-list', 'shared-task',
    )?.title, 'Preserved task');
    assert.equal(store.findProviderRecord(
      'google', 'task', 'new-generation', 'shared-list', 'shared-task',
    )?.title, 'New account task');
    assert.equal(store.countProviderRecords('google', 'task'), 2);
    store.close();

    store = openStore(path);
    assert.equal(store.countProviderRecords('google', 'task'), 2);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const identity = (db.prepare(`SELECT name FROM pragma_index_list('provider_records') WHERE "unique"=1`)
        .all() as Array<{ name: string }>).map(index =>
        (db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) as Array<{ name: string }>)
          .map(column => column.name));
      assert.ok(identity.some(columns => columns.join(',') ===
        'provider,kind,account_id,container_id,external_id'));
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, ROW_SCHEMA_VERSION);
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

test('email Inbox identity uses account and message ID, not the thread ID', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const firstInput = emailInput('message-1');
    const first = store.upsertHermesInbox('email-message-1', canonicalHash(firstInput), firstInput, '2026-09-14T10:00:00.000Z');
    assert.equal(first.outcome, 'created');
    if (first.outcome !== 'created') return;
    const resolved = store.updateInboxDecision(first.item.id, first.item.version, {
      state: 'resolved', outcome: 'read', snoozedUntil: null,
    }, '2026-09-14T10:01:00.000Z');
    assert.equal(resolved?.state, 'resolved');

    const nextInput = emailInput('message-2');
    const next = store.upsertHermesInbox('email-message-2', canonicalHash(nextInput), nextInput, '2026-09-14T10:02:00.000Z');
    assert.equal(next.outcome, 'created');
    if (next.outcome !== 'created') return;
    assert.notEqual(next.item.id, first.item.id);
    assert.equal(next.item.state, 'open');
    assert.equal(store.listInboxItems().filter(item => item.source.kind === 'email').length, 2);

    const changedThread = { ...nextInput, expectedVersion: next.item.version, source: { ...nextInput.source, threadId: 'thread-other' } };
    const conflict = store.upsertHermesInbox(
      'email-message-2-wrong-thread', canonicalHash(changedThread), changedThread, '2026-09-14T10:03:00.000Z',
    );
    assert.equal(conflict.outcome, 'conflict');
    if (conflict.outcome === 'conflict') assert.equal(conflict.reason, 'source');
    const unchanged = store.getInboxItem(next.item.id);
    assert.equal(unchanged?.source.kind === 'email' ? unchanged.source.threadId : null, 'thread-1');
  } finally { store.close(); }
});

test('Hermes Inbox proposal and draft mutation namespaces cannot collide', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const firstInput = emailInput('namespace-first');
    const first = store.upsertHermesInbox(
      'shared-key', canonicalHash(firstInput), firstInput, '2026-09-14T10:00:00.000Z',
    );
    assert.equal(first.outcome, 'created');

    const suffixInput = emailInput('namespace-suffix');
    const suffix = store.upsertHermesInbox(
      'shared-key:draft', canonicalHash(suffixInput), suffixInput, '2026-09-14T10:01:00.000Z',
    );
    assert.equal(suffix.outcome, 'created');
    assert.equal(store.listInboxItems().filter(item => item.source.kind === 'email').length, 2);

    assert.equal(store.upsertHermesInbox(
      'shared-key', canonicalHash(firstInput), firstInput, '2026-09-14T10:02:00.000Z',
    ).outcome, 'replayed');
    assert.equal(store.upsertHermesInbox(
      'shared-key:draft', canonicalHash(suffixInput), suffixInput, '2026-09-14T10:03:00.000Z',
    ).outcome, 'replayed');
  } finally { store.close(); }
});

test('owner draft revisions remain current when Hermes updates the Inbox item', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const initialInput = emailInput('message-draft');
    const initial = store.upsertHermesInbox(
      'email-draft-1', canonicalHash(initialInput), initialInput, '2026-09-14T10:00:00.000Z',
    );
    assert.equal(initial.outcome, 'created');
    if (initial.outcome !== 'created') return;
    assert.equal(initial.draft?.author, 'hermes');

    const owner = store.appendOwnerDraft(
      initial.item.id,
      initial.item.version,
      replyEnvelope('message-draft', 'thread-1', 'Owner wording'),
      '2026-09-14T10:01:00.000Z',
    );
    assert.equal(owner.outcome, 'updated');
    if (owner.outcome !== 'updated') return;
    assert.equal(owner.draft.revision, 2);

    const hermesInput: HermesInboxUpsertInput = {
      ...initialInput,
      expectedVersion: owner.item.version,
      summary: 'Hermes added context without replacing the owner draft.',
      draft: replyEnvelope('message-draft', 'thread-1', 'Hermes replacement'),
    };
    const updated = store.upsertHermesInbox(
      'email-draft-2', canonicalHash(hermesInput), hermesInput, '2026-09-14T10:02:00.000Z',
    );
    assert.equal(updated.outcome, 'updated');
    if (updated.outcome !== 'updated') return;
    assert.equal(updated.draftOutcome, 'kept_owner');
    assert.equal(updated.item.currentDraftId, owner.draft.id);
    assert.equal(updated.draft?.reply.bodyText, 'Owner wording');
    assert.equal(store.listDrafts(initial.item.id).length, 2);

    const replay = store.upsertHermesInbox(
      'email-draft-2', canonicalHash(hermesInput), hermesInput, '2026-09-14T10:03:00.000Z',
    );
    assert.equal(replay.outcome, 'replayed');
    assert.equal(store.listDrafts(initial.item.id).length, 2);
  } finally { store.close(); }
});

test('a lost Hermes upsert response replays the current owner draft honestly', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const input = emailInput('message-lost-response');
    const initial = store.upsertHermesInbox(
      'email-lost-response', canonicalHash(input), input, '2026-09-14T10:00:00.000Z',
    );
    assert.equal(initial.outcome, 'created');
    if (initial.outcome !== 'created') return;
    const owner = store.appendOwnerDraft(
      initial.item.id,
      initial.item.version,
      replyEnvelope('message-lost-response', 'thread-1', 'Owner wording after the lost response'),
      '2026-09-14T10:01:00.000Z',
    );
    assert.equal(owner.outcome, 'updated');
    if (owner.outcome !== 'updated') return;

    const replay = store.upsertHermesInbox(
      'email-lost-response', canonicalHash(input), input, '2026-09-14T10:02:00.000Z',
    );

    assert.equal(replay.outcome, 'replayed');
    if (replay.outcome !== 'replayed') return;
    assert.equal(replay.draftOutcome, 'kept_owner');
    assert.equal(replay.draft?.id, owner.draft.id);
    assert.equal(replay.draft?.author, 'owner');
    assert.equal(replay.draft?.reply.bodyText, 'Owner wording after the lost response');
  } finally { store.close(); }
});

test('email envelope guards reject injected headers, extra MIME, and malformed receipts', () => {
  const reply = replyEnvelope('message-guard', 'thread-guard', 'First line\nSecond line');
  assert.equal(isReplyEnvelope(reply), true);
  assert.equal(isReplyEnvelope({ ...reply, subject: 'Hello\r\nBcc: attacker@example.test' }), false);
  assert.equal(isReplyEnvelope({ ...reply, to: ['friend@example.test\nCc: attacker@example.test'] }), false);
  assert.equal(isReplyEnvelope({ ...reply, mime: 'raw MIME must never be stored' }), false);
  assert.equal(isEmailSendReceiptInput({
    kind: 'email-send', payloadHash: 'A'.repeat(43),
    providerMessageId: 'sent-message', providerThreadId: 'thread-guard',
  }), true);
  assert.equal(isEmailSendReceiptInput({
    kind: 'email-send', payloadHash: 'A'.repeat(43),
    providerMessageId: 'sent-message\r\nX-Injected: yes', providerThreadId: 'thread-guard',
  }), false);
  assert.equal(isEmailSendReceiptInput({
    kind: 'email-send', payloadHash: 'A'.repeat(43),
    providerMessageId: 'sent-message', providerThreadId: 'thread-guard', mime: 'forbidden',
  }), false);
});

test('email send approval pins the exact envelope and settles only an exact replay-safe receipt', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const input = emailInput('message-send', 'thread-send', 'Approved wording');
    const initial = store.upsertHermesInbox(
      'email-send-1', canonicalHash(input), input, '2026-09-14T10:00:00.000Z',
    );
    assert.equal(initial.outcome, 'created');
    if (initial.outcome !== 'created' || !initial.draft) return;

    assert.equal(emailSendPayloadHash({
      inboxId: 'inbox-golden',
      draftId: 'draft-golden',
      reply: replyEnvelope('message-send', 'thread-1', 'Approved wording'),
    }), 'odrnJF5zH-so1Uu51RZZ69M_FpVfVSEPNT1cPEWYi8Y');

    const queued = store.queueEmailSendAction(
      initial.item.id, initial.item.version, initial.draft.id, '2026-09-14T10:01:00.000Z',
    );
    assert.equal(queued.outcome, 'queued');
    if (queued.outcome !== 'queued') return;
    assert.deepEqual(queued.action.payload.reply, initial.draft.reply);
    assert.deepEqual(Object.keys(queued.action.payload).sort(), ['draftId', 'inboxId', 'kind', 'payloadHash', 'reply']);
    assert.deepEqual(Object.keys(queued.action.payload.reply).sort(), [
      'accountId', 'bcc', 'bodyText', 'cc', 'from', 'inReplyTo', 'references',
      'replyToMessageId', 'subject', 'threadId', 'to',
    ]);
    assert.equal(queued.action.payload.payloadHash, emailSendPayloadHash({
      inboxId: initial.item.id, draftId: initial.draft.id, reply: initial.draft.reply,
    }));
    assert.match(queued.action.payload.payloadHash, /^[A-Za-z0-9_-]{43}$/);
    assert.match(queued.action.approval.previewText, /Approved wording/);
    assert.match(queued.action.approval.previewText, new RegExp(queued.action.payload.payloadHash));
    assert.equal(JSON.stringify(queued.action).includes('"mime"'), false);

    assert.equal(store.appendOwnerDraft(
      initial.item.id,
      initial.item.version,
      replyEnvelope('message-send', 'thread-send', 'Changed after approval'),
      '2026-09-14T10:01:01.000Z',
    ).outcome, 'conflict');
    assert.equal(store.updateInboxDecision(initial.item.id, initial.item.version, {
      state: 'resolved', outcome: 'read', snoozedUntil: null,
    }, '2026-09-14T10:01:02.000Z'), null);
    publishFreshGoogleList(store);
    assert.equal(queueGoogleCreate(store, {
      nonce: 'queued_send_make_task',
      inbox: { id: initial.item.id, version: initial.item.version },
    }).outcome, 'inbox_conflict');

    const replacement: HermesInboxUpsertInput = {
      ...input,
      expectedVersion: initial.item.version,
      summary: 'Hermes refreshed the summary after approval.',
      draft: replyEnvelope('message-send', 'thread-send', 'Hermes replacement'),
    };
    const refreshed = store.upsertHermesInbox(
      'email-send-2', canonicalHash(replacement), replacement, '2026-09-14T10:01:03.000Z',
    );
    assert.equal(refreshed.outcome, 'updated');
    if (refreshed.outcome !== 'updated') return;
    assert.equal(refreshed.draftOutcome, 'kept_approved');
    assert.equal(refreshed.item.currentDraftId, initial.draft.id);
    assert.equal(store.listDrafts(initial.item.id).length, 1);

    assert.equal(store.claimEmailSendAction(
      queued.action.id, '2026-09-14T10:01:04.000Z', 120_000, false,
    ).outcome, 'disabled');
    const claim = store.claimEmailSendAction(
      queued.action.id, '2026-09-14T10:01:05.000Z', 120_000, true,
    );
    assert.equal(claim.outcome, 'claimed');
    if (claim.outcome !== 'claimed') return;
    assert.equal(claim.mode, 'send');

    const wrongHash = queued.action.payload.payloadHash.endsWith('A')
      ? `${queued.action.payload.payloadHash.slice(0, -1)}B`
      : `${queued.action.payload.payloadHash.slice(0, -1)}A`;
    assert.equal(store.settleEmailSendAction(claim.action.id, claim.claimId, {
      kind: 'email-send', payloadHash: wrongHash,
      providerMessageId: 'sent-message-send', providerThreadId: 'thread-send',
    }, '2026-09-14T10:01:06.000Z').outcome, 'hash_mismatch');
    assert.equal(store.getAction(claim.action.id)?.state, 'running');
    assert.equal(store.settleEmailSendAction(claim.action.id, claim.claimId, {
      kind: 'email-send', payloadHash: queued.action.payload.payloadHash,
      providerMessageId: 'sent-message-send', providerThreadId: 'different-thread',
    }, '2026-09-14T10:01:07.000Z').outcome, 'invalid_receipt');
    assert.equal(store.settleEmailSendAction(claim.action.id, claim.claimId, {
      kind: 'email-send', payloadHash: queued.action.payload.payloadHash,
      providerMessageId: 'message-send', providerThreadId: 'thread-send',
    }, '2026-09-14T10:01:08.000Z').outcome, 'invalid_receipt');

    const receipt = {
      kind: 'email-send' as const,
      payloadHash: queued.action.payload.payloadHash,
      providerMessageId: 'sent-message-send',
      providerThreadId: 'thread-send',
    };
    const settled = store.settleEmailSendAction(
      claim.action.id, claim.claimId, receipt, '2026-09-14T10:01:09.000Z',
    );
    assert.equal(settled.outcome, 'settled');
    if (settled.outcome !== 'settled') return;
    assert.equal(settled.action.state, 'succeeded');
    assert.equal(settled.item.state, 'resolved');
    assert.equal(settled.item.outcome, 'sent');
    assert.deepEqual(settled.action.receipt, { ...receipt, receivedAt: '2026-09-14T10:01:09.000Z' });
    assert.equal(store.settleEmailSendAction(
      claim.action.id, claim.claimId, receipt, '2026-09-14T10:01:10.000Z',
    ).outcome, 'replayed');
    assert.equal(store.settleEmailSendAction(claim.action.id, claim.claimId, {
      ...receipt, providerMessageId: 'different-sent-message',
    }, '2026-09-14T10:01:11.000Z').outcome, 'receipt_conflict');
    assert.equal(store.updateInboxDecision(settled.item.id, settled.item.version, {
      state: 'open', outcome: null, snoozedUntil: null,
    }, '2026-09-14T10:01:12.000Z'), null);
    assert.equal(store.queueEmailSendAction(
      settled.item.id, settled.item.version, initial.draft.id, '2026-09-14T10:01:13.000Z',
    ).outcome, 'replayed');
  } finally { store.close(); }
});

test('an expired email send becomes unknown and can only be claimed for reconciliation', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const input = emailInput('message-unknown', 'thread-unknown', 'Please confirm.');
    const initial = store.upsertHermesInbox(
      'email-unknown-1', canonicalHash(input), input, '2026-09-14T10:00:00.000Z',
    );
    assert.equal(initial.outcome, 'created');
    if (initial.outcome !== 'created' || !initial.draft) return;
    const queued = store.queueEmailSendAction(
      initial.item.id, initial.item.version, initial.draft.id, '2026-09-14T10:00:01.000Z',
    );
    assert.equal(queued.outcome, 'queued');
    if (queued.outcome !== 'queued') return;
    const sentClaim = store.claimEmailSendAction(
      queued.action.id, '2026-09-14T10:00:02.000Z', 1_000, true,
    );
    assert.equal(sentClaim.outcome, 'claimed');
    if (sentClaim.outcome !== 'claimed') return;
    assert.equal(sentClaim.mode, 'send');
    assert.equal(store.recoverExpiredEmailSendActions('2026-09-14T10:00:02.500Z'), 0);
    assert.equal(store.recoverExpiredEmailSendActions('2026-09-14T10:00:03.000Z'), 1);
    const unknown = store.getAction(queued.action.id);
    assert.equal(unknown?.state, 'unknown');
    assert.equal(unknown?.claimId, null);
    assert.equal(unknown?.leaseUntil, null);
    assert.match(unknown?.error ?? '', /Reconciliation is required/);
    assert.equal(store.appendOwnerDraft(
      initial.item.id,
      initial.item.version,
      replyEnvelope('message-unknown', 'thread-unknown', 'Unsafe changed wording'),
      '2026-09-14T10:00:04.000Z',
    ).outcome, 'conflict');
    assert.equal(store.updateInboxDecision(initial.item.id, initial.item.version, {
      state: 'resolved', outcome: 'read', snoozedUntil: null,
    }, '2026-09-14T10:00:04.000Z'), null);
    publishFreshGoogleList(store);
    assert.equal(queueGoogleCreate(store, {
      nonce: 'unknown_send_make_task',
      inbox: { id: initial.item.id, version: initial.item.version },
    }).outcome, 'inbox_conflict');

    const replacement: HermesInboxUpsertInput = {
      ...input,
      expectedVersion: initial.item.version,
      draft: replyEnvelope('message-unknown', 'thread-unknown', 'Unsafe Hermes replacement'),
    };
    const upserted = store.upsertHermesInbox(
      'email-unknown-2', canonicalHash(replacement), replacement, '2026-09-14T10:00:04.000Z',
    );
    assert.equal(upserted.outcome, 'updated');
    if (upserted.outcome !== 'updated') return;
    assert.equal(upserted.draftOutcome, 'kept_approved');
    assert.equal(upserted.item.currentDraftId, initial.draft.id);

    const reconciliation = store.claimEmailSendAction(
      queued.action.id, '2026-09-14T10:00:05.000Z', 1_000, false,
    );
    assert.equal(reconciliation.outcome, 'claimed');
    if (reconciliation.outcome !== 'claimed') return;
    assert.equal(reconciliation.mode, 'reconcile');
    assert.equal(reconciliation.action.attemptCount, 2);
    const expiredReceipt = store.settleEmailSendAction(reconciliation.action.id, reconciliation.claimId, {
      kind: 'email-send', payloadHash: queued.action.payload.payloadHash,
      providerMessageId: 'sent-message-unknown', providerThreadId: 'thread-unknown',
    }, '2026-09-14T10:00:06.000Z');
    assert.equal(expiredReceipt.outcome, 'invalid_claim');
    assert.equal(expiredReceipt.action.state, 'unknown');
    const next = store.claimEmailSendAction(
      queued.action.id, '2026-09-14T10:00:07.000Z', 1_000, false,
    );
    assert.equal(next.outcome, 'claimed');
    if (next.outcome === 'claimed') assert.equal(next.mode, 'reconcile');
  } finally { store.close(); }
});

test('the action decoder keeps Hermes version zero migration actions across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-focus-action-decoder-'));
  const path = join(dir, 'focus.sqlite');
  let store = openStore(path, workspaceFixture());
  try {
    const source = { kind: 'hermes' as const, boardSlug: 'personal-tasks', taskId: 'hermes-zero', version: 0 };
    const payload: Extract<ActionRow['payload'], { kind: 'task-migration' }> = {
      kind: 'task-migration', migrationId: `migration-${'a'.repeat(32)}`, previewHash: 'preview-hash',
      sourceKey: 'hermes:personal-tasks:hermes-zero', sourceSnapshot: { id: 'hermes-zero', version: 0 },
      operation: 'bind', taskId: 'legacy-open', source, sourceAliases: [source],
      destination: { accountId: 'google-account', listId: 'my-tasks' }, destinationName: 'My Tasks',
      existingExternalId: 'google-existing', targetSnapshot: {
        title: 'Migrated task', status: 'open', doOn: '2026-09-20', etag: 'etag-1',
        observedAt: '2026-09-14T09:00:00.000Z',
      },
      nonce: null, title: 'Migrated task', notes: 'Preserved notes', doOn: '2026-09-20',
      plan: {
        priority: 'medium', waiting: false, deadlineOn: '2026-09-21', plannedOn: null,
        plannedAt: '2026-09-20T09:00:00.000Z', estimateMinutes: 30,
      },
      reminder: null, preservedReminders: [], resumedFromActionId: null,
    };
    const action: ActionRow = {
      id: 'migration-hermes-zero', version: 1, payload,
      operationKey: 'task-migration:hermes-zero', requestHash: canonicalHash(payload),
      approval: { actor: 'owner', at: '2026-09-14T10:00:00.000Z', previewText: 'Bind Hermes task.' },
      state: 'queued', attemptCount: 0, nextAttemptAt: null, claimId: null, leaseUntil: null,
      receipt: null, error: null, createdAt: '2026-09-14T10:00:00.000Z', updatedAt: '2026-09-14T10:00:00.000Z',
    };
    store.insertApprovedAction(action);
    assert.equal(store.getAction(action.id)?.payload.kind, 'task-migration');
    store.close();
    store = openStore(path);
    const reopened = store.getAction(action.id);
    assert.equal(reopened?.payload.kind, 'task-migration');
    assert.equal(reopened?.payload.kind === 'task-migration' ? reopened.payload.source.version : null, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test('jobs support claims, questions, answers, retry-safe results, send back, and settlement', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const created = store.createJob({
      title: 'Check the timetable', instruction: 'Confirm the room change.', taskId: null, inboxId: null,
    }, '2026-09-14T10:00:00.000Z');
    assert.equal(created.outcome, 'created');
    if (created.outcome !== 'created') return;

    const firstClaim = store.claimJob(created.job.id, '2026-09-14T10:00:01.000Z', 120_000);
    assert.equal(firstClaim.outcome, 'claimed');
    if (firstClaim.outcome !== 'claimed') return;
    const progress = store.postJobResult(created.job.id, firstClaim.claimId, {
      kind: 'progress', text: 'Checking the published timetable.', url: null,
    }, '2026-09-14T10:00:02.000Z', 120_000);
    assert.equal(progress.outcome, 'updated');
    const progressReplay = store.postJobResult(created.job.id, firstClaim.claimId, {
      kind: 'progress', text: 'Checking the published timetable.', url: null,
    }, '2026-09-14T10:00:03.000Z', 120_000);
    assert.equal(progressReplay.outcome, 'replayed');
    assert.equal(store.listJobUpdates(created.job.id).length, 1);

    const question = store.postJobResult(created.job.id, firstClaim.claimId, {
      kind: 'question', text: 'Should I use the provisional room?', url: null,
    }, '2026-09-14T10:00:04.000Z', 120_000);
    assert.equal(question.outcome, 'updated');
    if (question.outcome !== 'updated') return;
    assert.equal(question.job.state, 'needs_you');
    assert.equal(question.job.claimId, null);
    const answer = store.answerJob(created.job.id, question.job.version, 'Use the confirmed room only.', '2026-09-14T10:00:05.000Z');
    assert.equal(answer.outcome, 'updated');
    if (answer.outcome !== 'updated') return;
    assert.equal(answer.job.state, 'working');
    assert.equal(answer.job.claimId, null);

    const secondClaim = store.claimJob(created.job.id, '2026-09-14T10:00:06.000Z', 120_000);
    assert.equal(secondClaim.outcome, 'claimed');
    if (secondClaim.outcome !== 'claimed') return;
    const result = store.postJobResult(created.job.id, secondClaim.claimId, {
      kind: 'result', text: 'The confirmed room is IT125.', url: 'https://example.test/timetable',
    }, '2026-09-14T10:00:07.000Z', 120_000);
    assert.equal(result.outcome, 'updated');
    if (result.outcome !== 'updated') return;
    assert.equal(result.job.state, 'review');
    const sentBack = store.sendBackJob(created.job.id, result.job.version, 'Check the lecturer notice too.', '2026-09-14T10:00:08.000Z');
    assert.equal(sentBack.outcome, 'updated');
    if (sentBack.outcome !== 'updated') return;
    assert.equal(sentBack.job.state, 'queued');

    const thirdClaim = store.claimJob(created.job.id, '2026-09-14T10:00:09.000Z', 120_000);
    assert.equal(thirdClaim.outcome, 'claimed');
    if (thirdClaim.outcome !== 'claimed') return;
    const finalResult = store.postJobResult(created.job.id, thirdClaim.claimId, {
      kind: 'result', text: 'The lecturer notice confirms IT125.', url: null,
    }, '2026-09-14T10:00:10.000Z', 120_000);
    assert.equal(finalResult.outcome, 'updated');
    if (finalResult.outcome !== 'updated') return;
    const settled = store.settleJob(created.job.id, finalResult.job.version, 'dropped', '2026-09-14T10:00:11.000Z');
    assert.equal(settled.outcome, 'settled');
    if (settled.outcome !== 'settled') return;
    assert.equal(settled.job.state, 'settled');
    assert.equal(settled.job.outcome, 'dropped');
    assert.deepEqual(store.listJobUpdates(created.job.id).map(update => update.kind), [
      'progress', 'question', 'answer', 'result', 'sent_back', 'result', 'settled',
    ]);
    const resultChange = store.listChanges(0, 500).changes.find(change =>
      change.entityId === created.job.id && change.details?.update &&
      (change.details.update as { kind?: unknown }).kind === 'result');
    assert.equal((resultChange?.details?.update as { text?: unknown } | undefined)?.text, 'The confirmed room is IT125.');
  } finally { store.close(); }
});

test('an expired job lease rejects the old claim and can be reclaimed', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const created = store.createJob({ title: 'Lease test', instruction: 'Wait.', taskId: null, inboxId: null },
      '2026-09-14T10:00:00.000Z');
    assert.equal(created.outcome, 'created');
    if (created.outcome !== 'created') return;
    const first = store.claimJob(created.job.id, '2026-09-14T10:00:01.000Z', 1_000);
    assert.equal(first.outcome, 'claimed');
    if (first.outcome !== 'claimed') return;
    assert.equal(store.postJobResult(created.job.id, first.claimId, {
      kind: 'result', text: 'Too late.', url: null,
    }, '2026-09-14T10:00:03.000Z', 1_000).outcome, 'invalid_claim');
    const second = store.claimJob(created.job.id, '2026-09-14T10:00:03.000Z', 1_000);
    assert.equal(second.outcome, 'claimed');
    if (second.outcome === 'claimed') assert.notEqual(second.claimId, first.claimId);
  } finally { store.close(); }
});

test('accepting a linked job atomically queues its normal Google completion action', () => {
  const data = workspaceFixture();
  data.tasks[0].externalLinks = [{
    provider: 'google_tasks', connectionId: 'google-generation', containerId: 'uni-list', containerName: 'Study',
    externalId: 'google-task-job', policy: 'completion_only', sourceStatus: 'needsAction', sourceVersion: 'etag-old',
    linkedAt: '2026-09-01T08:00:00.000Z',
  }];
  const store = openStore(':memory:', data);
  try {
    store.publishProviderScope({
      provider: 'google', resourceKind: 'task-list', accountId: 'google-generation', connectionGeneration: 'google-generation',
      containerId: 'uni-list', containerName: 'Study', coverageFrom: null, coverageTo: null,
      fetchedAt: '2026-09-14T10:00:00.000Z',
      records: [{
        provider: 'google', kind: 'task', connectionId: 'google-generation', containerId: 'uni-list', containerName: 'Study',
        externalId: 'google-task-job', title: 'Plan autumn term', status: 'needsAction', startsAt: null, endsAt: null,
        startsOn: null, endsOn: null, allDay: false, dueOn: null, completedAt: null,
        sourceUpdatedAt: '2026-09-14T09:00:00.000Z', sourceVersion: 'etag-current', completionWritable: true,
        notes: null, parentId: null, position: null, sourceUrl: null, sourceTimeZone: null,
      }],
    });
    const task = store.getTask('legacy-open');
    assert.ok(task);
    const created = store.createJob({
      title: 'Finish the plan', instruction: 'Prepare the final plan.', taskId: task.id, inboxId: null,
    }, '2026-09-14T10:00:01.000Z');
    assert.equal(created.outcome, 'created');
    if (created.outcome !== 'created') return;
    const claim = store.claimJob(created.job.id, '2026-09-14T10:00:02.000Z', 120_000);
    assert.equal(claim.outcome, 'claimed');
    if (claim.outcome !== 'claimed') return;
    const review = store.postJobResult(created.job.id, claim.claimId, {
      kind: 'result', text: 'The plan is ready.', url: null,
    }, '2026-09-14T10:00:03.000Z', 120_000);
    assert.equal(review.outcome, 'updated');
    if (review.outcome !== 'updated') return;

    const missingVersion = store.settleJob(created.job.id, review.job.version, 'accepted', '2026-09-14T10:00:04.000Z');
    assert.equal(missingVersion.outcome, 'task_version_required');
    assert.equal(store.getJob(created.job.id)?.state, 'review');
    assert.equal(store.listActions().length, 0);
    const stale = store.settleJob(created.job.id, review.job.version, 'accepted', '2026-09-14T10:00:05.000Z', task.version - 1);
    assert.equal(stale.outcome, 'task_conflict');
    assert.equal(store.listActions().length, 0);

    const accepted = store.settleJob(created.job.id, review.job.version, 'accepted', '2026-09-14T10:00:06.000Z', task.version);
    assert.equal(accepted.outcome, 'settled');
    if (accepted.outcome !== 'settled') return;
    assert.equal(accepted.job.outcome, 'accepted');
    assert.equal(accepted.action?.payload.kind, 'task-status');
    assert.equal(accepted.action?.state, 'queued');
    assert.equal(store.getTask(task.id)?.intentVersion, task.intentVersion + 1);
  } finally { store.close(); }
});

test('accepting completed linked work replaces queued and failed reopens but rejects a running reopen', () => {
  for (const priorState of ['queued', 'failed', 'running'] as const) {
    const data = workspaceFixture();
    data.tasks[0].externalLinks = [{
      provider: 'google_tasks', connectionId: 'google-generation', containerId: 'uni-list', containerName: 'Study',
      externalId: `google-task-${priorState}`, policy: 'completion_only', sourceStatus: 'completed', sourceVersion: 'etag-old',
      linkedAt: '2026-09-01T08:00:00.000Z',
    }];
    const store = openStore(':memory:', data);
    try {
      store.publishProviderScope({
        provider: 'google', resourceKind: 'task-list', accountId: 'google-generation', connectionGeneration: 'google-generation',
        containerId: 'uni-list', containerName: 'Study', coverageFrom: null, coverageTo: null,
        fetchedAt: '2026-09-14T10:00:00.000Z',
        records: [{
          provider: 'google', kind: 'task', connectionId: 'google-generation', containerId: 'uni-list', containerName: 'Study',
          externalId: `google-task-${priorState}`, title: 'Plan autumn term', status: 'completed', startsAt: null, endsAt: null,
          startsOn: null, endsOn: null, allDay: false, dueOn: null, completedAt: '2026-09-14T09:00:00.000Z',
          sourceUpdatedAt: '2026-09-14T09:00:00.000Z', sourceVersion: 'etag-current', completionWritable: true,
          notes: null, parentId: null, position: null, sourceUrl: null, sourceTimeZone: null,
        }],
      });
      const task = store.getTask('legacy-open');
      assert.ok(task);
      assert.equal(task.observed?.status, 'completed');
      const reopen = store.queueTaskStatusAction(task.id, task.version, 'open', '2026-09-14T10:00:01.000Z');
      assert.equal(reopen.outcome, 'queued');
      if (reopen.outcome !== 'queued') continue;

      if (priorState !== 'queued') {
        const claimed = store.claimNextTaskStatusAction('2026-09-14T10:00:02.000Z', 120_000);
        assert.equal(claimed?.id, reopen.action.id);
        assert.ok(claimed?.claimId);
        if (priorState === 'failed') {
          const failed = store.settleTaskStatusAction(reopen.action.id, claimed.claimId, {
            outcome: 'failed', notice: 'Temporary provider failure.', retryable: true,
          }, '2026-09-14T10:00:03.000Z');
          assert.equal(failed?.state, 'failed');
        }
      }

      const created = store.createJob({
        title: 'Finish the plan', instruction: 'Prepare the final plan.', taskId: task.id, inboxId: null,
      }, '2026-09-14T10:00:04.000Z');
      assert.equal(created.outcome, 'created');
      if (created.outcome !== 'created') continue;
      const claim = store.claimJob(created.job.id, '2026-09-14T10:00:05.000Z', 120_000);
      assert.equal(claim.outcome, 'claimed');
      if (claim.outcome !== 'claimed') continue;
      const review = store.postJobResult(created.job.id, claim.claimId, {
        kind: 'result', text: 'The plan is ready.', url: null,
      }, '2026-09-14T10:00:06.000Z', 120_000);
      assert.equal(review.outcome, 'updated');
      if (review.outcome !== 'updated') continue;

      const currentTask = store.getTask(task.id);
      assert.ok(currentTask);
      const accepted = store.settleJob(
        created.job.id, review.job.version, 'accepted', '2026-09-14T10:00:07.000Z', currentTask.version,
      );
      if (priorState === 'running') {
        assert.equal(accepted.outcome, 'task_conflict');
        assert.equal(store.getJob(created.job.id)?.state, 'review');
        assert.equal(store.getAction(reopen.action.id)?.state, 'running');
        assert.equal(store.listActions().length, 1);
        continue;
      }
      assert.equal(accepted.outcome, 'settled', priorState);
      if (accepted.outcome !== 'settled') continue;
      assert.equal(accepted.action?.payload.kind, 'task-status');
      if (accepted.action?.payload.kind === 'task-status') assert.equal(accepted.action.payload.after, 'completed');
      assert.equal(store.getAction(reopen.action.id)?.state, 'superseded');
      assert.equal(store.getTask(task.id)?.intentVersion, currentTask.intentVersion + 1);
    } finally { store.close(); }
  }
});

test('active work cannot be dropped, and accepting an already-completed task queues no action', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const droppedJob = store.createJob({ title: 'Drop me', instruction: 'No longer needed.', taskId: null, inboxId: null },
      '2026-09-14T10:00:00.000Z');
    assert.equal(droppedJob.outcome, 'created');
    if (droppedJob.outcome === 'created') {
      assert.equal(store.settleJob(
        droppedJob.job.id, droppedJob.job.version, 'dropped', '2026-09-14T10:00:01.000Z',
      ).outcome, 'invalid_state');
      assert.equal(store.getJob(droppedJob.job.id)?.state, 'queued');
    }

    const completed = store.listTasks().find(task => task.observed?.status === 'completed');
    assert.ok(completed);
    const created = store.createJob({
      title: 'Review completed work', instruction: 'Summarise it.', taskId: completed.id, inboxId: null,
    }, '2026-09-14T10:00:02.000Z');
    assert.equal(created.outcome, 'created');
    if (created.outcome !== 'created') return;
    const claim = store.claimJob(created.job.id, '2026-09-14T10:00:03.000Z', 120_000);
    assert.equal(claim.outcome, 'claimed');
    if (claim.outcome !== 'claimed') return;
    const review = store.postJobResult(created.job.id, claim.claimId, {
      kind: 'result', text: 'Reviewed.', url: null,
    }, '2026-09-14T10:00:04.000Z', 120_000);
    assert.equal(review.outcome, 'updated');
    if (review.outcome !== 'updated') return;
    const accepted = store.settleJob(created.job.id, review.job.version, 'accepted', '2026-09-14T10:00:05.000Z');
    assert.equal(accepted.outcome, 'settled');
    if (accepted.outcome === 'settled') assert.equal(accepted.action, null);
  } finally { store.close(); }
});

test('task creation atomically stores approval, planning, and the Inbox outcome', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    publishFreshGoogleList(store);
    const proposal = emailInput('task-source');
    const upsert = store.upsertHermesInbox('task-source', canonicalHash(proposal), proposal, '2026-09-14T10:00:30.000Z');
    assert.equal(upsert.outcome, 'created');
    if (upsert.outcome !== 'created') return;
    const queued = queueGoogleCreate(store, { inbox: { id: upsert.item.id, version: upsert.item.version } });
    assert.equal(queued.outcome, 'queued');
    if (queued.outcome !== 'queued') return;
    assert.equal(queued.task.binding.kind, 'pending');
    assert.equal(queued.task.observed, null);
    assert.equal(queued.plan.priority, 'high');
    assert.equal(queued.plan.deadlineOn, '2026-09-21');
    assert.equal(queued.action.payload.kind, 'task-create');
    assert.match(queued.action.approval.previewText, /My Tasks/);
    assert.match(queued.action.approval.previewText, /Fox-Focus-ID: nonce_create_1/);
    assert.equal(queued.inbox?.state, 'resolved');
    assert.equal(queued.inbox?.outcome, 'task');
    assert.equal(queued.inbox?.taskId, queued.task.id);

    const replay = queueGoogleCreate(store, { inbox: { id: upsert.item.id, version: upsert.item.version } });
    assert.equal(replay.outcome, 'replayed');
    assert.equal(store.listActions().filter(action => action.payload.kind === 'task-create').length, 1);
    assert.equal(store.listTasks().filter(task => task.binding.kind === 'pending').length, 1);

    const conflict = store.queueTaskCreateAction({
      destination: { accountId: 'google-generation', listId: 'my-tasks' }, destinationName: 'My Tasks',
      nonce: 'nonce_create_1', title: 'Different content', notes: '', finalNotes: 'Fox-Focus-ID: nonce_create_1',
      doOn: null, plan: {
        priority: 'medium', waiting: false, deadlineOn: null, plannedOn: null, plannedAt: null, estimateMinutes: null,
      },
    }, '2026-09-14T10:02:00.000Z');
    assert.equal(conflict.outcome, 'idempotency_conflict');
  } finally { store.close(); }
});

test('a nonce-marked list snapshot binds the pending row and settles the create without a duplicate', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    publishFreshGoogleList(store);
    const queued = queueGoogleCreate(store, { nonce: 'nonce_snapshot' });
    assert.equal(queued.outcome, 'queued');
    if (queued.outcome !== 'queued') return;
    const claim = store.claimNextTaskCreateAction('2026-09-14T10:01:01.000Z', 120_000);
    assert.equal(claim?.mode, 'create');
    assert.ok(claim?.action.claimId);

    store.publishProviderScope({
      provider: 'google', resourceKind: 'task-list', accountId: 'google-generation',
      connectionGeneration: 'google-generation', containerId: 'my-tasks', containerName: 'My Tasks',
      coverageFrom: null, coverageTo: null, fetchedAt: '2026-09-14T10:01:02.000Z',
      records: [{
        provider: 'google', kind: 'task', connectionId: 'google-generation', containerId: 'my-tasks',
        containerName: 'My Tasks', externalId: 'remote-created', title: 'Created once', status: 'needsAction',
        startsAt: null, endsAt: null, startsOn: null, endsOn: null, allDay: false, dueOn: '2026-09-20',
        completedAt: null, sourceUpdatedAt: '2026-09-14T10:01:02.000Z', sourceVersion: 'etag-created',
        completionWritable: true, notes: 'Owner notes\n\nFox-Focus-ID: nonce_snapshot', parentId: null,
        position: '0001', sourceUrl: 'https://tasks.google.com/task/remote-created', sourceTimeZone: null,
      }],
    });
    const task = store.getTask(queued.task.id);
    assert.equal(task?.binding.kind, 'google');
    if (task?.binding.kind === 'google') assert.equal(task.binding.ref.externalId, 'remote-created');
    assert.equal(store.getAction(queued.action.id)?.state, 'succeeded');
    assert.equal(store.listTasks().filter(candidate =>
      candidate.binding.kind === 'google' && candidate.binding.ref.externalId === 'remote-created').length, 1);

    const lateSettlement = store.settleTaskCreateAction(queued.action.id, claim?.action.claimId ?? '', {
      outcome: 'succeeded', externalId: 'remote-created', current: {
        title: 'Created once', notes: 'Owner notes\n\nFox-Focus-ID: nonce_snapshot', state: 'open',
        completedAt: null, dueOn: '2026-09-20', parentId: null, position: '0001',
        sourceUrl: 'https://tasks.google.com/task/remote-created', version: 'etag-created',
        updatedAt: '2026-09-14T10:01:02.000Z', completionWritable: true,
      },
    }, '2026-09-14T10:01:03.000Z');
    assert.equal(lateSettlement?.state, 'succeeded');
  } finally { store.close(); }
});

test('expired create leases reconcile, and removed destinations surface after a successful readback', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    publishFreshGoogleList(store);
    const queued = queueGoogleCreate(store, { nonce: 'nonce_expired' });
    assert.equal(queued.outcome, 'queued');
    if (queued.outcome !== 'queued') return;
    const first = store.claimNextTaskCreateAction('2026-09-14T10:01:01.000Z', 1_000);
    assert.equal(first?.mode, 'create');
    const recovered = store.claimNextTaskCreateAction('2026-09-14T10:01:03.000Z', 1_000);
    assert.equal(recovered?.mode, 'reconcile');
    assert.notEqual(recovered?.action.claimId, first?.action.claimId);

    assert.equal(store.retireProviderScope({
      provider: 'google', resourceKind: 'task-list', accountId: 'google-generation',
      connectionGeneration: 'google-generation', containerId: 'my-tasks',
    }), true);
    const settled = store.settleTaskCreateAction(queued.action.id, recovered?.action.claimId ?? '', {
      outcome: 'succeeded', externalId: 'remote-after-removal', current: {
        title: 'Created once', notes: 'Owner notes\n\nFox-Focus-ID: nonce_expired', state: 'open',
        completedAt: null, dueOn: '2026-09-20', parentId: null, position: null, sourceUrl: null,
        version: 'etag-after-removal', updatedAt: '2026-09-14T10:01:04.000Z', completionWritable: true,
      },
    }, '2026-09-14T10:01:04.000Z');
    assert.equal(settled?.state, 'conflict');
    assert.equal(store.getTask(queued.task.id)?.unavailableAt, '2026-09-14T10:01:04.000Z');
    assert.equal(store.getTask(queued.task.id)?.binding.kind, 'google');
  } finally { store.close(); }
});

test('Inbox snoozes require a future instant and wake through a versioned system transition', () => {
  const store = openStore(':memory:', workspaceFixture());
  try {
    const item = store.getInboxItem('legacy-inbox');
    assert.ok(item);
    assert.equal(isInboxDecisionInput({
      version: item.version, state: 'waiting', outcome: null, snoozedUntil: null,
    }), false);
    assert.equal(isInboxDecisionInput({
      version: item.version, state: 'open', outcome: null, snoozedUntil: '2026-09-14T10:00:00.000Z',
    }), false);
    assert.equal(isInboxDecisionInput({
      version: item.version, state: 'waiting', outcome: null, snoozedUntil: '2026-09-14T10:00:00.000Z',
    }), true);
    for (const invalid of [
      { state: 'waiting' as const, outcome: null, snoozedUntil: null },
      { state: 'waiting' as const, outcome: null, snoozedUntil: 'not-an-instant' },
      { state: 'waiting' as const, outcome: null, snoozedUntil: '2026-09-14T08:59:59.000Z' },
      { state: 'open' as const, outcome: null, snoozedUntil: '2026-09-14T10:00:00.000Z' },
    ]) {
      assert.equal(store.updateInboxDecision(item.id, item.version, invalid, '2026-09-14T09:00:00.000Z'), null);
      assert.equal(store.getInboxItem(item.id)?.version, item.version);
    }
    const waiting = store.updateInboxDecision(item.id, item.version, {
      state: 'waiting', outcome: null, snoozedUntil: '2026-09-14T10:00:00.000Z',
    }, '2026-09-14T09:00:00.000Z');
    assert.equal(waiting?.state, 'waiting');
    assert.equal(store.wakeDueInboxItems('2026-09-14T10:00:01.000Z'), 1);
    const open = store.getInboxItem(item.id);
    assert.equal(open?.state, 'open');
    assert.equal(open?.snoozedUntil, null);
    assert.equal(open?.version, (waiting?.version ?? 0) + 1);
    assert.equal(store.wakeDueInboxItems('2026-09-14T10:00:02.000Z'), 0);
    assert.ok(store.listChanges(0, 500).changes.some(change =>
      change.mutationKey === `system:inbox-wake:${item.id}:${open?.version}`));
  } finally { store.close(); }
});
