/**
 * Narrow provider adapters.
 *
 * The callers own OAuth, token persistence, scheduling, database writes, and
 * approval. Reads are intentionally field-limited. The sole write operation is
 * an exact Google Task status transition followed by a readback; this module
 * exposes no create, delete, clear, or broad update primitive.
 *
 * An injected fetch implementation keeps the adapter deterministic and means
 * it never discovers, reads, logs, or persists credentials itself.
 */

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_TASKS_API = "https://tasks.googleapis.com/tasks/v1";
const MICROSOFT_GRAPH_API = "https://graph.microsoft.com/v1.0";
const MICROSOFT_DUBLIN_TIME_ZONE = "GMT Standard Time";
const MAX_PAGES_PER_READ = 1_000;

export type Provider = "google" | "microsoft";

export type ProviderOperation =
  | "google.calendar-list"
  | "google.calendar-events"
  | "google.calendar-snapshot"
  | "google.calendar-changes"
  | "google.task-lists"
  | "google.tasks"
  | "google.task-status-update"
  | "microsoft.calendar-list"
  | "microsoft.calendar-view"
  | "microsoft.todo-lists"
  | "microsoft.todo-tasks";

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProviderReadClient {
  /** A short-lived access token supplied by the connection layer. */
  readonly accessToken: string;
  /** Injected to keep this adapter deterministic and independent of token storage. */
  readonly fetch: ProviderFetch;
  readonly signal?: AbortSignal;
}

export type ProviderReadFailureStatus =
  | "invalid-request"
  | "reauthorization-required"
  | "permission-denied"
  | "not-found"
  | "resync-required"
  | "rate-limited"
  | "remote-error"
  | "invalid-response"
  | "network-error";

export interface ProviderReadFailure {
  readonly status: ProviderReadFailureStatus;
  readonly provider: Provider;
  readonly operation: ProviderOperation;
  /** Present only when the provider returned an HTTP response. */
  readonly httpStatus?: number;
  /** A safe, parsed Retry-After value when the provider supplied one. */
  readonly retryAfterSeconds?: number;
}

export interface ProviderReadSuccess<T> {
  readonly status: "ok";
  readonly provider: Provider;
  readonly operation: ProviderOperation;
  readonly pageCount: number;
  readonly value: T;
}

export type ProviderReadResult<T> = ProviderReadSuccess<T> | ProviderReadFailure;

export type ProviderWriteFailureStatus =
  | ProviderReadFailureStatus
  | "conflict"
  | "verification-failed";

export type ProviderWritePhase = "preflight" | "update" | "readback";

export interface ProviderWriteFailure {
  readonly status: ProviderWriteFailureStatus;
  readonly provider: Provider;
  readonly operation: ProviderOperation;
  readonly phase: ProviderWritePhase;
  /** Present only when the provider returned an HTTP response. */
  readonly httpStatus?: number;
  /** A safe, parsed Retry-After value when the provider supplied one. */
  readonly retryAfterSeconds?: number;
}

export interface ProviderWriteSuccess<T> {
  readonly status: "ok";
  readonly provider: Provider;
  readonly operation: ProviderOperation;
  readonly value: T;
}

export type ProviderWriteResult<T> = ProviderWriteSuccess<T> | ProviderWriteFailure;

/** A source time intentionally distinguishes a date-only value from an instant. */
export type ImportedTime =
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "instant"; readonly value: string };

export interface ImportedCalendar {
  readonly provider: Provider;
  readonly externalId: string;
  readonly title: string;
  readonly isPrimary: boolean;
}

interface ImportedCalendarEventBase {
  readonly provider: Provider;
  readonly calendarId: string;
  readonly externalId: string;
  readonly title: string;
  readonly updatedAt: string | null;
}

export interface ImportedActiveCalendarEvent extends ImportedCalendarEventBase {
  readonly state: "active";
  readonly start: ImportedTime;
  readonly end: ImportedTime;
  readonly isAllDay: boolean;
}

/** Cancelled event tombstones can legally omit event timing and title fields. */
export interface ImportedCancelledCalendarEvent extends ImportedCalendarEventBase {
  readonly state: "cancelled";
  readonly start: null;
  readonly end: null;
  readonly isAllDay: null;
}

export type ImportedCalendarEvent =
  | ImportedActiveCalendarEvent
  | ImportedCancelledCalendarEvent;

export interface ImportedTaskList {
  readonly provider: Provider;
  readonly externalId: string;
  readonly title: string;
}

export interface ImportedTask {
  readonly provider: Provider;
  readonly taskListId: string;
  readonly externalId: string;
  readonly title: string;
  readonly notes: string | null;
  readonly parentId: string | null;
  readonly position: string | null;
  readonly sourceUrl: string | null;
  readonly state: "open" | "completed";
  /** The provider's non-sensitive state, retained for deterministic mappings. */
  readonly sourceState: string;
  /** A date-only due value. Neither provider supplies a reliable due instant. */
  readonly dueDate: string | null;
  /** Only populated when the source provides an unambiguous UTC instant. */
  readonly completedAt: string | null;
  readonly updatedAt: string | null;
  /** Provider concurrency token. Google supplies the task ETag. */
  readonly version: string | null;
  /** Google supplies task tombstones; Microsoft polling does not. */
  readonly isDeleted: boolean;
  /** False for provider-owned assignments that this app must not mutate. */
  readonly completionWritable?: boolean;
}

export interface GoogleCalendarEventsInput {
  readonly calendarId: string;
  readonly timeMin: string;
  readonly timeMax: string;
}

export interface GoogleCalendarChangesInput {
  readonly calendarId: string;
  readonly syncToken: string;
}

/** A complete source snapshot used solely to establish a Google sync cursor. */
export interface GoogleCalendarSnapshotInput {
  readonly calendarId: string;
}

