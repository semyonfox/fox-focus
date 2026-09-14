import { createHash } from 'node:crypto';
import { isDateKey } from '../src/calendar-time.ts';
import type { HermesFeed, HermesTask } from '../src/hermes-model.ts';
import { isTask, type Area, type Task, type TaskExternalLink } from '../src/model.ts';
import {
  taskCreateNotes,
  type ActionRow,
  type ReminderRow,
  type TaskMigrationBlocker,
  type TaskMigrationPlan,
  type TaskMigrationPreview,
  type TaskMigrationPreviewItem,
  type TaskMigrationSummary,
  type TaskRow,
} from '../src/row-model.ts';
import type { GoogleTaskDestinationCatalogue } from './integrations.ts';
import { canonicalHash, canonicalJson } from './row-store.ts';
import type { Store, StoredRecord } from './store.ts';

function stableSuffix(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 32);
}

function googleLinks(task: Task): TaskExternalLink[] {
  return (task.externalLinks ?? []).filter(link => link.provider === 'google_tasks');
}

function hermesLinks(task: Task, boardSlug: string): TaskExternalLink[] {
  return (task.externalLinks ?? []).filter(link =>
    link.provider === 'hermes' && link.containerId === boardSlug);
}

function migrationPlan(taskId: string, store: Store): TaskMigrationPlan | null {
  const plan = store.getTaskPlan(taskId);
  return plan ? {
    priority: plan.priority,
    waiting: plan.waiting,
    deadlineOn: plan.deadlineOn,
    plannedOn: plan.plannedOn,
    plannedAt: plan.plannedAt,
    estimateMinutes: plan.estimateMinutes,
  } : null;
}

function migrationPlanVersion(taskId: string, store: Store): number | null {
  return store.getTaskPlan(taskId)?.version ?? null;
}

function hermesPriority(priority: number): TaskMigrationPlan['priority'] {
  if (priority >= 4) return 'high';
  if (priority >= 2) return 'medium';
  return 'low';
}

function durationMinutes(value: string): number | null {
  const hours = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)$/i);
  if (hours) {
    const minutes = Math.round(Number(hours[1]) * 60);
    return minutes >= 1 && minutes <= 1_440 ? minutes : null;
  }
  const minutes = value.trim().match(/^(\d+)\s*(?:m|mins?|minutes?)$/i);
  if (!minutes) return null;
  const parsed = Number(minutes[1]);
  return parsed >= 1 && parsed <= 1_440 ? parsed : null;
}

function utcInstant(value: string | null): string | null | undefined {
  if (value === null) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : new Date(milliseconds).toISOString();
}

function planForHermes(task: HermesTask): TaskMigrationPlan {
  const due = task.due.trim();
  return {
    priority: hermesPriority(task.priority),
    waiting: task.localState === 'waiting',
    deadlineOn: isDateKey(due) ? due : null,
    plannedOn: null,
    plannedAt: utcInstant(task.scheduledAt) ?? null,
    estimateMinutes: durationMinutes(task.duration),
  };
}

function hermesDueConflict(task: HermesTask): string | null {
  const due = task.due.trim();
  const lowered = due.toLowerCase();
  if (!due || lowered === 'no deadline' || isDateKey(due)) return null;
  if (lowered === 'waiting' && task.localState === 'waiting') return null;
  return `Hermes task ${task.id} has a due label without an exact migration date.`;
}

function hermesPlanningConflict(task: HermesTask): string | null {
  const due = hermesDueConflict(task);
  if (due) return due;
  const duration = task.duration.trim();
  if (duration && duration.toLowerCase() !== 'no estimate' && durationMinutes(duration) === null) {
    return `Hermes task ${task.id} has a duration without an exact minute value.`;
  }
  if (task.scheduledAt !== null && utcInstant(task.scheduledAt) === undefined) {
    return `Hermes task ${task.id} has a scheduled time that is not an offset-bearing instant.`;
  }
  if (task.reminderFireAt !== null && utcInstant(task.reminderFireAt) === undefined) {
    return `Hermes task ${task.id} has a reminder time that is not an offset-bearing instant.`;
  }
  return null;
}

function defaultPlan(plan: TaskMigrationPlan): boolean {
  return plan.priority === 'medium' && !plan.waiting && plan.deadlineOn === null &&
    plan.plannedOn === null && plan.plannedAt === null && plan.estimateMinutes === null;
}

function samePlan(first: TaskMigrationPlan, second: TaskMigrationPlan): boolean {
  return canonicalHash(first) === canonicalHash(second);
}

function destinationForArea(catalogue: GoogleTaskDestinationCatalogue, area: Area) {
  const explicit = catalogue.destinations.filter(destination =>
    destination.fresh && destination.accountId === catalogue.accountId &&
    destination.explicitMapping && destination.area === area);
  if (explicit.length === 1) return explicit[0];
  return catalogue.fallbackListId
    ? catalogue.destinations.find(destination =>
        destination.fresh && destination.accountId === catalogue.accountId &&
        destination.listId === catalogue.fallbackListId) ?? null
    : null;
}

