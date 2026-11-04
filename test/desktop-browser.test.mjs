import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBrowserManager, browserURL } from '../desktop/browser.mjs';
import { createBrowserFiles } from '../desktop/browser-files.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { checkTool } from '../core/registry.mjs';

function fixture(t, options = {}) {
  const behavior = options;
  const views = [], sessions = [], events = [], attached = [], chats = new Map(['a', 'b', 'c', 'd', 'e'].map(id => [id, { id }]));
  const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(1280, 16); png.writeUInt32BE(800, 20);
  class View {
    constructor(options) {
      this.options = options; if (options.webContents) { this.webContents = options.webContents; views.push(this); return; } this.destroyed = false; this.url = ''; this.commands = []; this.zoom = 1; this.entries = []; this.index = -1;
      const wc = this.webContents = new EventEmitter(), api = wc.debugger = new EventEmitter(); wc.id = views.length + 1; wc.session = options.webPreferences?.session;
      wc.isLoading = () => !!this.loading; wc.getURL = () => this.url; wc.getTitle = () => 'Fixture page'; wc.isDestroyed = () => this.destroyed;
      wc.setAudioMuted = value => { this.muted = value; }; wc.setIgnoreMenuShortcuts = value => { this.ignoresMenu = value; };
      wc.setWindowOpenHandler = handler => { this.popup = handler; }; wc.stop = () => { this.loading = false; this.rejectLoad?.(new Error('Navigation stopped')); wc.emit('did-stop-loading'); };
      wc.getZoomFactor = () => this.zoom; wc.setZoomFactor = value => { this.zoom = value; };
      wc.beginFrameSubscription = () => { this.subscriptions = (this.subscriptions || 0) + 1; }; wc.endFrameSubscription = () => { this.subscriptions--; };
      wc.findInPage = () => 7; wc.stopFindInPage = action => { this.findStop = action; }; wc.downloadURL = value => { this.downloadURL = value; };
      wc.navigationHistory = { canGoBack: () => this.index > 0, canGoForward: () => this.index + 1 < this.entries.length, goBack: () => { this.url = this.entries[--this.index]; wc.emit('did-stop-loading'); }, goForward: () => { this.url = this.entries[++this.index]; wc.emit('did-stop-loading'); } };
      wc.loadURL = async url => {
        this.loading = true; wc.emit('did-start-navigation', { isMainFrame: true, url }); wc.emit('did-start-loading');
        if (url.endsWith('/hold')) await new Promise((resolve, reject) => { this.resolveLoad = resolve; this.rejectLoad = reject; });
        this.url = url; this.loading = false; this.entries.splice(++this.index); this.entries.push(url); wc.emit('did-navigate', {}, url); wc.emit('did-stop-loading');
      };
      wc.reload = () => { void wc.loadURL(this.url); };
      wc.close = ({ waitForBeforeUnload } = {}) => {
        if (waitForBeforeUnload && this.unsaved) { const event = { preventDefault() { this.prevented = true; } }; wc.emit('will-prevent-unload', event); if (!event.prevented) return; }
        this.destroyed = true; this.rejectLoad?.(new Error('Destroyed browser')); wc.emit('destroyed');
      };
      api.attach = () => { this.debugAttached = true; }; api.detach = () => { this.debugAttached = false; this.captureDetach?.(new Error('target closed while handling command')); }; api.isAttached = () => !!this.debugAttached;
      api.sendCommand = async (name, args) => {
        this.commands.push({ name, args }); if (this.destroyed) throw new Error('Destroyed browser'); if (name === 'Page.enable' && behavior.initializationFailures > 0) { behavior.initializationFailures--; throw new Error('Fixture setup failed'); }
        if (name === 'Page.captureScreenshot') { if (this.captureGate) { try { await Promise.race([this.captureGate, new Promise((_, reject) => {this.captureDetach = reject;})]); } finally {this.captureDetach = null;} } const image = Buffer.from(png); image.writeUInt32BE(args.clip.width, 16); image.writeUInt32BE(args.clip.height, 20); return { data: this.screenshotData ?? image.toString('base64') }; }
        if (name === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-fixture' } } };
        if (name === 'Page.createIsolatedWorld') return { executionContextId: 12 };
        if (name === 'Runtime.evaluate') {
          if (args.expression.startsWith('(function snapshotPage(')) { const token = args.expression.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)[0]; return { result: { value: { title: 'Fixture page', text: 'Untrusted fixture', elements: [{ id: token + ':1', label: 'Field', role: 'input', bounds: { x: 40, y: 80, width: 200, height: 40 } }], untrusted: true } } }; }
          if (args.expression.startsWith('(function elementPoint(')) return { result: { value: { x: 140, y: 100 } } };
          if (args.expression.startsWith('(function editablePage(')) return { result: { value: true } };
        }
        return {};
      }; if (!options.fixtureGuest) views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; } setVisible(value) { this.visible = value; }
  }
  const createSession = (partition, options) => {
    const session = new EventEmitter(); session.partition = partition; session.options = options; session.flushed = [];
    session.setPermissionRequestHandler = fn => { session.permission = fn; }; session.setPermissionCheckHandler = fn => { session.permissionCheck = fn; }; session.setDevicePermissionHandler = fn => { session.devicePermission = fn; }; session.setDisplayMediaRequestHandler = fn => { session.displayPermission = fn; };
    session.webRequest = { onBeforeRequest: (_filter, fn) => { session.beforeRequest = fn; } }; session.flushStorageData = () => { session.flushed.push('storage'); }; session.cookies = { flushStore: async () => { session.flushed.push('cookies'); } }; session.closeAllConnections = async () => { session.flushed.push('connections'); }; sessions.push(session); return session;
  };
  const browser = createBrowserManager({ createView: args => new View(args), createSession, emit: event => events.push(event), getChat: id => chats.get(id), attachView: view => attached.push(view), detachView: view => { attached.splice(attached.indexOf(view), 1); }, ...options });
  t.after(() => browser.close());
  const execute = async (name, args = {}, chatId = 'a', signal) => browser.tools().find(tool => tool.name === `browser_${name}`).execute(args, { chat: { id: chatId }, signal });
  const request = (method, args = {}) => browser.request('browser.' + method, method === 'state' ? args : { chatId: 'a', ...args });
  return { browser, views, sessions, events, attached, chats, execute, request, createGuest: () => new View({ fixtureGuest: true, webPreferences: views[0].options.webPreferences }).webContents };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('browser schemas, sandbox and navigation safeguards retain exact browser-only authority', async t => {
  const f = fixture(t); f.browser.tools().forEach(checkTool); assert.equal(f.browser.tools().length, 16);
  for (const value of ['file:///c:/secret', 'data:text/html,body', 'javascript:alert(1)', 'faber://app/', 'ftp://example.com', 'http://user:pass@example.com/', 'https://example.com/\nsecret']) assert.throws(() => browserURL(value));
  await assert.rejects(f.execute('open', { url: 'https://example.com', chatId: 'b' })); assert.equal(f.views.length, 0);
  await f.execute('open', { url: 'https://example.com/' }); const view = f.views[0], prefs = view.options.webPreferences, session = f.sessions[0];
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.preload, undefined); assert.equal(prefs.disableBlinkFeatures, 'FileSystemAccessLocal,EyeDropperAPI'); assert.equal(view.visible, false); assert.equal(f.attached.length, 0);
  assert.match(session.partition, /^persist:faber-browser-[a-f0-9]{64}$/); session.permission(null, 'media', value => assert.equal(value, false)); assert.equal(session.permissionCheck(), false); assert.equal(session.devicePermission(), false);
  assert.deepEqual(view.popup({ url: 'https://example.com' }), { action: 'deny' });
  let prevented = 0; view.webContents.emit('will-navigate', { preventDefault() { prevented++; } }, 'file:///C:/secret'); assert.equal(prevented, 1);
  session.beforeRequest({ url: 'file:///C:/secret', resourceType: 'script' }, result => assert.equal(result.cancel, true));
  await assert.rejects(f.execute('click', { x: 1280, y: 1, frameId: 'x' })); await assert.rejects(f.execute('click', { x: 1, y: 2 }));
});

