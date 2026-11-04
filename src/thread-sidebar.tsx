import { useState } from "react";
import { AlarmClock, Check, ChevronDown, CircleCheck, CircleDashed, LayoutGrid, List, SquarePen } from "lucide-react";
import type { AssistantId, AssistantInfo } from "./row-model.ts";
import { relativeTime, type WorkThread } from "./work-threads.ts";
import "./threads.css";

export type AssistantFilter = AssistantId | "all";

export type SnoozePreset = { id: string; label: string; until: string };

// presets follow T3: later today, tomorrow morning, next Monday morning, in local (Dublin) time
export function snoozePresets(now: Date): SnoozePreset[] {
  const at = (date: Date, hours: number) => {
    const next = new Date(date);
    next.setHours(hours, 0, 0, 0);
    return next;
  };
  const laterToday = now.getHours() < 17 ? at(now, 18) : new Date(now.getTime() + 3 * 60 * 60_000);
  const tomorrow = at(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), 9);
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;
  const nextWeek = at(new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMonday), 9);
  const time = (date: Date) => date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return [
    { id: "later", label: `Later today · ${time(laterToday)}`, until: laterToday.toISOString() },
    { id: "tomorrow", label: `Tomorrow · ${time(tomorrow)}`, until: tomorrow.toISOString() },
    { id: "next-week", label: `Next week · ${nextWeek.toLocaleDateString("en-GB", { weekday: "short" })} ${time(nextWeek)}`, until: nextWeek.toISOString() },
  ];
}

export function assistantInitial(assistant: AssistantId): string {
  return assistant === "fox" ? "F" : "H";
}

function StatusLabel({ thread }: { thread: WorkThread }) {
  if (thread.shelf !== "active") return <span className="thread-time">{relativeTime(thread.updatedAt)}</span>;
  const icon = thread.status === "Woke"
    ? <AlarmClock size={12} aria-hidden />
    : thread.tone === "working"
      ? <CircleDashed size={12} aria-hidden />
      : thread.tone === "done"
        ? <CircleCheck size={12} aria-hidden />
        : null;
  return <span className={`thread-status thread-status--${thread.tone}`}>{icon}{thread.status}</span>;
}

type RowProps = {
  thread: WorkThread;
  selected: boolean;
  context: string;
  engine: string;
  canSettle: boolean;
  canSnooze: boolean;
  onSelect: () => void;
  onSettle: () => void;
  onSnooze: (until: string | null) => void;
  rowRef?: (element: HTMLButtonElement | null) => void;
};

function ThreadRow(props: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { thread } = props;
  const recede = thread.shelf === "settled" || thread.shelf === "noise";
  return <li className={`thread-row${props.selected ? " thread-row--selected" : ""}${recede ? " thread-row--recede" : ""}${menuOpen ? " thread-row--menu" : ""}`}>
    <button className="thread-row-main" type="button" ref={props.rowRef} data-thread-key={thread.key}
      aria-pressed={props.selected} onClick={props.onSelect}>
      <span className="thread-line thread-line--top">
        <span className={`thread-avatar thread-avatar--${thread.assistant}`} aria-hidden>{assistantInitial(thread.assistant)}</span>
        <span className="thread-assistant">{thread.assistant === "fox" ? "Fox" : "Hermes"}</span>
        <StatusLabel thread={thread} />
      </span>
      <span className={`thread-title${thread.attention ? " thread-title--attention" : ""}`}>{thread.title}</span>
      <span className="thread-line thread-line--meta">
        <span className="thread-context">{props.context}</span>
        <span className="thread-engine">{props.engine}</span>
      </span>
    </button>
    {props.canSettle || props.canSnooze ? <span className="thread-row-actions">
      {props.canSettle ? <button type="button" className="thread-action" title="Settle" aria-label={`Settle ${thread.title}`} onClick={props.onSettle}><Check size={13} /></button> : null}
      {props.canSnooze ? <button type="button" className="thread-action" title="Snooze" aria-label={`Snooze ${thread.title}`} aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}><AlarmClock size={13} /></button> : null}
    </span> : null}
    {menuOpen ? <span className="thread-snooze-menu" role="menu">
      {snoozePresets(new Date()).map(preset => <button key={preset.id} type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onSnooze(preset.until); }}>{preset.label}</button>)}
      {thread.shelf === "snoozed" ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onSnooze(null); }}>Wake now</button> : null}
    </span> : null}
  </li>;
}

