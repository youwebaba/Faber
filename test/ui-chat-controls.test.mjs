import test from 'node:test';
import assert from 'node:assert/strict';
import { contextChoice, composerMetrics } from '../renderer/chat-controls.mjs';
import { chatFamily, navigationActions, deletionWarning } from '../renderer/chat-navigation.mjs';
import { relatedRuns, toolActivityLabel } from '../renderer/run-activity.mjs';
import { mergeRuntimeStreams } from '../renderer/ui-refresh.mjs';

test('context selection is explicit runtime capacity, with null preserving the model default', () => {
  assert.equal(contextChoice(''), null); assert.equal(contextChoice(null), null);
  assert.equal(contextChoice('32768'), 32768); assert.equal(contextChoice('2147483647'), 2147483647);
  for (const value of ['-1', '0', '0.5', 'NaN', 'Infinity', '2147483648']) assert.throws(() => contextChoice(value));
});
test('composer usage keeps unknown, estimated and actual counts distinct and uses captured capacity for an active call', () => {
  const unknown = composerMetrics({}, undefined); assert.equal(unknown.used, null); assert.equal(unknown.capacity, null); assert.equal(unknown.percent, null); assert.equal(unknown.rate, null);
  const controls = { contextTokens: 8192, context: { estimatedTokens: 100, capacityTokens: 4096 } };
  const idle = composerMetrics(controls, { inputTokens: 999, outputTokens: 100 }, 'new draft');
  assert.equal(idle.used, 103); assert.equal(idle.estimated, true); assert.equal(idle.capacity, 8192);
  const managed = { ...controls, context: { ...controls.context, mode: 'managed' } };
  assert.equal(composerMetrics(managed).capacity, 4096, 'A saved size must not masquerade as allocated managed capacity before restart');
  assert.equal(composerMetrics({ ...managed, context: { ...managed.context, capacityTokens: null } }).capacity, null);
  const live = composerMetrics(controls, { inputTokens: 0, outputTokens: 0, capacityTokens: 4096, tokensPerSecond: 0, tokensPerSecondEstimated: false }, '', true);
  assert.equal(live.used, 0); assert.equal(live.estimated, false); assert.equal(live.rate, 0); assert.equal(live.capacity, 4096);
  const estimated = composerMetrics(controls, { estimatedInputTokens: 4100, estimatedOutputTokens: 10, capacityTokens: 4096, tokensPerSecond: 5.5, tokensPerSecondEstimated: true }, '', true);
  assert.equal(estimated.used, 4110); assert.equal(estimated.percent, 100); assert.equal(estimated.estimated, true); assert.equal(estimated.rateEstimated, true);
  assert.equal(composerMetrics({}, { tokensPerSecond: Infinity }).rate, null);
});
test('chat navigation guards the selected chat family and never another project’s active run', () => {
  const state = { projects: [{ id: 'p' }, { id: 'old', archived: true }], chats: [{ id: 'root' }, { id: 'child', parentChatId: 'root' }, { id: 'grandchild', parentChatId: 'child' }, { id: 'other' }], runs: [{ chatId: 'other', status: 'running' }] };
  assert.deepEqual([...chatFamily(state, 'root')], ['root', 'child', 'grandchild']);
  let actions = navigationActions(state, 'chat', 'root'); assert.equal(actions.find(item => item.id === 'forceStop').disabled, true); assert.equal(actions.find(item => item.id === 'move').disabled, false);
  state.runs.push({ chatId: 'grandchild', status: 'waiting_approval' }); actions = navigationActions(state, 'chat', 'root');
  assert.equal(actions.find(item => item.id === 'forceStop').disabled, false); assert.equal(actions.find(item => item.id === 'move').disabled, true);
  assert.deepEqual(navigationActions(state, 'chat', 'missing'), []); assert.deepEqual(navigationActions(state, 'project', 'old'), []);
  assert.deepEqual(navigationActions(state, 'project', 'p').map(item => item.id), ['archive', 'delete']);
});
test('delete confirmation wording distinguishes chats and projects exactly', () => {
  assert.equal(deletionWarning('chat'), 'Are you sure you want to delete this chat? Deleted chats are not recoverable!');
  assert.equal(deletionWarning('project'), 'Are you sure you want to delete this project? Deleted chats are not recoverable!');
  assert.throws(() => deletionWarning('folder'));
});
test('expanded activity follows run ownership and displays real command or file arguments without rewriting them', () => {
  const state = { runs: [{ id: 'root' }, { id: 'child', parentRunId: 'root' }, { id: 'grandchild', parentRunId: 'child' }, { id: 'other', chatId: 'same-chat' }] };
  assert.deepEqual(relatedRuns(state, 'root').map(run => run.id), ['root', 'child', 'grandchild']);
  const command = '<script>literal command & args</script>\nsecond line';
  assert.deepEqual(toolActivityLabel({ name: 'shell_run', args: { command }, status: 'waiting_approval' }), { name: 'shell_run', detail: command, status: 'Waiting approval' });
  assert.equal(toolActivityLabel({ name: 'files_read', args: { path: 'src/index.mjs' } }).detail, 'src/index.mjs');
  assert.equal(toolActivityLabel({ name: 'other', args: { nested: { command: 'unrelated' } } }).detail, '');
});
test('live metric snapshots survive UI stream handoff and stale chunks cannot replace newer counters', () => {
  const streams = new Map(), first = { estimatedInputTokens: 100, estimatedOutputTokens: 2, tokensPerSecond: 1 };
  let version = mergeRuntimeStreams(streams, { streamSequence: 1, streams: [{ runId: 'r', lastAssistantId: 'a', text: 'A', metrics: first }] });
  const second = { ...first, estimatedOutputTokens: 3 };
  version = mergeRuntimeStreams(streams, { type: 'delta', streamSequence: 2, sequence: 2, runId: 'r', chatId: 'c', lastAssistantId: 'a', text: 'B', modelCallId: 'call', metrics: second }, version);
  assert.equal(streams.get('r').text, 'AB'); assert.equal(streams.get('r').metrics.estimatedOutputTokens, 3);
  mergeRuntimeStreams(streams, { type: 'delta', streamSequence: 1, sequence: 1, runId: 'r', text: 'stale', metrics: first }, version);
  assert.equal(streams.get('r').text, 'AB'); assert.equal(streams.get('r').metrics.estimatedOutputTokens, 3);
});