export interface GoogleTaskListTasksInput {
  readonly taskListId: string;
}

export interface GoogleTaskStatusUpdateInput {
  readonly taskListId: string;
  readonly taskId: string;
  readonly state: "open" | "completed";
  /** The task ETag captured during import. Sent as If-Match when present. */
  readonly expectedEtag?: string;
}

export interface GoogleTaskStatusUpdate {
  readonly taskListId: string;
  readonly taskId: string;
  readonly requestedState: "open" | "completed";
  readonly etag: string;
  /** Exact task returned by a GET after the PATCH completed. */
  readonly task: ImportedTask;
}

export interface MicrosoftCalendarViewInput {
  readonly calendarId: string;
  readonly startDateTime: string;
  readonly endDateTime: string;
}

export interface MicrosoftTodoTasksInput {
  readonly taskListId: string;
}

export interface GoogleCalendarEventsBatch {
  readonly events: readonly ImportedCalendarEvent[];
  /** Save this only after a complete, successful snapshot or incremental read. */
  readonly nextSyncToken: string | null;
}

export interface ProviderCollection<T> {
  readonly records: readonly T[];
}

type PaginationPage<T, M> = {
  readonly records: readonly T[];
  readonly nextCursor: string | null;
  readonly metadata: M;
};

type CollectedPages<T, M> = {
  readonly records: readonly T[];
  readonly finalMetadata: M;
};

const INVALID = Symbol("invalid-provider-value");
type Invalid = typeof INVALID;

function failure(
  status: ProviderReadFailureStatus,
  provider: Provider,
  operation: ProviderOperation,
  extras: Pick<ProviderReadFailure, "httpStatus" | "retryAfterSeconds"> = {},
): ProviderReadFailure {
  return { status, provider, operation, ...extras };
}

function success<T>(
  provider: Provider,
  operation: ProviderOperation,
  pageCount: number,
  value: T,
): ProviderReadSuccess<T> {
  return { status: "ok", provider, operation, pageCount, value };
}

function writeFailure(
  status: ProviderWriteFailureStatus,
  provider: Provider,
  operation: ProviderOperation,
  phase: ProviderWritePhase,
  extras: Pick<ProviderWriteFailure, "httpStatus" | "retryAfterSeconds"> = {},
): ProviderWriteFailure {
  return { status, provider, operation, phase, ...extras };
}

function writeSuccess<T>(
  provider: Provider,
  operation: ProviderOperation,
  value: T,
): ProviderWriteSuccess<T> {
  return { status: "ok", provider, operation, value };
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const candidate = new Date(0);
  candidate.setUTCFullYear(year, month - 1, day);
  candidate.setUTCHours(0, 0, 0, 0);
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function asCanonicalInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !isValidDate(match[1])) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function asCanonicalDate(value: unknown): string | null {
  return typeof value === "string" && isValidDate(value) ? value : null;
}

function dateFromProviderDue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = value.slice(0, 10);
  if (!isValidDate(date)) return null;
  return value === date || asCanonicalInstant(value) !== null ? date : null;
}

function optionalInstant(value: unknown): string | null | Invalid {
  if (value === undefined || value === null) return null;
  return asCanonicalInstant(value) ?? INVALID;
}

function optionalText(value: unknown): string | null | Invalid {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : INVALID;
}

function optionalGoogleTaskNotes(value: unknown): string | null | Invalid {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.length <= 8_192 ? value : INVALID;
}

function optionalVersion(value: unknown): string | null | Invalid {
  if (value === undefined || value === null) return null;
  return isNonEmptyText(value) && value.length <= 1_024 && !/[\r\n]/.test(value)
    ? value
    : INVALID;
}

