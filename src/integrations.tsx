import { CalendarDays, CheckCircle2, CircleAlert, Link2, ListTodo, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { dublinDateKey, isDateKey } from './calendar-time.ts';
import { filterCalendarContextByDateRange } from './integration-model.ts';

type Provider = 'google' | 'microsoft';
type SyncState = 'idle' | 'syncing' | 'failed';
type ConnectionState = 'connected' | 'needs_reconnect';

type Connection = {
  state: ConnectionState;
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

type ImportedRecord = {
  id: number;
  provider: Provider;
  kind: 'calendar_event' | 'task';
  containerName: string;
  title: string;
  status: string | null;
  startsAt: string | null;
  startsOn: string | null;
  dueOn: string | null;
  allDay: boolean;
};

type Overview = { providers: ProviderStatus[]; records: ImportedRecord[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is Provider {
  return value === 'google' || value === 'microsoft';
}

function isConnection(value: unknown): value is Connection {
  return isRecord(value) &&
    (value.state === 'connected' || value.state === 'needs_reconnect') &&
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
    typeof value.containerName === 'string' && typeof value.title === 'string' &&
    (value.status === null || typeof value.status === 'string') &&
    (value.startsAt === null || typeof value.startsAt === 'string') &&
    (value.startsOn === null || typeof value.startsOn === 'string') &&
    (value.dueOn === null || typeof value.dueOn === 'string') && typeof value.allDay === 'boolean';
}

function isOverview(value: unknown): value is Overview {
  return isRecord(value) && Array.isArray(value.providers) && value.providers.every(isProviderStatus) &&
    Array.isArray(value.records) && value.records.every(isImportedRecord);
}

function providerLabel(provider: Provider): string {
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
  if (!provider.connection) return 'Read-only calendar and task context is ready to connect.';
  if (provider.connection.state === 'needs_reconnect') return 'The saved authorization needs to be renewed.';
  if (provider.sync.state === 'syncing') return 'Refreshing your read-only context…';
  if (provider.sync.state === 'failed') return provider.sync.lastError ?? 'The last refresh did not finish.';
  if (provider.connection.lastSyncedAt) return `Last synced ${formatInstant(provider.connection.lastSyncedAt)}.`;
  return 'Connected. First import is waiting to run.';
}

function useOverview(open: boolean) {
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

export function IntegrationsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { overview, loading, failed, refresh } = useOverview(open);
  const [syncing, setSyncing] = useState<Provider | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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

  const records = overview?.records ?? [];
  const events = records.filter(record => record.kind === 'calendar_event');
  const tasks = records.filter(record => record.kind === 'task');

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="editor-dialog editor-dialog--drawer integrations-drawer" role="dialog" aria-modal="true" aria-label="Calendar and task connections">
        <div className="editor-heading">
          <div className="composer-icon"><Link2 size={17} /></div>
          <div><p className="eyebrow">Read-only sources</p><h2>Calendars &amp; tasks</h2></div>
          <button className="close-composer" type="button" onClick={onClose} aria-label="Close connections"><X size={17} /></button>
        </div>
        <p className="drawer-intro">Fox Focus imports calendar context and tasks without changing either provider. Refresh tokens stay encrypted on this server.</p>
        <div className="integration-security"><ShieldCheck size={15} /><span>No calendar edits, task completions, emails, or provider writes are enabled here.</span></div>
        {message ? <p className="integration-message" role="status">{message}</p> : null}
        {failed ? <p className="integration-message integration-message--error" role="status">Could not load connection status. Your provider data was not changed.</p> : null}
        <div className="integration-provider-list">
          {(overview?.providers ?? []).map(provider => (
            <article className="integration-provider" key={provider.provider}>
              <div className="integration-provider-copy">
                <strong>{provider.displayName}</strong>
                <small>{connectionCopy(provider)}</small>
                {provider.connection?.state === 'connected' ? <span>{provider.calendarEventCount} calendar items · {provider.taskCount} tasks</span> : null}
              </div>
              <div className="integration-provider-actions">
                {!provider.configured ? <span className="connection-state connection-state--muted">Setup needed</span> : null}
                {provider.configured && !provider.connection ? <a className="submit-button" href={`/api/v1/integrations/${provider.provider}/connect`}><Link2 size={13} /> Connect</a> : null}
                {provider.configured && provider.connection?.state === 'needs_reconnect' ? <a className="submit-button" href={`/api/v1/integrations/${provider.provider}/connect`}><Link2 size={13} /> Reconnect</a> : null}
                {provider.configured && provider.connection?.state === 'connected' ? <button className="secondary-action" type="button" disabled={syncing === provider.provider || provider.sync.state === 'syncing'} onClick={() => void sync(provider.provider)}><RefreshCw size={13} /> Refresh</button> : null}
              </div>
            </article>
          ))}
          {!overview && !loading ? <p className="empty-line">No connection status is available yet.</p> : null}
        </div>
        {loading && !overview ? <p className="integration-loading">Checking connections…</p> : null}
        <div className="integration-records">
          <div className="integration-record-section">
            <div><CalendarDays size={15} /><strong>Imported calendar context</strong></div>
            {events.slice(0, 40).map(record => <article className="integration-record" key={record.id}><span><strong>{record.title}</strong><small>{providerLabel(record.provider)} · {record.containerName} · {recordWhen(record)}</small></span><CheckCircle2 size={15} aria-label="Read-only" /></article>)}
            {overview && !events.length ? <p className="empty-line">No calendar items imported yet.</p> : null}
          </div>
          <div className="integration-record-section">
            <div><ListTodo size={15} /><strong>Imported tasks</strong></div>
            {tasks.slice(0, 80).map(record => <article className="integration-record" key={record.id}><span><strong>{record.title}</strong><small>{providerLabel(record.provider)} · {record.containerName} · {recordWhen(record)}{record.status === 'completed' ? ' · completed' : ''}</small></span><CircleAlert size={15} aria-label="Read-only" /></article>)}
            {overview && !tasks.length ? <p className="empty-line">No tasks imported yet.</p> : null}
          </div>
        </div>
        <div className="editor-footer"><span>Imported records remain authoritative in Google or Microsoft.</span><button className="secondary-action" type="button" onClick={onClose}>Close</button></div>
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
  enabled,
  startDate,
  endDate,
  onOpen,
}: {
  enabled: boolean;
  startDate: string;
  endDate: string;
  onOpen: () => void;
}) {
  const { overview, loading, failed } = useOverview(enabled);
  if (!enabled) return null;
  const connected = overview?.providers.some(provider => provider.connection?.state === 'connected') ?? false;
  const importedEvents = (overview?.records ?? []).filter(record => record.kind === 'calendar_event');
  const matchingEvents = filterCalendarContextByDateRange(importedEvents, startDate, endDate);
  const events = matchingEvents.slice(0, 8);
  const today = dublinDateKey(new Date());

  if (loading && !overview) return <p className="source-boundary">Checking calendar connections…</p>;
  if (failed && !overview) return <p className="source-boundary source-boundary--warning">Calendar connections could not be checked. <button className="inline-action" type="button" onClick={onOpen}>Open sources</button></p>;
  if (!connected) return <p className="source-boundary">Calendar source not connected. <button className="inline-action" type="button" onClick={onOpen}>Connect Google or Microsoft</button></p>;
  return <div className="provider-calendar-context">
    <div><span>{calendarContextHeading(startDate, endDate, today)} · read-only</span><button className="inline-action" type="button" onClick={onOpen}>Open sources</button></div>
    {events.map(record => <p key={record.id}><strong>{record.title}</strong><small>{providerLabel(record.provider)} · {recordWhen(record)}</small></p>)}
    {matchingEvents.length > events.length ? <p className="provider-calendar-context-empty">{matchingEvents.length - events.length} more imported item{matchingEvents.length - events.length === 1 ? '' : 's'} in this range. Open sources to review them.</p> : null}
    {!matchingEvents.length ? <p className="provider-calendar-context-empty">{emptyCalendarContextCopy(startDate, endDate, today, importedEvents.length > 0)}</p> : null}
  </div>;
}
