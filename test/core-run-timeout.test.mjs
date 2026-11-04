import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../core/runtime.mjs';

const realTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
const empty = { type: 'object', properties: {}, additionalProperties: false };
const never = new Promise(() => {});
function clock(t) {
  let elapsed = 0; const scheduled = [];
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.mock.method(performance, 'now', () => elapsed);
  const mockedTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    const callback = t.mock.fn(fn); scheduled.push({ callback, delay }); return mockedTimeout(callback, delay, ...args);
  });
  return { scheduled, advance(ms) { elapsed += ms; t.mock.timers.tick(ms); } };
}
async function fixture(t, provider = async function* () { await never; }) {
  const root = await fs.mkdtemp(join(tmpdir(), 'faber-run-timeout-'));
  const options = { dataDir: join(root, 'data'), sourceDir: join(root, 'source'), provider }, runtimes = [];
  const open = async () => { const runtime = await createRuntime(options); runtimes.push(runtime); return runtime; };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await open(), project = await runtime.request('project.create', { name: 'Timeout fixture', path: options.sourceDir });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  return { runtime, chat, open, options };
}
async function until(runtime, predicate) {
  const initial = await runtime.request('state.get'); if (predicate(initial)) return initial;
  return new Promise((resolve, reject) => {
    const watchdog = realTimeout(() => { unsubscribe(); reject(new Error('Timeout fixture state did not settle')); }, 5000);
    const unsubscribe = runtime.subscribe(event => {
      if (event.type === 'state' && predicate(event.state)) { realClearTimeout(watchdog); unsubscribe(); resolve(event.state); }
    });
  });
}
const runState = (runtime, id) => runtime.request('state.get').then(state => state.runs.find(run => run.id === id));
const stopped = (runtime, id) => until(runtime, state => state.runs.some(run => run.id === id && run.status === 'canceled'));

test('Off persists through reload and creates no run timer, while the existing default remains ten minutes', async t => {
  const timers = clock(t), { runtime, chat, open } = await fixture(t, async function* () { yield { type: 'delta', text: 'Completed without an overall timer.' }; });
  assert.equal((await runtime.request('state.get')).settings.runTimeoutMs, 600000);
  await runtime.request('settings.update', { runTimeoutMs: 0 }); await runtime.close();
  const reopened = await open(); assert.equal((await reopened.request('state.get')).settings.runTimeoutMs, 0);
  const { runId } = await reopened.request('chat.send', { chatId: chat.id, text: 'Run with the limit off' });
  await until(reopened, state => state.runs.some(run => run.id === runId && run.status === 'completed'));
  assert.equal(timers.scheduled.length, 0);
});

test('turning a busy run Off clears its deadline and ignores a stale callback without changing the run', async t => {
  const timers = clock(t), { runtime, chat } = await fixture(t);
  await runtime.request('settings.update', { runTimeoutMs: 1000 });
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Keep working' });
  timers.advance(900); await runtime.request('settings.update', { runTimeoutMs: 0 });
  timers.scheduled[0].callback(); timers.advance(100000);
  assert.equal((await runState(runtime, runId)).status, 'running'); assert.equal(timers.scheduled.length, 1);
  await runtime.request('chat.forceStop', { chatId: chat.id }); assert.equal((await runState(runtime, runId)).status, 'canceled');
});

test('shorter and longer live deadlines are measured from the original start', async t => {
  const timers = clock(t), { runtime, chat } = await fixture(t);
  await runtime.request('settings.update', { runTimeoutMs: 5000 });
  const first = await runtime.request('chat.send', { chatId: chat.id, text: 'Shorten this run' });
  timers.advance(2000); await runtime.request('settings.update', { runTimeoutMs: 4000 });
  assert.equal(timers.scheduled.at(-1).delay, 2000);
  timers.advance(1999); assert.equal((await runState(runtime, first.runId)).status, 'running');
  timers.advance(1); await stopped(runtime, first.runId); await runtime.request('chat.forceStop', { chatId: chat.id });
  await runtime.request('settings.update', { runTimeoutMs: 1000 });
  const second = await runtime.request('chat.send', { chatId: chat.id, text: 'Extend this run' });
  timers.advance(750); await runtime.request('settings.update', { runTimeoutMs: 2000 });
  assert.equal(timers.scheduled.at(-1).delay, 1250);
  timers.advance(1249); assert.equal((await runState(runtime, second.runId)).status, 'running');
  timers.advance(1); await stopped(runtime, second.runId);
});

