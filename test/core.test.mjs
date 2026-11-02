import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../core/runtime.mjs';
import { validate, checkTool } from '../core/registry.mjs';
import { streamProvider, providerMessages, testProvider, validateCredentialTransport } from '../core/provider.mjs';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const fakeTool = (name, permission, execute) => ({ name, permission, execute, description: 'Test-only fake tool', parameters: structuredClone(empty) });
async function fixture(t, provider, host = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sophia-core-test-'));
  const options = { dataDir: join(directory, 'data'), sourceDir: join(directory, 'source'), provider, host };
  const runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const project = await runtime.request('project.create', { name: 'Test project', path: options.sourceDir });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  return { runtime, chat, project, options };
}
async function until(runtime, predicate, timeout = 3000) {
  const initial = await runtime.request('state.get');
  if (predicate(initial)) return initial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Test state wait timed out')); }, timeout);
    const unsubscribe = runtime.subscribe(event => { if (event.type === 'state' && predicate(event.state)) { clearTimeout(timer); unsubscribe(); resolve(event.state); } });
  });
}
async function complete(runtime, runId) { return until(runtime, state => state.runs.some(run => run.id === runId && ['completed', 'failed', 'canceled'].includes(run.status))); }

test('synchronous model availability guard rejects loading/stopping before mutation but permits tools and ready chats', async t => {
  let phase = 'stopped'; const checked = [];
  const { runtime, chat } = await fixture(t, async function* () { yield { type: 'delta', text: 'ready' }; }, { assertProviderAvailable: (id, model) => {
    checked.push({ id, model }); if (phase !== 'ready') throw new Error(`Local model is ${phase}; start it first`);
  } });
  await runtime.request('chat.update', { id: chat.id, model: 'selected-model' });
  const before = await runtime.request('state.get');
  for (phase of ['stopped', 'loading', 'stopping']) {
    await assert.rejects(runtime.request('chat.send', { chatId: chat.id, text: 'must not append' }), /start it first/);
    assert.deepEqual(await runtime.request('state.get'), before);
  }
  assert.deepEqual(checked, Array(3).fill({ id: 'local-ollama', model: 'selected-model' }));
  assert.ok(Array.isArray(await runtime.request('tool.run', { chatId: chat.id, name: 'project_list', args: {} })));
  assert.equal(checked.length, 3);
  phase = 'ready';
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'now ready' });
  const state = await complete(runtime, runId);
  assert.equal(state.runs.find(run => run.id === runId).status, 'completed');
  assert.equal(state.runs.find(run => run.id === runId).model, 'selected-model');
  assert.equal(state.chats[0].messages[0].content, 'now ready');
});

test('registry validates nested args and registration rejects invalid definitions atomically', async t => {
  const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'integer', minimum: 1 } } }, additionalProperties: false };
  assert.throws(() => validate({ items: [0] }, schema), /range/);
  assert.throws(() => validate({ items: [1], extra: true }, schema), /unknown property/);
  for (const value of ['{"items":[1],"__proto__":{}}', '{"items":[1],"constructor":{}}', '{"items":[1],"toString":{}}']) assert.throws(() => validate(JSON.parse(value), schema), /unknown property/);
  assert.throws(() => checkTool({ ...fakeTool('bad-name', 'read', () => null) }), /name/);
  const { runtime } = await fixture(t);
  assert.throws(() => runtime.registerTools([fakeTool('first_tool', 'read', () => null), fakeTool('agent_list', 'read', () => null)]), /Duplicate/);
  assert.equal((await runtime.request('state.get')).tools.some(tool => tool.name === 'first_tool'), false);
  const mutable = fakeTool('cloned_schema', 'read', () => null); runtime.registerTools([mutable]); mutable.parameters.additionalProperties = true;
  await assert.rejects(runtime.request('tool.run', { chatId: 'missing', name: 'cloned_schema', args: { extra: true } }), /unknown property/);
  await assert.rejects(runtime.request('settings.update', { maxAgents: 999 }), /range/);
  await assert.rejects(runtime.request('chat.update', { id: 'missing', surprise: true }), /unknown property/);
});

