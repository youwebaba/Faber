import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../core/runtime.mjs';
import { createGateway } from '../desktop/gateway.mjs';
import { createProfiles, assertProfileSwitchAllowed } from '../desktop/profile-path.cjs';
import { validateRequestPayload } from '../desktop/request-payload.mjs';

// Standalone, isolated renderer/preload/runtime acceptance. Native relaunch and
// recovery actions are scoped fixtures; real host/bootstrap checks are separate.
const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-roadmap-ui-'));
const progress = stage => writeFileSync(path.join(dataDir, 'progress.txt'), stage);
process.on('uncaughtException', error => { writeFileSync(path.join(dataDir, 'early-error.txt'), error.stack || String(error)); app.exit(1); });
process.on('unhandledRejection', error => { writeFileSync(path.join(dataDir, 'early-error.txt'), error.stack || String(error)); app.exit(1); });
progress('created'); mkdirSync(path.join(dataDir, 'electron'));
app.setPath('userData', path.join(dataDir, 'electron'));
protocol.registerSchemesAsPrivileged([{ scheme: 'faber', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const screenshots = {}, checks = [], errors = [], hostCalls = [], secrets = new Map(), held = new Map();
const profiles = createProfiles(path.join(dataDir, 'profile-registry'), { defaultDirectory: path.join(dataDir, 'data') });
let runtime, runtimeTransition, gateway, window, failRecovery = false, safeMode = true, rejectSwitch = true, readyCalls = 0;
const host = { getSecret: async id => secrets.get(id), setSecret: async (id, value) => { secrets.set(id, value); } };
const emit = event => { if (window && !window.isDestroyed()) window.webContents.send('faber:event', event); };
async function openRuntime() {
  runtime = await createRuntime({ dataDir: path.join(dataDir, 'data'), sourceDir, host, provider: async function* ({ messages }) {
    const last = messages.findLast(message => message.role === 'user')?.content;
    if (['INITIAL_BUSY', 'STOP_BUSY'].includes(last)) yield { type: 'tool', id: last, name: 'fixture_hold', args: { label: last } };
    else yield { type: 'delta', text: 'Fixture follow-up applied.' };
  } });
  runtime.registerTools([{ name: 'fixture_hold', description: 'Controlled safe-point fixture', permission: 'read', parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false }, execute: async ({ label }, ctx) => {
    await new Promise((resolve, reject) => { held.set(label, resolve); ctx.signal.addEventListener('abort', () => { held.delete(label); reject(ctx.signal.reason || new Error('Canceled')); }, { once: true }); }); held.delete(label); return { held: label };
  } }]);
  runtime.subscribe(emit);
}
const js = code => window.webContents.executeJavaScript(code);
const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const change = (selector, value) => js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(node.type==='checkbox')node.checked=${JSON.stringify(value)};else node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
async function until(predicate, label) { const end = Date.now() + 15000; while (Date.now() < end) { const value = await predicate(); if (value) return value; await pause(40); } throw new Error(`Roadmap UI timeout: ${label}; ${await js('document.body.innerText')}`); }
async function capture(name) {
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); window.webContents.invalidate(); await window.webContents.capturePage(); await pause(90);
  const file = path.join(dataDir, `${name}.png`); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots[name] = file;
}
async function send(text, enter = false) {
  await change('#prompt', text);
  await js(enter ? `document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))` : `document.querySelector('#composer').requestSubmit()`);
}
const state = () => runtime.request('state.get');
const current = async chat => (await state()).chats.find(item => item.id === chat.id);
async function settled(chat) { return until(async () => (await state()).runs.findLast(run => run.chatId === chat.id && !['running', 'waiting_approval'].includes(run.status)), 'settled run'); }
const watchdog = setTimeout(() => { console.error('Roadmap UI fixture exceeded 90 seconds'); app.exit(1); }, 90000); watchdog.unref();
async function run() {
try {
  progress('waiting-ready'); await app.whenReady(); progress('runtime'); await openRuntime();
  const projectPath = path.join(dataDir, 'project'), otherPath = path.join(dataDir, 'other-project'); await fs.mkdir(projectPath); await fs.mkdir(otherPath);
  const project = await runtime.request('project.create', { name: 'Roadmap UI fixture', path: projectPath }), other = await runtime.request('project.create', { name: 'Second project', path: otherPath });
  const provider = await runtime.request('provider.save', { id: 'roadmap-ui', name: 'Fixture local/API', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-model' });
  const chat = await runtime.request('chat.create', { projectId: project.id, title: 'Remaining roadmap' }); await runtime.request('chat.update', { id: chat.id, providerId: provider.id, model: 'fixture-model' });
  const otherChat = await runtime.request('chat.create', { projectId: other.id, title: 'Other draft' });
  protocol.handle('faber', async request => {
    const url = new URL(request.url); if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
    const file = path.resolve(sourceDir, 'renderer', decodeURIComponent(url.pathname).slice(1)); if (!file.startsWith(path.join(sourceDir, 'renderer') + path.sep)) return new Response('Forbidden', { status: 403 });
    try { return new Response(await fs.readFile(file), { headers: { 'Content-Type': ({ '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  window = new BrowserWindow({ width: 1440, height: 950, useContentSize: true, show: false, backgroundColor: '#181818', webPreferences: { preload: path.join(sourceDir, 'desktop', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  ipcMain.handle('faber:request', async (event, method, params = {}) => {
    if (runtimeTransition) await runtimeTransition;
    assert.equal(event.sender, window.webContents); assert.equal(event.senderFrame, window.webContents.mainFrame); validateRequestPayload(method, params);
    if (method === 'app.uiState') return null;
    if (method === 'app.recoveryStatus') { if (failRecovery) throw new Error('Controlled recovery status failure'); hostCalls.push(method); return { safeMode, reason: 'Controlled startup recovery fixture. All addons were suppressed.' }; }
    if (method === 'app.uiReady') {
      assert.ok(hostCalls.includes('state.get')); assert.ok(hostCalls.includes('app.recoveryStatus'));
      assert.equal(await js(`document.documentElement.dataset.uiReady`), 'false'); assert.ok(await js(`document.querySelector('#transcript').children.length>0`));
      if (safeMode) assert.equal(await js(`document.querySelector('#modal-title').textContent`), 'Currently in SAFEMODE');
      readyCalls++; return { ready: true, safeMode };
    }
    if (method === 'app.restartNormal') { hostCalls.push(method); return { restarting: false }; }
    if (method === 'profiles.list') return profiles.list();
    if (method === 'profiles.create') return profiles.create(params.name);
    if (method === 'profiles.rename') return profiles.rename(params.id, params.name);
    if (method === 'profiles.switch') {
      hostCalls.push({ method, params }); assertProfileSwitchAllowed({ draftsCleared: params.draftsCleared, runs: (await state()).runs });
      if (rejectSwitch) throw new Error('Controlled active download refusal; drafts preserved');
      return { restarting: true, currentId: params.id };
    }
    if (method.startsWith('gateway.')) {
      gateway ||= await createGateway({ dataDir: path.join(dataDir, 'data'), runtime, host, emit, stream: async function* () { yield { type: 'delta', text: 'Gateway fixture response' }; } });
      return gateway.request(method, params);
    }
    if (method === 'localModels.list') return { models: [], modelLabels: [], process: { status: 'stopped' } };
    if (method === 'chatgpt.status') return { accounts: [], activeAccountId: null, signIn: { status: 'idle' } };
    if (method === 'browser.state') return { sessions: [], bookmarks: [], history: [], downloads: [] };
    if (method === 'browser.view' || method === 'browser.chromeFocus') return {};
    if (method === 'models.state') return { downloads: [], downloadDirectory: projectPath };
    if (method === 'addons.list') return { addons: [], errors: [] };
    if (method === 'provider.test') return { ok: true, models: ['fixture-model', 'second-fixture'] };
    if (method === 'state.get') hostCalls.push(method);
    return runtime.request(method, params);
  });
  progress('loading-renderer'); await window.loadURL('faber://app/index.html'); await until(() => js(`document.documentElement.dataset.uiReady==='true'`), 'startup healthy');
  assert.equal(readyCalls, 1); assert.equal(await js(`document.querySelector('#safe-mode-status').hidden`), false); assert.equal(await js(`document.querySelector('#quickstart-done')===null`), true);
  await capture('roadmap-safe-mode'); checks.push('app.uiReady follows successful state/recovery/render; Safe Mode wins over onboarding and stays visible');
  await click('#safe-restart-normal'); assert.ok(hostCalls.includes('app.restartNormal'));
  await click('#close-modal'); await click(`[data-chat-id="${chat.id}"]`);
  await send('INITIAL_BUSY'); await until(() => held.has('INITIAL_BUSY'), 'held tool');
  assert.equal(await js(`document.querySelector('#send-message').hidden`), false); assert.equal(await js(`document.querySelector('#stop-run').hidden`), false);
  await click('#open-settings'); assert.equal(await js(`document.querySelector('#settings-run-timeout-minutes').value`), '10');
  await change('#settings-run-timeout-minutes', ''); await click('#settings-save-run-timeout'); await until(() => js(`document.querySelector('#notice-text').textContent.includes('Enter an overall run duration')`), 'empty duration rejected'); assert.equal((await state()).settings.runTimeoutMs, 600000);
  await change('#settings-run-timeout-minutes', '3'); await click('#settings-save-run-timeout'); await until(async () => (await state()).settings.runTimeoutMs === 180000, 'custom active duration'); await until(() => js(`!document.querySelector('#settings-save-run-timeout').disabled`), 'duration save settled');
  await change('#settings-run-timeout-mode', 'off'); await click('#settings-save-run-timeout'); await until(async () => (await state()).settings.runTimeoutMs === 0, 'overall limit off'); await capture('roadmap-time-limit-off');
  await click('#close-modal'); await click('#open-settings'); assert.equal(await js(`document.querySelector('#settings-run-timeout-mode').value`), 'off'); assert.equal(await js(`document.querySelector('#settings-run-timeout-minutes').disabled`), true); await click('#close-modal');
  await send('Steering from Enter', true); await until(async () => (await current(chat)).inbox?.length === 1, 'queued Enter followup');
  const queued = (await current(chat)).inbox[0]; await until(() => js(`document.querySelector('[data-message-id="${queued.id}"] .pending-followup-label')?.textContent==='Pending follow-up'`), 'durable pending label');
  await capture('roadmap-busy-followups');
  held.get('INITIAL_BUSY')(); await settled(chat); await until(() => js(`document.querySelectorAll('[data-message-id="${queued.id}"]').length===1 && !document.querySelector('[data-message-id="${queued.id}"]').classList.contains('pending-followup')`), 'delivered identity');
  await window.webContents.reload(); await until(() => js(`document.documentElement.dataset.uiReady==='true'`), 'delivered reload');
  assert.equal(await js(`document.querySelectorAll('[data-message-id="${queued.id}"]').length`), 1); await click('#close-modal');
  await send('STOP_BUSY'); await until(() => held.has('STOP_BUSY'), 'second held tool'); await send('Retain after Stop'); await until(async () => (await current(chat)).inbox?.length === 1, 'second pending followup');
  const retained = (await current(chat)).inbox[0]; await click('#stop-run'); await settled(chat);
  let finishRestart; runtimeTransition = new Promise(resolve => { finishRestart = resolve; }); await runtime.close(); await openRuntime(); finishRestart(); runtimeTransition = undefined; await window.webContents.reload(); await until(() => js(`document.documentElement.dataset.uiReady==='true'`), 'pending restart');
  assert.equal((await current(chat)).inbox[0].id, retained.id); assert.equal(await js(`document.querySelectorAll('[data-message-id="${retained.id}"] .pending-followup-label').length`), 1); await click('#close-modal');
  assert.equal((await state()).settings.runTimeoutMs, 0); checks.push('Overall run time limit validates empty/custom minutes, applies custom/Off to an active run, persists across restart and keeps Stop available');
  checks.push('Send and Enter queue while Stop remains available; delivery and Stop/runtime-restart preserve one identity and correct pending state');
  await click('#chat-options'); await change(`[data-project-grant="${other.id}"]`, true);
  await js(`[...document.querySelectorAll('#modal-body button')].find(node=>node.textContent==='Save changes').click()`);
  await until(async () => (await current(chat)).projectGrants.includes(other.id), 'named grant');
  await click('#chat-options'); await change(`[data-project-grant="${other.id}"]`, false); await js(`[...document.querySelectorAll('#modal-body button')].find(node=>node.textContent==='Save changes').click()`); await until(async () => !(await current(chat)).projectGrants.length, 'named revoke');
  const creating = runtime.request('tool.run', { chatId: chat.id, name: 'project_create', args: { name: 'Created by approval', path: projectPath } }).then(value => value, error => ({ error: error.message }));
  await until(() => js(`!!document.querySelector('.approval')`), 'project creation approval');
  assert.equal(await js(`document.querySelectorAll('.approval input[type=checkbox]').length`), 0);
  assert.match(await js(`document.querySelector('.approval').innerText`), /Created by approval/);
  await js(`[...document.querySelectorAll('.approval button')].find(node=>node.textContent==='Deny').click()`); await creating;
  checks.push('User grants and revokes named project scope; nonrememberable project approval names its target and hides Remember');
  await click('#open-settings'); await click('[data-settings-category="profiles"].nav-button'); await until(() => js(`!!document.querySelector('#new-profile-name')`), 'profiles category');
  await change('#new-profile-name', 'Secondary fixture'); await js(`[...document.querySelectorAll('.settings-pane button')].find(node=>node.textContent==='Create profile').click()`); await until(() => profiles.list().profiles.length === 2, 'create separate profile'); await until(() => js(`document.querySelectorAll('.profile-settings-row').length===2`), 'profile rows');
  await change('[aria-label="Name for Secondary fixture"]', 'Renamed fixture'); await js(`document.querySelector('[aria-label="Name for Secondary fixture"]').closest('.profile-settings-row').querySelector('button').click()`); await until(() => profiles.list().profiles.some(profile => profile.name === 'Renamed fixture'), 'rename profile'); await until(() => js(`document.querySelector('[aria-label="Name for Renamed fixture"]')!==null`), 'renamed row');
  await capture('roadmap-profiles'); const secondary = profiles.list().profiles.find(profile => !profile.current);
  await click('#close-modal'); await click(`[data-chat-id="${otherChat.id}"]`); await change('#prompt', 'Draft in another chat'); await click(`[data-chat-id="${chat.id}"]`); await change('#prompt', 'Current chat draft');
  await js(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['draft file bytes'],'draft.txt',{type:'text/plain'}));const picker=document.querySelector('#file-picker');picker.files=transfer.files;picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  // Add an image through the actual paste handler as well as a text-file draft.
  await js(`(()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'draft.png',{type:'image/png'}));document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:transfer}));})()`);
  await until(() => js(`document.querySelectorAll('.image-draft').length===2 && !document.querySelector('#image-draft-status').textContent.includes('Reading')`), 'image draft');
  await click('#chat-options'); await js(`document.querySelector('#modal input[type=text]').value='Unsaved form title'`);
  await js(`document.querySelector('#profile-switcher').click()`); await until(() => js(`document.querySelector('#profile-switch-dialog').open`), 'profile switcher'); await change('#switch-profile-choice', secondary.id); await click('#switch-profile-submit');
  assert.equal(hostCalls.filter(item => item?.method === 'profiles.switch').length, 0); await click('#confirm-profile-switch'); await until(() => js(`document.querySelector('#profile-switch-dialog').textContent.includes('drafts preserved')`), 'switch refusal');
  assert.equal(await js(`document.querySelector('#prompt').value`), 'Current chat draft'); assert.equal(await js(`document.querySelectorAll('.image-draft').length`), 2); assert.equal(await js(`document.querySelector('#modal input[type=text]').value`), 'Unsaved form title');
  await js(`document.querySelector('#profile-switch-dialog').close();document.querySelector('#modal').close()`); await click(`[data-chat-id="${otherChat.id}"]`); assert.equal(await js(`document.querySelector('#prompt').value`), 'Draft in another chat'); await click(`[data-chat-id="${chat.id}"]`);
  rejectSwitch = false; await click('#profile-switcher'); await until(() => js(`document.querySelector('#profile-switch-dialog').open`), 'accepted switcher'); await change('#switch-profile-choice', secondary.id); await click('#switch-profile-submit'); await click('#confirm-profile-switch'); await until(() => js(`document.querySelector('#profile-switch-dialog').textContent.includes('Restarting in')`), 'accepted switch'); assert.equal(await js(`document.querySelector('#prompt').value`), 'Current chat draft'); await js(`document.querySelector('#profile-switch-dialog').close()`);
  checks.push('Separate profile created/renamed; explicit discard consent precedes host switch; rejection retains every chat, image and form draft');
  await click('#open-settings'); await click('[data-settings-category="external"].nav-button'); await until(() => js(`!!document.querySelector('#gateway-start')`), 'external settings');
  assert.equal((await gateway.request('gateway.status')).running, false); assert.equal(await js(`document.querySelector('#gateway-remote').checked`), false); assert.match(await js(`document.querySelector('.gateway-network-note').textContent`), /unencrypted HTTP/);
  await js(`window.__tokenCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.__tokenCopies.push(value)}})`);
  await change('#gateway-project', project.id); await change('#gateway-provider', provider.id); await click('#gateway-list-models'); await until(() => js(`document.querySelector('.gateway-model-catalog').textContent.includes('second-fixture')`), 'model catalog');
  await js(`[...document.querySelectorAll('.gateway-model-catalog button')].find(node=>node.textContent==='fixture-model').click()`); await change('#gateway-port', '0'); await click('#gateway-save'); await until(async () => (await gateway.request('gateway.status')).config.model === 'fixture-model', 'saved explicit gateway route'); await until(() => js(`!document.querySelector('#gateway-rotate-token').disabled`), 'configuration save settled');
  await click('#gateway-rotate-token'); await until(() => js(`!document.querySelector('#gateway-token').closest('label').hidden`), 'one-time token'); assert.equal(await js(`window.__tokenCopies.length`), 0); await click('#gateway-copy-token'); assert.equal(await js(`window.__tokenCopies.length`), 1);
  await click('#gateway-start'); await until(async () => (await gateway.request('gateway.status')).running, 'gateway start'); assert.equal(await js(`document.querySelector('#gateway-address').disabled`), true); assert.match(await js(`document.querySelector('#gateway-urls').textContent`), /\/v1.*\/mcp/);
  await capture('roadmap-external-access'); assert.equal(await js(`document.querySelector('#gateway-start').disabled`), true); assert.equal(await js(`document.querySelector('#gateway-list-models').disabled`), true); await js(`document.querySelector('#gateway-stop').scrollIntoView({block:'center'})`); await capture('roadmap-external-controls'); await click('#gateway-stop'); await until(async () => !(await gateway.request('gateway.status')).running, 'gateway stop'); await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); assert.equal(await js(`document.querySelector('#gateway-stop').disabled`), true); await click('#close-modal'); await until(() => js(`document.querySelector('#gateway-token').value===''`), 'token cleared on close'); await click('#open-settings'); await click('[data-settings-category="external"].nav-button'); await until(() => js(`!!document.querySelector('#gateway-token')`), 'reopened external settings'); assert.equal(await js(`document.querySelector('#gateway-token').value`), '');
  checks.push('External access starts off; explicit target/model, literal-address controls, model listing, stopped-only editing, one-time token, click-only clipboard, URLs and Stop exercised');
  const beforeFailure = readyCalls; failRecovery = true; await window.webContents.reload(); await until(() => js(`document.documentElement.dataset.uiReady==='error'`), 'recovery read failure'); assert.equal(readyCalls, beforeFailure); checks.push('Failed bootstrap never reports app.uiReady');
  const report = { ok: true, realRenderer: true, realPreload: true, realRuntime: true, realGateway: true, nativeProfileSwitchAndRecovery: 'scoped fixtures; actual bootstrap/main checked separately', installedAppTouched: false, inferenceCalls: 0, checks, readyCalls, screenshots, rendererErrors: errors.filter(error => !/Controlled recovery status failure/.test(error)), dataDir };
  await fs.writeFile(path.join(dataDir, 'roadmap-ui-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  await gateway?.close(); await runtime.close(); window.destroy(); clearTimeout(watchdog); app.exit(0);
} catch (error) {
  console.error(error); console.error(JSON.stringify({ rendererErrors: errors, hostCalls })); console.error('Fixture evidence directory: ' + dataDir); await gateway?.close().catch(() => {}); await runtime?.close().catch(() => {}); if (window && !window.isDestroyed()) window.destroy(); clearTimeout(watchdog); app.exit(1);
}

}
void run();
