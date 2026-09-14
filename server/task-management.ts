import { randomUUID } from 'node:crypto';
import { addCalendarDays, dublinDateKey, formatDublinDateKey } from '../src/calendar-time.ts';
import type { HermesFeed, HermesTask } from '../src/hermes-model.ts';
import type { Priority, Task, TaskExternalLink } from '../src/model.ts';
import type {
  Snapshot,
  Store,
  StoredRecord,
  TaskActionRequest,
  TaskActionState,
  TaskAdoptionRequest,
  TaskAdoptionSource,
} from './store.ts';

const PREVIEW_LIFETIME_MS = 15 * 60_000;

export type TaskManagementErrorCode =
  | 'not_found'
  | 'already_adopted'
  | 'not_linked'
  | 'read_only'
  | 'invalid_source'
  | 'action_in_progress'
  | 'idempotency_conflict';

export class TaskManagementError extends Error {
  readonly code: TaskManagementErrorCode;

  constructor(code: TaskManagementErrorCode, message: string) {
    super(message);
    this.name = 'TaskManagementError';
    this.code = code;
  }
}

function expiry(now: Date): string {
  return new Date(now.getTime() + PREVIEW_LIFETIME_MS).toISOString();
}

function linkedTask(snapshot: Snapshot, link: Pick<TaskExternalLink, 'provider' | 'connectionId' | 'containerId' | 'externalId'>): Task | undefined {
  return snapshot.data.tasks.find(task => task.externalLinks?.some(candidate =>
    candidate.provider === link.provider &&
    candidate.connectionId === link.connectionId &&
    candidate.containerId === link.containerId &&
    candidate.externalId === link.externalId));
}

function dueLabel(date: string | null, now: Date): string {
  if (!date) return 'No deadline';
  const today = dublinDateKey(now);
  if (date === today) return 'Today';
  if (date === addCalendarDays(today, 1)) return 'Tomorrow';
  return formatDublinDateKey(date, { day: 'numeric', month: 'short' });
}

function googleOrMicrosoftTask(record: StoredRecord, now: Date): Task {
  if (!record.connectionId) throw new TaskManagementError('invalid_source', 'Refresh this provider before adopting its task.');
  const provider = record.provider === 'google' ? 'google_tasks' : 'microsoft_todo';
  const completed = record.status === 'completed';
  const link: TaskExternalLink = {
    provider,
    externalId: record.externalId,
    containerId: record.containerId,
    containerName: record.containerName,
    connectionId: record.connectionId,
    policy: record.provider === 'google' && record.completionWritable ? 'completion_only' : 'read_only',
    ...(record.status ? { sourceStatus: record.status } : {}),
    ...(record.sourceVersion ? { sourceVersion: record.sourceVersion } : {}),
    ...(record.sourceUpdatedAt ? { sourceUpdatedAt: record.sourceUpdatedAt } : {}),
    linkedAt: now.toISOString(),
  };
  return {
    id: `task-${randomUUID()}`,
    title: record.title,
    area: 'Personal',
    state: completed ? 'done' : 'up-next',
    duration: '30 min',
    due: dueLabel(record.dueOn, now),
    priority: 'medium',
    completed,
    scheduledTime: null,
    origin: 'migration',
    source: `${record.provider === 'google' ? 'Google Tasks' : 'Microsoft To Do'} · ${record.containerName}`,
    createdAt: now.toISOString(),
    ...(record.provider === 'microsoft' && record.dueOn ? { deadlineDate: record.dueOn } : {}),
    ...(completed && record.completedAt ? { completedAt: record.completedAt } : {}),
    externalLinks: [link],
  };
}

function hermesPriority(value: number): Priority {
  if (value >= 4) return 'high';
  if (value >= 2) return 'medium';
  return 'low';
}

