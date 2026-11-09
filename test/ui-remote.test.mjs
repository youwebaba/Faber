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
  replaceWith(node) { const parent = this.parentElement; if (parent) { parent.insertBefore(node, this); this.remove(); } }
  get childNodes() { return this.children; } get firstChild() { return this.children[0]; } get lastChild() { return this.children.at(-1); }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); } set textContent(value) { this.children = []; this._text = String(value); }
  set innerHTML(_value) { throw new Error('Untrusted remote text reached HTML'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') delete this.src; }
  pause() { this.paused = true; this.pauseCalls = (this.pauseCalls || 0) + 1; }
  load() { this.loadCalls = (this.loadCalls || 0) + 1; }
  addEventListener(name, callback) { this.events[name] = callback; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) { return this.children.flatMap(node => [node, ...node.querySelectorAll('*')]).filter(node => selector === '*' || selector.startsWith('#') ? selector === '*' || node.id === selector.slice(1) : selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tagName === selector.toUpperCase()); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { top: 0, bottom: 10 }; }
}
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=';
function fixture({ imageReferences = false, mediaReferences = false, steering = false, loseSteerReply, contentMenu, sendGate, imageGate, imageFailure,capabilities } = {}) {
  const document = { activeElement: null, createElement(tag) { return new Element(tag, this); }, createTextNode(text) { const node = this.createElement('text'); node.textContent = text; return node; }, querySelector(selector) { return this.body.querySelector(selector); } };
  document.body = document.createElement('body'); const local = document.createElement('div'); local.className = 'shell'; const sidebar = document.createElement('aside'); sidebar.id = 'sidebar'; const navigation = document.createElement('nav'); navigation.id = 'project-list'; sidebar.append(navigation); const workspacePane = document.createElement('main'); workspacePane.className = 'workspace'; const localPrompt = document.createElement('textarea'); localPrompt.id = 'prompt'; localPrompt.value = 'Keep my local draft'; workspacePane.append(localPrompt); local.append(sidebar, workspacePane); document.body.append(local);
  const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls || ''; if (text !== undefined) node.textContent = text; return node; };
  const calls = [], devices = [{ id: 'host', name: '<literal host>', online: true }, { id: 'other', name: 'Other host', online: true }]; let listener;
  const projects = [{ id: 'p', name: '<img onerror=x>', archived: false }, { id: 'old', name: 'Archived project', archived: true }];
  const chats = [{ id: 'c', projectId: 'p', title: 'Parent' }, { id: 'child', projectId: 'p', title: 'Agent', parentChatId: 'c' }, { id: 'archived', projectId: 'old', title: 'Old chat', archived: true }];
  const messages = [{ id: 'm', role: 'assistant', content: '**Remote response** <script>literal</script>' }];
  const runs = [];
  const request = async (method, params) => { calls.push({ method, params }); if (method === 'media.release') return { released: true }; assert.equal(method, 'remote.request'); if (!devices.find(device => device.id === params.deviceId)?.online) throw new Error('Fixture host offline'); if (params.method === 'workspace.list') return capabilities&&params.params.since?{unchanged:true,revision:'directory',capabilities}:{ projects, chats: params.params.offset ? chats.slice(1) : chats.slice(0, 1), nextOffset: params.params.offset ? null : 1, revision: 'directory', ...(capabilities?{capabilities}:imageReferences || mediaReferences || steering ? { capabilities: { imageReferences, mediaReferences, steering } } : {}) };
    if (params.method === 'chat.read') return params.params.since ? { unchanged: true, revision: 'chat' } : { chat: { ...chats.find(chat => chat.id === params.params.chatId), messages }, runs, approvals: [], streams: [], before: null, revision: 'chat' };
    if (params.method === 'chat.image') { if (imageGate) await imageGate; if (imageFailure?.value) throw new Error('Synthetic image read failed'); return { imageId: params.params.imageId, image }; }
    if (params.method === 'chat.steer') { if (loseSteerReply?.value) { loseSteerReply.value=false; throw new Error('Host reply lost'); } return {runId:params.params.runId,status:'applied'}; }
    if (params.method === 'chat.send') { if (sendGate) await sendGate; messages.push({ id: 'sent', role: 'user', content: params.params.text }); return { runId: 'r' }; } return {};
  };
  const workspace = createRemoteWorkspace({ request, subscribe: callback => { listener = callback; }, el, document, contentMenu, getDevices: () => devices, showConnections() {} });
  workspace.updateDevices();
  return { workspace, document, local, sidebar, localPrompt, calls, devices, chats, messages, runs, emit: event => listener(event), get: id => document.querySelector(`#${id}`), row: (deviceId, chatId) => navigation.querySelectorAll('button').find(node => node.dataset.remoteDeviceId === deviceId && node.dataset.remoteChatId === chatId) };
}

