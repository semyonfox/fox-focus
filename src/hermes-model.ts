export const hermesStatuses = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
] as const;

export type HermesStatus = (typeof hermesStatuses)[number];
export type HermesOwner = "human" | "agent" | "unassigned";

export type HermesTask = {
  id: string;
  title: string;
  status: HermesStatus;
  priority: number;
  updatedAt: string;
  owner: HermesOwner;
  list: string;
  parentTitle: string | null;
};

export type HermesBoard = {
  slug: string;
  name: string;
  total: number;
  tasks: HermesTask[];
  lists: string[];
};

export type HermesFeed =
  | { state: "connected"; checkedAt: string; board: HermesBoard }
  | { state: "unavailable"; checkedAt: string; board: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isHermesStatus(value: unknown): value is HermesStatus {
  return typeof value === "string" && hermesStatuses.includes(value as HermesStatus);
}

function isHermesOwner(value: unknown): value is HermesOwner {
  return value === "human" || value === "agent" || value === "unassigned";
}

function isHermesTask(value: unknown): value is HermesTask {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isHermesStatus(value.status) &&
    typeof value.priority === "number" &&
    Number.isInteger(value.priority) &&
    isIsoInstant(value.updatedAt) &&
    isHermesOwner(value.owner) &&
    typeof value.list === "string" &&
    (value.parentTitle === null || typeof value.parentTitle === "string")
  );
}

export function isHermesFeed(value: unknown): value is HermesFeed {
  if (!isRecord(value) || !isIsoInstant(value.checkedAt)) return false;
  if (value.state === "unavailable") return value.board === null;
  if (value.state !== "connected" || !isRecord(value.board)) return false;
  return (
    typeof value.board.slug === "string" &&
    typeof value.board.name === "string" &&
    typeof value.board.total === "number" &&
    Number.isInteger(value.board.total) &&
    Array.isArray(value.board.lists) && value.board.lists.every(list => typeof list === "string") &&
    Array.isArray(value.board.tasks) &&
    value.board.tasks.every(isHermesTask)
  );
}
