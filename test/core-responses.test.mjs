import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../core/runtime.mjs';
import { streamProvider, testProvider } from '../core/provider.mjs';
import { responsesInput } from '../core/responses.mjs';
import { fileTools } from '../tools/files.mjs';
import { createUpgrades, upgradeTools } from '../desktop/upgrades.mjs';

const configuration = { id: 'cloud-fixture', name: 'Explicit protocol fixture', kind: 'openai-responses', baseUrl: 'https://provider.example/v1', model: 'gpt-6-astra', reasoningEffort: 'medium', hasKey: true };
const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-test-continuation' };
const call = (id, name, args) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
const message = text => ({ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const completed = output => ({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output } });
function response(frames) {
  const encoded = new TextEncoder().encode(frames.map(frame => `event: ${frame.type}\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < encoded.length; index += 11) controller.enqueue(encoded.slice(index, index + 11)); controller.close(); } }));
}
async function collect(fetchImpl, options = {}) {
  const events = [];
  for await (const event of streamProvider({ provider: configuration, messages: [{ role: 'user', content: 'test' }], tools: [], host: { getSecret: () => 'fake-key' }, fetchImpl, ...options })) events.push(event);
  return events;
}
async function fixture(t, fetchImpl, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faber-responses-test-'));
  const sourceDir = path.join(root, 'source'), dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(sourceDir, 'core'), { recursive: true }); await fs.mkdir(path.join(sourceDir, 'test'));
  await fs.writeFile(path.join(sourceDir, 'core/value.mjs'), 'export const value=1;');
  await fs.writeFile(path.join(sourceDir, 'test/value.test.mjs'), 'import assert from "node:assert/strict"; assert.ok(true);');
  const secrets = new Map();
  const host = { getSecret: id => secrets.get(id), setSecret: (id, value) => secrets.set(id, value), ...overrides };
  const options = { sourceDir, dataDir, host, provider: args => streamProvider({ ...args, fetchImpl }) };
  const runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const saved = await runtime.request('provider.save', { id: configuration.id, name: configuration.name, kind: configuration.kind, baseUrl: configuration.baseUrl, model: configuration.model, reasoningEffort: 'medium', apiKey: 'fake-key' });
  const project = await runtime.request('project.create', { name: 'Protocol fixture', path: sourceDir });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  await runtime.request('chat.update', { id: chat.id, providerId: saved.id });
  return { runtime, chat, options, root, secrets };
}
async function until(runtime, predicate) {
  for (let count = 0; count < 300; count++) { const state = await runtime.request('state.get'); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Runtime fixture timed out');
}
const finish = (runtime, runId) => until(runtime, state => state.runs.some(run => run.id === runId && !['running', 'waiting_approval'].includes(run.status)));

test('Responses streaming uses flat non-strict functions, reasoning, complete terminal items and one dispatch per call', async () => {
  let request;
  const functionCall = call('call_one', 'project_list', {});
  const events = await collect(async (url, options) => {
    request = { url, ...options };
    return response([{ type: 'response.output_item.added', item: { ...functionCall, arguments: '' }, output_index: 1 }, { type: 'response.function_call_arguments.delta', delta: '{', output_index: 1 }, { type: 'response.function_call_arguments.done', arguments: '{}', output_index: 1 }, { type: 'response.output_item.done', item: functionCall, output_index: 1 }, { type: 'response.output_text.delta', delta: '你好' }, completed([reasoning, functionCall, message('你好')])]);
  }, { tools: [{ name: 'project_list', description: 'List projects', parameters: { type: 'object', properties: {}, additionalProperties: false } }] });
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'https://provider.example/v1/responses'); assert.equal(request.redirect, 'error'); assert.equal(body.store, false); assert.equal(body.reasoning.effort, 'medium');
  assert.equal(body.tools[0].strict, false); assert.equal(body.tools[0].name, 'project_list'); assert.equal(body.tools[0].function, undefined);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']); assert.equal(events.filter(event => event.type === 'tool').length, 1);
  assert.equal(events.find(event => event.type === 'provider_output').data.items[0].encrypted_content, reasoning.encrypted_content);
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['你好']);
});

test('failed, incomplete, truncated, duplicate and malformed calls never dispatch a tool', async () => {
  const valid = call('call_one', 'effect', {});
  for (const frames of [
    [{ type: 'response.output_item.done', item: valid }, { type: 'response.failed', response: { error: { message: 'synthetic failure' } } }],
    [{ type: 'response.output_item.done', item: valid }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }],
    [{ type: 'response.output_item.done', item: valid }],
    [completed([valid, valid])], [completed([{ ...valid, arguments: '{bad}' }])],
  ]) {
    const events = [];
    await assert.rejects(async () => { for await (const event of streamProvider({ provider: configuration, messages: [], tools: [], host: { getSecret: () => 'fake-key' }, fetchImpl: async () => response(frames) })) events.push(event); });
    assert.equal(events.some(event => event.type === 'tool' || event.type === 'provider_output'), false);
  }
});

test('exact output replay retains opaque reasoning, function IDs and image inputs only for matching connection', () => {
  const output = [reasoning, call('call_one', 'desktop_screenshot', {})];
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'call_one', name: 'desktop_screenshot', args: {} }], providerOutput: { kind: 'openai-responses', providerId: configuration.id, baseUrl: configuration.baseUrl, model: configuration.model, items: output } }, { role: 'tool', toolName: 'desktop_screenshot', toolCallId: 'call_one', content: '{"ok":true}', image: 'data:image/png;base64,YQ==' }];
  const input = responsesInput(messages, configuration);
  assert.deepEqual(input.slice(0, 2), output); assert.equal(input[2].type, 'function_call_output'); assert.equal(input[2].call_id, 'call_one'); assert.equal(input[3].content[1].type, 'input_image');
  for (const other of [{ ...configuration, id: 'other' }, { ...configuration, baseUrl: 'https://other.example/v1' }, { ...configuration, model: 'gpt-6.1-sol' }]) assert.ok(!JSON.stringify(responsesInput(messages, other)).includes(reasoning.encrypted_content));
});

test('real runtime Responses loop executes shared file and staged upgrade tools only after approval', async t => {
  const requests = [];
  const output = [reasoning, call('read', 'files_read', { path: 'core/value.mjs' }), call('stage', 'upgrade_stage', { changes: [{ path: 'core/value.mjs', content: 'export const value=2;' }] })];
  const { runtime, chat, options } = await fixture(t, async (_url, options) => { requests.push(JSON.parse(options.body)); return response([completed(requests.length === 1 ? output : [message('Staged only; original source unchanged.')])]); });
  runtime.registerTools([...fileTools(), ...upgradeTools(createUpgrades({ sourceDir: options.sourceDir, dataDir: options.dataDir, confirm: async () => false }))]);
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Inspect and stage the fixture change.' });
  const waiting = await until(runtime, state => state.approvals.length === 1);
  assert.equal(waiting.approvals[0].permission, 'upgrade'); assert.deepEqual(waiting.chats[0].grants, []);
  assert.equal(await fs.readFile(path.join(options.sourceDir, 'core/value.mjs'), 'utf8'), 'export const value=1;');
  await runtime.request('approval.resolve', { id: waiting.approvals[0].id, allow: true });
  const state = await finish(runtime, runId); assert.equal(state.runs[0].status, 'completed', state.runs[0].error);
  assert.deepEqual(state.runs[0].toolEvents.map(event => [event.name, event.status]), [['files_read', 'completed'], ['upgrade_stage', 'completed']]);
  assert.deepEqual(requests[1].input.filter(item => ['reasoning', 'function_call'].includes(item.type)), output);
  assert.deepEqual(requests[1].input.filter(item => item.type === 'function_call_output').map(item => item.call_id), ['read', 'stage']);
  assert.equal(await fs.readFile(path.join(options.sourceDir, 'core/value.mjs'), 'utf8'), 'export const value=1;');
  const saved = JSON.parse(await fs.readFile(path.join(options.dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.chats[0].messages.find(item => item.providerOutput).providerOutput.items[0].encrypted_content, reasoning.encrypted_content);
  assert.ok(!JSON.stringify(saved).includes('fake-key'));
});

test('runtime refuses repeated historical call IDs even with large opaque context', async t => {
  for (const oversized of [false, true]) await t.test(String(oversized), async t => {
    let effects = 0, requests = 0;
    const opaque = { ...reasoning, encrypted_content: oversized ? 'x'.repeat(50000) : reasoning.encrypted_content };
    const { runtime, chat } = await fixture(t, async () => { requests++; return response([completed([opaque, call('effect', 'synthetic_effect', {})])]); });
    runtime.registerTools([{ name: 'synthetic_effect', description: 'Test-only read effect counter', permission: 'read', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => ++effects }]);
    const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'test' });
    const state = await finish(runtime, runId); assert.equal(state.runs[0].status, 'failed'); assert.equal(effects, 1);
    assert.equal(requests, 2); assert.match(state.runs[0].error, /previously dispatched/);
    assert.equal(state.chats[0].messages.find(item => item.providerOutput).providerOutput.items[0].encrypted_content, opaque.encrypted_content);
  });
});

test('connection credentials cannot move origin silently or change while a captured run is active', async t => {
  const { runtime, chat, secrets } = await fixture(t, async () => new Response(new ReadableStream({ start() {} })));
  const save = { id: configuration.id, name: 'Edited', kind: 'openai-responses', baseUrl: 'https://other.example/v1', model: 'gpt-6.1-sol' };
  await assert.rejects(runtime.request('provider.save', save), /explicitly replace or remove/);
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'wait' });
  await runtime.request('chat.update', { id: chat.id, providerId: 'local-ollama' });
  await assert.rejects(runtime.request('provider.save', { ...save, apiKey: 'replacement' }), /in use/);
  assert.equal(secrets.get(configuration.id), 'fake-key');
  await runtime.request('chat.stop', { chatId: chat.id }); await finish(runtime, runId); await runtime.close();
});

test('saved effort preserves or clears explicitly; listings and errors do not perform inference or expose keys', async t => {
  const { runtime } = await fixture(t, async () => response([completed([message('unused')])]));
  const base = { id: configuration.id, name: configuration.name, kind: configuration.kind, baseUrl: configuration.baseUrl, model: configuration.model };
  assert.equal((await runtime.request('provider.save', base)).reasoningEffort, 'medium');
  assert.equal((await runtime.request('provider.save', { ...base, reasoningEffort: '' })).reasoningEffort, undefined);
  await assert.rejects(runtime.request('provider.save', { ...base, reasoningEffort: 'unsupported' }), /enum/);
  const result = await testProvider(configuration, { getSecret: () => 'fake-key' }, async (url, options) => { assert.ok(url.endsWith('/models')); assert.equal(options.method, undefined); return Response.json({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] }); });
  assert.deepEqual(result, { ok: true, models: ['gpt-6-astra', 'gpt-6.1-sol'] });
  await assert.rejects(collect(async () => Response.json({ error: { message: 'Invalid fake-key' } }, { status: 401 })), error => error.message.includes('[redacted]') && !error.message.includes('fake-key'));
});

test('large ordinary tool text and opaque response items replay exactly', async t => {
  const requests = [];
  const output = [{ ...reasoning, encrypted_content: 'opaque'.repeat(10000) }, call('read_long', 'files_read', { path: 'core/value.mjs' })];
  const { runtime, chat, options } = await fixture(t, async (_url, options) => { requests.push(JSON.parse(options.body)); return response([completed(requests.length === 1 ? output : [message('Read the full file content.')])]); });
  runtime.registerTools(fileTools());
  await fs.writeFile(path.join(options.sourceDir, 'core/value.mjs'), '// long source fixture\n'.repeat(2000));
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Read the source file.' });
  const state = await finish(runtime, runId);
  assert.equal(state.runs[0].status, 'completed', state.runs[0].error); assert.equal(requests.length, 2);
  const returned = requests[1].input.find(item => item.type === 'function_call_output');
  assert.equal(returned.output, state.chats[0].messages.find(item => item.role === 'tool').content);
  assert.equal(JSON.parse(returned.output).text, '// long source fixture\n'.repeat(2000));
  assert.deepEqual(requests[1].input.filter(item => ['reasoning', 'function_call'].includes(item.type)), output);
  assert.ok(state.chats[0].messages.find(item => item.role === 'tool').content.length > 38000);
});