test('scene, live viewing and Work Inbox capabilities remain conditional on initial and unchanged directory refreshes',async()=>{
  const prior=globalThis.document,capabilities={imageReferences:true,mediaReferences:true,sceneReferences:true,liveCapture:true,workInbox:true},f=fixture({capabilities});globalThis.document=f.document;
  try{
    await flush();await f.row('host','c').events.click();await flush();assert.equal(f.get('remote-watch-live').hidden,false);assert.equal(f.get('remote-work-inbox').hidden,false);assert.ok(f.calls.some(call=>call.params?.method==='chat.read'&&call.params.params.sceneMode==='references'));
    capabilities.sceneReferences=capabilities.liveCapture=capabilities.workInbox=false;f.workspace.updateDevices();await flush();assert.equal(f.get('remote-watch-live').hidden,true);assert.equal(f.get('remote-work-inbox').hidden,true);
    capabilities.sceneReferences=capabilities.liveCapture=capabilities.workInbox=true;f.workspace.updateDevices();await flush();assert.equal(f.get('remote-watch-live').hidden,false);assert.equal(f.get('remote-work-inbox').hidden,false);assert.ok(f.calls.some(call=>call.params?.method==='workspace.list'&&call.params.params.since==='directory'));
  }finally{f.workspace.dispose();globalThis.document=prior;}
});

test('paired steering targets the selected run, retains the draft after a lost reply and reconciles one correction',async()=>{
  const prior=globalThis.document, f=fixture({steering:true,loseSteerReply:{value:true}});globalThis.document=f.document;
  f.runs.push({id:'active',chatId:'c',status:'running',modelCalls:[{id:'call',status:'running',metrics:{generatedOutputTokens:17,outputTokensStatus:'estimated'}}]});
  try{
    await flush(); await f.row('host','c').events.click(); await flush();
    assert.equal(f.get('remote-steer').hidden,false);
    assert.match(f.get('remote-transcript').textContent,/≈ 17 output tokens/);
    const prompt=f.get('remote-prompt');prompt.value='Change the filename';prompt.events.input();
    await f.get('remote-steer').events.click();await flush();assert.equal(prompt.value,'Change the filename');
    await f.get('remote-steer').events.click();await flush();
    const calls=f.calls.filter(item=>item.params.method==='chat.steer').map(item=>item.params.params);
    assert.equal(calls.length,2);assert.equal(calls[0].correctionId,calls[1].correctionId);assert.equal(calls[0].runId,'active');
    assert.equal(prompt.value,'');assert.equal(f.calls.filter(item=>item.params.method==='chat.send').length,0);
  }finally{f.workspace.dispose();globalThis.document=prior;}
});

test('remote workspace paginates, preserves local drafts, isolates events and never sends offline actions locally', async () => {
  const previousDocument = globalThis.document, f = fixture(); globalThis.document = f.document;
  try {
    f.workspace.open('host'); await flush(); assert.notEqual(f.local.inert, true); assert.equal(f.sidebar.hidden, false); assert.equal(f.get('remote-projects').querySelectorAll('button').filter(node => node.dataset.remoteChatId).length, 4); assert.equal(f.localPrompt.value, 'Keep my local draft');
    const chat = f.get('remote-projects').querySelectorAll('button').find(node => node.dataset.remoteChatId === 'c'); await chat.events.click(); await flush();
    const transcript = f.get('remote-transcript'); assert.ok(transcript.textContent.includes('Remote response')); assert.ok(transcript.textContent.includes('<script>literal</script>')); const node = transcript.querySelector('article');
    f.emit({ type: 'state', state: { chats: [] } }); f.emit({ type: 'remoteWorkspace', deviceId: 'other', event: { type: 'delta', text: 'Other host' } }); assert.equal(transcript.querySelector('article'), node);
    const prompt = f.get('remote-prompt'); prompt.value = 'Follow up remotely'; prompt.events.input(); f.get('remote-composer').events.submit({ preventDefault() {} }); await flush();
    const sent = f.calls.find(call => call.params.method === 'chat.send'); assert.equal(sent.params.deviceId, 'host'); assert.equal(sent.params.params.text, 'Follow up remotely'); assert.match(sent.params.requestId, /^[\da-f-]{36}$/i);
    prompt.value = 'Keep remote draft'; prompt.events.input(); f.devices[0].online = false; f.workspace.updateDevices(); assert.equal(prompt.disabled, true); assert.equal(f.get('remote-send').disabled, true);
    const before = f.calls.filter(call => call.params.method === 'chat.send').length; f.get('remote-composer').events.submit({ preventDefault() {} }); await flush(); assert.equal(f.calls.filter(call => call.params.method === 'chat.send').length, before); assert.equal(prompt.value, 'Keep remote draft');
    f.workspace.close(); assert.equal(f.local.hidden, false); assert.notEqual(f.local.inert, true); assert.equal(f.localPrompt.value, 'Keep my local draft'); assert.ok(f.row('host', 'c'));
    f.workspace.open('host'); await flush(); assert.equal(prompt.value, 'Keep remote draft'); assert.equal(prompt.disabled, true); assert.ok(f.workspace.refreshReason());
    const beforeClear = f.calls.length; await f.get('remote-clear-draft').events.click(); assert.equal(prompt.value, ''); assert.equal(f.workspace.hasDrafts(), false); assert.equal(f.calls.length, beforeClear); assert.equal(f.localPrompt.value, 'Keep my local draft');
    assert.ok(f.calls.every(call => ['remote.request', 'media.release'].includes(call.method)));
    assert.ok(f.calls.filter(call => call.params.method === 'chat.read').every(call => !Object.hasOwn(call.params.params, 'imageMode')));
  } finally { f.workspace.dispose(); globalThis.document = previousDocument; }
});

