import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../core/runtime.mjs';
import { streamProvider, testProvider, providerBody } from '../core/provider.mjs';
import { responsesInput, responseEvents } from '../core/responses.mjs';
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

const textDelta = (output_index, content_index, item_id, delta, type = 'response.output_text.delta') => ({ type, output_index, content_index, item_id, delta });
const visibleText = events => events.reduce((text, event) => event.type === 'text' ? event.text : event.type === 'delta' ? text + event.text : text, '');

test('Responses tracks interleaved output items and content parts and preserves phases for replay', async () => {
  const commentary = { ...message('Checking '), id: 'msg_commentary', phase: 'commentary' };
  commentary.content.push({ type: 'output_text', text: 'files.\n', annotations: [] });
  const final = { ...message('Done.'), id: 'msg_final', phase: 'final_answer' };
  const output = [commentary, final, call('after_text', 'project_list', {})];
  const events = await collect(async () => response([
    textDelta(0, 1, commentary.id, 'files.\n'), textDelta(1, 0, final.id, 'Done.'),
    textDelta(0, 0, commentary.id, 'Check'), textDelta(0, 0, commentary.id, 'ing '), completed(output),
  ]));
  assert.equal(visibleText(events), 'Checking files.\nDone.');
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.text), ['Checkfiles.\nDone.', 'Checking files.\nDone.']);
  const saved = events.find(event => event.type === 'provider_output').data;
  assert.deepEqual(saved.items, output);
  assert.deepEqual(responsesInput([{ role: 'assistant', content: visibleText(events), providerOutput: saved }], configuration), output);
  assert.ok(events.findIndex(event => event.type === 'tool') > events.findIndex(event => event.type === 'provider_output'));
});

test('Responses reconciles validated completed text including revisions, prefixes and legacy deltas', async t => {
  const first = text => ({ ...message(text), id: 'first', phase: 'commentary' });
  const last = text => ({ ...message(text), id: 'last', phase: 'final_answer' });
  for (const [name, frames, output, expected, replacement] of [
    ['terminal suffix', [textDelta(0, 0, 'last', 'Ans')], [last('Answer')], 'Answer', false],
    ['same-part revision', [textDelta(0, 0, 'last', 'Draft')], [last('Final')], 'Final', true],
    ['terminal is shorter', [textDelta(0, 0, 'last', 'Answer with extra text')], [last('Answer')], 'Answer', true],
    ['missing earlier suffix', [textDelta(0, 0, 'first', 'Check'), textDelta(1, 0, 'last', 'Answer')], [first('Checking '), last('Answer')], 'Checking Answer', true],
    ['terminal only contains final', [textDelta(0, 0, 'first', 'Checking '), textDelta(1, 0, 'last', 'Answer')], [last('Answer')], 'Answer', true],
    ['legacy revision', [{ type: 'response.output_text.delta', delta: 'Draft' }], [last('Final')], 'Final', true],
    ['mixed indexed and legacy', [textDelta(0, 0, 'last', 'An'), { type: 'response.output_text.delta', delta: 'swer' }], [last('Answer')], 'Answer', false],
    ['terminal only', [], [last('Answer')], 'Answer', false],
    ['refusal', [textDelta(0, 0, 'last', 'Cannot', 'response.refusal.delta')], [{ ...last(''), content: [{ type: 'refusal', refusal: 'Cannot help.' }] }], 'Cannot help.', false],
  ]) await t.test(name, async () => {
    const events = await collect(async () => response([...frames, completed(output)]));
    assert.equal(visibleText(events), expected);
    assert.equal(events.some(event => event.type === 'text'), replacement);
    assert.deepEqual(events.find(event => event.type === 'provider_output').data.items, output);
  });
});

test('Responses malformed terminal text and invalid stream identities never release tools', async t => {
  const valid = call('must_not_execute', 'project_list', {});
  const invalidMessage = content => ({ ...message(''), content });
  for (const [name, frames] of [
    ['non-string text', [completed([valid, invalidMessage([{ type: 'output_text', text: 7 }])])]],
    ['missing refusal', [completed([valid, invalidMessage([{ type: 'refusal' }])])]],
    ['unknown content', [completed([valid, invalidMessage([{ type: 'input_text', text: 'wrong' }])])]],
    ['unfinished message', [completed([valid, { ...message('wrong'), status: 'in_progress' }])]],
    ['invalid index', [textDelta(-1, 0, 'first', 'wrong'), completed([valid])]],
    ['changed item ID', [textDelta(0, 0, 'first', 'one'), textDelta(0, 1, 'different', 'two'), completed([valid])]],
    ['changed part type', [textDelta(0, 0, 'first', 'one'), textDelta(0, 0, 'first', 'two', 'response.refusal.delta'), completed([valid])]],
  ]) await t.test(name, async () => {
    const events = [];
    await assert.rejects(async () => { for await (const event of responseEvents(frames, configuration)) events.push(event); });
    assert.equal(events.some(event => event.type === 'tool' || event.type === 'provider_output'), false);
  });
});