function freshDestination(
  catalogue: GoogleTaskDestinationCatalogue,
  accountId: string,
  listId: string,
) {
  if (!catalogue.connectionGeneration || catalogue.accountId !== accountId) return null;
  return catalogue.destinations.find(destination =>
    destination.fresh && destination.accountId === accountId && destination.listId === listId) ?? null;
}

function preservedRemindersForTask(store: Store, taskId: string): TaskMigrationPreviewItem['preservedReminders'] {
  return store.listReminders()
    .filter(reminder => reminder.target.kind === 'task' && reminder.target.id === taskId)
    .map(reminder => ({
      id: reminder.id,
      version: reminder.version,
      fireAt: reminder.fireAt,
      state: reminder.state,
    }))
    .sort((first, second) => first.id.localeCompare(second.id));
}

function taskReferences(store: Store): Set<string> {
  const referenced = new Set<string>();
  for (const item of store.listInboxItems()) if (item.taskId) referenced.add(item.taskId);
  for (const job of store.listJobs()) if (job.taskId) referenced.add(job.taskId);
  for (const reminder of store.listReminders()) {
    if (reminder.target.kind === 'task') referenced.add(reminder.target.id);
  }
  return referenced;
}

function taskRecordStatus(record: StoredRecord): 'open' | 'completed' {
  return record.status === 'completed' ? 'completed' : 'open';
}

function targetSnapshot(record: StoredRecord): NonNullable<TaskMigrationPreviewItem['targetSnapshot']> {
  return {
    title: record.title,
    status: taskRecordStatus(record),
    doOn: record.dueOn,
    etag: record.sourceVersion,
    observedAt: record.sourceUpdatedAt,
  };
}

function providerIdentity(accountId: string, listId: string, externalId: string): string {
  return `${accountId}\u0000${listId}\u0000${externalId}`;
}

export function taskMigrationPreviewHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isLegacyAccountIdentity(accountId: string): boolean {
  return accountId.startsWith('legacy:') ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId);
}

function approvalText(item: Omit<TaskMigrationPreviewItem, 'approvalText'>): string {
  const source = item.source.kind === 'fox'
    ? `Fox Focus task ${item.source.taskId}`
    : `Hermes task ${item.source.taskId} on ${item.source.boardSlug}`;
  const planning = [
    `Local priority: ${item.plan.priority}`,
    `Local waiting: ${item.plan.waiting}`,
    `Local deadline: ${item.plan.deadlineOn ?? 'none'}`,
    `Local planned date: ${item.plan.plannedOn ?? 'none'}`,
    `Local planned instant: ${item.plan.plannedAt ?? 'none'}`,
    `Local estimate minutes: ${item.plan.estimateMinutes ?? 'none'}`,
    `Reminder: ${item.reminder ? `${item.reminder.id} at ${item.reminder.fireAt}` : 'none'}`,
    ...item.preservedReminders.map(reminder =>
      `Existing reminder unchanged: ${reminder.id} at ${reminder.fireAt} (${reminder.state}, version ${reminder.version})`),
    ...(item.sourceAliases.length
      ? [`Source aliases: ${item.sourceAliases.map(alias =>
          alias.kind === 'hermes' ? `${alias.boardSlug}/${alias.taskId}` : `fox/${alias.taskId}`).join(', ')}`]
      : []),
    ...(item.replacesActionId
      ? [`Resume ${item.resumeMode} from terminal migration action ${item.replacesActionId}.`]
      : []),
  ];
  if (item.operation === 'bind') {
    return [
      `Bind ${source} to Google Tasks account ${item.destination.accountId}, list "${item.destination.listName}" (${item.destination.listId}), task ${item.existingExternalId}.`,
      `Source title: ${item.title}`,
      `Source status: ${item.status}`,
      `Google title: ${item.targetSnapshot?.title ?? ''}`,
      `Google status: ${item.targetSnapshot?.status ?? ''}`,
      `Google due: ${item.targetSnapshot?.doOn ?? 'none'}`,
      `Google ETag: ${item.targetSnapshot?.etag ?? 'none'}`,
      `Keep local planning on Fox Focus task ${item.localTaskId}.`,
      ...planning,
    ].join('\n');
  }
  return [
    `Create ${source} in Google Tasks account ${item.destination.accountId}, list "${item.destination.listName}" (${item.destination.listId}).`,
    `Source title: ${item.title}`,
    `Source status: ${item.status}`,
    `Google title: ${item.outgoing?.title ?? ''}`,
    `Google status: open`,
    `Google notes: ${item.outgoing?.notes ?? ''}`,
    `Google due: ${item.outgoing?.doOn ?? 'none'}`,
    `Keep local planning on Fox Focus task ${item.localTaskId}.`,
    ...planning,
  ].join('\n');
}

function withApproval(item: Omit<TaskMigrationPreviewItem, 'approvalText'>): TaskMigrationPreviewItem {
  return { ...item, approvalText: approvalText(item) };
}

