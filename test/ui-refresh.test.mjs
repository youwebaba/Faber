import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentDrafts } from '../renderer/file-attachments.mjs';
import { composeUISnapshot, validateUISnapshot, refreshBlocker, mergeRuntimeStreams, interfaceError } from '../renderer/ui-refresh.mjs';

const png = 'data:image/png;base64,iVBORw0KGgo=';
const view = { sidebarHidden: true, sidebarOpen: false, activityHidden: false, activityOpen: true, promptFocused: true, transcriptScroll: 52.5, activityScroll: 8, projectScroll: 0, promptSelectionStart: 1, promptSelectionEnd: 3 };
const image = { name: 'paste.png', type: 'image/png', size: 8 };
const textFile = content => ({ name: 'source.js', type: 'text/plain', size: new TextEncoder().encode(content).length, arrayBuffer: async () => new TextEncoder().encode(content).buffer });

test('refresh notices strip only the known Electron request wrapper and preserve the actual reason', () => {
  const reason = 'Backend changes are pending. Restart the app to activate them; this page and its drafts remain open.';
  assert.equal(interfaceError(new Error(`Error invoking remote method 'sophia:request': Error: ${reason}`)), reason);
  assert.equal(interfaceError(reason), reason);
  const other = "Error invoking remote method 'other:request': Error: Keep this diagnostic";
  assert.equal(interfaceError(other), other);
  assert.equal(interfaceError('Error: A meaningful application error'), 'Error: A meaningful application error');
});

test('reload snapshot round-trips all chat/new-project composer drafts with each attachment once', async () => {
  const source = createAttachmentDrafts({ readImage: async () => png });
  await source.add('chat-a', [image, textFile('const greeting = "你好";')]);
  await source.add('new:project-b', [textFile('unsent new project')]);
  const state = composeUISnapshot({ selectedChatId: null, selectedProjectId: 'project-b', drafts: new Map([['chat-a', 'Question'], ['new:project-b', 'Draft'], ['chat-c', 'Text only']]), attachments: source.snapshot(), view });
  assert.equal(state.selectedChatId, null); assert.equal(state.drafts.length, 3);
  const restored = createAttachmentDrafts(); restored.restore(state.drafts.map(({ key, attachments }) => ({ key, attachments })));
  assert.deepEqual(restored.snapshot(), source.snapshot());
  const ids = restored.snapshot().flatMap(entry => restored.get(entry.key).map(item => item.id)); assert.equal(new Set(ids).size, 3);
  await restored.add('chat-a', [textFile('newer')]); assert.equal(new Set(restored.get('chat-a').map(item => item.id)).size, 3);
  state.drafts[0].attachments[0].name = 'changed'; assert.equal(source.get('chat-a')[0].name, 'paste.png');
});

test('unsettled reads block snapshot even after pending attachment removal; restore validates atomically', async () => {
  let finish; const source = createAttachmentDrafts({ readText: () => new Promise(resolve => { finish = resolve; }) });
  const pending = source.add('old-chat', [textFile('read')]); source.remove('old-chat', [source.get('old-chat')[0].id]);
  assert.equal(source.hasPending(), true); assert.throws(() => source.snapshot(), /finish/); finish('read'); await pending; assert.equal(source.hasPending(), false);
  assert.deepEqual(source.snapshot(), []);
});

test('invalid snapshots reject duplicate drafts, secrets, bad images, limits and invalid view data', () => {
  const valid = composeUISnapshot({ selectedChatId: 'c', selectedProjectId: 'p', drafts: new Map([['c', 'draft']]), attachments: [], view });
  for (const bad of [
    { ...valid, token: 'must not travel' }, { ...valid, version: 2 }, { ...valid, drafts: [...valid.drafts, valid.drafts[0]] },
    { ...valid, view: { ...view, transcriptScroll: Infinity } }, { ...valid, view: { ...view, promptSelectionEnd: 0 } },
    { ...valid, drafts: [{ key: 'c', text: '', attachments: [{ kind: 'image', name: 'bad', image: 'data:image/png;base64,YQ==' }] }] },
    { ...valid, drafts: [{ key: 'c', text: '', attachments: Array(9).fill({ kind: 'text', name: 'file', content: '' }) }] },
  ]) assert.throws(() => validateUISnapshot(bad));
  const store = createAttachmentDrafts(); store.restore([{ key: 'kept', attachments: [{ kind: 'text', name: 'saved', content: 'keep me' }] }]);
  assert.throws(() => store.restore([{ key: 'new', attachments: [{ kind: 'text', name: 'x', content: 'new' }] }, { key: 'bad', attachments: [{ kind: 'unknown' }] }]));
  assert.equal(store.get('kept')[0].content, 'keep me'); assert.deepEqual(store.get('new'), []);
});

test('automatic refresh defers forms, Models, file chooser, reads, voice and in-flight actions', () => {
  for (const flag of ['sending', 'pendingReads', 'pendingPicker', 'pendingRequests', 'modalOpen', 'modelsOpen', 'voiceActive']) assert.ok(refreshBlocker({ [flag]: true }));
  assert.equal(refreshBlocker({ manual: true, modalOpen: true, cleanSettings: true }), '');
  assert.ok(refreshBlocker({ manual: false, modalOpen: true, cleanSettings: true }));
  assert.equal(refreshBlocker({}), '');
});

test('snapshot plus queued deltas resumes exactly once, rejects stale snapshots and clears on commit', () => {
  const streams = new Map(); let version = -1;
  version = mergeRuntimeStreams(streams, { streams: [{ runId: 'r', chatId: 'c', text: 'Hello', lastAssistantId: null, sequence: 3 }], streamSequence: 3 }, version);
  const delta = { type: 'delta', runId: 'r', chatId: 'c', text: ' world', lastAssistantId: null, sequence: 4, streamSequence: 4 };
  version = mergeRuntimeStreams(streams, delta, version); version = mergeRuntimeStreams(streams, delta, version);
  version = mergeRuntimeStreams(streams, { streams: [], streamSequence: 2 }, version); assert.equal(streams.get('r').text, 'Hello world');
  version = mergeRuntimeStreams(streams, { streams: [], streamSequence: 5 }, version); assert.equal(streams.size, 0);
  version = mergeRuntimeStreams(streams, delta, version); assert.equal(streams.size, 0);
  mergeRuntimeStreams(streams, { ...delta, text: 'Next turn', sequence: 6, streamSequence: 6, lastAssistantId: 'committed' }, version); assert.equal(streams.get('r').text, 'Next turn');
});
