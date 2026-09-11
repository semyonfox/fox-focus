import { DatabaseSync } from "node:sqlite";
import type { HermesFeed, HermesOwner, HermesStatus, HermesTask } from "../src/hermes-model.ts";

const statuses = new Set<HermesStatus>([
  "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done",
]);
const uuidOnly = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hermesIdOnly = /^t_[0-9a-f]{8}$/i;

type HermesRow = {
  id: unknown;
  title: unknown;
  status: unknown;
  priority: unknown;
  assignee: unknown;
  updated_at: unknown;
};

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

function toTask(row: HermesRow): HermesTask | null {
  if (
    typeof row.id !== "string" ||
    typeof row.title !== "string" ||
    typeof row.status !== "string" ||
    !statuses.has(row.status as HermesStatus) ||
    typeof row.priority !== "number" ||
    typeof row.updated_at !== "number"
  ) return null;

  return {
    id: row.id,
    title: readableTitle(row.title, row.id),
    status: row.status as HermesStatus,
    priority: row.priority,
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    owner: ownerFor(row.assignee),
  };
}

export function readHermesFeed(source: HermesSource): HermesFeed {
  const checkedAt = (source.now ?? (() => new Date()))().toISOString();
  const limit = Math.max(1, Math.min(source.limit ?? 200, 200));
  let db: DatabaseSync | undefined;

  try {
    // Keep the database directory mounted read-only so SQLite can see its WAL
    // sidecars. `immutable=1` is deliberately avoided because Hermes is live.
    db = new DatabaseSync(source.dbPath, { readOnly: true, timeout: 2_000 });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000;");

    const totalRow = db.prepare(
      "SELECT COUNT(*) AS total FROM tasks WHERE status != 'archived'",
    ).get();
    const total = typeof totalRow?.total === "number" ? totalRow.total : 0;
    const rows = db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, t.assignee,
             COALESCE(
               (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = t.id),
               t.completed_at,
               t.started_at,
               t.created_at
             ) AS updated_at
        FROM tasks t
       WHERE t.status != 'archived'
       ORDER BY CASE t.status
                  WHEN 'running' THEN 0 WHEN 'blocked' THEN 1
                  WHEN 'review' THEN 2 WHEN 'ready' THEN 3
                  WHEN 'todo' THEN 4 WHEN 'triage' THEN 5
                  WHEN 'scheduled' THEN 6 ELSE 7
                END,
                t.priority DESC, updated_at DESC
       LIMIT ?
    `).all(limit) as HermesRow[];

    return {
      state: "connected",
      checkedAt,
      board: {
        slug: source.boardSlug ?? "personal-tasks",
        name: source.boardName ?? "Personal Tasks",
        total,
        tasks: rows.flatMap((row) => {
          const task = toTask(row);
          return task ? [task] : [];
        }),
      },
    };
  } catch {
    return { state: "unavailable", checkedAt, board: null };
  } finally {
    db?.close();
  }
}
