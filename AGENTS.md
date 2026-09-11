# Fox Focus

Fox Focus is a private, self-hosted life cockpit. Keep the early product small: local tasks, deadlines, reminders, capture, a calm Today view and read-only calendar context.

## Data and safety

- Google Calendar, Gmail and Canvas are authoritative for imported records. Do not edit imported data as if Fox Focus owns it.
- Never commit credentials, tokens, private email bodies, Canvas data, or database dumps.
- External writes require a human-readable approval record and exact before-and-after preview. Do not add direct send, delete, calendar-edit, or Canvas-submit paths.
- The existing `personal-tasks` board remains canonical until a migration is explicitly approved.

## Engineering

- Store instants in UTC and render user-facing dates in `Europe/Dublin`; test DST boundaries when date logic arrives.
- Preserve provenance and stable external identifiers for imported data.
- Prefer a small, well-tested local app over a dashboard of unfinished integrations.
