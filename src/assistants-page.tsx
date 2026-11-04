import { useState, type FormEvent } from "react";
import { CornerDownLeft, SquarePen } from "lucide-react";
import type { AssistantId, AssistantInfo, InboxItemRow, Job, ThreadEntry } from "./row-model.ts";
import { assistantInitial } from "./thread-sidebar.tsx";
import { ThreadView } from "./thread-view.tsx";
import { relativeTime, type WorkThread } from "./work-threads.ts";

// the Hermes cron mirror describes each routine in one sentence-per-field summary
function routineField(summary: string, field: string): string | null {
  const match = new RegExp(`${field}: ([^.]+)\\.`).exec(summary);
  return match ? match[1].trim() : null;
}

const CAPABILITIES: Record<AssistantId, Array<{ label: string; level: "allowed" | "asks" | "never" }>> = {
  fox: [
    { label: "Read your tasks, calendar and Inbox", level: "allowed" },
    { label: "Ask you questions", level: "allowed" },
    { label: "Create tasks, send email, edit calendars", level: "never" },
  ],
  hermes: [
    { label: "Read Fox Focus context", level: "allowed" },
    { label: "Propose Inbox items and reply drafts", level: "allowed" },
    { label: "Send email", level: "asks" },
    { label: "Approve its own writes", level: "never" },
  ],
};

export type AssistantsPageProps = {
  assistants: AssistantInfo[];
  threads: WorkThread[];
  routines: InboxItemRow[];
  selected: AssistantId;
  onSelect: (assistant: AssistantId) => void;
  entriesFor: (job: Job) => ThreadEntry[] | null;
  busyKey: string | null;
  onStart: (assistant: AssistantId, text: string) => Promise<boolean>;
  onAnswer: (job: Job, text: string) => void;
  onReply: (job: Job, text: string) => void;
  onSettle: (job: Job) => void;
  onSnooze: (job: Job, until: string | null) => void;
  onOpenThread: (thread: WorkThread) => void;
};

