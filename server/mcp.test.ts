import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app.ts';
import { canonicalHash } from './row-store.ts';
import { openStore } from './store.ts';

const password = 'test-only-password-at-least-24-characters';
const token = 'mcp-test-token-at-least-24-characters-long';
const hermesToken = 'hermes-test-token-at-least-24-characters';
const at = '2026-11-04T10:00:00.000Z';

function setup(options: { fox?: boolean } = {}) {
  const store = openStore(':memory:');
  let kicks = 0;
  const app = createApp(store, password, undefined, undefined, {
    now: () => new Date(at),
    mcpToken: token,
    taskStatusToken: hermesToken,
    ...(options.fox === false ? {} : { agentWorker: { kick: () => { kicks += 1; } } }),
  });
  let id = 0;
  async function rpc(method: string, params?: Record<string, unknown>, auth = `Bearer ${token}`) {
    id += 1;
    return app.request('/mcp', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.status, 200);
    const body = await response.json() as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> } };
    return body.result;
  }
  return { store, app, rpc, call, kicks: () => kicks };
}

test('the MCP endpoint only answers its own bearer token over POST', async () => {
  const { app, rpc, store } = setup();
  try {
    assert.equal((await rpc('ping', undefined, '')).status, 401);
    assert.equal((await rpc('ping', undefined, `Bearer ${hermesToken}`)).status, 401);
    const basic = `Basic ${Buffer.from(`fox:${password}`).toString('base64')}`;
    assert.equal((await rpc('ping', undefined, basic)).status, 401);
    assert.equal((await app.request('/mcp', { headers: { authorization: `Bearer ${token}` } })).status, 405);
    const crossOrigin = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'https://evil.example', host: 'focus.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(crossOrigin.status, 403);
    // the owner API is untouched by the MCP token
    assert.equal((await app.request('/api/v1/rows', { headers: { authorization: `Bearer ${token}` } })).status, 401);
  } finally { store.close(); }
});

test('the MCP handshake negotiates a version and lists the tools', async () => {
  const { app, rpc, store } = setup();
  try {
    const init = await (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json() as {
      result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
    };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'fox-focus');
    const unknown = await (await rpc('initialize', { protocolVersion: '1999-01-01' })).json() as { result: { protocolVersion: string } };
    assert.equal(unknown.result.protocolVersion, '2025-11-25');
    const notified = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(notified.status, 202);
    const tools = await (await rpc('tools/list')).json() as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
    assert.deepEqual(tools.result.tools.map(tool => tool.name),
      ['today', 'list_tasks', 'list_threads', 'read_thread', 'start_thread', 'reply', 'settle', 'dismiss', 'snooze']);
    assert.equal(tools.result.tools.find(tool => tool.name === 'today')?.annotations.readOnlyHint, true);
    const missing = await (await rpc('resources/list')).json() as { error: { code: number } };
    assert.equal(missing.error.code, -32601);
  } finally { store.close(); }
});

test('MCP tools start, read, answer, settle, snooze and dismiss threads without provider writes', async () => {
  const { call, store, kicks } = setup();
  try {
    const started = await call('start_thread', { request: 'Book my NCT before the end of the month' });
    assert.equal(started.isError, undefined);
    const key = String(started.structuredContent?.key);
    assert.match(key, /^job:/);
    assert.equal(started.structuredContent?.assistant, 'fox');
    assert.equal(kicks(), 1);

    // simulate Fox asking a question
    const claim = store.claimNextAgentJob('fox', at, 60_000);
    assert.ok(claim);
    store.appendAgentMessage(claim.job.id, claim.claimId, {
      role: 'assistant', model: 'claude-opus-5-5', usage: null,
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'ask_user', input: { question: 'Which slot?', options: ['Thu', 'Mon'] } }],
    }, at, 60_000);
    store.finishAgentRun(claim.job.id, claim.claimId, { kind: 'ask', prompt: { kind: 'choice', toolUseId: 'toolu_1', question: 'Which slot?', options: ['Thu', 'Mon'] } }, at);

    const today = await call('today');
    assert.deepEqual((today.structuredContent?.waiting_on_you as Array<{ key: string }>).map(thread => thread.key), [key]);
    const read = await call('read_thread', { key });
    assert.deepEqual(read.structuredContent?.waiting_question, { question: 'Which slot?', options: ['Thu', 'Mon'] });

    const answered = await call('reply', { key, text: 'Thu' });
    assert.equal(answered.structuredContent?.state, 'queued');
    assert.equal(kicks(), 2);
    assert.equal((await call('settle', { key })).isError, true);

    const reclaim = store.claimNextAgentJob('fox', at, 60_000);
    assert.ok(reclaim);
    store.appendAgentMessage(reclaim.job.id, reclaim.claimId, { role: 'assistant', model: 'claude-opus-5-5', usage: null, content: [{ type: 'text', text: 'Held Thursday.' }] }, at, 60_000);
    store.finishAgentRun(reclaim.job.id, reclaim.claimId, { kind: 'complete' }, at);
    assert.equal((await call('settle', { key })).structuredContent?.state, 'settled');

    const email = {
      expectedVersion: null,
      source: { kind: 'email' as const, accountId: 'personal', messageId: 'msg-1', threadId: 'thread-1' },
      title: 'Review LinkedIn message', summary: 'A recruiter wrote.', likelyNoise: false,
    };
    store.upsertHermesInbox('email:personal:msg-1', canonicalHash(email), email, at);
    const listed = await call('list_threads');
    const emailKey = (listed.structuredContent?.threads as Array<{ key: string; title: string }>).find(thread => thread.title === 'Review LinkedIn message')?.key;
    assert.ok(emailKey);
    assert.equal((await call('snooze', { key: emailKey, until: '2026-11-05T09:00:00.000Z' })).structuredContent?.snoozed_until, '2026-11-05T09:00:00.000Z');
    assert.equal((await call('snooze', { key: emailKey, until: 'tomorrow' })).isError, true);
    assert.equal((await call('dismiss', { key: emailKey })).structuredContent?.state, 'settled');
    assert.equal(store.listInboxItems().find(item => item.title === 'Review LinkedIn message')?.outcome, 'dismissed');

    assert.equal((await call('read_thread', { key: 'job:missing' })).isError, true);
    assert.equal(store.listActions().length, 0);
  } finally { store.close(); }
});

test('start_thread falls back to Hermes when Fox is not configured', async () => {
  const { call, store } = setup({ fox: false });
  try {
    const started = await call('start_thread', { request: 'Check the gala entries' });
    assert.equal(started.structuredContent?.assistant, 'hermes');
    assert.equal((await call('start_thread', { request: 'Hi', assistant: 'fox' })).isError, true);
  } finally { store.close(); }
});
