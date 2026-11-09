import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../core/runtime.mjs';
import { streamProvider } from '../core/provider.mjs';
import { supportsNativeSteering } from '../core/responses-websocket.mjs';
import { usageSummary } from '../core/usage.mjs';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tool = (name, execute, permission = 'read') => ({ name, execute, permission, description: 'Deterministic a2.5 fixture', parameters: empty });
const sse = frames => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
async function until(runtime, predicate) {
  for (let count = 0; count < 500; count++) { const state = await runtime.request('state.get'); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('a2.5 fixture timed out');
}
const settled = (runtime, runId) => until(runtime, state => state.runs.find(run => run.id === runId)?.endedAt && state.runs.find(run => run.id === runId)?.modelCalls.every(call => call.endedAt));
async function fixture(t, provider, host = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'faber-a25-')), options = { sourceDir: join(root, 'source'), dataDir: join(root, 'data'), provider, host };
  const runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await fs.rm(root, { force: true, recursive: true }); });
  const project = await runtime.request('project.create', { name: 'Fixture', path: options.sourceDir });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  return { runtime, chat, project, options };
}

test('Stop aborts a live parent and descendant before emitting its first history snapshot', { timeout: 15000 }, async t => {
  const signals = [], entered = deferred(); let calls = 0;
  const f = await fixture(t, async function* ({ signal }) {
    if (calls++ === 0) { yield { type: 'tool', id: 'spawn', name: 'agent_create', args: { title: 'Child', task: 'Wait' } }; return; }
    signals.push(signal); if (signals.length === 2) entered.resolve();
    await new Promise(() => {});
  });
  // Saved, completed history must not force one save per historical run before abort.
  for (let index = 0; index < 20; index++) await f.runtime.request('tool.run', { chatId: f.chat.id, name: 'system_time', args: {} });
  const { runId } = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Spawn and wait' }); await entered.promise;
  const snapshots = [];
  const unsubscribe = f.runtime.subscribe(event => { if (event.type === 'state') snapshots.push(signals.every(signal => signal.aborted)); });
  const stopped = await f.runtime.request('chat.stop', { chatId: f.chat.id }); unsubscribe();
  assert.ok(stopped.stopped.includes(runId)); assert.ok(signals.every(signal => signal.aborted)); assert.ok(snapshots.every(Boolean)); assert.ok(snapshots.length < 10);
  await f.runtime.request('chat.forceStop', { chatId: f.chat.id });
});

test('rejected provider output aborts and returns its iterator without waiting for cleanup', async t => {
  let canceled = false, returned = 0;
  const f = await fixture(t, ({ signal }) => ({ [Symbol.asyncIterator]() { return { next: async () => ({ value: { type: 'delta', text: 12 }, done: false }), return() { returned++; canceled = signal.aborted; return new Promise(() => {}); } }; } }));
  const sent = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Reject invalid text' });
  const state = await settled(f.runtime, sent.runId);
  assert.equal(state.runs.at(-1).status, 'failed'); assert.equal(returned, 1); assert.equal(canceled, true);
});

test('HTTP steering cancels only generation, discards partial arguments, and deduplicates corrections across a new remote request', async t => {
  const started = deferred(), seen = []; let calls = 0, effects = 0, closed = 0;
  const f = await fixture(t, async function* ({ messages }) {
    seen.push(messages);
    if (calls++ === 0) {
      try { yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 3 } }; yield { type: 'delta', text: 'Old partial' }; yield { type: 'output_progress', characters: 100 }; started.resolve(); await new Promise(() => {}); yield { type: 'tool', id: 'obsolete', name: 'fixture_effect', args: {} }; }
      finally { closed++; }
    } else { yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 5 } }; yield { type: 'delta', text: 'Corrected answer' }; }
  });
  f.runtime.registerTools([tool('fixture_effect', () => ++effects)]);
  const { runId } = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Original' }); await started.promise;
  const params = { chatId: f.chat.id, runId, text: 'Use the correction', correctionId: randomUUID() };
  const authority = { device: { id: 'paired-fixture' }, requestId: randomUUID() };
  const first = await f.runtime.remoteRequest('chat.steer', params, authority);
  const final = await settled(f.runtime, runId);
  const again = await f.runtime.remoteRequest('chat.steer', params, { ...authority, requestId: randomUUID() });
  assert.equal(first.runId, runId); assert.equal(again.messageId, first.messageId); assert.equal(again.status, 'applied'); assert.equal(final.runs.length, 1);
  assert.equal(final.runs[0].modelCalls[0].status, 'interrupted'); assert.equal(final.runs[0].status, 'completed'); assert.equal(effects, 0);
  assert.equal(final.chats[0].messages.filter(message => message.id === first.messageId).length, 1);
  assert.ok(final.chats[0].messages.some(message => message.content === 'Old partial' && message.status === 'interrupted'));
  assert.equal(seen.at(-1).at(-1).content, params.text); assert.equal(final.runs[0].promptUsage.length, 2);
  assert.deepEqual(final.runs[0].promptUsage.map(row => row.outputTokens), [3, 5]);
  assert.equal(closed, 0, 'A provider ignoring cancellation cannot block on generator.return()');
  await assert.rejects(f.runtime.request('chat.steer', { ...params, text: 'Conflicting content' }), /Conflicting/);
  await assert.rejects(f.runtime.request('chat.steer', { ...params, correctionId: randomUUID() }), /finished or changed/);
});

