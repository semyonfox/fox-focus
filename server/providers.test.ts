import { taskCompletionFingerprint } from './task-completion-fingerprint.ts';
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGoogleTask,
  listGoogleCalendarEvents,
  listGoogleCalendarChanges,
  listGoogleCalendars,
  listGoogleCalendarSnapshot,
  listGoogleTasks,
  listMicrosoftCalendarView,
  listMicrosoftCalendars,
  listMicrosoftTodoTasks,
  reconcileGoogleTaskCreate,
  updateGoogleTaskStatus,
  type ProviderFetch,
  type ProviderReadClient,
} from "./providers.ts";

type CapturedRequest = {
  readonly url: string;
  readonly init: RequestInit;
};

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function queuedFetch(...responses: Response[]): { readonly fetch: ProviderFetch; readonly requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetch: ProviderFetch = async (url, init) => {
    requests.push({ url, init });
    const response = responses.shift();
    assert.ok(response, `unexpected request to ${url}`);
    return response;
  };
  return { fetch, requests };
}

function client(fetch: ProviderFetch): ProviderReadClient {
  return { accessToken: "test-access-token", fetch };
}

function headers(request: CapturedRequest): Headers {
  return new Headers(request.init.headers);
}

function assertReadOnly(requests: readonly CapturedRequest[]): void {
  for (const request of requests) assert.equal(request.init.method, "GET");
}

test("Google calendar list uses the scoped endpoint, bearer header, and page tokens", async () => {
  const transport = queuedFetch(
    json({
      items: [{ id: "primary", summary: "Personal", primary: true }],
      nextPageToken: "next page",
    }),
    json({ items: [{ id: "uk", summary: "UK holidays" }] }),
  );

  const result = await listGoogleCalendars(client(transport.fetch));

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.value.records, [
    { provider: "google", externalId: "primary", title: "Personal", isPrimary: true },
    { provider: "google", externalId: "uk", title: "UK holidays", isPrimary: false },
  ]);
  assert.equal(transport.requests.length, 2);
  const first = new URL(transport.requests[0].url);
  assert.equal(first.origin, "https://www.googleapis.com");
  assert.equal(first.pathname, "/calendar/v3/users/me/calendarList");
  assert.equal(first.searchParams.get("maxResults"), "250");
  assert.equal(first.searchParams.get("fields"), "items(id,summary,primary),nextPageToken");
  assert.equal(first.searchParams.get("pageToken"), null);
  assert.equal(headers(transport.requests[0]).get("authorization"), "Bearer test-access-token");
  assert.equal(headers(transport.requests[0]).get("accept"), "application/json");
  assert.equal(new URL(transport.requests[1].url).searchParams.get("pageToken"), "next page");
  assertReadOnly(transport.requests);
});

