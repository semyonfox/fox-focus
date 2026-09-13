# Task ownership and sync handover

Status: approved product direction, updated 13 September 2026. This approves implementation against fixtures and local data. It does not approve a live Hermes migration or unattended provider writes.

## Current implementation

- Today, Tasks, Calendar, and Inbox are separate views. Each uses the document scrollbar.
- Native tasks, local calendar blocks, completion history, Inbox decisions, reminders, and provider links persist in SQLite with revision checks.
- The calendar has day and upcoming modes. Local intervals use UTC instants and render in `Europe/Dublin`; invalid or ambiguous DST input is rejected.
- Google and Microsoft records import as provider-owned context. List-to-area mapping controls where imported task context appears.
- A Google, Microsoft, or Hermes task becomes native only through an explicit adoption preview and approval.
- An adopted Google link can request only completion or reopening through an exact preview, version check, approval, patch, and readback. No provider create, delete, clear, move, or general edit route exists.
- The mounted Hermes board remains a read-only mirror for unadopted tasks. Fox Focus stores local annotations, and the optional legacy action bridge can complete one unadopted task after confirmation. It is disabled unless its plugin, private endpoint, separate token, and full completion effects have been reviewed.
- Hermes can read the safe Fox Focus task-status projection and submit idempotent proposals to Inbox through a separate token.
- Opted-in Web Push reminders use persisted subscriptions and delivery records. In-tab reminders remain available when push is unavailable.

Code support does not grant permission to migrate live tasks or enable an external write. The board and each provider remain authoritative for every record Fox Focus has not adopted.

## The decision

Fox Focus is the native home for personal tasks. It must still work in full when Google, Hermes, Microsoft, Gmail, and Canvas are unavailable.

Imported data can add provenance, dates, and external links. It cannot define the core task model or force new features to depend on a provider.

The existing Hermes `personal-tasks` board remains canonical until explicit migration approvals begin. Approving a Hermes adoption cuts over that one task without changing the board. Hermes remains canonical for every task not yet adopted until the final checked migration completes. After cutover, Hermes reads task status from Fox Focus and sends proposed work to Inbox.

## The app should feel small

Use four real views instead of one long dashboard:

| View | Purpose |
| --- | --- |
| Today | A short home with the current or next calendar item, about five useful tasks, due-soon work, and Inbox decisions. |
| Tasks | The complete task browser with filtering, sorting, history, and task detail. |
| Calendar | Day and upcoming schedule context. |
| Inbox | One decision at a time for captures and agent proposals. |

Each view uses the document scrollbar. Do not put the task list inside a fixed-height scroller.

In Tasks, keep the information already useful in a row: title, category, deadline or planned time, state, and quiet source context. The checkbox completes or reopens the task. Clicking the rest of the row opens the task detail or editor. Edit and Schedule do not need to appear as full buttons on every row.

On a phone, the deadline stays visible. Secondary metadata can move into the opened task. Connection instructions stay hidden unless there is an error, conflict, or action that needs attention.

## Task model

The core task is provider-independent:

```text
task
  id
  title
  area
  state
  completed
  deadlineDate
  scheduledDate
  scheduledTime
  duration
  priority
  createdAt
  completedAt
```

Provider information is optional:

```text
external_link
  provider
  connectionId
  containerId
  externalId
  sourceVersion
  sourceStatus
  sourceUpdatedAt
  policy
  linkedAt
```

The link is embedded in its native task. `connectionId` is an opaque Fox Focus authorization reference, not a verified provider account name or email. `policy` is `read_only` or `completion_only`. A missing link means a normal native task, not an incomplete record.

Keep these ideas separate:

- Area says what the task concerns, using one of the app's shallow local choices such as `University` or `Personal`.
- Provenance says where it came from.
- An external link says which legacy provider record may receive an approved status change.
- Related material links to email, Canvas, a calendar event, or an agent run without copying its private body into the task.

## Local task behaviour

- New tasks are created only in Fox Focus.
- Editing a native task changes only Fox Focus.
- Completing a task records its completion locally and keeps it in Done.
- Reopening it changes the local state back to active.
- Deletion is a separate deliberate action. A checkbox never deletes a record.
- Provider refreshes cannot recreate, duplicate, or resurrect an adopted task.
- A task keeps working if every optional external link is removed.

There is no default Google or Microsoft task home. Do not create a dedicated provider list just because a local task exists.

## Adopting legacy tasks

Adoption changes ownership. It is not ordinary synchronization.

1. Import remote tasks as a read-only shadow using stable container and task IDs.
2. Reconcile duplicates, completion state, dates, and records missing stable IDs.
3. Show an adoption preview with the source record and the native task that Fox Focus will create.
4. When the record belongs to an existing native task, select that task as `targetTaskId` and preview adding the source link instead of creating a duplicate.
5. Record approval, then create the local task or add its optional external link once.
6. Keep the durable adopted-source mapping so later refreshes never create a second local task.
7. Export or back up the old canonical store before the live ownership cutover.

