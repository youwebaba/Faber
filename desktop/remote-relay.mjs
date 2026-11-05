import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import WebSocketClient from './vendor/ws/lib/websocket.js';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/, sessionPattern = /^[A-Za-z0-9_-]{22}$/;
const frameBytes = 64 * 1024, windowBytes = 256 * 1024, handshakeMs = 10_000;
const sendBytesPerSecond = 1.5 * 1024 * 1024;
const validToken = value => typeof value === 'string' && tokenPattern.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const error = () => new Error('Remote relay connection closed');
function record(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function parseControl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) throw new Error('Invalid relay control');
  return JSON.parse(value);
}
export function generateRouteSecret() { return randomBytes(32).toString('base64url'); }
export function deriveRouteId(secret) {
  if (!validToken(secret)) throw new Error('Invalid host registration secret');
  return createHash('sha256').update(secret).digest('base64url');
}

export function validateRelayUrl(relayUrl, { allowLocalRelay = false, approvedRelayHosts = [] } = {}) {
  if (typeof relayUrl !== 'string' || relayUrl.length > 512 || /[\s\\]/.test(relayUrl)) throw new Error('Invalid relay URL');
  let url; try { url = new URL(relayUrl); } catch { throw new Error('Invalid relay URL'); }
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname);
  const publicHost = !net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(url.hostname) &&
    !/(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example)$/.test(url.hostname) && !url.hostname.endsWith('.');
  const approved = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(url.hostname) || (Array.isArray(approvedRelayHosts) && approvedRelayHosts.includes(url.hostname));
  const origin = `${url.protocol}//${url.host}`;
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !/^wss?:\/\/[^/?#]+\/?$/i.test(relayUrl) ||
      !(allowLocalRelay && local && url.protocol === 'ws:' || publicHost && approved && url.protocol === 'wss:' && (!url.port || url.port === '443'))) throw new Error('Use an approved public WSS relay on port 443');
  return origin;
}
export function validateRelayConfig({ relayUrl, routeId }, options = {}) {
  if (!validToken(routeId)) throw new Error('Invalid relay route');
  return { relayUrl: validateRelayUrl(relayUrl, options), routeId };
}

const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
async function validateAddress(relayUrl, options) {
  const url = new URL(relayUrl);
  if (options.allowLocalRelay && url.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) return [{ address: url.hostname.replace(/^\[|\]$/g, ''), family: url.hostname === '[::1]' ? 6 : 4 }];
  let deadline;
  const addresses = await Promise.race([dns.lookup(url.hostname, { all: true, verbatim: true }), new Promise((_resolve, reject) => {
    deadline = setTimeout(() => reject(error()), handshakeMs); deadline.unref();
  })]).finally(() => clearTimeout(deadline));
  if (!addresses.length || addresses.length > 32 || addresses.some(({ address, family }) => net.isIP(address) !== family ||
      (family === 4 ? blocked.check(address, 'ipv4') : family !== 6 || !/^[23][0-9a-f]{3}:/i.test(address) || blocked.check(address, 'ipv6')))) throw new Error('Relay resolved to a nonpublic address');
  return addresses.map(({ address, family }) => ({ address, family }));
}
async function openSocket(endpoint, options) {
  options.signal?.throwIfAborted();
  const addresses = await validateAddress(endpoint, options), url = new URL(endpoint), hostname = url.hostname.replace(/^\[|\]$/g, '');
  options.signal?.throwIfAborted();
  const socketOptions = { agent: false, followRedirects: false, rejectUnauthorized: true, servername: net.isIP(hostname) ? undefined : hostname,
    perMessageDeflate: false, maxPayload: frameBytes, handshakeTimeout: handshakeMs,
    lookup(lookupHost, lookupOptions, callback) {
      if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
      if (lookupHost.toLowerCase() !== hostname) { callback(error()); return; }
      // Bind this connection to the already validated answers; never resolve the hostname again.
      if (lookupOptions?.all) callback(null, addresses.map(value => ({ ...value })));
      else callback(null, addresses[0].address, addresses[0].family);
    } };
  const Impl = options.allowLocalRelay && url.protocol === 'ws:' && net.isIP(hostname) && options.WebSocketImpl || WebSocketClient;
  const ws = new Impl(endpoint, socketOptions);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('error', () => {});
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(fail, handshakeMs); timeout.unref();
    function cleanup() { clearTimeout(timeout); ws.removeEventListener('open', opened); ws.removeEventListener('error', fail); ws.removeEventListener('close', fail); options.signal?.removeEventListener('abort', fail); }
    function fail() { cleanup(); try { ws.close(); } catch {} reject(error()); }
    function opened() { cleanup(); resolve(ws); }
    ws.addEventListener('open', opened); ws.addEventListener('error', fail); ws.addEventListener('close', fail); options.signal?.addEventListener('abort', fail, { once: true });
  });
}

