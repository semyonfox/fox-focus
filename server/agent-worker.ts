import type Anthropic from '@anthropic-ai/sdk';
import { addCalendarDays, dublinDateKey } from '../src/calendar-time.ts';
import { isRecord } from '../src/model.ts';
import type { AssistantId, Job, JobPrompt, ThreadEntry } from '../src/row-model.ts';
import { isRoutineMirror } from '../src/work-threads.ts';
import type { JobMessageRow } from './row-store.ts';
import type { Store } from './store.ts';

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type MessageCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export const AGENT_MODEL = 'claude-opus-5-5';
const AGENT_LEASE_MS = 10 * 60_000;
const AGENT_POLL_MS = 30_000;
const MAX_MODEL_CALLS_PER_RUN = 10;
const SPEND_WINDOW_MS = 24 * 60 * 60_000;

// the worker stores the response content as transcript data and reads only these fields
export type AgentModelResponse = {
  content: unknown[];
  stop_reason: string | null;
  model: string;
  usage: object;
};

export type AgentModelClient = {
  create: (params: MessageCreateParams) => Promise<AgentModelResponse>;
};

type AgentStore = Pick<Store,
  'claimNextAgentJob' | 'appendAgentMessage' | 'finishAgentRun' | 'listJobMessages' | 'listAgentUsageSince' |
  'readContext' | 'getTask' | 'getInboxItem'>;

export const ASK_USER = 'ask_user';
export const GET_CONTEXT = 'get_context';
export const SETTLE_THREAD = 'settle_thread';

