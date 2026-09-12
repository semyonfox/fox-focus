# Self-hosting the prototype

Fox Focus is one Node process with a SQLite workspace file. It does not need a database server, Redis, or a background worker service for the prototype.

## Run it safely

Use the Docker quick start in the [README](../README.md) for a clean local install. It creates a named volume at `/data` in the container. That volume holds both `focus.sqlite` and the generated workspace password.

For an internet-facing installation, keep port 8789 on loopback or a private network. Put a TLS reverse proxy, Tailscale, or another private access layer in front of it. Do not publish the container port directly to the public internet.

The first startup creates a random password at `/data/workspace-password` with mode `0600`. Sign in with the fixed username `fox`. To choose your own password, overwrite that file (at least 8 characters) and restart the container. This is a temporary single-user privacy gate, not account management. The homepage and workspace API use the same credentials.

- `/` is the password-protected workspace.
- `/app` redirects to `/` for older bookmarks.
- `/api/v1/workspace` and `/api/v1/hermes` require the same password.
- `/healthz` is public and returns no workspace data.

## Hermes task mirror

Mount the Hermes Personal Tasks board directory read-only and set
`HERMES_KANBAN_DB` to its SQLite database path. Mount the WAL and shared-memory
sidecars with it. Fox Focus polls that source on startup and every 60 seconds,
then upserts a normalized mirror by Hermes task ID. A failed or bounded read
keeps the last good mirror instead of deleting rows. Task bodies never leave the
adapter.

Hermes owns title and completion status. Fox Focus stores area, due label,
duration, planning, and reminder annotations against that stable ID. Google
backed cards use their `google-task:<external ID>` provenance to join the
read-only provider record when the match is unambiguous. They never deduplicate
by title.

The codebase contains one optional remote write: Hermes completion. It uses a dedicated action route,
a separately scoped bearer token, optimistic version checking, an idempotency
key, a persisted approval record, and readback. If an HTTP result is lost while
Hermes is waiting on its database, Fox leaves the checkbox unchanged and
reconciles the exact durable action receipt on later polls. Configure the
private deployment by installing [`integrations/hermes/fox-focus-sync`](../integrations/hermes/fox-focus-sync/README.md)
as the Hermes user plugin, then set:

```dotenv
HERMES_ACTION_API_URL=http://host.docker.internal:9119/api/plugins/fox-focus-sync/task-completion
HERMES_ACTION_TOKEN_FILE=/run/secrets/fox-focus/hermes-action-token
HERMES_ACTION_TOKEN_FILE_HOST=/absolute/private/hermes-action-token
```

The token must carry only `kanban:personal-tasks:complete`. Do not reuse a
dashboard session token. The Compose service maps `host.docker.internal` to the
Docker host and mounts the token file read-only. Hermes's default loopback bind
is not reachable from a bridge-network container: run the dashboard on a host
interface Docker can reach (the current service uses `--host 0.0.0.0`) and
firewall port 9119 so only the Docker bridge and intended local clients can
reach it. Without both action settings, mirror reads and local annotations
still work, but completion stays disabled. After rotating the service token,
restart both the Hermes dashboard and Fox Focus because each reads it once at
startup.

Deploying the Fox Focus image alone does not enable completion. Jenkins uses an
operator-owned production Compose file, and the plugin runs in Hermes rather
than in the Fox Focus image. Install and validate the plugin, token, reachable
private endpoint, firewall rule, environment values, and read-only token mount
as one separate runtime change. Until all of them are present, the deployed app
continues to mirror tasks and save local annotations but refuses completion. The
approval preview must be checked against the exact completion lifecycle of the
Hermes revision being deployed; do not enable the route when the preview omits
run, dependency, workspace-cleanup, or lifecycle-hook effects.

## Google and Microsoft are optional and read-only

Provider OAuth is disabled unless `APP_BASE_URL`, an owner-only token-encryption
key file, and at least one provider client file are mounted into the runtime.
Do not put those files in this repository, an image layer, a Compose file, or a
Docker environment variable. `compose.yaml` binds each named host file
read-only at a fixed container path, so the application never receives a whole
Hermes credential directory.

The operator-owned production Compose file must preserve the same three-file
contract at `/run/secrets/fox-focus/google-client.json`,
`/run/secrets/fox-focus/microsoft-client.json`, and
`/run/secrets/fox-focus/token-key`. Each mount must be a read-only file bind.
If a provider is intentionally unconfigured, mount a non-secret `{}` placeholder
for that provider rather than omitting the target. Jenkins validates this
rendered mount map before replacing the running app and stops the deployment if
the data volume, Hermes mount, or any OAuth mount changes its expected access.

The exact Google/Entra registration and private environment shape are in
[Google and Microsoft connections](integrations.md). The production callback
host must be the canonical HTTPS URL; never derive it from a request Host
header. Reuse an OAuth client registration only if it is a Web client with the
exact Fox Focus callback registered. Hermes refresh tokens are neither mounted
nor reused.

Connected providers poll every 15 minutes. The worker only makes provider
reads: a rolling calendar-context window and task-list snapshots. It does not
use public webhooks or perform calendar/task mutations. A refresh-token failure
marks that provider as requiring reconnection without touching local workspace
data or another provider connection.

Microsoft sign-in uses the `consumers` authority. The person who connects can
use an ordinary personal Outlook, Hotmail, or Microsoft account. Microsoft
still requires the operator to create an Entra app registration configured for
personal Microsoft accounts; deploying this repository cannot create or infer
that client registration.

## SQLite and backups

The workspace opens SQLite with WAL mode, full synchronous writes, and a five-second busy timeout. WAL mode lets readers continue during short writes, but it does not make SQLite a multi-writer database. Keep one app replica and keep the database, `-wal`, and `-shm` files on local disk. Do not use an NFS or SMB share for the live database.

Back up a running database with SQLite's online backup API or `VACUUM INTO`. Validate the result with `PRAGMA quick_check`. Do not copy only `focus.sqlite` while WAL mode is active, because recent transactions may still live in the sidecar file.

Before a destructive restore or a volume deletion, stop the container and make a verified copy. `docker compose down -v` deletes the workspace volume and the generated password.

## Push notification keys

The first startup creates `/data/vapid.json` with mode `0600`. Keep this file in the data volume and back it up with the SQLite workspace. Restoring the database without the same VAPID keys invalidates existing browser subscriptions.

On iPhone and iPad, add Fox Focus to the Home Screen before enabling device notifications. iOS does not offer Web Push permission to a regular browser tab.

## Deployment checks

After deploying a new image, check the container health endpoint locally and verify that anonymous requests to the workspace API receive `401`. Then sign in normally and make a small local edit to confirm the data volume is still mounted.

GitHub Actions validates the source independently, but Jenkins is the release authority. A `main` push reaches Jenkins through its GitHub webhook, with a ten-minute source poll as a missed-webhook fallback; Jenkins builds its own image, runs tests, starts an isolated candidate, then deploys only the app container. This keeps deployments available when GitHub Actions or GitHub Container Registry is unavailable. It uses an operator-owned Compose specification so source changes cannot replace the persistent data volume or Hermes mount, and it must not recreate either those resources or a separately managed reverse proxy or tunnel.

No release process should package the SQLite file, password file, Hermes database, or provider credentials into an image or repository.