test('Responses progress exposes supplied public summaries and never hidden reasoning', async () => {
  const tool = call('tool', 'project_list', {});
  const events = await collect(async () => response([
    { type: 'response.output_item.added', item: reasoning, output_index: 0 },
    { type: 'response.reasoning_text.delta', delta: 'hidden reasoning must not appear', output_index: 0 },
    { type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, summary_index: 0, delta: 'Checking' },
    { type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, summary_index: 0, delta: ' files.' },
    { type: 'response.reasoning_summary_text.done', item_id: reasoning.id, summary_index: 0, text: 'Checking files.' },
    { type: 'response.output_item.added', item: tool, output_index: 1 },
    { type: 'response.function_call_arguments.delta', delta: '{}', output_index: 1 },
    { type: 'response.output_item.added', item: message(''), output_index: 2 },
    textDelta(2, 0, 'msg_fixture', 'Done.'), completed([reasoning, tool, message('Done.')]),
  ]));
  assert.deepEqual(events.filter(event => event.type === 'progress'), [
    { type: 'progress', phase: 'thinking' },
    { type: 'progress', phase: 'thinking', summary: 'Checking' },
    { type: 'progress', phase: 'thinking', summary: 'Checking files.' },
    { type: 'progress', phase: 'preparing_tools' },
    { type: 'progress', phase: 'responding' },
  ]);
  assert.equal(visibleText(events), 'Done.');
  const bounded = await collect(async () => response([{ type: 'response.reasoning_summary_text.delta', delta: 'x'.repeat(2100) }, completed([message('Done')])]));
  assert.equal(bounded.find(event => event.type === 'progress').summary.length, 2000);
});

test('Responses cancellation between progress, reconciliation and terminal calls prevents tool release', async t => {
  for (const stopAt of ['progress', 'text', 'provider_output']) await t.test(stopAt, async () => {
    const controller = new AbortController(), events = [];
    const frames = [textDelta(0, 0, 'msg_fixture', 'Draft'), completed([message('Final'), call('cancelled', 'project_list', {})])];
    await assert.rejects(async () => {
      for await (const event of responseEvents(frames, configuration, controller.signal)) {
        events.push(event);
        if (event.type === stopAt) controller.abort(new Error('Fixture canceled'));
      }
    }, /Fixture canceled/);
    assert.equal(events.some(event => event.type === 'tool'), false);
    if (stopAt === 'progress') assert.equal(events.some(event => event.type === 'delta' || event.type === 'text'), false);
  });
});

test('only internal compaction requests add output budgets and preserve local context options', () => {
  for (const kind of ['openai-responses', 'openai', 'ollama']) {
    const provider = { ...configuration, kind, chatOptions: { contextTokens: 32000, thinking: false } };
    const body = extra => providerBody({ provider: { ...provider, ...extra }, messages: [{ role: 'user', content: 'summary fixture' }], tools: [] });
    for (const compactionTokens of [undefined, 0, -1, 1.5]) {
      const ordinary = body({ compactionTokens });
      assert.equal(ordinary.max_output_tokens, undefined); assert.equal(ordinary.max_tokens, undefined); assert.equal(ordinary.options?.num_predict, undefined);
      if (kind === 'ollama') assert.equal(ordinary.options.num_ctx, 32000);
    }
    const summary = body({ compactionTokens: 2048 });
    if (kind === 'openai-responses') assert.equal(summary.max_output_tokens, 2048);
    else if (kind === 'openai') assert.equal(summary.max_tokens, 2048);
    else assert.deepEqual(summary.options, { num_ctx: 32000, num_predict: 2048 });
  }
});