class RelayDuplex extends Duplex {
  constructor(ws, signal) {
    super({ readableHighWaterMark: frameBytes, writableHighWaterMark: frameBytes, allowHalfOpen: false });
    this.ws = ws; this.credit = windowBytes; this.ackDebt = 0; this.isReady = false; this.nextWriteAt = 0;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.handshake = setTimeout(() => this.destroy(error()), handshakeMs); this.handshake.unref();
    this.message = event => {
      if (this.destroyed) return;
      try {
        if (typeof event.data === 'string') {
          if (event.data === 'faber-pong') return;
          const message = parseControl(event.data);
          if (!this.isReady && record(message, ['type', 'sessionId']) && message.type === 'ready' && sessionPattern.test(message.sessionId)) {
            this.isReady = true; clearTimeout(this.handshake); this.resolveReady(this); return;
          }
          if (!this.isReady || !record(message, ['type', 'bytes']) || message.type !== 'credit' || !Number.isSafeInteger(message.bytes) || message.bytes < 1 || this.credit + message.bytes > windowBytes) throw error();
          this.credit += message.bytes; this.resumeWriter?.(); return;
        }
        if (!this.isReady || !(event.data instanceof ArrayBuffer) || event.data.byteLength < 1 || event.data.byteLength > frameBytes || this.readableLength + event.data.byteLength > windowBytes + frameBytes) throw error();
        const size = event.data.byteLength;
        if (this.push(Buffer.from(event.data))) this.ack(size); else this.ackDebt += size;
      } catch { this.destroy(error()); }
    };
    this.onSocketClose = event => {
      if (this.isReady && event.type === 'close' && [1000, 1001].includes(event.code)) { this.push(null); this.resumeWriter?.(); }
      else this.destroy(error());
    };
    this.aborted = () => this.destroy(error()); this.signal = signal;
    ws.addEventListener('message', this.message); ws.addEventListener('close', this.onSocketClose); ws.addEventListener('error', this.onSocketClose);
    signal?.addEventListener('abort', this.aborted, { once: true });
    if (signal?.aborted) queueMicrotask(this.aborted);
    // Callers receive failures through ready or their stream; an early close cannot become an unhandled error.
    this.on('error', () => {});
  }
  ack(bytes) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'ack', bytes })); }
  _read() { if (this.ackDebt) { const debt = this.ackDebt; this.ackDebt = 0; this.ack(debt); } }
  _write(chunk, _encoding, callback) {
    const write = async () => {
      await this.ready;
      for (let offset = 0; offset < chunk.length;) {
        if (this.destroyed || this.ws.readyState !== 1) throw error();
        if (!this.credit) await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { this.resumeWriter = null; reject(error()); }, handshakeMs); timeout.unref();
          this.resumeWriter = () => { clearTimeout(timeout); this.resumeWriter = null; this.destroyed ? reject(error()) : resolve(); };
        });
        if (this.destroyed || this.ws.bufferedAmount > windowBytes) throw error();
        const size = Math.min(frameBytes, this.credit, chunk.length - offset);
        // Stay below the public relay's per-socket rate limit while preserving stream backpressure.
        const wait = Math.ceil(this.nextWriteAt - Date.now());
        if (wait > 0) await new Promise(resolve => { const timer = setTimeout(resolve, wait); timer.unref(); });
        if (this.destroyed || this.ws.readyState !== 1) throw error();
        this.nextWriteAt = Math.max(this.nextWriteAt, Date.now()) + size / sendBytesPerSecond * 1000;
        this.credit -= size; this.ws.send(chunk.subarray(offset, offset + size)); offset += size;
      }
    };
    write().then(() => callback(), callback);
  }
  _final(callback) { try { this.ws.close(1000, 'Tunnel complete'); } catch {} callback(); }
  _destroy(failure, callback) {
    clearTimeout(this.handshake); this.rejectReady(failure || error()); this.resumeWriter?.();
    this.ws.removeEventListener('message', this.message); this.ws.removeEventListener('close', this.onSocketClose); this.ws.removeEventListener('error', this.onSocketClose);
    this.signal?.removeEventListener('abort', this.aborted);
    try { this.ws.close(1000, 'Tunnel complete'); } catch {}
    callback(failure);
  }
}

