# Google and Microsoft connections

Fox Focus uses server-side OAuth to import calendar and task context. Google Calendar, Microsoft Calendar, and Microsoft To Do remain read-only. Google Tasks owns task content and completion, including tasks created through Fox Focus; Fox Focus stores local planning and reminders against its stable task rows.

Task creation and status changes are the only Google writes. Every create shows its destination and outgoing fields before approval, and every status change starts from the owner's explicit checkbox click. Fox Focus never moves, clears, or deletes a Google task.

The separate legacy Hermes action bridge can complete an unadopted Hermes-owned task after confirmation. It never writes Google Tasks or Microsoft To Do and is blocked once Fox Focus adopts that task.

The owner-facing legacy migration preview is implemented but has not been run. Approval records one immutable, resumable mapping batch for native Fox tasks and the `personal-tasks` board; it binds exact existing Google IDs or creates through nonce reconciliation. Keep the Hermes mirror, annotations, completion bridge, and `fox-focus-sync` plugin until the owner approves a live batch and its Google readbacks, local planning, reminders, and mappings are verified. Remove those four legacy paths only after that cutover.

## Private deployment setup

Keep all credential inputs outside the repository. Fox Focus mounts each file read-only:

- a Google Web application client JSON, if Google is enabled;
- a small Microsoft client JSON with `clientId` and `clientSecret`, if Microsoft is enabled;
- a 32-byte base64url token-encryption key in its own file.

Do not reuse, copy, or mount Hermes refresh tokens. A provider client registration may be reused only when it supports a Web callback and contains the exact Fox Focus redirect. Fox Focus obtains its own refresh token through its own browser consent flow.

Keep each host file owner-only where possible with mode `0600`. A container bind mount must also be readable by the unprivileged `node` user, UID 1000 in the supplied image. Use ownership or a narrow ACL, not a world-readable mode.

Fox Focus rejects a token response that reports an unrequested scope. It encrypts accepted tokens before writing them to SQLite. The browser never receives an access or refresh token.

Set the non-secret paths in the private Compose environment:

```dotenv
APP_BASE_URL=https://focus.semyon.ie
GOOGLE_OAUTH_CLIENT_FILE_HOST=/absolute/private/google-oauth-client.json
MICROSOFT_OAUTH_CLIENT_FILE_HOST=/absolute/private/microsoft-oauth-client.json
OAUTH_TOKEN_KEY_FILE_HOST=/absolute/private/oauth-token-key
```

Only set a provider host file when that provider is configured. Do not mount a directory that also contains Hermes credentials or browser state.

## Google Cloud

Use an OAuth 2.0 Web application client. A Desktop client cannot serve Fox Focus's HTTPS callback.

Register exactly:

```text
https://focus.semyon.ie/api/v1/integrations/google/callback
```

Enable Google Calendar API and Google Tasks API.

Fox Focus requests exactly:

```text
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/tasks
```

The calendar scopes remain read-only. The full Tasks scope permits the narrow completion bridge, but the server still allows only status changes for explicitly adopted tasks. An older connection granted `tasks.readonly` must reconnect. Fox Focus marks it as needing reconnection instead of attempting a write.

For this personal deployment, set the external consent screen to In production rather than Testing. Google refresh tokens issued to an external app left in Testing can expire after seven days. Keep the app private. A generally distributed product needs a separate verification review.

## Google Tasks adoption

Imported Google tasks are source-owned until adoption. Adoption requires a preview and records:

- an opaque Fox Focus connection generation and the Google task-list ID;
- stable task ID and current ETag or version;
- current title, status, date-only due value, and safe provenance;
- the native Fox Focus task fields that will be created;
- approval state and adoption request ID.

The connection generation changes after a new OAuth authorization. It prevents an old link or late import from being treated as part of the new connection, but it is not a verified Google account ID, name, or email address.

Approval normally creates one native task and one optional external link. A preview may instead name an existing native task with `targetTaskId`. Approval then adds the source link to that task without replacing its Fox Focus details. This is the path for a Google record that matches a task already adopted from Hermes. Repeating approval returns the same task.

The owner calls `POST /api/v1/task-adoptions/preview` with the imported provider record ID:

```json
{
  "source": "google",
  "recordId": 123,
  "targetTaskId": "existing-fox-task-id"
}
```