test('steering waits for an executing tool, preserves its result and grants, and skips the next obsolete action', async t => {
  const running = deferred(), release = deferred(); let calls = 0, effects = 0;
  const f = await fixture(t, async function* () {
    if (calls++ === 0) { yield { type: 'tool', id: 'running', name: 'fixture_hold', args: {} }; yield { type: 'tool', id: 'obsolete', name: 'fixture_effect', args: {} }; }
    else yield { type: 'delta', text: 'Applied after the tool settled' };
  });
  f.runtime.registerTools([tool('fixture_hold', async (_args, ctx) => { running.resolve(ctx.signal); await release.promise; assert.equal(ctx.signal.aborted, false); return { committed: true }; }, 'files'), tool('fixture_effect', () => ++effects, 'files')]);
  await f.runtime.request('chat.update', { id: f.chat.id, grants: ['files'] });
  const { runId } = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Original' }); const toolSignal = await running.promise;
  const correction = await f.runtime.request('chat.steer', { chatId: f.chat.id, runId, text: 'Change the next step' });
  assert.equal(correction.waitingFor, 'tool'); assert.equal(toolSignal.aborted, false); release.resolve();
  const state = await settled(f.runtime, runId), run = state.runs[0];
  assert.equal(run.status, 'completed'); assert.equal(run.toolEvents.length, 1); assert.equal(run.toolEvents[0].status, 'completed'); assert.equal(effects, 0);
  assert.deepEqual(run.grants, ['files']); assert.equal(run.steering[0].status, 'applied');
  assert.ok(state.chats[0].messages.some(message => message.toolCallId === 'obsolete' && message.content.includes('superseded')));
});

test('steering supersedes an approval-waiting action without granting permission', async t => {
  let calls = 0, effects = 0;
  const f = await fixture(t, async function* () { if (calls++ === 0) yield { type: 'tool', id: 'pending', name: 'fixture_effect', args: {} }; else yield { type: 'delta', text: 'Correction applied' }; });
  f.runtime.registerTools([tool('fixture_effect', () => ++effects, 'files')]);
  const { runId } = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Original' });
  const pending = await until(f.runtime, state => state.approvals.length === 1);
  const result = await f.runtime.request('chat.steer', { chatId: f.chat.id, runId, text: 'Do not write' });
  assert.equal(result.waitingFor, 'approval');
  const state = await settled(f.runtime, runId);
  assert.equal(effects, 0); assert.equal(state.runs[0].toolEvents[0].status, 'superseded'); assert.deepEqual(state.runs[0].grants, []); assert.equal(state.approvals.length, 0);
  await assert.rejects(f.runtime.request('approval.resolve', { id: pending.approvals[0].id, allow: true }), /no longer pending/);
});

test('argument chunks produce live estimated tokens before a tool dispatch; tool waiting produces no ticks', async t => {
  const output = deferred(), resume = deferred(), running = deferred(), release = deferred(), progress = [];
  const f = await fixture(t, async function* () {
    yield { type: 'output_progress', characters: 480 }; output.resolve(); await resume.promise;
    yield { type: 'tool', id: 'write', name: 'fixture_hold', args: {} };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 140 } };
  });
  f.runtime.registerTools([tool('fixture_hold', async () => { running.resolve(); await release.promise; return { done: true }; })]);
  f.runtime.subscribe(event => { if (event.type === 'progress') progress.push(event); });
  const { runId } = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Write a long file' }); await output.promise;
  const state = await f.runtime.request('state.get'), live = state.streams[0];
  assert.equal(state.runs[0].toolEvents.length, 0); assert.equal(live.metrics.generatedOutputTokens, 120); assert.equal(live.metrics.outputTokensStatus, 'estimated');
  resume.resolve(); await running.promise; const events = progress.length; await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(progress.length, events);
  await f.runtime.request('chat.stop', { chatId: f.chat.id }); release.resolve(); await f.runtime.request('chat.forceStop', { chatId: f.chat.id });
  assert.ok(progress.some(event => event.metrics.outputTokensStatus === 'reported' && event.metrics.generatedOutputTokens === 140));
});

