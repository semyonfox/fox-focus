import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emailSendBlocksInboxMutation,
  emailSendUiState,
  preferredTaskDestination,
  type TaskDestination,
} from '../src/inbox-client.ts';
import type { ActionRow, DraftRevision, InboxItemRow, ReplyEnvelope } from '../src/row-model.ts';

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