test('host-managed read-only chats keep viewing available and disable mutations and model selection', async () => {
  const previousDocument = globalThis.document, f = fixture(); globalThis.document = f.document; f.chats[0].readOnly = true;
  try { f.workspace.open('host'); await flush(); await f.get('remote-projects').querySelectorAll('button').find(node => node.dataset.remoteChatId === 'c').events.click(); await flush(); assert.ok(f.get('remote-transcript').textContent.includes('Remote response')); assert.equal(f.get('remote-prompt').disabled, true); assert.equal(f.get('remote-send').disabled, true); assert.equal(f.get('remote-choose-model').disabled, true); assert.equal(f.get('remote-new-chat').disabled, false); }
  finally { f.workspace.dispose(); globalThis.document = previousDocument; }
});

test('negotiated host media keeps native players stable, binds child ownership, and releases sources offline', async () => {
  const previousDocument = globalThis.document, contexts = [], f = fixture({ mediaReferences: true, contentMenu: { bind: (_node, context) => contexts.push(context), close() {} } }); globalThis.document = f.document;
  const audio = { id: '11111111-1111-4111-8111-111111111111', kind: 'audio', mimeType: 'audio/wav', bytes: 16044, name: 'sample.wav' }, video = { ...audio, id: '22222222-2222-4222-8222-222222222222', kind: 'video', mimeType: 'video/webm', name: 'sample.webm' };
  f.messages[0].mediaRefs = [audio];
  f.runs.push({ id: 'parent-run', chatId: 'c', status: 'completed', toolEvents: [] }, { id: 'child-run', chatId: 'child', parentRunId: 'parent-run', status: 'completed', toolEvents: [{ id: 'child-media', name: 'media_show', status: 'completed', mediaRefs: [video] }] });
  try {
    f.workspace.open('host'); await flush(); await f.row('host', 'c').events.click(); await flush();
    assert.ok(f.calls.filter(call => call.params.method === 'chat.read').every(call => call.params.params.mediaMode === 'references' && !Object.hasOwn(call.params.params, 'imageMode')));
    const transcript = f.get('remote-transcript'), player = transcript.querySelector('audio'), child = transcript.querySelector('video'); assert.ok(player, f.get('remote-notice').textContent); assert.ok(child);
    assert.equal(player.src, `faber://app/media/c/${audio.id}?deviceId=host`); assert.equal(child.src, `faber://app/media/child/${video.id}?deviceId=host`); assert.ok(contexts.some(context => context.chatId === 'child' && context.deviceId === 'host' && context.mediaId === video.id));
    player.currentTime = 0.4; player.paused = false; player.volume = 0.25;
    f.emit({ type: 'remoteWorkspace', deviceId: 'host', event: { type: 'delta', streamSequence: 1, sequence: 1, runId: 'parent-run', chatId: 'c', text: 'Fixture update' } });
    assert.equal(transcript.querySelector('audio'), player); assert.equal(player.currentTime, 0.4); assert.equal(player.paused, false); assert.equal(player.volume, 0.25);
    f.devices[0].online = false; f.workspace.updateDevices(); assert.equal(player.paused, true); assert.equal(player.src, undefined); assert.ok(transcript.textContent.includes('Connect to the host to play this media.'));
    assert.ok(f.calls.some(call => call.method === 'media.release' && call.params.chatId === 'child' && call.params.deviceId === 'host'));
    assert.ok(f.calls.some(call => call.method === 'media.release' && call.params.chatId === 'c' && call.params.deviceId === 'host'));
  } finally { f.workspace.dispose(); globalThis.document = previousDocument; }
});