Adopting a Google task can grant its link the `completion_only` policy. Adopting a Hermes task does not create a Hermes write path. Once the Hermes migration cuts over, the old board becomes an archived source rather than an editable mirror.

The owner creates the preview with `POST /api/v1/task-adoptions/preview` and approves its returned ID with `POST /api/v1/task-adoptions/:id/approve`. A provider preview may include `targetTaskId` to add its link to an existing Fox Focus task, including one adopted from Hermes. The preview expires after 15 minutes. Repeated approval or a second preview cannot create another native task for the same stable source identity. Fox Focus refuses to guess when the same provider IDs were linked under an older connection generation, so the user must select the existing task and approve the relink.

## Google completion bridge

Only an explicitly adopted Google task may use the bridge. It supports two operations against the same external task ID:

- `needsAction` to `completed`
- `completed` to `needsAction`

The operation does not send the title, notes, due day, order, parent, or list back to Google. It never creates, deletes, clears, or moves a Google task.

Before a write, Fox Focus creates an action request that records:

- provider, opaque connection reference, list ID, task ID, and requested operation;
- exact human-readable before and after values;
- expected version or ETag;
- approval state and expiry;
- a stable idempotency key;
- attempts, verified result status and version, and any error or conflict.

The preview names the native task, opaque connection reference, provider list, provider task title and ID, current and requested statuses, and expected ETag. After approval, Fox Focus fetches the remote record again. A changed version stops the write and creates a conflict. An unchanged record receives one status patch, followed by a readback of the same task ID.

The owner uses `POST /api/v1/task-actions/preview`, followed by `POST /api/v1/task-actions/:id/approve`. `GET /api/v1/task-actions` reports the recent stored states or filters them by `taskId`. An eligible failure can use `POST /api/v1/task-actions/:id/retry`.

The local completion is not rolled back when Google is unavailable or rejects the write. A retryable failure can use the same action and idempotency key. A conflict or non-retryable failure needs a fresh preview of the current local state after any required refresh or reconnection. Every retry reads first. If Google already has the desired status, that read completes the action without another mutation.

Do not call Google Tasks `clear`. It hides completed tasks across a list and is wider than the approved action. Do not call delete. The importer detects assigned Docs or Chat tasks and gives them a read-only link, so the completion bridge rejects them.

## Hermes boundary

Hermes has two narrow jobs after cutover:

1. Read `GET /api/v1/task-status`.
2. Submit proposed work through `POST /api/v1/task-proposals` with an idempotency key.

The status projection contains only fields needed to answer questions such as what is active, due soon, planned, completed, or blocked. It does not expose notes, source bodies, provider tokens, filesystem paths, sessions, approval secrets, or raw provider payloads.

Hermes does not complete, reopen, edit, or delete Fox Focus tasks. It does not receive Google credentials. If Hermes thinks something should change, it submits an Inbox proposal for the user to review.

The current read-only Hermes SQLite adapter is a temporary migration aid. Never add a direct SQLite write path.

`HERMES_STATUS_TOKEN_FILE` points to the owner-only bearer-token file. That token works only on the two Hermes routes. Owner Basic authentication still works across the private API, and there are no public discovery endpoints.

## Rollout

1. The code now has real Today, Tasks, Calendar, and Inbox views with one scrollbar per page.
2. Native tasks, completion history, optional external links, adoption previews, and durable action requests persist locally.
3. Next, run shadow imports and reconciliation against selected read-only live sources.
4. Preview and approve adoption records. Verify that refreshes cannot duplicate adopted tasks.
5. Back up the Hermes board, briefly freeze task changes, reconcile once more, and request explicit cutover approval.
6. Make Fox Focus canonical and switch Hermes to the implemented read-only status and Inbox proposal routes.
7. Reconnect Google for the full Tasks scope, then test failure, retry, stale ETag, and readback before relying on the completion bridge.

Steps 5 and 7 affect live external state. They each need a separate human decision with the exact target and impact.

## Acceptance checks

- The Today view fits its core information without scrolling through the full task list.
- Desktop and phone layouts have one vertical scrollbar.
- The task title area opens details and the checkbox changes completion.
- New local tasks cause no Google or Hermes request.
- Repeating an adoption request does not create a duplicate task.
- Completing an adopted Google task changes only its status and only after approval.
- A stale ETag causes a conflict, not an overwrite.
- A failed upstream write leaves the local state intact and exposes an eligible retry or a fresh preview.
- A provider refresh never resurrects a completed or deleted local task.
- Hermes can read the safe status projection but cannot mutate tasks.
- Retrying the same Hermes proposal creates one Inbox item.
- Imported calendar, Gmail, Canvas, Microsoft, and unadopted Google records remain source-owned.

## Related documents

- [Architecture and delivery plan](architecture-plan.md)
- [Hermes task handover](hermes-task-sync-request.md)
- [Google and Microsoft connections](integrations.md)
