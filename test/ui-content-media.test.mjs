import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaReferences, mediaSource, resultMedia, createMediaOutputs, contentActions, createContentMenu } from '../renderer/content-media.mjs';
import { sameMessage } from '../renderer/ui-helpers.mjs';
import { remoteChat, remoteWorkspace } from '../renderer/remote-state.mjs';

const audio = { id: '11111111-1111-4111-8111-111111111111', kind: 'audio', mimeType: 'audio/wav', bytes: 16044, name: 'sample.wav' };
const video = { ...audio, id: '22222222-2222-4222-8222-222222222222', kind: 'video', mimeType: 'video/webm', name: 'sample.webm' };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';

class Element {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.events = {}; this.attributes = {}; this.dataset = {}; this.style = {}; this.tabIndex = -1; this.srcSets = 0; this.paused = true; this.currentTime = 0; this.offsetWidth = 200; this.offsetHeight = 100; }
  set src(value) { this.srcSets++; this.attributes.src = value; } get src() { return this.attributes.src || ''; }
  set textContent(value) { this.children = []; this._text = value; } get textContent() { return (this._text || '') + this.children.map(node => node.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML sink'); }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  setAttribute(name, value) { this.attributes[name] = value; } getAttribute(name) { return this.attributes[name]; } removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { this.events[name] = listener; }
  matches(selector) { return selector.split(',').some(value => value === this.tagName || value === '[tabindex]' && this.tabIndex >= 0 || value === `#${this.id}`); }
  querySelectorAll(selector) { return this.children.flatMap(node => [node, ...node.querySelectorAll('*')]).filter(node => selector === '*' || node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() { return { top: 10, bottom: 20, left: 10 }; }
  focus() { this.ownerDocument.activeElement = this; }
  pause() { this.paused = true; this.pauseCalls = (this.pauseCalls || 0) + 1; }
  load() { this.loadCalls = (this.loadCalls || 0) + 1; }
  async requestFullscreen() { this.ownerDocument.fullscreenElement = this; this.events.fullscreenchange?.(); }
}
function fixture() {
  const document = { createElement(tag) { return new Element(tag, this); }, addEventListener() {}, getSelection() { return this.selection; }, async exitFullscreen() { const node = this.fullscreenElement; this.fullscreenElement = null; node?.events.fullscreenchange?.(); } };
  document.body = document.createElement('body');
  const calls = [], request = async (method, params) => { calls.push({ method, params }); return { saved: true }; };
  const window = { innerWidth: 1000, innerHeight: 800, addEventListener() {} };
  return { document, calls, request, window };
}
const event = (target, extra = {}) => ({ target, type: 'contextmenu', clientX: 50, clientY: 50, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });

test('only bounded host media descriptors become players; output strings and URLs stay inert', () => {
  assert.deepEqual(mediaReferences([audio, video]), [audio]);
  assert.deepEqual(resultMedia(JSON.stringify({ media: video })), [video]);
  for (const ref of [{ ...audio, id: 'https://example.com/file' }, { ...audio, kind: 'video' }, { ...audio, mimeType: 'audio/webm' }, { ...audio, mimeType: '__proto__', kind: undefined, name: 'undefined' }, { ...audio, bytes: 536870913 }, { ...audio, bytes: 0 }, { ...audio, name: '../sample.wav' }, { ...audio, name: 'sample.mp3' }, { ...audio, name: 'x\nsample.wav' }]) assert.deepEqual(mediaReferences([ref]), []);
  assert.deepEqual(resultMedia('<video src="https://example.com/file">'), []);
  assert.equal(mediaSource('chat/one', audio.id, 'host?x'), `faber://app/media/chat%2Fone/${audio.id}?deviceId=host%3Fx`);
  const message = { id: 'm', role: 'tool', content: '', mediaRefs: [audio] };
  assert.equal(sameMessage(message, structuredClone(message)), true); assert.equal(sameMessage(message, { ...message, mediaRefs: [video] }), false);
  assert.equal(remoteWorkspace({ projects: [], chats: [], capabilities: { mediaReferences: true } }).capabilities.mediaReferences, true);
  const remote = remoteChat({ chat: { id: 'c', messages: [{ ...message, mediaRefs: [{ ...audio, path: 'untrusted-path' }] }] }, runs: [{ id: 'r', chatId: 'child', toolEvents: [{ id: 'e', mediaRefs: [video] }] }] }, 'c');
  assert.deepEqual(remote.chat.messages[0].mediaRefs, [audio]); assert.deepEqual(remote.runs[0].toolEvents[0].mediaRefs, [video]);
});

test('native players retain seek, volume and playback across snapshots and release every owning chat', async () => {
  const f = fixture(), outputs = createMediaOutputs(f), context = { chatId: 'parent' };
  const [node] = outputs.get([audio], context); f.document.body.append(node); const player = node.querySelector('audio');
  assert.equal(player.controls, true); assert.equal(player.preload, 'metadata'); assert.equal(player.autoplay, undefined);
  player.currentTime = 0.75; player.volume = 0.3; player.paused = false;
  assert.equal(outputs.get(structuredClone([audio]), context)[0], node); assert.equal(player.currentTime, 0.75); assert.equal(player.volume, 0.3); assert.equal(player.paused, false); assert.equal(player.srcSets, 1);
  const [child] = outputs.get([video], { chatId: 'child', deviceId: 'host' }); f.document.body.append(child); const fullscreen = child.querySelector('button');
  await fullscreen.events.click(); assert.equal(f.document.fullscreenElement, child); assert.equal(fullscreen.textContent, 'Exit full screen'); await fullscreen.events.click(); assert.equal(f.document.fullscreenElement, null);
  outputs.clear(); assert.equal(player.paused, true); assert.equal(player.src, ''); assert.equal(player.loadCalls, 1);
  assert.deepEqual(f.calls, [{ method: 'media.release', params: { chatId: 'parent' } }, { method: 'media.release', params: { chatId: 'child', deviceId: 'host' } }]);
});

test('offline media has no source and reconnect never starts playback; removed players are unloaded', () => {
  const f = fixture(), outputs = createMediaOutputs(f); outputs.setAvailable(false);
  const [node] = outputs.get([audio], { chatId: 'c', deviceId: 'host' }); f.document.body.append(node); const player = node.querySelector('audio');
  assert.equal(player.src, ''); assert.match(node.textContent, /Connect to the host/);
  outputs.setAvailable(true); assert.equal(player.src, mediaSource('c', audio.id, 'host')); assert.equal(player.paused, true);
  player.paused = false; outputs.setAvailable(false); assert.equal(player.paused, true); assert.equal(player.src, '');
  node.remove(); outputs.prune(); assert.equal(player.loadCalls, 2); outputs.clear();
});

test('content actions copy image bytes or host references and save only existing displayed payloads', () => {
  assert.deepEqual(contentActions({ chatId: 'c' }, { text: 'selected', image: png }).map(item => item.id), ['copyText', 'copyImage', 'save']);
  assert.deepEqual(contentActions({ chatId: 'child', deviceId: 'host', imageId: 'ref' })[0], { id: 'copyImage', label: 'Copy image', method: 'clipboard.copyImage', params: { chatId: 'child', deviceId: 'host', imageId: 'ref' } });
  assert.deepEqual(contentActions({ chatId: 'child', deviceId: 'host', mediaId: video.id }).map(item => [item.method, item.params]), [['media.save', { chatId: 'child', deviceId: 'host', mediaId: video.id }]]);
  for (const image of ['https://example.com/pixel.png', 'file:///secret.png', 'data:image/svg+xml;base64,PHN2Zy8+']) assert.deepEqual(contentActions({}, { image }), []);
});

test('content menu captures selected text, exposes image actions, supports keyboard navigation and restores focus', async () => {
  const f = fixture(), menu = createContentMenu(f), origin = f.document.createElement('article'), image = f.document.createElement('img'); image.src = png; origin.append(image); f.document.body.append(origin);
  menu.bind(origin, { chatId: 'c', text: 'whole message' }); const firstListener = origin.events.contextmenu; menu.bind(origin, { chatId: 'c', text: 'updated whole message' }); assert.equal(origin.events.contextmenu, firstListener);
  f.document.selection = { anchorNode: image, focusNode: image, toString: () => 'only selected words' };
  const open = event(image, { type: 'keydown', key: 'F10', shiftKey: true }); origin.events.keydown(open); assert.equal(open.prevented, true);
  const popup = f.document.body.querySelector('#content-context-menu'), buttons = popup.querySelectorAll('button'); assert.deepEqual(buttons.map(node => node.dataset.action), ['copyText', 'copyImage', 'save']); assert.equal(f.document.activeElement, buttons[0]);
  popup.events.keydown(event(buttons[0], { key: 'End' })); assert.equal(f.document.activeElement, buttons[2]); popup.events.keydown(event(buttons[2], { key: 'ArrowDown' })); assert.equal(f.document.activeElement, buttons[0]);
  await buttons[0].events.click(); assert.deepEqual(f.calls[0], { method: 'clipboard.copyText', params: { text: 'only selected words' } }); assert.equal(popup.hidden, true); assert.equal(f.document.activeElement, image);
  f.document.selection = null; origin.events.contextmenu(event(image)); await popup.querySelectorAll('button')[1].events.click(); assert.equal(f.calls[1].method, 'clipboard.copyImage'); assert.equal(f.calls[1].params.image, png);
  origin.events.contextmenu(event(image)); const escape = event(popup, { key: 'Escape' }); popup.events.keydown(escape); assert.equal(escape.prevented, true); assert.equal(escape.stopped, true); assert.equal(f.document.activeElement, image);
});

test('fullscreen content menus stay in the fullscreen layer and return to the body on close', () => {
  const f = fixture(), menu = createContentMenu(f), node = f.document.createElement('figure'); f.document.body.append(node); f.document.fullscreenElement = node; menu.bind(node, { chatId: 'c', mediaId: video.id, text: video.name });
  node.events.contextmenu(event(node)); const popup = node.querySelector('#content-context-menu'); assert.ok(popup); menu.close(); assert.equal(popup.parentElement, f.document.body);
});
