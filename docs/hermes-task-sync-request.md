# Hermes integration contract

Status: implemented on the Fox Focus side and tested with fixtures. The live `personal-tasks` migration and the real mail executor have not been run or verified.

Hermes reads work, proposes Inbox items, carries short jobs forward and back, publishes briefings, and executes an email only after the owner approves its exact envelope. It cannot settle a job, approve a write, complete a task directly, access SQLite directly, or write the Hermes database.

## Authentication

Fox Focus loads one bearer token from `HERMES_STATUS_TOKEN_FILE`. The token must contain at least 24 characters and stay outside the repository, browser bundle, logs, database exports, and Hermes output.

The bearer token works only on these six routes:

| Method and route | Use |
| --- | --- |
| `GET /api/v1/context?from=YYYY-MM-DD&to=YYYY-MM-DD` | Read one consistent task, calendar, Inbox, job, action, briefing, and freshness snapshot |
| `GET /api/v1/changes?after=<seq>&limit=<1..500>` | Read ordered immutable changes after a saved cursor |
| `PUT /api/v1/inbox/:proposalKey` | Create or update one structured Inbox item |
| `POST /api/v1/requests/:id/claim` | Claim a job or approved email action |
| `POST /api/v1/requests/:id/result` | Add a job update or return an email receipt |
| `PUT /api/v1/briefings/:day` | Create or replace one daily briefing |

All other routes require owner Basic authentication. In particular, the compatibility routes `/api/v1/task-status` and `/api/v1/task-proposals` no longer accept the Hermes bearer token.

Requests and responses use JSON unless the route is a GET or claim without a body. Fox Focus limits request bodies and rejects cross-origin browser mutations.

## Context and changes

`GET /api/v1/context` requires an inclusive `from` and `to` date. Its response includes:

- a `cursor` from the same SQLite read transaction;
- tasks with local plans, derived area, and pending action;
- calendar context in the requested range;
- Inbox items with their current draft;
- unsettled jobs and their updates;
- outstanding actions;
- non-expired briefings whose day is in the requested range;
- per-list and per-calendar Google freshness.

Process changes after that cursor through `GET /api/v1/changes`. Save the returned cursor after each page. Each entry contains the actor, mutation identity and hash, entity version, operation, immutable snapshot or tombstone, transition details, and UTC timestamp. A `410` with `resetRequired: true` means the saved cursor is too old. Read a fresh context before continuing.

Neither read route changes state.

## Inbox upsert

Email identity is account plus message ID. Keep thread ID for context, but do not use it as the item key. A new message in an old resolved thread must surface as a new item.

Example:

```json
{
  "expectedVersion": null,
  "source": {
    "kind": "email",
    "accountId": "mail-account",
    "messageId": "provider-message-id",
    "threadId": "provider-thread-id"
  },
  "title": "Confirm the booking",
  "summary": "The organiser asked for a reply.",
  "likelyNoise": false,
  "draft": {
    "accountId": "mail-account",
    "threadId": "provider-thread-id",
    "replyToMessageId": "provider-message-id",
    "inReplyTo": "<provider-message-id@example.test>",
    "references": ["<earlier-message@example.test>"],
    "from": "owner@example.test",
    "to": ["organiser@example.test"],
    "cc": [],
    "bcc": [],
    "subject": "Re: Booking",
    "bodyText": "That time works for me."
  }
}
```

Use `expectedVersion: null` to create. Use the current positive version to update. The `proposalKey` is the idempotency key; reusing it with different content returns `409`.

A draft must match the source account, thread, and message. Fox Focus appends immutable draft revisions. It keeps an owner-edited draft or an envelope with an unsettled send action instead of replacing it. Hermes may refresh title, summary, and likely-noise classification, but cannot change owner decision fields. Likely-noise items remain reviewable.

Do not send raw MIME, credentials, or unrelated message bodies in this request.

## Jobs

The owner creates a job, optionally linked to a task or Inbox item. Its states are:

```text
queued -> working -> needs_you -> working -> review
review -> settled/accepted
review -> settled/dropped
review -> queued          owner sends it back
```

Claim it with:

```http
POST /api/v1/requests/<job-id>/claim
Authorization: Bearer <token>
```

A job claim returns:

```json
{
  "kind": "job",
  "job": { "id": "job-id", "state": "working" },
  "claimId": "opaque-claim-id",
  "leaseUntil": "2026-09-14T10:02:00.000Z"
}
```

Post updates with the returned claim in `X-Claim-Id`:

```json
{ "kind": "progress", "text": "Checking the published timetable.", "url": null }
```

`kind` is `progress`, `question`, or `result`. Text is one plain-text line of at most 280 characters. URL is `null` or a safe HTTPS URL. Progress keeps the job working and renews the lease. A question moves it to `needs_you` and releases the claim. A result moves it to `review` and releases the claim.

The owner answers a question in one line, accepts, drops, or sends the job back with one line. Hermes cannot call those owner routes. Accepting a job linked to a task is also the owner's completion click; Fox Focus queues the normal ETag-guarded Google action.

Hermes may post several progress bodies while the claim is active. Replaying the exact body under the same claim returns the same update.

## Email send actions

Fox Focus has no Gmail access. Hermes owns the mail executor. It must send only the envelope returned by a claimed action and build MIME deterministically from those fields. Fox Focus never stores MIME.