test('tabs are chat-scoped, share only their chat session and retain old optional-tab tool compatibility', async t => {
  const f = fixture(t); const opened = await f.execute('open', { url: 'https://example.com/a' });
  const second = await f.execute('new_tab', { url: 'https://example.com/b' }); const tabs = await f.execute('tabs'); assert.equal(tabs.tabs.length, 2); assert.equal(tabs.activeTabId, second.tabId);
  assert.equal(f.views[0].options.webPreferences.session, f.views[1].options.webPreferences.session);
  await f.execute('select_tab', { tabId: opened.tabId }); const snapshot = await f.execute('snapshot'); assert.equal(snapshot.tabId, opened.tabId);
  const frame = await f.execute('screenshot'); await assert.rejects(f.execute('click', { tabId: second.tabId, x: 1, y: 1, frameId: frame.frameId }), /Stale/);
  await f.execute('open', { url: 'https://example.com/other' }, 'b'); assert.notEqual(f.sessions[0].partition, f.sessions[1].partition);
  await assert.rejects(f.execute('select_tab', { tabId: opened.tabId }, 'b'), /does not belong/);
  await f.execute('close', { tabId: second.tabId }); assert.equal((await f.execute('tabs')).tabs.length, 1); assert.equal(f.views[0].destroyed, false); assert.equal(f.views[1].destroyed, true);
});

test('structured and vision handles expire after input or same-URL navigation without OS input', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' });
  const snapshot = await f.execute('snapshot'), elementId = snapshot.elements[0].id, frame = await f.execute('screenshot');
  await f.execute('click', { elementId }); await assert.rejects(f.execute('click', { elementId }), /Stale/); await assert.rejects(f.execute('scroll', { deltaY: 1, frameId: frame.frameId }), /Stale/);
  await f.execute('type', { text: 'Page only', clear: true }); const current = await f.execute('screenshot'); await f.execute('navigate', { url: 'https://example.com/' }); await assert.rejects(f.execute('click', { x: 2, y: 2, frameId: current.frameId }), /Stale/);
  assert.ok(f.views[0].commands.some(call => call.name === 'Input.insertText')); assert.equal(f.views[0].commands.some(call => /bringToFront|activateTarget/.test(call.name)), false);
});

