import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { areas, isOneOf, isPrototypeData, isRecord } from '../src/model.ts';
import { isDateKey } from '../src/calendar-time.ts';
import { isHermesCompletionInput, isHermesTaskAnnotationInput } from '../src/hermes-model.ts';
import { isInboxDecisionInput, isTaskPlanInput, isTaskStatusInput } from '../src/row-model.ts';
import { isPushSubscription } from './push.ts';
import type { Store } from './store.ts';
import { HermesServiceError, type HermesMirrorService } from './hermes.ts';
import type { IntegrationOverview, IntegrationService } from './integrations.ts';
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
  now?: () => Date;
  actionWorker?: { kick: () => void };
};

function tokenMatches(value: string, expected: string): boolean {
  const supplied = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function isHermesApiRequest(method: string, path: string): boolean {
  return (method === 'GET' && (path === '/api/v1/context' || path === '/api/v1/changes' || path === '/api/v1/task-status')) ||
    (method === 'POST' && path === '/api/v1/task-proposals');
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
    throw new Error('Hermes task-status token must have at least 24 characters');
  }
  const now = options.now ?? (() => new Date());
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
    tasks: store.listTasks(),
    taskPlans: store.listTaskPlans(),
    inbox: store.listInboxItems(),
    drafts: store.listDrafts(),
    actions: store.listActions(),
    reminders: store.listReminders(),
    freshness: store.listSyncStates(),
  }));
  app.get('/api/v1/context', (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!from || !to || !isDateKey(from) || !isDateKey(to) || from > to) {
      return c.json({ error: 'A valid from and to date are required' }, 400);
    }
    return c.json(store.readContext(from, to));
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
  app.put('/api/v1/inbox-items/:inboxId', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isInboxDecisionInput(body)) return c.json({ error: 'Invalid Inbox decision' }, 400);
    const current = store.getInboxItem(c.req.param('inboxId'));
    const updated = store.updateInboxDecision(c.req.param('inboxId'), body.version, {
      state: body.state,
      outcome: body.outcome,
      snoozedUntil: body.snoozedUntil,
    }, now().toISOString());
    return updated ? c.json({ item: updated }) : current
      ? c.json({ error: 'Inbox item changed', current }, 409)
      : c.json({ error: 'Inbox item not found' }, 404);
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
    return c.redirect(`/?integration=${provider}&result=${result.outcome}`, 303);
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
      connectionId: started.action.connectionId,
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
    console.error('Request failed:', error.name);
    return c.json({ error: 'Request failed' }, 500);
  });
  return app;
}