test('prompt usage sums call identities once, preserves unknowns, and keeps subset counts separate', () => {
  const one = { id: 'one', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5 }, metrics: { estimatedInputTokens: 90, estimatedOutputTokens: 15 } };
  const total = usageSummary([one, one, { id: 'summary', usage: { inputTokens: 15, outputTokens: 6 } }, { id: 'retry', usage: { outputTokens: 4 } }, { id: 'unknown' }]);
  assert.equal(total.calls, 4); assert.equal(total.inputTokens, 115); assert.equal(total.outputTokens, 30); assert.equal(total.cachedInputTokens, 40); assert.equal(total.reasoningTokens, 5);
  assert.equal(total.status, 'partial'); assert.equal(total.reportedCalls, 2); assert.equal(total.partialCalls, 1); assert.equal(total.unknownCalls, 1);
  assert.equal(total.estimatedInputTokens, undefined); assert.equal(total.estimatedOutputTokens, undefined);
  const missing = usageSummary([one, { id: 'text-only', metrics: { estimatedInputTokens: 17, estimatedOutputTokens: 8 } }, { id: 'partial', usage: { inputTokens: 5 }, metrics: { estimatedInputTokens: 100, estimatedOutputTokens: 7 } }]);
  assert.equal(missing.estimatedInputTokens, 17); assert.equal(missing.estimatedOutputTokens, 15); assert.equal(missing.inputTokens, 105); assert.equal(missing.outputTokens, 20);
  assert.equal(usageSummary([{ id: 'missing' }]).estimatedOutputTokens, undefined);
});

test('per-prompt usage includes attributable child calls exactly once', async t => {
  const f = await fixture(t, async function* ({ messages }) {
    if (messages.at(-1).content === 'Child task') { yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 5 } }; yield { type: 'delta', text: 'Child finished' }; }
    else if (!messages.some(message => message.toolName === 'agent_create')) {
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, reasoningTokens: 2 } }; yield { type: 'tool', id: 'spawn', name: 'agent_create', args: { task: 'Child task' } };
    } else if (!messages.some(message => message.toolName === 'agent_wait')) {
      const child = JSON.parse(messages.find(message => message.toolName === 'agent_create').content);
      yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 6 } }; yield { type: 'tool', id: 'wait', name: 'agent_wait', args: { runId: child.runId } };
    } else { yield { type: 'usage', usage: { inputTokens: 70, outputTokens: 7 } }; yield { type: 'delta', text: 'Parent finished' }; }
  });
  const { runId } = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Delegate then finish' });
  const state = await settled(f.runtime, runId), parent = state.runs.find(run => run.id === runId), child = state.runs.find(run => run.parentRunId === runId);
  assert.equal(parent.status, 'completed', parent.error); assert.equal(parent.promptUsage.length, 1); assert.equal(child.promptUsage.length, 0);
  const usage = parent.promptUsage[0]; assert.equal(usage.inputTokens, 280); assert.equal(usage.outputTokens, 28); assert.equal(usage.calls, 4); assert.equal(new Set(usage.callIds).size, 4);
  assert.equal(usage.cachedInputTokens, 40); assert.equal(usage.reasoningTokens, 2); assert.equal(usage.status, 'reported');
});

test('steering at model completion prevents dispatch of its obsolete action', async t => {
  let calls = 0, effects = 0, correction;
  const f = await fixture(t, async function* () { if (calls++ === 0) yield { type: 'tool', id: 'obsolete', name: 'fixture_effect', args: {} }; else yield { type: 'delta', text: 'Updated final' }; });
  f.runtime.registerTools([tool('fixture_effect', () => ++effects)]);
  f.runtime.subscribe(event => {
    const run = event.type === 'state' && event.state.runs[0];
    if (!correction && run?.modelCalls[0]?.status === 'completed' && !run.toolEvents.length) correction = f.runtime.request('chat.steer', { chatId: f.chat.id, runId: run.id, text: 'Cancel that action' });
  });
  const { runId } = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Original' }); const state = await settled(f.runtime, runId); await correction;
  assert.equal(state.runs[0].status, 'completed'); assert.equal(effects, 0); assert.equal(state.runs[0].steering[0].status, 'applied');
});