test('human takeover synchronously revokes in-flight and queued work, holds all tools, and resumes only as stale errors', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' }); const view = f.views[0]; let release;
  view.captureGate = new Promise(resolve => { release = resolve; });
  let settled = 0; const screenshot = f.execute('screenshot').then(value => { settled++; return value; }, error => { settled++; return error; });
  const queued = f.execute('type', { text: 'Must never reach human field' }).catch(error => error); await tick();
  const taking = f.request('takeover'); assert.equal((await f.request('state')).sessions[0].mode, 'human');
  const reads = f.execute('tabs').then(() => { throw Error('Must remain held'); }, error => error); await tick(); assert.equal(settled, 0); assert.ok((await f.request('state')).sessions[0].waitingAgents >= 3); assert.equal(view.destroyed, false);
  release(); await taking; await tick(); assert.equal(f.events.some(event => event.type === 'browserFrame'), false); assert.equal(view.commands.some(call => call.name === 'Input.insertText'), false);
  await f.request('resume'); assert.match((await screenshot).message, /control|Browser switched/i); assert.match((await queued).message, /control|Browser switched/i); assert.match((await reads).message, /fresh observation/i);
  view.captureGate = null; assert.ok((await f.execute('snapshot')).elements.length);
  await f.request('takeover'); const controller = new AbortController(), waiting = f.execute('snapshot', {}, 'a', controller.signal).catch(error => error); await tick(); controller.abort(new Error('Stop fixture')); assert.match((await waiting).message, /Stop fixture/); assert.equal(view.destroyed, false);
});

test('native view is explicit, hideable and bounded; human shortcuts/find/zoom remain browser scoped', async t => {
  const f = fixture(t); const { tabId } = await f.execute('open', { url: 'https://example.com/' });
  assert.equal((await f.request('view', { visible: true, x: 10, y: 20, width: 600, height: 400 })).monitoring, true); assert.equal(f.attached.length, 0);
  await f.request('takeover'); await f.request('view', { tabId, visible: true, x: 10, y: 20, width: 600, height: 400 }); assert.equal(f.attached.length, 1); const view = f.views[0]; assert.equal(view.visible, true);
  let prevented = 0; view.webContents.emit('before-input-event', { preventDefault() { prevented++; } }, { type: 'keyDown', key: 'l', control: true }); assert.equal(prevented, 1); assert.equal(f.events.at(-1).action, 'address');
  assert.equal((await f.request('find', { text: 'fixture' })).requestId, 7); await f.request('zoom', { factor: 1.5 }); assert.equal(view.zoom, 1.5);
  f.browser.hideView(); assert.equal(f.attached.length, 0); assert.equal(view.visible, false);
  await f.request('resume'); assert.equal(view.zoom, 1); const frame = await f.execute('screenshot'); assert.equal(frame.width, 600); assert.equal(frame.height, 400);
  view.webContents.emit('before-input-event', { preventDefault() { throw Error('Agent input cannot produce browser UI shortcuts'); } }, { type: 'keyDown', key: 'l', control: true });
});

test('persistent metadata restores lazily with human ownership; closing tabs never clears website storage', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-browser-state-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const f = fixture(t, { dataDir }); const a = await f.execute('open', { url: 'https://example.com/a' }); const b = await f.execute('new_tab', { url: 'https://example.com/b' }); await f.execute('close', { tabId: b.tabId });
  await f.browser.request('browser.bookmark', { url: 'https://example.com/a', title: 'A bookmark' }); await f.request('takeover'); await f.browser.close(); assert.ok(f.sessions[0].flushed.includes('cookies'));
  const second = fixture(t, { dataDir }); await second.browser.initialize(); let state = await second.request('state'); assert.equal(second.views.length, 0); assert.equal(state.sessions[0].mode, 'human'); assert.equal(state.sessions[0].tabs.length, 1); assert.equal(state.sessions[0].activeTabId, a.tabId); assert.equal(state.sessions[0].tabs[0].loaded, false); assert.equal(state.bookmarks.length, 1);
  await second.request('takeover'); assert.equal(second.views[0].url, 'https://example.com/a'); assert.equal(second.sessions[0].partition, f.sessions[0].partition);
  second.views[0].unsaved = true; assert.equal((await second.request('closeTab', { tabId: a.tabId })).closed, false); assert.equal(second.views[0].destroyed, false);
});

test('Stop and cancellation stop loading without destroying durable tabs or blocking Close', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' });
  const pending = f.execute('navigate', { url: 'https://example.com/hold' }).catch(error => error); await tick(); await f.request('stop'); assert.equal(f.views[0].destroyed, false); await f.request('resume'); assert.match((await pending).message, /stopped|control/i);
  const controller = new AbortController(), canceled = f.execute('navigate', { url: 'https://example.com/hold' }, 'a', controller.signal).catch(error => error); await tick(); controller.abort(new Error('Cancel fixture')); assert.match((await canceled).message, /Cancel fixture/); assert.equal(f.views[0].destroyed, false);
  await f.execute('close'); assert.equal(f.views[0].destroyed, true);
});