function hermesTask(task: HermesTask, board: { slug: string; name: string }, now: Date): Task {
  const completed = task.status === 'done';
  return {
    id: `task-${randomUUID()}`,
    title: task.title,
    area: 'Personal',
    state: completed ? 'done' : task.status === 'scheduled' ? 'scheduled' : task.status === 'blocked' ? 'waiting' : 'up-next',
    duration: '30 min',
    due: completed ? 'No deadline' : task.status === 'blocked' ? 'Waiting' : 'No deadline',
    priority: hermesPriority(task.priority),
    completed,
    scheduledTime: null,
    origin: 'migration',
    source: `Hermes · ${task.source}`,
    createdAt: now.toISOString(),
    ...(completed ? { completedAt: task.updatedAt } : {}),
    externalLinks: [{
      provider: 'hermes',
      externalId: task.id,
      containerId: board.slug,
      containerName: board.name,
      policy: 'read_only',
      sourceStatus: task.status,
      sourceUpdatedAt: task.updatedAt,
      linkedAt: now.toISOString(),
    }],
  };
}

function adoptionPreview(
  source: TaskAdoptionSource,
  before: Record<string, unknown>,
  task: Task,
  workspaceRevision: number,
  now: Date,
): Omit<TaskAdoptionRequest, 'status' | 'approvedAt' | 'adoptedTaskId'> {
  const link = task.externalLinks?.[0];
  if (!link) throw new TaskManagementError('invalid_source', 'The source task has no stable identifier.');
  return {
    id: randomUUID(),
    source,
    externalId: link.externalId,
    containerId: link.containerId,
    workspaceRevision,
    before,
    task,
    createdAt: now.toISOString(),
    expiresAt: expiry(now),
  };
}

export function previewProviderTaskAdoption(
  store: Store,
  recordId: number,
  now = new Date(),
  targetTaskId?: string,
): TaskAdoptionRequest {
  const record = store.getProviderRecord(recordId);
  if (!record || record.kind !== 'task') throw new TaskManagementError('not_found', 'Imported task was not found.');
  const importedTask = googleOrMicrosoftTask(record, now);
  const link = importedTask.externalLinks?.[0];
  if (!link) throw new TaskManagementError('invalid_source', 'The imported task has no stable identifier.');
  const snapshot = store.read();
  if (linkedTask(snapshot, link)) throw new TaskManagementError('already_adopted', 'This task is already in Fox Focus.');
  const targetTask = targetTaskId ? snapshot.data.tasks.find(task => task.id === targetTaskId) : undefined;
  if (targetTaskId && !targetTask) throw new TaskManagementError('not_found', 'The selected Fox Focus task was not found.');
  const targetProviderLinks = targetTask?.externalLinks?.filter(candidate => candidate.provider === link.provider) ?? [];
  const replacesOlderGeneration = targetProviderLinks.length === 1 && targetProviderLinks[0].connectionId !== link.connectionId &&
    targetProviderLinks[0].containerId === link.containerId && targetProviderLinks[0].externalId === link.externalId;
  if (targetProviderLinks.length > 0 && !replacesOlderGeneration) {
    throw new TaskManagementError('invalid_source', 'The selected Fox Focus task already has a link for this provider.');
  }
  const staleTask = snapshot.data.tasks.find(task => task.externalLinks?.some(candidate =>
    candidate.provider === link.provider && candidate.connectionId !== link.connectionId &&
    candidate.containerId === link.containerId && candidate.externalId === link.externalId));
  if (staleTask && !targetTask) {
    throw new TaskManagementError('invalid_source', 'This source ID was linked through an older connection. Choose the existing Fox Focus task and review the new link.');
  }
  const task = targetTask
    ? {
        ...targetTask,
        externalLinks: [
          ...(targetTask.externalLinks ?? []).filter(candidate =>
            !(replacesOlderGeneration && candidate.provider === link.provider &&
              candidate.containerId === link.containerId && candidate.externalId === link.externalId)),
          link,
        ],
      }
    : importedTask;
  return store.createTaskAdoption(adoptionPreview(record.provider, {
    ownership: record.provider,
    recordId: record.id,
    provider: record.provider,
    connectionId: record.connectionId,
    containerId: record.containerId,
    externalId: record.externalId,
    list: record.containerName,
    title: record.title,
    state: record.status,
    dueOn: record.dueOn,
    sourceUpdatedAt: record.sourceUpdatedAt,
    sourceVersion: record.sourceVersion,
    targetTaskId: targetTask?.id ?? null,
    targetTaskTitle: targetTask?.title ?? null,
    targetTaskState: targetTask ? targetTask.completed ? 'completed' : targetTask.state : null,
    targetTaskDeadline: targetTask?.deadlineDate ?? targetTask?.due ?? null,
  }, task, snapshot.revision, now));
}

