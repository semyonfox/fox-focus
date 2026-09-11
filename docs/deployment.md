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

## Hermes is optional and read-only

To show a Hermes Personal Tasks board, mount that board directory read-only and set `HERMES_KANBAN_DB` to its SQLite database path. Mount the database's WAL and shared-memory sidecar files with it. The adapter opens SQLite in read-only mode and returns task titles, status, numeric priority, derived update time, ownership, source list names, and parent task titles. It reads explicit source metadata from task bodies internally to recover list names; it never returns the bodies. Structure-only list headings appear as list buttons, not actionable tasks.

Visible list buttons switch directly between individual lists, including empty lists. My Tasks opens by default when present. Switching lists clears the search so items are not accidentally hidden. It does not copy Hermes records into local editable tasks. The Personal Tasks board remains canonical. Running without the mount simply leaves the Hermes panel unavailable.

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