test('file transfer requires human intent and rechecks ownership after native chooser awaits', async t => {
  const records = [], group = { mode: 'human', epoch: 1 }, tab = { id: 'tab' }, record = { tab, group, revision: 1, contents: { id: 1, downloadURL: value => records.push(value) } }; let release;
  const files = createBrowserFiles({ downloads: [], changed() {}, allowed: current => current.group.mode === 'human', chooseUpload: () => new Promise(resolve => { release = resolve; }), chooseSave: async () => path.join(os.tmpdir(), 'owned-browser-download') });
  t.after(() => files.close()); const upload = files.upload(record, { backendNodeId: 10 }, () => { throw Error('Stale upload must not submit'); }).catch(error => error); await tick(); group.mode = 'agent'; group.epoch++; release([path.join(os.tmpdir(), 'owned-fixture.txt')]); assert.match((await upload).message, /ownership changed/i);
  await assert.rejects(files.download(record, 'https://example.com/file'), /Take control/); group.mode = 'human'; await files.download(record, 'https://example.com/file'); assert.deepEqual(records, ['https://example.com/file']);
  const session = new EventEmitter(); files.install(session, () => record); let denied = 0;
  session.emit('will-download', { preventDefault() { denied++; } }, { getURL: () => 'https://example.com/other', getURLChain: () => ['https://example.com/other'], getFilename: () => 'other', getTotalBytes: () => 1 }, record.contents); assert.equal(denied, 1);
});

test('Save As uses the pending server filename and consumes only the download that starts', async t => {
  const downloads = [], session = new EventEmitter(), url = 'https://example.com/download', target = path.join(os.tmpdir(), 'controlled.txt'), proposed = [], started = [];
  const record = { tab: { id: 'tab' }, group: { chatId: 'a', mode: 'human', epoch: 1 }, contents: { id: 1 } }; let selection = null, revoke = false, savedPath;
  const item = () => Object.assign(new EventEmitter(), { getURL: () => url, getURLChain: () => [url], getFilename: () => 'controlled?.txt', getTotalBytes: () => 25, getReceivedBytes: () => 25, setSavePath: value => { savedPath = value; } });
  const files = createBrowserFiles({ downloads, changed() {}, allowed: current => current.group.mode === 'human', chooseSave: async filename => { proposed.push(filename); if (revoke) record.group.epoch++; return selection; } });
  t.after(() => files.close()); files.install(session, () => record);
  session.emit('will-download', { preventDefault() {} }, item(), record.contents); const pending = downloads[0];
  downloads.unshift({ ...pending, id: 'other-tab', tabId: 'other', filename: 'other-tab.txt' }, { ...pending, id: 'other-chat', chatId: 'b', filename: 'other-chat.txt' });
  record.contents.downloadURL = value => { started.push(value); const transfer = item(); session.emit('will-download', { preventDefault() { assert.fail('The approved transfer must start'); } }, transfer, record.contents); transfer.emit('done', {}, 'completed'); };
  assert.deepEqual(await files.download(record, url), { canceled: true }); assert.equal(proposed[0], 'controlled_.txt'); assert.ok(downloads.includes(pending)); assert.equal(started.length, 0);
  selection = 'relative.txt'; await assert.rejects(files.download(record, url), /absolute download destination/); assert.ok(downloads.includes(pending)); assert.equal(started.length, 0);
  selection = target; revoke = true; await assert.rejects(files.download(record, url), /ownership changed/); assert.ok(downloads.includes(pending)); assert.equal(started.length, 0);
  revoke = false; assert.deepEqual(await files.download(record, url), { started: true }); assert.equal(savedPath, target); assert.deepEqual(started, [url]);
  assert.equal(downloads.includes(pending), false); assert.equal(downloads.filter(entry => entry.status === 'completed').length, 1); assert.deepEqual(downloads.filter(entry => entry.status === 'pending').map(entry => entry.id), ['other-tab', 'other-chat']);
});

test('main bounds guard checks actual modal open property and preload exposes only bounded browser controls', async () => {
  const main = await fs.readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8'), preload = await fs.readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.ok(main.includes("document.querySelector('#modal')?.open")); assert.ok(main.includes("'#browser-page-slot'")); assert.ok(main.includes("window.on('blur'")); assert.ok(main.includes("['minimize','hide','resize']")); assert.ok(preload.includes("'browser.takeover'")); assert.ok(preload.includes("'browser.zoom'"));
});

test('automatic browser authority matches exact registered functions and never grants unrelated tools', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-browser-authority-')); let browser;
  const runtime = await createRuntime({ dataDir: path.join(root, 'profile'), sourceDir: path.join(root, 'source'), host: { isAutomaticTool: (tool, permission) => browser?.isAutomaticTool(tool, permission) } }); t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const f = fixture(t); browser = f.browser; const project = await runtime.request('project.create', { name: 'Fixture', path: root }), chat = await runtime.request('chat.create', { projectId: project.id }); f.chats.set(chat.id, chat); runtime.registerTools(browser.tools());
  let approvals = 0; const off = runtime.subscribe(event => { if (event.type === 'approval') { approvals++; void runtime.request('approval.resolve', { id: event.approval.id, allow: false }); } }); t.after(off);
  await runtime.request('tool.run', { chatId: chat.id, name: 'browser_open', args: { url: 'https://example.com/' } }); assert.equal(approvals, 0); assert.deepEqual((await runtime.request('state.get')).chats.find(item => item.id === chat.id).grants, []);
  const tool = browser.tools()[0]; assert.equal(browser.isAutomaticTool({ ...tool, execute: () => true }, tool.permission), false); assert.equal(browser.isAutomaticTool(tool, 'shell'), false);
  const download = browser.tools().find(tool => tool.name === 'browser_download'); assert.equal(download.permission, 'files'); assert.equal(browser.isAutomaticTool(download, 'files'), false);
  runtime.registerTools([{ name: 'ordinary_network', description: 'Fixture network', permission: 'network', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => true }]); await assert.rejects(runtime.request('tool.run', { chatId: chat.id, name: 'ordinary_network', args: {} }), /denied|declin/i);
});

