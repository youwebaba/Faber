import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRelayServer, RELAY_LIMITS } from '../server.mjs';
import { createRelayHostAdapter, connectRelayController, generateRouteSecret, deriveRouteId, validateRelayUrl, validateRelayConfig } from '../../desktop/remote-relay.mjs';
import { createRemoteHost, createRemoteController, generateRemoteIdentity, parseRemoteInvitation } from '../../desktop/remote-transport.mjs';

const local = { allowLocalRelay: true };
function vault() { const values = new Map(); return { values, getSecret: async key => values.get(key) || '', setSecret: async (key, value) => { values.set(key, value); } }; }
async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Relay fixture timed out');
}
async function relayFixture(t, options = {}) {
  const secret = generateRouteSecret(), routeId = deriveRouteId(secret);
  const relay = createRelayServer({ allowedRouteIds: [routeId], ...options });
  const { port } = await relay.start(), relayUrl = `ws://127.0.0.1:${port}`;
  t.after(() => relay.close());
  return { secret, routeId, relayUrl, relay, route: { relayUrl, routeId } };
}
async function raw(url) {
  const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('WebSocket rejected')), { once: true }); });
  return ws;
}
function control(ws, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(failed, 3000); timeout.unref();
    function cleanup() { clearTimeout(timeout); ws.removeEventListener('message', message); ws.removeEventListener('close', failed); }
    function failed() { cleanup(); reject(new Error('Control closed')); }
    function message(event) { if (typeof event.data !== 'string') return; const value = JSON.parse(event.data); if (value.type === type) { cleanup(); resolve(value); } }
    ws.addEventListener('message', message); ws.addEventListener('close', failed, { once: true });
  });
}
const closed = ws => ws.readyState >= 2 ? Promise.resolve() : new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));

test('relay URLs and route provisioning fail closed at their trust boundaries', () => {
  const secret = generateRouteSecret(), routeId = deriveRouteId(secret);
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/); assert.match(routeId, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(secret, routeId);
  assert.equal(deriveRouteId(secret), routeId);
  assert.equal(validateRelayUrl('wss://fixture.trycloudflare.com/'), 'wss://fixture.trycloudflare.com');
  assert.equal(validateRelayUrl('wss://fixture.trycloudflare.com:443/'), 'wss://fixture.trycloudflare.com');
  for (const relayUrl of ['ws://fixture.trycloudflare.com', 'wss://user:secret@fixture.trycloudflare.com', 'wss://fixture.trycloudflare.com:444', 'wss://fixture.trycloudflare.com/path', 'wss://fixture.trycloudflare.com/x/..', 'wss://fixture.trycloudflare.com/?secret=bad', 'wss://fixture.trycloudflare.com/#bad', 'wss://fixture.trycloudflare.com.attacker.com', 'wss://attacker.com', 'wss://localhost', 'wss://127.0.0.1', 'wss://[::1]', 'wss://home.internal']) assert.throws(() => validateRelayConfig({ relayUrl, routeId }));
  assert.throws(() => validateRelayConfig({ relayUrl: 'wss://fixture.trycloudflare.com', routeId: '../route' }));
  assert.equal(validateRelayUrl('ws://127.0.0.1:9999', local), 'ws://127.0.0.1:9999');
  assert.throws(() => validateRelayUrl('ws://192.168.1.2:9999', local));
  assert.equal(validateRelayUrl('wss://relay.trusted.org', { approvedRelayHosts: ['relay.trusted.org'] }), 'wss://relay.trusted.org');
  assert.throws(() => validateRelayUrl('wss://machine.local', { approvedRelayHosts: ['machine.local'] }));
  assert.throws(() => createRelayServer(), /Allow/);
  assert.throws(() => createRelayServer({ allowedRouteIds: [routeId], host: '0.0.0.0' }), /loopback/);
});

