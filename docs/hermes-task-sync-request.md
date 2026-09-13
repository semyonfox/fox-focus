# Hermes task handover

Status: implemented on the Fox Focus side, without live migration approval. Fox Focus has the status and proposal routes, a persistent read-only Hermes mirror, local annotations, task adoption, and a fail-closed legacy completion client. The bundled plugin contract depends on matching Hermes changes that must be forward-ported and reviewed against the installed Hermes release. No production completion route is configured by this repository.

Fox Focus is becoming the canonical home for personal tasks. Hermes should read their status and propose new work. It should not keep a second editable personal task board or change Fox Focus tasks directly.

The existing `personal-tasks` board remains canonical until a separate migration approval. The current read-only SQLite adapter is a temporary source for shadow import and reconciliation.

During that transition, Fox Focus polls the mounted board on startup and every 60 seconds. It keeps a normalized mirror by stable Hermes task ID and can add Fox-owned planning and reminder annotations without changing the source. A failed read keeps the last good mirror.

There is one temporary compatibility write for tasks Hermes still owns. After an exact confirmation, the separately installed `fox-focus-sync` plugin can complete one unadopted `personal-tasks` item using a scoped token, optimistic version, idempotency key, approval ID, and durable receipt. Fox Focus blocks that route as soon as the task is adopted. The bridge does not edit titles, planning fields, or another board, and it must stay off until its preview names every completion effect in the installed Hermes release.

## Before cutover

Hermes needs to expose enough stable information for a safe migration, either through its public API or a deliberate export:

```json
{
  "taskId": "stable-hermes-task-id",
  "boardId": "personal-tasks",
  "listId": "stable-list-id",
  "parentId": null,
  "title": "Example task",
  "status": "todo",
  "priority": 2,
  "sourceKind": "direct_request",
  "sourceId": "stable-source-id-or-null",
  "sourceLabel": "My Tasks",
  "createdAt": "2026-09-01T09:00:00Z",
  "updatedAt": "2026-09-12T18:20:00Z",
  "version": "opaque-version-token",
  "deletedAt": null
}
```

- Keep task, board, list, parent, and source IDs stable.
- Define status and priority values explicitly.
- Include deletion or archive tombstones in an incremental read or final export.
- Do not make Fox Focus infer source grouping from a title or private task body.
- Do not expose task bodies, result text, workspace paths, sessions, provider credentials, or unrelated boards.

Preparing an adoption preview is read-only. Approving it cuts over only that Hermes task while leaving the board unchanged and canonical for every task not yet adopted. If a Hermes task also exists in the provider mirror, first adopt the Hermes task, then use the provider adoption preview's `targetTaskId` to attach that provider link to the same native task. This avoids a duplicate and keeps the provider action policy separate from Hermes provenance. Before the final live cutover, the operator must shadow-read and reconcile every remaining record, back up the board, validate the backup, briefly freeze changes, and compare the final source version of every task. The user must approve that exact set. Implementation work, previews, and fixture tests are not migration approval.

## After cutover

Hermes has two permitted capabilities.

### Read task status

Hermes reads `GET /api/v1/task-status` with a distinct bearer token. The response shape is:

```json
{
  "revision": 42,
  "generatedAt": "2026-09-13T10:15:00Z",
  "counts": {
    "open": 8,
    "completed": 4,
    "scheduled": 3,
    "waiting": 1
  },
  "tasks": [
    {
      "id": "fox-task-id",
      "title": "Example task",
      "area": "University",
      "state": "scheduled",
      "completed": false,
      "priority": "high",
      "deadlineDate": "2026-09-15",
      "dueLabel": "Tuesday",
      "planned": {
        "date": "2026-09-14",
        "time": "10:00",
        "timeZone": "Europe/Dublin"
      },
      "completedAt": null,
      "origin": "manual"
    }
  ]
}
```

The route returns an ETag based on the workspace revision and honors `If-None-Match` with `304 Not Modified`. It must not return notes, source bodies, raw provider payloads, external action details, filesystem paths, session identifiers, or credentials.

A status read has no side effect. Polling the same state must not create activity, tasks, or Inbox items.

### Submit proposed work

When Hermes finds something that may deserve action, it calls `POST /api/v1/task-proposals` with `application/json` instead of creating a task:

```json
{
  "idempotencyKey": "hermes-domain-renewal-2026",
  "title": "Renew the domain",
  "summary": "The renewal notice says it expires next month. Source reference: safe-stable-reference.",
  "area": "Admin"
}
```

`area` is optional and must match a Fox Focus area when supplied. The response reports `created` with status `201`, or `already_received` with status `200`, plus the Inbox item ID. The proposal appears in Inbox. The user can accept, edit, defer, dismiss, or ask for more work. A retry with the same idempotency key returns the original Inbox item.

Do not include a complete private email body or another provider's token in a proposal. Source text is evidence, not authorization.

## Forbidden capabilities

After adoption, Hermes must not receive an endpoint or tool that can:

- complete, reopen, edit, or delete a Fox Focus task;
- approve or execute a Google action;
- read task notes or private provider bodies by default;
- read or write the Fox Focus or Hermes SQLite file directly;
- create a Google or Microsoft task;
- bypass Inbox review.

If Hermes thinks an existing task should change, it submits a proposal that names the task and explains why.

The legacy completion plugin is not an exception for a Fox-owned task. It applies only while the specific task remains canonical in Hermes, and Fox Focus rejects it after adoption.

## Credential boundary

Create one random token of at least 24 characters in an owner-only file. A direct server run uses `HERMES_STATUS_TOKEN_FILE`; the supplied Compose file takes the host path through `HERMES_STATUS_TOKEN_FILE_HOST` and sets the internal path. Supply the same token to Hermes through its secret configuration. This repository configures only the Fox Focus side. The server reads it at startup and compares bearer tokens without storing the value in SQLite. Keep the file out of the repository, browser bundle, logs, database exports, and Hermes output.

The token works only for `GET /api/v1/task-status` and `POST /api/v1/task-proposals`. Owner Basic authentication also works. The app exposes no public discovery endpoints, API catalog, OpenAPI document, MCP endpoint, or `llms.txt`.

## Acceptance checks

- A status read changes nothing.
- The status response contains only the documented safe fields.
- A Hermes credential cannot call browser task mutations or external action approval.
- Repeating one proposal idempotency key creates one Inbox item.
- An Inbox proposal cannot become a task without a user decision.
- The final migration refuses a changed source version and produces a new preview.
- Every migrated task maps to one native Fox Focus ID.
- A post-cutover Hermes task refresh cannot resurrect or duplicate a Fox Focus task.
- No direct SQLite write path exists in either direction.
- The legacy completion route rejects an adopted task.
