import { CalendarDays, CheckCircle2, Link2, ListTodo, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { dublinDateKey, isDateKey } from './calendar-time.ts';
import { areaForList, filterCalendarContextByDateRange, listAreaKey } from './integration-model.ts';
import {
  areas,
  isOneOf,
  isPrototypeData,
  isTask,
  type Area,
  type PrototypeData,
  type Task,
} from './model.ts';
import type { TaskMigrationPreview, TaskMigrationPreviewItem } from './row-model.ts';

export type Provider = 'google' | 'microsoft';
type SyncState = 'idle' | 'syncing' | 'failed';
type ConnectionState = 'connected' | 'needs_reconnect';

type Connection = {
  connectionId: string;
  state: ConnectionState;
  scopes: string[];
  connectedAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
};

type ProviderStatus = {
  provider: Provider;
  displayName: string;
  configured: boolean;
  connection: Connection | null;
  sync: { state: SyncState; completedAt: string | null; lastError: string | null };
  calendarEventCount: number;
  taskCount: number;
};

export type ImportedRecord = {
  id: number;
  provider: Provider;
  connectionId: string | null;
  kind: 'calendar_event' | 'task';
  containerId: string;
  containerName: string;
  externalId: string;
  title: string;
  status: string | null;
  startsAt: string | null;
  startsOn: string | null;
  dueOn: string | null;
  allDay: boolean;
  adoptedTaskId: string | null;
};

export type Overview = { providers: ProviderStatus[]; records: ImportedRecord[] };
export type OverviewState = {
  overview: Overview | null;
  loading: boolean;
  failed: boolean;
  refresh: () => Promise<void>;
};

type WorkspaceSnapshot = { revision: number; data: PrototypeData };
type AdoptionPreview = {
  id: string;
  status: 'awaiting_approval';
  before: Record<string, unknown>;
  after: Task;
  expiresAt: string;
};

type MigrationProgress = {
  migrationId: string;
  previewHash: string;
  state: 'queued' | 'working' | 'needs_review' | 'settled';
  counts: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    conflict: number;
    unknown: number;
    superseded?: number;
    cancelled?: number;
  };
  mappings: Array<{
    sourceKey: string;
    externalId: string | null;
    actionId: string;
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'conflict' | 'unknown' | 'superseded' | 'cancelled';
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is Provider {
  return value === 'google' || value === 'microsoft';
}

function isConnection(value: unknown): value is Connection {
  return isRecord(value) &&
    typeof value.connectionId === 'string' && value.connectionId.length > 0 &&
    (value.state === 'connected' || value.state === 'needs_reconnect') &&
    Array.isArray(value.scopes) && value.scopes.every(scope => typeof scope === 'string') &&
    typeof value.connectedAt === 'string' &&
    (value.lastSyncedAt === null || typeof value.lastSyncedAt === 'string') &&
    (value.lastError === null || typeof value.lastError === 'string');
}

function isProviderStatus(value: unknown): value is ProviderStatus {
  return isRecord(value) && isProvider(value.provider) && typeof value.displayName === 'string' &&
    typeof value.configured === 'boolean' && (value.connection === null || isConnection(value.connection)) &&
    isRecord(value.sync) && (value.sync.state === 'idle' || value.sync.state === 'syncing' || value.sync.state === 'failed') &&
    (value.sync.completedAt === null || typeof value.sync.completedAt === 'string') &&
    (value.sync.lastError === null || typeof value.sync.lastError === 'string') &&
    typeof value.calendarEventCount === 'number' && Number.isSafeInteger(value.calendarEventCount) && value.calendarEventCount >= 0 &&
    typeof value.taskCount === 'number' && Number.isSafeInteger(value.taskCount) && value.taskCount >= 0;
}

function isImportedRecord(value: unknown): value is ImportedRecord {
  return isRecord(value) && typeof value.id === 'number' && Number.isSafeInteger(value.id) &&
    isProvider(value.provider) && (value.kind === 'calendar_event' || value.kind === 'task') &&
    (value.connectionId === null || typeof value.connectionId === 'string') &&
    typeof value.containerId === 'string' && typeof value.containerName === 'string' &&
    typeof value.externalId === 'string' && typeof value.title === 'string' &&
    (value.status === null || typeof value.status === 'string') &&
    (value.startsAt === null || typeof value.startsAt === 'string') &&
    (value.startsOn === null || typeof value.startsOn === 'string') &&
    (value.dueOn === null || typeof value.dueOn === 'string') && typeof value.allDay === 'boolean' &&
    (value.adoptedTaskId === null || typeof value.adoptedTaskId === 'string');
}

function isOverview(value: unknown): value is Overview {
  return isRecord(value) && Array.isArray(value.providers) && value.providers.every(isProviderStatus) &&
    Array.isArray(value.records) && value.records.every(isImportedRecord);
}

function isAdoptionPreview(value: unknown): value is AdoptionPreview {
  return isRecord(value) && typeof value.id === 'string' && value.status === 'awaiting_approval' &&
    isRecord(value.before) && isTask(value.after) && typeof value.expiresAt === 'string';
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  return isRecord(value) && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) &&
    value.revision >= 0 && isPrototypeData(value.data);
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableDateKey(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && isDateKey(value));
}

function isUtcInstant(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('Z') && !Number.isNaN(Date.parse(value));
}

function isNullableUtcInstant(value: unknown): value is string | null {
  return value === null || isUtcInstant(value);
}

function isMigrationSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === 'fox'
    ? typeof value.taskId === 'string' && Number.isSafeInteger(value.version)
    : value.kind === 'hermes' && typeof value.boardSlug === 'string' &&
      typeof value.taskId === 'string' && Number.isSafeInteger(value.version);
}

