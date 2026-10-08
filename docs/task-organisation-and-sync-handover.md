# Task ownership and workflow handover

Status: approved product direction, updated 14 September 2026. The implementation and fixture tests are complete. This does not approve a live `personal-tasks` migration, real email sending, or any other unattended provider write.

## Product decision

Google Tasks is the home for all task content and completion, including new manual, Inbox-derived, and briefing-derived tasks. Fox Focus is the working view and owns priority, waiting, deadlines, planning, reminders, Inbox decisions, jobs, approvals, and action history.

A pending Google create is a durable command awaiting confirmation. It is not a second local task home. Cached Google tasks remain readable during an outage, and pending or conflicted actions stay visible.

The existing Hermes `personal-tasks` board remains canonical until the owner approves and verifies its live migration. Building the migration flow and viewing a preview do not move ownership.

## Daily workflow

Fox Focus has four compact views:

| View | Use |
| --- | --- |
| Today | Current calendar context, a short task list, deadlines, and a collapsed daily briefing |
| Tasks | Full active and completed task browser with task detail |
| Calendar | Read-only provider context and existing local time blocks |
| Inbox | Email decisions and Hermes work handed forward and back |

Each view uses one page scrollbar. Task rows keep the title, area, date, state, and quiet source context. The checkbox changes completion; the rest of the row opens detail. On a phone, dates stay visible and secondary controls move into detail.

Area comes from the task's Google list through `listAreas`. Fox Focus does not store a second area value on the task. Local planning remains attached to the stable internal task ID even if Google is temporarily unavailable.

## Completing and reopening

The task row and explicit checkbox are the preview. Clicking it is the owner's approval. There is no confirmation dialog unless Google has changed the remote record or Hermes proposed the change.

On click, Fox Focus atomically records:

- the task version and newer local intent;
- the Google account, list, task ID, and expected ETag;
- exact before and after status;
- owner identity, readable approval text, and time;
- a queued durable action.

The worker leases the action, conditionally patches status, and reads the same Google task back. A stale ETag becomes a conflict for review. A newer click supersedes an older queued or failed intent, but never an operation that may already have reached Google. Completion never deletes a task, and completed history remains visible.

## Creating tasks

Before creation, Fox Focus shows the chosen Google account and list with the exact title, notes, and do-on date. The area-to-list mapping selects the destination. If there is no mapping, Fox Focus can fall back only when it discovers one fresh list named exactly My Tasks for that account; otherwise the owner must choose. It never substitutes another account or list after approval.

The durable create action includes a random nonce. Fox Focus adds this exact notes line:

```text
Fox-Focus-ID: <nonce>
```

It submits once and verifies the returned task. If the response is lost, it reconciles by the exact nonce. One match binds the pending row. Several matches need review. No match stays unknown. None permits automatic reinsertion.

Google's due field is date-only despite its timestamp-shaped API value. Fox Focus maps it to `doOn`, not a deadline or timed reminder.

## Local task planning

Fox Focus keeps these local fields in a separate versioned plan:

- priority;
- waiting;
- deadline date;
- planned date or UTC planned instant;
- estimate in minutes.

Reminders use separate versioned rows. Fox Focus does not copy plans or reminders back to Google. A reminder at a specific time remains local because Google Tasks cannot preserve that time.

## Inbox

Inbox is one T3 Code-style thread list:

- Needs you contains new email, `needs_you` jobs, and work ready for review.
- Working contains queued or active jobs and pending sends.
- Settled is collapsed.
- Likely noise is collapsed but never hidden.

The detail pane shows the summary, current email draft where relevant, update timeline, and bottom actions. Email actions are Send, Edit draft, Ask Hermes, Make task, Snooze, Done, Not interested, and Noise. Task detail also offers Hand to Hermes.

Email items use account plus message ID as their identity. Thread ID is context only. A later message in a resolved thread therefore appears as a new item.

Drafts are immutable revisions. Hermes can offer a later draft until the owner edits it. After an owner edit or send approval, Hermes cannot replace that wording. Owner decisions use expected versions, so an old tab cannot silently overwrite a newer state.

## Jobs