function Shelf(props: { label: string; count: number; open: boolean; onToggle: () => void; tone: "snoozed" | "settled" | "noise" }) {
  if (!props.count) return null;
  return <li className={`thread-shelf thread-shelf--${props.tone}`}>
    <button type="button" aria-expanded={props.open} onClick={props.onToggle}>
      <span>{props.open ? props.label : `${props.label} (${props.count})`}</span>
      <i aria-hidden />
      <ChevronDown size={12} aria-hidden />
    </button>
  </li>;
}

export type ThreadSidebarProps = {
  threads: WorkThread[];
  assistants: AssistantInfo[];
  filter: AssistantFilter;
  onFilter: (filter: AssistantFilter) => void;
  selectedKey: string | null;
  view: "threads" | "board";
  onView: (view: "threads" | "board") => void;
  onSelect: (thread: WorkThread) => void;
  onSettle: (thread: WorkThread) => void;
  onSnooze: (thread: WorkThread, until: string | null) => void;
  canSettle: (thread: WorkThread) => boolean;
  canSnooze: (thread: WorkThread) => boolean;
  contextLabel: (thread: WorkThread) => string;
  onNewThread: () => void;
  shelves: { snoozed: boolean; settled: boolean; noise: boolean };
  onShelf: (shelf: "snoozed" | "settled" | "noise") => void;
  search: string;
  onSearch: (value: string) => void;
  rowRef?: (key: string, element: HTMLButtonElement | null) => void;
};

const SETTLED_PAGE = 20;

export function ThreadSidebar(props: ThreadSidebarProps) {
  const [settledShown, setSettledShown] = useState(SETTLED_PAGE);
  const query = props.search.trim().toLowerCase();
  const visible = props.threads.filter(thread => (props.filter === "all" || thread.assistant === props.filter) &&
    (!query || thread.title.toLowerCase().includes(query)));
  const active = visible.filter(thread => thread.shelf === "active");
  const snoozed = visible.filter(thread => thread.shelf === "snoozed");
  const settled = visible.filter(thread => thread.shelf === "settled").sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  const noise = visible.filter(thread => thread.shelf === "noise");
  const engine = (thread: WorkThread) => props.assistants.find(assistant => assistant.id === thread.assistant)?.engine === "claude" ? "Claude" : "Hermes";
  const row = (thread: WorkThread) => <ThreadRow key={thread.key} thread={thread} selected={props.selectedKey === thread.key}
    context={props.contextLabel(thread)} engine={engine(thread)} canSettle={props.canSettle(thread)} canSnooze={props.canSnooze(thread)}
    onSelect={() => props.onSelect(thread)} onSettle={() => props.onSettle(thread)} onSnooze={until => props.onSnooze(thread, until)}
    rowRef={props.rowRef ? element => props.rowRef?.(thread.key, element) : undefined} />;
  return <aside className="thread-sidebar" aria-label="Inbox threads">
    <div className="thread-sidebar-head">
      <label className="thread-filter">
        <span className="sr-only">Assistant</span>
        <select value={props.filter} onChange={event => props.onFilter(event.target.value === "fox" || event.target.value === "hermes" ? event.target.value : "all")}>
          <option value="all">All assistants</option>
          {props.assistants.map(assistant => <option key={assistant.id} value={assistant.id}>{assistant.name}</option>)}
        </select>
      </label>
      <button className="thread-icon-button" type="button" title="New thread" aria-label="New thread" onClick={props.onNewThread}><SquarePen size={14} /></button>
      <button className="thread-icon-button" type="button" title={props.view === "board" ? "Thread list" : "Board"}
        aria-label={props.view === "board" ? "Show thread list" : "Show board"} onClick={() => props.onView(props.view === "board" ? "threads" : "board")}>
        {props.view === "board" ? <List size={14} /> : <LayoutGrid size={14} />}
      </button>
    </div>
    <label className="thread-search"><span className="sr-only">Search threads</span>
      <input value={props.search} onChange={event => props.onSearch(event.target.value)} placeholder="Search threads" />
    </label>
    <ul className="thread-list">
      {active.map(row)}
      {!active.length ? <li className="thread-empty">{query ? "No matching threads." : "Nothing needs you."}</li> : null}
      <Shelf label="Snoozed" tone="snoozed" count={snoozed.length} open={props.shelves.snoozed} onToggle={() => props.onShelf("snoozed")} />
      {props.shelves.snoozed ? snoozed.map(row) : null}
      <Shelf label="Settled" tone="settled" count={settled.length} open={props.shelves.settled} onToggle={() => props.onShelf("settled")} />
      {props.shelves.settled ? settled.slice(0, settledShown).map(row) : null}
      {props.shelves.settled && settled.length > settledShown
        ? <li className="thread-more"><button type="button" onClick={() => setSettledShown(count => count + SETTLED_PAGE)}>Show more</button></li>
        : null}
      <Shelf label="Likely noise" tone="noise" count={noise.length} open={props.shelves.noise} onToggle={() => props.onShelf("noise")} />
      {props.shelves.noise ? noise.map(row) : null}
    </ul>
  </aside>;
}

