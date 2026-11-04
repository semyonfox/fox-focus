import { randomUUID } from 'node:crypto';
import { addCalendarDays, dublinDateKey } from '../src/calendar-time.ts';
import { isRecord } from '../src/model.ts';
import { JOB_MESSAGE_LIMIT, isUtcInstant, type AssistantId, type Job } from '../src/row-model.ts';
import { buildWorkThreads, hermesThreadEntries, latestSendActions, type WorkThread } from '../src/work-threads.ts';
import { threadEntries } from './agent-worker.ts';
import type { Store } from './store.ts';

// a stateless, tools-only MCP server over Streamable HTTP; JSON responses, no SSE stream
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

type McpStore = Pick<Store,
  'listInboxItems' | 'listJobs' | 'listActions' | 'listJobUpdates' | 'listDrafts' | 'listJobMessages' | 'getJob' |
  'getInboxItem' | 'createJob' | 'answerJob' | 'sendBackJob' | 'settleJob' | 'snoozeJob' | 'updateInboxDecision' | 'readContext'>;

export type McpOptions = {
  now: () => Date;
  foxAvailable: boolean;
  kickFox: () => void;
};

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
};

const keyProperty = { type: 'string', description: 'Thread key from list_threads, such as "job:..." or "inbox:...".' };

export const MCP_TOOLS: Tool[] = [
  {
    name: 'today', readOnly: true,
    description: "Semyon's day: Dublin date and time, today's calendar, tasks due or planned today, and threads waiting on him.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_tasks', readOnly: true,
    description: 'Open Google-backed tasks with their local plan. Filter "open" (default), "today", "overdue" or "all".',
    inputSchema: { type: 'object', properties: { filter: { type: 'string', enum: ['open', 'today', 'overdue', 'all'] } }, additionalProperties: false },
  },
  {
    name: 'list_threads', readOnly: true,
    description: 'Inbox threads: requests to Fox or Hermes and email decisions. Active threads by default, or "all" to include snoozed and settled.',
    inputSchema: { type: 'object', properties: { include: { type: 'string', enum: ['active', 'all'] } }, additionalProperties: false },
  },
  {
    name: 'read_thread', readOnly: true,
    description: "One thread's conversation, or an email item's summary and current reply draft.",
    inputSchema: { type: 'object', properties: { key: keyProperty }, required: ['key'], additionalProperties: false },
  },
  {
    name: 'start_thread', readOnly: false,
    description: 'Start a new thread with Fox (default, read-only Claude assistant) or Hermes. Returns the new thread key.',
    inputSchema: {
      type: 'object',
      properties: { request: { type: 'string', description: 'What the assistant should do.' }, assistant: { type: 'string', enum: ['fox', 'hermes'] } },
      required: ['request'], additionalProperties: false,
    },
  },
  {
    name: 'reply', readOnly: false,
    description: 'Answer a thread that is waiting on Semyon, or reply to a completed or settled thread to send it back to work.',
    inputSchema: { type: 'object', properties: { key: keyProperty, text: { type: 'string' } }, required: ['key', 'text'], additionalProperties: false },
  },
  {
    name: 'settle', readOnly: false,
    description: 'Mark a thread done and dealt with. Never completes a Google task or sends anything.',
    inputSchema: { type: 'object', properties: { key: keyProperty }, required: ['key'], additionalProperties: false },
  },
  {
    name: 'dismiss', readOnly: false,
    description: 'Dismiss an email item as not interesting, or drop a completed request.',
    inputSchema: { type: 'object', properties: { key: keyProperty }, required: ['key'], additionalProperties: false },
  },
  {
    name: 'snooze', readOnly: false,
    description: 'Hide a thread until a UTC time such as "2026-11-05T09:00:00.000Z", or pass null to wake it now.',
    inputSchema: {
      type: 'object',
      properties: { key: keyProperty, until: { type: ['string', 'null'] } },
      required: ['key', 'until'], additionalProperties: false,
    },
  },
];

class ToolError extends Error {}

function argString(args: Record<string, unknown>, name: string, maximum = JOB_MESSAGE_LIMIT): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`${name} is required.`);
  if (value.length > maximum) throw new ToolError(`${name} is longer than ${maximum} characters.`);
  return value.trim();
}

function oneLineTitle(text: string): string {
  const line = text.split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return line.length <= 80 ? line || 'New thread' : `${line.slice(0, 79)}…`;
}