function sourceBlocker(sourceKey: string, code: TaskMigrationBlocker['code'], message: string): TaskMigrationBlocker {
  return { sourceKey, code, message };
}

function reminderForHermes(task: HermesTask): TaskMigrationPreviewItem['reminder'] {
  if (task.reminderMode === 'none' || !task.reminderFireAt) return null;
  const fireAt = utcInstant(task.reminderFireAt);
  if (!fireAt) return null;
  return {
    id: `reminder-migration-hermes-${stableSuffix(task.id)}`,
    fireAt,
  };
}

function validCreatePayload(title: string, notes: string): boolean {
  return title.trim().length > 0 && title.length <= 1_024 && !/[\r\n]/.test(title) && notes.length <= 8_192;
}

export function buildTaskMigrationPreview(
  store: Store,
  catalogue: GoogleTaskDestinationCatalogue,
  feed: HermesFeed,
  generatedAt = new Date().toISOString(),
): TaskMigrationPreview {
  const items: TaskMigrationPreviewItem[] = [];
  const blockers: TaskMigrationBlocker[] = [];
  const accountId = catalogue.accountId;
  if (!accountId || catalogue.destinations.length === 0) {
    blockers.push({ sourceKey: null, code: 'google_unavailable', message: 'Connect and refresh Google Tasks before previewing migration.' });
  }
  if (feed.state !== 'connected') {
    blockers.push({ sourceKey: null, code: 'hermes_unavailable', message: 'Refresh the complete Hermes board before previewing migration.' });
  } else if (feed.board.slug !== 'personal-tasks') {
    blockers.push({ sourceKey: null, code: 'wrong_board', message: 'Migration only accepts the personal-tasks Hermes board.' });
  }

  const board = feed.state === 'connected' && feed.board.slug === 'personal-tasks' ? feed.board : null;
  const boardTasks = new Map(board?.tasks.map(task => [task.id, task]) ?? []);
  const taskRows = store.listTasks();
  const taskRowsById = new Map(taskRows.map(task => [task.id, task]));
  const existingMigrationSources = new Set<string>();
  const tasksWithActionHistory = new Set<string>();
  const tasksWithReferences = taskReferences(store);
  const recoverableTerminalCreates = new Map<string, ActionRow>();
  for (const action of store.listActions()) {
    if ('taskId' in action.payload) tasksWithActionHistory.add(action.payload.taskId);
    if (action.payload.kind !== 'task-migration' || action.state === 'cancelled' || action.state === 'superseded') continue;
    const task = taskRowsById.get(action.payload.taskId);
    const recoverable = action.payload.operation === 'create' &&
      (action.state === 'conflict' || (action.state === 'failed' && action.nextAttemptAt === null)) &&
      task?.binding.kind === 'pending' && task.binding.createActionId === action.id &&
      typeof action.receipt?.providerId !== 'string';
    if (recoverable) {
      recoverableTerminalCreates.set(action.payload.taskId, action);
      continue;
    }
    existingMigrationSources.add(action.payload.sourceKey);
    for (const alias of action.payload.sourceAliases ?? []) {
      if (alias.kind === 'hermes') existingMigrationSources.add(`hermes:${alias.boardSlug}:${alias.taskId}`);
      else existingMigrationSources.add(`fox:${alias.taskId}`);
    }
    const related = action.payload.sourceSnapshot.relatedHermes;
    if (related && typeof related === 'object' && !Array.isArray(related)) {
      const relatedId = (related as Record<string, unknown>).id;
      if (typeof relatedId === 'string' && board) {
        existingMigrationSources.add(`hermes:${board.slug}:${relatedId}`);
      }
    }
  }
  const currentRecords = accountId
    ? store.listProviderRecordsForAccount('google', accountId, 'task').filter(record =>
        record.connectionGeneration === catalogue.connectionGeneration)
    : [];
  const recordByIdentity = new Map(currentRecords.map(record => [
    providerIdentity(record.accountId, record.containerId, record.externalId),
    record,
  ]));
  const recordsByExternalId = new Map<string, StoredRecord[]>();
  for (const record of currentRecords) {
    const records = recordsByExternalId.get(record.externalId) ?? [];
    records.push(record);
    recordsByExternalId.set(record.externalId, records);
  }
  const googleRows = new Map<string, TaskRow>();
  for (const row of taskRows) {
    if (row.binding.kind !== 'google') continue;
    googleRows.set(providerIdentity(
      row.binding.ref.accountId,
      row.binding.ref.listId,
      row.binding.ref.externalId,
    ), row);
  }

  const claimedHermesIds = new Set<string>();
  const hermesOwners = new Map<string, string[]>();
  for (const row of taskRows) {
    if (row.binding.kind !== 'legacy' || !isTask(row.binding.source) || !board) continue;
    for (const link of hermesLinks(row.binding.source, board.slug)) {
      const owners = hermesOwners.get(link.externalId) ?? [];
      owners.push(row.id);
      hermesOwners.set(link.externalId, owners);
    }
  }
  for (const [taskId, owners] of hermesOwners) {
    if (owners.length > 1) {
      blockers.push(sourceBlocker(
        `hermes:${board?.slug ?? 'personal-tasks'}:${taskId}`,
        'duplicate_target',
        `Hermes task ${taskId} is linked to more than one Fox Focus task.`,
      ));
    }
  }

  for (const row of taskRows) {
    if (existingMigrationSources.has(`fox:${row.id}`)) continue;
    if (row.binding.kind === 'pending') {
      const oldAction = recoverableTerminalCreates.get(row.id);
      if (!oldAction || oldAction.payload.kind !== 'task-migration' || oldAction.payload.operation !== 'create' ||
        !oldAction.payload.nonce) {
        blockers.push(sourceBlocker(`fox:${row.id}`, 'pending_create', `Fox Focus task ${row.id} already has an unresolved Google create.`));
        continue;
      }
      const sourceKey = oldAction.payload.sourceKey;
      const destination = freshDestination(
        catalogue,
        oldAction.payload.destination.accountId,
        oldAction.payload.destination.listId,
      );
      const plan = migrationPlan(row.id, store);
      if (!destination || !plan) {
        blockers.push(sourceBlocker(sourceKey, 'destination_missing', `The original Google list for ${sourceKey} is not fresh in the current connection.`));
        continue;
      }
      if (!validCreatePayload(oldAction.payload.title, oldAction.payload.notes)) {
        blockers.push(sourceBlocker(sourceKey, 'source_missing', `The approved Google payload for ${sourceKey} is outside provider limits.`));
        continue;
      }
      if (oldAction.payload.source.kind === 'hermes') {
        const currentHermes = boardTasks.get(oldAction.payload.source.taskId);
        if (!currentHermes || currentHermes.version !== oldAction.payload.source.version) {
          blockers.push(sourceBlocker(sourceKey, 'source_missing', `The Hermes source for ${sourceKey} changed after the terminal create.`));
          continue;
        }
        claimedHermesIds.add(currentHermes.id);
      }
      const sourceAliases = oldAction.payload.sourceAliases ?? [];
      let aliasChanged = false;
      for (const alias of sourceAliases) {
        if (alias.kind !== 'hermes') continue;
        const currentHermes = boardTasks.get(alias.taskId);
        if (!currentHermes || currentHermes.version !== alias.version) {
          blockers.push(sourceBlocker(sourceKey, 'source_missing', `The Hermes alias for ${sourceKey} changed after the terminal create.`));
          aliasChanged = true;
          continue;
        }
        claimedHermesIds.add(alias.taskId);
      }
      if (aliasChanged) continue;
      const preservedReminders = preservedRemindersForTask(store, row.id);
      items.push(withApproval({
        source: oldAction.payload.source,
        sourceAliases,
        sourceKey,
        sourceSnapshot: {
          ...oldAction.payload.sourceSnapshot,
          resumedFrom: {
            actionId: oldAction.id,
            state: oldAction.state,
            error: oldAction.error,
          },
          reminders: preservedReminders,
        },
        expectedTaskVersion: row.version,
        expectedPlanVersion: migrationPlanVersion(row.id, store),
        title: oldAction.payload.title,
        status: 'open',
        localTaskId: row.id,
        operation: 'create',
        destination: {
          accountId: destination.accountId,
          listId: destination.listId,
          listName: destination.name,
        },
        existingExternalId: null,
        targetSnapshot: null,
        outgoing: {
          title: oldAction.payload.title,
          notes: oldAction.payload.notes,
          doOn: oldAction.payload.doOn,
        },
        plan,
        reminder: null,
        preservedReminders,
        replacesActionId: oldAction.id,
        resumeMode: oldAction.state === 'failed' ? 'create' : 'reconcile',
      }));
      continue;
    }
    if (row.binding.kind === 'google') {
      if (!accountId || row.binding.ref.accountId === accountId || !isLegacyAccountIdentity(row.binding.ref.accountId)) continue;
      const sourceKey = `fox:${row.id}`;
      const plan = migrationPlan(row.id, store);
      const record = recordByIdentity.get(providerIdentity(
        accountId,
        row.binding.ref.listId,
        row.binding.ref.externalId,
      ));
      if (!row.observed || !plan || !record) {
        blockers.push(sourceBlocker(sourceKey, 'source_missing', `The exact current-account Google task for Fox Focus task ${row.id} is unavailable.`));
        continue;
      }
      const bindDestination = freshDestination(catalogue, accountId, record.containerId);
      if (!bindDestination) {
        blockers.push(sourceBlocker(sourceKey, 'destination_missing', `The Google list for Fox Focus task ${row.id} is not fresh in the current connection.`));
        continue;
      }
      if (taskRecordStatus(record) !== row.observed.status) {
        blockers.push(sourceBlocker(sourceKey, 'status_conflict', `Fox Focus task ${row.id} and the current-account Google task have different completion states.`));
        continue;
      }
      const currentIdentity = providerIdentity(accountId, record.containerId, record.externalId);
      const replacement = googleRows.get(currentIdentity) ?? null;
      const replacementPlan = replacement && replacement.id !== row.id ? migrationPlan(replacement.id, store) : null;
      if (replacement && replacement.id !== row.id && tasksWithActionHistory.has(replacement.id)) {
        blockers.push(sourceBlocker(sourceKey, 'duplicate_target', `The replacement Google row for Fox Focus task ${row.id} has action history and cannot be merged automatically.`));
        continue;
      }
      if (replacement && replacement.id !== row.id && tasksWithReferences.has(replacement.id)) {
        blockers.push(sourceBlocker(sourceKey, 'duplicate_target', `The replacement Google row for Fox Focus task ${row.id} is referenced by local records and cannot be merged automatically.`));
        continue;
      }
      if (replacementPlan && !samePlan(replacementPlan, plan) && !defaultPlan(replacementPlan)) {
        blockers.push(sourceBlocker(sourceKey, 'planning_conflict', `The replacement Google row for Fox Focus task ${row.id} has different local planning.`));
        continue;
      }
      const preservedReminders = preservedRemindersForTask(store, row.id);
      const item = withApproval({
        source: { kind: 'fox', taskId: row.id, version: row.version },
        sourceAliases: [],
        sourceKey,
        sourceSnapshot: JSON.parse(JSON.stringify({ task: row, plan, replacement, reminders: preservedReminders })) as Record<string, unknown>,
        expectedTaskVersion: row.version,
        expectedPlanVersion: migrationPlanVersion(row.id, store),
        title: row.observed.title,
        status: row.observed.status,
        localTaskId: row.id,
        operation: 'bind',
        destination: { accountId, listId: record.containerId, listName: bindDestination.name },
        existingExternalId: record.externalId,
        targetSnapshot: targetSnapshot(record),
        outgoing: null,
        plan,
        reminder: null,
        preservedReminders,
        replacesActionId: null,
        resumeMode: null,
      });
      items.push(item);
      continue;
    }
    if (row.binding.kind !== 'legacy') continue;
    const sourceKey = `fox:${row.id}`;
    const sourceTask = isTask(row.binding.source) ? row.binding.source : null;
    const plan = migrationPlan(row.id, store);
    if (!sourceTask || !row.observed || !plan) {
      blockers.push(sourceBlocker(sourceKey, 'source_missing', `Fox Focus task ${row.id} has incomplete migration data.`));
      continue;
    }
    const relatedLinks = board ? hermesLinks(sourceTask, board.slug) : [];
    if (relatedLinks.length > 1) {
      blockers.push(sourceBlocker(sourceKey, 'ambiguous_source', `Fox Focus task ${row.id} has more than one Hermes source link.`));
      continue;
    }
    const relatedHermes = relatedLinks[0] ? boardTasks.get(relatedLinks[0].externalId) ?? null : null;
    if (relatedLinks[0]) claimedHermesIds.add(relatedLinks[0].externalId);
    const sourceAliases = relatedHermes ? [{
      kind: 'hermes' as const,
      boardSlug: board?.slug ?? 'personal-tasks',
      taskId: relatedHermes.id,
      version: relatedHermes.version,
    }] : [];
    const preservedReminders = preservedRemindersForTask(store, row.id);
    let desiredPlan = plan;
    let reminder: TaskMigrationPreviewItem['reminder'] = null;
    if (relatedHermes?.annotationUpdatedAt) {
      const planningConflict = hermesPlanningConflict(relatedHermes);
      if (planningConflict) {
        blockers.push(sourceBlocker(sourceKey, 'planning_conflict', planningConflict));
        continue;
      }
      const annotatedPlan = planForHermes(relatedHermes);
      if (!samePlan(plan, annotatedPlan) && !defaultPlan(plan)) {
        blockers.push(sourceBlocker(sourceKey, 'planning_conflict', `Fox Focus and Hermes have different local planning for task ${row.id}.`));
        continue;
      }
      desiredPlan = annotatedPlan;
      reminder = reminderForHermes(relatedHermes);
      if (relatedHermes.reminderMode !== 'none' && !reminder) {
        blockers.push(sourceBlocker(sourceKey, 'planning_conflict', `Hermes task ${relatedHermes.id} has a reminder without an exact fire time.`));
        continue;
      }
    }
    const links = googleLinks(sourceTask);
    if (links.length > 1) {
      blockers.push(sourceBlocker(sourceKey, 'ambiguous_source', `Fox Focus task ${row.id} has more than one Google Tasks link.`));
      continue;
    }
    const sourceSnapshot = JSON.parse(JSON.stringify({
      task: row,
      plan,
      relatedHermes,
      reminders: preservedReminders,
    })) as Record<string, unknown>;
    const link = links[0];
    if (link) {
      if (!accountId || (link.connectionId !== accountId &&
        (!link.connectionId || !isLegacyAccountIdentity(link.connectionId)))) {
        blockers.push(sourceBlocker(sourceKey, 'source_missing', `Fox Focus task ${row.id} is linked to a different Google account.`));
        continue;
      }
      const record = recordByIdentity.get(providerIdentity(accountId, link.containerId, link.externalId));
      if (!record) {
        blockers.push(sourceBlocker(sourceKey, 'source_missing', `The exact Google task linked to Fox Focus task ${row.id} is unavailable.`));
        continue;
      }
      if (taskRecordStatus(record) !== row.observed.status) {
        blockers.push(sourceBlocker(sourceKey, 'status_conflict', `Fox Focus task ${row.id} and its exact Google task have different completion states.`));
        continue;
      }
      const bindDestination = freshDestination(catalogue, accountId, record.containerId);
      if (!bindDestination) {
        blockers.push(sourceBlocker(sourceKey, 'destination_missing', `The Google list for Fox Focus task ${row.id} is not fresh in the current connection.`));
        continue;
      }
      const replacement = googleRows.get(providerIdentity(accountId, record.containerId, record.externalId)) ?? null;
      const replacementPlan = replacement && replacement.id !== row.id ? migrationPlan(replacement.id, store) : null;
      if (replacement && replacement.id !== row.id && tasksWithActionHistory.has(replacement.id)) {
        blockers.push(sourceBlocker(sourceKey, 'duplicate_target', `The replacement Google row for Fox Focus task ${row.id} has action history and cannot be merged automatically.`));
        continue;
      }
      if (replacement && replacement.id !== row.id && tasksWithReferences.has(replacement.id)) {
        blockers.push(sourceBlocker(sourceKey, 'duplicate_target', `The replacement Google row for Fox Focus task ${row.id} is referenced by local records and cannot be merged automatically.`));
        continue;
      }
      if (replacementPlan && !samePlan(replacementPlan, desiredPlan) && !defaultPlan(replacementPlan)) {
        blockers.push(sourceBlocker(sourceKey, 'planning_conflict', `The replacement Google row for Fox Focus task ${row.id} has different local planning.`));
        continue;
      }
      const item = withApproval({
        source: { kind: 'fox', taskId: row.id, version: row.version },
        sourceAliases,
        sourceKey,
        sourceSnapshot: { ...sourceSnapshot, replacement },
        expectedTaskVersion: row.version,
        expectedPlanVersion: migrationPlanVersion(row.id, store),
        title: row.observed.title,
        status: row.observed.status,
        localTaskId: row.id,
        operation: 'bind',
        destination: { accountId, listId: record.containerId, listName: bindDestination.name },
        existingExternalId: record.externalId,
        targetSnapshot: targetSnapshot(record),
        outgoing: null,
        plan: desiredPlan,
        reminder,
        preservedReminders,
        replacesActionId: null,
        resumeMode: null,
      });
      items.push(item);
      continue;
    }
    if (row.observed.status === 'completed') {
      blockers.push(sourceBlocker(sourceKey, 'completed_create', `Completed Fox Focus task ${row.id} needs an explicit completion migration path.`));
      continue;
    }
    const destination = accountId ? destinationForArea(catalogue, sourceTask.area) : null;
    if (!destination) {
      blockers.push(sourceBlocker(sourceKey, 'destination_missing', `No unambiguous Google list is mapped for ${sourceTask.area}.`));
      continue;
    }
    const nonce = `migration_${stableSuffix(`${destination.accountId}\u0000${sourceKey}`)}`;
    const notes = taskCreateNotes(row.observed.notes ?? '', nonce);
    if (!validCreatePayload(row.observed.title, notes)) {
      blockers.push(sourceBlocker(sourceKey, 'source_missing', `Fox Focus task ${row.id} is outside Google title or notes limits.`));
      continue;
    }
    const item = withApproval({
      source: { kind: 'fox', taskId: row.id, version: row.version },
      sourceAliases,
      sourceKey,
      sourceSnapshot,
      expectedTaskVersion: row.version,
      expectedPlanVersion: migrationPlanVersion(row.id, store),
      title: row.observed.title,
      status: row.observed.status,
      localTaskId: row.id,
      operation: 'create',
      destination: { accountId: destination.accountId, listId: destination.listId, listName: destination.name },
      existingExternalId: null,
      targetSnapshot: null,
      outgoing: { title: row.observed.title, notes, doOn: row.observed.doOn },
      plan: desiredPlan,
      reminder,
      preservedReminders,
      replacesActionId: null,
      resumeMode: null,
    });
    items.push(item);
  }

  if (board) {
    for (const task of board.tasks) {
      if (existingMigrationSources.has(`hermes:${board.slug}:${task.id}`)) continue;
      if (claimedHermesIds.has(task.id)) continue;
      const sourceKey = `hermes:${board.slug}:${task.id}`;
      const sourceStatus = task.status === 'done' ? 'completed' as const : 'open' as const;
      const planningConflict = hermesPlanningConflict(task);
      if (planningConflict) {
        blockers.push(sourceBlocker(sourceKey, 'planning_conflict', planningConflict));
        continue;
      }
      const plan = planForHermes(task);
      const reminder = reminderForHermes(task);
      if (task.reminderMode !== 'none' && !reminder) {
        blockers.push(sourceBlocker(sourceKey, 'planning_conflict', `Hermes task ${task.id} has a reminder without an exact fire time.`));
        continue;
      }
      const sourceSnapshot = JSON.parse(JSON.stringify(task)) as Record<string, unknown>;
      if (task.sourceProvider === 'google' && task.sourceExternalId) {
        const matches = recordsByExternalId.get(task.sourceExternalId) ?? [];
        if (matches.length === 0) {
          blockers.push(sourceBlocker(sourceKey, 'source_missing', `The exact Google task for Hermes task ${task.id} is unavailable.`));
          continue;
        }
        if (matches.length > 1) {
          blockers.push(sourceBlocker(sourceKey, 'ambiguous_source', `Hermes task ${task.id} matches the same Google task ID in more than one list.`));
          continue;
        }
        const record = matches[0];
        const bindDestination = freshDestination(catalogue, record.accountId, record.containerId);
        if (!bindDestination) {
          blockers.push(sourceBlocker(sourceKey, 'destination_missing', `The Google list for Hermes task ${task.id} is not fresh in the current connection.`));
          continue;
        }
        if (taskRecordStatus(record) !== sourceStatus) {
          blockers.push(sourceBlocker(sourceKey, 'status_conflict', `Hermes task ${task.id} and its exact Google task have different completion states.`));
          continue;
        }
        const identity = providerIdentity(record.accountId, record.containerId, record.externalId);
        const targetRow = googleRows.get(identity);
        const targetPlan = targetRow ? migrationPlan(targetRow.id, store) : null;
        if (!targetRow || !targetPlan) {
          blockers.push(sourceBlocker(sourceKey, 'source_missing', `The exact Google task for Hermes task ${task.id} has no Fox Focus row.`));
          continue;
        }
        if (task.annotationUpdatedAt && !samePlan(targetPlan, plan) && !defaultPlan(targetPlan)) {
          blockers.push(sourceBlocker(sourceKey, 'planning_conflict', `Hermes and Fox Focus have different local planning for Google task ${record.externalId}.`));
          continue;
        }
        const preservedReminders = preservedRemindersForTask(store, targetRow.id);
        const item = withApproval({
          source: { kind: 'hermes', boardSlug: board.slug, taskId: task.id, version: task.version },
          sourceAliases: [],
          sourceKey,
          sourceSnapshot: {
            ...sourceSnapshot,
            localTask: targetRow,
            localPlan: targetPlan,
            reminders: preservedReminders,
          },
          expectedTaskVersion: targetRow.version,
          expectedPlanVersion: migrationPlanVersion(targetRow.id, store),
          title: task.title,
          status: sourceStatus,
          localTaskId: targetRow.id,
          operation: 'bind',
          destination: { accountId: record.accountId, listId: record.containerId, listName: bindDestination.name },
          existingExternalId: record.externalId,
          targetSnapshot: targetSnapshot(record),
          outgoing: null,
          plan: task.annotationUpdatedAt ? plan : targetPlan,
          reminder,
          preservedReminders,
          replacesActionId: null,
          resumeMode: null,
        });
        items.push(item);
        continue;
      }
      if (task.sourceProvider === 'google' || task.sourceExternalId) {
        blockers.push(sourceBlocker(sourceKey, 'source_missing', `Hermes task ${task.id} has incomplete Google provenance.`));
        continue;
      }
      if (sourceStatus === 'completed') {
        blockers.push(sourceBlocker(sourceKey, 'completed_create', `Completed Hermes task ${task.id} needs an explicit completion migration path.`));
        continue;
      }
      if (task.parentTitle) {
        blockers.push(sourceBlocker(sourceKey, 'ambiguous_source', `Hermes task ${task.id} has a parent title but no stable parent ID.`));
        continue;
      }
      const destination = accountId ? destinationForArea(catalogue, task.area) : null;
      if (!destination) {
        blockers.push(sourceBlocker(sourceKey, 'destination_missing', `No unambiguous Google list is mapped for ${task.area}.`));
        continue;
      }
      const localTaskId = `task-migration-${stableSuffix(sourceKey)}`;
      const nonce = `migration_${stableSuffix(`${destination.accountId}\u0000${sourceKey}`)}`;
      const notes = taskCreateNotes(`Migrated from Hermes personal-tasks (${task.id}).`, nonce);
      if (!validCreatePayload(task.title, notes)) {
        blockers.push(sourceBlocker(sourceKey, 'source_missing', `Hermes task ${task.id} is outside Google title or notes limits.`));
        continue;
      }
      const item = withApproval({
        source: { kind: 'hermes', boardSlug: board.slug, taskId: task.id, version: task.version },
        sourceAliases: [],
        sourceKey,
        sourceSnapshot,
        expectedTaskVersion: null,
        expectedPlanVersion: null,
        title: task.title,
        status: sourceStatus,
        localTaskId,
        operation: 'create',
        destination: { accountId: destination.accountId, listId: destination.listId, listName: destination.name },
        existingExternalId: null,
        targetSnapshot: null,
        outgoing: { title: task.title, notes, doOn: null },
        plan,
        reminder,
        preservedReminders: [],
        replacesActionId: null,
        resumeMode: null,
      });
      items.push(item);
    }
  }

  const bindTargets = new Map<string, TaskMigrationPreviewItem[]>();
  for (const item of items) {
    if (!item.existingExternalId) continue;
    const key = providerIdentity(item.destination.accountId, item.destination.listId, item.existingExternalId);
    const matches = bindTargets.get(key) ?? [];
    matches.push(item);
    bindTargets.set(key, matches);
  }
  for (const matches of bindTargets.values()) {
    if (matches.length < 2) continue;
    for (const item of matches) {
      blockers.push(sourceBlocker(item.sourceKey, 'duplicate_target', `More than one migration source targets Google task ${item.existingExternalId}.`));
    }
  }

  items.sort((first, second) => first.sourceKey.localeCompare(second.sourceKey));
  blockers.sort((first, second) =>
    (first.sourceKey ?? '').localeCompare(second.sourceKey ?? '') || first.code.localeCompare(second.code));
  const hash = taskMigrationPreviewHash({ accountId, items, blockers });
  return {
    hash,
    accountId,
    connectionGeneration: catalogue.connectionGeneration,
    generatedAt,
    items,
    blockers,
  };
}