test('enabling a deadline already passed cancels immediately without scheduling a zero-delay timer', async t => {
  const timers = clock(t), { runtime, chat } = await fixture(t);
  await runtime.request('settings.update', { runTimeoutMs: 0 });
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Start without a deadline' });
  timers.advance(3000); await runtime.request('settings.update', { runTimeoutMs: 2000 }); await stopped(runtime, runId);
  assert.equal(timers.scheduled.length, 0); assert.match((await runState(runtime, runId)).error, /configured time limit/);
});

test('maximum positive duration persists and never overflows Node timers; invalid values do not mutate settings', async t => {
  const timers = clock(t), { runtime, chat, open } = await fixture(t);
  await runtime.request('settings.update', { runTimeoutMs: 2147483647 });
  for (const value of [-1, 1, 999, 1000.5, 2147483648, Infinity, '0']) await assert.rejects(runtime.request('settings.update', { runTimeoutMs: value }));
  assert.equal((await runtime.request('state.get')).settings.runTimeoutMs, 2147483647);
  await runtime.close(); const reopened = await open();
  assert.equal((await reopened.request('state.get')).settings.runTimeoutMs, 2147483647);
  const { runId } = await reopened.request('chat.send', { chatId: chat.id, text: 'Use the largest duration' });
  assert.equal(timers.scheduled.at(-1).delay, 2147483647);
  assert.ok(timers.scheduled.every(item => item.delay > 0 && item.delay <= 2147483647));
  timers.advance(1000); assert.equal((await runState(reopened, runId)).status, 'running');
});

test('manual Stop with the overall limit Off still cancels pending tools, approvals and descendants', async t => {
  const timers = clock(t), { runtime, chat } = await fixture(t, async function* ({ messages }) {
    const task = messages.find(message => message.role === 'user')?.content;
    if (task === 'parent') { yield { type: 'tool', id: 'child', name: 'agent_create', args: { task: 'child' } }; yield { type: 'tool', id: 'hold', name: 'fixture_hold', args: {} }; }
    else yield { type: 'tool', id: 'approval', name: 'fixture_effect', args: {} };
  });
  let effects = 0;
  runtime.registerTools([
    { name: 'fixture_hold', description: 'Pending synthetic tool', permission: 'read', parameters: empty, execute: () => never },
    { name: 'fixture_effect', description: 'Unapproved synthetic effect', permission: 'files', parameters: empty, execute: () => ++effects },
  ]);
  await runtime.request('settings.update', { runTimeoutMs: 0 }); await runtime.request('chat.send', { chatId: chat.id, text: 'parent' });
  await until(runtime, state => state.runs.length === 2 && state.approvals.length === 1 && state.runs.some(run => run.toolEvents.some(event => event.name === 'fixture_hold' && event.status === 'running')));
  await runtime.request('chat.stop', { chatId: chat.id }); await runtime.request('chat.forceStop', { chatId: chat.id });
  const state = await runtime.request('state.get'); assert.ok(state.runs.every(run => run.status === 'canceled')); assert.equal(state.approvals.length, 0); assert.equal(effects, 0); assert.equal(timers.scheduled.length, 0);
});

test('completion, manual Stop and close remove timers; later setting edits cannot resurrect finished runs', async t => {
  const timers = clock(t); let answer = true;
  const { runtime, chat, options } = await fixture(t, async function* () { if (answer) yield { type: 'delta', text: 'Done.' }; else await never; });
  await runtime.request('settings.update', { runTimeoutMs: 1000 });
  const done = await runtime.request('chat.send', { chatId: chat.id, text: 'Complete normally' });
  await until(runtime, state => state.runs.some(run => run.id === done.runId && run.status === 'completed'));
  await runtime.request('settings.update', { runTimeoutMs: 2000 }); assert.equal(timers.scheduled.length, 1);
  answer = false; await runtime.request('chat.send', { chatId: chat.id, text: 'Stop manually' }); await runtime.request('chat.forceStop', { chatId: chat.id });
  await runtime.request('chat.send', { chatId: chat.id, text: 'Close while working' }); await runtime.close();
  timers.advance(100000); assert.ok(timers.scheduled.every(item => item.callback.mock.callCount() === 0));
  const state = JSON.parse(await fs.readFile(join(options.dataDir, 'state.json'), 'utf8'));
  assert.equal(state.runs[0].status, 'completed'); assert.ok(state.runs.slice(1).every(run => run.status === 'canceled')); assert.equal(state.approvals.length, 0);
});
