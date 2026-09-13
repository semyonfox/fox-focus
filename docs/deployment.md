# Self-hosting Fox Focus

Fox Focus is one Node process with a SQLite workspace file. It does not need a database server, Redis, or a separate worker service for the current single-user deployment.

## Run it safely

Use the Docker quick start in the [README](../README.md) for a clean local install. It creates a named volume at `/data`. That volume holds `focus.sqlite` and the generated workspace password.

For access outside the host, bind port 8789 to loopback or a private network. Put a TLS reverse proxy, Tailscale, or another private access layer in front of it. Do not publish the container port directly to the internet.

The first startup creates a random password at `/data/workspace-password` with mode `0600`. Sign in with the fixed username `fox`. To choose your own password, replace that file with at least 24 characters and restart the container. This is a single-user privacy gate, not account management.

- `/` is the password-protected workspace.
- `/app` redirects to `/` for older bookmarks.
- Workspace, integration, task-status, proposal, adoption, and action APIs require authentication.
- `/healthz` is public and returns no workspace data.

## Hermes task mirror

Mount the Hermes Personal Tasks board directory read-only and set `HERMES_KANBAN_DB` to its SQLite database path. The directory mount must include any WAL and shared-memory sidecars. Fox Focus polls the source on startup and every 60 seconds, then upserts a normalized mirror by stable Hermes task ID. A failed or bounded read keeps the last good mirror. Task bodies never leave the adapter.

Hermes owns each unadopted task's title and completion status. Fox Focus can store area, due label, duration, planning, and reminder annotations against that stable ID. Google-backed cards use their `google-task:<external ID>` provenance to join the read-only provider record when the match is unambiguous. Fox Focus never deduplicates them by title.

The codebase also contains one optional legacy remote write for unadopted Hermes tasks. It uses a dedicated action route, a separately scoped bearer token, optimistic version checking, an idempotency key, a persisted approval record, and readback. If an HTTP result is lost while Hermes is waiting on its database, Fox Focus leaves the checkbox unchanged and reconciles the durable action receipt on later polls. An adopted task cannot use this route.

To configure the bridge, install [`integrations/hermes/fox-focus-sync`](../integrations/hermes/fox-focus-sync/README.md) as the Hermes user plugin, then set:

```dotenv
HERMES_ACTION_API_URL=http://host.docker.internal:9119/api/plugins/fox-focus-sync/task-completion
HERMES_ACTION_TOKEN_FILE=/run/secrets/fox-focus/hermes-action-token
HERMES_ACTION_TOKEN_FILE_HOST=/absolute/private/hermes-action-token
```

The token must carry only `kanban:personal-tasks:complete`. Do not reuse a dashboard session token. Compose maps `host.docker.internal` to the Docker host and mounts the token file read-only. Hermes's default loopback bind is not reachable from a bridge-network container. Run the dashboard on a host interface Docker can reach, then firewall port 9119 so only the Docker bridge and intended local clients can reach it. Restart Hermes and Fox Focus after token rotation because both read the token at startup.

Deploying the Fox Focus image alone does not enable legacy completion. The plugin runs in Hermes, and Jenkins uses an operator-owned production Compose file. Install and validate the plugin, token, private endpoint, firewall rule, environment values, and read-only token mount as one separate runtime change. The approval preview must describe every completion effect in the installed Hermes version, including run, dependency, workspace cleanup, and lifecycle hook effects. Leave the bridge off if it does not.

## Hermes status and proposal token

Keep the Hermes credential separate from the browser password. Set `HERMES_STATUS_TOKEN_FILE` to an owner-only file containing at least 24 characters. The server accepts that bearer token only for `GET /api/v1/task-status` and `POST /api/v1/task-proposals`. Supply the same token to Hermes through its own secret configuration. This repository configures only the Fox Focus side. The owner can use Basic authentication on every private route.

For the supplied Compose file, set `HERMES_STATUS_TOKEN_FILE_HOST` to the absolute host path. Compose mounts it read-only and sets the internal `HERMES_STATUS_TOKEN_FILE` path. For a direct container deployment, mount that one file read-only and set `HERMES_STATUS_TOKEN_FILE` to its container path. Do not pass the token value in the environment. Fox Focus publishes no API catalog, OpenAPI document, MCP endpoint, or `llms.txt`.

## Hermes migration boundary

The optional Hermes SQLite mount is a transitional read-only source. Mount the selected board directory read-only and point `HERMES_KANBAN_DB` at its database. The adapter must never open that database for writing or return task bodies, filesystem paths, sessions, provider tokens, or result text.

The existing `personal-tasks` board remains canonical until a separate cutover approval. Approving an adoption cuts over only that task and blocks it from the legacy completion route. Every unadopted task stays Hermes-owned. Do not change the board mount or status as part of an ordinary application deploy.

Before cutover:

1. Run shadow import and reconcile stable task IDs and states.
2. Create and validate a recoverable board backup.
3. Briefly freeze task changes and run a final comparison.
4. Show the exact adoption set and request approval.

After the final cutover, remove the board and legacy action plugin from the writable workflow. Hermes reads `GET /api/v1/task-status` and submits new suggestions through `POST /api/v1/task-proposals`. The read-only board mount can remain for a short audit period, then be removed in a separate deployment change.