A job has a one-line title, short instruction, optional linked task or Inbox item, and an immutable update timeline.

1. The owner hands it to Hermes in `queued`.
2. Hermes claims it and moves it to `working`.
3. Hermes adds short progress entries.
4. Hermes either asks one question or submits a result.
5. The owner answers, accepts, drops, or sends it back with one line.

Hermes cannot settle a job. Accepting a result linked to an open task is the owner's completion click and uses the same normal Google action path. Sending work back returns it to `queued`; dropping it settles without changing a task.

## Email approval

Send is an owner-only action for the current draft revision. Approval records the complete account, thread, reply target, message references, sender, recipients, subject, and body text, plus a deterministic payload hash. Fox Focus stores no MIME and has no Gmail access.

Hermes claims the action and builds MIME from the stored envelope. Its receipt must echo the hash and identify the new message in the approved thread. If a lease expires after dispatch might have begun, the action becomes unknown and every later claim is reconciliation-only. Fox Focus never sends or authorizes the message again.

While a send is queued, running, or unknown, neither side can change its draft, settle the Inbox another way, or turn it into a task.

`EMAIL_SEND_ENABLED` is off by default and requires the Hermes bearer token when enabled. Do not enable it against a real mailbox until the executor passes the hash, MIME, receipt, and unknown-send checks in [the Hermes integration contract](hermes-task-sync-request.md).

## Briefing

Hermes publishes at most one versioned briefing for a Dublin date. News and event entries have short summaries, optional HTTPS source links, optional UTC event times, and an expiry. Today shows the briefing as a small collapsed card. It does not add entries to Inbox.

Save as task opens the normal Google destination and field approval. Remind me does the same and adds a local timed reminder atomically with the pending task and create action.

## Provider boundaries

- Google Tasks owns task content and completion. Fox Focus writes only owner-approved creates and status changes.
- Google Calendar remains read-only.
- Gmail owns messages. Fox Focus receives structured proposals from Hermes and stores approved envelopes and receipts, but never calls Gmail.
- Microsoft Calendar and To Do remain read-only. Keep the adapter; hide its controls from daily views while unconfigured.
- Canvas remains authoritative. Fox Focus has no submission route.
- Noise and dismissal never delete, archive, mark spam, or create sender rules in Gmail.
- Fox Focus never writes the Hermes SQLite database.

There is no provider delete, Google move or clear, calendar write, Microsoft write, or general task edit bridge.

## Migration status

The owner-facing migration flow is built but has not been run against live data. It previews native Fox tasks and `personal-tasks` board items, binds exact existing Google mirrors, and creates unmatched tasks through the nonce recovery path. The approved batch records source versions, source-to-target mappings, outgoing values, plans, reminders, and resumable actions.

Run it only after a separate owner decision:

1. Back up and validate the Fox Focus database and Hermes board.
2. Refresh all sources and resolve every preview blocker.
3. Approve the exact batch and briefly freeze legacy writers.
4. Execute resumably and resolve every unknown create.
5. Verify each Google readback, mapping, local plan, reminder, and Hermes context entry.

Keep the read-only Hermes mirror, local annotations, completion bridge, and `fox-focus-sync` plugin until the final verification. After cutover, archive mappings and approval history, remove those active paths, and retire the board from active use.

## Acceptance checks

- A new manual, Inbox, or briefing task names its Google destination before approval.
- Repeating a create or migration approval does not create a duplicate task.
- A lost create response never causes another blind insert.
- One checkbox click records approval, uses the imported ETag, and verifies readback.
- A stale ETag produces a conflict rather than an overwrite.
- A later email message in a resolved thread appears separately.
- Hermes cannot replace owner wording, settle a job, tick a task, or call an owner route with its bearer token.
- An expired email send can only reconcile.
- A briefing creates no Inbox item.
- Google Calendar, Gmail, Canvas, and Microsoft remain authoritative for their records.
- No provider delete, move, clear, calendar write, Microsoft write, direct Gmail call, or Hermes database write occurs.

## Related documents

- [Architecture](architecture-plan.md)
- [Hermes integration contract](hermes-task-sync-request.md)
- [Provider setup and boundaries](integrations.md)