test('queued prompts sharing one model call identify the charged prompt without duplicate token estimates', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, async function* () { if (calls++ === 0) yield { type: 'tool', id: 'hold', name: 'fixture_hold', args: {} }; else { yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 3 } }; yield { type: 'delta', text: 'Both follow-ups applied' }; } });
  f.runtime.registerTools([tool('fixture_hold', async () => { entered.resolve(); await release.promise; return true; })]);
  const { runId } = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Original' }); await entered.promise;
  const earlier = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'First follow-up' }), later = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Second follow-up' }); release.resolve();
  const state = await settled(f.runtime, runId), rows = state.runs[0].promptUsage;
  const shared = rows.find(row => row.requestMessageId === earlier.messageId), charged = rows.find(row => row.requestMessageId === later.messageId);
  assert.equal(shared.allocation, 'shared'); assert.equal(shared.sharedWithMessageId, later.messageId); assert.equal(shared.status, 'unknown'); assert.equal(shared.calls, 0); assert.equal(shared.estimatedOutputTokens, undefined);
  assert.equal(charged.outputTokens, 3); assert.equal(charged.calls, 1); assert.equal(rows.reduce((sum, row) => sum + (row.outputTokens || 0), 0), 3);
});

test('native steering capability is separate from ChatGPT subscription and compatible HTTP endpoints', () => {
  const provider = { kind: 'openai-responses', model: 'gpt-6.1-sol', baseUrl: 'https://api.openai.com/v1', hasKey: true };
  assert.equal(supportsNativeSteering(provider), true);
  for (const change of [{ authKind: 'chatgpt' }, { id: 'chatgpt:fixture' }, { model: 'gpt-5.6' }, { baseUrl: 'https://compatible.example/v1' }, { hasKey: false }]) assert.equal(supportsNativeSteering({ ...provider, ...change }), false);
});

