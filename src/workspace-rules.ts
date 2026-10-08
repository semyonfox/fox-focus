import type { Area, InboxItem, Task } from './model.ts';
import { areaForList } from './integration-model.ts';

// course codes also survive Canvas assignments mirrored through Google Tasks
export function isUniversityWork(...evidence: Array<string | null | undefined>): boolean {
  return evidence.some(value => /\b(canvas|university|college)\b|\bCT\s?\d{3,4}\b/i.test(value ?? ''));
}

export function importedTaskArea(
  listAreas: Record<string, Area> | undefined,
  task: { provider: string; containerId: string; containerName: string; title: string; notes?: string | null; sourceUrl?: string | null },
): Area {
  if (isUniversityWork(task.containerName, task.title, task.notes, task.sourceUrl)) return 'University';
  return areaForList(listAreas, task.provider, task.containerId, task.containerName);
}

export function localTaskArea(task: Task): Area {
  if (task.areaOverride || task.area !== 'Personal') return task.area;
  const imported = task.origin === 'migration' || task.origin === 'inbox' || Boolean(task.externalLinks?.length);
  return imported && isUniversityWork(task.source, task.title, ...task.externalLinks?.map(link => link.containerName) ?? [])
    ? 'University' : task.area;
}

export type InboxLane = 'review' | 'automation';

export function inboxLane(item: InboxItem): InboxLane {
  if (item.lane) return item.lane;
  if (!/\bhermes\b/i.test(`${item.actor} ${item.source}`)) return 'review';
  // explicit requests for a decision take priority over recurring-job wording
  if (/\b(approval required|needs? (?:your |manual )?(?:review|approval)|action required)\b/i.test(`${item.title} ${item.summary}`)) return 'review';
  return /\b(cron|recurring|hourly|nightly|daily|weekly|scheduled job|incremental email triage|watch .+ schedule)\b/i.test(`${item.title} ${item.source}`)
    ? 'automation' : 'review';
}

export function suggestReview(item: InboxItem, hasVerifiedTask = false) {
  if (hasVerifiedTask) return { outcome: 'existing-task-update' as const, reason: 'The supplied task ID matches an existing Personal Tasks record.', nextStep: 'Review the existing task before proposing any change.' };
  if (item.recommendation) return item.recommendation;
  if (inboxLane(item) === 'automation') return { outcome: 'awareness' as const, reason: 'This looks like a recurring Hermes job. Its presence alone does not need a new commitment.', nextStep: 'Does this run need your attention, or can it stay in Automations?' };
  if (isUniversityWork(item.title, item.source, item.sourceContext?.provider)) return { outcome: 'proposed-commitment' as const, reason: 'The source identifies university work. Check whether it is already on Personal Tasks.', nextStep: 'Is this a new commitment, or part of an existing assignment?' };
  return { outcome: 'needs-decision' as const, reason: 'The supplied summary does not establish whether you want to act on this.', nextStep: 'Is there something here you want to follow through on?' };
}