// the tool list must stay stable: a suspended thread resumes against the same tools
export const AGENT_TOOLS: BetaTool[] = [
  {
    name: GET_CONTEXT,
    description: "Read Semyon's current open tasks, the next seven days of calendar, Inbox items that need him, the current Dublin date and time, and anything linked to this thread. Read only.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: ASK_USER,
    description: 'Ask Semyon one question when you need a decision or information only he has. Give 2 to 4 short options. He can also reply in his own words. The thread pauses until he answers.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One short question.' },
        options: { type: 'array', items: { type: 'string' }, description: '2 to 4 short answer options.' },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: SETTLE_THREAD,
    description: "Mark this thread as done. Only call this when Semyon says the thread is finished, for example \"we're done\".",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

const SYSTEM_PROMPT = [
  'You are Fox, an assistant inside Fox Focus, the private life manager of Semyon, a computer science student in Galway.',
  'Each conversation is a thread in his Inbox. Be brief, plain and practical. Write in British English.',
  `Call ${GET_CONTEXT} when the request involves his tasks, calendar, Inbox or today's date. Dates and times are in Europe/Dublin.`,
  'You cannot change anything outside this conversation. You cannot create or complete tasks, send email, or edit calendars. Say exactly what Semyon should do, or what he could approve, instead.',
  'Work things out yourself. Pick sensible defaults and state what you assumed in one short line instead of asking.',
  `Only call ${ASK_USER} when you cannot continue without information only Semyon has, or when the choice would materially change the result. Never ask to confirm something you could just do. Give one short question and 2 to 4 options, never a question in plain text.`,
  `When Semyon says the thread is finished, call ${SETTLE_THREAD}.`,
  'When the request is done, reply with the answer itself. Keep it short.',
].join('\n');

// rough per-million-token prices; unknown models (such as a refusal fallback) use the higher rate
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  [AGENT_MODEL]: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
const DEFAULT_PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

function tokenCount(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function usageCostUsd(model: string | null, usage: Record<string, unknown>): number {
  const price = (model && PRICES[model]) || DEFAULT_PRICE;
  return (tokenCount(usage, 'input_tokens') * price.input +
    tokenCount(usage, 'output_tokens') * price.output +
    tokenCount(usage, 'cache_creation_input_tokens') * price.cacheWrite +
    tokenCount(usage, 'cache_read_input_tokens') * price.cacheRead) / 1_000_000;
}

type Block = Record<string, unknown> & { type: string };

function isBlock(value: unknown): value is Block {
  return isRecord(value) && typeof value.type === 'string';
}

function blocks(message: JobMessageRow): Block[] {
  return message.content.filter(isBlock);
}

// the transcript is written by this worker from API responses and owner input, so the stored
// blocks are already in API shape; this check rejects anything that is not a block at all
function toMessageParams(messages: JobMessageRow[]): BetaMessageParam[] {
  return messages.map(message => {
    const content = blocks(message);
    if (content.length !== message.content.length) throw new Error(`Job message ${message.seq} has an invalid block`);
    return { role: message.role, content: content as unknown as BetaContentBlockParam[] };
  });
}

function toolUses(message: JobMessageRow): Array<{ id: string; name: string; input: unknown }> {
  return blocks(message).flatMap(block =>
    block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
      ? [{ id: block.id, name: block.name, input: block.input }]
      : []);
}

function textOf(message: JobMessageRow): string {
  return blocks(message).flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('\n\n').trim();
}

export function parseAskInput(toolUseId: string, input: unknown): JobPrompt | null {
  if (!isRecord(input) || typeof input.question !== 'string' || !Array.isArray(input.options)) return null;
  const question = input.question.trim();
  const options = input.options.flatMap(option => typeof option === 'string' && option.trim() ? [option.trim().replace(/\s+/g, ' ')] : []);
  if (!question || question.length > 1_000 || options.length < 2 || options.length > 4 || options.some(option => option.length > 120)) {
    return null;
  }
  return { kind: 'choice', toolUseId, question, options };
}

function summariseContext(store: AgentStore, job: Job, now: Date): Record<string, unknown> {
  const today = dublinDateKey(now);
  const context = store.readContext(today, addCalendarDays(today, 7), now.toISOString());
  const openTasks = context.tasks
    .filter(entry => entry.task.observed?.status !== 'completed' && entry.task.unavailableAt === null)
    .slice(0, 60)
    .map(entry => ({
      title: entry.task.observed?.title ?? 'Untitled task',
      area: entry.area,
      doOn: entry.task.observed?.doOn ?? null,
      deadline: entry.plan.deadlineOn,
      plannedOn: entry.plan.plannedOn,
      plannedAt: entry.plan.plannedAt,
      waiting: entry.plan.waiting,
    }));
  const calendar = context.calendar.slice(0, 40).map(event => ({
    title: event.title,
    startsAt: event.startsAt ?? null,
    endsAt: event.endsAt ?? null,
    startsOn: event.startsOn ?? null,
  }));
  const inbox = context.inbox
    .filter(entry => entry.item.state === 'open' && !isRoutineMirror(entry.item))
    .slice(0, 20)
    .map(entry => ({ title: entry.item.title, summary: entry.item.summary.slice(0, 300) }));
  const linkedTask = job.taskId ? store.getTask(job.taskId) : null;
  const linkedInbox = job.inboxId ? store.getInboxItem(job.inboxId) : null;
  return {
    now: new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Dublin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(now),
    timeZone: 'Europe/Dublin',
    linked: {
      task: linkedTask?.observed?.title ?? null,
      inbox: linkedInbox ? { title: linkedInbox.title, summary: linkedInbox.summary.slice(0, 1_000) } : null,
    },
    openTasks,
    calendar,
    inbox,
  };
}

export type AgentWorkerOptions = {
  assistant?: AssistantId;
  model?: string;
  maxConcurrent?: number;
  dailyBudgetUsd?: number;
  now?: () => Date;
  leaseMilliseconds?: number;
  pollMilliseconds?: number;
  onError?: (error: unknown) => void;
};

export function createAgentWorker(store: AgentStore, client: AgentModelClient, options: AgentWorkerOptions = {}) {
  const assistant = options.assistant ?? 'fox';
  const model = options.model ?? AGENT_MODEL;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
  const dailyBudgetUsd = options.dailyBudgetUsd ?? 5;
  const now = options.now ?? (() => new Date());
  const leaseMilliseconds = options.leaseMilliseconds ?? AGENT_LEASE_MS;
  const pollMilliseconds = options.pollMilliseconds ?? AGENT_POLL_MS;
  const onError = options.onError ?? ((_error: unknown) => { console.error('Agent worker failed.'); });
  const running = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function spentUsd(at: Date): number {
    const since = new Date(at.getTime() - SPEND_WINDOW_MS).toISOString();
    return store.listAgentUsageSince(since).reduce((sum, row) => sum + usageCostUsd(row.model, row.usage), 0);
  }

  function append(jobId: string, claimId: string, message: Parameters<AgentStore['appendAgentMessage']>[2]): JobMessageRow | null {
    return store.appendAgentMessage(jobId, claimId, message, now().toISOString(), leaseMilliseconds);
  }

  function finish(jobId: string, claimId: string, end: Parameters<AgentStore['finishAgentRun']>[2]): void {
    store.finishAgentRun(jobId, claimId, end, now().toISOString());
  }

  async function run(job: Job, claimId: string): Promise<void> {
    let calls = 0;
    for (;;) {
      const messages = store.listJobMessages(job.id);
      const last = messages.at(-1);
      if (!last) {
        finish(job.id, claimId, { kind: 'failed', note: 'This thread has no message to work on.' });
        return;
      }
      if (last.role === 'assistant') {
        const uses = toolUses(last);
        if (!uses.length) {
          finish(job.id, claimId, { kind: 'complete' });
          return;
        }
        const results: BetaToolResultBlockParam[] = [];
        for (const use of uses) {
          if (use.name === ASK_USER) {
            const prompt = parseAskInput(use.id, use.input);
            if (prompt) {
              finish(job.id, claimId, { kind: 'ask', prompt });
              return;
            }
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Ask one short question with 2 to 4 short options.' });
          } else if (use.name === SETTLE_THREAD) {
            if (!append(job.id, claimId, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'Settled.' }], usage: null, model: null })) return;
            finish(job.id, claimId, { kind: 'settle' });
            return;
          } else if (use.name === GET_CONTEXT) {
            results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(summariseContext(store, job, now())) });
          } else {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}.` });
          }
        }
        if (!append(job.id, claimId, { role: 'user', content: results, usage: null, model: null })) return;
        continue;
      }
      if (calls >= MAX_MODEL_CALLS_PER_RUN) {
        finish(job.id, claimId, { kind: 'failed', note: `Stopped after ${MAX_MODEL_CALLS_PER_RUN} steps. Reply to let it continue.` });
        return;
      }
      if (spentUsd(now()) >= dailyBudgetUsd) {
        finish(job.id, claimId, { kind: 'failed', note: `The ${dailyBudgetUsd.toFixed(2)} USD spend cap for the last 24 hours is used up. Reply later to try again.` });
        return;
      }
      let response: AgentModelResponse;
      try {
        response = await client.create({
          model,
          max_tokens: 16_000,
          system: SYSTEM_PROMPT,
          tools: AGENT_TOOLS,
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          messages: toMessageParams(messages),
          cache_control: { type: 'ephemeral' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
      } catch {
        finish(job.id, claimId, { kind: 'failed', note: 'The model request failed. Reply to try again.' });
        return;
      }
      calls += 1;
      const usage = JSON.parse(JSON.stringify(response.usage)) as Record<string, unknown>;
      const content = JSON.parse(JSON.stringify(response.content)) as unknown[];
      if (!append(job.id, claimId, { role: 'assistant', content, usage, model: response.model })) return;
      if (response.stop_reason === 'refusal') {
        finish(job.id, claimId, { kind: 'failed', note: 'The model declined this request.' });
        return;
      }
      if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') {
        finish(job.id, claimId, { kind: 'failed', note: 'The reply ran out of room. Reply with a narrower request.' });
        return;
      }
      // tool_use, end_turn and pause_turn are all handled at the top of the loop from the stored message
    }
  }

  function kick(): void {
    while (running.size < maxConcurrent) {
      const claim = store.claimNextAgentJob(assistant, now().toISOString(), leaseMilliseconds);
      if (!claim) return;
      const work = run(claim.job, claim.claimId).catch(onError).finally(() => {
        running.delete(work);
        kick();
      });
      running.add(work);
    }
  }

  async function runUntilIdle(): Promise<void> {
    kick();
    while (running.size) await Promise.race(running);
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => kick(), pollMilliseconds);
    timer.unref();
    kick();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { kick, runUntilIdle, start, stop };
}

export type AgentWorker = ReturnType<typeof createAgentWorker>;

// projects the raw transcript into what the thread view shows; tool plumbing and thinking stay hidden
export function threadEntries(messages: JobMessageRow[]): ThreadEntry[] {
  const askIds = new Set<string>();
  const entries: ThreadEntry[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = textOf(message);
      if (text) entries.push({ seq: message.seq, role: 'assistant', kind: 'message', text, options: [], url: null, at: message.at });
      for (const use of toolUses(message)) {
        if (use.name === ASK_USER) {
          const prompt = parseAskInput(use.id, use.input);
          if (!prompt) continue;
          askIds.add(use.id);
          entries.push({ seq: message.seq, role: 'assistant', kind: 'question', text: prompt.question, options: prompt.options, url: null, at: message.at });
        } else if (use.name === GET_CONTEXT) {
          entries.push({ seq: message.seq, role: 'assistant', kind: 'activity', text: 'Checked your tasks, calendar and Inbox', options: [], url: null, at: message.at });
        } else if (use.name === SETTLE_THREAD) {
          entries.push({ seq: message.seq, role: 'assistant', kind: 'activity', text: 'Settled the thread', options: [], url: null, at: message.at });
        }
      }
      continue;
    }
    for (const block of blocks(message)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        entries.push({ seq: message.seq, role: 'owner', kind: 'message', text: block.text, options: [], url: null, at: message.at });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && askIds.has(block.tool_use_id) &&
        typeof block.content === 'string') {
        entries.push({ seq: message.seq, role: 'owner', kind: 'answer', text: block.content, options: [], url: null, at: message.at });
      }
    }
  }
  return entries;
}