test("Google calendar events retain date-only values, normalize instants, and never expose descriptions", async () => {
  const transport = queuedFetch(json({
    items: [
      {
        id: "timed",
        status: "confirmed",
        summary: "Lecture",
        description: "private event body",
        start: { dateTime: "2026-10-25T09:00:00+01:00", timeZone: "Europe/Dublin" },
        end: { dateTime: "2026-10-25T10:00:00+01:00", timeZone: "Europe/Dublin" },
        updated: "2026-09-11T08:00:00Z",
      },
      {
        id: "all-day",
        status: "tentative",
        summary: "Reading week",
        start: { date: "2026-10-26" },
        end: { date: "2026-10-31" },
      },
      { id: "deleted", status: "cancelled", updated: "2026-09-11T09:00:00Z" },
    ],
    nextSyncToken: "calendar-cursor",
  }));

  const result = await listGoogleCalendarEvents(client(transport.fetch), {
    calendarId: "primary/calendar",
    timeMin: "2026-10-01T00:00:00+01:00",
    timeMax: "2026-11-01T00:00:00+00:00",
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.value.events, [
    {
      provider: "google",
      calendarId: "primary/calendar",
      externalId: "timed",
      title: "Lecture",
      state: "active",
      start: { kind: "instant", value: "2026-10-25T08:00:00.000Z" },
      end: { kind: "instant", value: "2026-10-25T09:00:00.000Z" },
      isAllDay: false,
      updatedAt: "2026-09-11T08:00:00.000Z",
    },
    {
      provider: "google",
      calendarId: "primary/calendar",
      externalId: "all-day",
      title: "Reading week",
      state: "active",
      start: { kind: "date", value: "2026-10-26" },
      end: { kind: "date", value: "2026-10-31" },
      isAllDay: true,
      updatedAt: null,
    },
    {
      provider: "google",
      calendarId: "primary/calendar",
      externalId: "deleted",
      title: "Cancelled event",
      state: "cancelled",
      start: null,
      end: null,
      isAllDay: null,
      updatedAt: "2026-09-11T09:00:00.000Z",
    },
  ]);
  assert.equal(result.value.nextSyncToken, null);
  assert.ok(!JSON.stringify(result).includes("private event body"));
  const requestUrl = new URL(transport.requests[0].url);
  assert.equal(requestUrl.pathname, "/calendar/v3/calendars/primary%2Fcalendar/events");
  assert.equal(requestUrl.searchParams.get("timeMin"), "2026-09-30T23:00:00.000Z");
  assert.equal(requestUrl.searchParams.get("timeMax"), "2026-11-01T00:00:00.000Z");
  assert.equal(requestUrl.searchParams.get("showDeleted"), "true");
  assert.equal(requestUrl.searchParams.get("singleEvents"), "true");
  assert.ok(!requestUrl.searchParams.get("fields")?.includes("description"));
  assertReadOnly(transport.requests);
});

test("Google calendar changes use a saved sync token without mixing it with a date window", async () => {
  const transport = queuedFetch(json({
    items: [{ id: "gone", status: "cancelled" }],
    nextSyncToken: "refreshed-cursor",
  }));

  const result = await listGoogleCalendarChanges(client(transport.fetch), {
    calendarId: "primary",
    syncToken: "saved cursor",
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value.nextSyncToken, "refreshed-cursor");
  assert.equal(result.value.events[0].state, "cancelled");
  const requestUrl = new URL(transport.requests[0].url);
  assert.equal(requestUrl.searchParams.get("syncToken"), "saved cursor");
  assert.equal(requestUrl.searchParams.get("timeMin"), null);
  assert.equal(requestUrl.searchParams.get("timeMax"), null);
  assertReadOnly(transport.requests);
});

test("Google calendar snapshots establish a cursor without bounded-window parameters", async () => {
  const transport = queuedFetch(json({
    items: [],
    nextSyncToken: "first-cursor",
  }));

  const result = await listGoogleCalendarSnapshot(client(transport.fetch), { calendarId: "primary" });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value.nextSyncToken, "first-cursor");
  const requestUrl = new URL(transport.requests[0].url);
  assert.equal(requestUrl.searchParams.get("syncToken"), null);
  assert.equal(requestUrl.searchParams.get("timeMin"), null);
  assert.equal(requestUrl.searchParams.get("timeMax"), null);
  assertReadOnly(transport.requests);
});

test("Google Tasks keeps notes, hierarchy, position, and a safe source URL across pagination", async () => {
  const transport = queuedFetch(
    json({
      items: [{
        id: "done",
        etag: '"task-v1"',
        title: "Renew library book",
        status: "completed",
        due: "2026-09-12T00:00:00.000Z",
        completed: "2026-09-11T08:00:00Z",
        updated: "2026-09-11T08:00:00Z",
      }, {
        id: "assigned",
        etag: '"assigned-v1"',
        title: "Source-managed assignment",
        status: "needsAction",
        updated: "2026-09-11T09:00:00Z",
        assignmentInfo: { surfaceType: "DOCUMENT" },
      }],
      nextPageToken: "next",
    }),
    json({
      items: [{
        id: "nested",
        title: "File renewal receipt",
        status: "needsAction",
        notes: "Renew through the library portal",
        parent: "admin",
        position: "00000000000000000001",
        webViewLink: "https://tasks.google.com/task/nested",
        body: "unrelated provider body",
      }, {
        id: "deleted",
        etag: '"deleted-v1"',
        title: "Old item",
        deleted: true,
      }],
    }),
  );

  const result = await listGoogleTasks(client(transport.fetch), { taskListId: "list/with slash" });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.value.records, [
    {
      provider: "google",
      taskListId: "list/with slash",
      externalId: "done",
      title: "Renew library book",
      notes: null,
      parentId: null,
      position: null,
      sourceUrl: null,
      state: "completed",
      sourceState: "completed",
      dueDate: "2026-09-12",
      completedAt: "2026-09-11T08:00:00.000Z",
      updatedAt: "2026-09-11T08:00:00.000Z",
      version: '"task-v1"',
      isDeleted: false,
    },
    {
      provider: "google",
      taskListId: "list/with slash",
      externalId: "assigned",
      title: "Source-managed assignment",
      notes: null,
      parentId: null,
      position: null,
      sourceUrl: null,
      state: "open",
      sourceState: "needsAction",
      dueDate: null,
      completedAt: null,
      updatedAt: "2026-09-11T09:00:00.000Z",
      version: '"assigned-v1"',
      isDeleted: false,
      completionWritable: false,
    },
    {
      provider: "google",
      taskListId: "list/with slash",
      externalId: "nested",
      title: "File renewal receipt",
      notes: "Renew through the library portal",
      parentId: "admin",
      position: "00000000000000000001",
      sourceUrl: "https://tasks.google.com/task/nested",
      state: "open",
      sourceState: "needsAction",
      dueDate: null,
      completedAt: null,
      updatedAt: null,
      version: null,
      isDeleted: false,
    },
    {
      provider: "google",
      taskListId: "list/with slash",
      externalId: "deleted",
      title: "Old item",
      notes: null,
      parentId: null,
      position: null,
      sourceUrl: null,
      state: "open",
      sourceState: "deleted",
      dueDate: null,
      completedAt: null,
      updatedAt: null,
      version: '"deleted-v1"',
      isDeleted: true,
    },
  ]);
  assert.ok(!JSON.stringify(result).includes("unrelated provider body"));
  const first = new URL(transport.requests[0].url);
  assert.equal(first.pathname, "/tasks/v1/lists/list%2Fwith%20slash/tasks");
  assert.equal(first.searchParams.get("showAssigned"), "true");
  assert.equal(first.searchParams.get("showCompleted"), "true");
  assert.equal(first.searchParams.get("showHidden"), "true");
  assert.equal(first.searchParams.get("showDeleted"), "true");
  assert.ok(first.searchParams.get("fields")?.includes("etag"));
  assert.ok(first.searchParams.get("fields")?.includes("assignmentInfo"));
  assert.ok(first.searchParams.get("fields")?.includes("notes"));
  assert.ok(first.searchParams.get("fields")?.includes("parent"));
  assert.ok(first.searchParams.get("fields")?.includes("position"));
  assert.ok(first.searchParams.get("fields")?.includes("webViewLink"));
  assert.ok(!first.searchParams.get("fields")?.includes("body"));
  assert.equal(new URL(transport.requests[1].url).searchParams.get("pageToken"), "next");
  assertReadOnly(transport.requests);
});

