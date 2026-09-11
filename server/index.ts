import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { createIntegrationService, integrationConfigFromEnvironment } from './integrations.ts';
import { openStore } from './store.ts';
import { readHermesFeed } from './hermes.ts';
import webPush, { type WebPushError } from 'web-push';
import { deliveryKey, dueReminders } from './push.ts';

const dataDir = process.env.DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const passwordPath = join(dataDir, 'workspace-password');
try { writeFileSync(passwordPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
const password = readFileSync(passwordPath, 'utf8').trim();
const vapidPath = join(dataDir, 'vapid.json');
try {
  writeFileSync(vapidPath, JSON.stringify(webPush.generateVAPIDKeys()), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
}
chmodSync(vapidPath, 0o600);
const vapid: unknown = JSON.parse(readFileSync(vapidPath, 'utf8'));
if (typeof vapid !== 'object' || vapid === null || !('publicKey' in vapid) || !('privateKey' in vapid) ||
  typeof vapid.publicKey !== 'string' || typeof vapid.privateKey !== 'string') throw new Error('Invalid VAPID key file');
webPush.setVapidDetails('mailto:semyon.fox@gmail.com', vapid.publicKey, vapid.privateKey);
const store = openStore(join(dataDir, 'focus.sqlite'));
const hermesPath = process.env.HERMES_KANBAN_DB;
const integrationConfig = integrationConfigFromEnvironment();
const integrations = integrationConfig ? createIntegrationService(store, integrationConfig) : undefined;
const app = createApp(store, password, hermesPath ? () => readHermesFeed({ dbPath: hermesPath }) : undefined, integrations, vapid.publicKey);
app.get('/assets/*', serveStatic({ root: './dist' }));
app.get('/sw.js', async (c, next) => {
  const response = await serveStatic({ path: './dist/sw.js' })(c, next);
  if (!response) return c.notFound();
  response.headers.set('Content-Type', 'application/javascript; charset=utf-8');
  response.headers.set('Cache-Control', 'no-cache');
  response.headers.set('Service-Worker-Allowed', '/');
  return response;
});
app.get('/manifest.webmanifest', (c, next) => {
  c.header('Content-Type', 'application/manifest+json');
  return serveStatic({ path: './dist/manifest.webmanifest' })(c, next);
});
app.get('/', (c, next) => { c.header('Cache-Control', 'no-store'); return serveStatic({ path: './dist/index.html' })(c, next); });
const port = Number(process.env.PORT ?? 8789);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`Fox Focus listening on ${port}. Protected workspace at /.`));
let pushTickRunning = false;
async function sendDuePushNotifications(): Promise<void> {
  if (pushTickRunning) return;
  pushTickRunning = true;
  try {
    const snapshot = store.read();
    const reminders = dueReminders(snapshot.data, new Date(), store.listPushDeliveries());
    if (!reminders.length) return;
    const subscriptions = store.listPushSubscriptions();
    let sent = 0;
    let removed = 0;
    let failed = 0;
    for (const reminder of reminders) {
      const payload = JSON.stringify({ title: reminder.title, body: reminder.when, tag: reminder.id, url: '/' });
      for (const { subscription } of subscriptions) {
        try {
          await webPush.sendNotification(subscription, payload);
          sent += 1;
        } catch (error) {
          const statusCode = (error as WebPushError).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            if (store.deletePushSubscription(subscription.endpoint)) removed += 1;
          } else failed += 1;
        }
      }
    }
    store.markPushDelivered(reminders.map(deliveryKey), snapshot.data.reminders.map(deliveryKey));
    console.log(`Push tick: ${reminders.length} due, ${sent} sent, ${failed} failed, ${removed} removed.`);
  } catch {
    console.error('Push tick failed.');
  } finally {
    pushTickRunning = false;
  }
}
const pushTimer = setInterval(() => { void sendDuePushNotifications(); }, 60_000);
pushTimer.unref();
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
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(pushTimer);
  server.close(() => { store.close(); process.exit(0); });
});
