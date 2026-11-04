import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import syncFS from 'node:fs';
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import path from 'node:path';
import {app, session, WebContentsView} from 'electron';
import {createBrowserManager} from '../../desktop/browser.mjs';

const [phase, root, base] = process.argv.slice(2);
assert.ok(['write', 'read', 'logout'].includes(phase));
assert.ok(path.isAbsolute(root) && path.basename(root).startsWith('Faber-browser-persistence-'));
const relative = path.relative(os.tmpdir(), root);
assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Fixture profile must stay under the system temporary directory');
const origin = new URL(base); assert.equal(origin.hostname, '127.0.0.1'); assert.equal(origin.protocol, 'http:');
const profile = path.join(root, 'profile'), dataDir = path.join(root, 'manager');
const keyBytes = createHash('sha256').update('Synthetic fixture codec only; never real credentials').digest();
const secretPath = key => { assert.match(key, /^[a-f0-9]{64}$/); return path.join(root, 'synthetic-secrets', key + '.bin'); };
const readSessionCookies = async key => { let bytes; try { bytes = await fs.readFile(secretPath(key)); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } const decipher = createDecipheriv('aes-256-gcm', keyBytes, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); };
const writeSessionCookies = async (key, text) => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyBytes, iv), encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); await fs.mkdir(path.join(root, 'synthetic-secrets'), {recursive: true}); await fs.writeFile(secretPath(key), Buffer.concat([iv, cipher.getAuthTag(), encrypted])); };
syncFS.mkdirSync(profile, {recursive: true}); app.setPath('userData', profile);
let heldUpload, releaseUpload;
const uploadFile = path.join(root, 'fixture-upload.txt'), downloadFile = path.join(root, 'fixture-download.txt');
const wait = async (predicate, label) => { const end = Date.now() + 10000; while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Persistence fixture timeout: ' + label); };
const views = [], chatId = 'persistence-fixture', expectedPath = path.join(root, 'expected.json');
let browser;
void app.whenReady().then(async () => {
try {
  browser = createBrowserManager({dataDir, readSessionCookies, writeSessionCookies, chooseSave: async () => downloadFile, chooseUpload: async () => heldUpload ? new Promise(resolve => {releaseUpload = resolve;}) : [uploadFile], createView: options => { const view = new WebContentsView(options); views.push(view); return view; }, createSession: (partition, options) => session.fromPartition(partition, options), getChat: id => ({id}), attachView() {}, detachView() {}, isViewAllowed: () => false});
  await browser.initialize();
  const request = (name, args = {}) => browser.request('browser.' + name, {chatId, ...args});
  const state = () => browser.request('browser.state', {});
  const owned = async () => (await state()).sessions.find(item => item.chatId === chatId);
  let proof;
  if (phase === 'write') {
    await request('open', {url: base + '/signin'});
    const first = (await owned()).activeTabId;
    await request('newTab', {url: base + '/second'});
    const second = (await owned()).activeTabId;
    await request('newTab', {url: base + '/closed'});
    const closed = (await owned()).activeTabId;
    await request('closeTab', {tabId: closed});
    await request('selectTab', {tabId: first});
    await request('takeover', {tabId: first});
    const page = views.find(view => view.webContents.getURL() === base + '/signin').webContents;
    const jar = await page.session.cookies.get({url: base});
    assert.ok(jar.some(cookie => cookie.name === 'session_fixture' && cookie.httpOnly));
    assert.ok(jar.some(cookie => cookie.name === 'persistent_fixture' && cookie.httpOnly && cookie.expirationDate));
    await fs.writeFile(uploadFile, 'Controlled upload fixture bytes');
    await page.executeJavaScript("document.querySelector('#file').focus()");
    await request('upload', {tabId: first});
    assert.equal(await page.executeJavaScript("document.querySelector('#file').files[0].text()"), 'Controlled upload fixture bytes', 'Host-selected file reaches the actual page FileList');
    await request('download', {tabId: first, url: base + '/download'});
    const download = await wait(async () => (await state()).downloads.find(item => item.status === 'completed'), 'controlled download completion');
    assert.equal(download.chatId, chatId); assert.equal(download.tabId, first);
    assert.equal(await fs.readFile(downloadFile, 'utf8'), 'Controlled download fixture bytes');
    await page.executeJavaScript("document.querySelector('#canceled-file').focus()");
    heldUpload = true;
    const pendingUpload = request('upload', {tabId: first}).then(value => ({value}), error => ({error}));
    await wait(() => releaseUpload, 'held upload chooser');
    await request('resume'); releaseUpload([uploadFile]);
    assert.ok((await pendingUpload).error, 'Ownership change rejects pending upload');
    assert.equal(await page.executeJavaScript("document.querySelector('#canceled-file').files.length"), 0, 'Resume prevents stale file injection');
    await assert.rejects(request('download', {tabId: first, url: base + '/download'}), /control|human/i);
    await request('takeover', {tabId: first});
    await fs.writeFile(expectedPath, JSON.stringify({first, second, closed}));
    proof = {phase, ok: true, tabs: 2, humanOwnership: (await owned()).mode === 'human', httpOnlyCookiesSet: true, realFileListUpload: true, controlledDownloadBytes: true, downloadTabOwnership: true, staleUploadRejected: true};
  } else {
    const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8')), restored = await owned();
    assert.equal(views.length, 0, 'Initializing persisted metadata must not create or navigate a page');
    assert.equal(restored.mode, 'human', 'Human ownership remains private across app restart');
    assert.equal(restored.activeTabId, expected.first);
    assert.deepEqual(restored.tabs.map(tab => tab.id).sort(), [expected.first, expected.second].sort());
    assert.ok(restored.tabs.every(tab => tab.loaded === false));
    assert.ok(!restored.tabs.some(tab => tab.id === expected.closed));
    await request('takeover', {tabId: expected.first});
    const page = views.find(view => view.webContents.getURL() === base + '/signin').webContents;
    const jar = await page.session.cookies.get({url: base});
    const sessionCookieSurvived = jar.some(cookie => cookie.name === 'session_fixture' && cookie.value === 'synthetic-session-only' && cookie.httpOnly);
    const persistentCookieSurvived = jar.some(cookie => cookie.name === 'persistent_fixture' && cookie.value === 'synthetic-persistent-only' && cookie.httpOnly);
    proof = {phase, ok: true, lazyRestore: true, closedTabStayedClosed: true, sessionCookieSurvived, persistentCookieSurvived, httpOnlyHiddenFromPage: await page.executeJavaScript('document.cookie') === ''};
    await fs.writeFile(path.join(root, phase + '-report.json'), JSON.stringify(proof, null, 2));
    assert.equal(persistentCookieSurvived, true, 'Expiring synthetic sign-in cookie must survive a fresh Electron process');
    assert.equal(sessionCookieSurvived, phase === 'read', phase === 'read' ? 'Session synthetic sign-in cookie must survive a fresh Electron process' : 'Logged-out session cookie must not be revived');
    assert.equal(proof.httpOnlyHiddenFromPage, true);
    if (phase === 'read') {
      await browser.request('browser.open', {chatId: 'another-fixture', url: base + '/other'});
      const other = views.find(view => view.webContents.getURL() === base + '/other').webContents;
      assert.deepEqual(await other.session.cookies.get({url: base}), [], 'Other chat has a separate cookie jar');
      await page.session.cookies.remove(base, 'session_fixture');
    }
  }
  await browser.close(); browser = undefined;
  const metadata = await fs.readFile(path.join(dataDir, 'browser/state.json'), 'utf8');
  assert.ok(!metadata.includes('synthetic-session-only') && !metadata.includes('synthetic-persistent-only'), 'Tab metadata must not store authentication cookie values');
  await fs.writeFile(path.join(root, phase + '-report.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof)); app.quit();
} catch (error) {
  await browser?.close().catch(() => {});
  console.error(JSON.stringify({phase, ok: false, error: error.message})); app.exit(1);
}
}).catch(error => { console.error(error); app.exit(1); });
