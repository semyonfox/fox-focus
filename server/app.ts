import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { areas, isOneOf, isPrototypeData, isRecord } from '../src/model.ts';
import { isDateKey } from '../src/calendar-time.ts';
import { isHermesCompletionInput, isHermesTaskAnnotationInput } from '../src/hermes-model.ts';
import {
  isBriefingUpsertInput,
  isEmailSendApprovalInput,
  isEmailSendReceiptInput,
  isHermesInboxUpsertInput,
  isInboxDecisionInput,
  isJobAnswerInput,
  isJobInstruction,
  isJobResultInput,
  isJobSendBackInput,
  isJobSettleInput,
  isReplyEnvelope,
  isTaskMigrationApprovalInput,
  isTaskPlanInput,
  isTaskCreateInput,
  isTaskStatusInput,
  taskCreateNotes,
} from '../src/row-model.ts';
import { isPushSubscription } from './push.ts';
import type { Store } from './store.ts';
import { HermesServiceError, type HermesMirrorService } from './hermes.ts';
import type { IntegrationOverview, IntegrationService } from './integrations.ts';
import { canonicalHash } from './row-store.ts';
import {
  buildTaskMigrationPreview,
  migrationIdForIdempotencyKey,
  summarizeTaskMigration,
} from './task-migration.ts';
import {
  TaskManagementError,
  adoptionSourceStillMatches,
  adoptedTaskIdForHermes,
  adoptedTaskIdForRecord,
  previewHermesTaskAdoption,
  previewProviderTaskAdoption,
  previewTaskAction,
  taskStatusProjection,
} from './task-management.ts';

const emptyIntegrations: IntegrationOverview = {
  providers: (['google', 'microsoft'] as const).map(provider => ({
    provider,
    displayName: provider === 'google' ? 'Google' : 'Microsoft',
    configured: false,
    connection: null,
    sync: { provider, state: 'idle', startedAt: null, completedAt: null, recordCount: 0, lastError: null },
    calendarEventCount: 0,
    taskCount: 0,
  })),
  records: [],
};

function providerFrom(value: string): 'google' | 'microsoft' | null {
  return value === 'google' || value === 'microsoft' ? value : null;
}

export type AppOptions = {
  pushPublicKey?: string;
  taskStatusToken?: string;
  emailSendEnabled?: boolean;
  now?: () => Date;
  actionWorker?: { kick: () => void };
};

