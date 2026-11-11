import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../core/runtime.mjs';
import { streamProvider } from '../core/provider.mjs';
import { validateChatImages, imageBytesLimit } from '../core/images.mjs';
import { cleanUsage, providerUsage } from '../core/usage.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
const empty = { type: 'object', properties: {}, additionalProperties: false };
const sse = frames => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
const responseUsage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 5 } };
const expectedUsage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, reasoningTokens: 5 };
async function fixture(t, kind, fetchImpl, provider, host) {
  const root = await fs.mkdtemp(join(tmpdir(), 'faber-media-usage-test-'));
  const options = { sourceDir: join(root, 'source'), dataDir: join(root, 'data'), provider: provider || (args => streamProvider({ ...args, fetchImpl })), host };
  const runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const saved = await runtime.request('provider.save', { name: 'Protocol fixture', kind, baseUrl: 'http://localhost:1/v1', model: 'fixture' });
  const project = await runtime.request('project.create', { name: 'Fixture', path: options.sourceDir });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  await runtime.request('chat.update', { id: chat.id, providerId: saved.id });
  return { runtime, chat, options, saved };
}
async function until(runtime, predicate) {
  const state = await runtime.request('state.get'); if (predicate(state)) return state;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Fixture timeout')); }, 10000);
    const unsubscribe = runtime.subscribe(event => { if (event.type === 'state' && predicate(event.state)) { clearTimeout(timer); unsubscribe(); resolve(event.state); } });
  });
}
const finish = (runtime, id) => until(runtime, state => state.runs.some(run => run.id === id && !['running', 'waiting_approval'].includes(run.status)));

test('image input is checked before saving an attachment, steering, or resending historical images', async t => {
  let available = false, calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const provider = async function* () { calls++; await pending; yield { type: 'delta', text: 'done' }; };
  const host = { assertProviderAvailable(_id, _model, options) { if (options.hasImages && !available) throw new Error('Missing vision companion'); } };
  const { runtime, chat } = await fixture(t, 'openai', undefined, provider, host);
  const attachment = { chatId: chat.id, text: 'Read this', images: [png] };
  await assert.rejects(runtime.request('chat.send', attachment), /Missing vision companion/);
  assert.equal((await runtime.request('state.get')).chats[0].messages.length, 0);
  available = true;
  const { runId } = await runtime.request('chat.send', attachment);
  await until(runtime, state => state.runs[0]?.modelCalls.length > 0);
  available = false;
  await assert.rejects(runtime.request('chat.send', attachment), /Missing vision companion/);
  await assert.rejects(runtime.request('chat.steer', { ...attachment, runId }), /Missing vision companion/);
  release();
  assert.equal((await finish(runtime, runId)).runs[0].status, 'completed');
  const followup = await runtime.request('chat.send', { chatId: chat.id, text: 'Read the same image again' });
  assert.match((await finish(runtime, followup.runId)).runs.at(-1).error, /Missing vision companion/);
  assert.equal(calls, 1);
});

