import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { browserAddress, browserPaneWidth, browserViewBounds, createBrowserPanel } from '../renderer/browser.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.dataset = {}; this.style = { setProperty(name, value) { this[name] = value; } }; this.value = ''; this.hidden = false; this.textContent = ''; this.isConnected = true; const classes = new Set(); this.classList = { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) }; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  insertBefore(node, before) { node.remove(); node.parentElement = this; const index = this.children.indexOf(before); index < 0 ? this.children.push(node) : this.children.splice(index, 0, node); }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
  addEventListener(name, listener) { this.events[name] = listener; }
  set innerHTML(_value) { throw new Error('Untrusted browser metadata must render as text'); }
  getBoundingClientRect() { if (this.rect) return this.rect; if (this.id === 'browser-page-slot') { const width = parseInt(this.parentElement.style.width) || 350; return { left: 1280 - width, top: 130, width, height: 670 }; } if (this.id === 'browser-panel') { const width = parseInt(this.style.width) || 350; return { left: 1280 - width, top: 0, width, height: 800 }; } return { left: 0, top: 0, width: 1280, height: 800 }; }
  setPointerCapture() {} select() { this.selectionRequested = true; }
}
const flush = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };
const tab = (id = 'one', extra = {}) => ({ id, url: 'https://example.com/', title: 'Example', loaded: true, loading: false, canGoBack: false, canGoForward: false, updatedAt: '1', zoomFactor: 1, viewport: { width: 1280, height: 800 }, ...extra });
const group = (chatId = 'main', extra = {}) => ({ chatId, mode: 'agent', activeTabId: 'one', tabs: [tab()], ...extra });
const frame = (extra = {}) => ({ type: 'browserFrame', chatId: 'main', tabId: 'one', url: 'https://example.com/', image: png, width: 1280, height: 800, frameId: 'frame-1', sequence: 1, ...extra });
function fixture(savedWidth) {
  const body = new Element('body'), shell = new Element('div'), sidebar = new Element('aside'), workspace = new Element('main'), toggle = new Element('button'), header = new Element('header'), modal = new Element('dialog'), prompt = new Element('textarea'), rail = new Element('aside');
  header.id = 'workspace-header'; header.rect = { left: 232, top: 0, width: 700, height: 46 }; sidebar.id = 'sidebar'; sidebar.rect = { left: 0, top: 0, width: 232, height: 800 }; toggle.id = 'toggle-browser'; modal.id = 'modal'; modal.open = false; rail.id = 'activity-rail'; rail.hidden = true; prompt.id = 'prompt'; prompt.value = 'Unsent composer draft'; body.append(shell, modal); shell.append(sidebar, workspace); workspace.append(header, toggle, prompt, rail);
  const all = root => [root, ...root.children.flatMap(all)]; let focusCalls = 0, foreground = true;
  const document = { body, documentElement: { dataset: {} }, activeElement: prompt, hidden: false, events: {}, addEventListener(name, listener) { this.events[name] = listener; }, hasFocus: () => foreground, querySelector: selector => selector === '.shell' ? shell : selector === '.workspace-header' ? header : all(body).find(node => node.id === selector.slice(1)) };
  const attachFocus = node => { node.focus = () => { focusCalls++; document.activeElement = node; document.events.focusin?.({ target: node }); }; return node; }; attachFocus(prompt);
  const window = { innerWidth: 1280, innerHeight: 800, events: {}, addEventListener(name, listener) { this.events[name] = listener; }, requestAnimationFrame: callback => setImmediate(callback), getComputedStyle: node => ({ display: node.hidden || (node === sidebar && body.classList.contains('sidebar-hidden')) ? 'none' : 'block', overflow: node.id === 'browser-panel' ? 'hidden' : 'visible', overflowX: 'visible', overflowY: 'visible' }) };
  const stored = new Map(savedWidth ? [['faber.browserWidth', String(savedWidth)]] : []), storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const el = (tag, className, text) => { const node = attachFocus(new Element(tag)); node.className = className; if (text) node.textContent = text; return node; };
  const button = (text, callback, className) => { const node = el('button', className, text); node.addEventListener('click', callback); return node; };
  const chat = { id: 'main', title: 'Main chat' }, chats = [chat, { id: 'child', title: 'Child agent' }];
  let listener, state = { sessions: [], bookmarks: [], history: [], downloads: [] }; const calls = [], hooks = new Map();
  const emitState = () => listener({ type: 'browser', state });
  const request = async (method, args) => {
    calls.push({ method, args }); if (hooks.has(method)) return hooks.get(method)(args);
    if (method === 'browser.state') return state;
    if (method === 'browser.frame') return { chatId: args.chatId, tabId: args.tabId, image: null, sequence: 0 };
    if (method === 'browser.selectTab') { state = { ...state, sessions: state.sessions.map(item => item.chatId === args.chatId ? { ...item, mode: 'human', activeTabId: args.tabId } : item) }; emitState(); }
    if (method === 'browser.takeover' || method === 'browser.resume') { state = { ...state, sessions: state.sessions.map(item => item.chatId === args.chatId ? { ...item, mode: method === 'browser.takeover' ? 'human' : 'agent', tabs: item.tabs.map(tab => ({ ...tab, loaded: true })) } : item) }; emitState(); }
    return {};
  };
  const panel = createBrowserPanel({ request, subscribe: callback => { listener = callback; }, getChat: () => chat, getChats: () => chats, el, button, document, window, storage });
  return { panel, calls, document, window, chat, stored, get: id => document.querySelector(`#${id}`), nodes: predicate => all(body).filter(predicate), emit: event => listener(event), setState: next => { state = { ...state, ...next }; emitState(); }, hook: (name, callback) => hooks.set(name, callback), focusCalls: () => focusCalls, foreground: value => { foreground = value; }, focus: node => { document.activeElement = node; document.events.focusin?.({ target: node }); }, state: () => state };
}

