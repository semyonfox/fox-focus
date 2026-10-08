import { createHash } from 'node:crypto';

/** Only ignore metadata that cannot change the meaning of a status-only approval. */
export function taskCompletionFingerprint(task: {
  title: string;
  notes: string | null;
  state: 'open' | 'completed';
  dueOn: string | null;
  parentId: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify([
    task.title, task.notes ?? '', task.state, task.dueOn, task.parentId,
  ])).digest('base64url');
}