test('fake provider invokes shared tools, persists results, and emits real deltas', async t => {
  let calls = 0;
  const { runtime, chat, options } = await fixture(t, async function* ({ messages, tools }) {
    assert.ok(tools.some(tool => tool.name === 'test_read'));
    if (!messages.some(message => message.role === 'tool')) yield { type: 'tool', id: 'call-1', name: 'test_read', args: {} };
    else { assert.match(messages.at(-1).content, /42/); yield { type: 'delta', text: 'Verified 42' }; }
  });
  runtime.registerTools([fakeTool('test_read', 'read', () => { calls++; return { value: 42 }; })]);
  const deltas = []; runtime.subscribe(event => { if (event.type === 'delta') deltas.push(event.text); });
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Read value' });
  const state = await complete(runtime, runId);
  assert.equal(state.runs[0].status, 'completed'); assert.equal(calls, 1); assert.deepEqual(deltas, ['Verified 42']);
  const disk = JSON.parse(await readFile(join(options.dataDir, 'state.json'), 'utf8'));
  assert.equal(disk.chats[0].messages.at(-1).content, 'Verified 42');
  assert.equal(disk.runs[0].toolEvents[0].status, 'completed');
});

test('privileged tool blocks before approval, denial prevents effect, remembered grant persists', async t => {
  const { runtime, chat } = await fixture(t);
  let effects = 0;
  runtime.registerTools([fakeTool('test_effect', 'shell', () => ++effects)]);
  const denied = runtime.request('tool.run', { chatId: chat.id, name: 'test_effect', args: {} });
  const rejected = assert.rejects(denied, /denied/);
  let state = await until(runtime, state => state.approvals.length === 1);
  assert.equal(effects, 0);
  await runtime.request('approval.resolve', { id: state.approvals[0].id, allow: false }); await rejected;
  const allowed = runtime.request('tool.run', { chatId: chat.id, name: 'test_effect', args: {} });
  state = await until(runtime, state => state.approvals.length === 1);
  await runtime.request('approval.resolve', { id: state.approvals[0].id, allow: true, remember: true });
  assert.equal(await allowed, 1);
  assert.equal(await runtime.request('tool.run', { chatId: chat.id, name: 'test_effect', args: {} }), 2);
  assert.deepEqual((await runtime.request('state.get')).chats[0].grants, ['shell']);
});

test('cancel parent cancels child and pending approval without executing side effect', async t => {
  const { runtime, chat } = await fixture(t, async function* ({ messages }) {
    if (messages.some(message => message.role === 'tool')) { await new Promise(() => {}); }
    else if (messages.at(-1).content === 'parent') yield { type: 'tool', id: 'spawn', name: 'agent_create', args: { task: 'child' } };
    else yield { type: 'tool', id: 'effect', name: 'child_effect', args: {} };
  });
  let effects = 0; runtime.registerTools([fakeTool('child_effect', 'files', () => ++effects)]);
  await runtime.request('chat.send', { chatId: chat.id, text: 'parent' });
  await until(runtime, state => state.approvals.length === 1 && state.runs.length === 2);
  await runtime.request('chat.stop', { chatId: chat.id });
  const state = await until(runtime, state => state.runs.every(run => run.status === 'canceled') && !state.approvals.length);
  assert.equal(state.runs.length, 2); assert.equal(effects, 0);
});