test('overlapping monitor and tool captures serialize their native screenshot transactions', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' }); const view = f.views[0]; let release;
  view.captureGate = new Promise(resolve => { release = resolve; });
  await f.request('view', { visible: true, width: 1280, height: 800 });
  const first = f.execute('screenshot'); await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(view.subscriptions, 1); assert.equal(view.commands.filter(call => call.name === 'Page.captureScreenshot').length, 1, 'Monitor capture waits for the held native screenshot transaction');
  release(); await first; await tick(); assert.equal(view.subscriptions, 0); f.browser.hideView();
});

test('viewport resize waits for native screenshot restoration after caller cancellation', async t => {
  const f = fixture(t, { parkView: (view, size) => view.setBounds({ x: 0, y: 0, ...size }) }); await f.execute('open', { url: 'https://example.com/' });
  const view = f.views[0], original = view.webContents.debugger.sendCommand, controller = new AbortController(); let release, layoutWidth = 1280;
  view.captureGate = new Promise(resolve => { release = resolve; });
  view.webContents.debugger.sendCommand = async (name, args) => { const prior = layoutWidth, result = await original(name, args); if (name === 'Page.captureScreenshot') layoutWidth = prior; if (name === 'Emulation.setDeviceMetricsOverride') layoutWidth = args.width; return result; };
  const capture = f.execute('screenshot', {}, 'a', controller.signal).catch(error => error); await tick(); controller.abort(new Error('Cancel capture caller')); assert.match((await capture).message, /Cancel capture caller/);
  const resizing = f.request('view', { visible: true, width: 492, height: 700 }); await tick();
  assert.equal(view.commands.some(call => call.name === 'Emulation.setDeviceMetricsOverride' && call.args.width === 492), false); assert.equal(view.bounds.width, 1280); assert.equal(view.subscriptions, 1);
  release(); await resizing; assert.equal(layoutWidth, 492); assert.equal(view.bounds.width, 492); assert.equal(view.subscriptions, 0); assert.equal((await f.execute('snapshot')).viewport.width, 492); f.browser.hideView();
});

for (const action of ['open', 'navigate', 'back', 'forward', 'reload']) test(`${action} waits for raw capture settlement after its caller cancels`, async t => {
  const f = fixture(t); await f.execute('open', {url: 'https://example.com/a'}); await f.execute('navigate', {url: 'https://example.com/b'});
  if (action === 'forward') await f.execute('back');
  const view = f.views[0], calls = [], controller = new AbortController(); let release;
  for (const [api, name] of [[view.webContents, 'loadURL'], [view.webContents, 'reload'], [view.webContents.navigationHistory, 'goBack'], [view.webContents.navigationHistory, 'goForward']]) { const native = api[name]; api[name] = (...args) => {calls.push(name); return native(...args);}; }
  view.captureGate = new Promise(resolve => {release = resolve;});
  const capture = f.execute('screenshot', {}, 'a', controller.signal).catch(error => error); await tick(); controller.abort(new Error('Cancel capture caller')); await capture;
  const navigating = f.execute(action, ['open', 'navigate'].includes(action) ? {url: 'https://example.com/c'} : {}); await tick();
  assert.deepEqual(calls, [], 'No native navigation while Chromium still owns the capture');
  release(); await navigating; assert.ok(calls.length); assert.equal(view.subscriptions, 0);
});

test('native loading before its host event cannot start a surface capture', async t => {
  const f = fixture(t); await f.execute('open', {url: 'https://example.com/'}); const view = f.views[0]; view.loading = true;
  await assert.rejects(f.execute('screenshot'), /loading/); assert.equal(view.commands.some(call => call.name === 'Page.captureScreenshot'), false); view.loading = false;
});

test('delayed loading events cannot admit a monitor capture while native navigation waits', async t => {
  const f = fixture(t); await f.execute('open', {url: 'https://example.com/a'}); const view = f.views[0], controller = new AbortController(); let release;
  view.captureGate = new Promise(resolve => {release = resolve;}); const capture = f.execute('screenshot', {}, 'a', controller.signal).catch(error => error); await tick(); controller.abort(new Error('Cancel capture caller')); await capture;
  const navigating = f.execute('navigate', {url: 'https://example.com/b'}); await tick(); view.webContents.emit('did-stop-loading');
  await f.request('view', {visible: true, width: 1280, height: 800}); await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(view.commands.filter(call => call.name === 'Page.captureScreenshot').length, 1); assert.equal(view.url, 'https://example.com/a');
  release(); await navigating; f.browser.hideView(); assert.equal(view.url, 'https://example.com/b');
});