test('real native WebSockets deny unprovisioned routes, public-route takeover and duplicate hosts', async t => {
  const f = await relayFixture(t), target = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => target.close(resolve)));
  const adapter = await createRelayHostAdapter({ ...f.route, registrationSecret: f.secret, targetPort: target.address().port, ...local }); t.after(() => adapter.close());
  assert.equal(adapter.status().connected, true);
  await assert.rejects(raw(`${f.relayUrl}/v1/host/${deriveRouteId(generateRouteSecret())}`));
  const impostor = await raw(`${f.relayUrl}/v1/host/${f.routeId}`), denied = closed(impostor);
  impostor.send(JSON.stringify({ type: 'register', secret: generateRouteSecret() })); await denied;
  const duplicate = await raw(`${f.relayUrl}/v1/host/${f.routeId}`), rejected = closed(duplicate);
  duplicate.send(JSON.stringify({ type: 'register', secret: f.secret })); await rejected;
  assert.equal(f.relay.status().rooms, 1); assert.equal(adapter.status().connected, true);
  const streams = await Promise.all(Array.from({ length: 4 }, () => connectRelayController(f.route, local)));
  t.after(() => { for (const stream of streams) stream.destroy(); });
  const replies = streams.map((stream, index) => new Promise((resolve, reject) => { stream.once('data', data => resolve(data.toString())); stream.once('error', reject); stream.write(`session-${index}`); }));
  assert.deepEqual(await Promise.all(replies), ['session-0', 'session-1', 'session-2', 'session-3']);
  await assert.rejects(connectRelayController(f.route, local));
  assert.equal(f.relay.status().sessions, 4);
  await adapter.close(); await until(() => f.relay.status().rooms === 0 && f.relay.status().sessions === 0);
});

test('public relay TLS dial pins validated DNS answers and retains hostname verification across rebinding', async t => {
  let resolutions = 0, dial, overrideUsed = false;
  t.mock.method(dns, 'lookup', async () => ++resolutions === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  t.mock.method(tls, 'connect', options => { dial = options; throw new Error('Fixture stopped the public dial'); });
  class UnpinnedOverride { constructor() { overrideUsed = true; } }
  const route = { relayUrl: 'wss://relay.trusted.org', routeId: deriveRouteId(generateRouteSecret()) };
  await assert.rejects(connectRelayController(route, { approvedRelayHosts: ['relay.trusted.org'], WebSocketImpl: UnpinnedOverride }));
  assert.ok(dial); assert.equal(dial.servername, 'relay.trusted.org'); assert.equal(dial.rejectUnauthorized, true); assert.equal(dial.agent, false);
  const addresses = await new Promise((resolve, reject) => dial.lookup('relay.trusted.org', { all: true }, (error, values) => error ? reject(error) : resolve(values)));
  assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  const one = await new Promise((resolve, reject) => dial.lookup('relay.trusted.org', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(one, addresses[0]); assert.equal(resolutions, 1); assert.equal(overrideUsed, false);
  await assert.rejects(new Promise((resolve, reject) => dial.lookup('other.trusted.org', {}, error => error ? reject(error) : resolve())));
});

test('private DNS answers are rejected before any public relay TLS connection is attempted', async t => {
  let dials = 0;
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  t.mock.method(tls, 'connect', () => { dials++; throw new Error('Unexpected dial'); });
  await assert.rejects(connectRelayController({ relayUrl: 'wss://relay.trusted.org', routeId: deriveRouteId(generateRouteSecret()) }, { approvedRelayHosts: ['relay.trusted.org'] }), /nonpublic/);
  assert.equal(dials, 0);
});

test('four admitted 300ms pollers sustain session churn beyond the old quota despite exhausted unknown-route admission', async t => {
  let clock = Date.now();
  const f = await relayFixture(t, { now: () => clock }), sockets = new Set();
  const target = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => target.close(resolve)); });
  const adapter = await createRelayHostAdapter({ ...f.route, registrationSecret: f.secret, targetPort: target.address().port, ...local }); t.after(() => adapter.close());
  const unknown = deriveRouteId(generateRouteSecret());
  for (let n = 0; n <= RELAY_LIMITS.unknownUpgradesPerMinute; n++) await assert.rejects(raw(`${f.relayUrl}/v1/connect/${unknown}`));
  let completed = 0;
  for (let wave = 0; wave < 32; wave++) {
    clock += 300;
    const streams = await Promise.all(Array.from({ length: 4 }, () => connectRelayController(f.route, local)));
    try {
      assert.equal(f.relay.status().sessions, 4);
      await Promise.all(streams.map(async (stream, index) => {
        const response = once(stream, 'data'), payload = `wave-${wave}-controller-${index}`;
        stream.write(payload); assert.equal((await response)[0].toString(), payload); completed++;
      }));
    } finally { for (const stream of streams) stream.destroy(); }
    await until(() => f.relay.status().sessions === 0);
  }
  assert.equal(completed, 128); assert.equal(adapter.status().connected, true); assert.equal(f.relay.status().rooms, 1);
});