test('restart recovery marks in-flight effects interrupted and never replays them', async t => {
  const { runtime, options } = await fixture(t);
  await runtime.close();
  const path = join(options.dataDir, 'state.json'), state = JSON.parse(await readFile(path, 'utf8'));
  state.runs.push({ id: 'old', chatId: state.chats[0].id, status: 'waiting_approval', startedAt: new Date().toISOString(), toolEvents: [{ id: 'effect', name: 'shell', status: 'running' }] });
  state.approvals.push({ id: 'old-approval', runId: 'old' });
  state.chats[0].messages.push({ id: 'old-assistant', role: 'assistant', content: '', toolCalls: [{ id: 'unanswered', name: 'shell', args: {} }] });
  await writeFile(path, JSON.stringify(state));
  let called = false;
  const recovered = await createRuntime({ ...options, provider: async function* () { called = true; } });
  t.after(() => recovered.close());
  const snapshot = await recovered.request('state.get');
  assert.equal(snapshot.runs[0].status, 'interrupted'); assert.equal(snapshot.runs[0].toolEvents[0].status, 'interrupted');
  assert.deepEqual(snapshot.approvals, []); assert.equal(called, false);
  assert.equal(snapshot.chats[0].messages.at(-1).toolCallId, 'unanswered');
  assert.match(snapshot.chats[0].messages.at(-1).content, /do not replay automatically/);
  await recovered.close();
});

test('cross-chat tool delivery starts child run with reduced authority and persists message', async t => {
  let destination;
  const { runtime, chat, project } = await fixture(t, async function* ({ messages }) {
    if (messages.at(-1).content === 'send') yield { type: 'tool', id: 'send-call', name: 'agent_send', args: { chatId: destination.id, text: 'delivered' } };
    else yield { type: 'delta', text: 'done' };
  });
  destination = await runtime.request('chat.create', { projectId: project.id });
  await runtime.request('chat.update', { id: destination.id, grants: ['shell'] });
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'send' });
  await complete(runtime, runId);
  const state = await until(runtime, state => state.runs.length === 2 && state.runs.every(run => run.status === 'completed'));
  const child = state.runs.find(run => run.chatId === destination.id);
  assert.equal(child.parentRunId, runId); assert.deepEqual(child.grants, []);
  assert.equal(state.chats.find(item => item.id === destination.id).messages[0].content, 'delivered');
});