The owner approves the current draft through an owner-only route. The durable action contains:

```ts
{
  kind: "email-send";
  inboxId: string;
  draftId: string;
  reply: {
    accountId: string;
    threadId: string;
    replyToMessageId: string;
    inReplyTo: string;
    references: string[];
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    bodyText: string;
  };
  payloadHash: string;
}
```

Header fields reject control characters. Extra envelope and receipt fields are rejected, so raw MIME cannot be smuggled into either record.

### Hash contract

Construct this preimage object:

```json
{
  "schema": "fox-focus-email-send-v1",
  "inboxId": "<action inboxId>",
  "draftId": "<action draftId>",
  "reply": "<the exact reply object>"
}
```

Canonicalize it by sorting every object's keys lexicographically and applying the same rule recursively. Preserve array order. Serialize with JSON string escaping and no whitespace, encode that string as UTF-8, hash it with SHA-256, then encode the 32-byte digest as unpadded base64url.

This golden preimage:

```json
{"draftId":"draft-golden","inboxId":"inbox-golden","reply":{"accountId":"mail-account","bcc":[],"bodyText":"Approved wording","cc":[],"from":"owner@example.test","inReplyTo":"<message-send@example.test>","references":["<earlier@example.test>"],"replyToMessageId":"message-send","subject":"Re: Message message-send","threadId":"thread-1","to":["sender@example.test"]},"schema":"fox-focus-email-send-v1"}
```

must produce:

```text
odrnJF5zH-so1Uu51RZZ69M_FpVfVSEPNT1cPEWYi8Y
```

Do not hash only `reply`. Do not include `payloadHash` in the preimage.

### Claim and receipt

An email claim uses the same claim route and returns:

```json
{
  "kind": "email-send",
  "action": { "id": "action-id", "payload": { "kind": "email-send" } },
  "mode": "send",
  "claimId": "opaque-claim-id",
  "leaseUntil": "2026-09-14T10:02:00.000Z"
}
```

In `send` mode, build MIME from the stored reply, send once, and return this exact receipt with `X-Claim-Id`:

```json
{
  "kind": "email-send",
  "payloadHash": "<the action payloadHash>",
  "providerMessageId": "<new sent-message id>",
  "providerThreadId": "<the approved thread id>"
}
```

Fox Focus rejects a different hash, thread, reused reply-to message ID, expired claim, extra receipt field, or different replay. It records the successful receipt and Inbox `sent` outcome atomically.

If dispatch may have started and the lease expires, the action becomes `unknown`. Never send it again. A later claim returns `mode: "reconcile"`, including when `EMAIL_SEND_ENABLED` has since been disabled. Search Gmail for the already-sent reply using the approved account, thread, headers, and content. Return the same receipt only after finding one exact sent message. No match leaves the action unknown.

The first claim or result request that notices an expired running lease may return `409` with the action now marked unknown. Claim it again and expect `reconcile`. Do not treat that response as permission to send.

`EMAIL_SEND_ENABLED` defaults off. Fox Focus will not queue or issue a new send-mode claim while it is off. Setting it to `true` without `HERMES_STATUS_TOKEN_FILE` stops server startup. Keep it off until the real executor reproduces the golden hash, deterministic MIME, provider IDs, and reconciliation behavior.

## Briefings

Publish one briefing for a Dublin date:

```http
PUT /api/v1/briefings/2026-09-14
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "expectedVersion": null,
  "expiresAt": "2026-09-15T05:00:00.000Z",
  "entries": [
    {
      "kind": "news",
      "title": "Example headline",
      "summary": "One short source-based summary.",
      "url": "https://example.test/story",
      "startsAt": null
    },
    {
      "kind": "event",
      "title": "Example event",
      "summary": "Doors open at 18:30.",
      "url": "https://example.test/event",
      "startsAt": "2026-09-14T17:30:00.000Z"
    }
  ]
}
```

Use `expectedVersion: null` to create and the current positive version to replace. The day must be `YYYY-MM-DD`, entries are limited to 50, URLs are `null` or HTTPS, and all instants are UTC. An expiry at or before server time is rejected. Repeating identical content returns the stored row; stale different content returns `409` with the current row.

Briefing publication creates no Inbox item and performs no provider write. The owner's Save as task and Remind me actions use the normal Google task creation route. Remind me adds a local timed reminder in the same transaction.

## Migration boundary

The `personal-tasks` board remains canonical until the owner approves and verifies the live migration. Until then, Fox Focus may read its mounted SQLite database and the compatibility bridge may complete an unadopted board item after owner confirmation. Fox Focus never writes the Hermes database.

After verified cutover, remove the mirror, annotations, completion bridge, and `fox-focus-sync` plugin. Preserve source-to-target mappings, action receipts, and approval history. Hermes should then use only the six routes in this document.

## Acceptance checks for the Hermes side

- The bearer token receives `401` from every non-Hermes route.
- Context and change polling create no state.
- Replaying one Inbox proposal, job update, email receipt, or briefing does not duplicate it.
- A new message in an old thread uses its new message ID and surfaces separately.
- Hermes cannot replace an owner or approved draft.
- Hermes cannot settle a job or tick a task.
- The mail executor matches the golden hash, sends once, and reconciles an expired send without resending.
- Briefing publication creates no Inbox item.
- Hermes never accesses SQLite directly or writes the Hermes database.