test('canceling navigation waiting on a raw capture never replays native navigation later', async t => {
  const f = fixture(t); await f.execute('open', {url: 'https://example.com/a'}); const view = f.views[0], captureStop = new AbortController(), navigationStop = new AbortController(); let release;
  view.captureGate = new Promise(resolve => {release = resolve;}); const capture = f.execute('screenshot', {}, 'a', captureStop.signal).catch(error => error); await tick(); captureStop.abort(new Error('Cancel capture caller')); await capture;
  const navigating = f.execute('navigate', {url: 'https://example.com/must-not-replay'}, 'a', navigationStop.signal).catch(error => error); await tick();
  navigationStop.abort(new Error('Cancel queued navigation')); assert.match((await navigating).message, /Cancel queued navigation/);
  release(); await tick(); assert.equal(view.url, 'https://example.com/a'); assert.equal(view.entries.includes('https://example.com/must-not-replay'), false); assert.equal(view.subscriptions, 0);
});

test('website navigation releases an interrupted CDP capture and reconfigures the same tab without replay', async t => {
  const f = fixture(t); const opened = await f.execute('open', {url: 'https://example.com/a'}); const view = f.views[0], history = [...view.entries];
  view.captureGate = new Promise(() => {}); const capture = f.execute('screenshot').catch(error => error); await tick();
  view.webContents.emit('did-start-navigation', {isMainFrame: true, url: 'https://example.com/automatic'}); view.url = 'https://example.com/automatic'; view.webContents.emit('did-stop-loading');
  assert.match((await capture).message, /page changed while capturing/); const snapshot = await f.execute('snapshot');
  assert.equal(snapshot.tabId, opened.tabId); assert.equal(snapshot.url, 'https://example.com/automatic'); assert.equal(f.views.length, 1); assert.equal(view.destroyed, false); assert.deepEqual(view.entries, history); assert.equal(view.subscriptions, 0); assert.equal((await f.request('state')).sessions[0].mode, 'agent'); assert.equal(view.commands.filter(call => call.name === 'Page.enable').length, 2);
});

test('a monitor capture queued before website interruption cannot dispatch before recovery setup', async t => {
  const f = fixture(t); await f.execute('open', {url: 'https://example.com/a'}); const view = f.views[0]; await f.request('view', {visible: true, width: 1280, height: 800});
  view.captureGate = new Promise(() => {}); const capture = f.execute('screenshot').catch(error => error); await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(view.commands.filter(call => call.name === 'Page.captureScreenshot').length, 1);
  view.webContents.emit('did-start-navigation', {isMainFrame: true, url: 'https://example.com/automatic'}); view.url = 'https://example.com/automatic'; view.webContents.emit('did-stop-loading'); await capture; await tick(); await tick();
  assert.equal(view.commands.filter(call => call.name === 'Page.captureScreenshot').length, 1, 'Queued monitor work cannot observe an incompletely configured debugger'); assert.ok((await f.execute('snapshot')).elements.length); assert.equal(view.commands.filter(call => call.name === 'Page.enable').length, 2); f.browser.hideView();
});

test('closing an interrupted tab before its queued recovery cannot recreate or replay it', async t => {
  const f = fixture(t); await f.execute('open', {url: 'https://example.com/a'}); const view = f.views[0], history = [...view.entries];
  view.captureGate = new Promise(() => {}); const capture = f.execute('screenshot').catch(error => error); await tick();
  view.webContents.emit('did-start-navigation', {isMainFrame: true, url: 'https://example.com/automatic'}); view.webContents.close(); await capture; await tick(); await tick();
  assert.equal((await f.request('state')).sessions.length, 0); assert.equal(f.views.length, 1); assert.equal(view.destroyed, true); assert.deepEqual(view.entries, history); assert.equal(view.commands.filter(call => call.name === 'Page.enable').length, 1);
});

test('Stop revocation before queued recovery prevents automatic setup under the old epoch', async t => {
  const f = fixture(t); await f.execute('open', {url: 'https://example.com/a'}); const view = f.views[0];
  view.captureGate = new Promise(() => {}); const capture = f.execute('screenshot').catch(error => error); await tick();
  view.webContents.emit('did-start-navigation', {isMainFrame: true, url: 'https://example.com/automatic'});
  f.browser.reconcile({chats: [{id: 'a'}], runs: [{chatId: 'a', status: 'canceled', endedAt: new Date(Date.now() + 1000).toISOString()}]}); await capture; await tick(); await tick();
  assert.equal(f.views.length, 1); assert.equal(view.commands.filter(call => call.name === 'Page.enable').length, 1); assert.equal((await f.request('state')).sessions[0].mode, 'agent');
});

test('website interruption during takeover preserves its pending human ownership setup', async t => {
  const f = fixture(t); await f.execute('open', {url: 'https://example.com/a'}); const view = f.views[0];
  view.captureGate = new Promise(() => {}); const capture = f.execute('screenshot').catch(error => error); await tick(); const taking = f.request('takeover');
  view.webContents.emit('did-start-navigation', {isMainFrame: true, url: 'https://example.com/automatic'}); view.url = 'https://example.com/automatic'; view.webContents.emit('did-stop-loading'); await taking;
  assert.equal((await f.request('state')).sessions[0].mode, 'human'); assert.equal(view.destroyed, false); assert.equal(view.subscriptions, 0); await f.request('resume'); assert.ok(await capture instanceof Error); assert.ok((await f.execute('snapshot')).elements.length);
});

