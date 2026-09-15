# Fox Focus architecture

Status: implementation contract, updated 14 September 2026. Phases 1 through 6 are built and tested against fixtures. No live task migration or provider verification was performed.

Fox Focus is a private, single-owner task and time app. Google Tasks is the task home. Fox Focus adds local planning, a small daily view, a work Inbox, reminders, and read-only calendar context.

## Ownership

| Record | Authority | Fox Focus responsibility |
| --- | --- | --- |
| Task content, list, completion, and do-on date | Google Tasks | Cache and owner-approved create or status commands |
| Pending task creation | Fox Focus action | Show the command until Google identity is confirmed |
| Priority, waiting, deadline, plan, and reminder | Fox Focus | Store local fields against the stable task ID |
| Google Calendar event | Google Calendar | Read-only context with scope freshness |
| Existing local time block | Fox Focus | Keep the local schedule |
| Email and sent message | Gmail | Store structured references, draft revisions, approved send envelopes, and receipts |
| Inbox decision and delegated work | Fox Focus | Keep versioned owner decisions and job history |
| `personal-tasks` during migration | Hermes | Read-only reconciliation source |
| Briefing source entry | Source publisher | Store the versioned Hermes snapshot; owner controls create tasks and reminders |

The existing `personal-tasks` board remains canonical because its live migration has not been approved or run. The migration code does not change ownership by itself.

Area is not copied into each task row. Fox Focus derives it from the Google list through `listAreas`. Creation uses the mapped destination list and falls back only to the real My Tasks list ID returned for the connected account.

## Application shape

The browser has four views:

- Today shows the current calendar context, a short task list, deadlines, and a collapsed briefing card.
- Tasks shows all current and completed tasks. The checkbox completes or reopens a Google task.
- Calendar shows read-only provider events and existing local time blocks.
- Inbox uses one compact thread list with Needs you, Working, and collapsed Settled groups. Likely-noise items stay available in a collapsed group.

Inbox detail shows the selected item or job, its draft where relevant, its update timeline, and the actions that apply. It is a handoff loop, not a chat transcript. Each view uses the page scrollbar.

## Storage

SQLite stores mutable records as rows rather than rewriting the whole workspace document:

| Table | Contract |
| --- | --- |
| `tasks` | Stable internal ID and legacy, pending, or Google binding |
| `task_plans` | One independently versioned local plan per task |
| `inbox_items` | Structured source identity and owner-controlled state |
| `reply_drafts` | Immutable owner or Hermes revisions |
| `actions` | Immutable approved command and operation key, plus versioned execution state, lease, receipt, and error |
| `jobs` | Current delegated-work state and optional task or Inbox link |
| `job_updates` | Immutable short progress, question, answer, result, send-back, and settlement entries |
| `reminders` | Local scheduled, fired, or cancelled reminder |
| `changes` | Ordered immutable snapshots and tombstones with mutation identity |
| `sync_state` | Freshness, coverage, connection generation, and errors per provider scope |
| `briefings` | One versioned daily briefing with expiry and source entries |

These tables are `STRICT` and use foreign keys and checks. Domain mutations commit with immutable change snapshots; freshness is held separately in `sync_state`. Provider records, OAuth state, push subscriptions, and compatibility records remain in their existing tables. The legacy workspace document remains only for data that has not moved, including local calendar blocks and compatibility flows. Task and Inbox routes no longer rewrite it.

All instants are UTC. Date-only values use `YYYY-MM-DD`. The UI renders time in `Europe/Dublin` and rejects nonexistent or ambiguous local wall times.

## Google task commands

### Completion and reopening

The displayed task and its checkbox are the preview. The owner's click is approval, so there is no second dialog.

The same SQLite transaction records the local intent, immutable approved command payload, expected task version, expected Google ETag, before and after status, and approval time. The in-process worker claims the versioned action with a lease, uses `If-Match` when an ETag exists, and reads the same Google task back. Local intent stays distinct from confirmed remote state.

A changed remote record becomes a visible conflict. A newer owner intent supersedes an older queued or failed action. It cannot overtake an action that may already have reached Google. Startup and polling recover expired leases.

### Creation

All new manual, Inbox-derived, and briefing-derived tasks target Google Tasks. Before creation, the UI shows the account, destination list, title, notes, and do-on date. The destination comes from `listAreas`, with the connected account's real My Tasks ID as fallback.

Fox Focus writes `Fox-Focus-ID: <nonce>` as its own line in the approved notes. It submits a create once, stores the returned Google identity, and verifies a readback. A timeout or crash after dispatch makes the action `unknown`. Reconciliation searches for the exact nonce. One match binds the pending row, several matches require review, and no match stays unknown. None of those cases permits a blind second insert.

Fox Focus does not edit Google titles, notes, dates, parents, positions, or lists after creation. It never deletes, moves, clears, or bulk-completes Google tasks. Assigned Docs and Chat tasks remain read-only.

## Imports and freshness

