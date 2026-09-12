import { DatabaseSync } from "node:sqlite";
import type {
  HermesCompletionInput,
  HermesCompletionResult,
  HermesFeed,
  HermesMirrorSnapshot,
  HermesOwner,
  HermesRemoteTask,
  HermesStatus,
  HermesTask,
  HermesTaskAnnotationInput,
} from "../src/hermes-model.ts";
import type { Store } from "./store.ts";

const statuses = new Set<HermesStatus>([
  "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done",
]);
const uuidOnly = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hermesIdOnly = /^t_[0-9a-f]{8}$/i;
const googleIdentity = /^google-task:(.+)$/;

type HermesRow = {
  id: unknown;
  title: unknown;
  status: unknown;
  priority: unknown;
  assignee: unknown;
  created_at: unknown;
  updated_at: unknown;
  version: unknown;
  idempotency_key: unknown;
  source_metadata: unknown;
  parent_title: unknown;
};

const listHeading = /^Google Tasks list\s*[—–-]\s*(.+?)\s*\.?$/;

function normalizeSource(value: string | undefined): string | null {
  const source = value?.replace(/\s+/g, " ").trim().replace(/\.$/, "") ?? "";
  return source || null;
}

function sourceFromHeading(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return normalizeSource(value.match(listHeading)?.[1]);
}

function sourceFromMetadata(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const metadata = value.replaceAll("\\n", "\n");
  const googleList = metadata.match(/(?:^|\n)\s*Source:\s*Google\s+Tasks\s*\(([^)\r\n]+)\)\.?\s*(?:\n|$)/i);
  if (googleList) return normalizeSource(googleList[1]);
  if (/(?:^|\n)\s*Source:\s*email triage\b/i.test(metadata)) return "Email";
  if (/(?:^|\n)\s*Source:\s*direct(?:\s+request)?\b/i.test(metadata)) return "Direct request";
  return null;
}

function sourceFor(row: HermesRow): string {
  return sourceFromMetadata(row.source_metadata) ?? sourceFromHeading(row.parent_title) ?? "Unsorted";
}

export type HermesSource = {
  dbPath: string;
  boardSlug?: string;
  boardName?: string;
  limit?: number;
  now?: () => Date;
};

function readableTitle(value: string, id: string): string {
  const title = value.replace(/\s+/g, " ").trim();
  return !title || title === id || uuidOnly.test(title) || hermesIdOnly.test(title)
    ? "Untitled task"
    : title;
}

function ownerFor(assignee: unknown): HermesOwner {
  if (typeof assignee !== "string" || !assignee.trim()) return "unassigned";
  return assignee.trim().endsWith("-human") ? "human" : "agent";
}

function provenanceFor(value: unknown): Pick<HermesRemoteTask, "sourceProvider" | "sourceExternalId"> {
  if (typeof value !== "string") return { sourceProvider: null, sourceExternalId: null };
  const match = value.match(googleIdentity);
  const externalId = match?.[1]?.trim();
  return externalId && externalId.length <= 500
    ? { sourceProvider: "google", sourceExternalId: externalId }
    : { sourceProvider: null, sourceExternalId: null };
}

function toTask(row: HermesRow): HermesRemoteTask | null {
  if (
    typeof row.id !== "string" || typeof row.title !== "string" ||
    typeof row.status !== "string" || !statuses.has(row.status as HermesStatus) ||
    typeof row.priority !== "number" || typeof row.created_at !== "number" || typeof row.updated_at !== "number" ||
    typeof row.version !== "number" || !Number.isSafeInteger(row.version)
  ) return null;
  return {
    id: row.id,
    title: readableTitle(row.title, row.id),
    status: row.status as HermesStatus,
    priority: row.priority,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    version: row.version,
    owner: ownerFor(row.assignee),
    source: sourceFor(row),
    parentTitle: typeof row.parent_title === "string" && !listHeading.test(row.parent_title) ? row.parent_title : null,
    ...provenanceFor(row.idempotency_key),
    sourceDueOn: null,
    sourceStatus: null,
    sourceContainerId: null,
    sourceContainerName: null,
    sourceMatchUnique: false,
  };
}