export function previewHermesTaskAdoption(store: Store, feed: HermesFeed, externalId: string, now = new Date()): TaskAdoptionRequest {
  if (feed.state !== 'connected') throw new TaskManagementError('not_found', 'Hermes is unavailable.');
  const sourceTask = feed.board.tasks.find(task => task.id === externalId);
  if (!sourceTask) throw new TaskManagementError('not_found', 'Hermes task was not found.');
  const task = hermesTask(sourceTask, feed.board, now);
  const link = task.externalLinks?.[0];
  if (!link) throw new TaskManagementError('invalid_source', 'The Hermes task has no stable identifier.');
  const snapshot = store.read();
  if (linkedTask(snapshot, link)) throw new TaskManagementError('already_adopted', 'This task is already in Fox Focus.');
  return store.createTaskAdoption(adoptionPreview('hermes', {
    ownership: 'hermes',
    board: feed.board.name,
    title: sourceTask.title,
    state: sourceTask.status,
    source: sourceTask.source,
    externalId: sourceTask.id,
    containerId: feed.board.slug,
    sourceUpdatedAt: sourceTask.updatedAt,
  }, task, snapshot.revision, now));
}

export function previewTaskAction(
  store: Store,
  taskId: string,
  desiredState: TaskActionState,
  idempotencyKey: string,
  now = new Date(),
): TaskActionRequest {
  const snapshot = store.read();
  const task = snapshot.data.tasks.find(candidate => candidate.id === taskId);
  if (!task) throw new TaskManagementError('not_found', 'Task was not found.');
  if (store.hasRunningTaskAction(taskId, now.toISOString())) {
    throw new TaskManagementError('action_in_progress', 'An approved Google update for this task is still running. Wait for it to finish.');
  }
  const link = task.externalLinks?.find(candidate => candidate.provider === 'google_tasks');
  if (!link) throw new TaskManagementError('not_linked', 'This task has no Google Tasks link.');
  if (link.policy !== 'completion_only') throw new TaskManagementError('read_only', 'This source link is read-only.');
  if (!link.connectionId || store.getConnection('google')?.connectionId !== link.connectionId) {
    throw new TaskManagementError('read_only', 'Reconnect and reconcile this Google link before changing it.');
  }
  const sourceRecord = store.findProviderRecord('google', 'task', link.connectionId, link.containerId, link.externalId);
  if (sourceRecord && !sourceRecord.completionWritable) {
    throw new TaskManagementError('read_only', 'This Google task is source-managed and stays read-only.');
  }
  const expectedVersion = sourceRecord?.sourceVersion ?? null;
  if (!sourceRecord || !expectedVersion) {
    throw new TaskManagementError('invalid_source', 'Refresh Google before changing this linked task. The exact source task is not available.');
  }
  const before = {
    foxFocus: { taskId: task.id, title: task.title, state: task.completed ? 'completed' : 'open' },
    google: {
      connection: `Google connection ${link.connectionId.slice(0, 8)}`,
      list: link.containerName ?? sourceRecord?.containerName ?? link.containerId,
      taskId: link.externalId,
      title: sourceRecord.title,
      state: sourceRecord?.status ?? link.sourceStatus ?? null,
      version: expectedVersion,
    },
  };
  const after = {
    foxFocus: { taskId: task.id, title: task.title, state: desiredState },
    google: {
      connection: `Google connection ${link.connectionId.slice(0, 8)}`,
      list: link.containerName ?? sourceRecord?.containerName ?? link.containerId,
      taskId: link.externalId,
      title: sourceRecord.title,
      state: desiredState === 'completed' ? 'completed' : 'needsAction',
    },
  };
  const request = store.createTaskAction({
    id: randomUUID(),
    idempotencyKey,
    taskId,
    provider: 'google',
    connectionId: link.connectionId,
    containerId: link.containerId,
    externalId: link.externalId,
    desiredState,
    expectedVersion,
    workspaceRevision: snapshot.revision,
    before,
    after,
    createdAt: now.toISOString(),
    expiresAt: expiry(now),
  });
  if (
    request.taskId !== taskId || request.desiredState !== desiredState ||
    request.connectionId !== link.connectionId || request.containerId !== link.containerId ||
    request.externalId !== link.externalId || request.expectedVersion !== expectedVersion ||
    JSON.stringify(request.before) !== JSON.stringify(before) || JSON.stringify(request.after) !== JSON.stringify(after)
  ) {
    throw new TaskManagementError('idempotency_conflict', 'That idempotency key was already used for a different action.');
  }
  return request;
}

