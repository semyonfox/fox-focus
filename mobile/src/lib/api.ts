import { apiFetch, setApiFetch } from "@shared/api-transport";
import { loadTaskDestinations, parseWorkRows, preferredTaskDestination, type TaskDestination, type WorkRowsSnapshot } from "@shared/inbox-client";
import { isOverview, type ImportedRecord } from "@shared/integration-model";
import { isPrototypeData, isRecord, type PrototypeData } from "@shared/model";
import { parseTaskRows, type RowResponse } from "@shared/row-client";
import type { TaskCreateInput, TaskPlanRow, TaskRow } from "@shared/row-model";
import type { Connection } from "./settings";

const timeoutMs = 15_000;

function basicAuth({ username, password }: Connection): string {
  // utf-8 safe base64 of user:password
  let binary = "";
  for (const byte of new TextEncoder().encode(`${username}:${password}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

// points the shared web clients at the server with the owner login
export function configureServer(connection: Connection | null): void {
  setApiFetch(async (path, init = {}) => {
    if (!connection) throw new Error("Connect to Fox Focus in Settings");
    // react native's fetch turns cache: no-store into a query param, and the server never caches anyway
    const { cache: _cache, signal, headers, ...rest } = init;
    const merged = new Headers(headers);
    merged.set("Authorization", basicAuth(connection));
    merged.set("Accept", "application/json");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    signal?.addEventListener("abort", () => controller.abort());
    let response: Response;
    try {
      response = await fetch(`${connection.baseUrl}${path}`, { ...rest, headers: merged, signal: controller.signal });
    } catch {
      throw new Error(controller.signal.aborted && !signal?.aborted ? "Fox Focus took too long to answer" : "Could not reach Fox Focus");
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) throw new Error("Wrong username or password");
    return response;
  });
}

export type Rows = WorkRowsSnapshot & {
  tasks: TaskRow[];
  taskPlans: TaskPlanRow[];
  destinations: TaskDestination[];
  listNames: Record<string, string>;
  failedScopes: string[];
};

export const emptyRows: Rows = {
  inbox: [], drafts: [], jobs: [], jobUpdates: [], actions: [], reminders: [], briefings: [],
  capabilities: { emailSendEnabled: false, assistants: [] },
  tasks: [], taskPlans: [], destinations: [], listNames: {}, failedScopes: [],
};

export function errorText(value: unknown): string | null {
  return typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string"
    ? (value as { error: string }).error
    : null;
}

// list names and failed scopes come from the freshness rows
function scopes(value: unknown): Pick<Rows, "listNames" | "failedScopes"> {
  const listNames: Record<string, string> = {};
  const failedScopes: string[] = [];
  const freshness = typeof value === "object" && value !== null ? (value as { freshness?: unknown }).freshness : null;
  if (Array.isArray(freshness)) {
    for (const scope of freshness) {
      if (typeof scope !== "object" || scope === null) continue;
      const { resourceKind, containerId, containerName, state } = scope as Record<string, unknown>;
      if (typeof containerName !== "string") continue;
      if (resourceKind === "task-list" && typeof containerId === "string") listNames[containerId] = containerName;
      if (state === "failed") failedScopes.push(containerName);
    }
  }
  return { listNames, failedScopes };
}

// one read of /api/v1/rows, validated by the same parsers the web app uses
export async function fetchRows(): Promise<Rows> {
  const response = await apiFetch("/api/v1/rows");
  let value: unknown = null;
  try { value = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(errorText(value) ?? `Fox Focus answered ${response.status}`);
  if (value === null) throw new Error("This server doesn't have the row API");
  const work = parseWorkRows(value);
  const task = parseTaskRows(value);
  const destinations = await loadTaskDestinations().then(result => result.destinations, () => [] as TaskDestination[]);
  return { ...work, tasks: task.tasks, taskPlans: task.taskPlans, destinations, ...scopes(value) };
}

export type CalendarSource = {
  events: PrototypeData["events"];
  legacyTasks: PrototypeData["tasks"];
  listAreas: PrototypeData["listAreas"];
  records: ImportedRecord[];
  // either source failed; what did load is still shown
  failed: boolean;
};

export const emptyCalendar: CalendarSource = { events: [], legacyTasks: [], listAreas: undefined, records: [], failed: false };

async function readJson(path: string): Promise<unknown> {
  const response = await apiFetch(path);
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(errorText(value) ?? `Fox Focus answered ${response.status}`);
  return value;
}

// local blocks from the workspace and read-only imported calendars, the same sources the web calendar uses
export async function fetchCalendar(): Promise<CalendarSource> {
  const [workspace, integrations] = await Promise.allSettled([readJson("/api/v1/workspace"), readJson("/api/v1/integrations")]);
  const data = workspace.status === "fulfilled" && isRecord(workspace.value) && isPrototypeData(workspace.value.data) ? workspace.value.data : null;
  const overview = integrations.status === "fulfilled" && isOverview(integrations.value) ? integrations.value : null;
  // the web hides providers this server has not configured
  const configured = new Set(overview?.providers.filter(provider => provider.configured).map(provider => provider.provider) ?? []);
  return {
    events: data?.events ?? [],
    legacyTasks: data?.tasks ?? [],
    listAreas: data?.listAreas,
    records: overview?.records.filter(record => record.kind === "calendar_event" && configured.has(record.provider)) ?? [],
    failed: !data || !overview,
  };
}

export function expectOk(result: RowResponse, fallback: string): void {
  if (!result.ok) throw new Error(errorText(result.value) ?? fallback);
}

export function defaultDestination(rows: Rows): TaskDestination | null {
  return preferredTaskDestination(rows.destinations, "Personal") ??
    rows.destinations.find(destination => destination.isFallback) ?? rows.destinations[0] ?? null;
}

export const defaultPlan: TaskCreateInput["plan"] = {
  priority: "medium", waiting: false, deadlineOn: null, plannedOn: null, plannedAt: null, estimateMinutes: null,
};

// idempotency keys and task nonces; the server only needs uniqueness, [a-z0-9] fits the nonce rule
export function randomKey(): string {
  let key = "";
  while (key.length < 24) key += Math.random().toString(36).slice(2);
  return key.slice(0, 24);
}

export const oneLine = (text: string, maximum: number) => text.replace(/\s+/g, " ").trim().slice(0, maximum);
