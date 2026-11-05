import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteWorkspace, remoteChat, remoteLive, remoteChatFamilies, lastSeenLabel, remoteEvent } from '../renderer/remote-state.mjs';
import { createRemoteWorkspace } from '../renderer/remote-workspace.mjs';

test('remote metadata has no local path, provider, extension or executable action surface', () => {
  const value = remoteWorkspace({ projects: [{ id: 'p', name: '<img onerror=x>', path: 'private-path', archived: false }], chats: [{ id: 'c', projectId: 'p', title: '<script>x</script>', grants: ['shell'], providerId: 'host-provider' }], extensions: [{ actions: ['bad'] }], providers: [{ apiKey: 'fixture-key-not-real' }], nextOffset: null, revision: 'v1' });
  assert.equal(value.projects[0].name, '<img onerror=x>'); assert.equal(value.chats[0].title, '<script>x</script>');
  assert.equal(JSON.stringify(value).includes('private-path'), false); assert.equal(JSON.stringify(value).includes('fixture-key-not-real'), false); assert.equal(Object.hasOwn(value, 'providers'), false); assert.equal(Object.hasOwn(value.chats[0], 'grants'), false);
  const detail = remoteChat({ chat: { id: 'c', readOnly: true, messages: [{ id: 'm', role: 'assistant', content: '**Safe** <script>x</script>', images: 'bad', toolCalls: {}, sourceMessageId: 'request', modelCallId: 'call' }], grants: ['shell'], path: 'private-path' }, runs: [{ id: 'r', chatId: 'c', parentRunId: 'parent-run', requestMessageId: 'request', toolEvents: {}, modelCalls: {} }], approvals: [{ id: 'a', chatId: 'c', runId: 'r', permission: 'shell', rememberable: true }] }, 'c');
  assert.deepEqual(detail.chat.messages[0].images, []); assert.deepEqual(detail.runs[0].toolEvents, []); assert.deepEqual(detail.runs[0].modelCalls, []); assert.equal(detail.approvals[0].rememberable, false); assert.equal(Object.hasOwn(detail.chat, 'path'), false);
  assert.equal(detail.chat.readOnly, true); assert.equal(detail.chat.messages[0].sourceMessageId, 'request'); assert.equal(detail.chat.messages[0].modelCallId, 'call'); assert.equal(detail.runs[0].parentRunId, 'parent-run'); assert.equal(detail.runs[0].requestMessageId, 'request');
  assert.throws(() => remoteChat({ chat: { id: 'other', messages: [] } }, 'c'), /invalid chat/);
  assert.throws(() => remoteWorkspace({ projects: {}, chats: [] }), /invalid workspace/);
});

test('remote family navigation includes archived agents on request and uses host reply ordering', () => {
  const workspace = { chats: [{ id: 'parent', projectId: 'p', title: 'Parent', createdAt: '2026-01-01', lastAssistantAt: '2026-03-01' }, { id: 'child', projectId: 'p', parentChatId: 'parent', createdAt: '2026-04-01', archived: true }, { id: 'other', projectId: 'p', createdAt: '2026-02-01' }, { id: 'cycle', projectId: 'p', parentChatId: 'cycle' }] };
  assert.deepEqual(remoteChatFamilies(workspace, 'p', false).map(({ chat }) => chat.id), ['parent', 'other', 'cycle']);
  assert.deepEqual(remoteChatFamilies(workspace, 'p', true).map(({ chat, depth }) => [chat.id, depth]), [['parent', 0], ['child', 1], ['other', 0], ['cycle', 0]]);
  assert.equal(workspace.chats[1].archived, true);
});

test('connection timestamps and remote event envelopes do not confuse local or other-host events', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(lastSeenLabel(now - 120000, now), 'Last seen 2 min ago'); assert.equal(lastSeenLabel('2026-11-05T11:00:00Z', now), 'Last seen 1 hr ago'); assert.equal(lastSeenLabel(null, now), 'Never connected');
  assert.equal(remoteEvent({ type: 'state', state: {} }, 'host'), null); assert.equal(remoteEvent({ type: 'remoteWorkspace', deviceId: 'other', event: { type: 'delta' } }, 'host'), null);
  assert.deepEqual(remoteEvent({ type: 'remoteWorkspace', deviceId: 'host', event: { type: 'delta' } }, 'host'), { type: 'delta' });
});

