import test from 'node:test';
import assert from 'node:assert/strict';
import { safeImage, parseArguments, extensionActions, reconcileStreams, streamText, latestRun, visibleChats, sameMessage, chatApprovals } from '../renderer/ui-helpers.mjs';

test('screenshots accept inert raster data and reject active or remote sources', () => {
  assert.equal(safeImage('data:image/png;base64,aGVsbG8='), 'data:image/png;base64,aGVsbG8=');
  for (const value of ['javascript:alert(1)', 'https://example.com/tracker.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,a" onerror="x', null]) assert.equal(safeImage(value), null);
});

test('manual tool JSON must be an object and preserves nested upgrade arrays', () => {
  assert.deepEqual(parseArguments('{"changes":[{"path":"renderer/app.mjs","content":"hello"}]}'), { changes: [{ path: 'renderer/app.mjs', content: 'hello' }] });
  for (const value of ['null', '[]', '1', '"text"', '{bad}']) assert.throws(() => parseArguments(value));
});

test('streamed copy disappears on commit and the next tool-loop turn starts clean', () => {
  const run = { id: 'r1', chatId: 'c1', status: 'running', startedAt: '2026-10-31T00:00:00.000Z' };
  const state = { runs: [run], chats: [{ id: 'c1', messages: [{ id: 'old', role: 'assistant', content: 'Previous reply' }] }] };
  const streams = new Map([['r1', { text: 'Checking files', lastAssistantId: 'old' }]]);
  reconcileStreams(streams, state); assert.equal(streams.get('r1').text, 'Checking files');
  state.chats[0].messages.push({ id: 'new', role: 'assistant', content: 'Checking files', createdAt: run.startedAt });
  reconcileStreams(streams, state); assert.equal(streams.size, 0);
  assert.equal(streamText('Checking files', run, state.chats[0].messages), '');
  streams.set('r1', { text: 'Found', lastAssistantId: 'new' }); reconcileStreams(streams, state); assert.equal(streams.get('r1').text, 'Found');
  run.status = 'canceled'; reconcileStreams(streams, state); assert.equal(streams.size, 0); assert.equal(streamText('Found', run, []), '');
});

test('extension actions use registry metadata and disappear when unloaded', () => {
  const extension = { id: 'summary', name: 'Workspace summary', actions: [{ id: 'inspect', label: 'Inspect workspace', tool: 'workspace_summary', fields: [] }] };
  assert.deepEqual(extensionActions([extension]), [{ ...extension.actions[0], extensionName: 'Workspace summary' }]);
  assert.deepEqual(extensionActions([]), []);
  assert.deepEqual(extensionActions([{ actions: [{ label: 'Broken' }, { tool: 'missing_label' }] }]), []);
});

test('navigation excludes archives and run selection is scoped to the chat', () => {
  const state = { chats: [{ id: 'a', projectId: 'p', archived: false }, { id: 'b', projectId: 'p', archived: true }, { id: 'c', projectId: 'other' }], runs: [{ id: 'r1', chatId: 'a' }, { id: 'r2', chatId: 'b' }, { id: 'r3', chatId: 'a' }] };
  assert.deepEqual(visibleChats(state, 'p').map(chat => chat.id), ['a']);
  assert.equal(latestRun(state, 'a').id, 'r3');
});

test('unchanged state snapshots reuse message DOM while edits and attribution invalidate it', () => {
  const message = { id: 'm1', role: 'assistant', content: 'Hello', status: 'completed', toolCalls: [{ name: 'files_list', args: {} }] };
  assert.equal(sameMessage(message, structuredClone(message)), true);
  for (const change of [{ content: 'Edited' }, { status: 'failed' }, { fromChatId: 'agent' }, { toolCalls: [] }, { image: 'data:image/png;base64,aA==' }]) assert.equal(sameMessage(message, { ...message, ...change }), false);
  assert.equal(sameMessage(undefined, message), false);
});

test('parent chat exposes nested agent approvals without unrelated permissions', () => {
  const state = { runs: [{ id: 'parent', chatId: 'c1' }, { id: 'child', chatId: 'c2', parentRunId: 'parent' }, { id: 'grandchild', chatId: 'c3', parentRunId: 'child' }, { id: 'unrelated', chatId: 'c4' }], approvals: [{ id: 'a', chatId: 'c1', runId: 'parent' }, { id: 'b', chatId: 'c3', runId: 'grandchild' }, { id: 'c', chatId: 'c4', runId: 'unrelated' }] };
  assert.deepEqual(chatApprovals(state, 'c1').map(item => item.id), ['a', 'b']);
  assert.deepEqual(chatApprovals(state, 'c2').map(item => item.id), ['b']);
  assert.deepEqual(chatApprovals(state, 'missing'), []);
});
