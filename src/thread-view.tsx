import { useState, type FormEvent } from "react";
import { AlarmClock, Check, CircleDashed, CornerDownLeft } from "lucide-react";
import type { Job, ThreadEntry } from "./row-model.ts";
import { assistantName, relativeTime } from "./work-threads.ts";
import { assistantInitial, snoozePresets } from "./thread-sidebar.tsx";

export type ThreadViewProps = {
  job: Job;
  entries: ThreadEntry[] | null;
  busy: boolean;
  onAnswer: (text: string) => void;
  onReply: (text: string) => void;
  onSettle: () => void;
  onSnooze: (until: string | null) => void;
  compact?: boolean;
};

export function ThreadView({ job, entries, busy, onAnswer, onReply, onSettle, onSnooze, compact }: ThreadViewProps) {
  const [draft, setDraft] = useState("");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const hermes = job.assistant === "hermes";
  const waiting = job.state === "needs_you";
  const working = job.state === "queued" || job.state === "working";
  const lastQuestionSeq = waiting ? entries?.filter(entry => entry.kind === "question").at(-1)?.seq ?? null : null;
  const canSnooze = job.state !== "settled";
  const limit = hermes ? 280 : 4_000;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    if (waiting) onAnswer(text);
    else onReply(text);
    setDraft("");
  }

  return <section className={`thread-view${compact ? " thread-view--compact" : ""}`} aria-label={job.title}>
    {compact ? null : <header className="thread-view-head">
      <span className={`thread-avatar thread-avatar--${job.assistant}`} aria-hidden>{assistantInitial(job.assistant)}</span>
      <h2 tabIndex={-1}>{job.title}</h2>
      <small>{assistantName(job.assistant)} · {relativeTime(job.updatedAt)}</small>
      <span className="thread-view-actions">
        {canSnooze ? <span className="thread-view-snooze">
          <button className="secondary-action" type="button" aria-expanded={snoozeOpen} onClick={() => setSnoozeOpen(open => !open)}><AlarmClock size={13} /> Snooze</button>
          {snoozeOpen ? <span className="thread-snooze-menu" role="menu">
            {snoozePresets(new Date()).map(preset => <button key={preset.id} type="button" role="menuitem" onClick={() => { setSnoozeOpen(false); onSnooze(preset.until); }}>{preset.label}</button>)}
            {job.snoozedUntil ? <button type="button" role="menuitem" onClick={() => { setSnoozeOpen(false); onSnooze(null); }}>Wake now</button> : null}
          </span> : null}
        </span> : null}
        {job.state === "review" ? <button className="page-primary-action" type="button" disabled={busy} onClick={onSettle}><Check size={13} /> Settle <kbd>e</kbd></button> : null}
      </span>
    </header>}
    <div className="thread-messages">
      {entries === null ? <p className="thread-note">Loading the thread…</p> : null}
      {entries?.map((entry, index) => {
        if (entry.kind === "activity") return <p className="thread-activity" key={`${entry.seq}:${index}`}>{entry.text}</p>;
        if (entry.kind === "question") {
          const live = entry.seq === lastQuestionSeq;
          return <div className={`thread-ask${live ? " thread-ask--live" : ""}`} key={`${entry.seq}:${index}`}>
            <span className="thread-ask-label">{assistantName(job.assistant)} is asking</span>
            <p>{entry.text}</p>
            {entry.options.length ? <div className="thread-choices">
              {entry.options.map(option => <button key={option} type="button" className="secondary-action" disabled={!live || busy} onClick={() => onAnswer(option)}>{option}</button>)}
            </div> : null}
          </div>;
        }
        return <div className={`thread-bubble thread-bubble--${entry.role}`} key={`${entry.seq}:${index}`}>
          <p>{entry.text}</p>
          {entry.url ? <a href={entry.url} target="_blank" rel="noreferrer">Open result</a> : null}
        </div>;
      })}
      {working ? <p className="thread-activity thread-activity--live"><CircleDashed size={12} aria-hidden /> {job.state === "queued" ? "Queued" : `${assistantName(job.assistant)} is working`}</p> : null}
      {job.state === "review" && job.resultKind === "failed" ? <p className="thread-failure">{job.resultNote ?? "This run failed."}</p> : null}
    </div>
    <form className="thread-composer" onSubmit={submit}>
      <label className="sr-only" htmlFor={`thread-reply-${job.id}`}>{waiting ? "Answer" : "Reply"}</label>
      {hermes
        ? <input id={`thread-reply-${job.id}`} value={draft} maxLength={limit} disabled={working || busy} onChange={event => setDraft(event.target.value)}
            placeholder={working ? "Hermes is working…" : waiting ? "Answer in one line" : "Reply in one line to send it back"} />
        : <textarea id={`thread-reply-${job.id}`} value={draft} maxLength={limit} disabled={working || busy} rows={2}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
            placeholder={working ? "Fox is working…" : waiting ? "Or answer in your own words" : job.state === "settled" ? "Reply to reopen" : "Reply, or say we're done"} />}
      <button className="submit-button" type="submit" disabled={!draft.trim() || working || busy}><CornerDownLeft size={13} /> Send</button>
    </form>
  </section>;
}
