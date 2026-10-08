import type { InboxItem, InboxProposalContext } from './model.ts';
import type { InboxItemRow } from './row-model.ts';
import { isUniversityWork } from './workspace-rules.ts';
import { normalizeInboxSourceContext } from './inbox-time.ts';

export function normalizeInboxProposalContext(input: InboxProposalContext): InboxProposalContext {
  return {
    ...(input.lane ? { lane: input.lane } : {}),
    ...(input.recommendation ? { recommendation: {
      outcome: input.recommendation.outcome, reason: input.recommendation.reason, nextStep: input.recommendation.nextStep,
    } } : {}),
    ...(input.existingHermesTaskId ? { existingHermesTaskId: input.existingHermesTaskId } : {}),
    ...(input.sourceContext ? { sourceContext: normalizeInboxSourceContext(input.sourceContext) } : {}),
  };
}

// local review decisions belong to the exact row, independently of execution state
export function reviewItemFromRow(row: InboxItemRow, existing?: InboxItem): InboxItem {
  return {
    ...existing,
    id: row.id,
    title: row.title,
    summary: row.summary,
    source: row.source.kind === 'email' ? `Email · ${row.source.accountId}` : row.source.kind === 'hermes' ? 'Hermes' : 'Capture',
    actor: row.source.kind === 'capture' ? 'You' : 'Hermes',
    accent: existing?.accent ?? (isUniversityWork(row.title, row.summary) ? 'University' : 'Personal'),
    status: existing?.status ?? (row.state === 'resolved' ? 'handled' : row.state === 'waiting' ? 'waiting-on-agent' : 'new'),
  };
}