test("Google Tasks rejects an untrusted task source URL", async () => {
  const transport = queuedFetch(json({
    items: [{
      id: "task-1",
      title: "Review notes",
      status: "needsAction",
      webViewLink: "https://tasks.google.com.example.test/task/task-1",
    }],
  }));

  const result = await listGoogleTasks(client(transport.fetch), { taskListId: "list-1" });

  assert.deepEqual(result, {
    status: "invalid-response",
    provider: "google",
    operation: "google.tasks",
  });
  assertReadOnly(transport.requests);
});

test("Google task create sends the approved fields once and verifies an exact readback", async () => {
  const notes = "Created from Inbox\n\nFox-Focus-ID: nonce_123";
  const transport = queuedFetch(
    json({ id: "created/task" }, 201),
    json({
      id: "created/task",
      etag: '"created-v1"',
      title: "Submit registration",
      notes,
      status: "needsAction",
      due: "2026-10-25T00:00:00.000Z",
      updated: "2026-09-14T11:00:00Z",
      position: "0001",
    }),
  );

  const result = await createGoogleTask(client(transport.fetch), {
    taskListId: "admin/list",
    title: "Submit registration",
    notes,
    dueOn: "2026-10-25",
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value.taskId, "created/task");
  assert.equal(result.value.task.title, "Submit registration");
  assert.equal(result.value.task.notes, notes);
  assert.equal(result.value.task.dueDate, "2026-10-25");
  assert.equal(result.value.task.version, '"created-v1"');
  assert.deepEqual(transport.requests.map(request => request.init.method), ["POST", "GET"]);
  const insert = transport.requests[0];
  const insertUrl = new URL(insert.url);
  assert.equal(insertUrl.pathname, "/tasks/v1/lists/admin%2Flist/tasks");
  assert.equal(insertUrl.searchParams.get("fields"), "id");
  assert.deepEqual(JSON.parse(String(insert.init.body)), {
    title: "Submit registration",
    notes,
    due: "2026-10-25T00:00:00.000Z",
  });
  assert.equal(headers(insert).get("authorization"), "Bearer test-access-token");
  assert.equal(headers(insert).get("content-type"), "application/json");
  const readback = new URL(transport.requests[1].url);
  assert.equal(readback.pathname, "/tasks/v1/lists/admin%2Flist/tasks/created%2Ftask");
  assert.equal(readback.searchParams.get("fields"),
    "id,title,notes,parent,position,webViewLink,status,due,completed,updated,deleted,etag,assignmentInfo");
});

test("Google task create treats every ambiguous post-dispatch failure as unknown", async () => {
  const cases: Array<{
    name: string;
    fetch: ProviderFetch;
    phase: "dispatch" | "readback";
    candidateTaskId?: string;
  }> = [
    {
      name: "lost response",
      fetch: async () => { throw new TypeError("socket closed"); },
      phase: "dispatch",
    },
    {
      name: "server error",
      fetch: queuedFetch(json({}, 503)).fetch,
      phase: "dispatch",
    },
    {
      name: "request timeout response",
      fetch: queuedFetch(json({}, 408)).fetch,
      phase: "dispatch",
    },
    {
      name: "malformed success",
      fetch: queuedFetch(json({ unexpected: true }, 201)).fetch,
      phase: "dispatch",
    },
    {
      name: "lost readback",
      fetch: queuedFetch(json({ id: "candidate" }, 201), json({}, 503)).fetch,
      phase: "readback",
      candidateTaskId: "candidate",
    },
  ];

  for (const scenario of cases) {
    const result = await createGoogleTask(client(scenario.fetch), {
      taskListId: "list-1",
      title: "Created once",
      notes: "Fox-Focus-ID: nonce_456",
      dueOn: null,
    });
    assert.deepEqual(result, {
      status: "unknown",
      provider: "google",
      operation: "google.task-create",
      phase: scenario.phase,
      ...(scenario.candidateTaskId ? { candidateTaskId: scenario.candidateTaskId } : {}),
    }, scenario.name);
  }
});

test("Google task create does not confirm an incomplete or unwritable readback", async () => {
  const readbacks = [{
    id: "candidate", title: "Created once", notes: "Fox-Focus-ID: nonce_guard",
    status: "needsAction",
  }, {
    id: "candidate", etag: '"v1"', title: "Created once", notes: "Fox-Focus-ID: nonce_guard",
    status: "needsAction", completed: "2026-09-14T12:00:00Z",
  }, {
    id: "candidate", etag: '"v1"', title: "Created once", notes: "Fox-Focus-ID: nonce_guard",
    status: "needsAction", assignmentInfo: { surfaceType: "DOCUMENT" },
  }];

  for (const readback of readbacks) {
    const transport = queuedFetch(json({ id: "candidate" }, 201), json(readback));
    const result = await createGoogleTask(client(transport.fetch), {
      taskListId: "list-1",
      title: "Created once",
      notes: "Fox-Focus-ID: nonce_guard",
      dueOn: null,
    });
    assert.deepEqual(result, {
      status: "unknown",
      provider: "google",
      operation: "google.task-create",
      phase: "readback",
      candidateTaskId: "candidate",
    });
  }
});

test("Google task create returns a definitive rejection without a readback", async () => {
  const transport = queuedFetch(json({ error: "rate limit" }, 429, { "retry-after": "7" }));

  const result = await createGoogleTask(client(transport.fetch), {
    taskListId: "list-1",
    title: "Created once",
    notes: "Fox-Focus-ID: nonce_789",
    dueOn: null,
  });

  assert.deepEqual(result, {
    status: "failed",
    provider: "google",
    operation: "google.task-create",
    failure: "rate-limited",
    phase: "rejected",
    httpStatus: 429,
    retryAfterSeconds: 7,
  });
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].init.method, "POST");
});

