import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRemoteHost, createRemoteController, generateRemoteIdentity, parseRemoteInvitation, validateRemoteRoute } from '../desktop/remote-transport.mjs';
import { createRemoteWorkspace } from '../core/remote-workspace.mjs';

const windows = { skip: process.platform !== 'win32' };
const route = { relayUrl: 'wss://fixture.trycloudflare.com', routeId: 'a'.repeat(43), hostName: 'Host fixture' };
let generated;
const certificate = () => generated ||= generateRemoteIdentity();
function vault() { const values = new Map(); return { values, getSecret: async key => values.get(key) || '', setSecret: async (key, value) => { values.set(key, value); } }; }
async function until(check) { for (let n = 0; n < 200; n++) { const result = check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Remote fixture timed out.'); }
async function fixture(t, options = {}) {
  const hostStore = options.hostStore || vault(), controllerStore = vault(), events = [], calls = [];
  let clock = Date.now(), port;
  const remoteHost = await createRemoteHost({ host: hostStore, createIdentity: options.createIdentity || certificate, now: () => clock, onChange: state => events.push(state), dispatch: options.dispatch || (async (method, params, context) => { calls.push({ method, params, device: context.device }); return { method, params }; }) });
  ({ port } = await remoteHost.start());
  const dial = async (_route, { signal } = {}) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const abort = () => socket.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal?.removeEventListener('abort', abort));
    await once(socket, 'connect', { signal }); return socket;
  };
  const remoteController = await createRemoteController({ host: controllerStore, dial, now: () => clock, onChange: state => events.push(state) });
  t.after(async () => { await remoteController.dispose(); await remoteHost.dispose(); });
  const invite = () => remoteHost.createInvitation(route);
  const begin = async (controller = remoteController, deviceName = 'Controller fixture') => controller.pair({ ...(await invite()), deviceName });
  const pair = async (controller = remoteController, deviceName) => { const pending = await begin(controller, deviceName); await remoteHost.acceptPairing(pending.id); return (await controller.completePairing()).connection; };
  const raw = (path, body = {}, headers = {}, extra = {}) => new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = https.request({ host: '127.0.0.1', port, rejectUnauthorized: false, method: 'POST', path, agent: false, headers: { Host: 'faber.remote', 'X-Faber-Remote': '1', 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers }, ...extra }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject); request.end(payload);
  });
  return { remoteHost, remoteController, hostStore, controllerStore, events, calls, dial, raw, begin, pair, invite, get port() { return port; }, setClock(value) { clock = value; }, async restart() { await remoteHost.stop(); ({ port } = await remoteHost.start()); } };
}
function credentials(f) { return JSON.parse(f.controllerStore.values.get('remote-controller-v1')).connections[0]; }
const auth = connection => ({ Authorization: 'Bearer ' + connection.token, 'X-Faber-Device': connection.deviceId });

test('remote pairing requires local acceptance, persists only token hashes on host, and exposes no secrets', windows, async t => {
  const f = await fixture(t), invitation = await f.invite();
  const parsed = parseRemoteInvitation(invitation.invitation); assert.equal(parsed.hostName, route.hostName); assert.match(parsed.fingerprint, /^[a-f0-9]{64}$/);
  const pending = await f.remoteController.pair({ ...invitation, deviceName: 'Coffee shop PC' });
  assert.equal((await f.remoteController.completePairing()).state, 'pending'); assert.equal(f.calls.length, 0);
  assert.equal(f.remoteHost.status().pending[0].name, 'Coffee shop PC');
  assert.equal((await f.raw('/request', { method: 'state.get', params: {} })).status, 401);
  await f.remoteHost.acceptPairing(pending.id);
  const result = await f.remoteController.completePairing(), connection = result.connection;
  assert.equal(result.state, 'accepted'); assert.equal(connection.name, 'Coffee shop PC');
  assert.deepEqual(await f.remoteController.request(connection.id, 'state.get', { view: 'remote' }), { method: 'state.get', params: { view: 'remote' } });
  const secret = credentials(f), hostValue = JSON.parse(f.hostStore.values.get('remote-host-v1'));
  assert.equal(hostValue.devices[0].tokenHash, createHash('sha256').update(secret.token).digest('hex'));
  assert.equal(JSON.stringify(hostValue).includes(secret.token), false);
  assert.equal(JSON.stringify([f.events, f.remoteHost.status(), f.remoteController.status(), result]).includes(secret.token), false);
  assert.equal(JSON.stringify(f.events).includes(parsed.nonce), false);
  assert.equal(f.remoteHost.status().devices[0].online, true); assert.ok(f.remoteHost.status().devices[0].lastSeenAt);
  assert.equal(f.calls[0].device.id, pending.id);
  const reopened = await createRemoteController({ host: f.controllerStore, dial: f.dial });
  t.after(() => reopened.dispose());
  assert.deepEqual(await reopened.request(connection.id, 'state.get', {}), { method: 'state.get', params: {} });
  await f.restart();
  assert.deepEqual(await reopened.request(connection.id, 'state.get', {}), { method: 'state.get', params: {} });
});

