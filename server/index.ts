import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { createIntegrationService, integrationConfigFromEnvironment } from './integrations.ts';
import { openStore } from './store.ts';
import { createHermesActionClient, createHermesMirrorService, type HermesActionClient } from './hermes.ts';
import webPush from 'web-push';
import { deliverDuePushNotifications, deliveryKey, subscriptionDeliveryKey } from './push.ts';

const PUSH_REQUEST_TIMEOUT_MS = 10_000;

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
const hermesActionUrl = process.env.HERMES_ACTION_API_URL;
const hermesActionTokenFile = process.env.HERMES_ACTION_TOKEN_FILE;
let hermesActionClient: HermesActionClient | undefined;
if (hermesActionUrl && hermesActionTokenFile) {
  const token = readFileSync(hermesActionTokenFile, 'utf8').trim();
  hermesActionClient = createHermesActionClient(hermesActionUrl, token);
} else if (hermesActionUrl || hermesActionTokenFile) {
  console.error('Hermes completion needs both HERMES_ACTION_API_URL and HERMES_ACTION_TOKEN_FILE. Completion is disabled.');
}
const hermes = hermesPath
  ? createHermesMirrorService(store, { dbPath: hermesPath }, hermesActionClient)
  : undefined;
const integrationConfig = integrationConfigFromEnvironment();
const integrations = integrationConfig ? createIntegrationService(store, integrationConfig) : undefined;
const app = createApp(store, password, hermes, integrations, vapid.publicKey);
// Establish a current or explicitly stale mirror before the first reminder
// tick, so persisted rows from a previous run can never fire unchecked.
if (hermes) await hermes.poll();
app.get('/assets/*', serveStatic({ root: './dist' }));
// both files come from public/ via the vite build; read once so a missing file is a clean 404
function readDistFile(name: string): string | null {
  try { return readFileSync(join('./dist', name), 'utf8'); } catch { return null; }
}
const serviceWorkerSource = readDistFile('sw.js');
const manifestSource = readDistFile('manifest.webmanifest');
app.get('/sw.js', (c) => serviceWorkerSource === null
  ? c.notFound()
  : c.body(serviceWorkerSource, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    }));
app.get('/manifest.webmanifest', (c) => manifestSource === null
  ? c.notFound()
  : c.body(manifestSource, 200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' }));
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
    const hermesReminders = hermes ? store.listHermesReminders() : [];
    const retainedHermesReminders = store.listHermesReminders(true);
    const notificationData = { ...snapshot.data, reminders: [...snapshot.data.reminders, ...hermesReminders] };
    // Keep delivery keys for the last good Hermes mirror while polling is
    // stale or disabled, but never send reminders from that unverified view.
    store.prunePushDeliveries([...snapshot.data.reminders, ...retainedHermesReminders].map(deliveryKey));
    const summary = await deliverDuePushNotifications({
      data: notificationData,
      now: new Date(),
      subscriptions: store.listPushSubscriptions().map(record => record.subscription),
      delivered: new Set(store.listPushDeliveries().map(subscriptionDeliveryKey)),
      send: (subscription, payload) => webPush.sendNotification(subscription, payload, { timeout: PUSH_REQUEST_TIMEOUT_MS }).then(() => undefined),
      markDelivered: store.markPushDelivered,
      deleteSubscription: store.deletePushSubscription,
    });
    if (summary.due > 0) {
      console.log(`Push tick: ${summary.due} due, ${summary.sent} sent, ${summary.failed} failed, ${summary.removed} removed.`);
    }
  } catch {
    console.error('Push tick failed.');
  } finally {
    pushTickRunning = false;
  }
}
const pushTimer = setInterval(() => { void sendDuePushNotifications(); }, 60_000);
pushTimer.unref();
void sendDuePushNotifications();
let hermesTimer: NodeJS.Timeout | undefined;
if (hermes) {
  hermesTimer = setInterval(() => { void hermes.poll(); }, 60_000);
  hermesTimer.unref();
}
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
  if (hermesTimer) clearInterval(hermesTimer);
  server.close(() => { store.close(); process.exit(0); });
});