test("Google task create rejects invalid input before dispatch", async () => {
  const transport = queuedFetch();
  const invalidTitle = await createGoogleTask(client(transport.fetch), {
    taskListId: "list-1",
    title: " trailing space ",
    notes: "Fox-Focus-ID: nonce",
    dueOn: null,
  });
  const missingNonce = await createGoogleTask(client(transport.fetch), {
    taskListId: "list-1",
    title: "Valid title",
    notes: "No recovery marker",
    dueOn: null,
  });
  const expected = {
    status: "failed",
    provider: "google",
    operation: "google.task-create",
    failure: "invalid-request",
    phase: "pre-dispatch",
  } as const;
  assert.deepEqual(invalidTitle, expected);
  assert.deepEqual(missingNonce, expected);
  assert.equal(transport.requests.length, 0);
});

test("Google create reconciliation scans every page for one exact nonce marker", async () => {
  const transport = queuedFetch(
    json({
      items: [{
        id: "similar",
        title: "Wrong marker",
        notes: "prefix Fox-Focus-ID: nonce_abc",
        status: "needsAction",
      }],
      nextPageToken: "page-2",
    }),
    json({
      items: [{
        id: "deleted",
        title: "Deleted marker",
        notes: "Fox-Focus-ID: nonce_abc",
        deleted: true,
      }, {
        id: "reconciled",
        etag: '"reconciled-v1"',
        title: "Recovered task",
        notes: "Context\r\nFox-Focus-ID: nonce_abc\r\n",
        status: "needsAction",
        updated: "2026-09-14T12:00:00Z",
      }],
    }),
  );

  const result = await reconcileGoogleTaskCreate(client(transport.fetch), {
    taskListId: "list-1",
    nonce: "nonce_abc",
    candidateTaskId: "reconciled",
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value.taskId, "reconciled");
  assert.equal(result.value.task.notes, "Context\r\nFox-Focus-ID: nonce_abc\r\n");
  assert.equal(transport.requests.length, 2);
  assert.equal(new URL(transport.requests[1].url).searchParams.get("pageToken"), "page-2");
  assertReadOnly(transport.requests);
});

test("Google create reconciliation reports safe candidates for duplicate or mismatched markers", async () => {
  const transport = queuedFetch(json({ items: [{
    id: "first",
    etag: '"v1"',
    title: "First candidate",
    notes: "private detail\nFox-Focus-ID: nonce_dup",
    status: "needsAction",
    updated: "2026-09-14T12:00:00Z",
  }, {
    id: "second",
    etag: '"v2"',
    title: "Second candidate",
    notes: "Fox-Focus-ID: nonce_dup",
    status: "completed",
    completed: "2026-09-14T12:05:00Z",
  }] }));

  const result = await reconcileGoogleTaskCreate(client(transport.fetch), {
    taskListId: "list-1",
    nonce: "nonce_dup",
    candidateTaskId: "missing-candidate",
  });

  assert.equal(result.status, "conflict");
  if (result.status !== "conflict") return;
  assert.equal(result.candidateTaskId, "missing-candidate");
  assert.deepEqual(result.candidates.map(candidate => candidate.externalId), ["first", "second"]);
  assert.ok(!("notes" in result.candidates[0]));
  assert.ok(!JSON.stringify(result).includes("private detail"));
});

test("Google create reconciliation keeps no-match outcomes unknown", async () => {
  const transport = queuedFetch(json({ items: [] }));
  const result = await reconcileGoogleTaskCreate(client(transport.fetch), {
    taskListId: "list-1",
    nonce: "nonce_missing",
  });

  assert.deepEqual(result, {
    status: "unknown",
    provider: "google",
    operation: "google.task-create-reconcile",
    failure: "not-found",
  });
});

test("Google create reconciliation does not confirm a match without an ETag", async () => {
  const transport = queuedFetch(json({ items: [{
    id: "candidate",
    title: "Created once",
    notes: "Fox-Focus-ID: nonce_no_etag",
    status: "needsAction",
  }] }));
  const result = await reconcileGoogleTaskCreate(client(transport.fetch), {
    taskListId: "list-1",
    nonce: "nonce_no_etag",
  });

  assert.deepEqual(result, {
    status: "unknown",
    provider: "google",
    operation: "google.task-create-reconcile",
    failure: "invalid-response",
    candidateTaskId: "candidate",
  });
});

test("Google task completion patches only status with an ETag and verifies an exact readback", async () => {
  const transport = queuedFetch(
    json({ id: "task/id", title: "Renew library book", status: "needsAction", etag: '"task-v1"', updated: "2026-09-13T08:00:00Z" }),
    json({ id: "task/id", status: "completed", etag: '"task-v2"' }),
    json({
      id: "task/id",
      etag: '"task-v2"',
      title: "Renew library book",
      status: "completed",
      completed: "2026-09-13T08:15:00Z",
      updated: "2026-09-13T08:15:00Z",
    }),
  );

  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: "list/with slash",
    taskId: "task/id",
    state: "completed",
    expectedEtag: '"task-v1"',
  });

  assert.deepEqual(result, {
    status: "ok",
    provider: "google",
    operation: "google.task-status-update",
    value: {
      taskListId: "list/with slash",
      taskId: "task/id",
      requestedState: "completed",
      etag: '"task-v2"',
      task: {
        provider: "google",
        taskListId: "list/with slash",
        externalId: "task/id",
        title: "Renew library book",
        notes: null,
        parentId: null,
        position: null,
        sourceUrl: null,
        state: "completed",
        sourceState: "completed",
        dueDate: null,
        completedAt: "2026-09-13T08:15:00.000Z",
        updatedAt: "2026-09-13T08:15:00.000Z",
        version: '"task-v2"',
        isDeleted: false,
      },
    },
  });
  assert.equal(transport.requests.length, 3);

  const preflight = transport.requests[0];
  assert.equal(preflight.init.method, "GET");
  const patch = transport.requests[1];
  const patchUrl = new URL(patch.url);
  assert.equal(patch.init.method, "PATCH");
  assert.equal(patchUrl.pathname, "/tasks/v1/lists/list%2Fwith%20slash/tasks/task%2Fid");
  assert.equal(patchUrl.searchParams.get("fields"), "id,status,etag");
  assert.equal(headers(patch).get("authorization"), "Bearer test-access-token");
  assert.equal(headers(patch).get("content-type"), "application/json");
  assert.equal(headers(patch).get("if-match"), '"task-v1"');
  assert.deepEqual(JSON.parse(String(patch.init.body)), { status: "completed" });

  const readback = transport.requests[2];
  const readbackUrl = new URL(readback.url);
  assert.equal(readback.init.method, "GET");
  assert.equal(readbackUrl.pathname, patchUrl.pathname);
  assert.equal(
    readbackUrl.searchParams.get("fields"),
    "id,title,notes,parent,position,webViewLink,status,due,completed,updated,deleted,etag,assignmentInfo",
  );
  assert.equal(headers(readback).get("if-match"), null);
});

