import { useState } from 'react';
import { dublinDateKey, dublinDateTimeToInstant, dublinTimeValue, formatDublinDateKey } from './calendar-time.ts';
import { DEFAULT_INBOX_GRACE_MINUTES, inboxExpiry } from './inbox-time.ts';
import type { InboxExpiryRule, InboxItem } from './model.ts';

function formatInstant(instant: string) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
}

export function InboxTiming({ item, onSave }: { item: InboxItem; onSave: (rule: InboxExpiryRule) => void }) {
  const [enabled, setEnabled] = useState(item.expiryRule?.enabled ?? true);
  const [dateTime, setDateTime] = useState(item.expiryRule?.at ? `${dublinDateKey(new Date(item.expiryRule.at))}T${dublinTimeValue(item.expiryRule.at)}` : '');
  const [hours, setHours] = useState(String((item.expiryRule?.graceMinutes ?? DEFAULT_INBOX_GRACE_MINUTES) / 60));
  const [destination, setDestination] = useState<InboxExpiryRule['destination']>(item.expiryRule?.destination ?? 'history');
  const [error, setError] = useState('');
  const context = item.sourceContext;
  const expiry = inboxExpiry(item);
  const sourceExpiry = context?.timing === 'confirmed' ? context.expiresAt ?? context.endsAt : undefined;
  const times = [
    context?.startsAt ? `Starts ${formatInstant(context.startsAt)}` : null,
    context?.endsAt ? `Ends ${formatInstant(context.endsAt)}` : null,
    context?.dueAt ? `Due ${formatInstant(context.dueAt)}` : context?.dueOn ? `Due ${formatDublinDateKey(context.dueOn, { day: 'numeric', month: 'short' })}` : null,
  ].filter(Boolean);
  function save() {
    const at = dateTime ? dublinDateTimeToInstant(dateTime.slice(0, 10), dateTime.slice(11)) : null;
    const graceMinutes = Number(hours) * 60;
    if (enabled && dateTime && !at) { setError('Choose a valid Dublin time. Repeated or skipped clock-change times need another time.'); return; }
    if (enabled && !at && !sourceExpiry) { setError('Set an expiry time, or turn off automatic moving. A deadline alone is not an expiry.'); return; }
    if (!hours.trim() || !Number.isSafeInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 43_200) { setError('Choose a grace period between 0 and 720 hours, in whole minutes.'); return; }
    setError('');
    onSave({ enabled, ...(at ? { at } : {}), graceMinutes, destination });
  }
  return <div className="inbox-timing">
    {times.length ? <p className="inbox-source-times">{times.join(' · ')} <span>{context?.timing === 'suggested' ? 'Suggested · check source' : 'Dublin time'}</span></p> : null}
    {item.expiryApplied ? <p className="review-note-hint">Moved to {item.expiryApplied.destination === 'history' ? 'History' : 'Automations'} automatically on {formatInstant(item.expiryApplied.at)}.</p> : expiry ? <p className="review-note-hint">Moves to {expiry.destination === 'history' ? 'History' : 'Automations'} on {formatInstant(expiry.moveAt)}.</p> : null}
    <details className="inbox-expiry-options"><summary>Timing &amp; expiry</summary>
      {context ? <p className="review-note-hint">Source: {context.provider} · {context.externalId}{context.evidence ? ` · ${context.evidence}` : ''}</p> : <p className="review-note-hint">No source timing supplied. You can set an expiry manually.</p>}
      <label className="inbox-expiry-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Move after expiry</label>
      <div className="inbox-expiry-fields">
        <label>Expiry in Dublin<input type="datetime-local" value={dateTime} disabled={!enabled} onChange={event => setDateTime(event.target.value)} /></label>
        <label>Grace period, hours<input type="number" min="0" max="720" step="any" value={hours} disabled={!enabled} onChange={event => setHours(event.target.value)} /></label>
        <label>Move to<select aria-label="Move to" value={destination} disabled={!enabled} onChange={event => { if (event.target.value === 'history' || event.target.value === 'automation') setDestination(event.target.value); }}><option value="history">History</option><option value="automation">Automations</option></select></label>
      </div>
      {sourceExpiry ? <p className="review-note-hint">Leave expiry blank to follow the source: {formatInstant(sourceExpiry)}.</p> : null}
      {error ? <p className="workspace-alert" role="alert">{error}</p> : null}
      <button type="button" className="secondary-action" onClick={save}>Save expiry rule</button>
    </details>
  </div>;
}
