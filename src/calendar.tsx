import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Link2, Plus, X } from 'lucide-react';
import { addCalendarDays, calendarDateWindow, dublinDateKey, dublinTimeValue, formatDublinDateKey } from './calendar-time.ts';
import { daySegment, layoutDay, minuteOfDay } from './calendar-layout.ts';
import type { Area, TimelineEvent } from './model.ts';
import type { ImportedRecord, OverviewState } from './integrations.tsx';
import { importedTaskArea } from './workspace-rules.ts';
import './calendar.css';

export type CalendarEntry = {
  id: string; title: string; date: string; time: string; duration: number;
  startsAt?: string; allDay: boolean; endDate?: string; area: Area; source: string;
  local?: TimelineEvent;
};
type Entry = CalendarEntry;
type Mode = 'day' | 'week' | 'month';

export function calendarEntries(events: TimelineEvent[], records: ImportedRecord[], today: string): Entry[] {
  return [
    ...events.map(event => ({
      id: event.id, title: event.title,
      date: event.startsAt ? dublinDateKey(new Date(event.startsAt)) : event.date ?? today,
      time: typeof event.startsAt === "string" ? dublinTimeValue(event.startsAt) : event.start,
      duration: event.duration, startsAt: event.startsAt, allDay: false,
      area: event.area, source: event.source ?? (event.editable ? 'Local block' : 'Imported calendar'), local: event,
    })),
    ...records.filter(record => record.kind === 'calendar_event' && record.status !== 'cancelled' && (record.startsOn || record.startsAt)).map(record => ({
      id: `import:${record.provider}:${record.id}`, title: record.title,
      date: record.startsOn ?? dublinDateKey(new Date(record.startsAt!)),
      time: record.startsAt ? dublinTimeValue(record.startsAt) : '00:00',
      // sources without an end are shown as a short marker, not an invented hour
      duration: record.startsAt && record.endsAt ? Math.max(1, (Date.parse(record.endsAt) - Date.parse(record.startsAt)) / 60_000) : 15,
      startsAt: record.startsAt ?? undefined, allDay: record.allDay || Boolean(record.startsOn),
      endDate: record.endsOn ?? undefined,
      area: importedTaskArea(undefined, record), source: `${record.containerName} · Imported`,
    })),
  ];
}

