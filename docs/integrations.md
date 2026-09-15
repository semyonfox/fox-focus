# Provider connections

Fox Focus uses server-side OAuth for Google Calendar, Google Tasks, Microsoft Calendar, and Microsoft To Do. Tokens are encrypted before SQLite storage and never returned to the browser.

Google Tasks owns task content and completion. Google task creation and status changes are the only provider writes in the current system. Google Calendar and both Microsoft imports remain read-only. Fox Focus has no direct Gmail client; Hermes handles approved email sends under the separate contract in [Hermes integration contract](hermes-task-sync-request.md).

## Private configuration

Keep credentials and token keys outside the repository. The supplied container expects read-only files at these environment paths:

```dotenv
APP_BASE_URL=https://focus.example.test
GOOGLE_OAUTH_CLIENT_FILE=/run/secrets/fox-focus/google-client.json
MICROSOFT_OAUTH_CLIENT_FILE=/run/secrets/fox-focus/microsoft-client.json
OAUTH_TOKEN_KEY_FILE=/run/secrets/fox-focus/token-key
```

The private Compose setup maps host files through `GOOGLE_OAUTH_CLIENT_FILE_HOST`, `MICROSOFT_OAUTH_CLIENT_FILE_HOST`, and `OAUTH_TOKEN_KEY_FILE_HOST`. Configure only the providers in use. The token key is a 32-byte base64url value. Keep host files owner-readable and make mounted copies readable by the container's unprivileged `node` user without making them public.

Do not reuse or mount Hermes refresh tokens, browser profiles, or a directory containing unrelated secrets. Fox Focus obtains its own grant through its browser consent flow. It rejects token responses containing scopes it did not request.

## Google

Use an OAuth 2.0 Web application client and register this exact callback for the deployed origin:

```text
https://focus.example.test/api/v1/integrations/google/callback
```

Enable Google Calendar API and Google Tasks API. Fox Focus requests identity plus these API scopes:

```text
openid
email
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/tasks
```

The Google Tasks scope permits the two narrow write paths enforced by Fox Focus: create an approved task and complete or reopen an approved task. The Google Calendar scope permits reading and writing all calendars available to this Google account, including calendar configuration and sharing. This release still has no calendar-write endpoint or executor: a future calendar write needs an exact owner-approved action flow. A connection that has only `tasks.readonly`, `calendar.events`, or `calendar.events.readonly` must reconnect. The server does not expose title edits, task moves, list clears, task deletes, or bulk completion.

For a private Google app with an external consent screen, use the production publishing state when appropriate for the account. Refresh tokens from an external app left in Testing can expire after seven days. Public distribution would require a separate consent and verification review.

### Task destinations and area

Fox Focus discovers current Google task-list IDs. `listAreas` maps each list to a Fox Focus area; area is derived and is not stored on a task. New manual, Inbox, and briefing tasks use the chosen fresh list. If there is no explicit area mapping, automatic fallback is allowed only when the connected account has one fresh list whose exact name is `My Tasks`; otherwise the owner must choose.

The creation screen shows the account, destination list, title, notes, and do-on date before submission. The action appends:

```text
Fox-Focus-ID: <nonce>
```

to the approved notes. A lost create response is reconciled by that exact nonce. Fox Focus never blindly inserts again after an unknown outcome.

Google's due value is date-only. Imports store it as `doOn`; they do not turn it into a deadline or midnight UTC instant. Notes, parent, position, source URL, ETag, and stable account, list, and task IDs are retained. Assigned Docs and Chat tasks remain read-only.

### Completion and reopening

The displayed task and checkbox are the preview. A click records owner approval, exact before and after status, expected task version, target IDs, ETag, and approval time before the worker runs.

The worker reads the same task, uses `If-Match` when an ETag exists, changes only status, and reads the task back. A changed remote record becomes a conflict. A newer owner intent supersedes an older queued or failed action; an operation that may have reached Google must first be reconciled.

### Import isolation

Google fetches a complete paginated snapshot for each task list. It never feeds an `updatedMin` delta into the path that marks absent tasks unavailable. Each Google task list and calendar has its own timeout and freshness record. A failed scope keeps its previous rows, while successful scopes can publish normally.

Connection-generation checks discard late results from a replaced authorization. Google writes and snapshot publication serialize for the affected list, so an import cannot overwrite a newly confirmed command.

## Microsoft

The Microsoft adapter is retained and read-only. It imports calendar context and To Do records but has no write path. Daily views hide Microsoft controls while the provider is unconfigured.

For a personal Microsoft account, create an Entra app registration for personal Microsoft accounts and register:

```text
https://focus.example.test/api/v1/integrations/microsoft/callback
```

Fox Focus uses the `consumers` authority and these delegated permissions:

```text
offline_access
Calendars.ReadBasic
Tasks.Read
```

Do not add application permissions or `Tasks.ReadWrite`. Microsoft refresh currently publishes a provider-wide snapshot rather than the per-list isolation used for Google, so do not treat a partial Microsoft refresh as independently fresh scope data.

## Email and Hermes

Fox Focus does not connect to Gmail. Hermes may upsert structured email Inbox items, but message identity is account plus message ID and the thread ID is context only. An owner-approved send stores the exact reply envelope and base64url SHA-256 payload hash, not MIME. Hermes claims that action, builds MIME deterministically, and returns a hash-bound receipt.

`EMAIL_SEND_ENABLED` defaults off. When set to `true`, server startup also requires `HERMES_STATUS_TOKEN_FILE`. Leave sending off until the executor passes the golden hash, thread, receipt replay, and unknown-outcome reconciliation checks. The exact route and hash contract is in [Hermes integration contract](hermes-task-sync-request.md).

## Migration boundary

The migration preview for native Fox tasks and the Hermes `personal-tasks` board is built but has not been approved or run against live data. The board remains canonical until that happens. The preview can bind a mirrored task to its existing Google ID or queue a nonce-protected create, while preserving local plans and reminders.

Keep the read-only Hermes mirror, annotations, completion bridge, and `fox-focus-sync` plugin until the owner verifies every live mapping, Google readback, reminder, and unknown outcome. Remove those active legacy paths only after verified cutover. Fox Focus never writes the Hermes SQLite database.

## Live verification

Use disposable records before trusting a real connection:

- confirm every create shows the exact account, list, and outgoing fields;
- confirm a lost create response reconciles by nonce without a second insert;
- confirm a checkbox writes only status, honors the ETag, and reads back;
- confirm one failed Google list or calendar retains its rows without blocking another scope;
- confirm an expired email send is reconciliation-only and can never be sent again;
- confirm no provider delete, move, clear, calendar write, Microsoft write, direct Gmail request, or Hermes database write occurs.