function socketFixture(mode) {
  const opened = deferred(), sent = [], sockets = [];
  class Socket extends EventEmitter {
    constructor(url, options) { super(); sockets.push(this); assert.equal(url, 'wss://api.openai.com/v1/responses'); assert.equal(options.followRedirects, false); this.sequence = 0; queueMicrotask(() => this.emit('open')); }
    frame(frame) { this.emit('message', Buffer.from(JSON.stringify({ ...frame, sequence_number: this.sequence++ }))); }
    send(text) {
      const frame = JSON.parse(text); sent.push(frame);
      queueMicrotask(() => {
        if (frame.type === 'response.create' && !frame.previous_response_id) {
          this.frame({ type: 'response.created', response: { id: 'first' } });
          this.frame({ type: 'response.output_text.delta', delta: 'Original partial' }); opened.resolve();
        } else if (frame.type === 'response.steer') {
          assert.equal(Object.keys(frame).sort().join(','), 'input,previous_response_id,type');
          const accept = () => this.frame({ type: 'response.steer.accepted', steer: { id: 'accepted-steer', previous_response_id: 'first' } });
          if (!['late-ack', 'completion-race'].includes(mode)) accept();
          if (mode === 'tool-duplicate-controls') accept();
          if (mode === 'disconnect') { this.emit('close'); return; }
          if (mode.startsWith('tool')) {
            const call = { id: 'obsolete-item', type: 'function_call', name: 'fixture_effect', call_id: 'obsolete', arguments: '{}', status: 'completed' };
            if (mode === 'tool-snapshot') this.frame({ type: 'response.output_item.done', output_index: 0, item: call });
            this.frame({ type: 'response.completed', response: { id: 'first', status: 'completed', usage: { input_tokens: 100, output_tokens: 10 }, output: mode === 'tool-snapshot' ? [] : [call] } });
            const pending = { type: 'response.steer.pending', steer: { id: 'accepted-steer', previous_response_id: 'first' }, reason: 'waiting_for_required_input', required_input: [{ type: 'function_call_output', name: 'fixture_effect', call_id: 'obsolete' }] };
            this.frame(pending); if (mode === 'tool-duplicate-controls') this.frame(pending);
          } else {
            if (mode === 'completion-race') this.frame({ type: 'response.completed', response: { id: 'first', status: 'completed', usage: { input_tokens: 100, output_tokens: 10 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original partial' }] }] } });
            else this.frame({ type: 'response.incomplete', response: { id: 'first', status: 'incomplete', incomplete_details: { reason: 'steered' }, usage: { input_tokens: 100, output_tokens: 10 } } });
            if (['late-ack', 'completion-race'].includes(mode)) accept();
            this.complete();
          }
        } else if (frame.previous_response_id === 'first') {
          assert.ok(mode.startsWith('tool')); assert.equal(frame.input.length, 1); assert.equal(frame.input[0].call_id, 'obsolete'); assert.match(frame.input[0].output, /No tool was executed/); this.complete();
        }
      });
    }
    complete() {
      if (mode === 'reset-sequence') this.sequence = 0;
      this.frame({ type: 'response.created', response: { id: 'successor' } });
      this.frame({ type: 'response.output_text.delta', delta: 'Corrected answer' });
      this.frame({ type: 'response.completed', response: { id: 'successor', status: 'completed', usage: { input_tokens: 120, output_tokens: 20, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 4 } }, output: [{ id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Corrected answer' }] }] } });
    }
    terminate() { this.closed = true; }
  }
  return { Socket, opened: opened.promise, sent, sockets };
}

for (const mode of ['normal', 'tool', 'tool-snapshot', 'tool-duplicate-controls', 'late-ack', 'completion-race', 'reset-sequence', 'disconnect']) test(`GPT-6 WebSocket steering ${mode}: accepted and applied are distinct, with no duplicate action`, async t => {
  const ws = socketFixture(mode), secrets = new Map(), states = []; let effects = 0;
  const f = await fixture(t, args => streamProvider({ ...args, WebSocketImpl: ws.Socket }), { getSecret: id => secrets.get(id), setSecret: (id, value) => secrets.set(id, value) });
  f.runtime.registerTools([tool('fixture_effect', () => ++effects)]);
  const provider = await f.runtime.request('provider.save', { name: 'API fixture', kind: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', apiKey: 'fake-a25-websocket-key' });
  await f.runtime.request('chat.update', { id: f.chat.id, providerId: provider.id });
  f.runtime.subscribe(event => { if (event.type === 'state') { const status = event.state.runs.at(-1)?.steering?.[0]?.status; if (status) states.push(status); } });
  const { runId } = await f.runtime.request('chat.send', { chatId: f.chat.id, text: 'Original task' }); await ws.opened;
  const correction = await f.runtime.request('chat.steer', { chatId: f.chat.id, runId, text: 'Apply one correction', correctionId: randomUUID() });
  assert.equal(correction.mode, 'native'); const state = await settled(f.runtime, runId), run = state.runs[0];
  assert.equal(effects, 0); assert.equal(ws.sent.filter(frame => frame.type === 'response.steer').length, 1); assert.ok(states.includes('accepted'));
  if (mode === 'disconnect') { assert.equal(run.status, 'failed'); assert.equal(run.steering[0].status, 'unknown'); assert.equal(ws.sent.filter(frame => frame.type === 'response.create').length, 1); }
  else {
    assert.equal(run.status, 'completed', run.error); assert.equal(run.steering[0].status, 'applied'); assert.equal(run.modelCalls.length, 2);
    assert.deepEqual(run.modelCalls.map(call => call.responseId), ['first', 'successor']); assert.deepEqual(run.promptUsage.map(row => row.outputTokens), [10, 20]);
    assert.equal(state.chats[0].messages.at(-1).content, 'Corrected answer'); assert.equal(run.toolEvents.length, 0);
    if (!mode.startsWith('tool')) {
      const messages = state.chats[0].messages, prior = messages.find(message => message.content === 'Original partial');
      assert.equal(prior.status, mode === 'completion-race' ? 'completed' : 'interrupted');
      assert.ok(messages.indexOf(prior) < messages.findIndex(message => message.id === correction.messageId));
    }
    if (mode.startsWith('tool')) assert.equal(ws.sent.filter(frame => frame.type === 'response.create').length, 2);
  }
  assert.equal(ws.sockets[0].closed, true);
});

for (const kind of ['openai', 'openai-responses']) test(`${kind} tool argument transport reports incremental output before completion`, async () => {
  const frames = kind === 'openai' ? [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'write', function: { name: 'write_file', arguments: '{"content":"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'text"}' } }] }, finish_reason: 'tool_calls' }] },
  ] : [
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"content":"' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: 'text"}' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'write', name: 'write_file', arguments: '{"content":"text"}' }] } },
  ];
  const result = [];
  for await (const event of streamProvider({ provider: { kind, model: 'fixture', baseUrl: 'http://localhost:1/v1' }, messages: [], tools: [], fetchImpl: async () => sse(frames) })) result.push(event);
  const chunks = result.filter(event => event.type === 'output_progress'); assert.ok(chunks.length >= 2); assert.ok(chunks[1].characters > chunks[0].characters);
  assert.ok(result.findIndex(event => event.type === 'output_progress') < result.findIndex(event => event.type === 'tool'));
});
