import { useCallback, useEffect, useState } from "react";
import {
  isHermesFeed,
  isHermesTask,
  type HermesCompletionInput,
  type HermesFeed,
  type HermesStatus,
  type HermesTask,
  type HermesTaskAnnotationInput,
} from "./hermes-model.ts";

export const hermesLabels: Record<HermesStatus, string> = {
  triage: "Needs sorting", todo: "To do", scheduled: "Scheduled", ready: "Ready",
  running: "In progress", blocked: "Blocked", review: "Needs review", done: "Completed",
};

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      return new Error(body.error);
    }
  } catch {
    // The status-specific fallback is safer than displaying an upstream body.
  }
  return new Error(fallback);
}

export function useHermesFeed(enabled: boolean) {
  const [feed, setFeed] = useState<HermesFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(key => key + 1), []);
  const replaceTask = useCallback((task: HermesTask) => {
    setFeed(current => current && current.state !== "unavailable"
      ? { ...current, board: { ...current.board, tasks: current.board.tasks.map(candidate => candidate.id === task.id ? task : candidate) } }
      : current);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch("/api/v1/hermes", { signal: controller.signal });
        if (!response.ok) throw new Error("Feed unavailable");
        const next: unknown = await response.json();
        if (!isHermesFeed(next)) throw new Error("Feed unavailable");
        if (!disposed) { setFeed(next); setFailed(false); }
      } catch { if (!disposed) setFailed(true); }
      finally { if (!disposed) setLoading(false); }
    }
    void load();
    const interval = window.setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
    return () => { disposed = true; controller.abort(); window.clearInterval(interval); };
  }, [enabled, refreshKey, refresh]);

  const poll = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const response = await fetch("/api/v1/hermes/sync", { method: "POST" });
      if (!response.ok) throw await responseError(response, "Hermes could not be refreshed.");
      const next: unknown = await response.json();
      if (!isHermesFeed(next)) throw new Error("Hermes returned an invalid feed.");
      setFeed(next);
      setFailed(false);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  const updateAnnotation = useCallback(async (taskId: string, annotation: HermesTaskAnnotationInput) => {
    const response = await fetch(`/api/v1/hermes/tasks/${encodeURIComponent(taskId)}/annotation`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(annotation),
    });
    if (!response.ok) throw await responseError(response, "Could not save this task's Fox Focus details.");
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("task" in body) || !isHermesTask(body.task)) {
      throw new Error("Fox Focus returned an invalid task.");
    }
    replaceTask(body.task);
    return body.task;
  }, [replaceTask]);

  const completeTask = useCallback(async (taskId: string, input: HermesCompletionInput) => {
    const response = await fetch(`/api/v1/hermes/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await responseError(response, "Hermes could not complete this task.");
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("task" in body) || !isHermesTask(body.task)) {
      throw new Error("Fox Focus could not verify the completed task.");
    }
    replaceTask(body.task);
    return body.task;
  }, [replaceTask]);

  return { feed, failed, loading, refresh, poll, updateAnnotation, completeTask };
}
