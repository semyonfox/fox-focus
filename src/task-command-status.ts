import type { ActionRow, TaskRow } from "./row-model.ts";

export function taskCommandStatus(task: TaskRow, action: ActionRow | null): string {
  if (task.binding.kind === "legacy") return task.observed?.status === "completed" ? "Completed at source" : "Open at source";
  if (action?.state === "unknown") return "Outcome unknown · reconciliation required";
  if (action?.state === "conflict") return "Google changed · review required";
  if (action?.state === "failed") return "Google change failed";
  if (action?.state === "queued" || action?.state === "running") {
    return action.payload.kind === "task-status"
      ? action.payload.after === "completed" ? "Completion pending in Google" : "Reopen pending in Google"
      : "Creation pending in Google";
  }
  if (task.binding.kind === "pending") return "Awaiting Google creation confirmation";
  return task.observed?.status === "completed" ? "Completed in Google" : "Open in Google";
}