for (const kind of ['ollama', 'openai', 'openai-responses']) test(`${kind}: image-only and historical user images, actual per-call usage survives persistence`, async t => {
  const requests = [];
  const { runtime, chat, options, saved } = await fixture(t, kind, async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const first = requests.length === 1;
    if (kind === 'ollama') return new Response(JSON.stringify({ done: true, message: first ? { content: '', tool_calls: [{ id: 'one', function: { name: 'test_read', arguments: {} } }] } : { content: 'done' }, ...(first ? { prompt_eval_count: 100, eval_count: 20, prompt_eval_cached_count: 30 } : {}) }) + '\n');
    if (kind === 'openai') {
      assert.deepEqual(body.stream_options, { include_usage: true });
      const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 } };
      return sse([{ choices: [{ delta: first ? { tool_calls: [{ index: 0, id: 'one', function: { name: 'test_read', arguments: '{}' } }] } : { content: 'done' }, finish_reason: first ? 'tool_calls' : 'stop' }] }, ...(first ? [{ choices: [], usage }, { choices: [], usage }] : [])]);
    }
    const output = first ? [{ type: 'function_call', call_id: 'one', name: 'test_read', arguments: '{}', status: 'completed' }] : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] }];
    return sse([...(first ? [{ type: 'response.in_progress', response: { usage: responseUsage } }] : []), { type: 'response.completed', response: { status: 'completed', output, ...(first ? { usage: responseUsage } : {}) } }]);
  });
  runtime.registerTools([{ name: 'test_read', description: 'Test-only tool', permission: 'read', parameters: empty, execute: () => ({ ok: true }) }]);
  const sent = await runtime.request('chat.send', { chatId: chat.id, text: '', images: [png] });
  let state = await finish(runtime, sent.runId);
  assert.equal(state.runs[0].status, 'completed', state.runs[0].error);
  assert.equal(state.runs[0].modelCalls.length, 2);
  const [one, two] = state.runs[0].modelCalls;
  assert.deepEqual(one.usage, kind === 'ollama' ? { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 } : expectedUsage);
  assert.equal(two.usage, undefined); assert.equal(one.sequence, 1); assert.equal(two.sequence, 2);
  for (const call of [one, two]) { assert.equal(call.status, 'completed'); assert.ok(call.startedAt && call.endedAt); assert.equal(call.providerId, saved.id); assert.equal(call.model, 'fixture'); }
  const next = await runtime.request('chat.send', { chatId: chat.id, text: 'Compare this attachment', images: [png] });
  state = await finish(runtime, next.runId);
  const body = requests.at(-1);
  const users = (kind === 'openai-responses' ? body.input : body.messages).filter(message => message.role === 'user');
  assert.equal(users.length, 2);
  if (kind === 'ollama') { assert.equal(users[0].content, ''); assert.deepEqual(users[0].images, [png.split(',')[1]]); assert.equal(users[1].content, 'Compare this attachment'); }
  else if (kind === 'openai') { assert.deepEqual(users[0].content, [{ type: 'image_url', image_url: { url: png } }]); assert.equal(users[1].content[0].text, 'Compare this attachment'); }
  else { assert.deepEqual(users[0].content, [{ type: 'input_image', image_url: png, detail: 'auto' }]); assert.equal(users[1].content[0].text, 'Compare this attachment'); }
  assert.ok(!JSON.stringify(body).includes('inputTokens')); assert.ok(!JSON.stringify(body).includes('modelCalls'));
  const disk = JSON.parse(await fs.readFile(join(options.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(disk.runs[0].modelCalls, state.runs[0].modelCalls);
  assert.deepEqual(disk.chats[0].messages.filter(message => message.role === 'user').map(message => message.images), [[png], [png]]);
});

test('failed/incomplete Responses retain reported usage and never execute pending tools', async t => {
  for (const type of ['response.failed', 'response.incomplete']) await t.test(type, async t => {
    let effects = 0;
    const { runtime, chat } = await fixture(t, 'openai-responses', async () => sse([{ type, response: { usage: responseUsage, error: { message: 'fixture failure' }, output: [{ type: 'function_call', call_id: 'unsafe', name: 'test_effect', arguments: '{}' }] } }]));
    runtime.registerTools([{ name: 'test_effect', description: 'Test effect counter', permission: 'read', parameters: empty, execute: () => ++effects }]);
    const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'fail' });
    const state = await finish(runtime, runId);
    assert.equal(effects, 0); assert.equal(state.runs[0].modelCalls[0].status, 'failed'); assert.deepEqual(state.runs[0].modelCalls[0].usage, expectedUsage);
  });
});

test('Chat Completions length failure still receives final usage without executing its partial tool', async t => {
  let effects = 0;
  const { runtime, chat } = await fixture(t, 'openai', async () => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', function: { name: 'test_effect', arguments: '{}' } }] }, finish_reason: 'length' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } },
  ]));
  runtime.registerTools([{ name: 'test_effect', description: 'Test effect counter', permission: 'read', parameters: empty, execute: () => ++effects }]);
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'test' });
  const state = await finish(runtime, runId);
  assert.equal(effects, 0); assert.equal(state.runs[0].modelCalls[0].status, 'failed');
  assert.deepEqual(state.runs[0].modelCalls[0].usage, { inputTokens: 12, outputTokens: 8 });
});