test('provider secrets stay in host and registry replacement removes stale tools', async t => {
  const secrets = new Map();
  const { runtime, options } = await fixture(t, undefined, { setSecret: (key, value) => secrets.set(key, value) });
  const saved = await runtime.request('provider.save', { name: 'Explicit test provider', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake', apiKey: 'TEST-SECRET-NEVER-PERSIST' });
  assert.equal(saved.hasKey, true); assert.equal(secrets.get(saved.id), 'TEST-SECRET-NEVER-PERSIST');
  assert.ok(!(await readFile(join(options.dataDir, 'state.json'), 'utf8')).includes('TEST-SECRET'));
  await runtime.replaceExtensionTools([fakeTool('extension_one', 'read', () => null)], [{ id: 'one' }]);
  await assert.rejects(runtime.replaceExtensionTools([fakeTool('agent_list', 'read', () => null)], []), /Duplicate/);
  assert.ok((await runtime.request('state.get')).tools.some(tool => tool.name === 'extension_one'));
  await runtime.replaceExtensionTools([], []);
  assert.ok(!(await runtime.request('state.get')).tools.some(tool => tool.name === 'extension_one'));
});

test('model cannot add workspace roots without files approval', async t => {
  const { runtime, chat, options } = await fixture(t);
  const action = runtime.request('tool.run', { chatId: chat.id, name: 'project_create', args: { name: 'Outside root', path: options.dataDir } });
  const rejection = assert.rejects(action, /denied/);
  const state = await until(runtime, state => state.approvals.length === 1);
  assert.equal(state.approvals[0].permission, 'files'); assert.equal(state.projects.length, 1);
  await runtime.request('approval.resolve', { id: state.approvals[0].id, allow: false }); await rejection;
  assert.equal((await runtime.request('state.get')).projects.length, 1);
});

test('busy agent inbox is durable and delivered after complete tool result group', async t => {
  let destination, release;
  const hold = new Promise(resolve => { release = resolve; });
  const seen = [];
  const { runtime, chat, project, options } = await fixture(t, async function* ({ messages }) {
    const last = messages.at(-1);
    if (last.content === 'target') yield { type: 'tool', id: 'held', name: 'test_hold', args: {} };
    else if (last.content === 'send') yield { type: 'tool', id: 'send', name: 'agent_send', args: { chatId: destination.id, text: 'inbound' } };
    else { seen.push(messages); yield { type: 'delta', text: 'done' }; }
  });
  runtime.registerTools([fakeTool('test_hold', 'read', () => hold)]);
  destination = await runtime.request('chat.create', { projectId: project.id });
  const target = await runtime.request('chat.send', { chatId: destination.id, text: 'target' });
  await until(runtime, state => state.runs.some(run => run.toolEvents.some(event => event.name === 'test_hold')));
  const sender = await runtime.request('chat.send', { chatId: chat.id, text: 'send' });
  await complete(runtime, sender.runId);
  const disk = JSON.parse(await readFile(join(options.dataDir, 'state.json'), 'utf8'));
  assert.equal(disk.chats.find(item => item.id === destination.id).inbox[0].text, 'inbound');
  release({ ok: true }); await complete(runtime, target.runId);
  const received = seen.find(messages => messages.at(-1).content === 'inbound');
  assert.ok(received); assert.equal(received.at(-2).role, 'tool'); assert.equal(received.at(-3).toolCalls[0].id, 'held');
});

test('agent depth limit reports tool failure without spawning recursively', async t => {
  const { runtime, chat } = await fixture(t, async function* ({ messages }) {
    if (messages.at(-1).role === 'tool') { assert.match(messages.at(-1).content, /depth limit/); yield { type: 'delta', text: 'limit reached' }; }
    else yield { type: 'tool', name: 'agent_create', args: { task: 'recurse' } };
  });
  await runtime.request('settings.update', { maxDepth: 0 });
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'start' });
  const state = await complete(runtime, runId);
  assert.equal(state.runs.length, 1); assert.equal(state.chats.length, 1); assert.equal(state.runs[0].toolEvents[0].status, 'failed');
});

test('run timeout cancels descendant pending approvals', async t => {
  const { runtime, chat } = await fixture(t, async function* ({ messages }) {
    if (messages.some(message => message.role === 'tool')) await new Promise(() => {});
    else if (messages.at(-1).content === 'parent') yield { type: 'tool', name: 'agent_create', args: { task: 'child' } };
    else yield { type: 'tool', name: 'child_timeout_effect', args: {} };
  });
  let effects = 0; runtime.registerTools([fakeTool('child_timeout_effect', 'files', () => ++effects)]);
  await runtime.request('settings.update', { runTimeoutMs: 1000 });
  await runtime.request('chat.send', { chatId: chat.id, text: 'parent' });
  await until(runtime, state => state.runs.length === 2 && state.approvals.length === 1);
  const state = await until(runtime, state => state.runs.every(run => run.status === 'canceled') && state.approvals.length === 0);
  assert.equal(effects, 0); assert.equal(state.runs.length, 2);
});