test("Google refuses to PATCH a source-managed assigned task", async () => {
  const transport = queuedFetch(json({
    id: "assigned-task",
    etag: '"assigned-v1"',
    title: "Source-managed assignment",
    status: "needsAction",
    updated: "2026-09-13T08:00:00Z",
    assignmentInfo: { surfaceType: "DOCUMENT" },
  }));

  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: "assigned-list",
    taskId: "assigned-task",
    state: "completed",
    expectedEtag: '"assigned-v1"',
  });

  assert.deepEqual(result, {
    status: "verification-failed",
    provider: "google",
    operation: "google.task-status-update",
    phase: "preflight",
  });
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].init.method, "GET");
});

test("Google task reopen works without a known ETag and verifies completion was cleared", async () => {
  const transport = queuedFetch(
    json({
      id: "task-1", etag: '"task-v2"', title: "Completed task", status: "completed",
      completed: "2026-09-13T08:00:00Z", updated: "2026-09-13T08:00:00Z",
    }),
    new Response(null, { status: 204 }),
    json({
      id: "task-1",
      etag: '"task-v3"',
      title: "Reopened task",
      status: "needsAction",
      updated: "2026-09-13T09:00:00Z",
    }),
  );

  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: "list-1",
    taskId: "task-1",
    state: "open",
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value.task.state, "open");
  assert.equal(result.value.task.completedAt, null);
  assert.equal(result.value.etag, '"task-v3"');
  assert.equal(headers(transport.requests[1]).get("if-match"), '"task-v2"');
  assert.deepEqual(JSON.parse(String(transport.requests[1].init.body)), { status: "needsAction" });
});