test('invitations are single use, short lived, and rejected devices never reach application dispatch', windows, async t => {
  const f = await fixture(t), invitation = await f.invite(), other = await createRemoteController({ host: vault(), dial: f.dial }); t.after(() => other.dispose());
  const pending = await f.remoteController.pair({ ...invitation, deviceName: 'First PC' });
  await assert.rejects(other.pair({ ...invitation, deviceName: 'Replay PC' }), /unavailable/);
  f.remoteHost.rejectPairing(pending.id);
  await assert.rejects(f.remoteController.completePairing(), /not authorized/);
  f.remoteController.cancelPairing();
  const expired = await f.invite(); f.setClock(expired.expiresAt + 1);
  await assert.rejects(f.remoteController.pair({ ...expired, deviceName: 'Expired PC' }), /expired/);
  const later = await f.begin(); f.setClock(later.expiresAt + 1); await assert.rejects(f.remoteHost.acceptPairing(later.id), /expired/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.remoteHost.status().devices, []);
});

test('host validates authority, origins, credentials, routes, JSON bounds and application envelopes', windows, async t => {
  const f = await fixture(t); await f.pair(); const headers = auth(credentials(f)), request = { method: 'state.get', params: {} };
  for (const extra of [{ Host: 'attacker.example' }, { Origin: 'https://attacker.example' }, { Origin: 'null' }, { 'X-Forwarded-Host': 'faber.remote' }, { 'Proxy-Authorization': 'ignored' }, { 'X-Faber-Remote': '0' }]) assert.equal((await f.raw('/request', request, { ...headers, ...extra })).status, 403);
  assert.equal((await f.raw('/request?secret=bad', request, headers)).status, 404);
  assert.equal((await f.raw('/request', request, { ...headers, Authorization: 'Bearer ' + 'x'.repeat(43) })).status, 401);
  assert.equal((await f.raw('/request', request, { ...headers, 'Content-Length': 12 * 1024 * 1024 + 1 })).status, 413);
  assert.equal((await f.raw('/pair', {}, { 'Content-Length': 4097 })).status, 413);
  assert.equal((await f.raw('/request', { method: '__proto__', params: {} }, headers)).status, 400);
  assert.equal((await f.raw('/request', { method: 'state.get', params: [] }, headers)).status, 400);
  assert.equal((await f.raw('/request', request, { ...headers, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(f.calls.length, 0);
});

test('certificate mismatch sends zero HTTP bytes or pairing credentials to the unverified peer', windows, async t => {
  const f = await fixture(t), connection = await f.pair(), cert = await generateRemoteIdentity(); let received = 0;
  const connections = new Set(), spy = tls.createServer({ pfx: Buffer.from(cert.pfx, 'base64'), minVersion: 'TLSv1.2' }, socket => { connections.add(socket); socket.on('data', chunk => received += chunk.length); socket.on('error', () => {}); socket.on('close', () => connections.delete(socket)); });
  await new Promise(resolve => spy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => spy.close(resolve)); });
  const controller = await createRemoteController({ host: vault(), dial: async () => net.connect({ host: '127.0.0.1', port: spy.address().port }) }); t.after(() => controller.dispose());
  const invite = parseRemoteInvitation((await f.invite()).invitation); invite.fingerprint = '0'.repeat(64);
  const invitation = 'FABER-PAIR-1.' + Buffer.from(JSON.stringify(invite)).toString('base64url');
  await assert.rejects(controller.pair({ invitation, deviceName: 'Secret PC' }), /certificate/);
  const saved = await createRemoteController({ host: f.controllerStore, dial: async () => net.connect({ host: '127.0.0.1', port: spy.address().port }) }); t.after(() => saved.dispose());
  await assert.rejects(saved.request(connection.id, 'state.get', {}), /certificate/);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(received, 0);
});

test('revocation aborts only that device; stop and profile close abort every live operation', windows, async t => {
  const signals = [], f = await fixture(t, { dispatch: async (_method, _params, { device, signal }) => { signals.push({ device, signal }); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ canceled: true }), { once: true })); } });
  const first = await f.pair(), secondStore = vault(), second = await createRemoteController({ host: secondStore, dial: f.dial }); t.after(() => second.dispose()); const secondConnection = await f.pair(second, 'Second PC');
  const a = f.remoteController.request(first.id, 'state.get', {}).catch(error => error), b = second.request(secondConnection.id, 'state.get', {}).catch(error => error);
  await until(() => signals.length === 2); await f.remoteHost.revokeDevice(first.deviceId);
  assert.equal(signals[0].signal.aborted, true); assert.equal(signals[1].signal.aborted, false); assert.ok(await a instanceof Error);
  await assert.rejects(f.remoteController.request(first.id, 'state.get', {}), /not authorized/);
  await f.remoteHost.stop(); assert.equal(signals[1].signal.aborted, true); assert.ok(await b instanceof Error);
  await f.restart();
  const c = second.request(secondConnection.id, 'state.get', {}).catch(error => error); await until(() => signals.length === 3);
  await f.remoteHost.dispose(); assert.equal(signals[2].signal.aborted, true); assert.ok(await c instanceof Error);
  assert.equal(f.remoteHost.status().running, false);
});

