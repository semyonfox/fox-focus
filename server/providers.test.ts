import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listGoogleCalendarEvents,
  listGoogleCalendarChanges,
  listGoogleCalendars,
  listGoogleCalendarSnapshot,
  listGoogleTasks,
  listMicrosoftCalendarView,
  listMicrosoftCalendars,
  listMicrosoftTodoTasks,
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

test("Google Tasks follows pagination and requests completed, hidden, and deleted tasks without notes", async () => {
  const transport = queuedFetch(
    json({
      items: [{
        id: "done",
        title: "Renew library book",
        status: "completed",
        due: "2026-09-12T00:00:00.000Z",
        completed: "2026-09-11T08:00:00Z",
        updated: "2026-09-11T08:00:00Z",
        notes: "private task note",
      }],
      nextPageToken: "next",
    }),
    json({ items: [{ id: "deleted", title: "Old item", deleted: true }] }),
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
      state: "completed",
      sourceState: "completed",
      dueDate: "2026-09-12",
      completedAt: "2026-09-11T08:00:00.000Z",
      updatedAt: "2026-09-11T08:00:00.000Z",
      isDeleted: false,
    },
    {
      provider: "google",
      taskListId: "list/with slash",
      externalId: "deleted",
      title: "Old item",
      state: "open",
      sourceState: "deleted",
      dueDate: null,
      completedAt: null,
      updatedAt: null,
      isDeleted: true,
    },
  ]);
  assert.ok(!JSON.stringify(result).includes("private task note"));
  const first = new URL(transport.requests[0].url);
  assert.equal(first.pathname, "/tasks/v1/lists/list%2Fwith%20slash/tasks");
  assert.equal(first.searchParams.get("showCompleted"), "true");
  assert.equal(first.searchParams.get("showHidden"), "true");
  assert.equal(first.searchParams.get("showDeleted"), "true");
  assert.ok(!first.searchParams.get("fields")?.includes("notes"));
  assert.equal(new URL(transport.requests[1].url).searchParams.get("pageToken"), "next");
  assertReadOnly(transport.requests);
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
    state: "completed",
    sourceState: "completed",
    dueDate: "2026-09-18",
    completedAt: null,
    updatedAt: "2026-09-11T12:00:00.000Z",
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