test('canceled and HTTP-failed calls keep unknown usage; restart marks only existing in-flight records interrupted', async t => {
  const { runtime, chat, options } = await fixture(t, 'openai-responses', async () => new Response(new ReadableStream({ start() {} })));
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'wait' });
  await until(runtime, state => state.runs[0].modelCalls.length === 1);
  await runtime.request('chat.stop', { chatId: chat.id });
  let state = await finish(runtime, runId);
  // Wait for model-call finalization as Stop emits the run status immediately.
  state = await until(runtime, state => state.runs[0].modelCalls[0].status === 'canceled');
  assert.equal(state.runs[0].modelCalls[0].usage, undefined);
  await runtime.close();
  const statePath = join(options.dataDir, 'state.json'), disk = JSON.parse(await fs.readFile(statePath, 'utf8'));
  disk.runs[0].status = 'running'; disk.runs[0].modelCalls[0].status = 'running';
  disk.runs.push({ id: 'legacy', chatId: chat.id, status: 'completed', toolEvents: [] });
  await fs.writeFile(statePath, JSON.stringify(disk));
  const recovered = await createRuntime({ ...options, provider: args => streamProvider({ ...args, fetchImpl: async () => new Response('', { status: 429 }) }) });
  try {
    state = await recovered.request('state.get');
    assert.equal(state.runs[0].modelCalls[0].status, 'interrupted'); assert.equal(state.runs[1].modelCalls, undefined);
    const failed = await recovered.request('chat.send', { chatId: chat.id, text: 'fail' });
    state = await finish(recovered, failed.runId);
    const modelCall = state.runs.at(-1).modelCalls[0];
    assert.equal(modelCall.status, 'failed'); assert.equal(modelCall.usage, undefined); assert.ok(modelCall.endedAt);
  } finally { await recovered.close(); }
});

test('image bounds and MIME/base64 signatures are validated before any state mutation', async t => {
  assert.deepEqual(validateChatImages(Array(8).fill(png)), Array(8).fill(png));
  const bytes = Buffer.alloc(Math.floor((imageBytesLimit - 'data:image/png;base64,'.length) / 4) * 3);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  const boundary = `data:image/png;base64,${bytes.toString('base64')}`;
  assert.doesNotThrow(() => validateChatImages([boundary]));
  assert.throws(() => validateChatImages([boundary, png]), /8 MiB/);
  const { runtime, chat } = await fixture(t, 'ollama', undefined, async function* () { yield { type: 'delta', text: 'done' }; });
  const before = await runtime.request('state.get');
  for (const images of [Array(9).fill(png), ['https://example.com/image.png'], [png.replace('png', 'jpeg')], ['data:image/svg+xml;base64,YQ=='], ['data:image/png;base64,YQ=='], [png + '\n'], [png.slice(0, -1)], [boundary, png], [null]]) {
    await assert.rejects(runtime.request('chat.send', { chatId: chat.id, text: '', images }));
    assert.deepEqual(await runtime.request('state.get'), before);
  }
  await assert.rejects(runtime.request('chat.send', { chatId: chat.id, text: '', images: [] }), /text or an image/);
  assert.deepEqual(await runtime.request('state.get'), before);
});

test('usage validation preserves explicit zero and omits missing, negative or unsafe values', () => {
  assert.deepEqual(cleanUsage({ inputTokens: 0, outputTokens: -1, cachedInputTokens: '20', reasoningTokens: Number.MAX_SAFE_INTEGER + 1 }), { inputTokens: 0 });
  assert.deepEqual(providerUsage({}, 'openai'), {});
  assert.deepEqual(providerUsage({ input_tokens: 3, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 } }, 'openai-responses'), { inputTokens: 3, outputTokens: 4, reasoningTokens: 0 });
});
