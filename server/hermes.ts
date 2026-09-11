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
    source: sourceFor(row),
    parentTitle: typeof row.parent_title === 'string' && !listHeading.test(row.parent_title) ? row.parent_title : null,
  };
}

export function readHermesFeed(source: HermesSource): HermesFeed {
  const checkedAt = (source.now ?? (() => new Date()))().toISOString();
  const limit = Math.max(1, Math.min(source.limit ?? 2000, 2000));
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
             substr(t.body, 1, 512) AS source_metadata,
             (SELECT p.title FROM task_links l JOIN tasks p ON p.id=l.parent_id
               WHERE l.child_id=t.id ORDER BY p.id LIMIT 1) AS parent_title,
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

    // Hermes has not yet published source fields. Until it does, inspect only a
    // small source-metadata prefix and never return it from this adapter.
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
      board: {
        slug: source.boardSlug ?? "personal-tasks",
        name: source.boardName ?? "Personal Tasks",
        total,
        tasks,
        sources: [...sources].sort((a, b) => a.localeCompare(b)),
      },
    };
  } catch {
    return { state: "unavailable", checkedAt, board: null };
  } finally {
    db?.close();
  }
}
