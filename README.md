# Fox Focus

Fox Focus is a private, self-hosted workspace for deciding what needs attention today. It brings local tasks, a simple timetable, reminders, reviewable incoming work, and a read-only view of Hermes activity into one page.

It is deliberately small. The point is not to build another project manager or to pretend that every service owns the same task. Fox Focus gives you a place to see the moving parts, capture something quickly, and decide what happens next.

## What works today

- Add, edit, schedule, prioritise, and complete local tasks.
- Add and edit local calendar blocks with colour-coded areas.
- Capture an Inbox item, review it, and ask for a draft or more work before turning it into action.
- Keep local data in a SQLite file, with revision checks that stop one browser tab from silently overwriting another.
- Show a read-only, human-readable feed from a Hermes Personal Tasks board when one is mounted. Hermes remains the source of truth.
- Run the app in one Docker container. It generates a password on first start and keeps data in a mounted volume.

The deployed personal instance is intentionally protected. It is not a public demo and it contains no sample workspace for visitors to browse.

## What is not built yet

Google Calendar, Google Tasks, Microsoft To Do, email capture, MCP, real notification delivery, accounts, and provider write-back are planned work. They are not hidden behind a half-finished button.

The proposed rules for those integrations are in [the architecture plan](docs/architecture-plan.md). In short, imported systems keep ownership of their records, and an external change will require a readable preview and human approval.

## Try it locally

The quickest path is Docker. This creates an empty, local workspace.

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

The source build stores local data in `./data` unless `DATA_DIR` is set. Open the same local address and retrieve `./data/workspace-password` from your own machine.

There is also a self-contained visual prototype for a phone or an offline design review:

```bash
pnpm bundle
```

It writes `dist/fox-focus.html`. That file has its own browser-only state. It does not connect to a server, Hermes, or any provider.

## How it is put together

```text
Browser
  -> React and Vite client
  -> Hono HTTP API
  -> SQLite workspace file

Optional Hermes board
  -> read-only adapter
  -> same Hono API
```

The current app is a static React client with a small Hono server. SQLite is a sensible fit for one self-hosted user and one app replica. It runs in WAL mode, which lets readers continue while a short write is happening, while still keeping one writer at a time. The app uses short, versioned writes and `synchronous=FULL` so a save is either committed or rejected as stale.

The server exposes only a prototype workspace API today:

- `GET /healthz` is an unauthenticated health check with no workspace data.
- `GET /api/v1/workspace` reads the local workspace.
- `PUT /api/v1/workspace` saves it when the supplied revision still matches.
- `GET /api/v1/hermes` reads the optional Hermes feed.

The workspace and API use HTTP Basic authentication in this first self-hosted release. That is a privacy gate, not a multi-user login system. Put it behind HTTPS if it leaves your machine or home network.

## Running a fuller self-hosted setup

`compose.yaml` adds a persistent SQLite volume and an optional read-only Hermes board mount. Set `HERMES_BOARD_DIR` and `HERMES_KANBAN_DB=/hermes/personal-tasks/kanban.db` when you have a board to show. You do not need Hermes, a tunnel, or a reverse proxy to run the Docker command above.

For a production-shaped setup, bind the app to loopback and put a TLS-terminating reverse proxy or private network access layer in front of it. See [self-hosting notes](docs/deployment.md) for the safety boundaries and backup guidance.

## Repository and release status

This repository is source-only. It must not contain workspace databases, WAL files, credentials, provider tokens, imported mail, Canvas material, or Hermes board data.

GitHub Actions independently validates pull requests and `main`. The homelab Jenkins job is the release authority: a push to `main` triggers Jenkins to build, test, check an isolated candidate, and deploy its local image; a ten-minute source poll recovers from a missed webhook. No release image is published to GitHub Container Registry, so a GitHub Actions or GHCR outage cannot prevent Jenkins from deploying a verified `main` commit.

## Where to look next

- [Architecture and delivery plan](docs/architecture-plan.md) explains the proposed Google, Microsoft, MCP, reminder, and data-ownership design.
- [Self-hosting notes](docs/deployment.md) cover the actual prototype's persistence, access boundary, and backup rules.
- `server/app.test.ts` and `server/hermes.test.ts` show the current API and Hermes-adapter behaviour.

## Project rules

- Imported services stay authoritative for their own records.
- The existing `personal-tasks` board remains canonical until an explicit migration is approved.
- Never commit credentials, private records, or database files.
- Any future external write needs a human-readable before-and-after approval record.
