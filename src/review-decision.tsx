import { useEffect, useState } from 'react';
import { type InboxItem, type ReviewOutcome, reviewOutcomes, isOneOf } from './model.ts';
import type { HermesTask } from './hermes-model.ts';
import { suggestReview } from './workspace-rules.ts';

export const reviewOutcomeLabels: Record<ReviewOutcome, string> = {
  'noise-reference': 'Noise / reference', awareness: 'Awareness',
  'proposed-commitment': 'Proposed commitment', 'existing-task-update': 'Existing-task update', 'needs-decision': 'Needs decision',
};

export function ReviewDecision({ item, existingTask, onSave, onDismiss }: {
  item: InboxItem; existingTask?: HermesTask; onSave: (outcome: ReviewOutcome, note: string) => void; onDismiss: () => void;
}) {
  const suggestion = suggestReview(item, Boolean(existingTask));
  const [outcome, setOutcome] = useState<ReviewOutcome>(item.reviewDecision?.outcome ?? suggestion.outcome);
  const [note, setNote] = useState(item.reviewDecision?.note ?? '');
  useEffect(() => {
    setOutcome(item.reviewDecision?.outcome ?? suggestion.outcome);
    setNote(item.reviewDecision?.note ?? '');
  }, [item.id, item.reviewDecision, suggestion.outcome]);

  return <div className="review-decision">
    <div className="review-suggestion">
      <span className="review-suggestion-label">Suggested</span>
      <strong>{reviewOutcomeLabels[suggestion.outcome]}</strong>
      <p>{suggestion.reason}</p>
    </div>
    <p className="review-next-question">{suggestion.nextStep}</p>
    {existingTask ? <details className="review-existing-task"><summary>Personal Tasks · {existingTask.title}</summary><p>Task {existingTask.id} · {existingTask.status}</p><p>{existingTask.source}</p></details> : item.existingHermesTaskId ? <p className="review-note-hint">The supplied task reference could not be verified.</p> : null}
    <details className="review-adjustment"><summary>Change outcome</summary>
    <div className="review-decision-controls">
      <label className="review-outcome-field" htmlFor="review-outcome"><span>Your decision</span><select id="review-outcome" value={outcome} onChange={event => { const value = event.target.value; if (isOneOf(value, reviewOutcomes)) setOutcome(value); }}>{reviewOutcomes.map(value => <option key={value} value={value}>{reviewOutcomeLabels[value]}</option>)}</select></label>
    </div>
    </details>
    <details className="review-note" key={item.id} >
      <summary>{item.reviewDecision?.note ? 'Review note' : 'Add a note'}</summary>
      <label className="review-note-label" htmlFor="review-reason">Review note</label>
      <textarea id="review-reason" value={note} onChange={event => setNote(event.target.value)} placeholder="What matters, or what still needs checking…" maxLength={2000} />
    </details>
    <div className="review-hermes"><button type="button" className="secondary-action" disabled title="Hermes chat is not connected">Ask Hermes</button><span>Chat not connected</span></div>
    <div className="review-decision-footer">
      <button type="button" className="page-primary-action" onClick={() => onSave(outcome, note.trim())}>{item.reviewDecision ? 'Save decision' : 'Accept'}</button>
      <button type="button" className="secondary-action" onClick={onDismiss}>{item.status === 'handled' ? 'Return to review' : 'Dismiss'}</button>
      <span>{item.reviewDecision ? 'Saved locally' : 'Saves your decision only'}</span>
    </div>
  </div>;
}
