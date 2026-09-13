# Fox Focus

Fox Focus is a private, self-hosted home for tasks and time. Open it, see what needs attention, and get on with the day.

It is intentionally smaller than a project manager. There are four working views:

- **Today** shows the current or next calendar item, roughly five useful tasks, due-soon work, and Inbox decisions.
- **Tasks** is the full task browser. A checkbox completes a task. Opening the rest of the row shows its details and editing controls.
- **Calendar** shows the day and upcoming schedule without mixing task management into the same long page.
- **Inbox** holds captures and agent proposals until you decide what they become.

Each view owns the page scrollbar. Task lists do not trap the user inside a second scrolling panel.

## Task ownership

Fox Focus is the canonical home for native personal tasks. The task model works without Google, Hermes, Microsoft, or any other provider.

A task can keep optional provenance and an external link. Those fields extend the local record. They never become a prerequisite for adding, editing, scheduling, or completing a task.

Optional code is not the same as runtime configuration. The local Docker command below leaves provider OAuth, Hermes credentials, and the legacy Hermes completion bridge off. Deploying a Fox Focus image does not create a Microsoft app registration, install the Hermes plugin, or add private mounts to an operator-owned production Compose file.

The Google Tasks bridge is deliberately narrow:

- A legacy Google task must be explicitly adopted before Fox Focus owns it.
- Adoption keeps an opaque Fox Focus connection generation, the stable Google list ID and task ID, the source ETag, and the last known state. The generation is not a verified Google account name or email address.
- Completing or reopening that adopted task can request the same status change in Google after an exact before-and-after preview and approval.
- Fox Focus checks the remote version, makes one status change, and reads the task back.
- A failed Google write leaves the local task completed or reopened. The external action remains visible for retry or conflict review.
- New Fox Focus tasks are never created in Google automatically.
- Fox Focus does not mirror edits, move tasks, clear completed tasks, or delete Google tasks.
- Assigned tasks from Google Docs or Chat import as read-only and never receive the completion bridge.

Completing a task is not deletion. Completed tasks remain in Fox Focus history, including after a Google refresh.

The existing Hermes `personal-tasks` board stays canonical until explicit live migration approvals begin. Shadow reads and adoption do not touch that board. Approving a Hermes adoption cuts over that one task; Hermes remains canonical for every task not yet adopted. When the same old task also exists in Google, the adoption preview can add the Google link to the existing Hermes-adopted Fox Focus task instead of creating a duplicate. After the final cutover, Hermes reads a safe Fox Focus task-status projection and submits suggested work to Inbox. It does not own or mutate the task list.

## What works

- Create, edit, schedule, prioritise, reopen, and complete local tasks.
- Keep completed tasks in local history.
- Add and edit local calendar blocks with Dublin-aware time handling.
- Capture an Inbox item, review it, and turn it into a task, calendar block, draft request, or no action.
- Store the workspace in SQLite with revision checks that stop one browser tab from silently overwriting another.
- Deliver opted-in Web Push reminders to subscribed devices, with in-tab reminders when push is unavailable.
- Install as a PWA on supported browsers.
- Mirror selected Hermes board data through the transitional read-only adapter when its database is mounted. Fox Focus can keep local planning annotations for an unadopted Hermes task.
- Prepare an approved completion for an unadopted Hermes task when the separately scoped legacy action bridge is installed. An adopted task cannot use that route.
- Adopt imported Google, Microsoft, or Hermes tasks through a preview and approval record.
- Complete or reopen an adopted Google task through an exact preview, approval, status-only patch, and readback.
- Connect Google Calendar and Tasks and Microsoft Calendar and To Do through server-side OAuth. Calendar and Microsoft records remain read-only.
- Let Hermes read a safe task-status projection and submit idempotent proposals to Inbox through a separate status token.
- Preserve stable provider identifiers and normalized provenance without returning private source bodies to the browser.
- Run the app in one Docker container with a generated password and persistent data volume.

The deployed personal instance is private. It is not a public demo and contains no sample workspace for visitors.

## Deliberate limits

Fox Focus has no general bidirectional sync. It does not send email, submit Canvas work, delete provider records, clear Google task lists, create provider tasks, or let an assistant approve an external action. Gmail capture, general MCP support, accounts, provider disconnect and revocation, and broader provider writes are later work.

Google Calendar, Gmail, Canvas, Microsoft, unadopted Google Tasks, and unadopted Hermes tasks remain authoritative for their imported records. Any external write needs a readable preview, explicit human approval, version checking, and a recorded result.

## Run locally

The quickest path is Docker. This creates an empty local workspace.

```bash
git clone https://github.com/semyonfox/fox-focus.git
cd fox-focus
docker build -t fox-focus .
docker volume create fox-focus-data
docker run --detach --name fox-focus \
  --publish 127.0.0.1:8789:8789 \
  --volume fox-focus-data:/data \
  fox-focus
docker exec fox-focus cat /data/workspace-password
```