test('opaque tunnel credit bounds prevent a stalled peer from accumulating traffic', async t => {
  const f = await relayFixture(t), host = await raw(`${f.relayUrl}/v1/host/${f.routeId}`); t.after(() => host.close());
  const registered = control(host, 'registered'); host.send(JSON.stringify({ type: 'register', secret: f.secret })); await registered;
  const sessionRequest = control(host, 'session'), controller = await raw(`${f.relayUrl}/v1/connect/${f.routeId}`); t.after(() => controller.close());
  const { sessionId } = await sessionRequest, readyController = control(controller, 'ready');
  const peer = await raw(`${f.relayUrl}/v1/session/${f.routeId}/${sessionId}`); t.after(() => peer.close());
  let received = 0; peer.addEventListener('message', event => { if (event.data instanceof ArrayBuffer) received += event.data.byteLength; });
  const readyPeer = control(peer, 'ready'); peer.send(JSON.stringify({ type: 'attach', secret: f.secret })); await Promise.all([readyPeer, readyController]);
  const end = closed(controller);
  for (let n = 0; n < RELAY_LIMITS.windowBytes / RELAY_LIMITS.frameBytes + 1; n++) controller.send(Buffer.alloc(RELAY_LIMITS.frameBytes));
  await end; assert.ok(received <= RELAY_LIMITS.windowBytes); await until(() => f.relay.status().sessions === 0);
});

test('native duplex handles a paused reader, bounded credits and a multi-frame payload without loss', async t => {
  const f = await relayFixture(t), sockets = new Set();
  const target = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => target.close(resolve)); });
  const adapter = await createRelayHostAdapter({ ...f.route, registrationSecret: f.secret, targetPort: target.address().port, ...local }); t.after(() => adapter.close());
  const stream = await connectRelayController(f.route, local); t.after(() => stream.destroy());
  const payload = Buffer.alloc(3 * 1024 * 1024, 0x5b), chunks = [];
  const written = new Promise((resolve, reject) => stream.write(payload, error => error ? reject(error) : resolve()));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(stream.readableLength <= RELAY_LIMITS.windowBytes + RELAY_LIMITS.frameBytes);
  const received = new Promise((resolve, reject) => {
    let bytes = 0; stream.on('data', chunk => { chunks.push(chunk); bytes += chunk.length; if (bytes === payload.length) resolve(); }); stream.once('error', reject);
  });
  await Promise.all([written, received]); assert.deepEqual(Buffer.concat(chunks), payload);
});

test('host adapter reconnects after relay restart and creates fresh logical sessions', async t => {
  const secret = generateRouteSecret(), routeId = deriveRouteId(secret), first = createRelayServer({ allowedRouteIds: [routeId] });
  const { port } = await first.start(), route = { relayUrl: `ws://127.0.0.1:${port}`, routeId }, sockets = new Set();
  t.after(() => first.close());
  const target = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => target.close(resolve)); });
  const adapter = await createRelayHostAdapter({ ...route, registrationSecret: secret, targetPort: target.address().port, ...local }); t.after(() => adapter.close());
  const prior = await connectRelayController(route, local); t.after(() => prior.destroy());
  prior.resume();
  await first.close(); await until(() => prior.destroyed && !adapter.status().connected);
  const second = createRelayServer({ allowedRouteIds: [routeId], port }); t.after(() => second.close()); await second.start();
  await until(() => adapter.status().connected && second.status().rooms === 1);
  const next = await connectRelayController(route, local); t.after(() => next.destroy());
  const reply = once(next, 'data'); next.write('fresh connection'); assert.equal((await reply)[0].toString(), 'fresh connection');
  assert.notEqual(prior, next); assert.equal(second.status().sessions, 1);
});

