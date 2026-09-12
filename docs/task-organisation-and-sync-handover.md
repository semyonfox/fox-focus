# Task organisation and sync handover

Status: approved product direction and historical implementation handover. Since this checkpoint, Fox Focus has added provider tasks to the main browser, durable Web Push, local annotations for mirrored Hermes tasks, and a fail-closed Fox-side Hermes completion client. The completion backend is not configured and must not be enabled until its full effects match the approval preview. Google and Microsoft remain read-only, and the Hermes board remains canonical. Use the README and deployment guide for current runtime behavior.

## Implementation checkpoint — 11 September 2026

This release establishes the focused daily workflow without changing task ownership or enabling external writes:

- The calendar opens one day at a time with a seven-day selector centred on the chosen day. `Upcoming` keeps the useful seven-day scan as a separate mode.
- The task browser opens on `All`, uses the existing top-level areas as category tabs, keeps counts inside a compact filter-and-sort control, orders local tasks by due date then newest creation time, and places completed work after active work.
- Local tasks remain click-to-complete. Hermes tasks share the browser and remain managed by Hermes. Current Fox code can show a second confirmation, but the checkbox remains disabled without the separately reviewed and configured action bridge.
- Inbox review presents one selected item at a time with previous and next controls, local task/calendar/draft/no-action outcomes, reversible handled state, and a local feedback note. No email or Hermes action is sent.
- Task capture starts with a title and deadline; area, priority, duration, planning, and reminder preview live under `More options`.
- The fixed header no longer changes position while scrolling, uses a slightly translucent surface, and reduces appearance selection to one icon with `System` as the default.
- New local calendar blocks store UTC instants and render against `Europe/Dublin`; dated and time-only legacy rows remain readable. Spring-forward gaps and fall-back ambiguities are rejected rather than silently shifted.
- Connections and reminder prototypes sit at the end of the working flow. Reminder controls are explicitly manual in-app previews because no scheduler or system-notification delivery exists yet.

The release now has provider tasks in the main browser, list-to-area mapping, durable reminder delivery, and the Fox side of a narrow Hermes approval API. It still needs a current-Hermes backend whose full effects match the preview, the persisted parent/child category model described below, a real Gmail-backed review source, provider write approvals, and authenticated real-account Microsoft validation. The existing Hermes board and each connected provider remain authoritative.

## The decision

Fox Focus should be the unified place to scan and organise tasks. It must organise them by what they mean to the user, not by where they arrived from.

Keep four concerns separate:

| Concern | Example | Main UI treatment |
| --- | --- | --- |
| Category | `University / Assignments`, `Personal / Purchases` | Prominent chip, colour, tab, and filter. |
| Source | Canvas notification, Gmail, Hermes, Google Tasks | Provenance in the task detail and a secondary filter. |
| Home | Hermes, Fox Focus, Microsoft To Do | Controls which system can accept a change. |
| Related material | Email thread, Canvas page, Hermes run | Links and context, never a duplicate task. |

A task may have several sources and related records, but it has exactly one home. The home is the system that owns status changes and edits. Fox Focus must not silently copy one task into multiple editable backlogs.

Use one visible, shallow category picker. Start with parent and child categories such as `University / Assignments` and `Personal / Purchases`. Do not add free-form tags, projects, or multiple categories in the first version. If a later workflow needs fields specific to assignments or purchases, add those deliberately rather than making the category system carry every concept.

## Browser behaviour

The task browser should default to `All` and use horizontally scrolling category tabs:

```text
All | University | Personal | Work | Admin | ...
Due | Added | More filters
```

The main row should show the check-off control, title, category, and useful time information. Source and home should be quiet metadata, for example in a detail drawer or under `More filters`.

`More filters` can contain source, managed-by system, state, and an optional Hermes workstream such as software, email, or storage. Hermes workstreams are useful context, but they are not the user's category system.

Remove implementation-status panels such as `saved to SQLite` and the current source-first overview from the task browser. Keep a small connection or sync indicator only for an error, a pending approved action, or a conflict that needs attention.

Use truthful time labels:

- Sort by `Due` when a task has a real deadline or a provider date-only due value.
- Call Google Tasks' date-only field `Do on`, not a timed deadline. Google documents that it stores only the date and discards the time portion.
- Sort provider records that lack a creation timestamp by `Added to Fox Focus`, not `Created`.
- Keep deadlines, planned task blocks, and calendar events separate. A task deadline must not automatically create a calendar event.

## Data direction

Do not merge imported records into the existing local workspace task JSON merely to make the browser look unified. Provider and Hermes records remain their own source records. Add a local classification and linking layer keyed by stable references.

The first useful shape is:

```text
categories
  id, name, parent_id, colour, sort_order

task_classifications
  task_reference, category_id, assigned_by, updated_at

external_links
  entity_id, provider, account_id, container_id, external_id,
  version_or_etag, source_updated_at, tombstoned_at

action_requests
  target, operation, before, after, expected_version,
  approval_state, idempotency_key
```