export async function connectRelayController(config, options = {}) {
  const { relayUrl, routeId } = validateRelayConfig(config, options);
  const ws = await openSocket(`${relayUrl}/v1/connect/${routeId}`, options), stream = new RelayDuplex(ws, options.signal);
  await stream.ready;
  return stream;
}

export async function createRelayHostAdapter({ relayUrl, routeId, registrationSecret, targetPort, ...options }) {
  ({ relayUrl, routeId } = validateRelayConfig({ relayUrl, routeId }, options));
  if (deriveRouteId(registrationSecret) !== routeId) throw new Error('Host secret does not own this route');
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('Invalid private host port');
  const controller = new AbortController(), sessions = new Set(), pendingSessions = new Set();
  let ws, stopped = false, connected = false, reconnectTimer, heartbeat, failures = 0, lastPongAt = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true; connected = false; controller.abort(); clearTimeout(reconnectTimer); clearInterval(heartbeat);
    try { ws?.close(1000, 'Host stopped'); } catch {}
    for (const session of sessions) session.destroy();
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) { stop(); throw error(); }
  const connectionOptions = { ...options, signal: controller.signal };
  async function session(sessionId) {
    if (stopped || pendingSessions.size >= 4 || pendingSessions.has(sessionId)) return;
    pendingSessions.add(sessionId);
    let tunnel, target;
    try {
      const socket = await openSocket(`${relayUrl}/v1/session/${routeId}/${sessionId}`, connectionOptions);
      tunnel = new RelayDuplex(socket, controller.signal); sessions.add(tunnel);
      socket.send(JSON.stringify({ type: 'attach', secret: registrationSecret }));
      await tunnel.ready;
      if (stopped) throw error();
      target = net.connect({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true });
      target.setTimeout(60_000, () => target.destroy());
      await Promise.all([pipeline(tunnel, target), pipeline(target, tunnel)]);
    } catch { tunnel?.destroy(); target?.destroy(); }
    finally { sessions.delete(tunnel); pendingSessions.delete(sessionId); }
  }
  async function register() {
    ws = await openSocket(`${relayUrl}/v1/host/${routeId}`, connectionOptions);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(failed, handshakeMs); timeout.unref();
      function cleanup() { clearTimeout(timeout); ws.removeEventListener('message', message); ws.removeEventListener('close', failed); ws.removeEventListener('error', failed); }
      function failed() { cleanup(); try { ws.close(); } catch {} reject(error()); }
      function message(event) {
        try { const message = parseControl(event.data); if (!record(message, ['type']) || message.type !== 'registered') throw error(); cleanup(); resolve(); }
        catch { failed(); }
      }
      ws.addEventListener('message', message); ws.addEventListener('close', failed); ws.addEventListener('error', failed);
      ws.send(JSON.stringify({ type: 'register', secret: registrationSecret }));
    });
    if (stopped) { ws.close(); return; }
    failures = 0; connected = true; lastPongAt = Date.now();
    ws.addEventListener('message', event => {
      if (event.data === 'faber-pong') { lastPongAt = Date.now(); return; }
      try { const message = parseControl(event.data); if (!record(message, ['type', 'sessionId']) || message.type !== 'session' || !sessionPattern.test(message.sessionId)) throw error(); void session(message.sessionId); }
      catch { ws.close(1000, 'Invalid control'); }
    });
    ws.addEventListener('close', reconnect, { once: true });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} }, { once: true });
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      try { if (Date.now() - lastPongAt > 45_000) { connected = false; ws.close(); } else if (ws.readyState === 1) ws.send('faber-ping'); }
      catch { connected = false; ws.close(); }
    }, 20_000); heartbeat.unref();
  }
  function reconnect() {
    connected = false; clearInterval(heartbeat);
    for (const session of sessions) session.destroy();
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (!stopped) register().catch(reconnect); }, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5))); reconnectTimer.unref();
  }
  try { await register(); }
  catch (failure) { stop(); options.signal?.removeEventListener('abort', stop); throw failure; }
  return {
    status() { return { connected: !stopped && connected && ws?.readyState === 1, sessions: sessions.size }; },
    async close() {
      const socket = ws; stop(); options.signal?.removeEventListener('abort', stop);
      if (socket && socket.readyState !== 3) await new Promise(resolve => {
        const finish = () => { clearTimeout(timeout); socket.removeEventListener('close', finish); resolve(); };
        const timeout = setTimeout(finish, 1000); timeout.unref(); socket.addEventListener('close', finish, { once: true });
      });
    }
  };
}
