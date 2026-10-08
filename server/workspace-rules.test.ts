import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboxLane, importedTaskArea, localTaskArea, suggestReview } from '../src/workspace-rules.ts';
import { isInboxItem, isTask, type InboxItem, type Task } from '../src/model.ts';

const item: InboxItem = { id: 'one', title: 'Hermes: hourly cache cleanup', summary: 'Routine job status.', source: 'Hermes', actor: 'Hermes', status: 'new', accent: 'Admin' };
const task: Task = { id: 'task', title: 'Complete CT3531 VLAN assignment', area: 'Personal', state: 'up-next', duration: '30 min', due: 'No deadline', priority: 'medium', completed: false, scheduledTime: null, origin: 'migration', source: 'Google Tasks' };

test('university evidence survives generic Google list names and legacy adoption defaults', () => {
  assert.equal(localTaskArea(task), 'University');
  assert.equal(localTaskArea({ ...task, title: 'Read chapter', source: 'Hermes · Canvas' }), 'University');
  assert.equal(localTaskArea({ ...task, areaOverride: true }), 'Personal');
  assert.equal(localTaskArea({ ...task, origin: 'manual', source: undefined }), 'Personal');
  assert.equal(importedTaskArea(undefined, { provider: 'google', containerId: 'personal', containerName: 'Personal', title: 'Draft report', notes: 'From Canvas assignment 42' }), 'University');
  assert.equal(importedTaskArea({}, { provider: 'google', containerId: 'p', containerName: 'Personal', title: 'CT318 assignment' }), 'University');
  assert.equal(importedTaskArea({ 'google:id:p': 'Work' }, { provider: 'google', containerId: 'p', containerName: 'Personal', title: 'Client follow-up' }), 'Work');
  assert.equal(importedTaskArea({}, { provider: 'google', containerId: 'p', containerName: 'Canvas', title: 'Read chapter' }), 'University');
  assert.equal(localTaskArea({ ...task, title: 'Paint a canvas' , origin: 'manual' }), 'Personal');
});

test('routine jobs leave the review count without hiding requests for a decision', () => {
  assert.equal(inboxLane(item), 'automation');
  assert.equal(inboxLane({ ...item, title: 'Hermes: Camille incremental email triage' }), 'automation');
  assert.equal(inboxLane({ ...item, title: 'Hermes: Watch Web Summit 2026 schedule' }), 'automation');
  assert.equal(inboxLane({ ...item, summary: 'Approval required before changing the schedule.' }), 'review');
  assert.equal(inboxLane({ ...item, lane: 'review' }), 'review');
  assert.equal(inboxLane({ ...item, actor: 'Me', source: 'Capture' }), 'review');
  assert.equal(inboxLane({ ...item, title: 'Check a conference invitation' }), 'review');
  assert.equal(item.status, 'new');
});

test('review decisions validate and retain proposals without inventing an existing-task match', () => {
  const decision = { outcome: 'proposed-commitment', note: 'Check next week.', savedAt: '2026-10-07T12:00:00.000Z' };
  assert.equal(isInboxItem({ ...item, reviewDecision: decision }), true);
  assert.equal(isInboxItem({ ...item, reviewDecision: { ...decision, outcome: 'automatically-approved' } }), false);
  assert.equal(isInboxItem({ ...item, lane: 'missing' }), false);
  assert.equal(isTask({ ...task, areaOverride: true }), true);
  assert.equal(isTask({ ...task, areaOverride: 'true' }), false);
  assert.equal(suggestReview(item, true).outcome, 'existing-task-update');
  assert.equal(suggestReview({ ...item, title: 'An invitation', existingHermesTaskId: 'unverified' }).outcome, 'needs-decision');
});
