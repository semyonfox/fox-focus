import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { createIntegrationService, integrationConfigFromEnvironment } from './integrations.ts';
import { openStore } from './store.ts';
import { readHermesFeed } from './hermes.ts';

const dataDir = process.env.DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const passwordPath = join(dataDir, 'workspace-password');
try { writeFileSync(passwordPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
const password = readFileSync(passwordPath, 'utf8').trim();
const store = openStore(join(dataDir, 'focus.sqlite'));
const hermesPath = process.env.HERMES_KANBAN_DB;
const integrationConfig = integrationConfigFromEnvironment();
const integrations = integrationConfig ? createIntegrationService(store, integrationConfig) : undefined;
const app = createApp(store, password, hermesPath ? () => readHermesFeed({ dbPath: hermesPath }) : undefined, integrations);
app.get('/assets/*', serveStatic({ root: './dist' }));
app.get('/', (c, next) => { c.header('Cache-Control', 'no-store'); return serveStatic({ path: './dist/index.html' })(c, next); });
const port = Number(process.env.PORT ?? 8789);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`Fox Focus listening on ${port}. Protected workspace at /.`));
if (integrations) {
  // Polling keeps this private deployment read-only and avoids public webhooks.
  const initialSync = setTimeout(() => { void integrations.syncConnected(); }, 5_000);
  initialSync.unref();
  const syncTimer = setInterval(() => { void integrations.syncConnected(); }, 15 * 60_000);
  syncTimer.unref();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => clearInterval(syncTimer));
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