export function migrationIdForIdempotencyKey(idempotencyKey: string): string {
  return `migration-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

export function summarizeTaskMigration(actions: readonly ActionRow[], migrationId: string): TaskMigrationSummary {
  const migrationActions = actions.filter(action =>
    action.payload.kind === 'task-migration' && action.payload.migrationId === migrationId);
  const superseded = migrationActions.filter(action => action.state === 'superseded').length;
  const cancelled = migrationActions.filter(action => action.state === 'cancelled').length;
  const counts = {
    total: migrationActions.length,
    queued: migrationActions.filter(action => action.state === 'queued').length,
    running: migrationActions.filter(action => action.state === 'running').length,
    succeeded: migrationActions.filter(action => action.state === 'succeeded').length,
    failed: migrationActions.filter(action => action.state === 'failed').length,
    conflict: migrationActions.filter(action => action.state === 'conflict').length,
    unknown: migrationActions.filter(action => action.state === 'unknown').length,
    ...(superseded ? { superseded } : {}),
    ...(cancelled ? { cancelled } : {}),
  };
  const state = counts.total > 0 && counts.succeeded + superseded + cancelled === counts.total
    ? 'settled' as const
    : counts.conflict > 0 || migrationActions.some(action => action.state === 'failed' && action.nextAttemptAt === null)
      ? 'needs_review' as const
      : counts.total > 0 && counts.queued === counts.total
        ? 'queued' as const
        : 'working' as const;
  const previewHash = migrationActions[0]?.payload.kind === 'task-migration'
    ? migrationActions[0].payload.previewHash
    : '';
  return {
    migrationId,
    previewHash,
    state,
    counts,
    mappings: migrationActions.flatMap(action => {
      if (action.payload.kind !== 'task-migration') return [];
      const payload = action.payload;
      const providerId = typeof action.receipt?.providerId === 'string'
        ? action.receipt.providerId
        : payload.existingExternalId;
      const sources = [{ sourceKey: payload.sourceKey, source: payload.source }];
      for (const alias of payload.sourceAliases ?? []) {
        const sourceKey = alias.kind === 'hermes'
          ? `hermes:${alias.boardSlug}:${alias.taskId}`
          : `fox:${alias.taskId}`;
        if (!sources.some(source => source.sourceKey === sourceKey)) sources.push({ sourceKey, source: alias });
      }
      const related = payload.sourceSnapshot.relatedHermes;
      if (related && typeof related === 'object' && !Array.isArray(related)) {
        const record = related as Record<string, unknown>;
        if (typeof record.id === 'string' && typeof record.version === 'number') {
          const sourceKey = `hermes:personal-tasks:${record.id}`;
          if (!sources.some(source => source.sourceKey === sourceKey)) sources.push({
            sourceKey,
            source: { kind: 'hermes', boardSlug: 'personal-tasks', taskId: record.id, version: record.version },
          });
        }
      }
      return sources.map(({ sourceKey, source }) => ({
        sourceKey,
        source,
        localTaskId: payload.taskId,
        destination: {
          ...payload.destination,
          listName: payload.destinationName,
        },
        externalId: providerId,
        actionId: action.id,
        state: action.state,
      }));
    }),
    actions: migrationActions,
  };
}
