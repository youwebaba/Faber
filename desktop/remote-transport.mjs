import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

const hostVault = 'remote-host-v1', controllerVault = 'remote-controller-v1';
const authority = 'faber.remote', ttl = 5 * 60000, requestLimit = 12 * 1024 * 1024, responseLimit = 32 * 1024 * 1024;
const opaque = /^[A-Za-z0-9_-]{43}$/, hex = /^[a-f0-9]{64}$/, idPattern = /^[a-f0-9-]{36}$/;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const equalHash = (left, right) => hex.test(left || '') && hex.test(right || '') && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
const publicDevice = device => ({ id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt || null });
const publicConnection = connection => ({ id: connection.id, hostName: connection.hostName, name: connection.name, deviceId: connection.deviceId, relayUrl: connection.relayUrl, routeId: connection.routeId, fingerprint: connection.fingerprint, createdAt: connection.createdAt });
const failure = (status, message) => Object.assign(new Error(message), { remoteStatus: status });
function name(value, label = 'Device name') {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(label + ' must contain 1–80 visible characters.');
  return value.trim();
}
function validTime(value) { return Number.isSafeInteger(value) && value > 0; }
function copy(value) { return structuredClone(value); }
function notify(listener, state) { try { listener?.(state); } catch { /* A detached UI cannot interrupt the transport. */ } }
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Remote request canceled.'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readVault(host, key) {
  if (typeof host?.getSecret !== 'function' || typeof host?.setSecret !== 'function') throw new Error('Remote sessions require encrypted host credential storage.');
  let text;
  try { text = await host.getSecret(key); } catch { throw new Error('Remote encrypted storage is unavailable; saved data is preserved.'); }
  if (!text) return null;
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) throw new Error();
    const value = JSON.parse(text);
    if (!record(value) || value.version !== 1) throw new Error();
    return value;
  } catch { throw new Error('Remote encrypted storage is invalid; saved data is preserved.'); }
}
async function writeVault(host, key, value) {
  try { await host.setSecret(key, JSON.stringify(value)); } catch { throw new Error('Cannot save remote encrypted storage; previous data is preserved.'); }
}
export function validateRemoteRoute(value, { allowLocalRelay = false } = {}) {
  if (!record(value) || typeof value.relayUrl !== 'string' || value.relayUrl.length > 512 || !opaque.test(value.routeId || '')) throw new Error('Invalid remote relay route.');
  let url; try { url = new URL(value.relayUrl); } catch { throw new Error('Invalid remote relay address.'); }
  const hostname = url.hostname.toLowerCase();
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (!allowLocalRelay && (url.protocol !== 'wss:' || url.port && url.port !== '443' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname) || /^\d+(?:\.\d+){3}$/.test(hostname))) || (allowLocalRelay && !['wss:', 'ws:'].includes(url.protocol))) throw new Error('Remote relay requires an approved public WSS address.');
  return { relayUrl: url.origin, routeId: value.routeId };
}
function routePolicy(value, options) {
  const route = validateRemoteRoute(value, options);
  if (options.validateRoute) {
    const accepted = options.validateRoute(route);
    if (accepted === false || accepted?.then) throw new Error('Remote relay route was not approved.');
  } else if (!options.allowLocalRelay && !/^[a-z0-9-]+\.trycloudflare\.com$/.test(new URL(route.relayUrl).hostname)) throw new Error('Remote relay address is not trusted by this host.');
  return route;
}
export function parseRemoteInvitation(value, { now = Date.now(), allowLocalRelay = false } = {}) {
  if (typeof value !== 'string' || value.length > 4096 || !/^FABER-PAIR-1\.[A-Za-z0-9_-]+$/.test(value)) throw new Error('Paste a valid Faber pairing invitation.');
  let invite; try { invite = JSON.parse(Buffer.from(value.slice(13), 'base64url').toString('utf8')); } catch { throw new Error('Invalid Faber pairing invitation.'); }
  if (!record(invite) || invite.v !== 1 || !hex.test(invite.fingerprint || '') || !opaque.test(invite.nonce || '') || !validTime(invite.expiresAt) || invite.expiresAt <= now || invite.expiresAt > now + ttl) throw new Error('Pairing invitation is invalid or expired.');
  return { v: 1, ...validateRemoteRoute(invite, { allowLocalRelay }), fingerprint: invite.fingerprint, nonce: invite.nonce, hostName: name(invite.hostName, 'Host name'), expiresAt: invite.expiresAt };
}
function identity(value, now = Date.now()) {
  try {
    if (!record(value) || typeof value.pfx !== 'string' || value.pfx.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.pfx) || typeof value.certificate !== 'string' || value.certificate.length > 16384) throw new Error();
    const cert = new X509Certificate(Buffer.from(value.certificate, 'base64'));
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now || cert.ca) throw new Error();
    tls.createSecureContext({ pfx: Buffer.from(value.pfx, 'base64'), minVersion: 'TLSv1.2' });
    return { ...value, fingerprint: hash(cert.raw) };
  } catch { throw new Error('Remote TLS identity is invalid or expired; encrypted identity is preserved. Explicit recovery is required.'); }
}
export async function generateRemoteIdentity() {
  if (process.platform !== 'win32') throw new Error('Remote TLS identity generation currently requires Windows.');
  const script = await fs.readFile(new URL('./remote-certificate.ps1', import.meta.url), 'utf8');
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const executable = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const output = await new Promise((resolve, reject) => {
    execFile(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript], { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 }, (error, stdout) => error ? reject(new Error('Windows could not generate the remote TLS identity.')) : resolve(stdout));
  });
  let value; try { value = JSON.parse(output.replace(/^\uFEFF/, '')); } catch { throw new Error('Windows returned an invalid remote TLS identity.'); }
  const checked = identity(value);
  return { pfx: checked.pfx, certificate: checked.certificate };
}
function deviceRecord(value) {
  return record(value) && idPattern.test(value.id || '') && typeof value.name === 'string' && name(value.name) === value.name && hex.test(value.tokenHash || '') && validTime(value.createdAt) && (value.lastSeenAt === null || value.lastSeenAt === undefined || validTime(value.lastSeenAt));
}
function send(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body) > responseLimit) { status = 413; body = JSON.stringify({ error: 'Remote response exceeds the transport limit.' }); }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
  response.end(body);
}
async function readJSON(request, limit) {
  if (request.headers['transfer-encoding'] || !/^(?:0|[1-9]\d*)$/.test(request.headers['content-length'] || '') || Number(request.headers['content-length']) > limit) throw failure(413, 'Remote request body is too large or unbounded.');
  if (!/^application\/json(?:; charset=utf-8)?$/i.test(request.headers['content-type'] || '')) throw failure(415, 'Remote requests require JSON.');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw failure(413, 'Remote request body is too large.'); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(400, 'Remote request contains invalid JSON.'); }
  if (!record(value)) throw failure(400, 'Remote request must be an object.');
  return value;
}