Omit `targetTaskId` to create a new native task. Microsoft uses `source: "microsoft"`. A Hermes preview uses `source: "hermes"` and its stable `externalId` instead of `recordId`. The owner approves the returned unexpired request with `POST /api/v1/task-adoptions/:id/approve`. Only an adopted Google link permits later write-through.

Fox Focus does not guess across OAuth connection generations. If the same provider list and task IDs were linked under an older generation, select the existing Fox Focus task and approve a fresh preview. This also makes a possible account switch visible instead of silently relinking by ID.

Google's due value is date-only even though its API representation looks like a timestamp. Fox Focus shows it as `Do on`. It must not become a midnight UTC deadline.

Assigned Docs and Chat tasks stay read-only. Their lifecycle can affect the original assignment source.

## Completion-only write-through

Only a link marked `completion_only` can request a Google write. The two allowed changes are:

```text
needsAction -> completed
completed -> needsAction
```

Before approval, Fox Focus shows the native task title, opaque connection reference, Google list and task title, current status, requested status, external ID, and expected ETag. The reference identifies the local OAuth generation, not a verified Google account or email. The saved action request also has an expiry and idempotency key.

`POST /api/v1/task-actions/preview` creates the request:

```json
{
  "taskId": "task-native-id",
  "desiredState": "completed",
  "idempotencyKey": "task-native-id-completed-1"
}
```

`desiredState` is `completed` or `open`. `POST /api/v1/task-actions/:id/approve` runs the request, while `POST /api/v1/task-actions/:id/retry` retries an eligible failure. `GET /api/v1/task-actions` returns the stored state and accepts an optional `taskId` query.

After approval, the server:

1. Fetches the same list and task ID.
2. Compares the observed version with the preview.
3. Stops and records a conflict if the record changed.
4. Patches the status only when the version is still acceptable.
5. Reads the same task back and records the returned status and version.

If Google is unavailable, the native task remains in the state chosen by the user. A retryable failure can use the saved action again. A conflict or non-retryable failure needs a fresh preview after any required refresh or reconnection. Every retry reads first. If Google already has the desired status, that read records success without another patch.

The bridge never calls task insert, delete, move, or list-wide clear. It does not update titles, notes, due values, parents, positions, or lists. It never writes a new native Fox Focus task to Google.

## Microsoft Entra

The account connected to Fox Focus is an ordinary personal Microsoft account.
Fox Focus uses Microsoft's `consumers` OAuth authority, so choose **Personal
Microsoft accounts only** under Supported account types. Microsoft still
requires the OAuth client itself to be an Entra app registration; Fox Focus
cannot use a generic shared client in place of that registration. The tenant
owns the app registration but is not the account whose calendar and tasks Fox
imports. Add exactly:

```text
https://focus.semyon.ie/api/v1/integrations/microsoft/callback
```

Create a client secret and put the client ID and secret in the mounted Microsoft client JSON. Add delegated permissions only:

```text
offline_access
Calendars.ReadBasic
Tasks.Read
```

Do not add application permissions or `Tasks.ReadWrite`. Microsoft remains read-only while the Google legacy bridge is being proved. Some university or work tenants can block user consent through tenant policy.

## Import and refresh

The first import runs after connection. The server then polls connected providers on its configured interval.

Calendar context uses a bounded rolling window. Google Tasks and Microsoft To Do use complete task-list snapshots. Every normalized record retains provider, opaque connection generation, source container, stable external ID, source update time, and its date-only or UTC-instant type.

Provider refresh cannot overwrite native task fields or create a native task. It replaces the read-only provider mirror. The embedded link keeps its last approved observations until a successful status write updates it. If a source task is missing or deleted, its mirror record disappears and Fox Focus refuses a new write preview. It does not delete local history.

Each import is tied to the connection generation that supplied its access token. If a reconnect finishes while an older import is still running, Fox Focus discards the older result. It never stores older-generation records under the new generation.

If a provider revokes or expires a refresh token, Fox Focus marks that connection as needing reconnection. It does not delete the workspace, roll back local task completion, or acquire another grant silently.

## Write safety checks

Before enabling the Google bridge against a real account, verify all of these with a disposable task in the selected list:

- the approval preview names the exact task and status change;
- an expired approval cannot execute;
- the same action retry does not make two mutations;
- a stale version produces a visible conflict;
- a successful patch is followed by readback;
- a provider failure leaves local completion intact;
- a later import does not recreate or reopen the native task;
- no insert, delete, move, clear, calendar write, or Microsoft write request occurs.
