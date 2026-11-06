import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntime } from '../core/runtime.mjs';
import { mediaTools } from '../tools/media.mjs';
import { createChatMedia } from '../desktop/chat-media.mjs';
import { createRemoteHost, createRemoteController } from '../desktop/remote-transport.mjs';
import { createRelayHostAdapter, connectRelayController, generateRouteSecret, deriveRouteId } from '../desktop/remote-relay.mjs';
import { createRelayServer, RELAY_LIMITS } from '../relay/server.mjs';
import { waveFixture } from './fixtures/media.mjs';

const vault = () => { const values = new Map(); return { getSecret: async key => values.get(key) || '', setSecret: async (key, value) => { values.set(key, value); } }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await pause(25); } throw new Error('Relay media resource cleanup timed out'); }
async function hash(file) { const digest = createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes); return digest.digest('hex'); }

// Explicit long acceptance: node --test test/desktop-media-relay.fixture.mjs
test('media larger than the relay session cap saves exactly through fresh bounded paired TLS requests', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-media-relay-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const source = path.join(workspace, 'large-tone.wav'), destination = path.join(workspace, 'saved-tone.wav');
  const bytes = RELAY_LIMITS.sessionBytes + 1024 * 1024 + 44, header = waveFixture().subarray(0, 44);
  header.writeUInt32LE(bytes - 8, 4); header.writeUInt32LE(bytes - 44, 40);
  const file = await fs.open(source, 'wx'); await file.write(header); await file.truncate(bytes); await file.close();
  let runtime, receiver, controller, adapter, relay, media, dialCount = 0, chunks = 0;
  const started = Date.now();
  t.after(async () => { media?.close(); await controller?.dispose(); await adapter?.close(); await receiver?.dispose(); await relay?.close(); await runtime?.close(); });
  runtime = await createRuntime({ dataDir: path.join(root, 'profile'), sourceDir: path.resolve('.'), provider: async function* () { throw new Error('Provider calls are prohibited in this fixture'); } });
  runtime.registerTools(mediaTools());
  const project = await runtime.request('project.create', { name: 'Large media fixture', path: workspace });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  const result = await runtime.request('tool.run', { chatId: chat.id, name: 'media_show', args: { path: 'large-tone.wav' } });
  assert.equal(result.media.bytes, bytes);
  receiver = await createRemoteHost({ host: vault(), allowLocalRelay: true, dispatch: (method, params, authority) => {
    if (method === 'chat.media') { assert.ok(params.length <= 262144); chunks++; }
    return runtime.remoteRequest(method, params, authority);
  } });
  const { port } = await receiver.start(), secret = generateRouteSecret(), routeId = deriveRouteId(secret);
  relay = createRelayServer({ allowedRouteIds: [routeId] }); const relayAddress = await relay.start();
  const route = { relayUrl: `ws://127.0.0.1:${relayAddress.port}`, routeId };
  adapter = await createRelayHostAdapter({ ...route, registrationSecret: secret, targetPort: port, allowLocalRelay: true });
  controller = await createRemoteController({ host: vault(), allowLocalRelay: true, dial: (route, { signal } = {}) => { dialCount++; return connectRelayController(route, { signal, allowLocalRelay: true }); } });
  const invitation = await receiver.createInvitation({ ...route, hostName: 'Large media host' });
  const pending = await controller.pair({ ...invitation, deviceName: 'Large media controller' }); await receiver.acceptPairing(pending.id);
  const { connection } = await controller.completePairing();
  media = createChatMedia({ readMedia: runtime.readMedia, chooseSave: async () => destination, remoteRequest: (deviceId, method, params, signal) => controller.request(deviceId, method, params, { signal }) });
  assert.deepEqual(await media.request('media.save', { chatId: chat.id, mediaId: result.media.id, deviceId: connection.id }), { saved: true });
  assert.equal((await fs.stat(destination)).size, bytes); assert.equal(await hash(destination), await hash(source));
  assert.equal(chunks, Math.ceil(bytes / 262144) + 1); assert.equal(dialCount, chunks + 2, 'pair/status plus one fresh TLS relay session per media request');
  await until(() => relay.status().sessions === 0 && receiver.status().activeRequests === 0);
  assert.equal(relay.status().sockets, 1, 'only host registration remains');
  await adapter.close(); await until(() => relay.status().sockets === 0 && relay.status().rooms === 0);
  const report = { ok: true, synthetic: true, bytes, sha256: await hash(destination), chunks, dialCount, elapsedMs: Date.now() - started, relayLimits: RELAY_LIMITS, finalRelay: relay.status(), limits: ['Local WebSocket relay with real pinned TLS; physical two-PC/WAN testing remains pending.'] };
  await runtime.request('chat.delete', { chatId: chat.id });
  await fs.rm(source); await fs.rm(destination);
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(root, 'report.json'), ...report }));
});