test('remote image fetches use paired TLS authority and revocation cancels an in-flight image',windows,async t=>{
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
  const state = {projects:[{id:'p',name:'Project',path:'private host path'}],providers:[],runs:[],approvals:[],
    chats:[{id:'c',projectId:'p',messages:[{id:'m',role:'assistant',content:'Created this image',images:[image]}]}]};
  const workspace = createRemoteWorkspace({current:()=>({state,stateRevision:1,streams:new Map()}),request:async()=>{throw new Error('No mutations in image reads');}});
  t.after(()=>workspace.close());
  let dispatches = 0, delayImage = false, imageSignal;
  const f = await fixture(t,{dispatch:async(method,envelope,authority)=>{
    dispatches++; assert.equal(method,'workspace.rpc');
    if (delayImage && envelope.method === 'chat.image') {
      imageSignal = authority.signal;
      await new Promise(resolve=>authority.signal.addEventListener('abort',resolve,{once:true}));
    }
    return workspace.dispatch(envelope.method,envelope.params,authority);
  }}), connection = await f.pair();
  const rpc = (method,params)=>f.remoteController.request(connection.id,'workspace.rpc',{method,params});
  const page = await rpc('chat.read',{chatId:'c',imageMode:'references'}), imageId = page.chat.messages[0].imageRefs[0].id;
  assert.equal(JSON.stringify(page).includes(image),false); assert.equal(JSON.stringify(page).includes('private host path'),false);
  const envelope = {method:'workspace.rpc',params:{method:'chat.image',params:{chatId:'c',imageId}}};
  const before = dispatches; assert.equal((await f.raw('/request',envelope)).status,401); assert.equal(dispatches,before);
  assert.deepEqual(await rpc('chat.image',{chatId:'c',imageId}),{imageId,image});
  delayImage = true;
  const pending = rpc('chat.image',{chatId:'c',imageId}).catch(error=>error);
  await until(()=>imageSignal); await f.remoteHost.revokeDevice(connection.deviceId);
  assert.equal(imageSignal.aborted,true); assert.ok(await pending instanceof Error);
  const revoked = dispatches; await assert.rejects(rpc('chat.image',{chatId:'c',imageId}),/not authorized/); assert.equal(dispatches,revoked);
});