function optionalGoogleTaskUrl(value: unknown): string | null | Invalid {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  try {
    const url = new URL(value);
    return url.origin === "https://tasks.google.com"
      && url.username === ""
      && url.password === ""
      ? url.toString()
      : INVALID;
  } catch {
    return INVALID;
  }
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | Invalid {
  if (value === undefined || value === null) return fallback;
  return typeof value === "boolean" ? value : INVALID;
}

function titleOrFallback(value: string | null, fallback: string): string {
  const title = value?.trim() ?? "";
  return title || fallback;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function httpFailure(
  provider: Provider,
  operation: ProviderOperation,
  response: Response,
): ProviderReadFailure {
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  const extras = {
    httpStatus: response.status,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
  if (response.status === 401) return failure("reauthorization-required", provider, operation, extras);
  if (response.status === 403) return failure("permission-denied", provider, operation, extras);
  if (response.status === 404) return failure("not-found", provider, operation, extras);
  if (response.status === 410) return failure("resync-required", provider, operation, extras);
  if (response.status === 429) return failure("rate-limited", provider, operation, extras);
  return failure("remote-error", provider, operation, extras);
}

function writeHttpFailure(
  provider: Provider,
  operation: ProviderOperation,
  phase: ProviderWritePhase,
  response: Response,
): ProviderWriteFailure {
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  const extras = {
    httpStatus: response.status,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
  if (response.status === 409 || response.status === 412) {
    return writeFailure("conflict", provider, operation, phase, extras);
  }
  const readFailure = httpFailure(provider, operation, response);
  return writeFailure(readFailure.status, provider, operation, phase, extras);
}

function asWriteFailure(
  readFailure: ProviderReadFailure,
  phase: ProviderWritePhase,
): ProviderWriteFailure {
  return writeFailure(readFailure.status, readFailure.provider, readFailure.operation, phase, {
    ...(readFailure.httpStatus === undefined ? {} : { httpStatus: readFailure.httpStatus }),
    ...(readFailure.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: readFailure.retryAfterSeconds }),
  });
}

function validateClient(
  client: ProviderReadClient,
  provider: Provider,
  operation: ProviderOperation,
): ProviderReadFailure | null {
  if (
    !isNonEmptyText(client.accessToken)
    || /[\r\n]/.test(client.accessToken)
    || typeof client.fetch !== "function"
  ) return failure("invalid-request", provider, operation);
  return null;
}

async function fetchJson(
  client: ProviderReadClient,
  provider: Provider,
  operation: ProviderOperation,
  url: string,
  headers: HeadersInit,
): Promise<{ readonly payload: unknown } | { readonly error: ProviderReadFailure }> {
  let response: Response;
  try {
    response = await client.fetch(url, {
      method: "GET",
      headers,
      signal: client.signal,
    });
  } catch {
    return { error: failure("network-error", provider, operation) };
  }

  if (!response.ok) return { error: httpFailure(provider, operation, response) };

  try {
    const payload: unknown = await response.json();
    return { payload };
  } catch {
    return { error: failure("invalid-response", provider, operation) };
  }
}

async function collectPages<T, M>(options: {
  readonly client: ProviderReadClient;
  readonly provider: Provider;
  readonly operation: ProviderOperation;
  readonly initialUrl: string;
  readonly nextUrl: (cursor: string) => string | null;
  readonly headers: HeadersInit;
  readonly parse: (payload: unknown) => PaginationPage<T, M> | null;
}): Promise<ProviderReadResult<CollectedPages<T, M>>> {
  const clientError = validateClient(options.client, options.provider, options.operation);
  if (clientError) return clientError;

  const seenUrls = new Set<string>();
  const records: T[] = [];
  let url = options.initialUrl;
  let pageCount = 0;

  while (pageCount < MAX_PAGES_PER_READ) {
    if (seenUrls.has(url)) return failure("invalid-response", options.provider, options.operation);
    seenUrls.add(url);
    pageCount += 1;

    const response = await fetchJson(
      options.client,
      options.provider,
      options.operation,
      url,
      options.headers,
    );
    if ("error" in response) return response.error;

    const page = options.parse(response.payload);
    if (!page) return failure("invalid-response", options.provider, options.operation);
    records.push(...page.records);

    if (page.nextCursor === null) {
      return success(options.provider, options.operation, pageCount, {
        records,
        finalMetadata: page.metadata,
      });
    }

    const nextUrl = options.nextUrl(page.nextCursor);
    if (nextUrl === null) return failure("invalid-response", options.provider, options.operation);
    url = nextUrl;
  }

  return failure("invalid-response", options.provider, options.operation);
}

function pageToken(value: unknown): string | null | Invalid {
  if (value === undefined || value === null) return null;
  return isNonEmptyText(value) ? value : INVALID;
}

function parseGooglePage<T, M>(
  payload: unknown,
  itemParser: (item: unknown) => T | null,
  metadataParser: (record: Record<string, unknown>) => M | null,
): PaginationPage<T, M> | null {
  if (!isRecord(payload)) return null;
  const rawItems = payload.items;
  if (rawItems !== undefined && !Array.isArray(rawItems)) return null;
  const records: T[] = [];
  for (const item of rawItems ?? []) {
    const parsed = itemParser(item);
    if (parsed === null) return null;
    records.push(parsed);
  }
  const nextCursor = pageToken(payload.nextPageToken);
  if (nextCursor === INVALID) return null;
  const metadata = metadataParser(payload);
  if (metadata === null) return null;
  return { records, nextCursor, metadata };
}

function parseGoogleCalendar(value: unknown): ImportedCalendar | null {
  if (!isRecord(value) || !isNonEmptyText(value.id)) return null;
  const title = optionalText(value.summary);
  const primary = optionalBoolean(value.primary, false);
  if (title === INVALID || primary === INVALID) return null;
  return {
    provider: "google",
    externalId: value.id,
    title: titleOrFallback(title, "Untitled calendar"),
    isPrimary: primary,
  };
}

function parseGoogleTime(value: unknown): ImportedTime | null {
  if (!isRecord(value)) return null;
  const date = value.date;
  const dateTime = value.dateTime;
  const timeZone = value.timeZone;
  if (timeZone !== undefined && timeZone !== null && typeof timeZone !== "string") return null;
  if (date !== undefined && date !== null) {
    if (dateTime !== undefined && dateTime !== null) return null;
    const parsed = asCanonicalDate(date);
    return parsed === null ? null : { kind: "date", value: parsed };
  }
  const parsed = asCanonicalInstant(dateTime);
  return parsed === null ? null : { kind: "instant", value: parsed };
}

function parseGoogleCalendarEvent(calendarId: string, value: unknown): ImportedCalendarEvent | null {
  if (!isRecord(value) || !isNonEmptyText(value.id) || typeof value.status !== "string") return null;
  const title = optionalText(value.summary);
  const updatedAt = optionalInstant(value.updated);
  if (title === INVALID || updatedAt === INVALID) return null;

  if (value.status === "cancelled") {
    return {
      provider: "google",
      calendarId,
      externalId: value.id,
      title: titleOrFallback(title, "Cancelled event"),
      state: "cancelled",
      start: null,
      end: null,
      isAllDay: null,
      updatedAt,
    };
  }
  if (value.status !== "confirmed" && value.status !== "tentative") return null;

  const start = parseGoogleTime(value.start);
  const end = parseGoogleTime(value.end);
  if (start === null || end === null || start.kind !== end.kind) return null;
  return {
    provider: "google",
    calendarId,
    externalId: value.id,
    title: titleOrFallback(title, "Untitled event"),
    state: "active",
    start,
    end,
    isAllDay: start.kind === "date",
    updatedAt,
  };
}

function parseGoogleTaskList(value: unknown): ImportedTaskList | null {
  if (!isRecord(value) || !isNonEmptyText(value.id)) return null;
  const title = optionalText(value.title);
  if (title === INVALID) return null;
  return {
    provider: "google",
    externalId: value.id,
    title: titleOrFallback(title, "Untitled task list"),
  };
}

function parseGoogleTask(taskListId: string, value: unknown): ImportedTask | null {
  if (!isRecord(value) || !isNonEmptyText(value.id)) return null;
  const isDeleted = optionalBoolean(value.deleted, false);
  if (isDeleted === INVALID) return null;
  const sourceState = value.status === undefined || value.status === null
    ? isDeleted ? "deleted" : null
    : typeof value.status === "string" ? value.status : null;
  if (sourceState === null || (sourceState !== "needsAction" && sourceState !== "completed" && sourceState !== "deleted")) {
    return null;
  }
  if (!isDeleted && sourceState === "deleted") return null;
  const title = optionalText(value.title);
  const notes = optionalGoogleTaskNotes(value.notes);
  const parentId = optionalVersion(value.parent);
  const position = optionalVersion(value.position);
  const sourceUrl = optionalGoogleTaskUrl(value.webViewLink);
  const due = optionalText(value.due);
  const completedAt = optionalInstant(value.completed);
  const updatedAt = optionalInstant(value.updated);
  const version = optionalVersion(value.etag);
  const isAssigned = value.assignmentInfo !== undefined && value.assignmentInfo !== null;
  if (
    title === INVALID
    || notes === INVALID
    || parentId === INVALID
    || position === INVALID
    || sourceUrl === INVALID
    || due === INVALID
    || completedAt === INVALID
    || updatedAt === INVALID
    || version === INVALID
    || (isAssigned && !isRecord(value.assignmentInfo))
  ) return null;
  const dueDate = due === null ? null : dateFromProviderDue(due);
  if (due !== null && dueDate === null) return null;
  return {
    provider: "google",
    taskListId,
    externalId: value.id,
    title: titleOrFallback(title, "Untitled task"),
    notes,
    parentId,
    position,
    sourceUrl,
    state: sourceState === "completed" ? "completed" : "open",
    sourceState,
    dueDate,
    completedAt,
    updatedAt,
    version,
    isDeleted,
    ...(isAssigned ? { completionWritable: false } : {}),
  };
}

function googleHeaders(accessToken: string): Readonly<Record<string, string>> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

function googleUrl(path: string, parameters: Readonly<Record<string, string>>): string {
  const url = new URL(`${GOOGLE_CALENDAR_API}${path}`);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.toString();
}

function googleTasksUrl(path: string, parameters: Readonly<Record<string, string>>): string {
  const url = new URL(`${GOOGLE_TASKS_API}${path}`);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.toString();
}

function googlePagedUrl(
  makeBaseUrl: () => string,
  cursor: string | null,
): string {
  const url = new URL(makeBaseUrl());
  if (cursor !== null) url.searchParams.set("pageToken", cursor);
  return url.toString();
}

const googleCalendarListFields = "items(id,summary,primary),nextPageToken";
const googleCalendarEventFields = "items(id,status,summary,start(date,dateTime,timeZone),end(date,dateTime,timeZone),updated),nextPageToken,nextSyncToken";
const googleTaskListFields = "items(id,title),nextPageToken";
const googleTaskResourceFields = "id,title,notes,parent,position,webViewLink,status,due,completed,updated,deleted,etag,assignmentInfo";
const googleTaskFields = `items(${googleTaskResourceFields}),nextPageToken`;

/** Lists visible Google calendars. No calendar contents are requested here. */
export async function listGoogleCalendars(
  client: ProviderReadClient,
): Promise<ProviderReadResult<ProviderCollection<ImportedCalendar>>> {
  const operation: ProviderOperation = "google.calendar-list";
  const makeBaseUrl = () => googleUrl("/users/me/calendarList", {
    fields: googleCalendarListFields,
    maxResults: "250",
  });
  const result = await collectPages({
    client,
    provider: "google",
    operation,
    initialUrl: googlePagedUrl(makeBaseUrl, null),
    nextUrl: cursor => googlePagedUrl(makeBaseUrl, cursor),
    headers: googleHeaders(client.accessToken),
    parse: payload => parseGooglePage(payload, parseGoogleCalendar, () => undefined),
  });
  if (result.status !== "ok") return result;
  return success("google", operation, result.pageCount, { records: result.value.records });
}

function validRange(start: unknown, end: unknown): { readonly start: string; readonly end: string } | null {
  const normalizedStart = asCanonicalInstant(start);
  const normalizedEnd = asCanonicalInstant(end);
  if (normalizedStart === null || normalizedEnd === null) return null;
  return Date.parse(normalizedStart) < Date.parse(normalizedEnd)
    ? { start: normalizedStart, end: normalizedEnd }
    : null;
}

async function readGoogleCalendarEventPages(
  client: ProviderReadClient,
  operation: "google.calendar-events" | "google.calendar-snapshot" | "google.calendar-changes",
  calendarId: string,
  query: Readonly<Record<string, string>>,
  retainSyncToken: boolean,
): Promise<ProviderReadResult<GoogleCalendarEventsBatch>> {
  if (!isNonEmptyText(calendarId)) return failure("invalid-request", "google", operation);
  const encodedCalendarId = encodeURIComponent(calendarId);
  const makeBaseUrl = () => googleUrl(`/calendars/${encodedCalendarId}/events`, {
    fields: googleCalendarEventFields,
    maxResults: "2500",
    showDeleted: "true",
    singleEvents: "true",
    ...query,
  });
  const result = await collectPages({
    client,
    provider: "google",
    operation,
    initialUrl: googlePagedUrl(makeBaseUrl, null),
    nextUrl: cursor => googlePagedUrl(makeBaseUrl, cursor),
    headers: googleHeaders(client.accessToken),
    parse: payload => parseGooglePage(
      payload,
      value => parseGoogleCalendarEvent(calendarId, value),
      record => {
        const token = pageToken(record.nextSyncToken);
        return token === INVALID ? null : { nextSyncToken: token };
      },
    ),
  });
  if (result.status !== "ok") return result;
  return success("google", operation, result.pageCount, {
    events: result.value.records,
    // Google prohibits using timeMin/timeMax with a sync token. A bounded UI
    // window therefore must poll and must never seed the incremental cursor.
    nextSyncToken: retainSyncToken ? result.value.finalMetadata.nextSyncToken : null,
  });
}

/** Reads a bounded Google calendar window, including cancelled-event tombstones. */
export async function listGoogleCalendarEvents(
  client: ProviderReadClient,
  input: GoogleCalendarEventsInput,
): Promise<ProviderReadResult<GoogleCalendarEventsBatch>> {
  const operation: ProviderOperation = "google.calendar-events";
  const range = validRange(input.timeMin, input.timeMax);
  if (range === null) return failure("invalid-request", "google", operation);
  return readGoogleCalendarEventPages(client, operation, input.calendarId, {
    timeMin: range.start,
    timeMax: range.end,
  }, false);
}

/**
 * Reads a complete Google calendar snapshot and returns the compatible cursor
 * for later `listGoogleCalendarChanges` calls. This is intentionally separate
 * from the bounded context read above because Google forbids time bounds when
 * a sync token is used.
 */
export async function listGoogleCalendarSnapshot(
  client: ProviderReadClient,
  input: GoogleCalendarSnapshotInput,
): Promise<ProviderReadResult<GoogleCalendarEventsBatch>> {
  return readGoogleCalendarEventPages(
    client,
    "google.calendar-snapshot",
    input.calendarId,
    {},
    true,
  );
}

/** Reads Google event changes using an already-established sync token. */
export async function listGoogleCalendarChanges(
  client: ProviderReadClient,
  input: GoogleCalendarChangesInput,
): Promise<ProviderReadResult<GoogleCalendarEventsBatch>> {
  const operation: ProviderOperation = "google.calendar-changes";
  if (!isNonEmptyText(input.syncToken)) return failure("invalid-request", "google", operation);
  return readGoogleCalendarEventPages(client, operation, input.calendarId, {
    syncToken: input.syncToken,
  }, true);
}

/** Lists Google Task lists. Individual tasks are intentionally a separate call. */
export async function listGoogleTaskLists(
  client: ProviderReadClient,
): Promise<ProviderReadResult<ProviderCollection<ImportedTaskList>>> {
  const operation: ProviderOperation = "google.task-lists";
  const makeBaseUrl = () => googleTasksUrl("/users/@me/lists", {
    fields: googleTaskListFields,
    maxResults: "100",
  });
  const result = await collectPages({
    client,
    provider: "google",
    operation,
    initialUrl: googlePagedUrl(makeBaseUrl, null),
    nextUrl: cursor => googlePagedUrl(makeBaseUrl, cursor),
    headers: googleHeaders(client.accessToken),
    parse: payload => parseGooglePage(payload, parseGoogleTaskList, () => undefined),
  });
  if (result.status !== "ok") return result;
  return success("google", operation, result.pageCount, { records: result.value.records });
}

/** Reads all Google tasks, including completed, hidden, and deleted task records. */
export async function listGoogleTasks(
  client: ProviderReadClient,
  input: GoogleTaskListTasksInput,
): Promise<ProviderReadResult<ProviderCollection<ImportedTask>>> {
  const operation: ProviderOperation = "google.tasks";
  if (!isNonEmptyText(input.taskListId)) return failure("invalid-request", "google", operation);
  const encodedTaskListId = encodeURIComponent(input.taskListId);
  const makeBaseUrl = () => googleTasksUrl(`/lists/${encodedTaskListId}/tasks`, {
    fields: googleTaskFields,
    maxResults: "100",
    showAssigned: "true",
    showCompleted: "true",
    showDeleted: "true",
    showHidden: "true",
  });
  const result = await collectPages({
    client,
    provider: "google",
    operation,
    initialUrl: googlePagedUrl(makeBaseUrl, null),
    nextUrl: cursor => googlePagedUrl(makeBaseUrl, cursor),
    headers: googleHeaders(client.accessToken),
    parse: payload => parseGooglePage(
      payload,
      value => parseGoogleTask(input.taskListId, value),
      () => undefined,
    ),
  });
  if (result.status !== "ok") return result;
  return success("google", operation, result.pageCount, { records: result.value.records });
}

/**
 * Changes only the completion state of one already-existing Google Task.
 *
 * The caller must perform and persist user approval before invoking this. An
 * imported ETag should be supplied whenever available so a changed upstream
 * task fails safely instead of being overwritten. A successful PATCH is never
 * trusted on its own: the exact task is fetched and verified before success is
 * returned.
 */
export async function updateGoogleTaskStatus(
  client: ProviderReadClient,
  input: GoogleTaskStatusUpdateInput,
): Promise<ProviderWriteResult<GoogleTaskStatusUpdate>> {
  const operation: ProviderOperation = "google.task-status-update";
  if (
    !isNonEmptyText(input.taskListId)
    || !isNonEmptyText(input.taskId)
    || (input.state !== "open" && input.state !== "completed")
    || (input.expectedEtag !== undefined && optionalVersion(input.expectedEtag) === INVALID)
  ) return writeFailure("invalid-request", "google", operation, "update");

  const clientError = validateClient(client, "google", operation);
  if (clientError) return asWriteFailure(clientError, "update");

  const encodedTaskListId = encodeURIComponent(input.taskListId);
  const encodedTaskId = encodeURIComponent(input.taskId);
  const resourcePath = `/lists/${encodedTaskListId}/tasks/${encodedTaskId}`;
  const requestedSourceState = input.state === "completed" ? "completed" : "needsAction";
  const readUrl = googleTasksUrl(resourcePath, { fields: googleTaskResourceFields });
  const preflight = await fetchJson(client, "google", operation, readUrl, googleHeaders(client.accessToken));
  if ("error" in preflight) return asWriteFailure(preflight.error, "preflight");
  const currentTask = parseGoogleTask(input.taskListId, preflight.payload);
  if (currentTask === null || currentTask.externalId !== input.taskId) {
    return writeFailure("invalid-response", "google", operation, "preflight");
  }
  if (currentTask.isDeleted || currentTask.version === null) {
    return writeFailure("verification-failed", "google", operation, "preflight");
  }
  if (currentTask.completionWritable === false) {
    return writeFailure("verification-failed", "google", operation, "preflight");
  }
  if (currentTask.state === input.state && (input.state === "completed" || currentTask.completedAt === null)) {
    return writeSuccess("google", operation, {
      taskListId: input.taskListId,
      taskId: input.taskId,
      requestedState: input.state,
      etag: currentTask.version,
      task: currentTask,
    });
  }
  if (input.expectedEtag !== undefined && currentTask.version !== input.expectedEtag) {
    return writeFailure("conflict", "google", operation, "preflight", { httpStatus: 412 });
  }

  const patchUrl = googleTasksUrl(resourcePath, { fields: "id,status,etag" });

  let patchResponse: Response;
  try {
    patchResponse = await client.fetch(patchUrl, {
      method: "PATCH",
      headers: {
        ...googleHeaders(client.accessToken),
        "Content-Type": "application/json",
        "If-Match": currentTask.version,
      },
      body: JSON.stringify({ status: requestedSourceState }),
      signal: client.signal,
    });
  } catch {
    return writeFailure("network-error", "google", operation, "update");
  }

  if (!patchResponse.ok) return writeHttpFailure("google", operation, "update", patchResponse);
  if (patchResponse.body !== null) {
    try {
      await patchResponse.body.cancel();
    } catch {
      // The status write has already succeeded. Verification below is the
      // authoritative result even if the unused response body cannot close.
    }
  }

  const readback = await fetchJson(
    client,
    "google",
    operation,
    readUrl,
    googleHeaders(client.accessToken),
  );
  if ("error" in readback) return asWriteFailure(readback.error, "readback");

  const task = parseGoogleTask(input.taskListId, readback.payload);
  if (task === null || task.externalId !== input.taskId) {
    return writeFailure("invalid-response", "google", operation, "readback");
  }
  if (
    task.isDeleted
    || task.state !== input.state
    || task.version === null
    || (input.state === "open" && task.completedAt !== null)
  ) return writeFailure("verification-failed", "google", operation, "readback");

  return writeSuccess("google", operation, {
    taskListId: input.taskListId,
    taskId: input.taskId,
    requestedState: input.state,
    etag: task.version,
    task,
  });
}

function graphUrl(path: string, parameters: Readonly<Record<string, string>>): string {
  const url = new URL(`${MICROSOFT_GRAPH_API}${path}`);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.toString();
}

function graphNextUrl(expectedPath: string, cursor: string): string | null {
  try {
    const url = new URL(cursor);
    if (url.origin !== "https://graph.microsoft.com") return null;
    // Graph IDs are frequently base64-like strings. Its nextLink may encode
    // those path characters differently from URL's serializer, so compare the
    // decoded endpoint while still rejecting every other Graph route.
    return decodeURIComponent(url.pathname) === decodeURIComponent(expectedPath)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function parseGraphPage<T, M>(
  payload: unknown,
  itemParser: (item: unknown) => T | null,
  metadataParser: (record: Record<string, unknown>) => M | null,
): PaginationPage<T, M> | null {
  if (!isRecord(payload) || !Array.isArray(payload.value)) return null;
  const records: T[] = [];
  for (const item of payload.value) {
    const parsed = itemParser(item);
    if (parsed === null) return null;
    records.push(parsed);
  }
  const nextCursor = pageToken(payload["@odata.nextLink"]);
  if (nextCursor === INVALID) return null;
  const metadata = metadataParser(payload);
  if (metadata === null) return null;
  return { records, nextCursor, metadata };
}

function graphHeaders(accessToken: string, prefer?: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    ...(prefer === undefined ? {} : { Prefer: prefer }),
  };
}

function parseMicrosoftCalendar(value: unknown): ImportedCalendar | null {
  if (!isRecord(value) || !isNonEmptyText(value.id)) return null;
  const title = optionalText(value.name);
  const primary = optionalBoolean(value.isDefaultCalendar, false);
  if (title === INVALID || primary === INVALID) return null;
  return {
    provider: "microsoft",
    externalId: value.id,
    title: titleOrFallback(title, "Untitled calendar"),
    isPrimary: primary,
  };
}

function parseMicrosoftDateTime(value: unknown): { readonly dateTime: string; readonly timeZone: string } | null {
  if (!isRecord(value) || typeof value.dateTime !== "string" || !isNonEmptyText(value.timeZone)) return null;
  const date = value.dateTime.slice(0, 10);
  if (!isValidDate(date) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value.dateTime)) {
    return null;
  }
  return { dateTime: value.dateTime, timeZone: value.timeZone };
}

type DublinDateTimeParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}>;

const dublinFormatter = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function dublinPartNumber(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number | null {
  const value = parts.find(part => part.type === type)?.value;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function dublinPartsAt(instant: number): Omit<DublinDateTimeParts, "millisecond"> | null {
  const parts = dublinFormatter.formatToParts(new Date(instant));
  const year = dublinPartNumber(parts, "year");
  const month = dublinPartNumber(parts, "month");
  const day = dublinPartNumber(parts, "day");
  const hour = dublinPartNumber(parts, "hour");
  const minute = dublinPartNumber(parts, "minute");
  const second = dublinPartNumber(parts, "second");
  return year === null || month === null || day === null || hour === null || minute === null || second === null
    ? null
    : { year, month, day, hour, minute, second };
}

function parseDublinLocalDateTime(value: string): DublinDateTimeParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].slice(0, 3).padEnd(3, "0"));
  if (![year, month, day, hour, minute, second, millisecond].every(Number.isSafeInteger)) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isValidDate(date) || hour > 23 || minute > 59 || second > 59 || millisecond > 999) return null;
  return { year, month, day, hour, minute, second, millisecond };
}