test('operator admission file denies missing/corrupt routes and revokes active hosts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'faber-relay-')), file = path.join(directory, 'routes.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = await relayFixture(t, { allowedRouteIds: [], allowedRouteFile: file });
  await assert.rejects(raw(`${f.relayUrl}/v1/host/${f.routeId}`));
  await fs.writeFile(file, JSON.stringify({ routes: [f.routeId] }));
  const host = await raw(`${f.relayUrl}/v1/host/${f.routeId}`), registered = control(host, 'registered');
  t.after(() => host.close()); host.send(JSON.stringify({ type: 'register', secret: f.secret })); await registered;
  const end = closed(host); await fs.writeFile(file, '{broken'); await end;
  assert.equal(f.relay.status().rooms, 0); await assert.rejects(raw(`${f.relayUrl}/v1/host/${f.routeId}`));
  await fs.writeFile(file, JSON.stringify({ routes: [] })); await assert.rejects(raw(`${f.relayUrl}/v1/host/${f.routeId}`));
});

test('outbound WebSocket handshake rejects redirects before any host registration secret is sent', async t => {
  let upgrades = 0, destinationHits = 0;
  const server = http.createServer((_request, response) => { destinationHits++; response.writeHead(200); response.end(); });
  server.on('upgrade', (_request, socket) => { upgrades++; socket.end('HTTP/1.1 302 Found\r\nLocation: /redirected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const registrationSecret = generateRouteSecret();
  await assert.rejects(createRelayHostAdapter({ relayUrl: `ws://127.0.0.1:${server.address().port}`, routeId: deriveRouteId(registrationSecret), registrationSecret, targetPort: 1, ...local }));
  assert.equal(upgrades, 1); assert.equal(destinationHits, 0);
});

test('real relay composes pinned TLS pairing, independent sessions, denial and revocation without plaintext', { skip: process.platform !== 'win32' }, async t => {
  const f = await relayFixture(t), binaryFrames = [], controls = [], hostStore = vault(), controllerStore = vault(), calls = [];
  class ObservedWebSocket extends WebSocket {
    send(data) { if (typeof data === 'string') controls.push(data); else binaryFrames.push(Buffer.from(data)); return super.send(data); }
  }
  const observed = { ...local, WebSocketImpl: ObservedWebSocket };
  const remoteHost = await createRemoteHost({ host: hostStore, createIdentity: generateRemoteIdentity, allowLocalRelay: true, dispatch: async (method, params, { device }) => { calls.push({ method, params, device }); await new Promise(resolve => setTimeout(resolve, 10)); return { method, value: params.value }; } });
  t.after(() => remoteHost.dispose());
  const { port } = await remoteHost.start(), adapter = await createRelayHostAdapter({ ...f.route, registrationSecret: f.secret, targetPort: port, ...observed }); t.after(() => adapter.close());
  const remoteController = await createRemoteController({ host: controllerStore, allowLocalRelay: true, dial: (route, { signal }) => connectRelayController(route, { ...observed, signal }) }); t.after(() => remoteController.dispose());
  const invite = await remoteHost.createInvitation({ ...f.route, hostName: 'Fixture home PC' });
  const nonce = parseRemoteInvitation(invite.invitation, local).nonce;
  const pending = await remoteController.pair({ ...invite, deviceName: 'Fixture laptop' });
  assert.equal((await remoteController.completePairing()).state, 'pending'); assert.equal(calls.length, 0);
  await remoteHost.acceptPairing(pending.id);
  const accepted = await remoteController.completePairing(); assert.equal(accepted.state, 'accepted');
  const phrase = 'opaque-fixture-payload-' + generateRouteSecret();
  const results = await Promise.all(['first', 'second'].map(value => remoteController.request(accepted.connection.id, 'state.get', { value: phrase + value })));
  assert.deepEqual(results, [{ method: 'state.get', value: phrase + 'first' }, { method: 'state.get', value: phrase + 'second' }]);
  assert.equal(calls.length, 2);
  const bearer = JSON.parse(controllerStore.values.get('remote-controller-v1')).connections[0].token;
  const observedBinary = Buffer.concat(binaryFrames), observedControls = controls.join('\n');
  assert.ok(observedBinary.length > 0);
  for (const secret of [nonce, bearer, phrase]) { assert.equal(observedBinary.includes(Buffer.from(secret)), false); assert.equal(observedControls.includes(secret), false); }
  assert.equal(observedBinary.includes(Buffer.from('POST /')), false);
  await remoteHost.revokeDevice(accepted.connection.deviceId);
  await assert.rejects(remoteController.request(accepted.connection.id, 'state.get', { value: 'revoked' }), /authorized/); assert.equal(calls.length, 2);
  await adapter.close(); await until(() => f.relay.status().rooms === 0 && f.relay.status().sessions === 0);
});