function streamResponse(text, status = 200) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7)); controller.close(); } }), { status });
}
test('OpenAI SSE adapter handles chunked UTF-8, split tool JSON, authorization and image context', async () => {
  const frames = [
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'test_read', arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '2}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  let request;
  const events = [];
  for await (const event of streamProvider({ provider: { kind: 'openai', baseUrl: 'http://localhost/v1', model: 'fake', id: 'p', hasKey: true }, messages: [{ role: 'tool', content: '{}', toolCallId: 'past', toolName: 'screen', image: 'data:image/png;base64,YQ==' }], tools: [], host: { getSecret: () => 'test-secret' }, fetchImpl: async (url, options) => { request = { url, ...options }; return streamResponse(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\n'); } })) events.push(event);
  assert.deepEqual(events, [{ type: 'delta', text: '你好' }, { type: 'tool', id: 'call1', name: 'test_read', args: { x: 2 } }]);
  assert.equal(request.headers.Authorization, 'Bearer test-secret');
  assert.equal(request.redirect, 'error');
  assert.equal(JSON.parse(request.body).messages.at(-1).content[1].image_url.url, 'data:image/png;base64,YQ==');
});

test('native Ollama adapter handles tools, images and NDJSON; errors never become success', async () => {
  const provider = { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'fake' };
  let request;
  const events = [];
  for await (const event of streamProvider({ provider, messages: [], tools: [], fetchImpl: async (url, options) => { request = { url, ...options }; return streamResponse(JSON.stringify({ message: { content: 'hello', tool_calls: [{ function: { name: 'test_read', arguments: {} } }] }, done: true }) + '\n'); } })) events.push(event);
  assert.equal(request.url, 'http://localhost:11434/api/chat'); assert.equal(JSON.parse(request.body).options, undefined);
  assert.equal(events[1].name, 'test_read');
  assert.deepEqual(providerMessages([{ role: 'tool', content: '{}', image: 'data:image/png;base64,YQ==' }], 'ollama').at(-1).images, ['YQ==']);
  for (const response of [() => streamResponse('{bad}\n'), () => streamResponse('{"message":{"content":"partial"}}\n'), () => streamResponse('{"error":"model missing"}\n'), () => streamResponse('', 500)]) {
    await assert.rejects(async () => { for await (const _ of streamProvider({ provider, messages: [], tools: [], fetchImpl: async () => response() })) {} });
  }
  const tested = await testProvider(provider, {}, async (url, options) => { assert.ok(url.endsWith('/api/tags')); assert.equal(options.redirect, 'error'); return new Response(JSON.stringify({ models: [{ name: 'installed-model' }] })); });
  assert.deepEqual(tested, { ok: true, models: ['installed-model'] });
});

test('vision messages follow all tool responses, preserving provider call ordering', () => {
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'screen', args: {} }, { id: 'b', name: 'read', args: {} }] }, { role: 'tool', content: '{}', toolCallId: 'a', image: 'data:image/png;base64,YQ==' }, { role: 'tool', content: '{}', toolCallId: 'b' }];
  for (const kind of ['openai', 'ollama']) assert.deepEqual(providerMessages(messages, kind).map(message => message.role), ['assistant', 'tool', 'tool', 'user']);
});

test('model configuration cannot grant authority; native voice requires approval', async t => {
  const calls = [];
  const { runtime, chat } = await fixture(t, undefined, { voice: (action, args) => { calls.push({ action, args }); return { available: true }; } });
  await assert.rejects(runtime.request('tool.run', { chatId: chat.id, name: 'chat_configure', args: { grants: ['shell'] } }), /unknown property/);
  await runtime.request('tool.run', { chatId: chat.id, name: 'chat_configure', args: { model: 'selected-local-model', voice: { phrase: 'Hello Sophia' } } });
  const state = await runtime.request('state.get'); assert.equal(state.chats[0].model, 'selected-local-model'); assert.deepEqual(state.chats[0].grants, []);
  assert.deepEqual(await runtime.request('tool.run', { chatId: chat.id, name: 'voice_status', args: {} }), { available: true });
  const pending = runtime.request('tool.run', { chatId: chat.id, name: 'voice_start', args: { mode: 'dictation' } });
  const approval = (await until(runtime, state => state.approvals.length === 1)).approvals[0];
  assert.equal(approval.permission, 'computer'); assert.equal(calls.length, 1);
  await runtime.request('approval.resolve', { id: approval.id, allow: true }); await pending;
  assert.equal(calls[1].action, 'start'); assert.equal(calls[1].args.chatId, chat.id);
});

test('large messages and shared tool schemas reach the provider without clipping', async t => {
  let received;
  const { runtime, chat } = await fixture(t, async function* (input) { received = input; yield { type: 'delta', text: 'bounded' }; });
  runtime.registerTools(Array.from({ length: 12 }, (_, index) => ({ ...fakeTool(`large_schema_${index}`, 'read', () => null), description: 'Test schema description '.repeat(65) })));
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Test long message '.repeat(2000) });
  const state = await complete(runtime, runId);
  assert.equal(state.runs[0].status, 'completed', state.runs[0].error);
  assert.ok(JSON.stringify(received.messages).length + JSON.stringify(received.tools).length > 36000);
  assert.deepEqual(received.tools, state.tools); assert.equal(received.messages.at(-1).content, 'Test long message '.repeat(2000));
});

test('large latest tool arguments survive exactly through the next provider turn', async t => {
  let requests = 0;
  const { runtime, chat } = await fixture(t, async function* ({ messages }) {
    if (++requests === 1) yield { type: 'tool', name: 'large_arguments', args: { text: 'x'.repeat(50000) } };
    else { assert.equal(messages.find(message => message.toolCalls).toolCalls[0].args.text, 'x'.repeat(50000)); yield { type: 'delta', text: 'done' }; }
  });
  runtime.registerTools([{ ...fakeTool('large_arguments', 'read', () => ({ ok: true })), parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }]);
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'test' });
  const state = await complete(runtime, runId);
  assert.equal(requests, 2); assert.equal(state.runs[0].status, 'completed', state.runs[0].error);
  assert.equal(state.chats[0].messages.find(message => message.toolCalls)?.toolCalls[0].args.text.length, 50000);
});