function isMigrationPreviewItem(value: unknown): value is TaskMigrationPreviewItem {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.destination) || !isRecord(value.plan)) return false;
  const source = isMigrationSource(value.source) && Array.isArray(value.sourceAliases) &&
    value.sourceAliases.every(isMigrationSource);
  const outgoing = value.outgoing === null || (isRecord(value.outgoing) &&
    typeof value.outgoing.title === 'string' && typeof value.outgoing.notes === 'string' &&
    isNullableDateKey(value.outgoing.doOn));
  const target = value.targetSnapshot === null || (isRecord(value.targetSnapshot) &&
    typeof value.targetSnapshot.title === 'string' &&
    (value.targetSnapshot.status === 'open' || value.targetSnapshot.status === 'completed') &&
    isNullableDateKey(value.targetSnapshot.doOn) && isNullableText(value.targetSnapshot.etag) &&
    isNullableUtcInstant(value.targetSnapshot.observedAt));
  const reminder = value.reminder === null || (isRecord(value.reminder) &&
    typeof value.reminder.id === 'string' && isUtcInstant(value.reminder.fireAt));
  const preservedReminders = Array.isArray(value.preservedReminders) &&
    value.preservedReminders.every(candidate => isRecord(candidate) && typeof candidate.id === 'string' &&
      typeof candidate.version === 'number' && Number.isSafeInteger(candidate.version) && candidate.version >= 1 &&
      isUtcInstant(candidate.fireAt) && ['scheduled', 'fired', 'cancelled'].includes(String(candidate.state)));
  const resume = isNullableText(value.replacesActionId) &&
    (value.resumeMode === null || value.resumeMode === 'create' || value.resumeMode === 'reconcile') &&
    (value.replacesActionId === null) === (value.resumeMode === null);
  return source && typeof value.sourceKey === 'string' && isRecord(value.sourceSnapshot) &&
    (value.expectedTaskVersion === null || (typeof value.expectedTaskVersion === 'number' && Number.isSafeInteger(value.expectedTaskVersion) && value.expectedTaskVersion >= 1)) &&
    (value.expectedPlanVersion === null || (typeof value.expectedPlanVersion === 'number' && Number.isSafeInteger(value.expectedPlanVersion) && value.expectedPlanVersion >= 1)) &&
    typeof value.title === 'string' && (value.status === 'open' || value.status === 'completed') &&
    typeof value.localTaskId === 'string' && (value.operation === 'bind' || value.operation === 'create') &&
    typeof value.destination.accountId === 'string' && typeof value.destination.listId === 'string' &&
    typeof value.destination.listName === 'string' && isNullableText(value.existingExternalId) && target && outgoing &&
    (value.plan.priority === 'low' || value.plan.priority === 'medium' || value.plan.priority === 'high') &&
    typeof value.plan.waiting === 'boolean' && isNullableDateKey(value.plan.deadlineOn) &&
    isNullableDateKey(value.plan.plannedOn) && isNullableUtcInstant(value.plan.plannedAt) &&
    (value.plan.estimateMinutes === null || Number.isSafeInteger(value.plan.estimateMinutes)) &&
    reminder && preservedReminders && resume && typeof value.approvalText === 'string';
}

function isMigrationPreviewResponse(value: unknown): value is { preview: TaskMigrationPreview } {
  if (!isRecord(value) || !isRecord(value.preview)) return false;
  const preview = value.preview;
  const blockerCodes = [
    'google_unavailable', 'hermes_unavailable', 'wrong_board', 'destination_missing', 'source_missing',
    'ambiguous_source', 'duplicate_target', 'pending_create', 'status_conflict', 'planning_conflict',
    'completed_create',
  ];
  return /^[a-f0-9]{64}$/.test(String(preview.hash)) && isNullableText(preview.accountId) &&
    isNullableText(preview.connectionGeneration) && isUtcInstant(preview.generatedAt) &&
    Array.isArray(preview.items) && preview.items.every(isMigrationPreviewItem) &&
    Array.isArray(preview.blockers) && preview.blockers.every(blocker => isRecord(blocker) &&
      isNullableText(blocker.sourceKey) && blockerCodes.includes(String(blocker.code)) && typeof blocker.message === 'string');
}