test('live-only host updates require the selected chat and carry streams without durable metadata', () => {
  const value = { liveOnly: true, chatId: 'chat', revision: 'next-revision', streams: [{ runId: 'run', chatId: 'chat', text: 'New streamed text', phase: 'responding', sequence: 4 }], chat: { messages: ['must not replace saved history'] }, approvals: ['must not replace approval state'] };
  const result = remoteLive(value, 'chat'); assert.equal(result.revision, 'next-revision'); assert.equal(result.streams[0].text, 'New streamed text'); assert.equal(Object.hasOwn(result, 'chat'), false); assert.equal(Object.hasOwn(result, 'approvals'), false);
  assert.throws(() => remoteLive(value, 'other'), /invalid live chat/); assert.throws(() => remoteLive({ ...value, streams: {} }, 'chat'), /invalid live chat/); assert.throws(() => remoteLive({ ...value, revision: undefined }, 'chat'), /invalid live chat/);
});

class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.events = {}; this.dataset = {}; this.attributes = {}; this.style = {}; this.value = ''; this.hidden = false; this.className = ''; this._text = ''; this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100; this.isConnected = true; this.classList = { contains: name => this.className.split(' ').includes(name), add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; }, remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); }, toggle: (name, enabled) => enabled ? this.classList.add(name) : this.classList.remove(name) }; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
  insertBefore(node, before) { node.remove(); node.parentElement = this; const at = this.children.indexOf(before); if (at < 0) this.children.push(node); else this.children.splice(at, 0, node); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  get childNodes() { return this.children; } get firstChild() { return this.children[0]; } get lastChild() { return this.children.at(-1); }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); } set textContent(value) { this.children = []; this._text = String(value); }
  set innerHTML(_value) { throw new Error('Untrusted remote text reached HTML'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.events[name] = callback; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) { return this.children.flatMap(node => [node, ...node.querySelectorAll('*')]).filter(node => selector === '*' || selector.startsWith('#') ? selector === '*' || node.id === selector.slice(1) : selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tagName === selector.toUpperCase()); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { top: 0, bottom: 10 }; }
}
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const document = { activeElement: null, createElement(tag) { return new Element(tag, this); }, createTextNode(text) { const node = this.createElement('text'); node.textContent = text; return node; }, querySelector(selector) { return this.body.querySelector(selector); } };
  document.body = document.createElement('body'); const local = document.createElement('main'); local.className = 'shell'; const localPrompt = document.createElement('textarea'); localPrompt.id = 'prompt'; localPrompt.value = 'Keep my local draft'; local.append(localPrompt); document.body.append(local);
  const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls || ''; if (text !== undefined) node.textContent = text; return node; };
  const calls = [], devices = [{ id: 'host', name: '<literal host>', online: true }, { id: 'other', name: 'Other host', online: true }]; let listener;
  const projects = [{ id: 'p', name: '<img onerror=x>', archived: false }, { id: 'old', name: 'Archived project', archived: true }];
  const chats = [{ id: 'c', projectId: 'p', title: 'Parent' }, { id: 'child', projectId: 'p', title: 'Agent', parentChatId: 'c' }, { id: 'archived', projectId: 'old', title: 'Old chat', archived: true }];
  const messages = [{ id: 'm', role: 'assistant', content: '**Remote response** <script>literal</script>' }];
  const request = async (method, params) => { calls.push({ method, params }); assert.equal(method, 'remote.request'); if (!devices.find(device => device.id === params.deviceId)?.online) throw new Error('Fixture host offline'); if (params.method === 'workspace.list') return { projects, chats: params.params.offset ? chats.slice(1) : chats.slice(0, 1), nextOffset: params.params.offset ? null : 1, revision: 'directory' };
    if (params.method === 'chat.read') return params.params.since ? { unchanged: true, revision: 'chat' } : { chat: { ...chats.find(chat => chat.id === params.params.chatId), messages }, runs: [], approvals: [], streams: [], before: null, revision: 'chat' };
    if (params.method === 'chat.send') { messages.push({ id: 'sent', role: 'user', content: params.params.text }); return { runId: 'r' }; } return {};
  };
  const workspace = createRemoteWorkspace({ request, subscribe: callback => { listener = callback; }, el, document, getDevices: () => devices, showConnections() {} });
  return { workspace, document, local, localPrompt, calls, devices, chats, emit: event => listener(event), get: id => document.querySelector(`#${id}`) };
}