export function taskStatusProjection(snapshot: Snapshot, generatedAt = new Date().toISOString()) {
  const tasks = snapshot.data.tasks.map(task => ({
    id: task.id,
    title: task.title,
    area: task.area,
    state: task.state,
    completed: task.completed,
    priority: task.priority,
    deadlineDate: task.deadlineDate ?? null,
    dueLabel: task.due,
    planned: task.scheduledDate && task.scheduledTime
      ? { date: task.scheduledDate, time: task.scheduledTime, timeZone: 'Europe/Dublin' as const }
      : null,
    completedAt: task.completedAt ?? null,
    origin: task.origin,
  }));
  return {
    revision: snapshot.revision,
    generatedAt,
    counts: {
      open: tasks.filter(task => !task.completed).length,
      completed: tasks.filter(task => task.completed).length,
      scheduled: tasks.filter(task => task.state === 'scheduled').length,
      waiting: tasks.filter(task => task.state === 'waiting').length,
    },
    tasks,
  };
}

export function adoptedTaskIdForRecord(store: Store, snapshot: Snapshot, record: StoredRecord): string | null {
  const recorded = store.findAdoptedTaskId(record.provider, record.connectionId, record.containerId, record.externalId);
  if (recorded) return recorded;
  const provider = record.provider === 'google' ? 'google_tasks' : 'microsoft_todo';
  return linkedTask(snapshot, {
    provider,
    connectionId: record.connectionId ?? undefined,
    containerId: record.containerId,
    externalId: record.externalId,
  })?.id ?? null;
}

export function adoptedTaskIdForHermes(snapshot: Snapshot, boardSlug: string, externalId: string): string | null {
  return linkedTask(snapshot, { provider: 'hermes', connectionId: undefined, containerId: boardSlug, externalId })?.id ?? null;
}

export function adoptionSourceStillMatches(store: Store, request: TaskAdoptionRequest, feed?: HermesFeed): boolean {
  if (request.status === 'approved') return true;
  if (request.source === 'hermes') {
    if (feed?.state !== 'connected') return false;
    const task = feed.board.tasks.find(candidate => candidate.id === request.externalId);
    if (!task) return false;
    return feed.board.slug === request.containerId && task.title === request.before.title &&
      task.status === request.before.state && task.updatedAt === request.before.sourceUpdatedAt;
  }
  const recordId = request.before.recordId;
  if (typeof recordId !== 'number') return false;
  const record = store.getProviderRecord(recordId);
  return Boolean(record) && record?.kind === 'task' && record.provider === request.source &&
    record.containerId === request.containerId && record.externalId === request.externalId &&
    record.connectionId === request.before.connectionId && record.title === request.before.title &&
    record.status === request.before.state && record.dueOn === request.before.dueOn &&
    record.sourceUpdatedAt === request.before.sourceUpdatedAt && record.sourceVersion === request.before.sourceVersion;
}