test('indexed completed text parts correct visible output before response completion', async t => {
  for (const kind of ['output_text', 'refusal']) await t.test(kind, async () => {
    const controller = new AbortController(), events = [];
    const key = kind === 'output_text' ? 'text' : 'refusal';
    async function* frames() {
      yield textDelta(0, 0, 'msg_fixture', 'Draft', `response.${kind}.delta`);
      yield { type: `response.${kind}.done`, output_index: 0, content_index: 0, item_id: 'msg_fixture', [key]: 'Canonical answer.' };
      assert.equal(visibleText(events), 'Canonical answer.');
      assert.equal(events.some(event => event.type === 'provider_output' || event.type === 'tool'), false);
      yield completed([{ ...message(''), content: [{ type: kind, [key]: 'Canonical answer.' }] }]);
    }
    for await (const event of responseEvents(frames(), configuration, controller.signal)) events.push(event);
    assert.deepEqual(events.filter(event => event.type === 'text'), [{ type: 'text', text: 'Canonical answer.' }]);
  });
});

test('all provider protocols reject explicitly truncated compaction responses', async t => {
  for (const kind of ['openai-responses', 'openai', 'ollama']) await t.test(kind, async () => {
    const frames = kind === 'openai-responses'
      ? response([{ type: 'response.output_text.delta', delta: 'Partial summary' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }])
      : kind === 'openai'
        ? response([{ choices: [{ delta: { content: 'Partial summary' }, finish_reason: 'length' }] }])
        : new Response(JSON.stringify({ message: { content: 'Partial summary' }, done: true, done_reason: 'length' }) + '\n');
    await assert.rejects(collect(async () => frames, { provider: { ...configuration, kind, compactionTokens: 2048 } }), /token limit|max_output_tokens/);
  });
});