function threadSummary(thread: WorkThread) {
  return {
    key: thread.key,
    title: thread.title,
    assistant: thread.assistant,
    status: thread.status,
    needs_you: thread.attention,
    shelf: thread.shelf,
    source: thread.source,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
  };
}

export function createMcpHandler(store: McpStore, options: McpOptions) {
  function threads(): WorkThread[] {
    return buildWorkThreads(store.listInboxItems(), store.listJobs(), latestSendActions(store.listActions()), options.now().getTime());
  }

  function findThread(key: string): WorkThread {
    const thread = threads().find(candidate => candidate.key === key);
    if (!thread) throw new ToolError(`No thread with key ${key}. Use list_threads.`);
    return thread;
  }

  function tasks(filter: string) {
    const now = options.now();
    const today = dublinDateKey(now);
    const context = store.readContext(today, addCalendarDays(today, 1), now.toISOString());
    return context.tasks.filter(entry => {
      const open = entry.task.observed?.status !== 'completed' && entry.task.unavailableAt === null;
      if (filter === 'all') return true;
      if (!open) return false;
      const dates = [entry.task.observed?.doOn, entry.plan.deadlineOn, entry.plan.plannedOn].filter((value): value is string => typeof value === 'string');
      if (filter === 'today') return dates.some(date => date <= today);
      if (filter === 'overdue') return dates.some(date => date < today);
      return true;
    }).map(entry => ({
      title: entry.task.observed?.title ?? 'Untitled task',
      area: entry.area,
      status: entry.task.observed?.status ?? 'open',
      do_on: entry.task.observed?.doOn ?? null,
      deadline: entry.plan.deadlineOn,
      planned_on: entry.plan.plannedOn,
      planned_at: entry.plan.plannedAt,
      waiting: entry.plan.waiting,
    }));
  }

  function jobFor(thread: WorkThread): Job | null {
    return thread.job ? store.getJob(thread.job.id) : null;
  }

  function callTool(name: string, args: Record<string, unknown>): unknown {
    const at = options.now().toISOString();
    switch (name) {
      case 'today': {
        const now = options.now();
        const today = dublinDateKey(now);
        const context = store.readContext(today, today, now.toISOString());
        return {
          now: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', dateStyle: 'full', timeStyle: 'short' }).format(now),
          calendar: context.calendar.map(event => ({ title: event.title, starts_at: event.startsAt ?? null, ends_at: event.endsAt ?? null, starts_on: event.startsOn ?? null })),
          tasks: tasks('today'),
          waiting_on_you: threads().filter(thread => thread.attention).map(threadSummary),
        };
      }
      case 'list_tasks':
        return { tasks: tasks(typeof args.filter === 'string' ? args.filter : 'open') };
      case 'list_threads': {
        const all = args.include === 'all';
        return { threads: threads().filter(thread => all || thread.shelf === 'active').map(threadSummary) };
      }
      case 'read_thread': {
        const thread = findThread(argString(args, 'key', 300));
        const job = jobFor(thread);
        const item = thread.item;
        const draft = item?.currentDraftId ? store.listDrafts().find(candidate => candidate.id === item.currentDraftId) ?? null : null;
        return {
          ...threadSummary(thread),
          waiting_question: job?.prompt ? { question: job.prompt.question, options: job.prompt.options } : job?.question ?? null,
          failure: job?.resultKind === 'failed' ? job.resultNote : null,
          messages: job
            ? (job.assistant === 'hermes'
              ? hermesThreadEntries(job, store.listJobUpdates(job.id))
              : threadEntries(store.listJobMessages(job.id))).map(entry => ({ from: entry.role, kind: entry.kind, text: entry.text, options: entry.options, url: entry.url, at: entry.at }))
            : [],
          email: item ? { title: item.title, summary: item.summary, draft_reply: draft ? draft.reply.bodyText : null } : null,
        };
      }
      case 'start_thread': {
        const request = argString(args, 'request', 2_000);
        const assistant: AssistantId = args.assistant === 'hermes' ? 'hermes' : args.assistant === 'fox' || options.foxAvailable ? 'fox' : 'hermes';
        if (assistant === 'fox' && !options.foxAvailable) throw new ToolError('Fox is not configured on this server.');
        const result = store.createJob({ title: oneLineTitle(request), instruction: request, taskId: null, inboxId: null, ...(assistant === 'fox' ? { assistant } : {}) }, at, `mcp-${randomUUID()}`);
        if (result.outcome !== 'created' && result.outcome !== 'replayed') throw new ToolError('The thread could not be started.');
        if (assistant === 'fox') options.kickFox();
        return { key: `job:${result.job.id}`, assistant, status: 'Queued' };
      }
      case 'reply': {
        const thread = findThread(argString(args, 'key', 300));
        const text = argString(args, 'text');
        const job = jobFor(thread);
        if (!job) throw new ToolError('Email items have no conversation. Use settle, dismiss or snooze.');
        const result = job.state === 'needs_you'
          ? store.answerJob(job.id, job.version, text, at)
          : store.sendBackJob(job.id, job.version, text, at);
        if (result.outcome !== 'updated') {
          throw new ToolError(result.outcome === 'invalid_input'
            ? 'Hermes replies must be one line of up to 280 characters.'
            : `The thread is ${job.state} and cannot take a reply right now.`);
        }
        if (job.assistant === 'fox') options.kickFox();
        return { key: thread.key, state: result.job.state };
      }
      case 'settle':
      case 'dismiss': {
        const thread = findThread(argString(args, 'key', 300));
        const job = jobFor(thread);
        if (job) {
          const result = store.settleJob(job.id, job.version, name === 'settle' ? 'accepted' : 'dropped', at);
          if (result.outcome !== 'settled') throw new ToolError('Only a completed or failed thread can be settled. Reply or wait first.');
          return { key: thread.key, state: 'settled' };
        }
        const item = thread.item ? store.getInboxItem(thread.item.id) : null;
        if (!item || item.state === 'resolved') throw new ToolError('This thread is already settled.');
        const updated = store.updateInboxDecision(item.id, item.version, { state: 'resolved', outcome: name === 'settle' ? 'read' : 'dismissed', snoozedUntil: null }, at);
        if (!updated) throw new ToolError('The item changed or is locked by a pending send. Read it again.');
        return { key: thread.key, state: 'settled' };
      }
      case 'snooze': {
        const thread = findThread(argString(args, 'key', 300));
        const until = args.until;
        if (until !== null && !isUtcInstant(until)) throw new ToolError('until must be a UTC time such as 2026-11-05T09:00:00.000Z, or null.');
        const job = jobFor(thread);
        if (job) {
          const result = store.snoozeJob(job.id, job.version, until, at);
          if (result.outcome !== 'updated') throw new ToolError('This thread cannot be snoozed to that time.');
          return { key: thread.key, snoozed_until: until };
        }
        const item = thread.item ? store.getInboxItem(thread.item.id) : null;
        if (!item || item.state === 'resolved') throw new ToolError('This thread is settled.');
        const updated = store.updateInboxDecision(item.id, item.version, until === null
          ? { state: 'open', outcome: null, snoozedUntil: null }
          : { state: 'waiting', outcome: null, snoozedUntil: until }, at);
        if (!updated) throw new ToolError('The item changed, is locked by a pending send, or the time is in the past.');
        return { key: thread.key, snoozed_until: until };
      }
      default:
        throw new ToolError(`Unknown tool ${name}.`);
    }
  }

  // handles one JSON-RPC message; notifications return null
  function handle(message: unknown): Record<string, unknown> | null {
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    }
    const hasId = typeof message.id === 'string' || typeof message.id === 'number';
    if (!hasId) return null;
    const id = message.id;
    const params = isRecord(message.params) ? message.params : {};
    const result = (value: unknown) => ({ jsonrpc: '2.0', id, result: value });
    switch (message.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return result({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fox-focus', version: '1.0.0' },
          instructions: "Semyon's Fox Focus: tasks, calendar and an Inbox of threads with Fox and Hermes. Tools only read context or make local Inbox decisions; nothing here writes to Google, Gmail or calendars.",
        });
      }
      case 'ping':
        return result({});
      case 'tools/list':
        return result({
          tools: MCP_TOOLS.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
          })),
        });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = isRecord(params.arguments) ? params.arguments : {};
        try {
          const value = callTool(name, args);
          return result({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
        } catch (error) {
          if (error instanceof ToolError) return result({ content: [{ type: 'text', text: error.message }], isError: true });
          throw error;
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  }

  return { handle };
}