test('address/search uses platform URL parsing, avoids executable schemes and embedded credentials', () => {
  assert.equal(browserAddress('example.com/path'), 'https://example.com/path');
  assert.equal(browserAddress('http://localhost:4000/'), 'http://localhost:4000/');
  assert.equal(browserAddress('browser help'), 'https://www.google.com/search?q=browser%20help');
  assert.equal(browserAddress('localhost:4000'), 'https://localhost:4000/');
  for (const value of ['', 'javascript:alert(1)', 'file:///secret', 'data:text/html,a', 'https://user:pass@example.com']) assert.throws(() => browserAddress(value));
});

test('remembered pane width clamps to available room and keeps chat visible', () => {
  assert.deepEqual(browserPaneWidth(1200), { min: 320, max: 840, width: 400 });
  assert.equal(browserPaneWidth(1200, 600).width, 600); assert.equal(browserPaneWidth(1200, 2000).width, 840);
  assert.equal(browserPaneWidth(1200, 2).width, 320); assert.equal(browserPaneWidth(400, 600).width, 200);
});

test('native viewport rejects clipped/outside slots and rounds inward across zoom-layout fractions', () => {
  const rect = { left: 700.2, top: 130.2, width: 500.7, height: 600.7 };
  assert.deepEqual(browserViewBounds(rect, { width: 1280, height: 800 }), { x: 701, y: 131, width: 499, height: 599 });
  assert.equal(browserViewBounds({ ...rect, top: -10 }, { width: 1280, height: 800 }), null);
  assert.equal(browserViewBounds(rect, { width: 1280, height: 800 }, [{ left: 700, top: 200, width: 600, height: 600 }]), null);
});

test('agent sessions reveal readonly preview without changing chat, draft or keyboard focus', async () => {
  const f = fixture(), focused = f.document.activeElement;
  f.setState({ sessions: [group('child')] }); await flush();
  assert.equal(f.get('browser-panel').hidden, false); assert.equal(f.get('browser-session').value, 'child');
  assert.equal(f.document.activeElement, focused); assert.equal(focused.value, 'Unsent composer draft'); assert.equal(f.focusCalls(), 0);
  assert.equal(f.get('browser-text'), undefined, 'Fake page typing controls are removed');
  assert.equal(f.get('browser-frame').events.click, undefined, 'Preview clicks cannot imply takeover');
  assert.ok(f.calls.some(call => call.method === 'browser.view' && call.args.visible && call.args.tabId === 'one'));
  await f.get('browser-hide').events.click(); await flush();
  assert.equal(f.calls.filter(call => call.method === 'browser.view').at(-1).args.visible, false);
});