## Provider secrets

Provider OAuth stays disabled unless `APP_BASE_URL`, an owner-only token-encryption key file, and at least one provider client file are mounted. Keep these out of the repository, image layers, Compose environment values, and database backups:

```text
/run/secrets/fox-focus/google-client.json
/run/secrets/fox-focus/microsoft-client.json
/run/secrets/fox-focus/token-key
```

Each path is a read-only file bind, not a directory. If the deployment contract requires a provider target while that provider is disabled, mount a non-secret `{}` placeholder. Never mount or reuse Hermes refresh tokens.

Connected providers poll every 15 minutes. Scheduled refreshes read a bounded calendar window and complete task-list snapshots. They never trigger Google status write-through. A refresh-token failure marks that provider as needing reconnection without changing the workspace or another connection.

The production callback host must be the configured HTTPS origin. Do not derive it from the request Host header. A reused OAuth registration must be a Web client with the exact Fox Focus callback.

Google Calendar and Microsoft connections remain read-only. The current Google connection requests the full `https://www.googleapis.com/auth/tasks` scope because the guarded completion bridge is implemented. Its two calendar scopes remain read-only. Existing Google connections with only `tasks.readonly` need to reconnect. A reconnect creates a new opaque connection generation, and any older import that finishes late is discarded. See [Google and Microsoft connections](integrations.md).

The wider OAuth grant does not widen server behavior. Google writes still require an adopted task, `POST /api/v1/task-actions/preview`, and owner approval through `POST /api/v1/task-actions/:id/approve`. Test it first with a disposable task and inspect the recorded request. New native tasks must not produce a provider request.

The first run of this release authenticates an older token envelope and immediately reseals it against the new opaque connection generation. Rolling back to an image from before that migration cannot open the resealed token. The workspace and provider records remain intact, but Google and Microsoft may need to be reconnected after that rollback. Treat this as an explicit first-rollout tradeoff and verify connection state after any rollback. Jenkins reports the provider state after an automatic rollback when the older image exposes the integrations endpoint; otherwise inspect it manually.

Microsoft sign-in uses the `consumers` authority. The person who connects can
use an ordinary personal Outlook, Hotmail, or Microsoft account. Microsoft
still requires the operator to create an Entra app registration configured for
personal Microsoft accounts; deploying this repository cannot create or infer
that client registration.

## SQLite and backups

The workspace opens SQLite with WAL mode, full synchronous writes, and a five-second busy timeout. Keep one app replica and place the database, WAL, and shared-memory files on local disk. Do not use NFS or SMB for the live database.

Back up a running database through SQLite's online backup API or `VACUUM INTO`. Validate the result with `PRAGMA quick_check`. Copying only `focus.sqlite` while WAL is active can omit recent transactions.

The database contains native task history, adoption decisions, provider mirror records, opaque connection generations, and external action records. It does not establish a verified provider account name or email. The separate token-encryption key is required to use encrypted OAuth tokens after restore, so back it up through the existing secret-management process. Do not put it in the same archive as a database shared for debugging.

Before a destructive restore or volume deletion, stop the container and make a verified copy. `docker compose down -v` deletes the workspace volume and generated password.

## Push notification keys

The first startup creates `/data/vapid.json` with mode `0600`. Keep this file in the data volume and back it up with the SQLite workspace. Restoring the database without the same VAPID keys invalidates existing browser subscriptions.

The server records subscriptions and per-fire-time deliveries in SQLite, then checks due reminders once a minute. Delivery is best effort. In-tab reminders still work while the page is open, even if Web Push is unavailable or disabled.

On iPhone and iPad, add Fox Focus to the Home Screen before enabling device notifications. iOS does not offer Web Push permission to a regular browser tab.

## Deployment checks

After deploying a new image:

1. Check `/healthz` locally.
2. Verify anonymous workspace and task-status requests receive `401`.
3. If `HERMES_STATUS_TOKEN_FILE` is configured, verify its bearer token can read task status and submit a proposal but receives `401` from adoption and action routes.
4. Sign in and make one local task edit.
5. Confirm the task survives a restart and that no provider request occurred.
6. Inspect integration freshness and any pending, failed, or conflicting action.
7. If the Google bridge changed, repeat the disposable-task approval and readback test before using a real adopted task.
8. If the legacy Hermes bridge is configured, verify an approved unadopted completion and confirm an adopted task receives `409` from that route.
9. If Web Push changed, subscribe a disposable browser, fire one reminder, and confirm the same reminder is not delivered twice.

GitHub Actions validates source independently. Jenkins remains the release authority. A `main` push reaches it through a GitHub webhook, with a ten-minute source poll as a missed-webhook fallback. Jenkins builds its own image, runs tests, checks an isolated candidate, and replaces only the app container. It does not depend on an image published to GitHub Container Registry.

The operator-owned Compose specification protects the data volume, read-only Hermes mount, and secret file mounts from source changes. Jenkins compares those mounts before and after replacement and rolls back the app container if its runtime checks fail. It does not recreate the reverse proxy, tunnel, database volume, or Hermes board.

No release process should package the SQLite file, password file, VAPID private key, Hermes database, Hermes token files, provider credentials, private source material, or decrypted token into an image or repository.