test('every paired host stays in main navigation with qualified routes, offline rows, accessible details and separate drafts', async () => {
  const previousDocument = globalThis.document, f = fixture(); globalThis.document = f.document;
  try {
    await flush(); assert.equal(f.workspace.isOpen(), false); assert.ok(f.sidebar.contains(f.row('host', 'c'))); assert.ok(f.row('other', 'c'));
    const row = f.row('host', 'c'), child = f.row('host', 'child'); assert.notEqual(row.dataset.remoteKey, f.row('other', 'c').dataset.remoteKey); assert.equal(row.style.paddingLeft, '32px'); assert.equal(child.style.paddingLeft, '47px'); assert.ok(row.querySelector('.remote-globe')); assert.match(row.title, /Parent.*Project: <img onerror=x>.*Device: <literal host>/); assert.equal(row.attributes['aria-describedby'], row.querySelector('.remote-chat-tooltip').id);
    await row.events.click(); await flush(); const prompt = f.get('remote-prompt'); prompt.value = 'First host draft'; prompt.events.input();
    await f.row('other', 'c').events.click(); await flush(); assert.equal(prompt.value, ''); prompt.value = 'Second host draft'; prompt.events.input();
    f.get('remote-composer').events.submit({ preventDefault() {} }); await flush(); const sent = f.calls.find(call => call.params.method === 'chat.send'); assert.equal(sent.params.deviceId, 'other'); assert.equal(sent.params.params.chatId, 'c');
    await f.row('host', 'c').events.click(); await flush(); assert.equal(prompt.value, 'First host draft'); f.devices[0].online = false; f.workspace.updateDevices(); await flush(); assert.ok(f.row('host', 'c')); assert.match(f.row('host', 'c').title, /Offline/); assert.ok(f.row('other', 'c')); assert.equal(prompt.disabled, true);
    f.devices.push({ id: 'empty-offline', name: 'Away PC', online: false }); f.workspace.updateDevices(); await flush(); assert.ok(f.get('remote-projects').textContent.includes('Away PC · offline')); assert.ok(f.get('remote-projects').textContent.includes('connect to load projects'));
    f.workspace.close(); assert.equal(f.localPrompt.value, 'Keep my local draft'); assert.ok(f.row('host', 'c')); assert.ok(f.row('other', 'c'));
  } finally { f.workspace.dispose(); globalThis.document = previousDocument; }
});

test('negotiated remote image references hydrate once and legacy or malformed image references stay inert', async () => {
  const previousDocument = globalThis.document, f = fixture({ imageReferences: true }); globalThis.document = f.document;
  f.messages[0].imageRefs = [{ id: 'persisted-image', mimeType: 'image/png', bytes: 68 }];
  try {
    await flush(); await f.row('host', 'c').events.click(); await flush(); assert.equal(f.get('remote-transcript').querySelector('img')?.src, image);
    assert.equal(f.calls.filter(call => call.params.method === 'chat.image').length, 1); assert.ok(f.calls.filter(call => call.params.method === 'chat.read').every(call => call.params.params.imageMode === 'references'));
    await f.row('host', 'child').events.click(); await flush(); await f.row('host', 'c').events.click(); await flush(); assert.equal(f.calls.filter(call => call.params.method === 'chat.image' && call.params.params.chatId === 'c').length, 1);
    const malformed = remoteChat({ chat: { id: 'c', messages: [{ id: 'm', role: 'user', imageRefs: [{ id: 'bad', mimeType: 'image/svg+xml', bytes: 10 }, { id: 'huge', mimeType: 'image/png', bytes: 9000000 }] }] } }, 'c'); assert.deepEqual(malformed.chat.messages[0].imageRefs, []);
  } finally { f.workspace.dispose(); globalThis.document = previousDocument; }
});