test('ownership waits for raw capture completion before debugger reconfiguration', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' }); const view = f.views[0]; let release;
  view.captureGate = new Promise(resolve => { release = resolve; }); const capture = f.execute('screenshot').catch(error => error); await tick();
  const taking = f.request('takeover'); await tick(); assert.equal(view.debugAttached, true); assert.equal(view.subscriptions, 1); assert.equal(view.commands.some(call => call.name === 'Emulation.clearDeviceMetricsOverride'), false);
  release(); await taking; assert.equal(view.subscriptions, 0); assert.ok(view.commands.some(call => call.name === 'Emulation.clearDeviceMetricsOverride')); await f.request('resume'); assert.match((await capture).message, /control|switched/i);
});

test('agent ownership survives restart lazily without an artificial human pause', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-browser-agent-restore-'));
  const f = fixture(t, { dataDir }); await f.execute('open', { url: 'https://example.com/' }); await f.browser.close();
  const restored = fixture(t, { dataDir }); await restored.browser.initialize(); assert.equal((await restored.request('state')).sessions[0].mode, 'agent'); assert.equal(restored.views.length, 0); assert.equal((await restored.execute('snapshot')).url, 'https://example.com/');
});

test('closing the final human tab settles paused tools and does not strand a replacement group', async t => {
  const f = fixture(t); const opened = await f.execute('open', { url: 'https://example.com/' }); await f.request('takeover');
  const waiting = f.execute('snapshot').catch(error => error); await tick(); await f.request('closeTab', { tabId: opened.tabId }); assert.match((await waiting).message, /closed|fresh/i);
  await f.execute('open', { url: 'https://example.com/reopened' }); assert.equal((await f.execute('tabs')).tabs.length, 1);
});

test('late element resolution cannot bless coordinates across a viewport resize', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' }); const snapshot = await f.execute('snapshot'), view = f.views[0]; let release;
  const original = view.webContents.debugger.sendCommand; view.webContents.debugger.sendCommand = async (name, args) => { const result = await original(name, args); if (name === 'Runtime.evaluate' && args.expression.startsWith('(function elementPoint(')) await new Promise(resolve => { release = resolve; }); return result; };
  const clicking = f.execute('click', { elementId: snapshot.elements[0].id }).catch(error => error); await tick(); await f.request('view', { visible: true, width: 480, height: 720 }); release(); assert.match((await clicking).message, /Stale|changed/); assert.equal(view.commands.some(call => call.name === 'Input.dispatchMouseEvent'), false);
});

test('takeover readiness prevents a native attach before reconfiguration finishes', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' }); const view = f.views[0], original = view.webContents.debugger.sendCommand; let release;
  view.webContents.debugger.sendCommand = async (name, args) => { if (name === 'Emulation.clearDeviceMetricsOverride') await new Promise(resolve => { release = resolve; }); return original(name, args); };
  const taking = f.request('takeover'); await tick(); assert.equal((await f.request('state')).sessions[0].tabs[0].loaded, false); assert.equal((await f.request('view', { visible: true, width: 500, height: 600, x: 0, y: 0 })).visible, false); assert.equal(f.attached.length, 0);
  release(); await taking; await f.request('view', { visible: true, width: 500, height: 600, x: 0, y: 0 }); assert.equal(f.attached.length, 1);
});


test('validated agent click and Enter allow one owned popup without human control or native attachment', async t => {
  const f = fixture(t); const opened = await f.execute('open', { url: 'https://example.com/opener' }), view = f.views[0];
  assert.equal(view.popup({ url: 'https://example.com/unsolicited' }).action, 'deny');
  const original = view.webContents.debugger.sendCommand; let popup;
  view.webContents.debugger.sendCommand = async (name, args) => {
    const result = await original(name, args);
    if (name === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
      popup = view.popup({ url: 'https://example.com/child' });
      assert.equal(popup.action, 'allow'); assert.equal(view.popup({ url: 'https://example.com/second-unrequested' }).action, 'deny');
      const guest = f.createGuest(), child = popup.createWindow({ webContents: guest }); assert.equal(child, guest); assert.equal(child, f.views[1].webContents);
      assert.equal(child.debugger.isAttached(), false, 'Popup debugger setup must wait until Electron has adopted the returned contents');
      assert.equal(popup.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false); assert.equal(popup.overrideBrowserWindowOptions.webPreferences.sandbox, true);
    }
    return result;
  };
  const frame = await f.execute('screenshot'); await f.execute('click', { x: 140, y: 100, frameId: frame.frameId }); await tick();
  const tabs = await f.execute('tabs'); assert.equal(tabs.tabs.length, 2); assert.equal(tabs.tabs.find(tab => tab.id === tabs.activeTabId).url, 'https://example.com/child');
  assert.equal((await f.request('state')).sessions[0].mode, 'agent'); assert.equal(f.attached.length, 0); assert.equal(f.views[1].options.webPreferences.session, view.options.webPreferences.session);
  view.webContents.debugger.sendCommand = original;
  await f.execute('key', { tabId: opened.tabId, key: 'Enter' }); assert.equal(view.popup({ url: 'https://example.com/from-enter' }).action, 'allow');
});