test('background tabs preserve an unsent address, and live updates preserve keyed tab controls', async () => {
  const f = fixture(); f.setState({ sessions: [group()] }); await flush();
  const first = f.nodes(node => node.dataset.browserTab === 'one')[0]; f.focus(first);
  f.get('browser-url').value = 'An unsent search'; f.get('browser-url').events.input();
  f.setState({ sessions: [group('main', { activeTabId: 'two', tabs: [tab(), tab('two', { url: 'https://other.example/' })] })] });
  assert.equal(f.get('browser-url').value, 'An unsent search'); assert.equal(f.nodes(node => node.dataset.browserTab === 'one')[0], first); assert.equal(f.document.activeElement, first);
  f.emit(frame({ tabId: 'one', sequence: 20 })); assert.equal(f.get('browser-frame').hidden, true, 'A background tab cannot replace the selected frame');
  await first.events.click(); await flush();
  assert.equal(f.get('browser-url').value, 'https://example.com/');
});

test('typed manual Open binds its operation-owned group before loading completes', async () => {
  const f = fixture(); let createOwn, complete;
  const own = new Promise(resolve => { createOwn = resolve; }), loaded = new Promise(resolve => { complete = resolve; });
  f.hook('browser.open', async args => { f.setState({ sessions: [group('child')] }); f.setState({ sessions: [group('child', { tabs: [tab('one', { title: 'Changed' })] })] }); await own; f.setState({ sessions: [group('child'), group('main', { mode: 'human', tabs: [tab('one', { loading: true, url: args.url })] })] }); await loaded; f.setState({ sessions: [group('main', { mode: 'human' })] }); });
  f.get('browser-url').value = 'https://example.com/'; f.get('browser-url').events.input(); f.get('browser-navigation').events.submit({ preventDefault() {} });
  assert.equal(f.get('browser-session').value, ''); assert.equal(f.get('browser-url').value, 'https://example.com/');
  createOwn(); await flush();
  assert.equal(f.get('browser-session').value, 'main'); assert.equal(f.get('browser-stop').disabled, false);
  complete(); await flush(); f.emit(frame());
  assert.equal(f.get('browser-frame').hidden, true); assert.equal(f.get('browser-status').textContent, 'You have control · Agent browsing paused'); assert.ok(f.calls.some(call => call.method === 'browser.view' && call.args.visible)); assert.equal(f.get('browser-url').value, 'https://example.com/');
});

test('failed Open keeps its address draft without faking host ownership', async () => {
  const f = fixture(); f.hook('browser.open', async () => { throw new Error('Open failed'); });
  f.get('browser-url').value = 'https://example.com/'; f.get('browser-url').events.input(); f.get('browser-navigation').events.submit({ preventDefault() {} }); await flush();
  assert.equal(f.get('browser-url').value, 'https://example.com/'); assert.equal(f.get('browser-error').textContent, 'Open failed');
  assert.equal(f.calls.some(call => call.method === 'browser.takeover'), false);
});

test('Take over is explicit, blocks monitor frames, and unrelated agents do not replace human page', async () => {
  const f = fixture(); f.setState({ sessions: [group()] }); await flush();
  assert.equal(f.calls.some(call => call.method === 'browser.takeover'), false);
  await f.get('browser-takeover').events.click(); await flush();
  assert.equal(f.get('browser-status').textContent, 'You have control · Agent browsing paused');
  f.emit(frame()); assert.equal(f.get('browser-frame').hidden, true);
  f.setState({ sessions: [group('main', { mode: 'human' }), group('child')] }); await flush();
  assert.equal(f.get('browser-session').value, 'main');
  assert.ok(f.calls.some(call => call.method === 'browser.view' && call.args.visible && call.args.chatId === 'main'));
});