test('runtime keeps completed output item snapshots omitted by an empty terminal output', async t => {
  const answer = message('FABER_LUNA_OK');
  const { runtime, chat } = await fixture(t, async () => response([
    textDelta(0, 0, answer.id, 'FABER_LUNA_OK'),
    { type: 'response.output_item.done', output_index: 0, item: answer },
    { ...completed([]), response: { ...completed([]).response, usage: { input_tokens: 5128, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]));
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Synthetic exact-answer diagnostic' });
  const state = await finish(runtime, runId), run = state.runs.find(item => item.id === runId), saved = state.chats.find(item => item.id === chat.id).messages.at(-1);
  assert.equal(run.status, 'completed', run.error); assert.equal(saved.content, 'FABER_LUNA_OK');
  assert.deepEqual(saved.providerOutput.items, [answer]); assert.equal(run.toolEvents.length, 0);
  assert.deepEqual(run.modelCalls[0].usage, { inputTokens: 5128, outputTokens: 9, reasoningTokens: 0 });
});

test('empty terminal output replays completed snapshots in output order and dispatches each completed tool once', async () => {
  const first = { ...message('Checking.\n'), id: 'msg_first' }, last = { ...message('Cannot continue.'), id: 'msg_last', content: [{ type: 'refusal', refusal: 'Cannot continue.' }] };
  const output = [reasoning, first, call('done_only', 'project_list', {}), last];
  const events = await collect(async () => response([
    ...[3, 1, 2, 0, 2].map(output_index => ({ type: 'response.output_item.done', output_index, item: output[output_index] })), completed([]),
  ]));
  assert.equal(visibleText(events), 'Checking.\nCannot continue.');
  assert.deepEqual(events.find(event => event.type === 'provider_output').data.items, output);
  assert.equal(events.filter(event => event.type === 'tool').length, 1);
  assert.ok(events.findIndex(event => event.type === 'tool') > events.findIndex(event => event.type === 'provider_output'));
});

test('nonempty terminal lists keep revisions without reviving stale completed tools', async t => {
  for (const text of ['Revised final.', '']) await t.test(text || 'explicit empty fails without erasing partial', async () => {
    const output = [message(text)], events = [];
    const frames = [
      textDelta(0, 0, 'msg_fixture', 'Old draft.'),
      { type: 'response.output_item.done', output_index: 0, item: message('Old draft.') },
      { type: 'response.output_item.done', output_index: 1, item: call('stale', 'project_list', {}) },
      { type: 'response.output_item.done', output_index: 2, item: { ...call('unfinished', 'project_list', {}), status: 'in_progress' } },
      completed(output),
    ];
    const read = async () => { for await (const event of responseEvents(frames, configuration)) events.push(event); };
    if (text) await read(); else await assert.rejects(read(), /terminal items: 1; completed snapshots: 2/);
    assert.equal(visibleText(events), text || 'Old draft.'); assert.equal(events.some(event => event.type === 'tool'), false);
    if (text) assert.deepEqual(events.find(event => event.type === 'provider_output').data.items, output);
    else assert.equal(events.some(event => event.type === 'provider_output'), false);
  });
});

test('blank completed responses preserve streamed partial text as failed with bounded output counts', async t => {
  for (const [name, output, correction] of [['empty terminal', []], ['explicit empty message', [message('')]], ['reasoning only', [reasoning]], ['empty done correction', [], true]]) await t.test(name, async t => {
    const { runtime, chat } = await fixture(t, async () => response([
      textDelta(0, 0, 'msg_fixture', 'Partial answer.'),
      ...(correction ? [{ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'msg_fixture', text: '' }] : []), completed(output),
    ]));
    const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Synthetic partial diagnostic' });
    const state = await finish(runtime, runId), run = state.runs.find(item => item.id === runId), saved = state.chats.find(item => item.id === chat.id).messages.at(-1);
    assert.equal(run.status, 'failed'); assert.match(run.error, new RegExp(`omitted completed visible output \\(terminal items: ${output.length}; completed snapshots: 0\\)`));
    assert.equal(saved.content, 'Partial answer.'); assert.equal(saved.status, 'failed'); assert.equal(saved.providerOutput, undefined);
    assert.equal(run.toolEvents.length, 0);
  });
});

test('completed snapshot fallback rejects invalid identities, malformed content and foreign tool namespaces before release', async t => {
  const provider = { ...configuration, authKind: 'chatgpt' }, valid = { ...call('valid', 'project_list', {}), namespace: 'faber' };
  const done = (item, output_index = 0) => ({ type: 'response.output_item.done', output_index, item });
  for (const [name, frames] of [
    ['unfinished snapshot', [textDelta(0, 0, 'msg_fixture', 'Partial'), done({ ...message('wrong'), status: 'in_progress' }), completed([])]],
    ['missing completed status', [textDelta(0, 0, 'msg_fixture', 'Partial'), done({ ...message('wrong'), status: undefined }), completed([])]],
    ['mixed completed and unfinished tools', [done(valid), done({ ...call('unfinished', 'project_list', {}), namespace: 'faber', status: 'in_progress' }, 1), completed([])]],
    ['mixed completed and missing-status tools', [done(valid), done({ ...call('unfinished', 'project_list', {}), namespace: 'faber', status: undefined }, 1), completed([])]],
    ['mixed completed message and unfinished tool', [done(message('Answer')), done({ ...valid, status: 'in_progress' }, 1), completed([])]],
    ['malformed content', [done({ ...message(''), content: [{ type: 'output_text', text: 7 }] }), completed([])]],
    ['changed index identity', [textDelta(0, 0, 'different', 'Partial'), done(message('wrong')), completed([])]],
    ['duplicate snapshot ID', [done(message('one')), done(message('two'), 1), completed([])]],
    ['foreign namespace', [done({ ...valid, namespace: 'other' }), completed([])]],
    ['malformed arguments', [done({ ...valid, arguments: '{bad}' }), completed([])]],
    ['incomplete terminal', [done(valid), { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]],
    ['missing terminal', [done(valid)]],
  ]) await t.test(name, async () => {
    const events = [];
    await assert.rejects(async () => { for await (const event of responseEvents(frames, provider)) events.push(event); });
    assert.equal(events.some(event => event.type === 'tool' || event.type === 'provider_output'), false);
  });
});

test('cancellation during completed snapshot fallback prevents tool release', async t => {
  for (const stopAt of ['text', 'provider_output']) await t.test(stopAt, async () => {
    const controller = new AbortController(), events = [];
    const frames = [textDelta(0, 0, 'msg_fixture', 'Draft'), { type: 'response.output_item.done', output_index: 0, item: message('Final') }, { type: 'response.output_item.done', output_index: 1, item: call('cancel_fallback', 'project_list', {}) }, completed([])];
    await assert.rejects(async () => {
      for await (const event of responseEvents(frames, configuration, controller.signal)) {
        events.push(event); if (event.type === stopAt) controller.abort(new Error('Fixture canceled'));
      }
    }, /Fixture canceled/);
    assert.equal(events.some(event => event.type === 'tool'), false);
  });
});