`task_reference` can point to a Fox Focus task, a Hermes card, or an imported provider task. This lets a user put an imported task in `University / Assignments` without claiming Fox Focus owns the remote task.

Allow a user to assign default categories to source containers, such as a specific Canvas module or a selected task list. An individual task override always wins. Do not infer a category from arbitrary titles, task bodies, or private email content. An agent may suggest a category as a draft, but the user must accept or change it.

## Completion and sync rule

Use a single-home rule:

- Fox Focus-owned task: complete locally.
- Hermes-owned task: show a compact before-and-after confirmation, then call Hermes' public task API.
- Provider-owned task: do the same only after that provider's write connection and approval flow exist.
- Read-only imported item: show it in the browser, but offer `Adopt into Fox Focus` or `Request completion` rather than a fake local completion state.

Inbound source changes may refresh automatically. Every outbound change needs a human-readable before-and-after preview, a fresh version check, an idempotency key where the target supports it, a post-write readback, and a visible conflict if the remote task changed first.

Do not build general automatic bidirectional sync. Start with explicit approved write-through for a selected, linked task. If bidirectional status sync is added later, limit it to linked tasks in one chosen external list and stop for review on any conflicting change.

## Provider decision

Do not select Google Tasks or Microsoft To Do as the default home yet. The `personal-tasks` Hermes board remains canonical until a migration is explicitly approved.

If an external default becomes necessary after that decision, use Microsoft To Do with one dedicated `Fox Focus` list. It is technically the better fit:

- Microsoft To Do has user-defined categories, created and modified timestamps, priority, richer status, start/due/reminder times, recurrence, linked resources, and per-list delta sync. [Microsoft To Do task resource](https://learn.microsoft.com/en-us/graph/api/resources/todotask?view=graph-rest-1.0) and [task delta](https://learn.microsoft.com/en-us/graph/api/todotask-delta?view=graph-rest-1.0)
- Google Tasks has title, notes, two states, parent/position, and a date-only due day. Its task resource has no category or priority field, and its listing API relies on polling filters such as `updatedMin`. [Google Tasks task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks) and [task listing](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list)

Microsoft categories are mailbox-wide Outlook categories. If the bridge later maps categories out, use namespaced values such as `Fox Focus / University`. Do not create master categories automatically or request mailbox-settings permission solely to style them. Keep a category local when no exact mapped Outlook category exists.

Both providers need broader delegated write consent to write tasks. Start with one dedicated list, approved create/complete/reopen actions, and an explicit mapping. Do not mirror the same task into both Google and Microsoft.

## Hermes requirements

The current read-only SQLite adapter is enough for a mirror but not for safe completion. Hermes needs a documented REST or MCP contract before Fox Focus can check off Hermes work.

The read contract needs stable task, board, list, and parent IDs; status; priority; source projection; created and updated times where available; an opaque version; and deletion or archive tombstones. Hermes should publish source fields such as `sourceKind`, `sourceId`, and `sourceLabel` as provenance. It should not make Fox Focus parse task bodies to classify tasks.

The completion contract needs a narrow status change with:

```json
{
  "taskId": "stable-hermes-task-id",
  "expectedVersion": "opaque-version-token",
  "idempotencyKey": "unique-action-id",
  "change": { "status": "done" }
}
```

Hermes must return the safe before-and-after representation, reject stale versions, and support an incremental feed with tombstones. Fox Focus must never write Hermes SQLite directly.

## Rollout order

1. Replace source-first navigation with the category-first unified browser.
2. Add local categories and classifications for local, Hermes, Google, and Microsoft task references. This step has no external writes.
3. Add source-container defaults and individual category overrides.
4. Agree and implement the Hermes public task contract. Keep Hermes read-only until it exists.
5. Run a shadow import and reconciliation for `personal-tasks`. Export and briefly freeze changes before any explicit ownership cutover.
6. If Fox Focus becomes the home for new personal tasks, add one opt-in Microsoft To Do bridge with approved write-through.
7. Consider narrow, conflict-aware status sync only after daily use proves the model.

## Existing constraints to preserve

- Google Calendar, Gmail, Canvas, and imported task providers remain authoritative for their imported records.
- Email, Canvas, and social findings should begin as Inbox items or linked material. They do not become tasks automatically.
- Store instants in UTC, render in `Europe/Dublin`, and keep date-only values as `YYYY-MM-DD`.
- Preserve provenance and stable external identifiers. Do not store raw private source bodies only to support categorisation.
- The existing `personal-tasks` board remains canonical until an explicit migration approval.

## Related documents

- [Architecture and delivery plan](architecture-plan.md)
- [Hermes task sync request](hermes-task-sync-request.md)
- [Google and Microsoft connections](integrations.md)