test('restored human tabs stay unloaded and native surface hides for modal, route, drawer and clipping', async () => {
  const f = fixture(); f.setState({ sessions: [group('main', { mode: 'human', tabs: [tab('one', { loaded: false })] })] }); await flush();
  assert.equal(f.calls.some(call => call.method === 'browser.view' && call.args.visible), false);
  await f.get('browser-takeover').events.click(); await flush();
  assert.equal(f.calls.filter(call => call.method === 'browser.view').at(-1).args.visible, true);
  f.get('modal').open = true; f.panel.syncSurface(); await flush(); assert.equal(f.calls.filter(call => call.method === 'browser.view').at(-1).args.visible, false);
  f.get('modal').open = false; f.document.body.classList.add('models-open'); f.panel.syncSurface(); await flush(); assert.equal(f.calls.filter(call => call.method === 'browser.view').at(-1).args.visible, false);
  f.document.body.classList.remove('models-open'); await f.get('browser-menu').events.click(); await flush(); assert.equal(f.calls.filter(call => call.method === 'browser.view').at(-1).args.visible, false);
  await f.get('browser-menu').events.click(); f.get('browser-page-slot').rect = { left: 900, top: 130, width: 380, height: 800 }; f.panel.syncSurface(); await flush(); assert.equal(f.calls.filter(call => call.method === 'browser.view').at(-1).args.visible, false);
});

test('divider supports bounded pointer and keyboard resize, hides native content and remembers width', async () => {
  const f = fixture(400); f.setState({ sessions: [group('main', { mode: 'human' })] }); await flush();
  const divider = f.get('browser-divider'); assert.equal(f.get('browser-panel').style.width, '400px');
  divider.events.pointerdown({ button: 0, clientX: 880, pointerId: 1, preventDefault() {} });
  divider.events.pointermove({ clientX: 780 });
  assert.equal(f.get('browser-panel').style.width, '500px'); assert.equal(f.calls.filter(call => call.method === 'browser.view').at(-1).args.visible, false);
  divider.events.pointerup(); await flush(); assert.equal(f.stored.get('faber.browserWidth'), '500');
  divider.events.keydown({ key: 'Home', preventDefault() {} }); await flush(); assert.equal(f.get('browser-panel').style.width, '320px');
  divider.events.keydown({ key: 'End', preventDefault() {} }); await flush(); assert.equal(f.get('browser-panel').style.width, '682px');
  assert.equal(divider.attributes['aria-valuenow'], '682');
});

test('download progress and unrelated frame events retain focused Cancel and bookmark controls', async () => {
  const f = fixture(); const download = { id: 'd', chatId: 'main', tabId: 'one', url: 'https://example.com/file', filename: '<script>literal</script>', status: 'progressing', receivedBytes: 1, totalBytes: 10 };
  f.setState({ sessions: [group()], downloads: [download], bookmarks: [{ id: 'b', url: 'https://example.com/', title: 'Example' }] }); await flush();
  await f.get('browser-menu').events.click(); await f.get('browser-downloads').events.click();
  const cancel = f.nodes(node => node.dataset.browserCancel === 'd')[0]; f.focus(cancel);
  f.setState({ downloads: [{ ...download, receivedBytes: 5 }] }); f.emit(frame());
  assert.equal(f.nodes(node => node.dataset.browserCancel === 'd')[0], cancel); assert.equal(f.document.activeElement, cancel);
  await f.get('browser-bookmarks').events.click(); const remove = f.nodes(node => node.dataset.browserRemoveBookmark === 'b')[0]; f.focus(remove);
  f.setState({ downloads: [{ ...download, receivedBytes: 8 }] });
  assert.equal(f.nodes(node => node.dataset.browserRemoveBookmark === 'b')[0], remove); assert.equal(f.document.activeElement, remove);
  await remove.events.click(); assert.deepEqual(f.calls.find(call => call.method === 'browser.removeBookmark').args, { id: 'b' });
});

