# Fox Focus sync plugin

Do not install this directory by itself. It depends on the paired scoped-action
and durable-receipt changes in Hermes, and those changes must be forward-ported
and tested against the current Hermes release first. Before enabling the route,
make the Fox confirmation describe every completion side effect in that exact
Hermes revision.

This is a backend-only Hermes user plugin. It exposes one route:

`POST /api/plugins/fox-focus-sync/task-completion`

The board is fixed server-side to `personal-tasks`. A request cannot select
another board or mutate titles, bodies, assignees, priorities, or scheduling.

Install this directory as `$HERMES_HOME/plugins/fox-focus-sync`, enable
`fox-focus-sync` in the Hermes plugin allowlist, and create a random service
token at `$HERMES_HOME/secrets/fox-focus-action-token`. The token file must be a
regular file owned by the Hermes process user with mode `0600`; generate it
from at least 32 random bytes. Restart the dashboard after installation or
token rotation. Restart Fox Focus as well because it also reads the mounted
token once at startup.

The bearer token has only the `kanban:personal-tasks:complete` scope. The route
also requires an optimistic task-event version, a unique idempotency key, and a
human approval ID. Do not use the dashboard process session token for this
integration.

Request body:

```json
{
  "taskId": "t_0123456789ab",
  "expectedVersion": 42,
  "idempotencyKey": "fox-action-unique-id",
  "approvalId": "fox-checkbox-action-id",
  "change": {"status": "done"}
}
```

The success response returns the fixed board, exact safe `before` and `after`
task projections, the resulting `version`, and `replayed: true` for a repeated
identical idempotency key. A stale version returns HTTP 409 with `current` and
`currentVersion`; retry only after showing and reconfirming that new preview.