test('model context keeps only the latest screenshot payload and notes omitted images', async t => {
  let requests = 0, received;
  const { runtime, chat } = await fixture(t, async function* (input) {
    requests++;
    if (requests <= 2) yield { type: 'tool', name: 'test_screenshot', args: {} };
    else { received = input.messages; yield { type: 'delta', text: 'done' }; }
  });
  let screenshots = 0;
  runtime.registerTools([fakeTool('test_screenshot', 'read', () => ({ image: `data:image/png;base64,${++screenshots === 1 ? 'YQ==' : 'Yg=='}` }))]);
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'test images' });
  const state = await complete(runtime, runId);
  assert.equal(state.runs[0].status, 'completed', state.runs[0].error);
  assert.deepEqual(received.filter(message => message.image).map(message => message.image), ['data:image/png;base64,Yg==']);
  assert.ok(received.some(message => message.content.includes('Earlier image omitted')));
  assert.equal(state.chats[0].messages.filter(message => message.image).length, 2);
});

test('provider keys cannot be saved or used over non-loopback plaintext HTTP', async t => {
  for (const baseUrl of ['http://localhost:1234/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1', 'https://provider.example/v1']) assert.doesNotThrow(() => validateCredentialTransport(baseUrl, true));
  assert.doesNotThrow(() => validateCredentialTransport('http://192.168.1.2:1234/v1', false));
  let saved = false, fetched = false;
  const { runtime } = await fixture(t, undefined, { setSecret: () => { saved = true; } });
  await assert.rejects(runtime.request('provider.save', { name: 'Insecure remote', kind: 'openai', baseUrl: 'http://provider.example/v1', model: 'fake', apiKey: 'test-secret' }), /require HTTPS/);
  assert.equal(saved, false);
  const provider = { id: 'legacy', kind: 'openai', baseUrl: 'http://provider.example/v1', model: 'fake', hasKey: true };
  const fetchImpl = async () => { fetched = true; throw new Error('Must not fetch'); };
  await assert.rejects(async () => { for await (const _ of streamProvider({ provider, messages: [], tools: [], fetchImpl })) {} }, /require HTTPS/);
  const tested = await testProvider(provider, {}, fetchImpl); assert.equal(tested.ok, false); assert.match(tested.error, /require HTTPS/); assert.equal(fetched, false);
});
