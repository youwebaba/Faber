import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../core/runtime.mjs';

async function fixture(t, provider, host = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faber-b12-core-'));
  const runtime = await createRuntime({ dataDir: path.join(root, 'data'), sourceDir: path.join(root, 'source'), provider, host });
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const project = await runtime.request('project.create', { name: 'Fixture', path: path.join(root, 'workspace') });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  return { runtime, chat };
}
async function until(runtime, predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const state = await runtime.request('state.get'); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Fixture state timeout');
}
const finished = (runtime, id) => until(runtime, state => state.runs.some(run => run.id === id && ['completed', 'failed', 'canceled'].includes(run.status)));

test('model-requested time is accurate and live activity links to its exact transcript position', async t => {
  let turn = 0, name = 'Qwen3 fixture'; const liveEvents = [];
  const { runtime, chat } = await fixture(t, async function* ({ tools, messages }) {
    assert.ok(tools.some(tool => tool.name === 'system_time'));
    assert.match(messages[0].content, /Use system_time/);
    if (turn < 2) { yield { type: 'delta', text: `Time check ${turn}` }; yield { type: 'tool', id: `clock-${turn++}`, name: 'system_time', args: {} }; name = 'Another selected model'; }
    else yield { type: 'delta', text: 'Done' };
  }, { modelDisplayName: () => name });
  runtime.subscribe(event => { if (event.type === 'state') for (const run of event.state.runs) for (const tool of run.toolEvents) if (tool.status === 'running') liveEvents.push({ tool, messages: event.state.chats[0].messages }); });
  const before = Date.now(); const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'What time is it?' });
  const state = await finished(runtime, runId), run = state.runs.find(item => item.id === runId), messages = state.chats[0].messages;
  assert.equal(run.status, 'completed'); assert.equal(run.modelDisplayName, 'Qwen3 fixture'); assert.equal(run.requestMessageId, messages[0].id);
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  assert.ok(messages.every(message => message.runId === runId)); assert.equal(state.approvals.length, 0);
  for (const [index, event] of run.toolEvents.entries()) {
    const assistant = messages[1 + index * 2], result = messages[2 + index * 2], time = JSON.parse(result.content);
    assert.equal(event.toolCallId, `clock-${index}`); assert.equal(event.sourceMessageId, assistant.id); assert.equal(result.sourceMessageId, assistant.id);
    assert.equal(event.modelCallId, run.modelCalls[index].id); assert.equal(assistant.modelCallId, event.modelCallId); assert.equal(result.modelCallId, event.modelCallId);
    assert.ok(time.unixMilliseconds >= before && time.unixMilliseconds <= Date.now()); assert.equal(Date.parse(time.utc), time.unixMilliseconds);
    assert.equal(time.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone); assert.equal(time.utcOffsetMinutes, -new Date(time.unixMilliseconds).getTimezoneOffset()); assert.ok(time.local);
    assert.ok(liveEvents.some(entry => entry.tool.id === event.id && entry.messages.at(-1)?.id === assistant.id));
  }
});

test('partial failed output keeps its model-call association', async t => {
  const { runtime, chat } = await fixture(t, async function* () { yield { type: 'delta', text: 'Partial reply' }; throw new Error('Fixture failure'); });
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Start' }); const state = await finished(runtime, runId);
  assert.equal(state.runs[0].status, 'failed'); assert.equal(state.chats[0].messages.at(-1).modelCallId, state.runs[0].modelCalls[0].id);
});

test('automatic authority is tool-specific and cannot leak computer or network grants to the next tool', async t => {
  let trustedCalls = 0, ordinaryCalls = 0, turn = 0;
  const trusted = async (_args, ctx) => { await ctx.approve('network', 'Fixture browser connection'); trustedCalls++; return 'browser ready'; };
  const { runtime, chat } = await fixture(t, async function* () {
    if (!turn++) { yield { type: 'tool', id: 'browser-call', name: 'trusted_browser_fixture', args: {} }; yield { type: 'tool', id: 'ordinary-call', name: 'ordinary_fixture', args: {} }; }
    else yield { type: 'delta', text: 'Finished' };
  }, { isAutomaticTool: (tool, permission) => tool.name === 'trusted_browser_fixture' && tool.execute === trusted && ['computer', 'network'].includes(permission) });
  const parameters = { type: 'object', properties: {}, additionalProperties: false };
  runtime.registerTools([
    { name: 'trusted_browser_fixture', description: 'Trusted fixture', permission: 'computer', parameters, execute: trusted },
    { name: 'ordinary_fixture', description: 'Ordinary fixture', permission: 'computer', parameters, execute: () => { ordinaryCalls++; return 'executed'; } },
  ]);
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Use the fixture tools' });
  const waiting = await until(runtime, state => state.approvals.length === 1);
  assert.equal(trustedCalls, 1); assert.match(waiting.approvals[0].summary, /ordinary_fixture/); assert.deepEqual(waiting.runs[0].grants, []); assert.deepEqual(waiting.chats[0].grants, []);
  await runtime.request('approval.resolve', { id: waiting.approvals[0].id, allow: false }); await finished(runtime, runId); assert.equal(ordinaryCalls, 0);
});
