import fs from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { validate } from '../core/registry.mjs';
import { atomicWrite } from './recovery.mjs';
import { createRemoteHost, createRemoteController } from './remote-transport.mjs';
import { createRelayHostAdapter, connectRelayController, generateRouteSecret, deriveRouteId, validateRelayConfig, validateRelayUrl } from './remote-relay.mjs';

const id = { type: 'string', minLength: 1, maxLength: 256 }, name = { type: 'string', minLength: 1, maxLength: 80 };
const flag = { type: 'boolean' }, url = { type: 'string', maxLength: 512 };
const object = (properties, required = Object.keys(properties)) => ({ type:'object', properties, required, additionalProperties:false });
const configSchema = object({ allowConnections:flag, keepAwake:flag, deviceName:name, relayUrl:url },[]);
const rpcSchema = object({ method:id, params:{type:'object'}, requestId:id },['method','params']);
const schema = {
  'remote.status':object({}), 'remote.configure':configSchema, 'remote.invite':object({}),
  'remote.pair':object({ invite:{type:'string',minLength:1,maxLength:4096}, deviceName:name }, ['invite']),
  'remote.approve':object({id,allow:flag}), 'remote.revoke':object({id}), 'remote.forget':object({id}),
  'remote.request':object({ deviceId:id, ...rpcSchema.properties },['deviceId','method','params']),
};
export const remoteMethods = Object.keys(schema);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file,'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function createRemoteService({ dataDir, operatorDir, host, dispatch, emit, suspended = () => false, safeMode = false,
  powerMonitor, powerSaveBlocker, allowLocalRelay = false }) {
  const file = path.join(dataDir,'connections.json');
  const savedConfig = await readJson(file,{}); validate(savedConfig,configSchema);
  let config = { deviceName: hostname().slice(0,80) || 'This PC', allowConnections:false, keepAwake:false, relayUrl:'', ...savedConfig };
  let pilot, hostRouteId, registrationSecret, adapter, receiver, controller, closed = false, connectedState = 'off', error = '', pairError = '';
  let attempt, retry, pairingTimer, pairingBusy = false, awakeId, lastPublished = '', queue = Promise.resolve();
  const lastSeen = new Map(), lastProbe = new Map(), probing = new Set();
  const lifetime = new AbortController(), polls = new Map();
  const relayUrl = () => config.relayUrl || pilot?.relayUrl || '';
  const opts = () => ({ allowLocalRelay, approvedRelayHosts: relayUrl() ? [new URL(relayUrl()).hostname] : [] });
  function normalizeUrl(input) {
    if (!input) return '';
    const value = input.replace(/^https:\/\//i,'wss://');
    return validateRelayUrl(value,{allowLocalRelay,approvedRelayHosts:[new URL(value).hostname]});
  }
  async function readPilot() {
    if (!operatorDir) return null;
    const value = await readJson(path.join(operatorDir,'operator.json'),null);
    if (!value) return null;
    return { relayUrl:normalizeUrl(value.relayUrl), allowLocalEnrollment:value.allowLocalEnrollment === true };
  }
  pilot = await readPilot();
  if (config.relayUrl) config.relayUrl = normalizeUrl(config.relayUrl);
  const trusted = route => { validateRelayConfig(route,opts()); return true; };
  const serialize = fn => { const outcome = queue.then(fn); queue = outcome.catch(()=>{}); return outcome; };
  function onAC() { return powerMonitor ? !powerMonitor.isOnBatteryPower() : false; }
  function managePower() {
    const wanted = !closed && !safeMode && config.allowConnections && config.keepAwake && onAC();
    if (wanted && awakeId === undefined) awakeId = powerSaveBlocker?.start('prevent-app-suspension');
    if (!wanted && awakeId !== undefined) { powerSaveBlocker?.stop(awakeId); awakeId = undefined; }
  }
  function status() {
    const h = receiver?.status() ?? {devices:[],pending:[]}, c = controller?.status() ?? {connections:[],pending:null};
    const state = connectedState === 'online' && !adapter?.status().connected ? 'connecting' : connectedState;
    return { deviceName:config.deviceName, config:{allowConnections:config.allowConnections,keepAwake:config.keepAwake,relayUrl:relayUrl()},
      relayConfigured:!!relayUrl(), hostRouteId:hostRouteId || null, keepAwake:{active:awakeId !== undefined,onAC:onAC()},
      hosting:{state,...(error?{error}:{})}, pairing:c.pending, pairingError:pairError,
      pending:h.pending.map(p => ({id:p.id,deviceName:p.name,requestedAt:p.createdAt,expiresAt:p.expiresAt})),
      devices:[...h.devices.map(d=>({id:d.id,name:d.name,role:'controller',online:d.online,pairedAt:d.createdAt,lastSeen:d.lastSeenAt})),
        ...c.connections.map(d=>({id:d.id,name:d.hostName,role:'host',online:Date.now()-(lastSeen.get(d.id) || 0)<45000,pairedAt:d.createdAt,lastSeen:lastSeen.get(d.id)||null}))] };
  }
  function publish() {
    if (closed) return;
    const state = status(), key = JSON.stringify(state);
    if (key !== lastPublished) { lastPublished = key; emit?.({type:'remote',state}); }
  }
  function powerChange() { managePower(); publish(); }
  async function getRoute() {
    if (registrationSecret) return;
    registrationSecret = await host.getSecret('remote-relay-registration-v1');
    if (!registrationSecret) {
      const next = generateRouteSecret();
      await host.setSecret('remote-relay-registration-v1',next); registrationSecret = next;
    }
    hostRouteId = deriveRouteId(registrationSecret);
  }
  async function enroll() {
    if (!pilot?.allowLocalEnrollment || relayUrl() !== pilot.relayUrl) return;
    const routeFile = path.join(operatorDir,'routes.json');
    const raw = await readJson(routeFile,{routes:[]});
    if (!Array.isArray(raw.routes) || !raw.routes.every(s=>typeof s==='string' && /^[A-Za-z0-9_-]{43}$/.test(s))) throw new Error('Invalid local relay route file');
    if (raw.routes.includes(hostRouteId)) return;
    if (raw.routes.length >= 8) throw new Error('The local relay host list is full');
    await atomicWrite(routeFile,JSON.stringify({routes:[...raw.routes,hostRouteId]}));
  }
  receiver = await createRemoteHost({host,allowLocalRelay,validateRoute:trusted,onChange:publish,dispatch:(method,envelope,authority)=>{
    if (closed || safeMode || suspended() || !config.allowConnections || method !== 'workspace.rpc') throw new Error('Remote workspace unavailable');
    validate(envelope,rpcSchema);
    return dispatch(envelope.method,envelope.params,{...authority,requestId:envelope.requestId});
  }});
  controller = await createRemoteController({host,allowLocalRelay,validateRoute:trusted,onChange:publish,
    dial:(route,{signal})=>connectRelayController(route,{...opts(),signal})});
  async function stopHosting() {
    clearTimeout(retry); attempt?.abort(); attempt = undefined;
    const old = adapter; adapter = undefined; connectedState = 'off'; error = '';
    await Promise.all([old?.close(),receiver.stop()]); managePower(); publish();
  }
  async function startHosting() {
    if (closed || safeMode || !config.allowConnections || attempt) return;
    const current = new AbortController(); attempt = current;
    connectedState = 'connecting'; error = ''; publish(); managePower();
    try {
      pilot = await readPilot();
      if (!relayUrl()) throw new Error('Set a relay address in Connections to host this PC.');
      await getRoute();
      if (current.signal.aborted) return;
      await enroll();
      current.signal.throwIfAborted();
      const {port} = await receiver.start();
      current.signal.throwIfAborted();
      const live = await createRelayHostAdapter({ relayUrl:relayUrl(), routeId:hostRouteId, registrationSecret, targetPort:port, ...opts(), signal:current.signal });
      if (current.signal.aborted) { await live.close(); return; }
      adapter = live; connectedState = 'online'; error = '';
    } catch (e) {
      if (current.signal.aborted) return;
      connectedState = 'offline'; error = e.message;
      await receiver.stop();
      if (current.signal.aborted || attempt !== current) return;
      retry = setTimeout(()=>{attempt = undefined; void startHosting();},10000); retry.unref?.();
    } finally { publish(); }
  }
  async function finishPair() {
    if (closed || pairingBusy || !controller.status().pending) return;
    pairingBusy = true;
    try { const result = await controller.completePairing(); if (result.state === 'accepted') { lastSeen.set(result.connection.id,Date.now()); pairError = ''; } }
    catch (e) { pairError = e.message; if (!controller.status().pending || controller.status().pending.expiresAt <= Date.now()) controller.cancelPairing(); }
    finally { pairingBusy = false; publish(); }
  }
  function probeHosts() {
    for (const {id:connectionId} of controller.status().connections) {
      if (probing.size >= 2) break;
      const recentlySeen = Math.max(lastSeen.get(connectionId)||0,lastProbe.get(connectionId)||0);
      if (probing.has(connectionId) || Date.now()-recentlySeen < 45000) continue;
      probing.add(connectionId); lastProbe.set(connectionId,Date.now());
      const signal = AbortSignal.any([lifetime.signal,AbortSignal.timeout(8000)]);
      void controller.request(connectionId,'workspace.rpc',{method:'workspace.ping',params:{}},{signal})
        .then(()=>{lastSeen.set(connectionId,Date.now());},()=>{}).finally(()=>{probing.delete(connectionId);publish();});
    }
  }
  powerMonitor?.on('on-ac',powerChange); powerMonitor?.on('on-battery',powerChange);
  pairingTimer = setInterval(()=>{void finishPair(); publish();},2500); pairingTimer.unref?.();
  if (config.allowConnections && !safeMode) void startHosting();
  return {
    async request(method,params = {}) {
      if (closed || !Object.hasOwn(schema,method)) throw new Error('Remote connections unavailable');
      validate(params,schema[method]);
      if (method === 'remote.status') { probeHosts(); return status(); }
      if (method === 'remote.request') {
        const {deviceId,...envelope} = params;
        const selected = envelope.method === 'chat.read' && !envelope.params.before;
        const prior = selected && polls.get(deviceId);
        if (prior && prior.chatId !== envelope.params.chatId) prior.controller.abort();
        if (selected && envelope.params.waitMs && prior?.chatId === envelope.params.chatId && prior.since === envelope.params.since) return prior.result;
        const poll = selected && envelope.params.waitMs ? {chatId:envelope.params.chatId,since:envelope.params.since,controller:new AbortController()} : null;
        if (poll) { prior?.controller.abort(); polls.set(deviceId,poll); }
        const result = controller.request(deviceId,'workspace.rpc',envelope,{signal:poll?.controller.signal});
        if (poll) poll.result = result;
        try { const value = await result; lastSeen.set(deviceId,Date.now()); return value; }
        finally { if (poll && polls.get(deviceId) === poll) polls.delete(deviceId); }
      }
      if (method === 'remote.configure') return serialize(async()=>{
        pilot = await readPilot();
        const next = {...config,...params};
        if (params.relayUrl !== undefined) {
          next.relayUrl = normalizeUrl(params.relayUrl);
          if (next.relayUrl === pilot?.relayUrl) next.relayUrl = '';
        }
        if (safeMode && next.allowConnections) throw new Error('Restart in normal mode before hosting a remote session.');
        if (next.allowConnections && !(next.relayUrl || pilot?.relayUrl)) throw new Error('Enter your relay address first.');
        const restart = next.allowConnections !== config.allowConnections || next.relayUrl !== config.relayUrl;
        await atomicWrite(file,JSON.stringify(next)); config = next;
        if (restart) { await stopHosting(); if (config.allowConnections) void startHosting(); }
        managePower(); publish(); return status();
      });
      if (method === 'remote.invite') {
        if (!config.allowConnections || !adapter?.status().connected || suspended()) throw new Error('Wait for the relay connection before creating an invitation.');
        const invitation = await receiver.createInvitation({relayUrl:relayUrl(),routeId:hostRouteId,hostName:config.deviceName});
        return {invite:invitation.invitation,expiresAt:invitation.expiresAt};
      }
      if (method === 'remote.pair') { pairError=''; await controller.pair({invitation:params.invite,deviceName:params.deviceName || config.deviceName}); publish(); return status(); }
      if (method === 'remote.approve') { if (params.allow) await receiver.acceptPairing(params.id); else receiver.rejectPairing(params.id); }
      if (method === 'remote.revoke') await receiver.revokeDevice(params.id);
      if (method === 'remote.forget') { await controller.forget(params.id); lastSeen.delete(params.id); }
      publish(); return status();
    },
    async close() {
      if (closed) return;
      closed=true; lifetime.abort(); clearInterval(pairingTimer); clearTimeout(retry); attempt?.abort(); managePower();
      powerMonitor?.off('on-ac',powerChange); powerMonitor?.off('on-battery',powerChange);
      await queue;
      await Promise.allSettled([adapter?.close(),receiver.dispose(),controller.dispose()]);
    }
  };
}