test('shortcuts belong to browser focus and native shortcut events, never the composer or modal', async () => {
  const f = fixture(); f.setState({ sessions: [group('main', { tabs: [tab(), tab('two')] })] }); await flush();
  const event = key => ({ key, ctrlKey: true, preventDefault() { this.prevented = true; }, stopPropagation() {} });
  const composerKey = event('l'); f.get('browser-panel').events.keydown(composerKey); assert.equal(composerKey.prevented, undefined);
  f.focus(f.get('browser-url')); const key = event('Tab'); f.get('browser-panel').events.keydown(key); await flush(); assert.equal(f.state().sessions[0].activeTabId, 'two');
  f.emit({ type: 'browserShortcut', chatId: 'main', tabId: 'two', action: 'address' }); assert.equal(f.document.activeElement, f.get('browser-url')); assert.equal(f.get('browser-url').selectionRequested, true);
  const count = f.calls.filter(call => call.method === 'browser.newTab').length; f.get('modal').open = true; f.get('browser-panel').events.keydown(event('t')); assert.equal(f.calls.filter(call => call.method === 'browser.newTab').length, count);
});

test('Resume restores prior composer focus only for explicit foreground intent without intervening focus', async () => {
  const f = fixture(); f.setState({ sessions: [group()] }); await flush();
  await f.get('browser-takeover').events.click(); f.focus(f.get('browser-resume')); await f.get('browser-resume').events.click(); await flush();
  assert.equal(f.document.activeElement, f.get('prompt'));
  await f.get('browser-takeover').events.click(); f.focus(f.get('browser-resume')); f.foreground(false); await f.get('browser-resume').events.click(); await flush();
  assert.equal(f.document.activeElement, f.get('browser-resume'), 'A background app keeps its focus');
});


test('viewport changes discard old same-URL frames and accept only current tab dimensions', async () => {
  const f = fixture(); f.setState({ sessions: [group()] }); await flush(); f.emit(frame());
  assert.equal(f.get('browser-frame').hidden, false);
  f.setState({ sessions: [group('main', { tabs: [tab('one', { viewport: { width: 400, height: 670 } })] })] });
  assert.equal(f.get('browser-frame').hidden, true);
  f.emit(frame({ sequence: 2 })); assert.equal(f.get('browser-frame').hidden, true);
  f.emit(frame({ width: 400, height: 670, sequence: 3 })); assert.equal(f.get('browser-frame').hidden, false);
});

test('native surface resync after host dialogs preserves geometry without focus changes', async () => {
  const f = fixture(); f.setState({ sessions: [group('main', { mode: 'human' })] }); await flush();
  const before = f.calls.filter(call => call.method === 'browser.view' && call.args.visible).length;
  f.emit({ type: 'browserViewHidden' }); await flush();
  assert.equal(f.calls.filter(call => call.method === 'browser.view' && call.args.visible).length, before + 1);
  assert.equal(f.focusCalls(), 0);
});

test('find, zoom and transfer controls use explicit narrow human actions and preserve address drafts', async () => {
  const f = fixture(); f.setState({ sessions: [group('main', { mode: 'human' })] }); await flush();
  f.get('browser-url').value = 'Unsubmitted search'; f.get('browser-url').events.input();
  await f.get('browser-menu').events.click(); await f.get('browser-zoom-in').events.click();
  assert.deepEqual(f.calls.find(call => call.method === 'browser.zoom').args, { chatId: 'main', tabId: 'one', factor: 1.1 });
  assert.equal(f.get('browser-url').value, 'Unsubmitted search');
  await f.get('browser-find-open').events.click(); f.get('browser-find-text').value = 'Example'; f.get('browser-find-text').events.input(); await flush();
  assert.deepEqual(f.calls.find(call => call.method === 'browser.find').args, { chatId: 'main', tabId: 'one', text: 'Example', forward: true, findNext: false });
  f.emit({ type: 'browserFind', chatId: 'main', tabId: 'one', result: { activeMatchOrdinal: 1, matches: 3 } }); assert.equal(f.get('browser-find-result').textContent, '1 / 3');
  await f.get('browser-find-close').events.click(); assert.ok(f.calls.some(call => call.method === 'browser.stopFind'));
});