const BOARD_COLUMNS: Array<{ id: string; label: string; match: (thread: WorkThread) => boolean }> = [
  { id: "working", label: "Working", match: thread => thread.shelf === "active" && thread.tone === "working" },
  { id: "needs-you", label: "Needs you", match: thread => thread.shelf === "active" && thread.attention },
  { id: "completed", label: "Completed", match: thread => thread.shelf === "active" && thread.tone === "done" },
  { id: "snoozed", label: "Snoozed", match: thread => thread.shelf === "snoozed" },
  { id: "settled", label: "Settled", match: thread => thread.shelf === "settled" },
];

export function ThreadBoard(props: {
  threads: WorkThread[];
  filter: AssistantFilter;
  contextLabel: (thread: WorkThread) => string;
  onOpen: (thread: WorkThread) => void;
}) {
  const visible = props.threads.filter(thread => props.filter === "all" || thread.assistant === props.filter);
  return <div className="thread-board" aria-label="Board">
    {BOARD_COLUMNS.map(column => {
      const cards = visible.filter(column.match);
      const shown = column.id === "settled" ? cards.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)).slice(0, 12) : cards;
      return <section className={`thread-board-column${column.id === "needs-you" && cards.length ? " thread-board-column--hot" : ""}`} key={column.id} aria-label={column.label}>
        <h3>{column.label}<span>{cards.length}</span></h3>
        {shown.map(thread => <button className={`thread-card${column.id === "settled" ? " thread-card--recede" : ""}`} type="button" key={thread.key} onClick={() => props.onOpen(thread)}>
          <span className="thread-line thread-line--top">
            <span className={`thread-avatar thread-avatar--${thread.assistant}`} aria-hidden>{assistantInitial(thread.assistant)}</span>
            <strong>{thread.title}</strong>
          </span>
          <span className="thread-line thread-line--meta">
            <span className={`thread-status thread-status--${thread.tone}`}>{thread.status}</span>
            <span className="thread-context">{props.contextLabel(thread)}</span>
          </span>
        </button>)}
        {!cards.length ? <p className="thread-board-empty">Empty</p> : null}
      </section>;
    })}
  </div>;
}
