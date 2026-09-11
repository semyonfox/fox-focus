# Hermes task sync request

Status: draft handoff only. Nothing in this repository sends it to Hermes or changes a Hermes board.

The `personal-tasks` board remains canonical until an explicit migration is approved. Fox Focus needs a safe way to show a proposed completion and, only after a human approves it, ask Hermes to apply that one change.

## Paste into Hermes

You own the Hermes kanban contract. Update it so Fox Focus can safely mirror selected task state and submit an approved completion change without reading or writing Hermes SQLite directly.

Keep `personal-tasks` canonical. Do not create duplicate Fox Focus cards. Do not apply a change merely because Fox Focus refreshed a feed.

Expose a documented REST or MCP contract with these properties:

1. Each task includes stable `taskId`, `boardId`, `listId`, optional `parentId`, `title`, `status`, `priority`, `createdAt`, `updatedAt`, `version`, and `deletedAt` when deleted.
2. List and parent identifiers are stable IDs. Do not infer them from task titles or task bodies.
3. Define status and priority meanings. Publish the precise mapping for a completion request, including whether `done` is the only completion status.
4. A completion mutation accepts `taskId`, `expectedVersion`, an idempotency key, and the requested status. It returns the before and after representation, including the new version and update time.
5. Reject stale versions with a conflict response that contains the current safe-to-display fields. Never silently overwrite a newer Hermes change.
6. Return deletion or archive tombstones through incremental reads so Fox Focus can remove stale mirrors.
7. Scope the client credential to the selected board and task-status mutation only. Do not expose private task bodies, result text, workspace paths, sessions, or direct database access.

The initial mutation must be intentionally narrow:

```json
{
  "taskId": "stable-hermes-task-id",
  "expectedVersion": "opaque-version-token",
  "idempotencyKey": "fox-focus-unique-request-id",
  "change": { "status": "done" }
}
```

Before accepting that request, Hermes must support Fox Focus showing this human-readable preview:

```text
Hermes / Personal Tasks
Task: <title>
Current: <current status>, version <current version>
Requested: done
Result if approved: task is completed in Hermes
```

Do not add a direct SQLite write path. Fox Focus must use this public contract, record the approved action, and refresh the source after a successful response.

## Fox Focus acceptance checks

- A read has no side effect.
- Repeating the same idempotency key completes the task once.
- A stale version produces a conflict, not a blind overwrite.
- A completion emitted in Hermes appears as `done` in the next Fox Focus refresh.
- Fox Focus never needs a Hermes body, result, filesystem path, or session identifier to render or complete a task.