export async function createRemoteHost({ host, dispatch, onChange, createIdentity = generateRemoteIdentity, now = Date.now, ...options } = {}) {
  if (typeof dispatch !== 'function') throw new Error('Remote host requires an authorized application dispatcher.');
  let saved = await readVault(host, hostVault) || { version: 1, identity: null, devices: [] };
  try {
    if (!Array.isArray(saved.devices) || saved.devices.length > 32 || saved.devices.some(item => !deviceRecord(item)) || new Set(saved.devices.map(item => item.id)).size !== saved.devices.length || new Set(saved.devices.map(item => item.tokenHash)).size !== saved.devices.length) throw new Error();
    if (saved.identity) identity(saved.identity, now());
    else if (saved.devices.length) throw new Error();
  } catch { throw new Error('Remote host storage or identity is invalid; saved data is preserved. Explicit recovery is required.'); }
  let server = null, closed = false, desired = false, epoch = 0, queue = Promise.resolve(), invite = null;
  let minute = now(), requests = 0, pairingRequests = 0;
  const pending = new Map(), live = new Map(), sockets = new Set(), denied = new Set(), seen = new Map();
  const serial = callback => { const result = queue.catch(() => {}).then(callback); queue = result; return result; };
  const prune = () => { for (const [id, item] of pending) if (item.expiresAt <= now()) pending.delete(id); if (invite?.expiresAt <= now()) invite = null; };
  const status = () => {
    prune();
    return { running: !!server?.listening && desired && !closed, devices: saved.devices.filter(device => !denied.has(device.id)).map(device => { const lastSeenAt = seen.get(device.id) || device.lastSeenAt || null; return { ...publicDevice(device), lastSeenAt, online: !!server?.listening && desired && !closed && !!lastSeenAt && now() - lastSeenAt < 45000 }; }), pending: [...pending.values()].map(({ tokenHash: _hash, ...item }) => ({ ...item })), activeRequests: live.size };
  };
  const changed = () => notify(onChange, status());
  function invalidate(deviceId) {
    for (const item of live.values()) if (!deviceId || item.deviceId === deviceId) { item.controller.abort(new Error('Remote access ended.')); item.socket.destroy(); }
    if (!deviceId) for (const socket of sockets) socket.destroy();
  }
  function touch(device) {
    const at = now(); seen.set(device.id, at);
    if (at - (device.lastSeenAt || 0) < 60000) return;
    device.lastSeenAt = at;
    void serial(async () => {
      if (closed || denied.has(device.id) || !saved.devices.some(item => item.id === device.id)) return;
      const next = copy(saved); const current = next.devices.find(item => item.id === device.id); current.lastSeenAt = seen.get(device.id) || at;
      await writeVault(host, hostVault, next); saved = next;
    }).catch(() => {});
  }
  function authenticate(request, allowPending = false) {
    const supplied = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1], id = request.headers['x-faber-device'];
    const device = saved.devices.find(item => item.id === id && !denied.has(item.id)) || (allowPending ? pending.get(id) : null);
    if (!supplied || !device || !equalHash(hash(supplied), device.tokenHash)) throw failure(401, 'Remote device is not authorized.');
    return device;
  }
  async function handle(request, response) {
    const thisServer = server, thisEpoch = epoch, operation = { controller: new AbortController(), socket: request.socket, deviceId: null };
    const key = randomUUID(); let timer;
    try {
      if (!desired || closed || !thisServer?.listening) throw failure(503, 'Remote host is off.');
      if (live.size >= 16) throw failure(429, 'Remote request concurrency limit reached.');
      for (const header of ['authorization', 'host', 'origin', 'x-faber-device', 'x-faber-remote', 'content-type']) if (request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === header).length > 1) throw failure(400, 'Duplicate remote security header.');
      if (request.headers.host !== authority || request.headers.origin !== undefined || request.headers['x-faber-remote'] !== '1' || Object.keys(request.headers).some(key => /^(?:forwarded|x-forwarded-|proxy-|via$)/i.test(key))) throw failure(403, 'Invalid remote endpoint request.');
      if (request.method !== 'POST' || !['/pair', '/pair/status', '/request'].includes(request.url)) throw failure(404, 'Remote route is unavailable.');
      if (now() - minute >= 60000) { minute = now(); requests = 0; pairingRequests = 0; }
      if (++requests > 600 || request.url === '/pair' && ++pairingRequests > 10) throw failure(429, 'Remote request rate limit reached.');
      prune(); live.set(key, operation);
      const abort = () => operation.controller.abort(new Error('Remote controller disconnected.'));
      request.once('aborted', abort); response.once('close', () => { if (!response.writableEnded) abort(); });
      timer = setTimeout(() => { operation.controller.abort(new Error('Remote request timed out.')); send(response, 504, { error: 'Remote request timed out.' }); request.socket.destroy(); }, 60000); timer.unref?.();
      const fence = () => {
        operation.controller.signal.throwIfAborted();
        if (closed || !desired || thisServer !== server || thisEpoch !== epoch || request.socket.destroyed || operation.deviceId && denied.has(operation.deviceId)) throw failure(503, 'Remote access ended.');
      };
      if (request.url === '/pair') {
        const body = await readJSON(request, 4096); fence();
        if (!invite || invite.expiresAt <= now() || !opaque.test(body.nonce || '') || !equalHash(hash(body.nonce), invite.nonceHash) || !opaque.test(body.token || '') || pending.size >= 8 || saved.devices.length + pending.size >= 32) throw failure(403, 'Pairing invitation is unavailable.');
        let deviceName; try { deviceName = name(body.name); } catch { throw failure(400, 'A visible device name is required.'); }
        const tokenHash = hash(body.token);
        if (saved.devices.some(item => equalHash(tokenHash, item.tokenHash)) || [...pending.values()].some(item => equalHash(tokenHash, item.tokenHash))) throw failure(409, 'Pairing credential is already in use.');
        const item = { id: randomUUID(), name: deviceName, hostName: invite.hostName, tokenHash, createdAt: now(), expiresAt: invite.expiresAt };
        invite = null; pending.set(item.id, item); changed();
        send(response, 202, { id: item.id, state: 'pending', expiresAt: item.expiresAt }); return;
      }
      const device = authenticate(request, request.url === '/pair/status'); operation.deviceId = device.id;
      if ([...live.values()].filter(item => item.deviceId === device.id).length > 4) throw failure(429, 'Remote device concurrency limit reached.');
      const body = await readJSON(request, request.url === '/request' ? requestLimit : 4096); fence();
      if (request.url === '/pair/status') { send(response, 200, { id: device.id, state: pending.has(device.id) ? 'pending' : 'accepted' }); return; }
      if (!record(body.params) || typeof body.method !== 'string' || !/^[a-z][a-zA-Z0-9.]{0,99}$/.test(body.method)) throw failure(400, 'Invalid remote application request.');
      const result = await abortable(dispatch(body.method, body.params, { device: publicDevice(device), signal: operation.controller.signal }), operation.controller.signal);
      fence();
      const current = saved.devices.find(item => item.id === device.id);
      if (!current || !equalHash(current.tokenHash, device.tokenHash)) throw failure(401, 'Remote device was revoked.');
      touch(current); send(response, 200, { result }); changed();
    } catch (error) { send(response, error.remoteStatus || (operation.controller.signal.aborted ? 503 : 500), { error: error.remoteStatus ? error.message : operation.controller.signal.aborted ? 'Remote request canceled.' : 'Remote request failed.' }); }
    finally { clearTimeout(timer); live.delete(key); }
  }
  const service = {
    status,
    start() {
      if (closed) return Promise.reject(new Error('Remote host is closed.'));
      if (server?.listening && desired) return Promise.resolve({ port: server.address().port });
      desired = true; const wantedEpoch = ++epoch;
      return serial(async () => {
        if (closed || !desired || wantedEpoch !== epoch) throw new Error('Remote host start was canceled.');
        if (server?.listening) return { port: server.address().port };
        if (!saved.identity) {
          const generated = await createIdentity(); identity(generated, now());
          const next = { ...saved, identity: generated }; await writeVault(host, hostVault, next); saved = next;
        }
        const checked = identity(saved.identity, now());
        if (closed || !desired || wantedEpoch !== epoch) throw new Error('Remote host start was canceled.');
        const listener = https.createServer({ pfx: Buffer.from(checked.pfx, 'base64'), minVersion: 'TLSv1.2', handshakeTimeout: 10000, maxHeaderSize: 8192 }, (request, response) => { void handle(request, response); });
        listener.requestTimeout = 60000; listener.headersTimeout = 15000; listener.keepAliveTimeout = 1; listener.maxRequestsPerSocket = 1;
        listener.on('connection', socket => { if (sockets.size >= 32) { socket.destroy(); return; } sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
        listener.on('clientError', (_error, socket) => socket.destroy());
        await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
        if (closed || !desired || wantedEpoch !== epoch) { await new Promise(resolve => listener.close(resolve)); throw new Error('Remote host start was canceled.'); }
        server = listener; changed(); return { port: listener.address().port };
      });
    },
    stop() {
      desired = false; epoch++; invite = null; pending.clear(); invalidate(); const stopped = server; server = null; changed();
      return serial(async () => { if (stopped) await new Promise(resolve => stopped.close(resolve)); return status(); });
    },
    createInvitation({ relayUrl, routeId, hostName }) {
      return serial(async () => {
        if (!server?.listening || !desired || closed) throw new Error('Start the remote host before pairing.');
        const route = routePolicy({ relayUrl, routeId }, options), nonce = token(), expiresAt = now() + ttl, visibleName = name(hostName, 'Host name');
        const fingerprint = identity(saved.identity, now()).fingerprint;
        invite = { nonceHash: hash(nonce), expiresAt, hostName: visibleName };
        const value = { v: 1, ...route, hostName: visibleName, fingerprint, nonce, expiresAt };
        changed(); return { invitation: 'FABER-PAIR-1.' + Buffer.from(JSON.stringify(value)).toString('base64url'), expiresAt };
      });
    },
    acceptPairing(id) {
      return serial(async () => {
        prune(); const item = pending.get(id);
        if (!item || !server?.listening || !desired || closed) throw new Error('Pending remote pairing is unavailable or expired.');
        const device = { id: item.id, name: item.name, tokenHash: item.tokenHash, createdAt: now(), lastSeenAt: null };
        const next = { ...saved, devices: [...saved.devices, device] }; await writeVault(host, hostVault, next);
        saved = next;
        if (closed || !desired || !pending.has(id) || denied.has(id)) {
          denied.add(id); const canceled = { ...saved, devices: saved.devices.filter(device => device.id !== id) };
          await writeVault(host, hostVault, canceled); saved = canceled; throw new Error('Remote pairing was canceled.');
        }
        pending.delete(id); changed(); return publicDevice(device);
      });
    },
    rejectPairing(id) { pending.delete(id); changed(); return status(); },
    revokeDevice(id) {
      denied.add(id); pending.delete(id); invalidate(id); changed();
      return serial(async () => { const next = { ...saved, devices: saved.devices.filter(item => item.id !== id) }; await writeVault(host, hostVault, next); saved = next; seen.delete(id); changed(); return status(); });
    },
    async dispose() { closed = true; await service.stop(); }
  };
  return service;
}

async function connectPinned(route, fingerprint, dial, signal) {
  signal.throwIfAborted();
  const dialing = Promise.resolve().then(() => dial(route, { signal }));
  void dialing.then(stream => { if (signal.aborted) stream.destroy(); }, () => {});
  const raw = await abortable(dialing, signal);
  if (signal.aborted) { raw.destroy(); signal.throwIfAborted(); }
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: raw, servername: authority, minVersion: 'TLSv1.2', rejectUnauthorized: false });
    let settled=false;
    function fail(message){
      if(settled)return;settled=true;signal.removeEventListener('abort',stop);
      socket.destroy();reject(new Error(message));
    }
    const stop=()=>fail('Remote request canceled.');
    socket.on('error',()=>fail('Remote secure connection failed.'));
    socket.once('close',()=>fail('Remote secure connection closed during handshake.'));
    signal.addEventListener('abort', stop, { once: true });
    if(signal.aborted){stop();return;}
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate().raw;
        if (!peer || !equalHash(hash(peer), fingerprint)) throw new Error();
        const cert = new X509Certificate(peer);
        if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new Error();
        if(settled)return;settled=true;signal.removeEventListener('abort',stop);resolve(socket);
      } catch { fail('Remote host certificate does not match the pairing identity.'); }
    });
  });
}
async function exchange({ route, fingerprint, deviceId, credential, path, body, dial, signal }) {
  const payload = Buffer.from(JSON.stringify(body));
  if (payload.length > (path === '/request' ? requestLimit : 4096)) throw new Error('Remote request exceeds the transport limit.');
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('Remote request timed out.')), 60000); timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let socket, agent;
  try {
    socket = await connectPinned(route, fingerprint, dial, combined); combined.throwIfAborted();
    // The HTTP request is created only after the TLS peer pin succeeds, so even queued headers contain no unverified-socket credentials.
    agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => socket;
    return await new Promise((resolve, reject) => {
      const request = http.request({ hostname: authority, port: 443, method: 'POST', path, agent, signal: combined, headers: { Host: authority, 'X-Faber-Remote': '1', 'Content-Type': 'application/json', 'Content-Length': payload.length, Connection: 'close', ...(credential && deviceId ? { Authorization: 'Bearer ' + credential, 'X-Faber-Device': deviceId } : {}) } }, response => {
        let size = 0; const chunks = [];
        response.on('data', chunk => { size += chunk.length; if (size > responseLimit) { response.destroy(); reject(new Error('Remote response exceeds the transport limit.')); } else chunks.push(chunk); });
        response.on('error', () => reject(new Error('Remote response was interrupted.')));
        response.on('end', () => {
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new Error('Remote host returned an invalid response.')); return; }
          if (!record(value) || !/^application\/json(?:; charset=utf-8)?$/i.test(response.headers['content-type'] || '')) { reject(new Error('Remote host returned an invalid response.')); return; }
          if (response.statusCode < 200 || response.statusCode >= 300) { reject(Object.assign(new Error(typeof value.error === 'string' && value.error.length <= 300 ? value.error : 'Remote request was rejected.'), { status: response.statusCode })); return; }
          resolve(value);
        });
      });
      request.on('error', () => reject(new Error(combined.aborted ? 'Remote request canceled or timed out.' : 'Remote connection was interrupted.'))); request.end(payload);
    });
  } finally { clearTimeout(timer); agent?.destroy(); socket?.destroy(); }
}
export async function createRemoteController({ host, dial, onChange, now = Date.now, ...options } = {}) {
  if (typeof dial !== 'function') throw new Error('Remote controller requires an approved relay dialer.');
  let saved = await readVault(host, controllerVault) || { version: 1, connections: [] };
  try {
    if (!Array.isArray(saved.connections) || saved.connections.length > 32 || new Set(saved.connections.map(item => item.id)).size !== saved.connections.length) throw new Error();
    for (const item of saved.connections) {
      if (!record(item) || !idPattern.test(item.id || '') || !idPattern.test(item.deviceId || '') || !opaque.test(item.token || '') || !hex.test(item.fingerprint || '') || !validTime(item.createdAt) || name(item.name) !== item.name || name(item.hostName) !== item.hostName) throw new Error();
      routePolicy(item, options);
    }
  } catch { throw new Error('Remote controller encrypted storage is invalid; saved data is preserved.'); }
  let pending = null, closed = false, queue = Promise.resolve();
  const active = new Map(), forgotten = new Set(), moving = new Set();
  const status = () => ({ connections: saved.connections.filter(connection => !forgotten.has(connection.id)).map(publicConnection), pending: pending ? { id: pending.id || null, hostName: pending.hostName, name: pending.name, expiresAt: pending.expiresAt } : null, activeRequests: active.size });
  const changed = () => notify(onChange, status());
  const serial = callback => { const result = queue.catch(() => {}).then(callback); queue = result; return result; };
  async function call(connectionId, descriptor, path, body, signal) {
    if (closed) throw new Error('Remote controller is closed.');
    if (active.size >= 16 || [...active.values()].filter(item => item.connectionId === connectionId).length >= 4) throw new Error('Remote controller concurrency limit reached.');
    const controller = new AbortController(), id = randomUUID();
    active.set(id, { connectionId, controller }); changed();
    try {
      const route = routePolicy(descriptor, options);
      return await exchange({ route, fingerprint: descriptor.fingerprint, deviceId: descriptor.deviceId, credential: descriptor.token, path, body, dial, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
    } finally { active.delete(id); changed(); }
  }
  const service = {
    status,
    pair({ invitation, deviceName }) {
      return serial(async () => {
        if (closed || pending) throw new Error(closed ? 'Remote controller is closed.' : 'Finish or cancel the current pairing first.');
        const parsed = parseRemoteInvitation(invitation, { now: now(), allowLocalRelay: options.allowLocalRelay });
        routePolicy(parsed, options);
        const item = { ...parsed, name: name(deviceName), token: token(), id: null };
        pending = item; changed();
        try {
          const result = await call('pairing', item, '/pair', { nonce: item.nonce, token: item.token, name: item.name });
          if (pending !== item || closed) throw new Error('Remote pairing was canceled.');
          if (!idPattern.test(result.id || '') || result.state !== 'pending' || result.expiresAt !== item.expiresAt) throw new Error('Remote host returned an invalid pairing response.');
          item.id = result.id; item.deviceId = result.id; delete item.nonce; changed(); return status().pending;
        } catch (error) { if (pending === item) pending = null; changed(); throw error; }
      });
    },
    completePairing() {
      return serial(async () => {
        const item = pending;
        if (!item?.deviceId || item.expiresAt <= now()) { pending = null; changed(); throw new Error('Remote pairing is unavailable or expired.'); }
        const result = await call('pairing', item, '/pair/status', {});
        if (pending !== item || closed) throw new Error('Remote pairing was canceled.');
        if (result.id !== item.deviceId || !['pending', 'accepted'].includes(result.state)) throw new Error('Remote host returned an invalid pairing status.');
        if (result.state === 'pending') return { state: 'pending', ...status().pending };
        const existing = saved.connections.find(connection => connection.fingerprint === item.fingerprint && !forgotten.has(connection.id));
        const connection = { id: existing?.id || randomUUID(), hostName: item.hostName, name: item.name, deviceId: item.deviceId, relayUrl: item.relayUrl, routeId: item.routeId, fingerprint: item.fingerprint, token: item.token, createdAt: now() };
        const next = { ...saved, connections: [...saved.connections.filter(entry => entry.fingerprint !== connection.fingerprint), connection] };
        if (next.connections.length > 32) throw new Error('Forget a saved remote host before adding another.');
        await writeVault(host, controllerVault, next);
        if (closed || pending !== item) { await writeVault(host, controllerVault, saved); throw new Error('Remote pairing was canceled.'); }
        saved = next; pending = null; changed(); return { state: 'accepted', connection: publicConnection(connection) };
      });
    },
    cancelPairing() { pending = null; for (const item of active.values()) if (item.connectionId === 'pairing') item.controller.abort(); changed(); return status(); },
    async request(connectionId, method, params = {}, { signal } = {}) {
      if(moving.has(connectionId))throw new Error('The relay address is being verified.');
      const connection = saved.connections.find(item => item.id === connectionId && !forgotten.has(item.id));
      if (!connection) throw new Error('Saved remote host is unavailable.');
      const result = await call(connectionId, connection, '/request', { method, params }, signal);
      return result.result;
    },
    disconnect(connectionId) { for (const item of active.values()) if (!connectionId || item.connectionId === connectionId) item.controller.abort(); changed(); return status(); },
    changeRelay(connectionId,relayUrl){
      return serial(async()=>{
        const old=saved.connections.find(item=>item.id===connectionId&&!forgotten.has(item.id));
        if(!old||closed)throw Error('Saved remote host is unavailable.');
        const candidate={...old,...routePolicy({...old,relayUrl},options)};
        moving.add(connectionId);service.disconnect(connectionId);
        try{
          await call(connectionId,candidate,'/request',{method:'workspace.rpc',params:{method:'workspace.ping',params:{}}});
          if(closed||forgotten.has(connectionId))throw Error('Remote connection changed.');
          const next={...saved,connections:saved.connections.map(item=>item.id===connectionId?candidate:item)};
          await writeVault(host,controllerVault,next);saved=next;changed();return status();
        }finally{moving.delete(connectionId);}
      });
    },
    forget(connectionId) {
      forgotten.add(connectionId); service.disconnect(connectionId);
      return serial(async () => { const next = { ...saved, connections: saved.connections.filter(item => item.id !== connectionId) }; await writeVault(host, controllerVault, next); saved = next; changed(); return status(); });
    },
    async dispose() { closed = true; service.cancelPairing(); service.disconnect(); await queue.catch(() => {}); }
  };
  return service;
}