test('remote image-only drafts stay with their originating host when the file picker or send overlaps navigation', async () => {
  const previousDocument = globalThis.document, previousReader = globalThis.FileReader, gate = Promise.withResolvers(), f = fixture({ sendGate: gate.promise }); globalThis.document = f.document;
  globalThis.FileReader = class { readAsDataURL() { this.result = image; queueMicrotask(() => this.onload()); } };
  try {
    await flush(); await f.row('host', 'c').events.click(); await flush(); await f.get('remote-attach-images').events.click();
    await f.row('other', 'c').events.click(); await flush(); f.get('remote-image-picker').events.change({ target: { files: [new File([Buffer.from(image.split(',')[1], 'base64')], 'fixture.png', { type: 'image/png' })], value: 'fixture' } }); await flush();
    assert.equal(f.get('remote-image-drafts').hidden, true); await f.row('host', 'c').events.click(); await flush(); assert.equal(f.get('remote-image-drafts').querySelector('img')?.src, image); assert.equal(f.get('remote-send').disabled, false);
    f.get('remote-composer').events.submit({ preventDefault() {} }); await flush(); await f.row('other', 'c').events.click(); await flush(); const prompt = f.get('remote-prompt'); prompt.value = 'A newer draft on the second host'; prompt.events.input(); gate.resolve(); await flush();
    const sent = f.calls.find(call => call.params.method === 'chat.send'); assert.equal(sent.params.deviceId, 'host'); assert.deepEqual(sent.params.params, { chatId: 'c', text: '', images: [image] }); assert.equal(prompt.value, 'A newer draft on the second host');
    await f.row('host', 'c').events.click(); await flush(); assert.equal(f.get('remote-image-drafts').hidden, true); assert.equal(f.localPrompt.value, 'Keep my local draft'); assert.ok(f.calls.every(call => ['remote.request', 'media.release'].includes(call.method)));
  } finally { gate.resolve(); f.workspace.dispose(); globalThis.document = previousDocument; globalThis.FileReader = previousReader; }
});

test('remote media starts at most two reads and discards completions after changing the selected host', async () => {
  const previousDocument = globalThis.document, gate = Promise.withResolvers(), f = fixture({ imageReferences: true, imageGate: gate.promise }); globalThis.document = f.document;
  f.messages[0].imageRefs = Array.from({ length: 12 }, (_, i) => ({ id: `image-${i}`, mimeType: 'image/png', bytes: 68 }));
  try {
    await flush(); await f.row('host', 'c').events.click(); await flush(); assert.equal(f.calls.filter(call => call.params.method === 'chat.image').length, 2);
    const oldTranscript = f.get('remote-transcript').querySelector('article'); await f.row('other', 'c').events.click(); await flush(); gate.resolve(); await flush();
    assert.equal(oldTranscript.querySelectorAll('img').length, 0); assert.ok(f.calls.filter(call => call.params.method === 'chat.image').every(call => ['host', 'other'].includes(call.params.deviceId)));
    assert.ok(f.get('remote-transcript').querySelectorAll('img').length <= 8);
  } finally { gate.resolve(); f.workspace.dispose(); globalThis.document = previousDocument; }
});

test('offscreen failed image reads keep the explicit retry control when visible again', async () => {
  const previousDocument = globalThis.document, previousObserver = globalThis.IntersectionObserver, failure = { value: true }; let observer;
  globalThis.IntersectionObserver = class { constructor(callback) { this.callback = callback; this.nodes = []; observer = this; } observe(node) { this.nodes.push(node); } disconnect() { this.nodes = []; } };
  const f = fixture({ imageReferences: true, imageFailure: failure }); globalThis.document = f.document; f.messages[0].imageRefs = [{ id: 'retry-image', mimeType: 'image/png', bytes: 68 }];
  try {
    await flush(); await f.row('host', 'c').events.click(); await flush(); const target = observer.nodes.at(-1); observer.callback([{ target, isIntersecting: true }]); await flush(); assert.match(target.textContent, /Retry image/);
    observer.callback([{ target, isIntersecting: false }]); observer.callback([{ target, isIntersecting: true }]); assert.match(target.textContent, /Retry image/); assert.equal(f.calls.filter(call => call.params.method === 'chat.image').length, 1);
    failure.value = false; await target.querySelector('button').events.click(); await flush(); assert.equal(target.querySelector('img')?.src, image); assert.equal(f.calls.filter(call => call.params.method === 'chat.image').length, 2);
    target.getBoundingClientRect = () => ({ height: 240 }); observer.callback([{ target, isIntersecting: false }]); assert.equal(target.style.minHeight, '240px'); observer.callback([{ target, isIntersecting: true }]); target.querySelector('img').events.load(); assert.equal(target.style.minHeight, ''); assert.equal(f.calls.filter(call => call.params.method === 'chat.image').length, 2);
  } finally { f.workspace.dispose(); globalThis.document = previousDocument; globalThis.IntersectionObserver = previousObserver; }
});