function isMigrationProgress(value: unknown): value is MigrationProgress {
  if (!isRecord(value) || !isRecord(value.counts) || !Array.isArray(value.mappings)) return false;
  const counts = value.counts;
  const state = value.state === 'queued' || value.state === 'working' ||
    value.state === 'needs_review' || value.state === 'settled';
  const countKeys = ['total', 'queued', 'running', 'succeeded', 'failed', 'conflict', 'unknown'] as const;
  const actionStates = ['queued', 'running', 'succeeded', 'failed', 'conflict', 'unknown', 'superseded', 'cancelled'];
  return typeof value.migrationId === 'string' && /^[a-f0-9]{64}$/.test(String(value.previewHash)) && state &&
    countKeys.every(key => typeof counts[key] === 'number' && Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0) &&
    [counts.superseded, counts.cancelled].every(count => count === undefined ||
      (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) &&
    value.mappings.every(mapping => isRecord(mapping) && typeof mapping.sourceKey === 'string' &&
      isNullableText(mapping.externalId) && typeof mapping.actionId === 'string' && actionStates.includes(String(mapping.state)));
}

function isMigrationProgressResponse(value: unknown): value is { migration: MigrationProgress } {
  return isRecord(value) && isMigrationProgress(value.migration);
}

function isMigrationHistoryResponse(value: unknown): value is { migrations: MigrationProgress[] } {
  return isRecord(value) && Array.isArray(value.migrations) && value.migrations.every(isMigrationProgress);
}

function migrationSourceLabel(item: TaskMigrationPreviewItem): string {
  return item.source.kind === 'fox' ? 'Fox Focus' : item.source.boardSlug;
}

function migrationActionLabel(item: TaskMigrationPreviewItem): string {
  return item.operation === 'bind' ? 'Bind existing Google task' : 'Create in Google Tasks';
}

function migrationStateLabel(state: MigrationProgress['state']): string {
  if (state === 'needs_review') return 'Needs review';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function providerLabel(provider: Provider): string {
  return provider === 'google' ? 'Google' : 'Microsoft';
}

function formatInstant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-IE', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
  }).format(date);
}

function formatDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-IE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' }).format(date);
}

function recordWhen(record: ImportedRecord): string {
  if (record.kind === 'task') return record.dueOn ? `Do on ${formatDate(record.dueOn)}` : 'No due day';
  if (record.allDay && record.startsOn) return `All day · ${formatDate(record.startsOn)}`;
  return record.startsAt ? formatInstant(record.startsAt) : 'Time unavailable';
}

function connectionCopy(provider: ProviderStatus): string {
  if (!provider.configured) return 'Server credentials have not been mounted.';
  if (!provider.connection) return provider.provider === 'google'
    ? 'Full Google Calendar and Tasks access is ready to connect. Calendar changes will still require an explicit approval flow in Fox Focus.'
    : 'Read-only calendar and task context is ready to connect.';
  if (provider.connection.state === 'needs_reconnect') return 'The saved authorization needs to be renewed.';
  if (provider.provider === 'google' && !provider.connection.scopes.includes('https://www.googleapis.com/auth/tasks')) {
    return 'Enable task updates to approve completions and reopens from Fox Focus. Your current imports still work.';
  }
  if (provider.sync.state === 'syncing') return 'Refreshing your read-only context…';
  if (provider.sync.state === 'failed') return provider.sync.lastError ?? 'The last refresh did not finish.';
  if (provider.connection.lastSyncedAt) return `Last synced ${formatInstant(provider.connection.lastSyncedAt)}.`;
  return 'Connected. First import is waiting to run.';
}

export function useOverview(open: boolean): OverviewState {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/v1/integrations');
      const value: unknown = await response.json();
      if (!response.ok || !isOverview(value)) throw new Error('Invalid integrations response');
      setOverview(value);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  return { overview, loading, failed, refresh };
}