test('remote workspace paginates, preserves local drafts, isolates events and never sends offline actions locally', async () => {
  const previousDocument = globalThis.document, f = fixture(); globalThis.document = f.document;
  try {
    f.workspace.open('host'); await flush(); assert.equal(f.local.inert, true); assert.equal(f.get('remote-projects').querySelectorAll('button').length, 3); assert.equal(f.localPrompt.value, 'Keep my local draft');
    const chat = f.get('remote-projects').querySelectorAll('button').find(node => node.dataset.remoteChatId === 'c'); await chat.events.click(); await flush();
    const transcript = f.get('remote-transcript'); assert.ok(transcript.textContent.includes('Remote response')); assert.ok(transcript.textContent.includes('<script>literal</script>')); const node = transcript.querySelector('article');
    f.emit({ type: 'state', state: { chats: [] } }); f.emit({ type: 'remoteWorkspace', deviceId: 'other', event: { type: 'delta', text: 'Other host' } }); assert.equal(transcript.querySelector('article'), node);
    const prompt = f.get('remote-prompt'); prompt.value = 'Follow up remotely'; prompt.events.input(); f.get('remote-composer').events.submit({ preventDefault() {} }); await flush();
    const sent = f.calls.find(call => call.params.method === 'chat.send'); assert.equal(sent.params.deviceId, 'host'); assert.equal(sent.params.params.text, 'Follow up remotely'); assert.match(sent.params.requestId, /^[\da-f-]{36}$/i);
    prompt.value = 'Keep remote draft'; prompt.events.input(); f.devices[0].online = false; f.workspace.updateDevices(); assert.equal(prompt.disabled, true); assert.equal(f.get('remote-send').disabled, true);
    const before = f.calls.length; f.get('remote-composer').events.submit({ preventDefault() {} }); await flush(); assert.equal(f.calls.length, before); assert.equal(prompt.value, 'Keep remote draft');
    f.workspace.close(); assert.equal(f.local.hidden, false); assert.equal(f.local.inert, false); assert.equal(f.localPrompt.value, 'Keep my local draft');
    f.workspace.open('host'); await flush(); assert.equal(prompt.value, 'Keep remote draft'); assert.equal(prompt.disabled, true); assert.ok(f.workspace.refreshReason());
    const beforeClear = f.calls.length; await f.get('remote-clear-draft').events.click(); assert.equal(prompt.value, ''); assert.equal(f.workspace.hasDrafts(), false); assert.equal(f.calls.length, beforeClear); assert.equal(f.localPrompt.value, 'Keep my local draft');
    assert.ok(f.calls.every(call => call.method === 'remote.request'));
  } finally { f.workspace.close(); globalThis.document = previousDocument; }
});

test('host-managed read-only chats keep viewing available and disable mutations and model selection', async () => {
  const previousDocument = globalThis.document, f = fixture(); globalThis.document = f.document; f.chats[0].readOnly = true;
  try { f.workspace.open('host'); await flush(); await f.get('remote-projects').querySelectorAll('button').find(node => node.dataset.remoteChatId === 'c').events.click(); await flush(); assert.ok(f.get('remote-transcript').textContent.includes('Remote response')); assert.equal(f.get('remote-prompt').disabled, true); assert.equal(f.get('remote-send').disabled, true); assert.equal(f.get('remote-choose-model').disabled, true); assert.equal(f.get('remote-new-chat').disabled, false); }
  finally { f.workspace.close(); globalThis.document = previousDocument; }
});