test('controller supports two independent saved hosts and never exposes either bearer', windows, async t => {
  const a = await fixture(t), b = await fixture(t, { createIdentity: generateRemoteIdentity }), store = vault();
  const routes = new Map([[route.routeId, a.dial], ['b'.repeat(43), b.dial]]);
  const controller = await createRemoteController({ host: store, dial: (value, options) => routes.get(value.routeId)(value, options) }); t.after(() => controller.dispose());
  const pa = await controller.pair({ ...(await a.invite()), deviceName: 'Shared controller' }); await a.remoteHost.acceptPairing(pa.id); const ca = (await controller.completePairing()).connection;
  const pb = await controller.pair({ ...(await b.remoteHost.createInvitation({ ...route, routeId: 'b'.repeat(43), hostName: 'Second host' })), deviceName: 'Shared controller' }); await b.remoteHost.acceptPairing(pb.id); const cb = (await controller.completePairing()).connection;
  assert.notEqual(ca.id, cb.id); assert.notEqual(ca.fingerprint, cb.fingerprint); assert.equal(controller.status().connections.length, 2);
  assert.deepEqual(await controller.request(ca.id, 'state.get', { host: 'a' }), { method: 'state.get', params: { host: 'a' } });
  assert.deepEqual(await controller.request(cb.id, 'state.get', { host: 'b' }), { method: 'state.get', params: { host: 'b' } });
  await controller.forget(ca.id); assert.equal(controller.status().connections.length, 1); await assert.rejects(controller.request(ca.id, 'state.get', {}), /unavailable/);
});

test('encrypted-store failures and corrupted identities fail closed without overwrite', windows, async t => {
  const store = vault(); store.values.set('remote-host-v1', '{"version":1,"identity":{"pfx":"broken","certificate":"broken"},"devices":[]}');
  const original = store.values.get('remote-host-v1');
  await assert.rejects(createRemoteHost({ host: store, dispatch: async () => {} }), /preserved/); assert.equal(store.values.get('remote-host-v1'), original);
  const failed = { getSecret: async () => '', setSecret: async () => { throw new Error('unavailable'); } };
  const host = await createRemoteHost({ host: failed, dispatch: async () => {}, createIdentity: certificate }); t.after(() => host.dispose());
  await assert.rejects(host.start(), /Cannot save/); assert.equal(host.status().running, false);
  await assert.rejects(createRemoteController({ host: { ...store, getSecret: async () => '{broken' }, dial: async () => {} }), /preserved/);
});

test('pairing acceptance canceled during encrypted persistence never survives host stop', windows, async t => {
  const store = vault(), f = await fixture(t, { hostStore: store }), pending = await f.begin();
  const originalSet = store.setSecret; let release, entered = false;
  store.setSecret = async (key, value) => { if (!entered && JSON.parse(value).devices.length) { entered = true; await new Promise(resolve => release = resolve); } return originalSet(key, value); };
  const acceptance = f.remoteHost.acceptPairing(pending.id).catch(error => error);
  await until(() => entered); const stopping = f.remoteHost.stop(); release(); assert.ok(await acceptance instanceof Error); await stopping;
  assert.deepEqual(JSON.parse(store.values.get('remote-host-v1')).devices, []); assert.deepEqual(f.remoteHost.status().devices, []);
});

test('per-device concurrency is bounded and cancellation frees dispatch capacity', windows, async t => {
  const signals = [], f = await fixture(t, { dispatch: async (_method, _params, { signal }) => { signals.push(signal); return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } });
  const connection = await f.pair(), calls = Array.from({ length: 4 }, () => f.remoteController.request(connection.id, 'state.get', {}).catch(error => error));
  await until(() => signals.length === 4);
  await assert.rejects(f.remoteController.request(connection.id, 'state.get', {}), /concurrency/);
  const denied = await f.raw('/request', { method: 'state.get', params: {} }, auth(credentials(f))); assert.equal(denied.status, 429);
  f.remoteController.disconnect(connection.id); for (const call of calls) assert.ok(await call instanceof Error);
  await until(() => signals.every(signal => signal.aborted)); assert.equal(f.remoteController.status().activeRequests, 0);
});