test('agent popup intent is revoked by cancellation, navigation, ownership transfer and tab caps', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' }); const view = f.views[0], controller = new AbortController();
  await f.execute('key', { key: 'Enter' }, 'a', controller.signal); controller.abort(new Error('Cancel popup intent'));
  assert.equal(view.popup({ url: 'https://example.com/canceled' }).action, 'deny');
  await f.execute('key', { key: 'Enter' }); assert.equal(view.popup({ url: 'file:///C:/secret' }).action, 'deny');
  await f.execute('navigate', { url: 'https://example.com/new-page' }); assert.equal(view.popup({ url: 'https://example.com/old-intent' }).action, 'deny');
  await f.execute('key', { key: 'Enter' }); const reserved = view.popup({ url: 'https://example.com/reserved' }); assert.equal(reserved.action, 'allow');
  await f.request('takeover'); assert.throws(() => reserved.createWindow(), /control|capacity/i); assert.equal(f.views.length, 1);
  const capped = fixture(t, { maxLiveTabs: 1 }); await capped.execute('open', { url: 'https://example.com/' }); await capped.execute('key', { key: 'Enter' });
  assert.equal(capped.views[0].popup({ url: 'https://example.com/over-cap' }).action, 'deny'); assert.equal(capped.views.length, 1);
});

test('native geometry accepts harmless fractional zoom edges while rejecting real overflow', async () => {
  const { runInNewContext } = await import('node:vm');
  const main = await fs.readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const match = main.match(/const bounds=await window\.webContents\.executeJavaScript\(`([\s\S]*?)`\);/);
  assert.ok(match); const expression = Function('return `' + match[1] + '`;')();
  const rect = { x: 694.2, y: 145.3, width: 445, height: 570.7, left: 694.2, top: 145.3, right: 1139.2, bottom: 716 };
  const slot = { closest: () => null, getBoundingClientRect: () => rect, parentElement: null };
  const document = { body: { matches: () => false, inert: false }, querySelectorAll: () => [], querySelector: selector => selector === '#browser-page-slot' ? slot : selector === '#browser-session' ? { value: 'fixture-chat' } : selector === '#modal' ? { open: false } : { dataset: { browserTab: 'fixture-tab' } } };
  const result = runInNewContext(expression, { document, innerWidth: 1139, innerHeight: 800 }); assert.equal(result.tabId, 'fixture-tab'); assert.equal(result.width, 445);
  rect.right = 1139.51; assert.equal(runInNewContext(expression, { document, innerWidth: 1139, innerHeight: 800 }), null);
});


test('failed setup remains unavailable until a real configuration retry completes', async t => {
  const f = fixture(t, { initializationFailures: 1 }); await assert.rejects(f.execute('open', { url: 'https://example.com/' }), /setup failed/);
  assert.equal((await f.request('state')).sessions[0].tabs[0].loaded, false);
  const retried = await f.execute('open', { url: 'https://example.com/retried' }); assert.equal(retried.loaded, true); assert.equal(retried.url, 'https://example.com/retried'); assert.equal(f.views.length, 1);
  assert.equal(f.views[0].commands.filter(call => call.name === 'Page.enable').length, 2);
});

test('new agent work waits for Resume setup and superseded takeover cannot replace newer readiness', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' }); const view = f.views[0], original = view.webContents.debugger.sendCommand; let releaseHuman, releaseAgent, holdAgent = false;
  view.webContents.debugger.sendCommand = async (name, args) => {
    if (name === 'Emulation.clearDeviceMetricsOverride') await new Promise(resolve => { releaseHuman = resolve; });
    if (name === 'Emulation.setDeviceMetricsOverride' && holdAgent) await new Promise(resolve => { releaseAgent = resolve; });
    return original(name, args);
  };
  const old = f.request('takeover').catch(error => error); await tick(); holdAgent = true;
  const resumed = f.request('resume'); await tick(); let readDone = false;
  const reading = f.execute('snapshot').then(value => { readDone = true; return value; }); await tick(); assert.equal(readDone, false); assert.equal((await f.request('state')).sessions[0].tabs[0].loaded, false);
  assert.equal(releaseAgent, undefined, 'Resume waits for the prior native metrics command to settle'); releaseHuman(); await tick(); releaseAgent(); await resumed; assert.ok((await reading).elements.length); assert.ok(await old instanceof Error);
  const state = (await f.request('state')).sessions[0]; assert.equal(state.mode, 'agent'); assert.equal(state.tabs[0].loaded, true); assert.equal(view.destroyed, false);
});

test('passive frame races do not persist an error banner but tool failures remain visible', async t => {
  const f = fixture(t); await f.execute('open', { url: 'https://example.com/' }); const view = f.views[0], original = view.webContents.debugger.sendCommand;
  view.webContents.debugger.sendCommand = (name, args) => name === 'Page.captureScreenshot' ? Promise.reject(new Error('Browser page is loading. Wait for it to finish.')) : original(name, args);
  await assert.rejects(f.request('frame'), /loading/); assert.equal((await f.request('state')).sessions[0].tabs[0].error, undefined);
  await assert.rejects(f.execute('screenshot'), /loading/); assert.match((await f.request('state')).sessions[0].tabs[0].error, /loading/);
});
