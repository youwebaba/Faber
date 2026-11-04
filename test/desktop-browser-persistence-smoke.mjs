import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {runProcess} from '../tools/process.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-browser-persistence-'));
const electron = createRequire(import.meta.url)('electron'), fixture = fileURLToPath(new URL('./fixtures/browser-persistence-main.mjs', import.meta.url));
const requests = []; let phase = 'write';
const server = http.createServer((request, response) => {
  const cookies = request.headers.cookie || '';
  requests.push({phase, path: request.url, session: cookies.includes('session_fixture=synthetic-session-only'), persistent: cookies.includes('persistent_fixture=synthetic-persistent-only')});
  if (request.url === '/download') {response.setHeader('Content-Disposition', 'attachment; filename="fixture-download.txt"'); response.end('Controlled download fixture bytes'); return;}
  if (phase === 'write' && request.url === '/signin') response.setHeader('Set-Cookie', ['session_fixture=synthetic-session-only; HttpOnly; SameSite=Lax; Path=/', 'persistent_fixture=synthetic-persistent-only; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/']);
  response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Persistence fixture</title><h1>Controlled synthetic sign-in fixture</h1><input id="file" type="file"><input id="canceled-file" type="file">');
});
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port, runs = [];
try {
  for (phase of ['write', 'read', 'logout']) {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const result = await runProcess(electron, [fixture, phase, root, base], {env, timeout: 45000});
    runs.push({phase, code: result.code, stdout: result.stdout, stderr: result.stderr});
    await fs.writeFile(path.join(root, 'process-runs.json'), JSON.stringify(runs, null, 2));
    assert.equal(result.code, 0, phase + ' Electron process failed: ' + result.stderr);
  }
  const read = requests.find(item => item.phase === 'read' && item.path === '/signin'), logout = requests.find(item => item.phase === 'logout' && item.path === '/signin');
  assert.ok(read?.session && read.persistent, 'Restored cookies reach the real controlled HTTP server');
  assert.ok(logout && !logout.session && logout.persistent, 'Logout persists without reviving a session cookie');
  assert.ok(requests.filter(item => item.phase !== 'write').every(item => item.path !== '/closed'), 'Closed tab never navigates after restoration');
  assert.ok(requests.filter(item => item.path === '/other').every(item => !item.session && !item.persistent));
  const report = {ok: true, root, freshElectronProcesses: 3, syntheticHttpOnlyCookies: true, sessionCookieAcrossRestart: true, expiringCookieAcrossRestart: true, logoutNotRevived: true, lazyTabMetadata: true, closedTabStayedClosed: true, crossChatCookiesIsolated: true, noRealAccount: true, requests};
  await fs.writeFile(path.join(root, 'persistence-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await fs.writeFile(path.join(root, 'persistence-failure.json'), JSON.stringify({ok: false, root, phase, error: error.message, runs, requests}, null, 2));
  console.error(JSON.stringify({ok: false, root, phase, error: error.message})); process.exitCode = 1;
} finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