test('Resume tolerates a hidden focused button but never overrides another user focus choice', async () => {
  const f = fixture(); f.setState({ sessions: [group()] }); await flush();
  await f.get('browser-takeover').events.click(); f.focus(f.get('browser-resume'));
  f.hook('browser.resume', async () => { f.setState({ sessions: [group()] }); f.document.activeElement = f.document.body; });
  await f.get('browser-resume').events.click(); assert.equal(f.document.activeElement, f.get('prompt'));
  await f.get('browser-takeover').events.click(); f.focus(f.get('browser-resume'));
  f.hook('browser.resume', async () => { f.setState({ sessions: [group()] }); f.focus(f.get('browser-url')); });
  await f.get('browser-resume').events.click(); assert.equal(f.document.activeElement, f.get('browser-url'));
});


test('browser chrome focus is scoped away from composer/modal and empty-pane shortcuts create a tab', async () => {
  const f = fixture(); f.panel.show(true); await flush();
  assert.equal(f.calls.filter(call => call.method === 'browser.chromeFocus').at(-1).args.active, false);
  f.focus(f.get('browser-url')); await flush();
  assert.deepEqual(f.calls.filter(call => call.method === 'browser.chromeFocus').at(-1).args, { active: true, chatId: 'main' });
  f.emit({ type: 'browserShortcut', chatId: 'main', action: 'newTab' }); await flush();
  assert.ok(f.calls.some(call => call.method === 'browser.newTab' && call.args.chatId === 'main'));
  f.get('modal').open = true; f.panel.suspend(); await flush();
  assert.equal(f.calls.filter(call => call.method === 'browser.chromeFocus').at(-1).args.active, false);
});

test('pending user new-tab completion never overrides a newer composer focus choice', async () => {
  const f = fixture(); f.setState({ sessions: [group()] }); await flush(); let release;
  const pending = new Promise(resolve => { release = resolve; }); f.hook('browser.newTab', () => pending);
  f.focus(f.get('browser-new-tab')); const action = f.get('browser-new-tab').events.click(); f.focus(f.get('prompt'));
  release({}); await action; await flush();
  assert.equal(f.document.activeElement, f.get('prompt'));
});


test('ownership transitions resend identical geometry and tabs follow the actual chat-header height', async () => {
  const f = fixture(); f.setState({ sessions: [group()] }); await flush();
  const count = f.calls.filter(call => call.method === 'browser.view' && call.args.visible).length;
  f.setState({ sessions: [group('main', { mode: 'human' })] }); await flush();
  assert.equal(f.calls.filter(call => call.method === 'browser.view' && call.args.visible).length, count + 1, 'Native attach must follow an agent watch at identical bounds');
  assert.equal(f.get('browser-panel').style['--browser-header-height'], '46px');
  f.get('workspace-header').rect.height = 60; f.window.events.resize(); await flush();
  assert.equal(f.get('browser-panel').style['--browser-header-height'], '60px');
});


test('Activity explicitly switches from browser to the rail while ordinary browser closing preserves rail state', async () => {
  const source = await fs.readFile(new URL('../renderer/app.mjs', import.meta.url), 'utf8');
  const registration = source.split('\n').find(line => line.startsWith("$('#toggle-activity').addEventListener"));
  assert.ok(registration, 'Use the actual app caller registration');
  const handlers = {}, calls = []; let browserOpen = true;
  vm.runInNewContext(registration, {
    $: selector => ({ addEventListener: (_event, callback) => { handlers[selector] = callback; } }),
    document: { body: { classList: { contains: name => name === 'browser-open' && browserOpen } } },
    browserPanel: { show: open => { calls.push(['browser', open]); browserOpen = open; } },
    toggleActivity: force => calls.push(['activity', force]),
  });
  handlers['#toggle-activity']();
  assert.deepEqual(calls, [['browser', false], ['activity', true]]);
  calls.length = 0; handlers['#toggle-activity']();
  assert.deepEqual(calls, [['activity', undefined]], 'Normal Activity retains its existing toggle behavior');
  const f = fixture(), rail = f.get('activity-rail'); f.setState({ sessions: [group()] }); await flush();
  f.panel.show(false); assert.equal(rail.hidden, true);
  rail.hidden = false; f.panel.show(true); f.panel.show(false); assert.equal(rail.hidden, false);
});