function dublinLocalInstant(value: string): string | null {
  const local = parseDublinLocalDateTime(value);
  if (local === null) return null;
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, local.millisecond);
  const candidates = new Set<number>();
  for (const sample of [naive - 86_400_000, naive, naive + 86_400_000]) {
    const rendered = dublinPartsAt(sample);
    if (rendered === null) return null;
    const wholeSecond = Math.floor(sample / 1_000) * 1_000;
    const offset = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second) - wholeSecond;
    const candidate = naive - offset;
    const check = dublinPartsAt(candidate);
    if (
      check !== null && check.year === local.year && check.month === local.month && check.day === local.day &&
      check.hour === local.hour && check.minute === local.minute && check.second === local.second
    ) candidates.add(candidate);
  }
  if (candidates.size !== 1) return null;
  return new Date([...candidates][0]).toISOString();
}

function parseMicrosoftInstant(value: unknown): string | null {
  const dateTime = parseMicrosoftDateTime(value);
  if (dateTime === null) return null;
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime.dateTime)) return asCanonicalInstant(dateTime.dateTime);
  if (dateTime.timeZone === "UTC") return asCanonicalInstant(`${dateTime.dateTime}Z`);
  return dateTime.timeZone === MICROSOFT_DUBLIN_TIME_ZONE ? dublinLocalInstant(dateTime.dateTime) : null;
}

