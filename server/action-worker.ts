import type { ActionRow } from '../src/row-model.ts';
import type {
  RowStore,
  TaskCreateSettlement,
  TaskStatusSettlement,
} from './row-store.ts';

export const TASK_STATUS_ACTION_LEASE_MS = 2 * 60_000;
export const TASK_STATUS_ACTION_POLL_MS = 5_000;

type TaskStatusConflict = Extract<TaskStatusSettlement, { outcome: 'conflict' }>;

export type TaskStatusExecutionResult =
  | Extract<TaskStatusSettlement, { outcome: 'succeeded' | 'failed' }>
  | Omit<TaskStatusConflict, 'current'> & { current?: TaskStatusConflict['current'] };

export type TaskStatusExecutor = {
  updateGoogleTaskCompletion: (input: {
    accountId: string;
    containerId: string;
    externalId: string;
    desiredState: 'open' | 'completed';
    expectedVersion?: string;
  }) => Promise<TaskStatusExecutionResult>;
};

type TaskCreateSucceeded = Extract<TaskCreateSettlement, { outcome: 'succeeded' }>;

export type TaskCreateExecutionResult =
  | Exclude<TaskCreateSettlement, TaskCreateSucceeded>
  | Omit<TaskCreateSucceeded, 'current'> & {
      current: Omit<TaskCreateSucceeded['current'], 'version'> & { version: string | null };
    };

export type TaskCreateExecutor = {
  createGoogleTask: (input: {
    accountId: string;
    containerId: string;
    title: string;
    notes: string;
    dueOn: string | null;
  }) => Promise<TaskCreateExecutionResult>;
  reconcileGoogleTaskCreate: (input: {
    accountId: string;
    containerId: string;
    nonce: string;
    candidateExternalId?: string;
  }) => Promise<TaskCreateExecutionResult>;
};

export type TaskActionExecutor = TaskStatusExecutor & TaskCreateExecutor;

function normalizeTaskCreateResult(result: TaskCreateExecutionResult): TaskCreateSettlement {
  if (result.outcome !== 'succeeded') return result;
  const version = result.current.version;
  if (version === null) {
    return {
      outcome: 'unknown',
      notice: 'Google returned the created task without an ETag. Reconciliation is required before any new insert.',
      candidateExternalId: result.externalId,
    };
  }
  return { ...result, current: { ...result.current, version } };
}

type TaskActionStore = Pick<
  RowStore,
  | 'claimNextTaskStatusAction'
  | 'settleTaskStatusAction'
  | 'claimNextTaskCreateAction'
  | 'settleTaskCreateAction'
> & {
  wakeDueInboxItems?: (now: string) => number;
  recoverExpiredEmailSendActions?: (now: string) => number;
};

export type TaskStatusActionWorkerOptions = {
  now?: () => Date;
  leaseMilliseconds?: number;
  pollMilliseconds?: number;
  onError?: (error: unknown) => void;
};

export function createTaskStatusActionWorker(
  store: TaskActionStore,
  executor: TaskActionExecutor,
  options: TaskStatusActionWorkerOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const leaseMilliseconds = options.leaseMilliseconds ?? TASK_STATUS_ACTION_LEASE_MS;
  const pollMilliseconds = options.pollMilliseconds ?? TASK_STATUS_ACTION_POLL_MS;
  const onError = options.onError ?? ((_error: unknown) => {
    console.error('Task action worker failed.');
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let active: Promise<void> | null = null;
  let requested = false;

  async function runTaskStatusOnce(): Promise<{ claimed: boolean; action: ActionRow | null }> {
    const action = store.claimNextTaskStatusAction(now().toISOString(), leaseMilliseconds);
    if (!action) return { claimed: false, action: null };
    if (action.payload.kind !== 'task-status' || !action.claimId) {
      throw new Error('Task status worker claimed an invalid action');
    }

    let result: TaskStatusSettlement;
    try {
      const executed = await executor.updateGoogleTaskCompletion({
        accountId: action.payload.target.accountId,
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

    return {
      claimed: true,
      action: store.settleTaskStatusAction(action.id, action.claimId, result, now().toISOString()),
    };
  }

  function candidateExternalId(action: ActionRow): string | undefined {
    const candidate = action.receipt?.candidateExternalId;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
  }

  async function runTaskCreateOnce(): Promise<ActionRow | null> {
    const claim = store.claimNextTaskCreateAction(now().toISOString(), leaseMilliseconds);
    if (!claim) return null;
    const { action, mode } = claim;
    if (!action.claimId) {
      throw new Error('Task create worker claimed an invalid action');
    }

    const candidate = candidateExternalId(action);
    let result: TaskCreateSettlement;
    try {
      const executed = mode === 'create'
        ? await executor.createGoogleTask({
            accountId: action.payload.destination.accountId,
            containerId: action.payload.destination.listId,
            title: action.payload.title,
            notes: action.payload.notes,
            dueOn: action.payload.doOn,
          })
        : await executor.reconcileGoogleTaskCreate({
            accountId: action.payload.destination.accountId,
            containerId: action.payload.destination.listId,
            nonce: action.payload.nonce,
            ...(candidate === undefined ? {} : { candidateExternalId: candidate }),
          });
      result = normalizeTaskCreateResult(executed);
    } catch {
      result = {
        outcome: 'unknown',
        notice: mode === 'create'
          ? 'The Google create ended without a confirmed result. Reconciliation is required before any new insert.'
          : 'The Google task could not be reconciled. Do not insert it again.',
        ...(candidate === undefined ? {} : { candidateExternalId: candidate }),
      };
    }

    return store.settleTaskCreateAction(action.id, action.claimId, result, now().toISOString());
  }

  async function runNextAction(): Promise<ActionRow | null> {
    const status = await runTaskStatusOnce();
    if (status.claimed) return status.action;
    return runTaskCreateOnce();
  }

  function runMaintenance(): void {
    const timestamp = now().toISOString();
    store.wakeDueInboxItems?.(timestamp);
    store.recoverExpiredEmailSendActions?.(timestamp);
  }

  async function runOnce(): Promise<ActionRow | null> {
    runMaintenance();
    return runNextAction();
  }

  async function runUntilIdle(limit = 100): Promise<number> {
    runMaintenance();
    let completed = 0;
    while (completed < limit && await runNextAction()) completed += 1;
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