export function IntegrationsDrawer({
  open,
  onClose,
  overviewState,
  listAreas,
  onListAreaChange,
  onWorkspaceChanged,
  beforeWorkspaceMutation,
  localTasks,
}: {
  open: boolean;
  onClose: () => void;
  overviewState?: OverviewState;
  listAreas?: Record<string, Area>;
  onListAreaChange?: (key: string, area: Area) => void;
  onWorkspaceChanged?: (snapshot: WorkspaceSnapshot) => void;
  beforeWorkspaceMutation?: () => Promise<void>;
  localTasks?: Task[];
}) {
  const internalOverviewState = useOverview(open && overviewState === undefined);
  const { overview, loading, failed, refresh } = overviewState ?? internalOverviewState;
  const nativeTasks = localTasks ?? [];
  const [syncing, setSyncing] = useState<Provider | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionResult, setConnectionResult] = useState<{ text: string; failed: boolean } | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('integration');
    if (provider === 'unavailable') return { text: 'This connection is unavailable. Check the provider setup and try again.', failed: true };
    if (provider !== 'google' && provider !== 'microsoft') return null;
    const result = params.get('result');
    if (result !== 'connected' && result !== 'failed' && result !== 'declined') return null;
    const fallback = result === 'connected'
      ? `${providerLabel(provider)} connected.`
      : result === 'declined' ? 'Connection was not approved. You can try again when ready.'
        : 'Connection failed. Try connecting again.';
    return { text: params.get('notice')?.slice(0, 500) || fallback, failed: result !== 'connected' };
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('integration')) return;
    for (const key of ['integration', 'result', 'notice']) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const [adoption, setAdoption] = useState<AdoptionPreview | null>(null);
  const [adoptionSourceRecord, setAdoptionSourceRecord] = useState<ImportedRecord | null>(null);
  const [adopting, setAdopting] = useState<number | null>(null);
  const [linkTargetId, setLinkTargetId] = useState('');
  const [migrationPreview, setMigrationPreview] = useState<TaskMigrationPreview | null>(null);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [migrationApprovalKey, setMigrationApprovalKey] = useState('');
  const [migrationBusy, setMigrationBusy] = useState<'preview' | 'approve' | 'refresh' | null>(null);
  const [migrationHistoryLoaded, setMigrationHistoryLoaded] = useState(false);
  useEffect(() => {
    if (open) return;
    setAdoption(null);
    setAdoptionSourceRecord(null);
    setLinkTargetId('');
    setMessage(null);
    setConnectionResult(null);
    setMigrationHistoryLoaded(false);
  }, [open]);

  useEffect(() => {
    if (!open || migrationHistoryLoaded) return;
    setMigrationHistoryLoaded(true);
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/v1/task-migrations', { signal: controller.signal });
        const value: unknown = await response.json();
        if (!response.ok || !isMigrationHistoryResponse(value)) throw new Error('Invalid migration history');
        const latest = value.migrations.find(migration => migration.state !== 'settled') ?? value.migrations[0] ?? null;
        setMigrationProgress(latest);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setMessage('Task migration history could not be loaded.');
        }
      }
    })();
    return () => controller.abort();
  }, [migrationHistoryLoaded, open]);

  useEffect(() => {
    if (!open || !migrationProgress || migrationProgress.state === 'settled' || migrationProgress.state === 'needs_review') return;
    const controller = new AbortController();
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/task-migrations/${encodeURIComponent(migrationProgress.migrationId)}`, {
          signal: controller.signal,
        });
        const value: unknown = await response.json();
        if (!response.ok || !isMigrationProgressResponse(value)) throw new Error('Invalid migration status');
        if (active) setMigrationProgress(value.migration);
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === 'AbortError')) {
          setMessage('Task migration status could not be refreshed. The durable actions will keep their state.');
        }
      }
    };
    const interval = window.setInterval(() => { void poll(); }, 1_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [migrationProgress?.migrationId, migrationProgress?.state, open]);

  useEffect(() => {
    if (!open || migrationProgress?.state !== 'settled') return;
    setMessage('Task migration settled. Source mappings and approval history were preserved.');
    void refresh();
  }, [migrationProgress?.migrationId, migrationProgress?.state, open, refresh]);
  if (!open) return null;

  async function sync(provider: Provider) {
    setSyncing(provider);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/integrations/${provider}/sync`, { method: 'POST' });
      const value: unknown = await response.json();
      if (!isRecord(value) || (value.outcome !== 'synced' && value.outcome !== 'failed')) throw new Error('Invalid sync response');
      setMessage(value.outcome === 'synced' && typeof value.recordCount === 'number'
        ? `${providerLabel(provider)} refreshed ${value.recordCount} records.`
        : typeof value.notice === 'string' ? value.notice : 'Refresh did not finish.');
      await refresh();
    } catch {
      setMessage('Refresh did not finish. Try again.');
    } finally {
      setSyncing(null);
    }
  }

  async function previewAdoption(record: ImportedRecord, targetTaskId?: string) {
    setAdopting(record.id);
    setMessage(null);
    try {
      const response = await fetch('/api/v1/task-adoptions/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: record.provider, recordId: record.id, ...(targetTaskId ? { targetTaskId } : {}) }),
      });
      const value: unknown = await response.json();
      if (!response.ok || !isAdoptionPreview(value)) {
        throw new Error(isRecord(value) && typeof value.error === 'string' ? value.error : 'Could not prepare adoption.');
      }
      setAdoption(value);
      setAdoptionSourceRecord(record);
      setLinkTargetId(typeof value.before.targetTaskId === 'string' ? value.before.targetTaskId : '');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not prepare adoption.');
    } finally {
      setAdopting(null);
    }
  }

  async function approveAdoption() {
    if (!adoption) return;
    setMessage(null);
    try {
      await beforeWorkspaceMutation?.();
      const response = await fetch(`/api/v1/task-adoptions/${encodeURIComponent(adoption.id)}/approve`, { method: 'POST' });
      const value: unknown = await response.json();
      const snapshot = isRecord(value) && isWorkspaceSnapshot(value.snapshot) ? value.snapshot : null;
      if (!response.ok || !snapshot) throw new Error(isRecord(value) && typeof value.error === 'string' ? value.error : 'Could not adopt task.');
      setAdoption(null);
      setAdoptionSourceRecord(null);
      setLinkTargetId('');
      setMessage(typeof adoption.before.targetTaskId === 'string'
        ? 'Source linked to the existing Fox Focus task.'
        : 'Task adopted. Fox Focus now keeps its history.');
      onWorkspaceChanged?.(snapshot);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not adopt task.');
    }
  }

  async function previewMigration() {
    setMigrationBusy('preview');
    setMessage(null);
    try {
      await beforeWorkspaceMutation?.();
      const response = await fetch('/api/v1/task-migrations/preview');
      const value: unknown = await response.json();
      if (!response.ok || !isMigrationPreviewResponse(value)) {
        throw new Error(isRecord(value) && typeof value.error === 'string' ? value.error : 'Could not prepare task migration.');
      }
      setMigrationPreview(value.preview);
      setMigrationProgress(null);
      setMigrationApprovalKey(crypto.randomUUID());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not prepare task migration.');
    } finally {
      setMigrationBusy(null);
    }
  }

  async function approveMigration() {
    if (!migrationPreview || migrationPreview.blockers.length || !migrationPreview.items.length) return;
    setMigrationBusy('approve');
    setMessage(null);
    try {
      await beforeWorkspaceMutation?.();
      const response = await fetch('/api/v1/task-migrations/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previewHash: migrationPreview.hash,
          idempotencyKey: migrationApprovalKey || crypto.randomUUID(),
        }),
      });
      const value: unknown = await response.json();
      if (!response.ok || !isMigrationProgressResponse(value)) {
        throw new Error(isRecord(value) && typeof value.error === 'string' ? value.error : 'Could not approve task migration.');
      }
      setMigrationProgress(value.migration);
      setMessage(value.migration.state === 'settled' ? 'Task migration settled.' : 'Task migration approved and queued.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not approve task migration.');
    } finally {
      setMigrationBusy(null);
    }
  }

  async function refreshMigration() {
    if (!migrationProgress) return;
    setMigrationBusy('refresh');
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/task-migrations/${encodeURIComponent(migrationProgress.migrationId)}`);
      const value: unknown = await response.json();
      if (!response.ok || !isMigrationProgressResponse(value)) throw new Error('Could not refresh task migration.');
      setMigrationProgress(value.migration);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not refresh task migration.');
    } finally {
      setMigrationBusy(null);
    }
  }

  const records = overview?.records ?? [];
  const events = records.filter(record => record.kind === 'calendar_event');
  const tasks = records.filter(record => record.kind === 'task');
  const taskLists = [...tasks.reduce((lists, task) => {
    const key = listAreaKey(task.provider, task.containerId);
    const existing = lists.get(key);
    lists.set(key, existing ? { ...existing, count: existing.count + 1 } : {
      key,
      provider: task.provider,
      containerId: task.containerId,
      name: task.containerName,
      count: 1,
    });
    return lists;
  }, new Map<string, { key: string; provider: Provider; containerId: string; name: string; count: number }>()).values()];
  const adoptionRecord = adoptionSourceRecord ?? (adoption && typeof adoption.before.recordId === 'number'
    ? tasks.find(record => record.id === adoption.before.recordId)
    : undefined);
  const adoptionLinkProvider = adoptionRecord?.provider === 'microsoft' ? 'microsoft_todo' : 'google_tasks';
  const linkableTasks = nativeTasks.filter(task => {
    if (!adoptionRecord) return false;
    const providerLinks = task.externalLinks?.filter(link => link.provider === adoptionLinkProvider) ?? [];
    if (!providerLinks.length) return true;
    return providerLinks.length === 1 && providerLinks[0].connectionId !== adoptionRecord.connectionId &&
      providerLinks[0].containerId === adoptionRecord.containerId && providerLinks[0].externalId === adoptionRecord.externalId;
  });
  const selectedLinkTarget = linkTargetId ? nativeTasks.find(task => task.id === linkTargetId) : undefined;

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="editor-dialog editor-dialog--drawer integrations-drawer" role="dialog" aria-modal="true" aria-label="Calendar and task connections">
        <div className="editor-heading">
          <div className="composer-icon"><Link2 size={17} /></div>
          <div><p className="eyebrow">Connections</p><h2>Calendars &amp; tasks</h2></div>
          <button className="close-composer" type="button" onClick={onClose} aria-label="Close connections"><X size={17} /></button>
        </div>
        <p className="drawer-intro">Google Calendar and Tasks are connected through explicit approval boundaries. Fox Focus keeps planning and reminders; calendar changes need a dedicated owner-approved action flow.</p>
        <div className="integration-security"><ShieldCheck size={15} /><span>Only the exact task create or status change you approve can be written. Delete and clear actions are not available.</span></div>
        {connectionResult ? <p className={`integration-message${connectionResult.failed ? ' integration-message--error' : ''}`} role="status">{connectionResult.text}</p> : null}
        {message ? <p className="integration-message" role="status">{message}</p> : null}
        {failed ? <p className="integration-message integration-message--error" role="status">Could not load connection status. Your provider data was not changed.</p> : null}
        {adoptionSourceRecord && !adoption ? <section className="saved-draft" aria-label="Choose task adoption destination">
          <span>Prepare adoption preview</span>
          <p><strong>Source:</strong> {adoptionSourceRecord.title} · {providerLabel(adoptionSourceRecord.provider)} · {adoptionSourceRecord.containerName}</p>
          <div className="integration-link-choice"><label><span>Destination in Fox Focus</span><select value={linkTargetId} onChange={(event) => setLinkTargetId(event.target.value)}><option value="">Create a separate native task</option>{linkableTasks.map(task => <option value={task.id} key={task.id}>{task.title}</option>)}</select></label><button className="submit-button" type="button" disabled={adopting === adoptionSourceRecord.id} onClick={() => void previewAdoption(adoptionSourceRecord, linkTargetId || undefined)}>{adopting === adoptionSourceRecord.id ? 'Preparing…' : 'Review change'}</button></div>
          {selectedLinkTarget ? <p><strong>Compare:</strong> source is {adoptionSourceRecord.status ?? 'unknown'}{adoptionSourceRecord.dueOn ? `, due ${formatDate(adoptionSourceRecord.dueOn)}` : ', no due day'}; “{selectedLinkTarget.title}” is {selectedLinkTarget.completed ? 'completed' : selectedLinkTarget.state}{selectedLinkTarget.deadlineDate ? `, due ${formatDate(selectedLinkTarget.deadlineDate)}` : `, ${selectedLinkTarget.due.toLowerCase()}`}.</p> : null}
          <div className="integration-provider-actions"><button className="secondary-action" type="button" onClick={() => { setAdoptionSourceRecord(null); setLinkTargetId(''); }}>Cancel</button></div>
        </section> : null}
        {adoption ? <section className="saved-draft" aria-label="Task adoption preview">
          <span>Before and after</span>
          <p><strong>Before:</strong> {String(adoption.before.title ?? adoption.after.title)} stays in {String(adoption.before.ownership ?? 'the source')}.</p>
          {typeof adoption.before.connectionId === 'string' ? <p>Source connection {adoption.before.connectionId.slice(0, 8)} · {String(adoption.before.list ?? 'task list')} · task {String(adoption.before.externalId ?? 'unknown')}</p> : null}
          <p><strong>After:</strong> {typeof adoption.before.targetTaskId === 'string'
            ? `The source link is added to “${String(adoption.before.targetTaskTitle ?? adoption.after.title)}” without replacing its Fox Focus details.`
            : 'Fox Focus owns a new native copy and keeps it here when completed.'}</p>
          {typeof adoption.before.targetTaskId === 'string' ? <p><strong>State comparison:</strong> source is {String(adoption.before.state ?? 'unknown')}{typeof adoption.before.dueOn === 'string' ? `, due ${formatDate(adoption.before.dueOn)}` : ', no due day'}; Fox Focus stays {String(adoption.before.targetTaskState ?? 'unchanged')}{typeof adoption.before.targetTaskDeadline === 'string' ? `, due ${adoption.before.targetTaskDeadline}` : ''}.</p> : null}
          <p>{adoption.after.externalLinks?.find(link => link.provider === (adoption.before.provider === 'microsoft' ? 'microsoft_todo' : 'google_tasks'))?.policy === 'completion_only'
            ? 'Its existing Google link may only complete or reopen this exact source task, after another approval preview.'
            : 'The source link is kept as read-only provenance.'}</p>
          {adoptionRecord && linkableTasks.length ? <div className="integration-link-choice"><label><span>Use an existing Fox Focus task instead</span><select value={linkTargetId} onChange={(event) => setLinkTargetId(event.target.value)}><option value="">Create a separate native task</option>{linkableTasks.map(task => <option value={task.id} key={task.id}>{task.title}</option>)}</select></label><button className="secondary-action" type="button" disabled={adopting === adoptionRecord.id || (linkTargetId || '') === String(adoption.before.targetTaskId ?? '')} onClick={() => void previewAdoption(adoptionRecord, linkTargetId || undefined)}>Update preview</button></div> : null}
          <div className="integration-provider-actions">
            <button className="secondary-action" type="button" onClick={() => { setAdoption(null); setAdoptionSourceRecord(null); setLinkTargetId(''); }}>Cancel</button>
            <button className="submit-button" type="button" onClick={() => void approveAdoption()}>Adopt into Fox Focus</button>
          </div>
        </section> : null}
        <div className="integration-provider-list">
          {(overview?.providers ?? []).map(provider => (
            <article className="integration-provider" key={provider.provider}>
              <div className="integration-provider-copy">
                <strong>{provider.displayName}</strong>
                <small>{connectionCopy(provider)}</small>
                {provider.connection?.state === 'connected' ? <span>Connection {provider.connection.connectionId.slice(0, 8)} · {provider.calendarEventCount} calendar items · {provider.taskCount} tasks</span> : null}
              </div>
              <div className="integration-provider-actions">
                {!provider.configured ? <span className="connection-state connection-state--muted">Setup needed</span> : null}
                {provider.configured && !provider.connection ? <a className="submit-button" href={`/api/v1/integrations/${provider.provider}/connect`}><Link2 size={13} /> Connect</a> : null}
                {provider.configured && (provider.connection?.state === 'needs_reconnect' || (provider.provider === 'google' && provider.connection?.state === 'connected' && !provider.connection.scopes.includes('https://www.googleapis.com/auth/tasks'))) ? <a className="submit-button" href={`/api/v1/integrations/${provider.provider}/connect`}><Link2 size={13} /> {provider.connection?.state === 'needs_reconnect' ? 'Reconnect' : 'Enable task updates'}</a> : null}
                {provider.configured && provider.connection?.state === 'connected' ? <button className="secondary-action" type="button" disabled={syncing === provider.provider || provider.sync.state === 'syncing'} onClick={() => void sync(provider.provider)}><RefreshCw size={13} /> Refresh</button> : null}
              </div>
            </article>
          ))}
          {!overview && !loading ? <p className="empty-line">No connection status is available yet.</p> : null}
        </div>
        <section className="task-migration-panel" aria-labelledby="task-migration-heading">
          <header>
            <span><ListTodo size={15} /><strong id="task-migration-heading">Legacy task migration</strong></span>
            <button className="secondary-action" type="button" disabled={migrationBusy !== null || migrationProgress?.state === 'queued' || migrationProgress?.state === 'working'} onClick={() => void previewMigration()}>
              <RefreshCw size={12} /> {migrationBusy === 'preview' ? 'Preparing…' : migrationPreview ? 'Preview again' : 'Preview'}
            </button>
          </header>
          <p>Native Fox tasks and the <code>personal-tasks</code> board move only after this exact batch is approved.</p>
          {migrationProgress ? <div className={`migration-progress migration-progress--${migrationProgress.state}`}>
            <div><span>{migrationStateLabel(migrationProgress.state)}</span><strong>{migrationProgress.counts.succeeded + (migrationProgress.counts.superseded ?? 0) + (migrationProgress.counts.cancelled ?? 0)} of {migrationProgress.counts.total}</strong></div>
            <div className="migration-counts">
              {migrationProgress.counts.queued ? <span>{migrationProgress.counts.queued} queued</span> : null}
              {migrationProgress.counts.running ? <span>{migrationProgress.counts.running} running</span> : null}
              {migrationProgress.counts.failed ? <span>{migrationProgress.counts.failed} failed</span> : null}
              {migrationProgress.counts.conflict ? <span>{migrationProgress.counts.conflict} conflicts</span> : null}
              {migrationProgress.counts.unknown ? <span>{migrationProgress.counts.unknown} unknown</span> : null}
            </div>
            {migrationProgress.state === 'needs_review' ? <p>Review the unresolved mappings. Unknown creates reconcile only and conflicts are never resent.</p> : null}
            {!migrationPreview && migrationProgress.mappings.length ? <div className="migration-progress-mappings">
              {migrationProgress.mappings.map(mapping => <span key={mapping.actionId ?? mapping.sourceKey}>
                <strong>{mapping.sourceKey}</strong>
                <small>{mapping.externalId ?? mapping.state}</small>
              </span>)}
            </div> : null}
            <button className="mini-action" type="button" disabled={migrationBusy !== null} onClick={() => void refreshMigration()}>{migrationBusy === 'refresh' ? 'Refreshing…' : 'Refresh status'}</button>
          </div> : null}
          {migrationPreview ? <div className="migration-preview">
            <div className="migration-preview-summary">
              <span><strong>{migrationPreview.items.length}</strong> ready</span>
              <span className={migrationPreview.blockers.length ? 'migration-blocked' : ''}><strong>{migrationPreview.blockers.length}</strong> blocked</span>
              <small>{formatInstant(migrationPreview.generatedAt)}</small>
            </div>
            {migrationPreview.blockers.length ? <div className="migration-blockers" role="alert">
              {migrationPreview.blockers.map((blocker, index) => <p key={`${blocker.sourceKey ?? 'batch'}:${blocker.code}:${index}`}>{blocker.message}</p>)}
            </div> : null}
            <div className="migration-items">
              {migrationPreview.items.map(item => {
                const mapping = migrationProgress?.mappings.find(candidate => candidate.sourceKey === item.sourceKey);
                return <details key={item.sourceKey}>
                  <summary>
                    <i className={`inbox-thread-dot inbox-thread-dot--${mapping?.state === 'succeeded' ? 'settled' : mapping && ['failed', 'conflict', 'unknown'].includes(mapping.state) ? 'needs_you' : 'working'}`} />
                    <span><strong>{item.title}</strong><small>{migrationSourceLabel(item)} · {item.destination.listName}</small></span>
                    <em>{mapping?.state ?? item.operation}</em>
                  </summary>
                  <div className="migration-item-detail">
                    <span>{migrationActionLabel(item)}</span>
                    <pre>{item.approvalText}</pre>
                    {mapping?.externalId ? <small>Google task {mapping.externalId}</small> : null}
                  </div>
                </details>;
              })}
            </div>
            {!migrationProgress ? <div className="migration-approval">
              <span>{migrationPreview.blockers.length ? 'Resolve every blocker before approval.' : 'Approval stores this immutable batch before execution.'}</span>
              <button className="submit-button" type="button" disabled={migrationBusy !== null || Boolean(migrationPreview.blockers.length) || !migrationPreview.items.length} onClick={() => void approveMigration()}>{migrationBusy === 'approve' ? 'Approving…' : 'Approve migration'}</button>
            </div> : null}
          </div> : null}
        </section>
        {loading && !overview ? <p className="integration-loading">Checking connections…</p> : null}
        {taskLists.length ? <div className="integration-record-section integration-task-lists">
          <div><ListTodo size={15} /><strong>List routing</strong></div>
          <p className="integration-task-lists-note">Provider lists stay as projects. Choose which Fox Focus area each one belongs to.</p>
          {taskLists.map(list => <article className="integration-record" key={list.key}>
            <span><strong>{list.name}</strong><small>{providerLabel(list.provider)} · {list.count} {list.count === 1 ? 'task' : 'tasks'}</small></span>
            <label className="field"><span className="visually-hidden">Show {providerLabel(list.provider)} list {list.name} in area</span><select value={areaForList(listAreas, list.provider, list.containerId, list.name)} disabled={!onListAreaChange} onChange={(event) => { const area = event.target.value; if (isOneOf(area, areas)) onListAreaChange?.(list.key, area); }}>{areas.map(area => <option value={area} key={area}>{area}</option>)}</select></label>
          </article>)}
        </div> : null}
        <div className="integration-records">
          <div className="integration-record-section">
            <div><CalendarDays size={15} /><strong>Imported calendar context</strong></div>
            {events.slice(0, 40).map(record => <article className="integration-record" key={record.id}><span><strong>{record.title}</strong><small>{providerLabel(record.provider)} · {record.containerName} · {recordWhen(record)}</small></span><CheckCircle2 size={15} aria-label="Read-only" /></article>)}
            {overview && !events.length ? <p className="empty-line">No calendar items imported yet.</p> : null}
          </div>
          <div className="integration-record-section">
            <div><ListTodo size={15} /><strong>Imported tasks</strong></div>
            {tasks.map(record => <article className="integration-record" key={record.id}><span><strong>{record.title}</strong><small>{providerLabel(record.provider)} · {record.containerName} · {recordWhen(record)}{record.status === 'completed' ? ' · completed' : ''}</small></span>{record.adoptedTaskId ? <span className="connection-state"><CheckCircle2 size={13} /> In Fox Focus</span> : <button className="mini-action" type="button" onClick={() => { setAdoption(null); setAdoptionSourceRecord(record); setLinkTargetId(''); setMessage(null); }}>Adopt</button>}</article>)}
            {overview && !tasks.length ? <p className="empty-line">No tasks imported yet.</p> : null}
          </div>
        </div>
        <div className="editor-footer"><span>Legacy adoption remains available until the approved task migration is run. Calendar imports stay source-owned.</span><button className="secondary-action" type="button" onClick={onClose}>Close</button></div>
      </section>
    </div>
  );
}

function calendarContextHeading(startDate: string, endDate: string, today: string): string {
  if (!isDateKey(startDate) || !isDateKey(endDate) || startDate > endDate) return 'Imported calendar';
  if (startDate === endDate) return `Imported calendar · ${formatDate(startDate)}`;
  return startDate >= today ? 'Upcoming imported calendar' : 'Imported calendar range';
}

function emptyCalendarContextCopy(
  startDate: string,
  endDate: string,
  today: string,
  hasImportedEvents: boolean,
): string {
  if (!isDateKey(startDate) || !isDateKey(endDate) || startDate > endDate) {
    return 'The selected calendar range is unavailable.';
  }
  if (!hasImportedEvents) return 'Connected, but no calendar items have been imported yet.';
  if (startDate === endDate) {
    return startDate === today
      ? 'No imported calendar items today.'
      : `No imported calendar items on ${formatDate(startDate)}.`;
  }
  const prefix = startDate >= today ? 'No upcoming imported calendar items' : 'No imported calendar items';
  return `${prefix} from ${formatDate(startDate)} to ${formatDate(endDate)}.`;
}

/** Compact context for the selected calendar range; the drawer remains the full source browser. */
export function IntegrationCalendarContext({
  overviewState,
  startDate,
  endDate,
  onOpen,
}: {
  overviewState: OverviewState;
  startDate: string;
  endDate: string;
  onOpen: () => void;
}) {
  const { overview, loading, failed } = overviewState;
  const connected = overview?.providers.some(provider => provider.connection?.state === 'connected') ?? false;
  const importedEvents = (overview?.records ?? []).filter(record => record.kind === 'calendar_event');
  const matchingEvents = filterCalendarContextByDateRange(importedEvents, startDate, endDate);
  const events = matchingEvents.slice(0, 8);
  const today = dublinDateKey(new Date());

  if (loading && !overview) return <p className="source-boundary">Checking calendar connections…</p>;
  if (failed && !overview) return <p className="source-boundary source-boundary--warning">Calendar connections could not be checked. <button className="inline-action" type="button" onClick={onOpen}>Open sources</button></p>;
  if (!connected) return null;
  return <div className="provider-calendar-context">
    <div><span>{calendarContextHeading(startDate, endDate, today)} · read-only</span><button className="inline-action" type="button" onClick={onOpen}>Open sources</button></div>
    {events.map(record => <p key={record.id}><strong>{record.title}</strong><small>{providerLabel(record.provider)} · {recordWhen(record)}</small></p>)}
    {matchingEvents.length > events.length ? <p className="provider-calendar-context-empty">{matchingEvents.length - events.length} more imported item{matchingEvents.length - events.length === 1 ? '' : 's'} in this range. Open sources to review them.</p> : null}
    {!matchingEvents.length ? <p className="provider-calendar-context-empty">{emptyCalendarContextCopy(startDate, endDate, today, importedEvents.length > 0)}</p> : null}
  </div>;
}