/**
 * A To Do due date is a calendar date in the time zone carried by the
 * dateTimeTimeZone value. Keep that local date rather than converting a
 * midnight instant, which could move it across a date boundary.
 *
 * Calendar all-day events are different: calendarView is explicitly asked to
 * render them in Dublin, so require that response zone at the call site.
 */
function parseMicrosoftDate(value: unknown, expectedTimeZone?: string): string | null {
  const dateTime = parseMicrosoftDateTime(value);
  if (dateTime === null || (expectedTimeZone !== undefined && dateTime.timeZone !== expectedTimeZone)) return null;
  return /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.\d+)?$/.test(dateTime.dateTime)
    ? dateTime.dateTime.slice(0, 10)
    : null;
}

function parseMicrosoftCalendarEvent(calendarId: string, value: unknown): ImportedCalendarEvent | null {
  if (!isRecord(value) || !isNonEmptyText(value.id)) return null;
  const title = optionalText(value.subject);
  const cancelled = optionalBoolean(value.isCancelled, false);
  if (title === INVALID || cancelled === INVALID) return null;

  if (cancelled) {
    return {
      provider: "microsoft",
      calendarId,
      externalId: value.id,
      title: titleOrFallback(title, "Cancelled event"),
      state: "cancelled",
      start: null,
      end: null,
      isAllDay: null,
      updatedAt: null,
    };
  }

  if (typeof value.isAllDay !== "boolean") return null;
  const start = value.isAllDay
    ? parseMicrosoftDate(value.start, MICROSOFT_DUBLIN_TIME_ZONE)
    : parseMicrosoftInstant(value.start);
  const end = value.isAllDay
    ? parseMicrosoftDate(value.end, MICROSOFT_DUBLIN_TIME_ZONE)
    : parseMicrosoftInstant(value.end);
  if (start === null || end === null) return null;
  return {
    provider: "microsoft",
    calendarId,
    externalId: value.id,
    title: titleOrFallback(title, "Untitled event"),
    state: "active",
    start: value.isAllDay ? { kind: "date", value: start } : { kind: "instant", value: start },
    end: value.isAllDay ? { kind: "date", value: end } : { kind: "instant", value: end },
    isAllDay: value.isAllDay,
    updatedAt: null,
  };
}

