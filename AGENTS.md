# Fox Focus

Fox Focus is a private, self-hosted life cockpit. Keep the product small: Google-backed tasks, local planning and reminders, a terse work Inbox, and read-only calendar context.

## Data and safety

Google Tasks owns task content and completion, including new tasks created through Fox Focus. Fox Focus owns local planning, deadlines, reminders, Inbox decisions, and execution records. Pending Google creations are commands awaiting confirmation, not local-only tasks. Google Calendar, Gmail, and Canvas remain authoritative for their records.

Never commit credentials, tokens, private email bodies, Canvas data, or database dumps.

External writes require a durable human-readable approval record identifying the owner, target account and record, exact before-and-after values, and approval time. For an owner-initiated Google task completion or reopen, the displayed task and explicit status control are the preview; activating that control is approval and needs no second dialog. Task creation requires the destination list and exact outgoing fields to be visible before submission. Agent-proposed writes, bulk migrations, and conflicts with changed remote records require a separate exact preview and approval. Persist approval and the immutable command before dispatch. Keep pending and confirmed state separate. Email sending requires approval of the complete reply envelope and content and execution of the exact stored payload. Unknown create or send outcomes require reconciliation before any further attempt. Do not add unapproved send, delete, calendar-edit, or Canvas-submit paths.

The existing `personal-tasks` board remains canonical until a migration is explicitly approved.

## Engineering

- Store instants in UTC and render user-facing dates in `Europe/Dublin`; store date-only values as `YYYY-MM-DD` and test DST boundaries.
- Preserve provenance and stable external identifiers for imported data.
- Never write to the Hermes SQLite database. Keep Microsoft writes, provider deletes, task moves, completed-list clears, calendar writes, and direct Gmail access out of Fox Focus.
- Prefer a small, well-tested local app over a dashboard of unfinished integrations.
