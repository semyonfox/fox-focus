# Google and Microsoft connections

Fox Focus can import a read-only rolling calendar view plus tasks from Google
and Microsoft. The provider remains authoritative: this release has no
provider calendar edit, provider task completion, delete, email, or webhook
write path. Completing a Hermes-owned mirror uses the separately scoped Hermes
action API and never writes Google Tasks or Microsoft To Do.

The server runs the authorization-code flow. It uses PKCE, one-time expiring
state, and a server-held client secret. Browser storage never receives an
access or refresh token. Fox Focus encrypts tokens before storing them in its
SQLite volume; the separate encryption key must remain available after a
restart and restore.

## Private deployment setup

Keep all three inputs outside the repository. Fox Focus mounts each file
read-only, rather than mounting a directory that could accidentally include
Hermes tokens:

- the Google **Web application** client JSON, if Google is enabled;
- a small Microsoft client JSON with `clientId` and `clientSecret`, if
  Microsoft is enabled;
- a 32-byte base64url token-encryption key in its own file.

Do not reuse, copy, or mount Hermes refresh tokens. Existing Hermes provider
*client registrations* may be reused only when they support a Web callback and
the exact Fox Focus redirect below. Fox Focus obtains its own refresh token
through its own browser consent flow.

Keep each host file owner-only where possible (`0600`). Bind mounts retain the
host mode, so it must also be readable by the container's unprivileged `node`
user (UID 1000 in the supplied image); use ownership or a narrowly scoped ACL,
never a world-readable mode.

Prefer a dedicated Web client. If a reused Google client ever had broader
scopes granted, revoke that older grant before connecting Fox Focus so this app
starts with only the three read-only scopes below.

Fox Focus rejects a token response that reports an unrequested scope. It never
stores that token.

Set the non-secret deployment settings in the private Compose environment:

```dotenv
APP_BASE_URL=https://focus.semyon.ie
GOOGLE_OAUTH_CLIENT_FILE_HOST=/absolute/private/google-oauth-client.json
MICROSOFT_OAUTH_CLIENT_FILE_HOST=/absolute/private/microsoft-oauth-client.json
OAUTH_TOKEN_KEY_FILE_HOST=/absolute/private/oauth-token-key
```

Only set a provider's host-file variable when that provider is configured. The
public `compose.yaml` has harmless placeholder files, so it runs normally for a
local-only workspace. Do not use a host directory that also holds a Hermes
refresh token or browser state.

## Google Cloud

Use an OAuth 2.0 **Web application** client. A Desktop client, including the
one Hermes uses for a local installed-app flow, cannot serve Fox Focus's HTTPS
callback.

Register exactly:

```text
https://focus.semyon.ie/api/v1/integrations/google/callback
```

Enable Google Calendar API and Google Tasks API. Add only these data scopes to
the consent configuration:

```text
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/tasks.readonly
```

For this personal deployment, set the external consent screen to **In
production** rather than Testing. Testing refresh tokens expire after seven
days. An unverified private app for fewer than 100 personally known users can
remain unverified, but Google's consent warning is expected. Keep the app
private; a generally distributed product needs Google's verification process.

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

Create a client secret and put the client ID and secret into the private
Microsoft client JSON described above. Add delegated permissions only:

```text
offline_access
Calendars.ReadBasic
Tasks.Read
```

Do not add application permissions. Some university or work tenants can still
block user consent; that is tenant policy, not a Fox Focus failure.

## Using the connection

Open **Calendars & tasks** from the Signals panel and choose Connect. The
browser completes consent and returns to Fox Focus. The first import runs
immediately, then the server polls connected providers every 15 minutes.

Calendar context is a rolling window of 14 days back and 90 days ahead. Google
Tasks and Microsoft To Do are read as complete list snapshots. All provider
records retain source provider, source container, stable external ID, update
time, and their date-only versus UTC-instant distinction.

If a provider revokes or expires a refresh token, Fox Focus marks that one
connection as needing reconnection. It does not delete the local workspace or
silently acquire a new provider grant.