test('relay descriptor validation rejects local origins, extra URL fields and unapproved hosts', () => {
  for (const relayUrl of ['http://example.com', 'wss://127.0.0.1', 'wss://localhost', 'wss://host.local', 'wss://host.internal', 'wss://user:pass@example.com', 'wss://example.com:444', 'wss://example.com/path', 'wss://example.com/?secret=x', 'wss://example.com/#fragment']) assert.throws(() => validateRemoteRoute({ ...route, relayUrl }), /relay/);
  assert.deepEqual(validateRemoteRoute(route), { relayUrl: route.relayUrl, routeId: route.routeId });
  assert.deepEqual(validateRemoteRoute({ ...route, relayUrl: 'ws://127.0.0.1:8080' }, { allowLocalRelay: true }), { relayUrl: 'ws://127.0.0.1:8080', routeId: route.routeId });
});


test('pairing requests are rate limited and trust rejects unapproved relay origins before dial', windows, async t => {
  const f = await fixture(t);
  for (let count = 0; count < 10; count++) assert.equal((await f.raw('/pair', { nonce: 'x'.repeat(43), token: 'y'.repeat(43), name: 'Guessing PC' })).status, 403);
  assert.equal((await f.raw('/pair', {})).status, 429);
  let dials = 0;
  const controller = await createRemoteController({ host: vault(), dial: async () => { dials++; throw new Error('Must not dial'); } }); t.after(() => controller.dispose());
  const value = { ...parseRemoteInvitation((await f.invite()).invitation), relayUrl: 'wss://unapproved.example' };
  await assert.rejects(controller.pair({ invitation: 'FABER-PAIR-1.' + Buffer.from(JSON.stringify(value)).toString('base64url'), deviceName: 'Fixture' }), /not trusted/);
  assert.equal(dials, 0);
});

test('forget invalidates a saved controller immediately while encrypted persistence is pending', windows, async t => {
  const f = await fixture(t), connection = await f.pair(), originalSet = f.controllerStore.setSecret; let release, entered = false;
  f.controllerStore.setSecret = async (key, value) => { entered = true; await new Promise(resolve => release = resolve); return originalSet(key, value); };
  const forgetting = f.remoteController.forget(connection.id); await until(() => entered);
  await assert.rejects(f.remoteController.request(connection.id, 'state.get', {}), /unavailable/); assert.deepEqual(f.remoteController.status().connections, []);
  release(); await forgetting;
});


test('installed workbench extraction retains the certificate source and generates keys only in memory', windows, async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path'), { pathToFileURL } = await import('node:url');
  const { prepareWorkbench } = await import('../desktop/packaged-paths.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber remote package '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle'); await fs.mkdir(path.join(bundle, 'desktop'), { recursive: true });
  for (const file of ['remote-transport.mjs', 'remote-certificate.ps1']) await fs.copyFile(new URL('../desktop/' + file, import.meta.url), path.join(bundle, 'desktop', file));
  const workbench = await prepareWorkbench({ bundledSource: bundle, workbenchRoot: path.join(root, 'workbench'), version: '2.2.0' });
  const extracted = await import(pathToFileURL(path.join(workbench, 'desktop', 'remote-transport.mjs')).href), generated = await extracted.generateRemoteIdentity();
  assert.ok(Buffer.from(generated.pfx, 'base64').length > 1000);
  assert.deepEqual((await fs.readdir(path.join(workbench, 'desktop'))).sort(), ['remote-certificate.ps1', 'remote-transport.mjs']);
});


test('controller cancellation during accepted-pair persistence rolls back the saved bearer', windows, async t => {
  const f = await fixture(t), pending = await f.begin(); await f.remoteHost.acceptPairing(pending.id);
  const originalSet = f.controllerStore.setSecret; let release, entered = false;
  f.controllerStore.setSecret = async (key, value) => { if (!entered) { entered = true; await new Promise(resolve => release = resolve); } return originalSet(key, value); };
  const completion = f.remoteController.completePairing().catch(error => error); await until(() => entered);
  f.remoteController.cancelPairing(); release(); assert.ok(await completion instanceof Error);
  assert.deepEqual(JSON.parse(f.controllerStore.values.get('remote-controller-v1')).connections, []); assert.deepEqual(f.remoteController.status().connections, []);
});
