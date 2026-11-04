import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../core/runtime.mjs';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, provider, { capacity = null, history = [] } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'faber-recovery-'));
  const options = { dataDir: join(root, 'data'), sourceDir: join(root, 'source'), provider, host: { providerControls: () => capacity ? { context: { mode: 'managed', capacityTokens: capacity } } : undefined } };
  const runtimes = [];
  const open = async () => { const runtime = await createRuntime(options); runtimes.push(runtime); return runtime; };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  let runtime = await open();
  const project = await runtime.request('project.create', { name: 'Fixture', path: options.sourceDir });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  await runtime.request('provider.save', { id: 'fixture', name: 'Fixture', kind: 'openai', model: 'fixture-model', baseUrl: 'http://127.0.0.1:1/v1' });
  await runtime.request('chat.update', { id: chat.id, providerId: 'fixture' });
  if (history.length) {
    await runtime.close();
    const file = join(options.dataDir, 'state.json'), state = JSON.parse(await fs.readFile(file, 'utf8'));
    state.chats[0].messages = history;
    await fs.writeFile(file, JSON.stringify(state)); runtime = await open();
  }
  return { runtime, chat, open, options };
}
async function until(runtime, predicate) {
  for (let count = 0; count < 1000; count++) { const state = await runtime.request('state.get'); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Fixture timed out');
}
const finish = (runtime, runId) => until(runtime, state => state.runs.some(run => run.id === runId && !['running', 'waiting_approval'].includes(run.status)));
const history = () => Array.from({ length: 30 }, (_, index) => ({ id: 'old-' + index, role: index % 2 ? 'assistant' : 'user', content: 'Past work ' + index + ': ' + 'details '.repeat(800) }));
const summary = 'Goal: finish the current task. Completed actions remain completed; inspect original message IDs before repeating. Preserve existing files. Next: answer the latest user request.';
const handoff = (input, text = summary) => JSON.stringify({ summary: text, sourceMessageIds: [JSON.parse(input.messages[1].content).excerpts[0].id] });

test('preflight compacts working context, preserves full transcript and checkpoint across restart', async t => {
  const sent = [], prior = history();
  const setup = await fixture(t, async function* (input) {
    sent.push(input);
    if (input.provider.compactionTokens) { assert.equal(input.tools.length, 0); yield { type: 'delta', text: handoff(input) }; return; }
    yield { type: 'delta', text: 'Finished with condensed context.' };
  }, { capacity: 16000, history: prior });
  const { runId } = await setup.runtime.request('chat.send', { chatId: setup.chat.id, text: 'Please finish this task.' });
  let state = await finish(setup.runtime, runId);
  assert.equal(state.runs.at(-1).status, 'completed', state.runs.at(-1).error);
  assert.ok(state.runs.at(-1).compactions >= 1);
  assert.deepEqual(state.chats[0].messages.slice(0, prior.length), prior);
  const normal = sent.filter(input => !input.provider.compactionTokens);
  assert.equal(normal.length, 1); assert.ok(normal[0].messages.length < prior.length);
  assert.ok(normal[0].messages.some(message => message.content === 'Please finish this task.'));
  assert.ok(state.runs[0].modelCalls.some(call => call.purpose === 'compaction'));
  await setup.runtime.close();
  const reopened = await setup.open(); state = await reopened.request('state.get');
  assert.ok(state.chats[0].contextCheckpoint?.summary);
  assert.deepEqual(state.chats[0].messages.slice(0, prior.length), prior);
  const controls = await reopened.request('chat.controls', { chatId: setup.chat.id });
  assert.ok(controls.context.estimatedTokens < 16000);
});

test('legacy ACK checkpoints rebuild from complete original task prose before a known-capacity response call', async t => {
  const prior = history(), task = 'Write the outage comparison report. Preserve the requested distinction between attempted and verified repairs, keep unresolved decisions, and retain reference HARBOR-7261.';
  prior[0] = { id: 'original-task', role: 'user', content: task };
  const legacy = { version: 1, throughMessageId: prior.at(-1).id, summary: 'ARCHIVE_RECEIVED', capacityTokens: 16000 };
  const excerpts = [], order = []; let current;
  const setup = await fixture(t, async function* (input) {
    if (input.provider.compactionTokens) {
      order.push('summary'); assert.equal(input.tools.length, 0);
      assert.deepEqual((await current.request('state.get')).chats[0].contextCheckpoint, legacy);
      excerpts.push(...JSON.parse(input.messages[1].content).excerpts); yield { type: 'delta', text: handoff(input) }; return;
    }
    order.push('response'); yield { type: 'delta', text: 'Continued using a newly validated checkpoint.' };
  }, { capacity: 16000, history: prior });
  await setup.runtime.close();
  const file = join(setup.options.dataDir, 'state.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.chats[0].contextCheckpoint = legacy; await fs.writeFile(file, JSON.stringify(saved)); current = await setup.open();
  const controls = await current.request('chat.controls', { chatId: setup.chat.id }); assert.ok(controls.context.estimatedTokens > 16000);
  const { runId } = await current.request('chat.send', { chatId: setup.chat.id, text: 'Continue the original requested report.' });
  const final = await finish(current, runId); assert.equal(final.runs.at(-1).status, 'completed', final.runs.at(-1).error);
  assert.equal(order.at(-1), 'response'); assert.ok(order.length > 1); assert.ok(order.slice(0, -1).every(kind => kind === 'summary'));
  assert.equal(excerpts.filter(excerpt => excerpt.id === 'original-task').map(excerpt => excerpt.text).join(''), task);
  assert.ok(excerpts.every(excerpt => excerpt.role !== 'checkpoint')); assert.deepEqual(final.chats[0].messages.slice(0, prior.length), prior);
  assert.equal(final.chats[0].contextCheckpoint.version, 2);
  assert.ok(final.runs.at(-1).modelCalls.find(call => call.purpose === 'response').metrics.estimatedInputTokens <= 16000);
});

test('overflow after a tool result recovers without executing that action again', async t => {
  let normalCalls = 0, effects = 0, compactCalls = 0;
  const { runtime, chat } = await fixture(t, async function* (input) {
    if (input.provider.compactionTokens) { compactCalls++; assert.equal(input.tools.length, 0); yield { type: 'delta', text: handoff(input, summary + ' fixture_effect already executed once.') }; return; }
    normalCalls++;
    if (normalCalls === 1) yield { type: 'tool', id: 'once', name: 'fixture_effect', args: {} };
    else if (normalCalls === 2) throw new Error('Provider HTTP 400: request (57134 tokens) exceeds the available context size (16000 tokens), try increasing it');
    else { assert.ok(input.messages.some(message => message.content?.includes('already executed once'))); yield { type: 'delta', text: 'Done.' }; }
  }, { history: history().slice(0, 3) });
  runtime.registerTools([{ name: 'fixture_effect', description: 'Synthetic effect', parameters: empty, permission: 'read', execute: () => ({ effects: ++effects }) }]);
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Run the effect once and report.' });
  const state = await finish(runtime, runId);
  assert.equal(state.runs.at(-1).status, 'completed', state.runs.at(-1).error);
  assert.equal(effects, 1); assert.equal(normalCalls, 3); assert.ok(compactCalls > 0);
  assert.equal(state.chats[0].messages.filter(message => message.role === 'tool').length, 1);
  assert.equal(state.chats[0].messages.filter(message => message.role === 'user' && message.content === 'Run the effect once and report.').length, 1);
  assert.equal(state.chats[0].contextCapacityHint.capacityTokens, 16000);
});

test('manual compact resumes without inserting a Continue message and records summary usage', async t => {
  const { runtime, chat } = await fixture(t, async function* (input) {
    if (input.provider.compactionTokens) { yield { type: 'delta', text: handoff(input) }; yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }; return; }
    yield { type: 'delta', text: 'Resumed.' };
  }, { capacity: 16000, history: history().slice(0, 6).concat({ id: 'request', role: 'user', content: 'Finish the existing request.' }) });
  const before = (await runtime.request('state.get')).chats[0].messages;
  const { runId } = await runtime.request('chat.compact', { chatId: chat.id });
  const state = await finish(runtime, runId);
  assert.equal(state.runs.at(-1).status, 'completed', state.runs.at(-1).error);
  assert.deepEqual(state.chats[0].messages.slice(0, before.length), before);
  assert.equal(state.chats[0].messages.length, before.length + 1);
  assert.equal(state.runs.at(-1).modelCalls.find(call => call.purpose === 'compaction').usage.outputTokens, 50);
});

test('Stop cancels in-progress summarization without replacing checkpoint or transcript', async t => {
  const entered = deferred(), never = new Promise(() => {});
  const { runtime, chat } = await fixture(t, async function* (input) {
    if (input.provider.compactionTokens) { entered.resolve(); await never; }
    else yield { type: 'delta', text: 'Should not run' };
  }, { capacity: 16000, history: history() });
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Continue safely.' });
  await entered.promise;
  await runtime.request('chat.forceStop', { chatId: chat.id });
  const state = await finish(runtime, runId);
  assert.equal(state.runs.at(-1).status, 'canceled');
  assert.equal(state.chats[0].contextCheckpoint, undefined);
  assert.equal(state.chats[0].messages.length, history().length + 1);
});

test('canonical replacement and progress reach the UI, while only final text is saved', async t => {
  const { runtime, chat } = await fixture(t, async function* () {
    yield { type: 'progress', phase: 'thinking', summary: 'Checking formatting.' };
    yield { type: 'delta', text: 'early text' };
    yield { type: 'text', text: 'Correct final text' };
  });
  const events = []; runtime.subscribe(event => events.push(event));
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Answer.' });
  const state = await finish(runtime, runId);
  assert.equal(state.runs.at(-1).status, 'completed');
  assert.equal(state.chats[0].messages.at(-1).content, 'Correct final text');
  assert.equal(state.chats[0].messages.filter(message => message.role === 'assistant').length, 1);
  assert.ok(events.some(event => event.type === 'delta' && event.replace && event.text === 'Correct final text'));
  assert.ok(events.some(event => event.type === 'progress' && event.phase === 'thinking' && event.sequence > 0));
  assert.ok(state.runs[0].modelCalls[0].metrics.firstTokenMs >= 0);
});

test('repeated overflow has bounded recovery attempts and rate limits never trigger summaries', async t => {
  let requests = 0, summaries = 0;
  const first = await fixture(t, async function* (input) {
    if (input.provider.compactionTokens) { summaries++; yield { type: 'delta', text: handoff(input) }; return; }
    requests++; throw new Error('Provider HTTP 400: maximum context length is 16000 tokens');
  }, { history: history().slice(0, 4) });
  const run = await first.runtime.request('chat.send', { chatId: first.chat.id, text: 'Finish.' });
  const state = await finish(first.runtime, run.runId);
  assert.equal(state.runs.at(-1).status, 'failed'); assert.equal(state.runs.at(-1).contextOverflow, true);
  assert.ok(requests <= 3); assert.ok(summaries > 0 && summaries < 20);
  const rate = await fixture(t, async function* (input) { assert.equal(input.provider.compactionTokens, undefined); throw new Error('Provider HTTP 429: Rate limit reached on tokens per minute (TPM): Limit 1000000, Requested 867953'); });
  const rateRun = await rate.runtime.request('chat.send', { chatId: rate.chat.id, text: 'Answer.' });
  const rateState = await finish(rate.runtime, rateRun.runId);
  assert.equal(rateState.runs.at(-1).contextOverflow, undefined);
  assert.equal(rateState.runs.at(-1).modelCalls.length, 1);
});

test('known native capacity keeps room for a large latest request during overflow recovery', async t => {
  let requests = 0;
  const latest = 'latest instruction '.repeat(2500);
  const { runtime, chat } = await fixture(t, async function* (input) {
    if (input.provider.compactionTokens) { yield { type: 'delta', text: handoff(input) }; return; }
    if (++requests === 1) throw new Error('Provider HTTP 400: maximum context length is 32768 tokens');
    assert.ok(input.messages.some(message => message.content === latest)); yield { type: 'delta', text: 'Recovered.' };
  }, { capacity: 32768, history: [{ id: 'older', role: 'user', content: 'Earlier instructions and completed work.' }] });
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: latest });
  const state = await finish(runtime, runId);
  assert.equal(state.runs.at(-1).status, 'completed', state.runs.at(-1).error);
  assert.equal(requests, 2);
});

test('a summary context rejection retries smaller chunks without saving partial work', async t => {
  let summaries = 0, firstSize;
  const { runtime, chat } = await fixture(t, async function* (input) {
    if (input.provider.compactionTokens) {
      const size = JSON.stringify(input.messages).length;
      if (++summaries === 1) { firstSize = size; throw new Error('Provider HTTP 400: context_length_exceeded'); }
      assert.ok(size < firstSize); yield { type: 'delta', text: handoff(input) }; return;
    }
    yield { type: 'delta', text: 'Recovered after smaller chunks.' };
  }, { capacity: 16000, history: history() });
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Continue.' });
  const state = await finish(runtime, runId);
  assert.equal(state.runs.at(-1).status, 'completed', state.runs.at(-1).error);
  assert.ok(summaries > 1); assert.ok(state.chats[0].contextCheckpoint);
  assert.deepEqual(state.chats[0].messages.slice(0, history().length), history());
  assert.equal(state.runs[0].modelCalls.filter(call => call.purpose === 'compaction' && call.status === 'failed').length, 1);
});