function tokenMatches(value: string, expected: string): boolean {
  const supplied = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function isHermesApiRequest(method: string, path: string): boolean {
  return (method === 'GET' && (path === '/api/v1/context' || path === '/api/v1/changes')) ||
    (method === 'PUT' && /^\/api\/v1\/inbox\/[^/]+$/.test(path)) ||
    (method === 'PUT' && /^\/api\/v1\/briefings\/\d{4}-\d{2}-\d{2}$/.test(path)) ||
    (method === 'POST' && /^\/api\/v1\/requests\/[^/]+\/(?:claim|result)$/.test(path));
}

function taskManagementStatus(error: TaskManagementError): 404 | 409 | 422 {
  if (error.code === 'not_found') return 404;
  if (error.code === 'already_adopted' || error.code === 'action_in_progress' || error.code === 'idempotency_conflict') return 409;
  return 422;
}

export function createApp(
  store: Store,
  password: string,
  hermes?: HermesMirrorService,
  integrations?: IntegrationService,
  options: AppOptions = {},
) {
  // Existing self-hosted workspaces accepted eight-character passwords. Keep
  // those installations bootable; new passwords are still generated at 43
  // characters and the operator guidance requires at least 24.
  if (password.length < 8) throw new Error('Workspace password must have at least 8 characters');
  if (options.taskStatusToken !== undefined && options.taskStatusToken.length < 24) {
    throw new Error('Hermes API token must have at least 24 characters');
  }
  const now = options.now ?? (() => new Date());
  const emailSendEnabled = options.emailSendEnabled === true;
  const app = new Hono();
  app.use('*', secureHeaders());
  const auth = basicAuth({ username: 'fox', password, realm: 'Fox Focus workspace' });
  app.use('/', auth);
  app.use('/app', auth);
  app.use('/app/*', auth);
  app.use('/sw.js', auth);
  app.use('/manifest.webmanifest', auth);
  app.use('/api/*', async (c, next) => {
    const authorization = c.req.header('Authorization') ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (isHermesApiRequest(c.req.method, c.req.path) && options.taskStatusToken && tokenMatches(bearer, options.taskStatusToken)) {
      await next();
      return;
    }
    return auth(c, next);
  });
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // Browser mutations must originate on this origin. Agents use Basic auth
    // without an Origin header. No permissive CORS or cookie-only write path.
    const origin = c.req.header('Origin');
    const host = c.req.header('Host');
    if (!['GET', 'HEAD'].includes(c.req.method) && origin) {
      try {
        if (new URL(origin).host !== host) return c.json({ error: 'Cross-origin writes are not allowed' }, 403);
      } catch { return c.json({ error: 'Invalid origin' }, 403); }
    }
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 512 * 1024 }));
  app.get('/healthz', (c) => c.json({ ok: true, mode: 'workspace' }));
  app.get('/app', (c) => c.redirect('/', 302));
  app.get('/api/v1/workspace', (c) => c.json(store.read()));
  app.get('/api/v1/rows', (c) => c.json({
    capabilities: { emailSendEnabled },
    tasks: store.listTasks(),
    taskPlans: store.listTaskPlans(),
    inbox: store.listInboxItems(),
    drafts: store.listDrafts(),
    jobs: store.listJobs(),
    jobUpdates: store.listJobUpdates(),
    actions: store.listActions(),
    reminders: store.listReminders(),
    briefings: store.listBriefings(),
    freshness: store.listSyncStates(),
  }));
  app.get('/api/v1/context', (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!from || !to || !isDateKey(from) || !isDateKey(to) || from > to) {
      return c.json({ error: 'A valid from and to date are required' }, 400);
    }
    return c.json(store.readContext(from, to, now().toISOString()));
  });
  app.get('/api/v1/changes', (c) => {
    const afterText = c.req.query('after') ?? '0';
    const limitText = c.req.query('limit') ?? '100';
    if (!/^\d+$/.test(afterText) || !/^\d+$/.test(limitText)) return c.json({ error: 'Invalid change cursor' }, 400);
    const after = Number(afterText);
    const limit = Number(limitText);
    if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      return c.json({ error: 'Invalid change cursor' }, 400);
    }
    const page = store.listChanges(after, limit);
    return page.resetRequired ? c.json({ error: 'Change cursor expired', resetRequired: true, cursor: page.cursor }, 410) : c.json(page);
  });
  app.put('/api/v1/briefings/:day', async (c) => {
    const day = c.req.param('day');
    if (!isDateKey(day)) return c.json({ error: 'Invalid briefing day' }, 400);
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isBriefingUpsertInput(body)) return c.json({ error: 'Invalid briefing' }, 400);
    const result = store.upsertBriefing(day, body, now().toISOString());
    if (result.outcome === 'conflict') {
      return c.json({ error: 'Briefing changed', current: result.current }, 409);
    }
    if (result.outcome === 'expired') {
      return c.json({ error: 'Briefing expiry must be in the future', current: result.current }, 400);
    }
    return c.json({ outcome: result.outcome, briefing: result.briefing }, result.outcome === 'created' ? 201 : 200);
  });
  app.put('/api/v1/inbox/:proposalKey', async (c) => {
    const proposalKey = c.req.param('proposalKey');
    if (!proposalKey || proposalKey.length > 200 || /[\r\n]/.test(proposalKey)) {
      return c.json({ error: 'Invalid proposal key' }, 400);
    }
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isHermesInboxUpsertInput(body)) return c.json({ error: 'Invalid Inbox upsert' }, 400);
    const input = {
      expectedVersion: body.expectedVersion,
      source: body.source,
      title: body.title.trim(),
      summary: body.summary,
      likelyNoise: body.likelyNoise,
      ...(body.draft === undefined ? {} : { draft: body.draft }),
    };
    const result = store.upsertHermesInbox(proposalKey, canonicalHash(input), input, now().toISOString());
    if (result.outcome === 'invalid_draft') {
      return c.json({ error: 'Draft identity does not match the Inbox source', current: result.item }, 400);
    }
    if (result.outcome === 'conflict') {
      const error = result.reason === 'idempotency'
        ? 'That proposal key was used for different content'
        : result.reason === 'source'
          ? 'The email thread identity changed'
          : 'Inbox item changed';
      return c.json({ error, reason: result.reason, current: result.item }, 409);
    }
    return c.json({
      outcome: result.outcome,
      item: result.item,
      draft: result.draft,
      draftOutcome: result.draftOutcome,
    }, result.outcome === 'created' ? 201 : 200);
  });
  app.post('/api/v1/requests/:id/claim', (c) => {
    const id = c.req.param('id');
    if (!id || id.length > 200) return c.json({ error: 'Invalid request ID' }, 400);
    const claimedAt = now().toISOString();
    if (store.getJob(id)) {
      const result = store.claimJob(id, claimedAt, 120_000);
      if (result.outcome === 'not_found') return c.json({ error: 'Request not found' }, 404);
      if (result.outcome === 'unavailable') {
        return c.json({ error: 'Request is not available to claim', current: result.job }, 409);
      }
      return c.json({
        kind: 'job',
        job: result.job,
        claimId: result.claimId,
        leaseUntil: result.job.leaseUntil,
      });
    }
    const result = store.claimEmailSendAction(id, claimedAt, 120_000, emailSendEnabled);
    if (result.outcome === 'not_found') return c.json({ error: 'Request not found' }, 404);
    if (result.outcome === 'disabled') {
      return c.json({ error: 'Email sending is disabled', current: result.action }, 503);
    }
    if (result.outcome === 'unavailable') {
      return c.json({ error: 'Request is not available to claim', current: result.action }, 409);
    }
    if (!('mode' in result)) return c.json({ error: 'Request claim failed' }, 409);
    return c.json({
      kind: 'email-send',
      action: result.action,
      mode: result.mode,
      claimId: result.claimId,
      leaseUntil: result.action.leaseUntil,
    });
  });
  app.post('/api/v1/requests/:id/result', async (c) => {
    const id = c.req.param('id');
    const claimId = c.req.header('X-Claim-Id') ?? '';
    if (!id || id.length > 200 || !claimId || claimId.length > 200) {
      return c.json({ error: 'A valid request and claim ID are required' }, 400);
    }
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (isJobResultInput(body)) {
      const result = store.postJobResult(id, claimId, body, now().toISOString(), 120_000);
      if (result.outcome === 'not_found') return c.json({ error: 'Request not found' }, 404);
      if (result.outcome === 'invalid_claim') {
        return c.json({ error: 'Claim is invalid or expired', current: result.job }, 409);
      }
      if (result.outcome === 'invalid_state') {
        return c.json({ error: 'Request is not working', current: result.job }, 409);
      }
      if (!('update' in result)) return c.json({ error: 'Request result failed' }, 409);
      return c.json({ kind: 'job', outcome: result.outcome, job: result.job, update: result.update });
    }
    if (!isEmailSendReceiptInput(body)) return c.json({ error: 'Invalid request result' }, 400);
    const result = store.settleEmailSendAction(id, claimId, body, now().toISOString());
    if (result.outcome === 'not_found') return c.json({ error: 'Request not found' }, 404);
    if (result.outcome === 'invalid_claim') {
      return c.json({ error: 'Claim is invalid or expired', current: result.action }, 409);
    }
    if (result.outcome === 'hash_mismatch') {
      return c.json({ error: 'Receipt payload hash does not match the approved envelope', current: result.action }, 409);
    }
    if (result.outcome === 'receipt_conflict') {
      return c.json({ error: 'That claim already has a different receipt', current: result.action }, 409);
    }
    if (result.outcome === 'invalid_receipt') {
      return c.json({ error: 'Receipt does not match the approved reply thread', current: result.action }, 409);
    }
    if (!('item' in result)) return c.json({ error: 'Request result failed' }, 409);
    return c.json({ kind: 'email-send', outcome: result.outcome, action: result.action, item: result.item });
  });
  app.get('/api/v1/task-destinations', (c) => {
    if (!integrations) return c.json({ error: 'Google Tasks is not configured' }, 503);
    const catalogue = integrations.listGoogleTaskDestinations();
    const destinations = catalogue.destinations.filter(destination => destination.fresh).map(destination => ({
      accountId: destination.accountId,
      listId: destination.listId,
      listName: destination.name,
      area: destination.area,
      isFallback: destination.fallback,
      explicitMapping: destination.explicitMapping,
    }));
    const fallback = destinations.find(destination => destination.listId === catalogue.fallbackListId) ?? null;
    return c.json({ destinations, fallback });
  });
  app.post('/api/v1/tasks', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isTaskCreateInput(body)) return c.json({ error: 'Invalid task create request' }, 400);
    if (!integrations) return c.json({ error: 'Google Tasks is not configured' }, 503);
    const catalogue = integrations.listGoogleTaskDestinations();
    const destination = catalogue.destinations.find(candidate => candidate.fresh &&
      candidate.accountId === body.destination.accountId && candidate.listId === body.destination.listId);
    if (!destination || catalogue.accountId !== body.destination.accountId) {
      return c.json({ error: 'The Google task destination changed. Refresh the list and try again.' }, 409);
    }
    const finalNotes = taskCreateNotes(body.notes, body.nonce);
    if (finalNotes.length > 8_192) return c.json({ error: 'Task notes are too long' }, 400);
    const result = store.queueTaskCreateAction({
      destination: body.destination,
      destinationName: destination.name,
      nonce: body.nonce,
      title: body.title.trim(),
      notes: body.notes,
      finalNotes,
      doOn: body.doOn,
      plan: body.plan,
      ...(body.inbox ? { inbox: body.inbox } : {}),
      ...(body.reminder ? { reminder: body.reminder } : {}),
    }, now().toISOString());
    if (result.outcome === 'idempotency_conflict') {
      return c.json({ error: 'This task create nonce was already used for different content', current: result.action }, 409);
    }
    if (result.outcome === 'inbox_not_found') return c.json({ error: 'Inbox item not found' }, 404);
    if (result.outcome === 'inbox_conflict') return c.json({ error: 'Inbox item changed', current: result.inbox }, 409);
    if (result.outcome === 'invalid_reminder') return c.json({ error: 'Reminder must be a future UTC instant' }, 400);
    options.actionWorker?.kick();
    return c.json({ task: result.task, plan: result.plan, action: result.action, inbox: result.inbox, reminder: result.reminder },
      result.outcome === 'queued' ? 202 : 200);
  });
  app.get('/api/v1/task-migrations', (c) => {
    const migrations = store.listTaskMigrationRuns(20)
      .map(({ migrationId }) => summarizeTaskMigration(store.migrationActions(migrationId), migrationId));
    return c.json({ migrations });
  });
  app.get('/api/v1/task-migrations/preview', (c) => {
    const generatedAt = now().toISOString();
    const catalogue = integrations?.listGoogleTaskDestinations() ?? {
      accountId: null,
      connectionGeneration: null,
      destinations: [],
      fallbackListId: null,
    };
    const feed = hermes?.feed() ?? { state: 'unavailable' as const, checkedAt: generatedAt, board: null };
    return c.json({ preview: buildTaskMigrationPreview(store, catalogue, feed, generatedAt) });
  });
  app.post('/api/v1/task-migrations/approve', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isTaskMigrationApprovalInput(body)) return c.json({ error: 'Invalid task migration approval' }, 400);
    const migrationId = migrationIdForIdempotencyKey(body.idempotencyKey);
    const existingActions = store.migrationActions(migrationId);
    if (existingActions.length > 0) {
      const samePreview = existingActions.every(action =>
        action.payload.kind === 'task-migration' && action.payload.previewHash === body.previewHash);
      return samePreview
        ? c.json({ outcome: 'replayed', migration: summarizeTaskMigration(existingActions, migrationId) })
        : c.json({
            error: 'That migration approval key was already used for a different batch.',
            migration: summarizeTaskMigration(existingActions, migrationId),
          }, 409);
    }
    const approvedAt = now().toISOString();
    const catalogue = integrations?.listGoogleTaskDestinations() ?? {
      accountId: null,
      connectionGeneration: null,
      destinations: [],
      fallbackListId: null,
    };
    const feed = hermes?.feed() ?? { state: 'unavailable' as const, checkedAt: approvedAt, board: null };
    const preview = buildTaskMigrationPreview(store, catalogue, feed, approvedAt);
    if (preview.hash !== body.previewHash || preview.blockers.length > 0 || preview.items.length === 0) {
      return c.json({ error: 'Task migration sources changed or no eligible tasks remain. Review a new preview.', preview }, 409);
    }
    const result = store.approveTaskMigration(preview, body.idempotencyKey, approvedAt);
    const actions = result.actions;
    if (result.outcome === 'conflict') {
      return c.json({
        error: 'That migration approval key was already used for a different batch.',
        migration: summarizeTaskMigration(actions, migrationId),
      }, 409);
    }
    options.actionWorker?.kick();
    return c.json({
      outcome: result.outcome,
      migration: summarizeTaskMigration(actions, migrationId),
    }, result.outcome === 'queued' ? 202 : 200);
  });
  app.get('/api/v1/task-migrations/:migrationId', (c) => {
    const migrationId = c.req.param('migrationId');
    if (!/^migration-[a-f0-9]{32}$/.test(migrationId)) return c.json({ error: 'Invalid task migration ID' }, 400);
    const actions = store.migrationActions(migrationId);
    if (!actions.length) return c.json({ error: 'Task migration not found' }, 404);
    return c.json({ migration: summarizeTaskMigration(actions, migrationId) });
  });
  app.put('/api/v1/tasks/:taskId/plan', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isTaskPlanInput(body)) return c.json({ error: 'Invalid task plan' }, 400);
    const current = store.getTaskPlan(c.req.param('taskId'));
    const updated = store.updateTaskPlan(c.req.param('taskId'), body.version, {
      priority: body.priority,
      waiting: body.waiting,
      deadlineOn: body.deadlineOn,
      plannedOn: body.plannedOn,
      plannedAt: body.plannedAt,
      estimateMinutes: body.estimateMinutes,
    }, now().toISOString());
    return updated ? c.json({ plan: updated }) : current
      ? c.json({ error: 'Task plan changed', current }, 409)
      : c.json({ error: 'Task not found' }, 404);
  });
  app.post('/api/v1/tasks/:taskId/status', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isTaskStatusInput(body)) return c.json({ error: 'Invalid task status' }, 400);
    const result = store.queueTaskStatusAction(c.req.param('taskId'), body.version, body.state, now().toISOString());
    if (result.outcome === 'not_found') return c.json({ error: 'Task not found' }, 404);
    if (result.outcome === 'read_only') return c.json({ error: 'This task cannot be changed in Google Tasks', task: result.task }, 422);
    if (result.outcome === 'conflict') return c.json({ error: 'Task changed', current: result.task }, 409);
    options.actionWorker?.kick();
    return c.json({ action: result.action, task: result.task }, 202);
  });
  app.post('/api/v1/jobs', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isJobInstruction(body)) return c.json({ error: 'Invalid job' }, 400);
    const result = store.createJob({
      title: body.title.trim(),
      instruction: body.instruction.trim(),
      taskId: body.taskId ?? null,
      inboxId: body.inboxId ?? null,
    }, now().toISOString(), body.idempotencyKey);
    if (result.outcome === 'missing_task') return c.json({ error: 'Linked task not found' }, 404);
    if (result.outcome === 'missing_inbox') return c.json({ error: 'Linked Inbox item not found' }, 404);
    if (result.outcome === 'idempotency_conflict') {
      return c.json({ error: 'This job key was already used for a different instruction', current: result.job }, 409);
    }
    return c.json({ job: result.job }, result.outcome === 'created' ? 201 : 200);
  });
  app.post('/api/v1/jobs/:id/answer', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isJobAnswerInput(body)) return c.json({ error: 'Invalid answer' }, 400);
    const result = store.answerJob(c.req.param('id'), body.version, body.text, now().toISOString());
    if (result.outcome === 'not_found') return c.json({ error: 'Job not found' }, 404);
    if (result.outcome === 'conflict') return c.json({ error: 'Job changed', current: result.job }, 409);
    if (result.outcome === 'invalid_state') return c.json({ error: 'Job does not need an answer', current: result.job }, 409);
    if (!('update' in result)) return c.json({ error: 'Answer failed' }, 409);
    return c.json({ job: result.job, update: result.update });
  });
  app.post('/api/v1/jobs/:id/send-back', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isJobSendBackInput(body)) return c.json({ error: 'Invalid send-back note' }, 400);
    const result = store.sendBackJob(c.req.param('id'), body.version, body.text, now().toISOString());
    if (result.outcome === 'not_found') return c.json({ error: 'Job not found' }, 404);
    if (result.outcome === 'conflict') return c.json({ error: 'Job changed', current: result.job }, 409);
    if (result.outcome === 'invalid_state') return c.json({ error: 'Job is not ready for review', current: result.job }, 409);
    if (!('update' in result)) return c.json({ error: 'Send back failed' }, 409);
    return c.json({ job: result.job, update: result.update });
  });
  app.post('/api/v1/jobs/:id/settle', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isJobSettleInput(body)) return c.json({ error: 'Invalid settlement' }, 400);
    const result = store.settleJob(c.req.param('id'), body.version, body.outcome, now().toISOString(), body.taskVersion);
    if (result.outcome === 'not_found') return c.json({ error: 'Job not found' }, 404);
    if (result.outcome === 'conflict') return c.json({ error: 'Job changed', current: result.job }, 409);
    if (result.outcome === 'invalid_state') return c.json({ error: 'Job cannot be settled from its current state', current: result.job }, 409);
    if (result.outcome === 'task_not_found') return c.json({ error: 'Linked task not found', current: result.job }, 409);
    if (result.outcome === 'task_version_required') {
      return c.json({ error: 'The displayed linked task version is required', current: result.task }, 409);
    }
    if (result.outcome === 'task_conflict') return c.json({ error: 'Linked task changed', current: result.task }, 409);
    if (result.outcome === 'task_read_only') return c.json({ error: 'Linked task cannot be completed', current: result.task }, 422);
    if (!('action' in result)) return c.json({ error: 'Settlement failed' }, 409);
    if (result.action) options.actionWorker?.kick();
    return c.json({ job: result.job, update: result.update, action: result.action });
  });
  app.put('/api/v1/inbox-items/:inboxId', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isInboxDecisionInput(body)) return c.json({ error: 'Invalid Inbox decision' }, 400);
    const decisionAt = now().toISOString();
    if (body.state === 'waiting' && (body.snoozedUntil === null || Date.parse(body.snoozedUntil) <= Date.parse(decisionAt))) {
      return c.json({ error: 'Snooze time must be in the future' }, 400);
    }
    if (body.outcome === 'sent' || body.outcome === 'task') {
      return c.json({ error: 'Sent and task outcomes require their approval routes' }, 400);
    }
    const current = store.getInboxItem(c.req.param('inboxId'));
    const updated = store.updateInboxDecision(c.req.param('inboxId'), body.version, {
      state: body.state,
      outcome: body.outcome,
      snoozedUntil: body.snoozedUntil,
    }, decisionAt);
    return updated ? c.json({ item: updated }) : current
      ? c.json({ error: 'Inbox item changed', current }, 409)
      : c.json({ error: 'Inbox item not found' }, 404);
  });
  app.post('/api/v1/inbox-items/:inboxId/drafts', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isRecord(body) || !Number.isSafeInteger(body.version) || typeof body.version !== 'number' || body.version < 1 ||
      !isReplyEnvelope(body.reply)) return c.json({ error: 'Invalid draft revision' }, 400);
    const result = store.appendOwnerDraft(c.req.param('inboxId'), body.version, body.reply, now().toISOString());
    if (result.outcome === 'not_found') return c.json({ error: 'Inbox item not found' }, 404);
    if (result.outcome === 'conflict') return c.json({ error: 'Inbox item changed', current: result.item }, 409);
    if (result.outcome === 'not_email') return c.json({ error: 'Draft identity does not match the email', current: result.item }, 400);
    if (!('draft' in result)) return c.json({ error: 'Draft update failed' }, 409);
    return c.json({ item: result.item, draft: result.draft }, 201);
  });
  app.post('/api/v1/inbox-items/:inboxId/send', async (c) => {
    if (!emailSendEnabled) return c.json({ error: 'Email sending is disabled' }, 503);
    if (!c.req.header('Content-Type')?.startsWith('application/json')) {
      return c.json({ error: 'Expected application/json' }, 415);
    }
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isEmailSendApprovalInput(body)) return c.json({ error: 'Invalid email send approval' }, 400);
    const result = store.queueEmailSendAction(
      c.req.param('inboxId'),
      body.version,
      body.draftId,
      now().toISOString(),
    );
    if (result.outcome === 'not_found') return c.json({ error: 'Inbox item not found' }, 404);
    if (result.outcome === 'conflict') {
      return c.json({ error: 'Inbox item changed', current: result.item }, 409);
    }
    if (result.outcome === 'unavailable') {
      return c.json({ error: 'Email send is already pending or unavailable', current: result.item }, 409);
    }
    if (result.outcome === 'not_email') {
      return c.json({ error: 'Only email Inbox items can be sent', current: result.item }, 422);
    }
    if (result.outcome === 'invalid_draft') {
      return c.json({ error: 'The current draft cannot be sent', current: result.item }, 422);
    }
    if (!('action' in result)) return c.json({ error: 'Email send approval failed' }, 409);
    return c.json({ outcome: result.outcome, item: result.item, action: result.action },
      result.outcome === 'queued' ? 202 : 200);
  });
  app.get('/api/v1/push/public-key', (c) => options.pushPublicKey
    ? c.json({ publicKey: options.pushPublicKey })
    : c.json({ error: 'Push notifications are unavailable' }, 503));
  app.post('/api/v1/push/subscriptions', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    const text = await c.req.text();
    if (Buffer.byteLength(text, 'utf8') > 16 * 1024) return c.json({ error: 'Subscription is too large' }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isPushSubscription(body)) return c.json({ error: 'Invalid push subscription' }, 400);
    store.savePushSubscription(body, c.req.header('User-Agent')?.slice(0, 500) ?? null);
    return c.json({ ok: true }, 201);
  });
  app.delete('/api/v1/push/subscriptions', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isRecord(body) || typeof body.endpoint !== 'string' || body.endpoint.length > 4096) {
      return c.json({ error: 'Invalid endpoint' }, 400);
    }
    store.deletePushSubscription(body.endpoint);
    return c.json({ ok: true });
  });
  app.get('/api/v1/hermes', (c) => c.json(hermes?.feed() ?? {
    state: 'unavailable', checkedAt: new Date().toISOString(), board: null, completionAvailable: false,
  }));
  app.post('/api/v1/hermes/sync', async (c) => c.json(
    hermes ? await hermes.poll() : {
      state: 'unavailable', checkedAt: new Date().toISOString(), board: null, completionAvailable: false,
    },
  ));
  app.put('/api/v1/hermes/tasks/:taskId/annotation', async (c) => {
    if (!hermes) return c.json({ error: 'Hermes is unavailable' }, 503);
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isHermesTaskAnnotationInput(body)) return c.json({ error: 'Invalid task organisation' }, 400);
    if (body.reminderMode !== 'none' && (!body.scheduledAt || !body.reminderFireAt)) {
      return c.json({ error: 'A reminder needs a planned time' }, 400);
    }
    if (body.reminderMode === 'none' && body.reminderFireAt !== null) {
      return c.json({ error: 'A disabled reminder cannot have a fire time' }, 400);
    }
    if (!body.scheduledAt && body.localState === 'scheduled') {
      return c.json({ error: 'Scheduled state needs a planned time' }, 400);
    }
    const taskId = c.req.param('taskId');
    if (!taskId || taskId.length > 200) return c.json({ error: 'Invalid task ID' }, 400);
    if (store.isHermesTaskCoveredByMigration('personal-tasks', taskId)) {
      return c.json({ error: 'This task is frozen by an approved Google migration.' }, 409);
    }
    const task = hermes.updateAnnotation(taskId, body);
    return task ? c.json({ task }) : c.json({ error: 'Task not found' }, 404);
  });
  app.post('/api/v1/hermes/tasks/:taskId/complete', async (c) => {
    if (!hermes) return c.json({ error: 'Hermes is unavailable' }, 503);
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isHermesCompletionInput(body)) return c.json({ error: 'Invalid completion approval' }, 400);
    const taskId = c.req.param('taskId');
    if (!taskId || taskId.length > 200) return c.json({ error: 'Invalid task ID' }, 400);
    if (store.isHermesTaskCoveredByMigration('personal-tasks', taskId)) {
      return c.json({ error: 'This task is frozen by an approved Google migration.' }, 409);
    }
    const currentFeed = hermes.feed();
    if (currentFeed.board && adoptedTaskIdForHermes(store.read(), currentFeed.board.slug, taskId)) {
      return c.json({ error: 'This task is owned by Fox Focus and cannot be completed through the legacy Hermes bridge.' }, 409);
    }
    const confirmedAt = Date.parse(body.confirmation.confirmedAt);
    if (confirmedAt > Date.now() + 60_000 || confirmedAt < Date.now() - 10 * 60_000) {
      return c.json({ error: 'Completion approval expired. Confirm it again.' }, 400);
    }
    try {
      return c.json(await hermes.completeTask(taskId, body));
    } catch (error) {
      if (error instanceof HermesServiceError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
  app.get('/api/v1/task-status', (c) => {
    const snapshot = store.read();
    const etag = `"workspace-${snapshot.revision}"`;
    c.header('ETag', etag);
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
    return c.json(taskStatusProjection(snapshot, now().toISOString()));
  });
  app.post('/api/v1/task-proposals', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (
      !isRecord(body) || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 200 ||
      typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.length > 500 ||
      typeof body.summary !== 'string' || body.summary.trim().length === 0 || body.summary.length > 2_000 ||
      (body.area !== undefined && !isOneOf(body.area, areas))
    ) return c.json({ error: 'Invalid task proposal' }, 400);
    const timestamp = now().toISOString();
    const normalizedProposal = {
      title: body.title.trim(),
      summary: body.summary.trim(),
      area: body.area ?? 'Personal',
    };
    const requestHash = createHash('sha256').update(JSON.stringify(normalizedProposal)).digest('base64url');
    const result = store.addAgentProposal(body.idempotencyKey, requestHash, {
      id: `inbox-${randomUUID()}`,
      title: normalizedProposal.title,
      summary: normalizedProposal.summary,
      source: 'Hermes proposal',
      actor: 'Hermes',
      status: 'new',
      accent: normalizedProposal.area,
    }, timestamp);
    if (result.conflict) return c.json({ error: 'That idempotency key was used for a different proposal' }, 409);
    return c.json({ outcome: result.created ? 'created' : 'already_received', inboxItemId: result.inboxItemId }, result.created ? 201 : 200);
  });
  app.get('/api/v1/integrations', (c) => {
    const overview = integrations?.overview() ?? {
      ...emptyIntegrations,
      records: [...store.listProviderRecords(2_000, 'calendar_event'), ...store.listProviderRecords(2_000, 'task')],
    };
    const snapshot = store.read();
    return c.json({
      ...overview,
      records: overview.records.map(record => ({ ...record, adoptedTaskId: adoptedTaskIdForRecord(store, snapshot, record) })),
    });
  });
  app.get('/api/v1/integrations/:provider/connect', (c) => {
    const provider = providerFrom(c.req.param('provider'));
    const authorizationUrl = provider ? integrations?.startAuthorization(provider) : null;
    return authorizationUrl
      ? c.redirect(authorizationUrl, 302)
      : c.json({ error: 'Provider is not configured' }, 404);
  });
  app.get('/api/v1/integrations/:provider/callback', async (c) => {
    const provider = providerFrom(c.req.param('provider'));
    if (!provider || !integrations) return c.redirect('/?integration=unavailable', 303);
    const result = await integrations.completeAuthorization(provider, new URL(c.req.url).searchParams);
    const params = new URLSearchParams({ integration: provider, result: result.outcome, notice: result.notice });
    return c.redirect(`/?${params}`, 303);
  });
  app.post('/api/v1/integrations/:provider/sync', async (c) => {
    const provider = providerFrom(c.req.param('provider'));
    if (!provider || !integrations) return c.json({ error: 'Provider is not configured' }, 404);
    const result = await integrations.sync(provider);
    return result.outcome === 'synced' ? c.json(result) : c.json(result, 503);
  });
  app.post('/api/v1/task-adoptions/preview', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isRecord(body) || (body.source !== 'google' && body.source !== 'microsoft' && body.source !== 'hermes')) {
      return c.json({ error: 'Invalid adoption source' }, 400);
    }
    if (body.source === 'hermes' && typeof body.externalId === 'string' &&
      store.isHermesTaskCoveredByMigration('personal-tasks', body.externalId)) {
      return c.json({ error: 'This task is frozen by an approved Google migration.' }, 409);
    }
    try {
      const request = body.source === 'hermes'
        ? typeof body.externalId === 'string' && body.externalId.length > 0 && body.externalId.length <= 512
          ? previewHermesTaskAdoption(store, hermes?.feed() ?? { state: 'unavailable', checkedAt: now().toISOString(), board: null }, body.externalId, now())
          : null
        : typeof body.recordId === 'number' && Number.isSafeInteger(body.recordId) && body.recordId > 0
          ? body.targetTaskId === undefined || (
              typeof body.targetTaskId === 'string' && body.targetTaskId.length > 0 && body.targetTaskId.length <= 200
            )
            ? previewProviderTaskAdoption(store, body.recordId, now(), body.targetTaskId)
            : null
          : null;
      if (!request) return c.json({ error: 'Invalid adoption target' }, 400);
      if (request.source !== body.source) return c.json({ error: 'Adoption source does not match the imported record' }, 409);
      return c.json({
        id: request.id,
        status: request.status,
        before: request.before,
        after: request.task,
        expiresAt: request.expiresAt,
      }, 201);
    } catch (error) {
      if (error instanceof TaskManagementError) return c.json({ error: error.message }, taskManagementStatus(error));
      throw error;
    }
  });
  app.post('/api/v1/task-adoptions/:id/approve', (c) => {
    const id = c.req.param('id');
    const request = store.getTaskAdoption(id);
    if (!request) return c.json({ error: 'Adoption preview was not found' }, 404);
    if (request.source === 'hermes' &&
      store.isHermesTaskCoveredByMigration(request.containerId, request.externalId)) {
      return c.json({ error: 'This task is frozen by an approved Google migration.' }, 409);
    }
    if (request.status === 'awaiting_approval' && store.read().revision !== request.workspaceRevision) {
      return c.json({ error: 'The workspace changed after this preview. Preview the adoption again.' }, 409);
    }
    if (!adoptionSourceStillMatches(store, request, request.source === 'hermes' ? hermes?.feed() : undefined)) {
      return c.json({ error: 'The source task changed after this preview. Refresh and review it again.' }, 409);
    }
    const result = store.approveTaskAdoption(id, now().toISOString());
    return result
      ? c.json({ outcome: 'adopted', taskId: result.adoptedTaskId, snapshot: result.snapshot })
      : c.json({ error: 'Adoption preview was not found or has expired' }, 410);
  });
  app.get('/api/v1/task-actions', (c) => {
    const taskId = c.req.query('taskId');
    return c.json({ actions: store.listTaskActions(taskId || undefined) });
  });
  app.post('/api/v1/task-actions/preview', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (
      !isRecord(body) || typeof body.taskId !== 'string' || body.taskId.length === 0 || body.taskId.length > 200 ||
      (body.desiredState !== 'open' && body.desiredState !== 'completed') ||
      typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 200
    ) return c.json({ error: 'Invalid task action' }, 400);
    try {
      return c.json(previewTaskAction(store, body.taskId, body.desiredState, body.idempotencyKey, now()), 201);
    } catch (error) {
      if (error instanceof TaskManagementError) return c.json({ error: error.message }, taskManagementStatus(error));
      throw error;
    }
  });

  async function executeTaskAction(id: string, retry: boolean) {
    const existing = store.getTaskAction(id);
    if (existing?.status === 'succeeded') return { status: 200 as const, body: { action: existing, snapshot: store.read() } };
    if (retry && existing?.status === 'failed' && existing.result?.retryable !== true) {
      return { status: 409 as const, body: { error: 'This failure needs a new preview or reconnection before retrying.' } };
    }
    const started = store.beginTaskAction(id, now().toISOString(), retry);
    if (!started) return { status: 410 as const, body: { error: 'Action preview was not found, cannot be retried, or has expired.' } };
    if (started.outcome === 'conflict') {
      return { status: 409 as const, body: { action: started.action, snapshot: started.snapshot } };
    }
    if (!integrations) {
      const action = store.finishTaskAction(id, 'failed', { retryable: false }, 'Google Tasks is not configured.', now().toISOString());
      return { status: 503 as const, body: { action, snapshot: store.read() } };
    }
    const result = await integrations.updateGoogleTaskCompletion({
      accountId: started.action.connectionId,
      containerId: started.action.containerId,
      externalId: started.action.externalId,
      desiredState: started.action.desiredState,
      ...(started.action.expectedVersion ? { expectedVersion: started.action.expectedVersion } : {}),
    });
    if (result.outcome === 'succeeded') {
      store.updateTaskExternalState({
        taskId: started.action.taskId,
        connectionId: started.action.connectionId,
        containerId: started.action.containerId,
        externalId: started.action.externalId,
        sourceStatus: result.sourceStatus,
        sourceVersion: result.sourceVersion,
        sourceUpdatedAt: result.sourceUpdatedAt,
        completedAt: result.completedAt,
        now: now().toISOString(),
      });
      const action = store.finishTaskAction(id, 'succeeded', {
        verified: true,
        sourceStatus: result.sourceStatus,
        sourceVersion: result.sourceVersion,
      }, null, now().toISOString());
      return { status: 200 as const, body: { action, snapshot: store.read() } };
    }
    if (result.outcome === 'conflict') {
      const action = store.finishTaskAction(id, 'conflict', { retryable: false }, result.notice, now().toISOString());
      return { status: 409 as const, body: { action, snapshot: store.read() } };
    }
    const action = store.finishTaskAction(id, 'failed', { retryable: result.retryable }, result.notice, now().toISOString());
    return { status: 503 as const, body: { action, snapshot: store.read() } };
  }

  app.post('/api/v1/task-actions/:id/approve', async (c) => {
    const result = await executeTaskAction(c.req.param('id'), false);
    return c.json(result.body, result.status);
  });
  app.post('/api/v1/task-actions/:id/retry', async (c) => {
    const result = await executeTaskAction(c.req.param('id'), true);
    return c.json(result.body, result.status);
  });
  app.put('/api/v1/workspace', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isRecord(body) || !Number.isSafeInteger(body.revision) || typeof body.revision !== 'number' || body.revision < 0 || !isPrototypeData(body.data)) {
      return c.json({ error: 'Invalid workspace' }, 400);
    }
    const data = body.data;
    const current = store.read();
    if (JSON.stringify(data.tasks) !== JSON.stringify(current.data.tasks) ||
      JSON.stringify(data.inboxItems) !== JSON.stringify(current.data.inboxItems)) {
      return c.json({ error: 'Tasks and Inbox items use versioned row routes' }, 403);
    }
    // Fixture calendar context stands in for authoritative imported records.
    const imported = current.data.events.filter(e => !e.editable);
    if (imported.some(e => JSON.stringify(data.events.find(next => next.id === e.id)) !== JSON.stringify(e)) ||
      data.events.some(e => !e.editable && !imported.some(previous => previous.id === e.id))) {
      return c.json({ error: 'Read-only calendar context cannot be changed' }, 403);
    }
    const currentTasks = new Map(current.data.tasks.map(task => [task.id, task]));
    for (const nextTask of data.tasks) {
      const previous = currentTasks.get(nextTask.id);
      const previousLinks = previous?.externalLinks ?? [];
      const nextLinks = nextTask.externalLinks ?? [];
      if (JSON.stringify(previousLinks) !== JSON.stringify(nextLinks)) {
        return c.json({ error: 'External task links are managed by Fox Focus' }, 403);
      }
      if (previousLinks.some(link => link.policy === 'completion_only') &&
        (previous?.completed !== nextTask.completed || previous.completedAt !== nextTask.completedAt)) {
        return c.json({ error: 'Linked task completion requires an approval preview' }, 403);
      }
    }
    if (current.data.tasks.some(task => task.externalLinks?.length && !data.tasks.some(next => next.id === task.id))) {
      return c.json({ error: 'Adopted tasks cannot be removed through the workspace editor' }, 403);
    }
    const saved = store.save(body.revision, body.data);
    return saved ? c.json(saved) : c.json({ error: 'Workspace changed in another tab. Reload before saving.' }, 409);
  });
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    // Preserve the server-side stack for bounded operational diagnosis without
    // exposing source data or internal details to the browser response.
    console.error('Request failed:', error);
    return c.json({ error: 'Request failed' }, 500);
  });
  return app;
}
