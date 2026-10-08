# Fox Focus

Fox Focus is a private, self-hosted task and time app. Google Tasks is the task home; Fox Focus adds local planning, reminders, a calm Today view, read-only calendar context, and a terse Inbox for email decisions and work handed to Hermes.

The four views are:

- Today for the next calendar context, a short task list, deadlines, and a collapsed briefing;
- Tasks for active and completed Google-backed tasks with local planning;
- Calendar for unified day, week, and month views of provider events and local blocks, with a current-time line on the hourly grid;
- Inbox for manual review with a selected item’s details and controls, separate Automations and History, and explicit access to existing work threads.

Task lists use the page scrollbar. Calendar keeps its date controls above a scrollable hourly grid.

## Ownership and safety

Google Tasks owns task content and completion, including new tasks created through Fox Focus. Fox Focus owns local planning, deadlines, reminders, Inbox decisions, and execution records. Pending Google creations are commands awaiting confirmation, not local-only tasks. Google Calendar, Gmail, and Canvas remain authoritative for their records.

The existing Hermes `personal-tasks` board remains canonical until the owner separately approves and verifies its live migration. The migration flow is built, but no live migration is implied by installing this version.

An owner checkbox click approves completing or reopening the displayed Google task. Fox Focus records the exact status change and ETag, applies only that status change, and reads the task back. New tasks show their Google account, destination list, and outgoing fields before approval. A nonce in the notes prevents a lost create response from causing a blind duplicate.

Email sending is off by default. When enabled, the owner approves one immutable reply envelope; Hermes builds MIME and returns a receipt bound to the stored payload hash. An uncertain send becomes reconciliation-only and can never be resent by Fox Focus.

Fox Focus has no provider delete, Google move or clear, calendar write, Microsoft write, Canvas submission, direct Gmail access, assistant settlement, or Hermes database write path.

## What is implemented

- Strict SQLite rows for tasks, plans, Inbox items, immutable draft revisions, durable actions, jobs, job updates, reminders, changes, freshness, and daily briefings.
- Google task imports with complete per-list snapshots, per-list and per-calendar failure isolation, source IDs, ETags, notes, parent, and position.
- Google task creation for manual, Inbox, and briefing flows, with `Fox-Focus-ID` nonce reconciliation.
- Click-approved completion and reopening through a leased worker, `If-Match`, readback, restart recovery, superseding intents, and conflict review.
- A T3 Code-style Inbox with message-ID identity, owner-protected drafts, explicit decisions, keyboard actions, and likely-noise rows kept available.
- Hermes jobs with short progress, one-line questions and answers, owner review, send-back, accept, and drop. Hermes cannot settle a job or complete a linked task.
- Guarded email-send actions with exact envelopes, deterministic hashes, receipts, and unknown-outcome reconciliation. `EMAIL_SEND_ENABLED` defaults off.
- Expiring news and event briefings on Today. Save as task uses normal Google creation; Remind me also creates a local timed reminder.
- Read-only Google Calendar, Microsoft Calendar, and Microsoft To Do adapters. Microsoft controls stay hidden from daily views while unconfigured.
- An owner-facing, resumable migration preview for native Fox tasks and `personal-tasks` board items. It is built and fixture-tested, not run against live data.
- Web Push reminders, an installable PWA, and an offline visual bundle.

## Inbox review

Recommendations contain an outcome, reason, and next step. Accept saves a local review decision and optional note; it does not create a task, send a message, approve a job, or add a reminder. Existing work controls remain available separately. Review metadata is stored in the workspace against the exact Inbox row ID; source and execution records keep their current ownership.

Confirmed event expiries move to local History after 24 hours by default. Per-item rules can change the expiry, grace period, or destination, or disable the move. Restoring an item disables its rule. Expiry runs while the app is open and catches up when the workspace loads. Suggested dates and overdue task deadlines never trigger it.

`PUT /api/v1/inbox/:proposalKey` and the compatibility `POST /api/v1/task-proposals` accept optional `lane` (`review` or `automation`), `recommendation` (`outcome`, `reason`, `nextStep`), and `existingHermesTaskId`. Outcomes are `noise-reference`, `awareness`, `proposed-commitment`, `existing-task-update`, and `needs-decision`. Existing Personal Tasks references are displayed only when verified against the connected feed.