export function readHermesSnapshot(source: HermesSource): HermesMirrorSnapshot | null {
  const checkedAt = (source.now ?? (() => new Date()))().toISOString();
  const limit = Math.max(1, Math.min(source.limit ?? 2000, 2000));
  let db: DatabaseSync | undefined;
  let transactionOpen = false;
  try {
    db = new DatabaseSync(source.dbPath, { readOnly: true, timeout: 2_000 });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000;");
    db.exec("BEGIN");
    transactionOpen = true;
    const taskColumns = new Set((db.prepare("PRAGMA table_info(tasks)").all() as Record<string, unknown>[])
      .flatMap(column => typeof column.name === "string" ? [column.name] : []));
    const idempotencySelect = taskColumns.has("idempotency_key")
      ? "t.idempotency_key"
      : "NULL AS idempotency_key";
    const totalRow = db.prepare("SELECT COUNT(*) AS total FROM tasks WHERE status != 'archived'").get();
    const total = typeof totalRow?.total === "number" ? totalRow.total : 0;
    const rows = db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, t.assignee, t.created_at,
             ${idempotencySelect}, substr(t.body, 1, 512) AS source_metadata,
             (SELECT p.title FROM task_links l JOIN tasks p ON p.id=l.parent_id
               WHERE l.child_id=t.id ORDER BY p.id LIMIT 1) AS parent_title,
             COALESCE(
               (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id=t.id),
               t.completed_at, t.started_at, t.created_at
             ) AS updated_at,
             COALESCE((SELECT MAX(e.id) FROM task_events e WHERE e.task_id=t.id), 0) AS version
        FROM tasks t
       WHERE t.status != 'archived'
       ORDER BY CASE t.status
                  WHEN 'running' THEN 0 WHEN 'blocked' THEN 1 WHEN 'review' THEN 2
                  WHEN 'ready' THEN 3 WHEN 'todo' THEN 4 WHEN 'triage' THEN 5
                  WHEN 'scheduled' THEN 6 ELSE 7
                END,
                t.priority DESC, updated_at DESC
       LIMIT ?
    `).all(limit) as HermesRow[];
    db.exec("COMMIT");
    transactionOpen = false;
    const sources = new Set<string>();
    const tasks = rows.flatMap(row => {
      const heading = sourceFromHeading(row.title);
      if (heading) { sources.add(heading); return []; }
      const task = toTask(row);
      if (!task) return [];
      sources.add(task.source);
      return [task];
    });
    return {
      state: "connected",
      checkedAt,
      complete: rows.length < limit || total <= rows.length,
      board: {
        slug: source.boardSlug ?? "personal-tasks",
        name: source.boardName ?? "Personal Tasks",
        total: tasks.length,
        tasks,
        sources: [...sources].sort((first, second) => first.localeCompare(second)),
      },
    };
  } catch {
    if (transactionOpen) {
      try { db?.exec("ROLLBACK"); } catch { /* the source connection is discarded below */ }
    }
    return null;
  } finally {
    db?.close();
  }
}

/** Kept as a small adapter for callers that only need a one-off read. */
export function readHermesFeed(source: HermesSource): HermesFeed {
  const snapshot = readHermesSnapshot(source);
  if (!snapshot) {
    return {
      state: "unavailable",
      checkedAt: (source.now ?? (() => new Date()))().toISOString(),
      board: null,
    };
  }
  return {
    state: "connected",
    checkedAt: snapshot.checkedAt,
    board: {
      ...snapshot.board,
      tasks: snapshot.board.tasks.map(task => ({
        ...task,
        area: "Personal",
        localState: task.status === "blocked" ? "waiting" : "up-next",
        duration: "30 min",
        due: "No deadline",
        scheduledAt: null,
        reminderMode: "none",
        reminderFireAt: null,
        annotationUpdatedAt: null,
      })),
    },
  };
}

export type HermesCompletionRequest = {
  taskId: string;
  expectedVersion: number;
  idempotencyKey: string;
  approvalId: string;
  change: { status: "done" };
};

export type HermesRemoteCompletionResponse = {
  taskId: string;
  board: string;
  before: { id: string; title: string; status: HermesStatus; completedAt: number | null; version: number };
  after: { id: string; title: string; status: "done"; completedAt: number; version: number };
  version: number;
  replayed: boolean;
  approvalId: string;
  idempotencyKey: string;
};

export interface HermesActionClient {
  complete(request: HermesCompletionRequest): Promise<HermesRemoteCompletionResponse>;
}

export class HermesServiceError extends Error {
  readonly status: 404 | 409 | 502 | 503;
  readonly outcomeUnknown: boolean;

  constructor(status: 404 | 409 | 502 | 503, message: string, outcomeUnknown = false) {
    super(message);
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completionResponse(value: unknown, request: HermesCompletionRequest): HermesRemoteCompletionResponse | null {
  if (!isRecord(value) || !isRecord(value.before) || !isRecord(value.after)) return null;
  if (value.taskId !== request.taskId || value.board !== "personal-tasks" ||
    value.approvalId !== request.approvalId || value.idempotencyKey !== request.idempotencyKey ||
    typeof value.version !== "number" || !Number.isSafeInteger(value.version) ||
    typeof value.replayed !== "boolean" || value.before.id !== request.taskId ||
    typeof value.before.title !== "string" || typeof value.before.status !== "string" ||
    !statuses.has(value.before.status as HermesStatus) ||
    (value.before.completedAt !== null && !Number.isSafeInteger(value.before.completedAt)) ||
    !Number.isSafeInteger(value.before.version) || value.before.version !== request.expectedVersion ||
    value.after.id !== request.taskId ||
    typeof value.after.title !== "string" || value.after.title !== value.before.title || value.after.status !== "done" ||
    !Number.isSafeInteger(value.after.completedAt) || !Number.isSafeInteger(value.after.version) ||
    value.after.version !== value.version || value.after.version <= value.before.version) return null;
  return value as HermesRemoteCompletionResponse;
}

function readHermesActionReceipt(
  source: HermesSource,
  request: HermesCompletionRequest,
): HermesRemoteCompletionResponse | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source.dbPath, { readOnly: true, timeout: 2_000 });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000;");
    const row = db.prepare(`SELECT board, task_id, approval_id, idempotency_key,
        before_json, after_json, result_version
      FROM kanban_external_actions WHERE idempotency_key=?`).get(request.idempotencyKey) as Record<string, unknown> | undefined;
    if (!row || typeof row.before_json !== "string" || typeof row.after_json !== "string" ||
      row.before_json.length > 4_096 || row.after_json.length > 4_096) return null;
    return completionResponse({
      taskId: row.task_id,
      board: row.board,
      approvalId: row.approval_id,
      idempotencyKey: row.idempotency_key,
      before: JSON.parse(row.before_json),
      after: JSON.parse(row.after_json),
      version: row.result_version,
      replayed: true,
    }, request);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function createHermesActionClient(endpoint: string, token: string): HermesActionClient {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || !token.trim()) throw new Error("Invalid Hermes action configuration");
  return {
    async complete(request) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new HermesServiceError(503, "Hermes could not be reached. Fox Focus could not confirm the outcome.", true);
      }
      if (response.status === 409) throw new HermesServiceError(409, "Hermes changed this task. Review the latest status and try again.");
      if (response.status === 404) throw new HermesServiceError(404, "Hermes no longer has this task.");
      if (!response.ok) {
        if (response.status >= 500) {
          throw new HermesServiceError(503, "Hermes failed while handling the completion. Fox Focus could not confirm the outcome.", true);
        }
        throw new HermesServiceError(503, "Hermes rejected the completion. Check the scoped action token and request configuration.");
      }
      let body: unknown;
      try { body = await response.json(); } catch { throw new HermesServiceError(502, "Hermes returned an invalid completion response.", true); }
      const parsed = completionResponse(body, request);
      if (!parsed) throw new HermesServiceError(502, "Hermes returned an invalid completion response.", true);
      return parsed;
    },
  };
}

export interface HermesMirrorService {
  feed(): HermesFeed;
  poll(): Promise<HermesFeed>;
  updateAnnotation(taskId: string, annotation: HermesTaskAnnotationInput): HermesTask | null;
  completeTask(taskId: string, input: HermesCompletionInput): Promise<HermesCompletionResult>;
}

export function createHermesMirrorService(
  store: Store,
  source: HermesSource,
  actionClient?: HermesActionClient,
): HermesMirrorService {
  let pollInFlight: Promise<HermesFeed> | null = null;
  const withCapabilities = (feed: HermesFeed): HermesFeed => ({
    ...feed,
    completionAvailable: Boolean(actionClient),
  });
  function reconcileCompletedActions(): void {
    for (const action of store.listHermesActions()) {
      if (action.state !== "pending" && action.state !== "readback_failed") continue;
      const request: HermesCompletionRequest = {
        taskId: action.taskId,
        expectedVersion: action.expectedVersion,
        idempotencyKey: action.idempotencyKey,
        approvalId: action.id,
        change: { status: "done" },
      };
      const receipt = readHermesActionReceipt(source, request);
      if (receipt) {
        // The immutable receipt proves this exact approval committed. Later
        // task edits affect the current checkbox, not the action's history.
        store.finishHermesAction(action.id, "succeeded", receipt);
      }
    }
  }
  async function runPoll(): Promise<HermesFeed> {
    const snapshot = readHermesSnapshot(source);
    if (snapshot) {
      store.replaceHermesTasks(snapshot);
      // A local HTTP timeout cannot cancel Hermes's synchronous SQLite write.
      // Reconcile its durable receipt on later polls instead of recording a
      // false failure while the remote request may still be waiting on a lock.
      reconcileCompletedActions();
    } else store.markHermesUnavailable((source.now ?? (() => new Date()))().toISOString());
    return withCapabilities(store.readHermesFeed());
  }
  function poll(): Promise<HermesFeed> {
    if (pollInFlight) return pollInFlight;
    pollInFlight = runPoll().finally(() => { pollInFlight = null; });
    return pollInFlight;
  }
  return {
    feed: () => withCapabilities(store.readHermesFeed()),
    poll,
    updateAnnotation: store.updateHermesTaskAnnotation,
    async completeTask(taskId, input) {
      if (store.readHermesFeed().state !== "connected") {
        throw new HermesServiceError(503, "Hermes is not current. Refresh the board before completing a task.");
      }
      const start = store.beginHermesCompletion(
        taskId,
        input.expectedVersion,
        input.confirmation.beforeStatus,
        input.confirmation.confirmedAt,
      );
      if (start.outcome === "not_found") throw new HermesServiceError(404, "Hermes no longer has this task.");
      if (start.outcome === "conflict") throw new HermesServiceError(409, "Hermes changed this task. Review the latest status and try again.");
      if (start.outcome === "already_done") {
        return {
          task: start.task,
          approval: { id: "already-complete", summary: `"${start.task.title}" is already complete in Hermes.`, approvedAt: input.confirmation.confirmedAt },
        };
      }
      const { task, action } = start.value;
      if (!actionClient) {
        store.finishHermesAction(action.id, "failed", null, "action_api_unavailable");
        throw new HermesServiceError(503, "Hermes completion is not configured. The task was not changed.");
      }
      const request: HermesCompletionRequest = {
        taskId,
        expectedVersion: task.version,
        idempotencyKey: action.idempotencyKey,
        approvalId: action.id,
        change: { status: "done" },
      };
      let remote: HermesRemoteCompletionResponse | undefined;
      let ambiguousError: HermesServiceError | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          remote = await actionClient.complete(request);
          break;
        } catch (error) {
          const retryable = error instanceof HermesServiceError &&
            error.outcomeUnknown;
          // A timeout or lost response is ambiguous: Hermes may have committed
          // before transport failed. Replaying this idempotency key is how we
          // obtain a conclusive result without applying the transition twice.
          if (retryable) {
            ambiguousError = error;
            if (attempt === 0) continue;
            break;
          }
          const errorCode = error instanceof HermesServiceError && error.status === 409
            ? "remote_conflict"
            : error instanceof HermesServiceError && error.status === 404
              ? "remote_missing"
              : "remote_error";
          store.finishHermesAction(action.id, "failed", null, errorCode);
          await poll();
          throw error;
        }
      }
      if (!remote) remote = readHermesActionReceipt(source, request) ?? undefined;
      if (!remote) {
        const readback = await poll();
        const current = readback.state === "connected"
          ? readback.board.tasks.find(candidate => candidate.id === taskId)
          : undefined;
        const lateReceipt = readHermesActionReceipt(source, request);
        if (lateReceipt) {
          store.finishHermesAction(action.id, "succeeded", lateReceipt);
          if (current?.status === "done" && current.version === lateReceipt.version) {
            return {
              task: current,
              approval: { id: action.id, summary: action.approvalSummary, approvedAt: action.approvedAt },
            };
          }
          throw new HermesServiceError(409, "Hermes applied this completion, but the task changed again. Fox Focus is showing the latest state.");
        }
        // Even an unchanged readback is not proof of rejection: the aborted
        // request may still be queued behind Hermes's SQLite writer. Keep the
        // approval unresolved and let the 60-second poll reconcile its exact
        // receipt if that request commits later.
        store.finishHermesAction(action.id, "readback_failed", null, "remote_outcome_pending");
        throw new HermesServiceError(ambiguousError?.status ?? 502,
          current?.status === "done"
            ? "Hermes completed the task, but Fox Focus could not verify this approval yet. It will keep checking."
            : "Fox Focus could not confirm the Hermes action yet. It will keep checking before changing the checkbox.");
      }
      const readback = await poll();
      const next = readback.state === "connected"
        ? readback.board.tasks.find(candidate => candidate.id === taskId)
        : undefined;
      // A validated response or receipt proves that the exact approved action
      // committed even when a later edit means it is no longer the current
      // task version.
      store.finishHermesAction(action.id, "succeeded", remote);
      if (!next || next.status !== "done" || next.version !== remote.version) {
        throw new HermesServiceError(409, "Hermes applied this completion, but the task changed again. Fox Focus is showing the latest state.");
      }
      return { task: next, approval: { id: action.id, summary: action.approvalSummary, approvedAt: action.approvedAt } };
    },
  };
}
