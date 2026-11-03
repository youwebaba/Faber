import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptTimeline } from '../renderer/transcript-timeline.mjs';
import { modelDisplayName } from '../renderer/model-names.mjs';
import { preferredLocalChoice } from '../renderer/local-picker.mjs';

const at = second => `2026-11-03T00:00:${String(second).padStart(2, '0')}.000Z`;
function fixture() {
  const messages = [
    { id: 'u', role: 'user', content: 'Do two steps', createdAt: at(0) },
    { id: 'a', role: 'assistant', runId: 'r', content: 'First, read.', createdAt: at(1), toolCalls: [{ id: 'call-a', name: 'files_read', args: { path: 'a' } }] },
    { id: 'ta', role: 'tool', toolCallId: 'call-a', content: 'first result', createdAt: at(2) },
    { id: 'b', role: 'assistant', runId: 'r', content: 'Next, inspect.', createdAt: at(3), toolCalls: [{ id: 'call-b', name: 'files_read', args: { path: 'b' } }] },
    { id: 'tb', role: 'tool', toolCallId: 'call-b', content: 'second result', createdAt: at(4) },
    { id: 'final', role: 'assistant', runId: 'r', content: 'Done.', createdAt: at(5) },
    { id: 'u2', role: 'user', content: 'Continue.', createdAt: at(6) },
    { id: 'f2', role: 'assistant', runId: 'r2', content: 'Continued.', createdAt: at(8) },
  ];
  return { chats: [{ id: 'c', messages }], approvals: [], runs: [
    { id: 'r', chatId: 'c', status: 'completed', startedAt: at(0), requestMessageId: 'u', toolEvents: [
      { id: 'ea', toolCallId: 'call-a', name: 'files_read', args: { path: 'a' }, result: 'first result', status: 'completed', startedAt: at(1) },
      { id: 'eb', toolCallId: 'call-b', name: 'files_read', args: { path: 'b' }, result: 'second result', status: 'completed', startedAt: at(3) },
    ] }, { id: 'r2', chatId: 'c', status: 'completed', startedAt: at(6), requestMessageId: 'u2', toolEvents: [] },
  ] };
}
const order = rows => rows.map(row => row.kind === 'message' ? row.message.id : `${row.kind}:${row.key}`);

test('tool batches interleave with their assistant output and stay before final/continuation replies exactly once', () => {
  const state = fixture(), rows = transcriptTimeline(state, 'c');
  assert.deepEqual(order(rows), ['u', 'a', 'activity:r:step:0', 'b', 'activity:r:step:1', 'final', 'u2', 'f2']);
  assert.deepEqual(rows.filter(row => row.kind === 'activity').map(row => row.activity.events.map(event => event.id)), [['ea'], ['eb']]);
  assert.ok(!rows.some(row => row.message?.role === 'tool'), 'Represented tool results appear in the activity only');
});
test('old histories without correlation fields retain chronological batches using ordered calls', () => {
  const state = fixture(); for (const run of state.runs) for (const event of run.toolEvents) delete event.toolCallId;
  for (const message of state.chats[0].messages) delete message.runId;
  assert.deepEqual(order(transcriptTimeline(state, 'c')), ['u', 'a', 'activity:r:step:0', 'b', 'activity:r:step:1', 'final', 'u2', 'f2']);
});
test('live pending command, approval and streamed response use the same chronological slot and stable activity key', () => {
  const state = fixture(); state.chats[0].messages.length = 2; state.runs.length = 1; const run = state.runs[0]; run.status = 'waiting_approval'; run.toolEvents.length = 0;
  state.approvals.push({ id: 'approval', runId: run.id });
  let rows = transcriptTimeline(state, 'c'); assert.equal(rows.at(-1).activity.events[0].status, 'queued'); assert.equal(rows.at(-1).activity.approvals.length, 1);
  const key = rows.at(-1).key;
  run.toolEvents.push({ id: 'actual', toolCallId: 'call-a', name: 'files_read', status: 'completed', result: 'read' }); run.status = 'running'; state.approvals = [];
  rows = transcriptTimeline(state, 'c', new Map([['r', { text: 'Live reply', lastAssistantId: 'a' }]]));
  assert.deepEqual(order(rows), ['u', 'a', `activity:${key}`, 'stream:r']); assert.equal(rows.at(-2).activity.events[0].id, 'actual');
});
test('child activity belongs only to its spawning batch; manual tools and unmatched historical tool messages remain available', () => {
  const state = fixture(); state.runs[0].toolEvents[0].result = { runId: 'child' };
  state.runs.push({ id: 'child', chatId: 'child-chat', parentRunId: 'r', status: 'running', startedAt: at(2), toolEvents: [{ id: 'ec', name: 'shell_run' }] });
  state.runs.push({ id: 'manual', chatId: 'c', status: 'completed', startedAt: at(7), toolEvents: [{ id: 'em', name: 'files_list', status: 'completed', startedAt: at(7) }] });
  state.chats[0].messages.push({ id: 'legacy-result', role: 'tool', toolCallId: 'missing-call', content: 'Keep me', createdAt: at(9) });
  const rows = transcriptTimeline(state, 'c'), activities = rows.filter(row => row.kind === 'activity');
  assert.deepEqual(activities.map(row => row.activity.childRuns.map(run => run.id)), [['child'], [], []]);
  assert.ok(activities[0].activity.active); assert.ok(order(rows).indexOf('activity:manual:event:em') < order(rows).indexOf('f2'));
  assert.equal(rows.at(-1).message.id, 'legacy-result');
});
test('friendly model names require exact provider and transport identity, and never guess from a hash', () => {
  const labels = [{ providerId: 'local', model: 'faber-123', displayName: 'Qwen3.5-9B-Q4_K_M.gguf' }];
  assert.equal(modelDisplayName('local', 'faber-123', labels), 'Qwen3.5-9B-Q4_K_M.gguf');
  assert.equal(modelDisplayName('cloud', 'faber-123', labels), 'faber-123');
  assert.equal(modelDisplayName('local', 'faber-456', labels), 'faber-456');
  assert.equal(modelDisplayName('api', 'qwen:9b', labels), 'qwen:9b');
});
test('stopped local selection uses the host-provided scanner ID, not a hash inferred from the model name', () => {
  const selected = { source: 'download', id: 'scanner-file', value: 'download:scanner-file' }, other = { source: 'download', id: 'other-file', value: 'download:other-file' };
  const state = { process: { status: 'stopped' }, managedProviderId: 'managed', modelLabels: [{ providerId: 'managed', model: 'faber-alias', modelId: 'scanner-file', displayName: 'Qwen.gguf' }] };
  assert.equal(preferredLocalChoice(state, [other, selected], undefined, 'faber-alias', ''), selected);
  assert.equal(preferredLocalChoice(state, [other, selected], { id: 'different' }, 'faber-alias', ''), undefined);
  assert.equal(preferredLocalChoice(state, [other, selected], undefined, 'faber-alias', other.value), other);
  assert.equal(preferredLocalChoice({ ...state, process: { status: 'ready', modelId: other.id } }, [other], undefined, 'faber-alias', ''), undefined, 'A removed model must not silently select a different loaded model');
});