test("Google task status update reports an ETag conflict before writing", async () => {
  const transport = queuedFetch(json({
    id: "task-1", etag: '"fresh"', title: "Changed upstream", status: "needsAction",
    updated: "2026-09-13T09:00:00Z",
  }));

  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: "list-1",
    taskId: "task-1",
    state: "completed",
    expectedEtag: '"stale"',
  });

  assert.deepEqual(result, {
    status: "conflict",
    provider: "google",
    operation: "google.task-status-update",
    phase: "preflight",
    httpStatus: 412,
    currentTask: {
      provider: "google",
      taskListId: "list-1",
      externalId: "task-1",
      title: "Changed upstream",
      notes: null,
      parentId: null,
      position: null,
      sourceUrl: null,
      state: "open",
      sourceState: "needsAction",
      dueDate: null,
      completedAt: null,
      updatedAt: "2026-09-13T09:00:00.000Z",
      version: '"fresh"',
      isDeleted: false,
    },
  });
  assert.equal(transport.requests.length, 1);
});

test("Google reads the current task after a conditional PATCH conflict", async () => {
  const transport = queuedFetch(
    json({
      id: "task-1", etag: '"imported"', title: "Before race", status: "needsAction",
      updated: "2026-09-13T09:00:00Z",
    }),
    new Response(null, { status: 412 }),
    json({
      id: "task-1", etag: '"phone-edit"', title: "Changed on phone", notes: "Current notes",
      status: "needsAction", due: "2026-09-16T00:00:00.000Z", updated: "2026-09-13T09:01:00Z",
    }),
  );

  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: "list-1",
    taskId: "task-1",
    state: "completed",
    expectedEtag: '"imported"',
  });

  assert.equal(result.status, "conflict");
  if (result.status !== "conflict") return;
  assert.equal(result.phase, "update");
  assert.equal(result.httpStatus, 412);
  assert.equal(result.currentTask?.title, "Changed on phone");
  assert.equal(result.currentTask?.notes, "Current notes");
  assert.equal(result.currentTask?.dueDate, "2026-09-16");
  assert.equal(result.currentTask?.version, '"phone-edit"');
  assert.deepEqual(transport.requests.map(request => request.init.method), ["GET", "PATCH", "GET"]);
});

test("Google task status update fails verification when readback does not match", async () => {
  const transport = queuedFetch(
    json({ id: "task-1", status: "needsAction", etag: '"task-v1"', title: "Before update" }),
    json({ id: "task-1", status: "completed", etag: '"task-v2"' }),
    json({
      id: "task-1",
      etag: '"task-v2"',
      title: "Still open",
      status: "needsAction",
      updated: "2026-09-13T09:00:00Z",
    }),
  );

  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: "list-1",
    taskId: "task-1",
    state: "completed",
    expectedEtag: '"task-v1"',
  });

  assert.deepEqual(result, {
    status: "verification-failed",
    provider: "google",
    operation: "google.task-status-update",
    phase: "readback",
  });
  assert.equal(transport.requests.length, 3);
});

test("Google task retry treats an already-applied state as verified without another PATCH", async () => {
  const transport = queuedFetch(json({
    id: "task-1", etag: '"task-v2"', title: "Already completed", status: "completed",
    completed: "2026-09-13T09:00:00Z", updated: "2026-09-13T09:00:00Z",
  }));

  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: "list-1",
    taskId: "task-1",
    state: "completed",
    expectedEtag: '"task-v1"',
  });

  assert.equal(result.status, "ok");
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].init.method, "GET");
});