Optional `sourceContext` includes `provider`, `externalId`, `timing` (`confirmed` or `suggested`), and optional `startsAt`, `endsAt`, `dueAt`, `dueOn`, `expiresAt`, and short `evidence`. Instants are normalized to UTC. Exact Google/Microsoft matching also requires `containerId` and `connectionId`; refreshed event boundaries replace stale times without title matching. A distinct confirmed expiry is retained.

## Run locally

The shortest path creates an empty local workspace without provider or Hermes configuration:

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

Open `http://localhost:8789` and sign in as `fox` with the generated password. The password remains in the volume across container restarts. Do not share or commit it.

To stop the container:

```bash
docker stop fox-focus
```

Removing the container does not remove the named volume. Remove that volume only when you intend to discard the workspace and generated password.

### Build from source

Fox Focus needs Node 24 and pnpm 11.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm start
```

The source build stores data in `./data` unless `DATA_DIR` is set. Retrieve the generated password from `./data/workspace-password`.

For an offline visual review:

```bash
pnpm bundle
```

This writes `dist/fox-focus.html`. It uses browser-only state and does not connect to the server, Hermes, or providers.

## System shape

```text
Browser owner
  -> Today, Tasks, Calendar, Inbox
  -> Basic-authenticated Hono API
  -> SQLite rows, immutable approvals and action payloads, and ordered changes

Google OAuth
  -> full paginated task-list snapshots and bounded calendar reads
  <- approved task creates and status-only changes

Hermes bearer API
  -> context and ordered changes
  <- Inbox upserts, job updates, email receipts, and briefings
  -> no owner decisions and no direct database access

Microsoft OAuth
  -> read-only calendar and To Do imports

Legacy personal-tasks bridge
  -> read-only during the unrun migration
```

The owner API uses HTTP Basic authentication in this single-owner release. Put it behind HTTPS or a private network if it leaves the local machine. Hermes uses one separate bearer token accepted only on its six documented routes.

## Primary APIs

- `GET /healthz` is the unauthenticated health check.
- `GET /api/v1/rows` returns current row state and feature capabilities.
- `GET /api/v1/task-destinations` and `POST /api/v1/tasks` drive approved Google creation.
- `POST /api/v1/tasks/:taskId/status` records an approved completion or reopen.
- Inbox item, draft, send, and job routes are owner-only.
- Migration preview, approval, and status routes are owner-only.
- Hermes uses only `GET /api/v1/context`, `GET /api/v1/changes`, `PUT /api/v1/inbox/:proposalKey`, `POST /api/v1/requests/:id/claim`, `POST /api/v1/requests/:id/result`, and `PUT /api/v1/briefings/:day`.

Compatibility workspace, mirror, annotation, adoption, old task-action, task-status, and task-proposal routes remain until the live migration is verified. They are not the current ownership path. Fox Focus publishes no public API catalog, OpenAPI document, MCP endpoint, or `llms.txt`.

## Documentation

- [Architecture](docs/architecture-plan.md)
- [Task ownership and workflow handover](docs/task-organisation-and-sync-handover.md)
- [Hermes integration contract](docs/hermes-task-sync-request.md)
- [Provider setup and boundaries](docs/integrations.md)
- [Self-hosting notes](docs/deployment.md)

Anonymous usage collection is off by default. A web build requires both
`VITE_ANONYMOUS_STATS_ENABLED=true` and an owner-provided
`VITE_ANONYMOUS_STATS_ENDPOINT` ending in `/v1/events`. Use HTTPS or a relative
path to a separately configured same-origin proxy. No endpoint is preselected.
The Sources drawer provides an opt-out; Global Privacy Control, Do Not Track,
and unreadable preferences also stop collection. Android collection remains off.

The optional payload contains only version, app, kind, fixed event name, surface,
and a fixed route category. It carries no task, email, account, input, URL, error
message, stack, identifier or exact timestamp. Requests omit credentials and
referrers, reject redirects, time out after two seconds, and have no retries or
persistent queue. Limits are 20 events per minute, 200 per app lifetime and one
request in flight, with repeated error categories suppressed for one minute.
The separate collector must discard raw events and request metadata, retain only
UTC daily aggregates for 30 days (counts) or 14 days (errors), and disable request
logs before collection is enabled. No collector is deployed by this project.
