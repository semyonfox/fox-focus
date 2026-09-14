import type { ActionRow } from '../src/row-model.ts';
import type { RowStore, TaskStatusSettlement } from './row-store.ts';

export const TASK_STATUS_ACTION_LEASE_MS = 2 * 60_000;
export const TASK_STATUS_ACTION_POLL_MS = 5_000;

type TaskStatusConflict = Extract<TaskStatusSettlement, { outcome: 'conflict' }>;

export type TaskStatusExecutionResult =
  | Extract<TaskStatusSettlement, { outcome: 'succeeded' | 'failed' }>
  | Omit<TaskStatusConflict, 'current'> & { current?: TaskStatusConflict['current'] };

export type TaskStatusExecutor = {
  updateGoogleTaskCompletion: (input: {
    connectionId: string;
    containerId: string;
    externalId: string;
    desiredState: 'open' | 'completed';
    expectedVersion?: string;
  }) => Promise<TaskStatusExecutionResult>;
};

type TaskStatusActionStore = Pick<
  RowStore,
  'claimNextTaskStatusAction' | 'settleTaskStatusAction'
>;

export type TaskStatusActionWorkerOptions = {
  now?: () => Date;
  leaseMilliseconds?: number;
  pollMilliseconds?: number;
  onError?: (error: unknown) => void;
};

export function createTaskStatusActionWorker(
  store: TaskStatusActionStore,
  executor: TaskStatusExecutor,
  options: TaskStatusActionWorkerOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const leaseMilliseconds = options.leaseMilliseconds ?? TASK_STATUS_ACTION_LEASE_MS;
  const pollMilliseconds = options.pollMilliseconds ?? TASK_STATUS_ACTION_POLL_MS;
  const onError = options.onError ?? ((_error: unknown) => {
    console.error('Task status worker failed.');
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let active: Promise<void> | null = null;
  let requested = false;

  async function runOnce(): Promise<ActionRow | null> {
    const action = store.claimNextTaskStatusAction(now().toISOString(), leaseMilliseconds);
    if (!action) return null;
    if (action.payload.kind !== 'task-status' || !action.claimId) {
      throw new Error('Task status worker claimed an invalid action');
    }

    let result: TaskStatusSettlement;
    try {
      const executed = await executor.updateGoogleTaskCompletion({
        connectionId: action.payload.target.accountId,
        containerId: action.payload.target.listId,
        externalId: action.payload.target.externalId,
        desiredState: action.payload.after,
        ...(action.payload.expectedEtag ? { expectedVersion: action.payload.expectedEtag } : {}),
      });
      result = executed.outcome === 'conflict'
        ? { ...executed, current: executed.current ?? null }
        : executed;
    } catch {
      result = {
        outcome: 'failed',
        notice: 'The Google task update failed before a result was recorded.',
        retryable: true,
      };
    }

    return store.settleTaskStatusAction(action.id, action.claimId, result, now().toISOString());
  }

  async function runUntilIdle(limit = 100): Promise<number> {
    let completed = 0;
    while (completed < limit && await runOnce()) completed += 1;
    return completed;
  }

  function kick(): Promise<void> {
    requested = true;
    if (active) return active;

    const work = (async () => {
      while (requested) {
        requested = false;
        await runUntilIdle();
      }
    })();
    active = work;
    void work.catch(onError).finally(() => {
      if (active !== work) return;
      active = null;
      if (requested) void kick();
    });
    return work;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => { void kick(); }, pollMilliseconds);
    timer.unref();
    void kick();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { runOnce, runUntilIdle, kick, start, stop };
}

export type TaskStatusActionWorker = ReturnType<typeof createTaskStatusActionWorker>;