export function Calendar({ events, overview, date, onDate, selectedId, onEdit, onAdd, onSources, onAsk }: {
  events: TimelineEvent[]; overview: OverviewState; date: string; onDate: (date: string) => void;
  selectedId: string | null; onEdit: (event: TimelineEvent) => void; onAdd: () => void; onSources: () => void;
  onAsk?: (entry: CalendarEntry) => void;
}) {
  const [mode, setMode] = useState<Mode>('day');
  const [now, setNow] = useState(() => new Date());
  const [selection, setSelection] = useState<string | null>(selectedId);
  const scroller = useRef<HTMLDivElement>(null);
  const today = dublinDateKey(now);
  const entries = calendarEntries(events, overview.overview?.records ?? [], today);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekStart = addCalendarDays(date, -weekday);
  const monthStart = `${date.slice(0, 7)}-01`;
  const monthWeekday = new Date(`${monthStart}T12:00:00Z`).getUTCDay();
  const dates = mode === 'day' ? [date] : mode === 'week' ? calendarDateWindow(weekStart, 0, 6) : calendarDateWindow(addCalendarDays(monthStart, -monthWeekday), 0, 41);
  const selected = entries.find(entry => entry.id === selection);
  const nowMinute = minuteOfDay(dublinTimeValue(now));
  const allDayOn = (entry: Entry, day: string) => entry.allDay && entry.date <= day && (entry.endDate ? day < entry.endDate : day === entry.date);
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { setSelection(selectedId); }, [selectedId]);
  useEffect(() => {
    const event = entries.find(entry => entry.id === selectedId);
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (event ? minuteOfDay(event.time) : dates.includes(today) ? nowMinute : 480) - 120);
  }, [date, mode, selectedId]);
  function move(direction: number) {
    if (mode !== 'month') { setSelection(null); onDate(addCalendarDays(date, direction * (mode === 'week' ? 7 : 1))); return; }
    const next = new Date(`${monthStart}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + direction);
    onDate(next.toISOString().slice(0, 10));
  }
  function eventButton(entry: Entry) {
    return <button key={entry.id} type="button" className={`calendar-chip calendar-color--${entry.area.toLowerCase()}`} onClick={() => setSelection(entry.id)} title={`${entry.title} · ${entry.source}`}>
      {!entry.allDay ? <time>{entry.time}</time> : null}<span>{entry.title}</span>
    </button>;
  }
  return <section className="workspace-page workspace-page--calendar" aria-labelledby="calendar-heading">
    <header className="calendar-toolbar">
      <h1 id="calendar-heading">{formatDublinDateKey(date, mode === 'day' ? { day: 'numeric', month: 'long', year: 'numeric' } : { month: 'long', year: 'numeric' })}</h1>
      <div className="calendar-navigation"><button className="secondary-action" onClick={() => onDate(today)}>Today</button><button className="calendar-step" aria-label={`Previous ${mode}`} onClick={() => move(-1)}><ChevronLeft size={17} /></button><button className="calendar-step" aria-label={`Next ${mode}`} onClick={() => move(1)}><ChevronRight size={17} /></button></div>
      <div className="calendar-view-switch" role="group" aria-label="Calendar view">{(['day', 'week', 'month'] as const).map(value => <button key={value} className={`calendar-view-option${mode === value ? ' calendar-view-option--active' : ''}`} aria-pressed={mode === value} onClick={() => setMode(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
      <button className="page-primary-action" onClick={onAdd}><Plus size={14} /> Add block</button>
    </header>
    {overview.failed ? <p className="workspace-alert">Calendar sources could not refresh. Showing available events.</p> : null}
    <div className="calendar-canvas">
      {mode === 'month' ? <div className="month-grid">
        {dates.slice(0, 7).map(day => <span className="month-weekday" key={day}>{formatDublinDateKey(day, { weekday: 'short' })}</span>)}
        {dates.map(day => <div key={day} className={`month-cell${day.slice(0, 7) !== date.slice(0, 7) ? ' month-cell--outside' : ''}`}><button className={`calendar-day-number${day === today ? ' calendar-day-number--today' : ''}`} aria-label={formatDublinDateKey(day)} onClick={() => { onDate(day); setMode('day'); }}>{Number(day.slice(8))}</button>{entries.filter(entry => entry.allDay ? allDayOn(entry, day) : daySegment(entry, day)).map(eventButton)}</div>)}
      </div> : <>
        <div className="time-grid-head" style={{ gridTemplateColumns: `56px repeat(${dates.length}, minmax(0, 1fr))` }}><span className="calendar-zone">Dublin</span>{dates.map(day => <button key={day} className="time-grid-date" onClick={() => { onDate(day); setMode('day'); }}><span>{formatDublinDateKey(day, { weekday: 'short' })}</span><strong className={`calendar-day-number${day === today ? ' calendar-day-number--today' : ''}`}>{Number(day.slice(8))}</strong></button>)}</div>
        {entries.some(entry => dates.some(day => allDayOn(entry, day))) ? <div className="time-grid-all-day" style={{ gridTemplateColumns: `56px repeat(${dates.length}, minmax(0, 1fr))` }}><span>All day</span>{dates.map(day => <div key={day}>{entries.filter(entry => allDayOn(entry, day)).map(eventButton)}</div>)}</div> : null}
        <div className="time-grid-scroll" ref={scroller}>
          <div className="time-grid" style={{ gridTemplateColumns: `56px repeat(${dates.length}, minmax(0, 1fr))` }}>
            <div className="time-grid-hours">{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: hour * 60 }}>{String(hour).padStart(2, '0')}:00</span>)}</div>
            {dates.map(day => <div className="time-grid-day" key={day} aria-label={formatDublinDateKey(day)}>
              {layoutDay(entries.filter(entry => !entry.allDay), day).map(({ entry, start, end, column, columns }) => <button key={entry.id} type="button" className={`time-grid-event calendar-color--${entry.area.toLowerCase()}${entry.id === selection ? ' time-grid-event--selected' : ''}`} style={{ top: start, height: Math.max(24, end - start - 2), left: `calc(${column / columns * 100}% + 3px)`, width: `calc(${100 / columns}% - 6px)` }} onClick={() => setSelection(entry.id)} title={`${entry.title} · ${entry.time} · ${entry.source}`}><strong>{entry.title}</strong>{end - start >= 38 ? <small>{entry.time}{entry.local?.subtitle ? ` · ${entry.local.subtitle}` : ''}</small> : null}</button>)}
              {day === today ? <div className="calendar-now" style={{ top: nowMinute }} aria-label={`Current time ${dublinTimeValue(now)}`}><span>{dublinTimeValue(now)}</span></div> : null}
            </div>)}
          </div>
        </div>
      </>}
      <footer className="calendar-footnote"><span>Europe/Dublin · Imported calendars are read-only</span><button className="pane-link" onClick={onSources}><Link2 size={12} /> Sources</button></footer>
    </div>
    {selected ? <div className="calendar-selection" role="region" aria-label="Event details"><div><span className="eyebrow">{selected.source}</span><h2>{selected.title}</h2><p>{formatDublinDateKey(selected.date)} · {selected.allDay ? 'All day' : selected.time} · {selected.area}</p></div>{selected.local?.editable ? <button className="secondary-action" onClick={() => selected.local && onEdit(selected.local)}>Edit block</button> : <span className="source-chip">Read-only</span>}{onAsk ? <button className="secondary-action" onClick={() => onAsk(selected)}>Ask Hermes</button> : null}<button className="calendar-step" aria-label="Close event details" onClick={() => setSelection(null)}><X size={16} /></button></div> : null}
  </section>;
}