export function AssistantsPage(props: AssistantsPageProps) {
  const [tab, setTab] = useState<"threads" | "routines" | "permissions">("threads");
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const assistant = props.assistants.find(candidate => candidate.id === props.selected) ?? props.assistants[0];
  if (!assistant) return null;
  const own = props.threads.filter(thread => thread.assistant === assistant.id && thread.kind === "job" && thread.job && !thread.item);
  const current = composing ? null : [...own].filter(thread => thread.shelf !== "settled")
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))[0] ?? null;
  const routines = assistant.id === "hermes" ? props.routines : [];

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await props.onStart(assistant.id, text)) {
      setDraft("");
      setComposing(false);
    }
  }

  function summary(id: AssistantId): string {
    const mine = props.threads.filter(thread => thread.assistant === id && thread.shelf === "active");
    const needs = mine.filter(thread => thread.attention).length;
    const working = mine.filter(thread => thread.tone === "working").length;
    const parts = [needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "", working ? `${working} working` : ""].filter(Boolean);
    return parts.join(" · ") || "All quiet";
  }

  return <section className="workspace-page assistants-page" aria-labelledby="assistants-heading">
    <h1 id="assistants-heading" className="sr-only">Assistants</h1>
    <div className="assistants-layout pane">
      <aside className="assistants-roster" aria-label="Assistants">
        {props.assistants.map(candidate => {
          const needs = props.threads.some(thread => thread.assistant === candidate.id && thread.attention);
          return <button key={candidate.id} type="button" className={`assistant-mate${candidate.id === assistant.id ? " assistant-mate--selected" : ""}`}
            aria-pressed={candidate.id === assistant.id} onClick={() => { props.onSelect(candidate.id); setComposing(false); }}>
            <span className={`thread-avatar thread-avatar--large thread-avatar--${candidate.id}`} aria-hidden>{assistantInitial(candidate.id)}</span>
            <span className="assistant-mate-copy">
              <strong>{candidate.name} <em>{candidate.engine === "claude" ? "Claude" : "Hermes"}</em></strong>
              <small>{candidate.available ? `${candidate.role} · ${summary(candidate.id)}` : "Not configured on this server"}</small>
            </span>
            {needs ? <i className="assistant-mate-dot" aria-label="Needs you" /> : null}
          </button>;
        })}
      </aside>
      <div className="assistants-chat">
        <header className="assistants-chat-head">
          <span className={`thread-avatar thread-avatar--${assistant.id}`} aria-hidden>{assistantInitial(assistant.id)}</span>
          <strong>{assistant.name}</strong>
          <small>{assistant.role}</small>
          {current ? <button className="secondary-action" type="button" onClick={() => setComposing(true)}><SquarePen size={13} /> New thread</button> : null}
        </header>
        {current?.job ? <ThreadView compact job={current.job} entries={props.entriesFor(current.job)} busy={props.busyKey !== null}
          onAnswer={text => current.job && props.onAnswer(current.job, text)} onReply={text => current.job && props.onReply(current.job, text)}
          onSettle={() => current.job && props.onSettle(current.job)} onSnooze={until => current.job && props.onSnooze(current.job, until)} />
          : <form className="assistants-start" onSubmit={event => void start(event)}>
            <p>{assistant.available
              ? assistant.id === "fox" ? "Ask Fox anything. Questions come back to your Inbox." : "Hand Hermes a request. It picks it up within a minute."
              : `${assistant.name} is not configured on this server.`}</p>
            <div className="thread-composer">
              <label className="sr-only" htmlFor="assistant-start">Message {assistant.name}</label>
              <textarea id="assistant-start" rows={3} value={draft} maxLength={2_000} disabled={!assistant.available}
                onChange={event => setDraft(event.target.value)} placeholder={`Message ${assistant.name}…`}
                onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
              <button className="submit-button" type="submit" disabled={!draft.trim() || !assistant.available || props.busyKey !== null}><CornerDownLeft size={13} /> Send</button>
            </div>
            {composing ? <button className="pane-link" type="button" onClick={() => setComposing(false)}>Back to the current thread</button> : null}
          </form>}
      </div>
      <aside className="assistants-side" aria-label={`${assistant.name} details`}>
        <nav className="assistants-tabs" aria-label="Assistant details">
          <button type="button" aria-pressed={tab === "threads"} onClick={() => setTab("threads")}>Threads</button>
          {assistant.id === "hermes" ? <button type="button" aria-pressed={tab === "routines"} onClick={() => setTab("routines")}>Routines</button> : null}
          <button type="button" aria-pressed={tab === "permissions"} onClick={() => setTab("permissions")}>Can do</button>
        </nav>
        {tab === "threads" ? <ul className="assistants-thread-list">
          {own.slice(0, 12).map(thread => <li key={thread.key}>
            <button type="button" onClick={() => props.onOpenThread(thread)}>
              <strong>{thread.title}</strong>
              <span className={`thread-status thread-status--${thread.shelf === "active" ? thread.tone : "quiet"}`}>{thread.shelf === "active" ? thread.status : thread.shelf === "snoozed" ? "Snoozed" : "Settled"}</span>
            </button>
          </li>)}
          {!own.length ? <li className="thread-empty">No threads yet.</li> : null}
        </ul> : null}
        {tab === "routines" && assistant.id === "hermes" ? <ul className="assistants-routines">
          {routines.map(routine => {
            const enabled = routineField(routine.summary, "Enabled");
            const lastRun = routineField(routine.summary, "Last run");
            const state = enabled === "False" ? "off" : lastRun && lastRun !== "ok" && lastRun !== "never run" ? "bad" : "ok";
            return <li key={routine.id}>
              <i className={`routine-dot routine-dot--${state}`} aria-hidden />
              <span><strong>{routine.title.replace(/^Hermes: /, "")}</strong>
                <small>{[routineField(routine.summary, "Schedule"), enabled === "False" ? "paused" : lastRun ? `last run ${lastRun}` : null].filter(Boolean).join(" · ")} · {relativeTime(routine.updatedAt)}</small></span>
            </li>;
          })}
          {!routines.length ? <li className="thread-empty">No routines reported.</li> : null}
        </ul> : null}
        {tab === "permissions" ? <ul className="assistants-permissions">
          {CAPABILITIES[assistant.id].map(capability => <li key={capability.label}>
            <span>{capability.label}</span>
            <b className={`permission permission--${capability.level}`}>{capability.level === "allowed" ? "allowed" : capability.level === "asks" ? "asks you" : "never"}</b>
          </li>)}
        </ul> : null}
      </aside>
    </div>
  </section>;
}