function parseMicrosoftTaskList(value: unknown): ImportedTaskList | null {
  if (!isRecord(value) || !isNonEmptyText(value.id)) return null;
  const title = optionalText(value.displayName);
  if (title === INVALID) return null;
  return {
    provider: "microsoft",
    externalId: value.id,
    title: titleOrFallback(title, "Untitled task list"),
  };
}

const microsoftTaskStates = new Set([
  "notStarted",
  "inProgress",
  "completed",
  "waitingOnOthers",
  "deferred",
  "unknownFutureValue",
]);

function parseMicrosoftTask(taskListId: string, value: unknown): ImportedTask | null {
  if (
    !isRecord(value)
    || !isNonEmptyText(value.id)
    || typeof value.status !== "string"
    || !microsoftTaskStates.has(value.status)
  ) return null;
  const title = optionalText(value.title);
  let dueDate: string | null = null;
  if (value.dueDateTime !== undefined && value.dueDateTime !== null) {
    dueDate = parseMicrosoftDate(value.dueDateTime);
    if (dueDate === null) return null;
  }
  const updatedAt = optionalInstant(value.lastModifiedDateTime);
  if (title === INVALID || updatedAt === INVALID) return null;
  return {
    provider: "microsoft",
    taskListId,
    externalId: value.id,
    title: titleOrFallback(title, "Untitled task"),
    notes: null,
    parentId: null,
    position: null,
    sourceUrl: null,
    state: value.status === "completed" ? "completed" : "open",
    sourceState: value.status,
    dueDate,
    completedAt: null,
    updatedAt,
    version: null,
    isDeleted: false,
  };
}