Open `http://localhost:8789`, sign in as `fox`, and use the password from the final command. The password lives in the volume, so it survives a container restart. Do not share it or add it to the repository.

To stop the local container:

```bash
docker stop fox-focus
```

`docker rm fox-focus` removes only the container. Remove the `fox-focus-data` volume only when you mean to discard the workspace and its generated password.

### Build from source

Fox Focus needs Node 24 and pnpm 11.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm start
```

The source build stores local data in `./data` unless `DATA_DIR` is set. Open the same local address and retrieve `./data/workspace-password` from your machine.

For an offline visual review:

```bash
pnpm bundle
```

This writes `dist/fox-focus.html`. It has browser-only state and does not connect to the server, Hermes, or a provider.

## System shape

```text
Browser
  -> Today, Tasks, Calendar, Inbox
  -> Hono HTTP API
  -> SQLite workspace and action history

Optional Hermes board
  -> read-only 60-second poll
  -> persistent mirror + local planning annotations
  -> unadopted legacy tasks only
  -> same Hono API

Optional legacy Hermes action plugin
  <- one explicitly approved completion for an unadopted task
  <- separate, narrowly scoped service token

Optional Google / Microsoft connections
  -> server-held OAuth and encrypted tokens
  -> read-only calendar, Microsoft, and unadopted task imports
  -> completion-only Google bridge for explicitly adopted tasks

Optional assistants
  -> read-only task-status projection
  -> proposals into Inbox
```

The owner uses HTTP Basic authentication in this first self-hosted release. That is a privacy gate, not a multi-user login system. Put it behind HTTPS or a private network if it leaves your machine.

## Task API

- `GET /healthz` is an unauthenticated health check with no workspace data.
- `GET /api/v1/workspace` reads the local workspace.
- `PUT /api/v1/workspace` saves it when the supplied revision still matches.
- `GET /api/v1/hermes` reads the persisted Hermes mirror.
- `POST /api/v1/hermes/sync` requests a read-only mirror refresh.
- `PUT /api/v1/hermes/tasks/:taskId/annotation` saves Fox-owned planning details.
- `POST /api/v1/hermes/tasks/:taskId/complete` submits one confirmed completion for an unadopted task when the legacy action bridge is configured.
- `GET /api/v1/integrations` returns safe connection status and imported read-only records.
- `GET /api/v1/integrations/:provider/connect` starts OAuth; its callback consumes a one-time server state.
- `POST /api/v1/integrations/:provider/sync` performs an authenticated, read-only provider refresh.
- `GET /api/v1/task-status` returns the safe read-only projection used by Hermes.
- `POST /api/v1/task-proposals` adds an idempotent Hermes proposal to Inbox.
- `POST /api/v1/task-adoptions/preview` and `POST /api/v1/task-adoptions/:id/approve` adopt one imported task.
- `GET /api/v1/task-actions` lists status-write requests.
- `POST /api/v1/task-actions/preview` creates the exact completion or reopen preview.
- `POST /api/v1/task-actions/:id/approve` runs an approved request. `POST /api/v1/task-actions/:id/retry` retries an eligible failure.

All private routes accept the owner's Basic authentication. Only the status and proposal routes also accept the Hermes bearer token loaded from `HERMES_STATUS_TOKEN_FILE`. Fox Focus publishes no public API catalog, OpenAPI document, MCP endpoint, or `llms.txt`.

`compose.yaml` adds a persistent SQLite volume and an optional read-only Hermes board mount. Set `HERMES_BOARD_DIR` and `HERMES_KANBAN_DB=/hermes/personal-tasks/kanban.db` to show the old board during migration. Read-only mirroring and local annotations work without the legacy action bridge. That bridge stays disabled until its plugin, private endpoint, separate action token, and exact completion effects have been reviewed. You do not need Hermes, a tunnel, or a reverse proxy to run the Docker command above.

## Documentation

- [Architecture and delivery plan](docs/architecture-plan.md) defines the native task model, approval boundary, and staged rollout.
- [Task ownership and sync handover](docs/task-organisation-and-sync-handover.md) records the approved product behaviour.
- [Hermes task handover](docs/hermes-task-sync-request.md) defines the read-only status and proposal boundary.
- [Google and Microsoft connections](docs/integrations.md) covers OAuth, scopes, and the Google completion bridge.
- [Self-hosting notes](docs/deployment.md) covers persistence, private access, backups, and secret mounts.

## Project rules

- Fox Focus owns native tasks and their completion history.
- The existing `personal-tasks` board remains canonical until a separate live migration approval.
- Imported services stay authoritative for records that Fox Focus has not explicitly adopted.
- Never commit credentials, private records, provider tokens, or database files.
- Never perform an external write without an exact preview, approval record, and guarded execution.
- The legacy Hermes completion client applies only to unadopted tasks and stays disabled until its preview matches every completion effect in the installed Hermes release.
