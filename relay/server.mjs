import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const limits = Object.freeze({ rooms: 8, sockets: 48, unauthenticated: 12, sessions: 4, unknownUpgradesPerMinute: 120, roomUpgradesPerMinute: 2400, upgradeBurst: 80,
  frameBytes: 64 * 1024, windowBytes: 256 * 1024, sessionBytes: 64 * 1024 * 1024,
  bytesPerSecond: 2 * 1024 * 1024, messagesPerSecond: 256, handshakeMs: 10_000,
  idleMs: 60_000, sessionMs: 30 * 60_000, hostMs: 24 * 60 * 60_000 });
export const RELAY_LIMITS = limits;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hash = secret => createHash('sha256').update(secret).digest('base64url');
const validToken = value => typeof value === 'string' && tokenPattern.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
function record(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function reject(socket, status = 400) { socket.setTimeout(1000, () => socket.destroy()); socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }

export function createRelayServer({ host = '127.0.0.1', port = 0, allowedRouteIds = [], allowedRouteFile, now: clock = Date.now } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('The proof-of-concept relay must bind to loopback');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid relay port');
  if (typeof clock !== 'function') throw new Error('Invalid relay clock');
  if (!Array.isArray(allowedRouteIds) || allowedRouteIds.length > limits.rooms || allowedRouteIds.some(id => !validToken(id)) ||
      (allowedRouteFile !== undefined && (typeof allowedRouteFile !== 'string' || !allowedRouteFile.trim())) || (!allowedRouteIds.length && !allowedRouteFile)) throw new Error('Allow one to eight provisioned host route IDs before starting the relay');
  const routeFile = allowedRouteFile ? path.resolve(allowedRouteFile) : null;
  function allowedRoutes() {
    if (!routeFile) return new Set(allowedRouteIds);
    try {
      if (statSync(routeFile).size > 4096) return new Set();
      const value = JSON.parse(readFileSync(routeFile, 'utf8'));
      const routes = Array.isArray(value) ? value : record(value, ['routes']) ? value.routes : null;
      if (!Array.isArray(routes) || routes.length > limits.rooms || routes.some(id => !validToken(id)) || new Set([...routes, ...allowedRouteIds]).size > limits.rooms) return new Set();
      return new Set([...routes, ...allowedRouteIds]);
    } catch { return new Set(); }
  }
  const rooms = new Map(), sockets = new Set(), unauthenticated = new Set();
  let closing = false, started = false, upgradeWindow = clock(), upgrades = 0;
  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000, connectionsCheckingInterval: 1000, maxHeaderSize: 4096 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/healthz') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true,"protocol":1}'); }
    else { response.writeHead(404); response.end(); }
  });
  server.maxConnections = limits.sockets + 16;
  server.maxRequestsPerSocket = 1;
  server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => reject(socket));
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.frameBytes, perMessageDeflate: false, clientTracking: false, allowSynchronousEvents: false });

  function send(ws, message) {
    if (ws.readyState !== 1 || ws.bufferedAmount > limits.windowBytes + 4096) { close(ws, 1008, 'Slow connection'); return false; }
    try { ws.send(typeof message === 'string' ? message : JSON.stringify(message), error => { if (error) close(ws); }); return true; }
    catch { close(ws); return false; }
  }
  function close(ws, code = 1008, reason = 'Session closed') {
    if (ws.faberClosed) return;
    ws.faberClosed = true;
    sockets.delete(ws); unauthenticated.delete(ws);
    const state = ws.faber;
    if (state?.room) {
      const room = state.room;
      if (room.host === ws) {
        rooms.delete(room.id);
        for (const session of [...room.sessions.values()]) { close(session.controller, code, reason); if (session.host) close(session.host, code, reason); }
      } else if (state.session) {
        room.sessions.delete(state.session.id);
        const peer = state.session.controller === ws ? state.session.host : state.session.controller;
        if (peer) close(peer, code, reason);
      }
    }
    try { ws.close(code, reason); } catch { ws.terminate(); }
    const timer = setTimeout(() => ws.terminate(), 1000); timer.unref();
  }
  function control(data) {
    if (data.length > 1024) throw new Error('Oversized control');
    return JSON.parse(data.toString('utf8'));
  }
  function admitHost(ws, message) {
    const state = ws.faber;
    if (!allowedRoutes().has(state.routeId) || !record(message, ['type', 'secret']) || message.type !== 'register' || !validToken(message.secret) || !equal(hash(message.secret), state.routeId)) throw new Error('Registration denied');
    if (rooms.has(state.routeId) || rooms.size >= limits.rooms) throw new Error('Host unavailable');
    const room = { id: state.routeId, host: ws, sessions: new Map(), upgradeTokens: limits.upgradeBurst, upgradeAt: clock() };
    rooms.set(room.id, room);
    state.role = 'host'; state.room = room; state.deadline = clock() + limits.hostMs;
    unauthenticated.delete(ws);
    send(ws, { type: 'registered' });
  }
  function attachHost(ws, message) {
    const state = ws.faber, room = rooms.get(state.routeId), session = room?.sessions.get(state.sessionId);
    if (!record(message, ['type', 'secret']) || message.type !== 'attach' || !validToken(message.secret) || !equal(hash(message.secret), state.routeId) ||
        !room || !session || session.host || session.controller.readyState !== 1 || clock() > session.deadline) throw new Error('Session denied');
    session.host = ws; session.deadline = clock() + limits.sessionMs; session.lastActivity = clock();
    state.role = 'pipe'; state.room = room; state.session = session;
    session.controller.faber.role = 'pipe';
    unauthenticated.delete(ws);
    send(ws, { type: 'ready', sessionId: session.id });
    send(session.controller, { type: 'ready', sessionId: session.id });
  }
  function acceptController(ws) {
    const room = rooms.get(ws.faber.routeId);
    if (!room || room.host.readyState !== 1 || room.sessions.size >= limits.sessions) { close(ws, 1008, 'Host unavailable'); return; }
    const session = { id: randomBytes(16).toString('base64url'), controller: ws, host: null, deadline: clock() + limits.handshakeMs, lastActivity: clock() };
    room.sessions.set(session.id, session);
    ws.faber.role = 'waiting'; ws.faber.room = room; ws.faber.session = session;
    unauthenticated.delete(ws);
    send(room.host, { type: 'session', sessionId: session.id });
  }
  function onMessage(ws, data, binary) {
    if (ws.faberClosed) return;
    const state = ws.faber, now = clock();
    try {
      state.lastActivity = now;
      if (now - state.rateAt >= 1000) { state.rateAt = now; state.messages = 0; state.bytes = 0; }
      if (++state.messages > limits.messagesPerSecond || (state.bytes += data.length) > limits.bytesPerSecond) throw new Error('Rate limit');
      if (state.role === 'register') { if (binary) throw new Error('Invalid registration'); admitHost(ws, control(data)); return; }
      if (state.role === 'attach') { if (binary) throw new Error('Invalid attachment'); attachHost(ws, control(data)); return; }
      if (!binary && data.toString('utf8') === 'faber-ping') { send(ws, 'faber-pong'); return; }
      if (state.role !== 'pipe') throw new Error('Unexpected frame');
      const session = state.session, peer = session.controller === ws ? session.host : session.controller;
      if (!peer || peer.readyState !== 1 || now > session.deadline) throw new Error('Session expired');
      if (!binary) {
        const message = control(data);
        if (!record(message, ['type', 'bytes']) || message.type !== 'ack' || !Number.isSafeInteger(message.bytes) || message.bytes < 1 || message.bytes > state.inFlight) throw new Error('Invalid acknowledgement');
        state.inFlight -= message.bytes;
        send(peer, { type: 'credit', bytes: message.bytes });
        return;
      }
      if (data.length < 1 || data.length > limits.frameBytes || peer.faber.inFlight + data.length > limits.windowBytes ||
          (state.totalBytes += data.length) > limits.sessionBytes || peer.bufferedAmount > limits.windowBytes) throw new Error('Tunnel limit');
      peer.faber.inFlight += data.length; session.lastActivity = now;
      peer.send(data, { binary: true }, error => { if (error) close(peer); });
    } catch { close(ws, 1008, 'Relay policy rejected frame'); }
  }
  server.on('upgrade', (request, socket, head) => {
    if (closing) { reject(socket, 503); return; }
    const now = clock();
    const match = /^\/v1\/(host|connect|session)\/([A-Za-z0-9_-]{43})(?:\/([A-Za-z0-9_-]{22}))?$/.exec(request.url || '');
    const validUpgrade = request.method === 'GET' && match && validToken(match[2]) && (match[1] === 'session') === Boolean(match[3]) && !request.headers['sec-websocket-protocol'];
    const room = validUpgrade ? rooms.get(match[2]) : undefined, pending = match?.[1] === 'session' && room?.sessions.get(match[3]);
    const admitted = room?.host.readyState === 1 && (match[1] === 'connect' && room.sessions.size < limits.sessions || pending && !pending.host);
    if (admitted) {
      room.upgradeTokens = Math.min(limits.upgradeBurst, room.upgradeTokens + Math.max(0, now - room.upgradeAt) * limits.roomUpgradesPerMinute / 60_000); room.upgradeAt = now;
      if (room.upgradeTokens < 1) { reject(socket, 429); return; }
      room.upgradeTokens--;
    } else {
      if (now - upgradeWindow >= 60_000) { upgradeWindow = now; upgrades = 0; }
      if (++upgrades > limits.unknownUpgradesPerMinute) { reject(socket, 429); return; }
    }
    if (!validUpgrade || !allowedRoutes().has(match[2])) { reject(socket); return; }
    if (!admitted && match[1] !== 'host') { reject(socket, 429); return; }
    if (sockets.size >= limits.sockets || unauthenticated.size >= limits.unauthenticated) { reject(socket, 429); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      ws.faber = { role: match[1] === 'host' ? 'register' : match[1] === 'session' ? 'attach' : 'waiting', routeId: match[2], sessionId: match[3],
        deadline: clock() + limits.handshakeMs, lastActivity: clock(), inFlight: 0, totalBytes: 0, rateAt: clock(), messages: 0, bytes: 0 };
      sockets.add(ws); unauthenticated.add(ws);
      ws.on('error', () => close(ws));
      ws.on('close', code => close(ws, [1000, 1001].includes(code) ? code : 1008));
      ws.on('message', (data, binary) => onMessage(ws, data, binary));
      for (const event of ['ping', 'pong']) ws.on(event, () => {
        const state = ws.faber, now = clock();
        if (now - state.rateAt >= 1000) { state.rateAt = now; state.messages = 0; state.bytes = 0; }
        if (++state.messages > limits.messagesPerSecond) close(ws, 1008, 'Rate limit');
      });
      if (match[1] === 'connect') acceptController(ws);
    });
  });
  const sweep = setInterval(() => {
    const now = clock(), allowed = allowedRoutes();
    for (const ws of sockets) {
      const state = ws.faber;
      if (!allowed.has(state.routeId)) close(ws, 1008, 'Host revoked');
      else if ((state.role === 'host' || unauthenticated.has(ws)) && now > state.deadline) close(ws, 1000, 'Reconnect required');
      else if (state.role === 'host' && now - state.lastActivity > limits.idleMs) close(ws, 1000, 'Host heartbeat expired');
      else if (state.session && (now > state.session.deadline || now - state.session.lastActivity > limits.idleMs)) close(ws, 1000, 'Session expired');
    }
  }, 1000); sweep.unref();

  return {
    async start() {
      if (closing) throw new Error('Relay is closed');
      if (!started) { await new Promise((resolve, rejectStart) => { server.once('error', rejectStart); server.listen({ host, port }, () => { server.off('error', rejectStart); resolve(); }); }); started = true; }
      return { host, port: server.address().port };
    },
    status() { return { rooms: rooms.size, sockets: sockets.size, sessions: [...rooms.values()].reduce((sum, room) => sum + room.sessions.size, 0) }; },
    async close() {
      if (closing) return;
      closing = true; clearInterval(sweep);
      for (const ws of [...sockets]) { close(ws, 1001, 'Relay stopped'); ws.terminate(); }
      wss.close();
      if (started) { const done = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await done; }
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = { allowedRouteIds: (process.env.FABER_RELAY_ALLOWED_ROUTES || '').split(',').filter(Boolean), port: 8787 };
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--port' && /^\d{1,5}$/.test(args[i + 1] || '')) options.port = Number(args[i + 1]);
      else if (args[i] === '--bind' && args[i + 1]) options.host = args[i + 1];
      else if (args[i] === '--allow-route' && args[i + 1]) options.allowedRouteIds.push(args[i + 1]);
      else if (args[i] === '--allow-file' && args[i + 1]) options.allowedRouteFile = args[i + 1];
      else throw new Error('Usage: node relay/server.mjs [--bind 127.0.0.1] [--port 8787] (--allow-route ROUTE_ID | --allow-file FILE)');
    }
    const relay = createRelayServer(options), address = await relay.start();
    console.log(`Faber blind relay listening on ${address.host}:${address.port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); process.exitCode = 0; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