/** Lists Microsoft calendars through Microsoft Graph. */
export async function listMicrosoftCalendars(
  client: ProviderReadClient,
): Promise<ProviderReadResult<ProviderCollection<ImportedCalendar>>> {
  const operation: ProviderOperation = "microsoft.calendar-list";
  const expectedPath = "/v1.0/me/calendars";
  const initialUrl = graphUrl("/me/calendars", {
    "$select": "id,name,isDefaultCalendar",
    "$top": "100",
  });
  const result = await collectPages({
    client,
    provider: "microsoft",
    operation,
    initialUrl,
    nextUrl: cursor => graphNextUrl(expectedPath, cursor),
    headers: graphHeaders(client.accessToken),
    parse: payload => parseGraphPage(payload, parseMicrosoftCalendar, () => undefined),
  });
  if (result.status !== "ok") return result;
  return success("microsoft", operation, result.pageCount, { records: result.value.records });
}

/**
 * Lists a bounded Microsoft calendar view. `Prefer` requests the user's Dublin
 * display zone and immutable IDs, preserving all-day dates across DST while
 * the adapter normalizes timed events to UTC.
 */
export async function listMicrosoftCalendarView(
  client: ProviderReadClient,
  input: MicrosoftCalendarViewInput,
): Promise<ProviderReadResult<ProviderCollection<ImportedCalendarEvent>>> {
  const operation: ProviderOperation = "microsoft.calendar-view";
  const range = validRange(input.startDateTime, input.endDateTime);
  if (!isNonEmptyText(input.calendarId) || range === null) {
    return failure("invalid-request", "microsoft", operation);
  }
  const encodedCalendarId = encodeURIComponent(input.calendarId);
  const expectedPath = `/v1.0/me/calendars/${encodedCalendarId}/calendarView`;
  const initialUrl = graphUrl(`/me/calendars/${encodedCalendarId}/calendarView`, {
    // Graph calendarView cannot return lastModifiedDateTime with $select. Keeping
    // a narrow projection is more important than accepting event bodies just to
    // obtain that optional timestamp.
    "$select": "id,subject,start,end,isAllDay,isCancelled",
    "$top": "100",
    endDateTime: range.end,
    startDateTime: range.start,
  });
  const result = await collectPages({
    client,
    provider: "microsoft",
    operation,
    initialUrl,
    nextUrl: cursor => graphNextUrl(expectedPath, cursor),
    headers: graphHeaders(client.accessToken, `outlook.timezone="${MICROSOFT_DUBLIN_TIME_ZONE}", IdType="ImmutableId"`),
    parse: payload => parseGraphPage(
      payload,
      value => parseMicrosoftCalendarEvent(input.calendarId, value),
      () => undefined,
    ),
  });
  if (result.status !== "ok") return result;
  return success("microsoft", operation, result.pageCount, { records: result.value.records });
}