Google task lists use complete paginated snapshots. Delta results are never passed to code that deletes rows absent from a full snapshot. Imports retain notes, parent, position, source URL, version, and stable account, list, and task identities.

Each Google task list and Google calendar publishes independently with its own timeout and freshness row. Failure in one Google scope leaves its previous rows in place and does not stop another scope from becoming fresh. Connection-generation checks reject results from an authorization that has since been replaced. Google task writes serialize with snapshot publication for the same list.

Google Calendar and Microsoft data remain read-only. Microsoft still uses its legacy provider-wide refresh. The Microsoft adapter stays in the codebase, but daily views hide its controls while it is unconfigured.

## Inbox and jobs

Email Inbox identity is account plus message ID. Thread ID remains context, so a later message in a resolved thread can create a new item. Hermes may append a draft revision but cannot replace an owner revision, an approved send draft, or owner decision fields.

Inbox outcomes are `sent`, `task`, `dismissed`, `noise`, and `read`. Sending and task creation have dedicated approval paths. Snooze keeps an item waiting until its UTC instant. Noise is feedback, not a Gmail spam or delete operation.

A job moves through this owner-controlled sequence:

```text
queued -> working
working -> needs_you -> working
working -> review
review -> queued     owner sends it back
review -> settled    owner accepts or drops it
```

Hermes can claim a job, add progress, ask one short question, or submit a result. It cannot settle a job. Accepting a job linked to an open task counts as the owner's completion click and queues the normal Google status action.

## Email sending

Fox Focus has no Gmail client. The owner approves the current immutable reply envelope, and Hermes builds and sends MIME from that envelope. Fox Focus stores no MIME.

An email action stores account, thread, reply-to message ID, `In-Reply-To`, references, from, to, cc, bcc, subject, body text, draft ID, and a deterministic payload hash. While the action is queued, running, or unknown, Fox Focus blocks draft edits, Inbox decisions, and Inbox-to-task creation.

Hermes claims a queued action in `send` mode. If its lease expires after dispatch might have started, Fox Focus records `unknown`. Every later claim is `reconcile`, even when new sending is disabled. It never authorizes another send. A successful receipt must echo the approved hash and identify a new provider message in the approved thread. Receipt storage and the Inbox `sent` transition are one transaction.

`EMAIL_SEND_ENABLED` defaults off. Setting it to `true` also requires `HERMES_STATUS_TOKEN_FILE`; otherwise startup fails. Leave it off until the Hermes executor has been checked against the exact hash and MIME contract.

The full hash contract is in [the Hermes integration contract](hermes-task-sync-request.md).

## Briefing

Hermes may publish one expiring briefing for a Dublin date. It contains short news and event entries with optional HTTPS source URLs and optional UTC event times. Today shows it as a small collapsed card rather than creating Inbox items.

"Save as task" goes through the normal Google creation flow and shows the destination before approval. "Remind me" creates the same Google-bound task and a local timed reminder. The source entry itself remains provider-owned.

## API boundaries

The browser uses owner Basic authentication. The row API includes task planning and status, task creation and destinations, Inbox decisions and drafts, owner email approval, job creation and settlement, and migration preview and approval. Briefing Save as task and Remind me reuse normal task creation. `/api/v1/rows` returns the current row state and feature capabilities.

Hermes has one bearer token loaded from `HERMES_STATUS_TOKEN_FILE`. The server accepts it only on context, changes, Inbox upsert, request claim, request result, and briefing publication. See [the Hermes integration contract](hermes-task-sync-request.md) for every route and request shape.

Compatibility routes for whole-workspace data, adoption, the old task action preview, task status, task proposals, and the Hermes mirror remain while migration is pending. They are not the current task ownership path. No route writes the Hermes database.

## Migration and removal

The owner-facing migration flow inventories native Fox tasks and `personal-tasks` items. Its preview binds mirrored tasks to exact existing Google IDs where possible and creates the rest through the nonce-safe path. Approval stores immutable source snapshots, expected versions, source-to-target mappings, outgoing fields, planning data, reminders, and resumable action state.

The flow has been built and tested only. It has not touched live data. Before running it:

1. Back up and validate the board and Fox Focus database.
2. Refresh Google and Hermes sources, then resolve every blocker in the preview.
3. Approve the exact batch and briefly freeze legacy task writers.
4. Run resumably and reconcile every unknown create.
5. Verify Google readbacks, mappings, local planning, reminders, and Hermes context.

Keep the Hermes mirror, annotations, completion bridge, and `fox-focus-sync` plugin until that verification is complete. Then archive the mapping and approval history, remove those four active legacy paths, and replace the board-canonical rule in `AGENTS.md` with the retirement wording from the approved plan.

## Hard limits

- No provider delete, Google move or clear, calendar write, Microsoft write, Canvas submit, or direct Gmail access.
- No assistant approval or settlement of an owner decision.
- No SQLite write to the Hermes database.
- No raw credentials, tokens, private email bodies, or database dumps in the repository.
- No claim that a timeout is success. Unknown Google creates and email sends require reconciliation.
