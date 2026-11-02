import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../core/runtime.mjs';
import { streamProvider, providerMessages } from '../core/provider.mjs';
import { responsesInput } from '../core/responses.mjs';

// Deterministic fixtures only: no provider/network requests or native effects.
const empty = { type: 'object', properties: {}, additionalProperties: false };
async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), 'sophia-context-test-'));
  const options = { dataDir: join(root, 'data'), sourceDir: join(root, 'source'), provider };
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const open = async () => { const runtime = await createRuntime(options); runtimes.push(runtime); return runtime; };
  const runtime = await open();
  const project = await runtime.request('project.create', { name: 'Fixture', path: options.sourceDir });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  return { runtime, chat, options, open };
}
async function until(runtime, predicate) {
  const initial = await runtime.request('state.get');
  if (predicate(initial)) return initial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Fixture state wait timed out')); }, 15000);
    const unsubscribe = runtime.subscribe(event => {
      if (event.type === 'state' && predicate(event.state)) { clearTimeout(timer); unsubscribe(); resolve(event.state); }
    });
  });
}
const finish = (runtime, id) => until(runtime, state => state.runs.some(run => run.id === id && !['running', 'waiting_approval'].includes(run.status)));

for (const kind of ['ollama', 'openai', 'openai-responses']) test(`${kind}: complete old/latest history, tools and opaque items survive legacy settings`, async t => {
  const requests = [];
  const configuration = { id: 'fixture', name: 'Fixture', kind, baseUrl: 'http://localhost:1/v1', model: 'fixture-model' };
  const latest = 'latest user text '.repeat(4000), args = { text: 'full argument '.repeat(4000) };
  const result = { text: 'full result '.repeat(6000) };
  const opaque = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque'.repeat(12000) };
  const functionCall = { type: 'function_call', id: 'fc_latest', call_id: 'latest-call', name: 'fixture_tool', arguments: JSON.stringify(args), status: 'completed' };
  const provider = input => streamProvider({ ...input, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const first = requests.length === 1;
    if (kind === 'ollama') {
      assert.equal(body.options, undefined);
      return new Response(JSON.stringify({ message: first ? { content: '', tool_calls: [{ id: 'latest-call', function: { name: 'fixture_tool', arguments: args } }] } : { content: 'done' }, done: true }) + '\n');
    }
    if (kind === 'openai') return new Response(`data: ${JSON.stringify({ choices: [{ delta: first ? { tool_calls: [{ index: 0, id: 'latest-call', function: { name: 'fixture_tool', arguments: JSON.stringify(args) } }] } : { content: 'done' }, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\n`);
    const output = first ? [opaque, functionCall] : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }];
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`);
  } });
  const setup = await fixture(t, provider);
  await setup.runtime.request('provider.save', configuration);
  await setup.runtime.request('chat.update', { id: setup.chat.id, providerId: configuration.id });
  await setup.runtime.close();
  const statePath = join(setup.options.dataDir, 'state.json');
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  Object.assign(saved.settings, { maxTurns: 1, contextChars: 8000, contextMessages: 4 });
  const history = Array.from({ length: 100 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', content: `History ${i}: ${'unaltered '.repeat(500)}` }));
  const oldCall = { ...functionCall, id: 'fc_old', call_id: 'old-call' };
  history.push({ id: 'old-assistant', role: 'assistant', content: 'old assistant '.repeat(3000), toolCalls: [{ id: 'old-call', name: 'fixture_tool', args }], ...(kind === 'openai-responses' ? { providerOutput: { kind, providerId: configuration.id, baseUrl: configuration.baseUrl, model: configuration.model, items: [opaque, oldCall] } } : {}) });
  history.push({ id: 'old-result', role: 'tool', content: JSON.stringify(result), toolCallId: 'old-call', toolName: 'fixture_tool' });
  saved.chats[0].messages = history;
  await writeFile(statePath, JSON.stringify(saved));
  const runtime = await setup.open();
  const tool = { name: 'fixture_tool', description: 'Large schema description '.repeat(2000), permission: 'read', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, execute: actual => { assert.deepEqual(actual, args); return result; } };
  runtime.registerTools([tool]);
  for (const key of ['contextChars', 'contextMessages', 'maxTurns']) {
    assert.equal(Object.hasOwn((await runtime.request('state.get')).settings, key), false);
    await assert.rejects(runtime.request('settings.update', { [key]: 1 }), /unknown property/);
  }
  const { runId } = await runtime.request('chat.send', { chatId: setup.chat.id, text: latest });
  const state = await finish(runtime, runId);
  assert.equal(state.runs[0].status, 'completed', state.runs[0].error); assert.equal(requests.length, 2);
  const sentHistory = [...history, { role: 'user', content: latest }];
  const expected = kind === 'openai-responses' ? responsesInput(sentHistory, configuration) : providerMessages(sentHistory, kind);
  const first = kind === 'openai-responses' ? requests[0].input : requests[0].messages;
  assert.deepEqual(first.slice(1), expected);
  const wireTool = requests[0].tools.find(item => (item.function?.name || item.name) === tool.name);
  assert.equal((wireTool.function || wireTool).description, tool.description);
  assert.deepEqual((wireTool.function || wireTool).parameters, tool.parameters);
  const second = kind === 'openai-responses' ? requests[1].input : requests[1].messages;
  assert.deepEqual(second.slice(0, first.length), first);
  if (kind === 'openai-responses') {
    assert.deepEqual(second.slice(first.length), [opaque, functionCall, { type: 'function_call_output', call_id: 'latest-call', output: JSON.stringify(result) }]);
  } else {
    const callArgs = second.at(-2).tool_calls[0].function.arguments;
    assert.deepEqual(typeof callArgs === 'string' ? JSON.parse(callArgs) : callArgs, args);
    assert.equal(second.at(-1).content, JSON.stringify(result));
  }
  const disk = JSON.parse(await readFile(statePath, 'utf8'));
  for (const key of ['contextChars', 'contextMessages', 'maxTurns']) assert.equal(Object.hasOwn(disk.settings, key), false);
});

test('more than 100 tool turns complete; Stop still cancels a continuing tool loop', async t => {
  let turns = 0, effects = 0, indefinite = false;
  const { runtime, chat } = await fixture(t, async function* () {
    if (++turns <= 105 || indefinite) yield { type: 'tool', id: `iteration-${turns}`, name: 'fixture_step', args: {} };
    else yield { type: 'delta', text: 'completed after 105 tool turns' };
  });
  runtime.registerTools([{ name: 'fixture_step', description: 'Test-only counter', permission: 'read', parameters: empty, execute: () => ++effects }]);
  const first = await runtime.request('chat.send', { chatId: chat.id, text: 'finish after 105 tools' });
  const completed = await finish(runtime, first.runId);
  assert.equal(completed.runs[0].status, 'completed', completed.runs[0].error);
  assert.equal(turns, 106); assert.equal(effects, 105);
  indefinite = true;
  const second = await runtime.request('chat.send', { chatId: chat.id, text: 'continue until stopped' });
  await until(runtime, state => state.runs.find(run => run.id === second.runId).toolEvents.length >= 5);
  await runtime.request('chat.stop', { chatId: chat.id });
  const stopped = await finish(runtime, second.runId);
  assert.equal(stopped.runs.find(run => run.id === second.runId).status, 'canceled');
  const count = effects;
  await runtime.close();
  assert.equal(effects, count);
});
