import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  briefingReminderSuggestion,
  dublinInstantLocalValue,
  dublinLocalReminderInstant,
  emailSendBlocksInboxMutation,
  emailSendUiState,
  preferredTaskDestination,
  type TaskDestination,
} from '../src/inbox-client.ts';
import type { ActionRow, BriefingEntry, DraftRevision, InboxItemRow, ReplyEnvelope } from '../src/row-model.ts';

const NOW = '2026-09-14T10:00:00.000Z';

function reply(): ReplyEnvelope {
  return {
    accountId: 'owner@example.test', threadId: 'thread-1', replyToMessageId: 'message-1',
    inReplyTo: '<message-1@example.test>', references: ['<root@example.test>'],
    from: 'owner@example.test', to: ['sender@example.test'], cc: [], bcc: [],
    subject: 'Re: Update', bodyText: 'Thanks.',
  };
}

function emailItem(): InboxItemRow {
  return {
    id: 'inbox-1', version: 2,
    source: { kind: 'email', accountId: 'owner@example.test', messageId: 'message-1', threadId: 'thread-1' },
    title: 'Update', summary: 'A short update.', state: 'open', outcome: null, taskId: null,
    currentDraftId: 'draft-1', likelyNoise: false, snoozedUntil: null, createdAt: NOW, updatedAt: NOW,
  };
}

function draft(): DraftRevision {
  return { id: 'draft-1', inboxId: 'inbox-1', revision: 1, author: 'owner', reply: reply(), createdAt: NOW };
}

function sendAction(state: ActionRow['state']): ActionRow {
  return {
    id: `send-${state}`, version: 1,
    payload: { kind: 'email-send', inboxId: 'inbox-1', draftId: 'draft-1', reply: reply(), payloadHash: 'x'.repeat(43) },
    operationKey: 'email-send:draft-1', requestHash: 'request-hash',
    approval: { actor: 'owner', at: NOW, previewText: 'Exact reply envelope' },
    state, attemptCount: 0, nextAttemptAt: null, claimId: null, leaseUntil: null,
    receipt: null, error: null, createdAt: NOW, updatedAt: NOW,
  };
}

function destination(
  listId: string,
  area: TaskDestination['area'],
  options: { explicitMapping?: boolean; isFallback?: boolean } = {},
): TaskDestination {
  return {
    accountId: 'google-account',
    listId,
    listName: listId,
    area,
    explicitMapping: options.explicitMapping ?? false,
    isFallback: options.isFallback ?? false,
  };
}

test('task creation defaults only to a unique explicit area mapping or My Tasks', () => {
  const fallback = destination('my-tasks', 'Personal', { isFallback: true });
  const university = destination('university', 'University', { explicitMapping: true });
  const inferred = destination('inferred-work', 'Work');

  assert.equal(preferredTaskDestination([fallback, university, inferred], 'University')?.listId, 'university');
  assert.equal(preferredTaskDestination([fallback, university, inferred], 'Work')?.listId, 'my-tasks');
  assert.equal(preferredTaskDestination([university, inferred], 'Work'), null);
  assert.equal(preferredTaskDestination([
    university,
    destination('university-two', 'University', { explicitMapping: true }),
    fallback,
  ], 'University')?.listId, 'my-tasks');
});

test('Dublin reminder inputs resolve only unambiguous wall times across DST boundaries', () => {
  assert.equal(dublinLocalReminderInstant('2026-03-29T00:30'), '2026-03-29T00:30:00.000Z');
  assert.equal(dublinLocalReminderInstant('2026-03-29T02:30'), '2026-03-29T01:30:00.000Z');
  assert.equal(dublinLocalReminderInstant('2026-03-29T01:30'), null);
  assert.equal(dublinLocalReminderInstant('2026-10-25T01:30'), null);
  assert.equal(dublinLocalReminderInstant('2026-10-25T02:30'), '2026-10-25T02:30:00.000Z');
  assert.equal(dublinLocalReminderInstant('2026-02-30T10:00'), null);
});

test('exact source instants retain their fold when Dublin repeats a wall time', () => {
  assert.deepEqual(dublinInstantLocalValue('2026-10-25T00:30:00.000Z'), {
    localValue: '2026-10-25T01:30',
    instant: '2026-10-25T00:30:00.000Z',
  });
  assert.deepEqual(dublinInstantLocalValue('2026-10-25T01:30:00.000Z'), {
    localValue: '2026-10-25T01:30',
    instant: '2026-10-25T01:30:00.000Z',
  });
  assert.equal(dublinInstantLocalValue('2026-10-25T01:30:00+01:00'), null);
});

test('briefing actions suggest one hour before an event and reject a too-late default', () => {
  const now = new Date('2026-09-14T10:00:00.000Z');
  const entry = (startsAt: string | null): BriefingEntry => ({
    kind: startsAt ? 'event' : 'news',
    title: 'Briefing item',
    summary: '',
    url: null,
    startsAt,
  });

  assert.deepEqual(briefingReminderSuggestion(entry('2026-09-14T14:00:00.000Z'), now), {
    localValue: '2026-09-14T14:00',
    fireAt: '2026-09-14T13:00:00.000Z',
  });
  assert.equal(briefingReminderSuggestion(entry('2026-09-14T10:03:00.000Z'), now), null);
  assert.deepEqual(briefingReminderSuggestion(entry(null), now), {
    localValue: '2026-09-14T12:00',
    fireAt: '2026-09-14T11:00:00.000Z',
  });
});

test('briefing reminders preserve the exact instant through the repeated Dublin hour', () => {
  const suggestion = briefingReminderSuggestion({
    kind: 'event', title: 'Clock-change event', summary: '', url: null,
    startsAt: '2026-10-25T01:30:00.000Z',
  }, new Date('2026-10-24T12:00:00.000Z'));

  assert.deepEqual(suggestion, {
    localValue: '2026-10-25T01:30',
    fireAt: '2026-10-25T00:30:00.000Z',
  });
  assert.equal(dublinLocalReminderInstant(suggestion.localValue), null);
});

test('email send controls distinguish disabled, sending, unknown, failed, and sent states', () => {
  const item = emailItem();
  const currentDraft = draft();

  assert.equal(emailSendUiState(item, currentDraft, undefined, false), 'disabled');
  assert.equal(emailSendUiState(item, currentDraft, undefined, true), 'ready');
  assert.equal(emailSendUiState(item, currentDraft, sendAction('queued'), true), 'sending');
  assert.equal(emailSendUiState(item, currentDraft, sendAction('running'), true), 'sending');
  assert.equal(emailSendUiState(item, currentDraft, { ...sendAction('running'), attemptCount: 2 }, true), 'reconciling');
  assert.equal(emailSendUiState(item, currentDraft, sendAction('unknown'), true), 'unknown');
  assert.equal(emailSendUiState(item, currentDraft, sendAction('failed'), true), 'failed');
  assert.equal(emailSendUiState(
    { ...item, currentDraftId: 'draft-2' },
    { ...currentDraft, id: 'draft-2', revision: 2 },
    sendAction('failed'),
    true,
  ), 'ready');
  assert.equal(emailSendUiState({ ...item, state: 'resolved', outcome: 'sent' }, currentDraft, sendAction('succeeded'), true), 'sent');

  assert.equal(emailSendBlocksInboxMutation(sendAction('queued')), true);
  assert.equal(emailSendBlocksInboxMutation(sendAction('unknown')), true);
  assert.equal(emailSendBlocksInboxMutation(sendAction('failed')), false);
});