test("Google task status update rejects unsafe ETags before any request", async () => {
  const transport = queuedFetch();

  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: "list-1",
    taskId: "task-1",
    state: "completed",
    expectedEtag: '"safe"\r\nx-injected: yes',
  });

  assert.deepEqual(result, {
    status: "invalid-request",
    provider: "google",
    operation: "google.task-status-update",
    phase: "update",
  });
  assert.equal(transport.requests.length, 0);
});

test("Microsoft calendar view preserves Dublin all-day dates and normalizes timed events across DST", async () => {
  const nextLink = "https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView?$skiptoken=second";
  const transport = queuedFetch(
    json({
      value: [{
        id: "event-1",
        subject: "Team meeting",
        start: { dateTime: "2026-09-12T09:00:00.0000000", timeZone: "GMT Standard Time" },
        end: { dateTime: "2026-09-12T10:00:00.0000000", timeZone: "GMT Standard Time" },
        isAllDay: false,
        isCancelled: false,
        bodyPreview: "private preview",
      }, {
        id: "event-2",
        subject: "Dublin all day",
        start: { dateTime: "2026-03-29T00:00:00.0000000", timeZone: "GMT Standard Time" },
        end: { dateTime: "2026-03-30T00:00:00.0000000", timeZone: "GMT Standard Time" },
        isAllDay: true,
        isCancelled: false,
      }],
      "@odata.nextLink": nextLink,
    }),
    json({ value: [{ id: "event-3", subject: "Cancelled", isCancelled: true }] }),
  );

  const result = await listMicrosoftCalendarView(client(transport.fetch), {
    calendarId: "cal-1",
    startDateTime: "2026-09-01T00:00:00Z",
    endDateTime: "2026-10-01T00:00:00Z",
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.value.records, [
    {
      provider: "microsoft",
      calendarId: "cal-1",
      externalId: "event-1",
      title: "Team meeting",
      state: "active",
      start: { kind: "instant", value: "2026-09-12T08:00:00.000Z" },
      end: { kind: "instant", value: "2026-09-12T09:00:00.000Z" },
      isAllDay: false,
      updatedAt: null,
    },
    {
      provider: "microsoft",
      calendarId: "cal-1",
      externalId: "event-2",
      title: "Dublin all day",
      state: "active",
      start: { kind: "date", value: "2026-03-29" },
      end: { kind: "date", value: "2026-03-30" },
      isAllDay: true,
      updatedAt: null,
    },
    {
      provider: "microsoft",
      calendarId: "cal-1",
      externalId: "event-3",
      title: "Cancelled",
      state: "cancelled",
      start: null,
      end: null,
      isAllDay: null,
      updatedAt: null,
    },
  ]);
  assert.ok(!JSON.stringify(result).includes("private preview"));
  const first = new URL(transport.requests[0].url);
  assert.equal(first.origin, "https://graph.microsoft.com");
  assert.equal(first.pathname, "/v1.0/me/calendars/cal-1/calendarView");
  assert.equal(first.searchParams.get("$select"), "id,subject,start,end,isAllDay,isCancelled");
  assert.equal(first.searchParams.get("startDateTime"), "2026-09-01T00:00:00.000Z");
  assert.equal(first.searchParams.get("endDateTime"), "2026-10-01T00:00:00.000Z");
  assert.equal(headers(transport.requests[0]).get("prefer"), 'outlook.timezone="GMT Standard Time", IdType="ImmutableId"');
  assert.equal(transport.requests[1].url, nextLink);
  assertReadOnly(transport.requests);
});

test("Microsoft To Do requests no body fields, maps task states, and rejects untrusted page links", async () => {
  const transport = queuedFetch(json({
    value: [{
      id: "todo-1",
      title: "Submit assignment",
      status: "completed",
      dueDateTime: { dateTime: "2026-09-18T00:00:00.0000000", timeZone: "Europe/Dublin" },
      lastModifiedDateTime: "2026-09-11T12:00:00Z",
      body: { content: "private note" },
    }],
  }));

  const result = await listMicrosoftTodoTasks(client(transport.fetch), { taskListId: "tasks-list" });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.value.records, [{
    provider: "microsoft",
    taskListId: "tasks-list",
    externalId: "todo-1",
    title: "Submit assignment",
    notes: null,
    parentId: null,
    position: null,
    sourceUrl: null,
    state: "completed",
    sourceState: "completed",
    dueDate: "2026-09-18",
    completedAt: null,
    updatedAt: "2026-09-11T12:00:00.000Z",
    version: null,
    isDeleted: false,
  }]);
  assert.ok(!JSON.stringify(result).includes("private note"));
  const first = new URL(transport.requests[0].url);
  assert.equal(first.pathname, "/v1.0/me/todo/lists/tasks-list/tasks");
  assert.equal(first.searchParams.get("$select"), "id,title,status,dueDateTime,lastModifiedDateTime");
  assert.ok(!first.searchParams.get("$select")?.includes("body"));
  assertReadOnly(transport.requests);

  const hostile = queuedFetch(json({
    value: [],
    "@odata.nextLink": "https://example.test/collect-token",
  }));
  const rejected = await listMicrosoftCalendars(client(hostile.fetch));
  assert.equal(rejected.status, "invalid-response");
  assert.equal(hostile.requests.length, 1);
  assertReadOnly(hostile.requests);
});