/** Lists Microsoft To Do task lists. */
export async function listMicrosoftTodoLists(
  client: ProviderReadClient,
): Promise<ProviderReadResult<ProviderCollection<ImportedTaskList>>> {
  const operation: ProviderOperation = "microsoft.todo-lists";
  const expectedPath = "/v1.0/me/todo/lists";
  const initialUrl = graphUrl("/me/todo/lists", {
    "$select": "id,displayName",
    "$top": "100",
  });
  const result = await collectPages({
    client,
    provider: "microsoft",
    operation,
    initialUrl,
    nextUrl: cursor => graphNextUrl(expectedPath, cursor),
    headers: graphHeaders(client.accessToken),
    parse: payload => parseGraphPage(payload, parseMicrosoftTaskList, () => undefined),
  });
  if (result.status !== "ok") return result;
  return success("microsoft", operation, result.pageCount, { records: result.value.records });
}

/** Lists Microsoft To Do tasks without requesting their note/body field. */
export async function listMicrosoftTodoTasks(
  client: ProviderReadClient,
  input: MicrosoftTodoTasksInput,
): Promise<ProviderReadResult<ProviderCollection<ImportedTask>>> {
  const operation: ProviderOperation = "microsoft.todo-tasks";
  if (!isNonEmptyText(input.taskListId)) return failure("invalid-request", "microsoft", operation);
  const encodedTaskListId = encodeURIComponent(input.taskListId);
  const expectedPath = `/v1.0/me/todo/lists/${encodedTaskListId}/tasks`;
  const initialUrl = graphUrl(`/me/todo/lists/${encodedTaskListId}/tasks`, {
    // completedDateTime is a dateTimeTimeZone value. It can carry a Windows
    // time-zone name, which cannot be safely converted to UTC without an extra
    // mapping dependency; task state already tells us whether it is complete.
    "$select": "id,title,status,dueDateTime,lastModifiedDateTime",
    "$top": "100",
  });
  const result = await collectPages({
    client,
    provider: "microsoft",
    operation,
    initialUrl,
    nextUrl: cursor => graphNextUrl(expectedPath, cursor),
    headers: graphHeaders(client.accessToken),
    parse: payload => parseGraphPage(
      payload,
      value => parseMicrosoftTask(input.taskListId, value),
      () => undefined,
    ),
  });
  if (result.status !== "ok") return result;
  return success("microsoft", operation, result.pageCount, { records: result.value.records });
}
