import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { isPrototypeData, isRecord } from '../src/model.ts';
import type { Store } from './store.ts';
import type { HermesFeed } from '../src/hermes-model.ts';
import type { IntegrationOverview, IntegrationService } from './integrations.ts';

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

export function createApp(
  store: Store,
  password: string,
  hermes?: () => HermesFeed,
  integrations?: IntegrationService,
) {
  if (password.length < 24) throw new Error('Workspace password must have at least 24 characters');
  const app = new Hono();
  app.use('*', secureHeaders());
  const auth = basicAuth({ username: 'fox', password, realm: 'Fox Focus workspace' });
  app.use('/', auth);
  app.use('/app', auth);
  app.use('/app/*', auth);
  app.use('/api/*', auth);
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
  app.get('/api/v1/hermes', (c) => c.json(hermes?.() ?? { state: 'unavailable', checkedAt: new Date().toISOString(), board: null }));
  app.get('/api/v1/integrations', (c) => c.json(integrations?.overview() ?? emptyIntegrations));
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
  app.put('/api/v1/workspace', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isRecord(body) || !Number.isSafeInteger(body.revision) || typeof body.revision !== 'number' || body.revision < 0 || !isPrototypeData(body.data)) {
      return c.json({ error: 'Invalid workspace' }, 400);
    }
    const data = body.data;
    const current = store.read();
    // Fixture calendar context stands in for authoritative imported records.
    const imported = current.data.events.filter(e => !e.editable);
    if (imported.some(e => JSON.stringify(data.events.find(next => next.id === e.id)) !== JSON.stringify(e)) ||
      data.events.some(e => !e.editable && !imported.some(previous => previous.id === e.id))) {
      return c.json({ error: 'Read-only calendar context cannot be changed' }, 403);
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