test("provider failures are classified without reading provider error bodies", async () => {
  const transport = queuedFetch(new Response("private provider error", {
    status: 429,
    headers: { "retry-after": "15" },
  }));

  const result = await listGoogleCalendars(client(transport.fetch));

  assert.deepEqual(result, {
    status: "rate-limited",
    provider: "google",
    operation: "google.calendar-list",
    httpStatus: 429,
    retryAfterSeconds: 15,
  });
});

test("malformed provider records fail the whole response instead of being silently imported", async () => {
  const transport = queuedFetch(json({
    items: [{
      id: "bad-event",
      status: "confirmed",
      start: { dateTime: "2026-02-30T09:00:00Z" },
      end: { dateTime: "2026-02-30T10:00:00Z" },
    }],
  }));

  const result = await listGoogleCalendarEvents(client(transport.fetch), {
    calendarId: "primary",
    timeMin: "2026-09-01T00:00:00Z",
    timeMax: "2026-10-01T00:00:00Z",
  });

  assert.deepEqual(result, {
    status: "invalid-response",
    provider: "google",
    operation: "google.calendar-events",
  });
});

test('Google completion tolerates an ETag-only change and uses the fresh conditional version', async () => {
  const baseline = { title: 'Review project', notes: 'Check references', state: 'open' as const, dueOn: '2026-09-21', parentId: null };
  const transport = queuedFetch(
    json({ id: 'task-1', title: baseline.title, notes: baseline.notes, status: 'needsAction', due: '2026-09-21T00:00:00.000Z', etag: '"fresh"', position: 'changed-position' }),
    json({ id: 'task-1', status: 'completed', etag: '"done"' }),
    json({ id: 'task-1', title: baseline.title, notes: baseline.notes, status: 'completed', due: '2026-09-21T00:00:00.000Z', etag: '"done"', completed: '2026-09-15T20:00:00Z' }),
  );
  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: 'list-1', taskId: 'task-1', state: 'completed', expectedEtag: '"stale"',
    expectedContentHash: taskCompletionFingerprint(baseline),
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(transport.requests.map(request => request.init.method), ['GET', 'PATCH', 'GET']);
  assert.equal(new Headers(transport.requests[1].init.headers).get('If-Match'), '"fresh"');
  assert.equal(transport.requests[1].init.body, '{"status":"completed"}');
});

for (const [field, changed] of Object.entries({ title: 'Renamed task', notes: 'Different instructions', due: '2026-09-22T00:00:00.000Z', parent: 'new-parent' })) {
  test(`Google completion still rejects a changed ${field} after approval`, async () => {
    const baseline = { title: 'Review project', notes: 'Check references', state: 'open' as const, dueOn: '2026-09-21', parentId: null };
    const transport = queuedFetch(json({ id: 'task-1', title: baseline.title, notes: baseline.notes, status: 'needsAction', due: '2026-09-21T00:00:00.000Z', etag: '"fresh"', [field]: changed }));
    const result = await updateGoogleTaskStatus(client(transport.fetch), {
      taskListId: 'list-1', taskId: 'task-1', state: 'completed', expectedEtag: '"stale"',
      expectedContentHash: taskCompletionFingerprint(baseline),
    });
    assert.equal(result.status, 'conflict');
    assert.equal(transport.requests.length, 1, 'a meaningful edit must not be overwritten');
  });
}

test('Google completion still rejects an edit racing the rebased conditional write', async () => {
  const baseline = { title: 'Review project', notes: null, state: 'open' as const, dueOn: null, parentId: null };
  const transport = queuedFetch(
    json({ id: 'task-1', title: baseline.title, status: 'needsAction', etag: '"fresh"' }),
    new Response(null, { status: 412 }),
    json({ id: 'task-1', title: 'Changed during write', status: 'needsAction', etag: '"raced"' }),
  );
  const result = await updateGoogleTaskStatus(client(transport.fetch), {
    taskListId: 'list-1', taskId: 'task-1', state: 'completed', expectedEtag: '"stale"',
    expectedContentHash: taskCompletionFingerprint(baseline),
  });
  assert.equal(result.status, 'conflict');
  assert.equal(transport.requests.filter(request => request.init.method === 'PATCH').length, 1);
});
