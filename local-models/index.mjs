import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { openStore } from '../core/store.mjs';
import { validate } from '../core/registry.mjs';
import { scanLocalModels } from './library.mjs';
import { createOllamaControl } from './ollama.mjs';
import {createHardware,defaultConfiguration,configurationSchema,validateConfiguration,launchArguments,observePlacement} from './hardware.mjs';
import {outputPath} from '../model-hub/paths.mjs';
import {recycleModel} from './recycle.mjs';
import {localModelDetails} from './details.mjs';
import {contextTokensSchema} from '../core/controls.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1, maxLength: 300 };
const schemas = { 'localModels.list': object({ providerId: id }), 'localModels.start': object({ modelId: id, providerId: id, model: id, contextTokens:contextTokensSchema }), 'localModels.stop': object({ providerId: id, model: id }) };
schemas['localModels.hardware']=object({});schemas['localModels.configure']=configurationSchema;schemas['localModels.delete']=object({modelId:id},['modelId']);
schemas['localModels.details']=object({modelId:id},['modelId']);
const active = run => ['running', 'waiting_approval'].includes(run.status);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function executablePath(explicit) {
  const candidates = [ ...(explicit?[explicit]:[]),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', 'lib', 'ollama', 'llama-server.exe'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')),
  ];
  for (const candidate of candidates) { try { if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate); } catch { /* Try the next installed executable. */ } }
  return null;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
export async function killOwnedProcess(child) {
  // shortcut: ordinary Stop/close owns cleanup; a Windows Job Object is needed to guarantee cleanup after a hard main-process crash.
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('error', () => { child.kill(); resolve(); }); killer.once('close', resolve); });
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

export async function createLocalModels({ dataDir, runtime, getHubState, emit = () => {}, executable, backendDirectories,hardwareRunner,trashItem,withModelFiles,fetchImpl = fetch, spawnImpl = spawn, killProcess = killOwnedProcess, loadTimeoutMs = 300000, pollMs = 250 }) {
  const store = await openStore(path.join(dataDir, 'local-models'), { version: 1, providerId: null });
  if (store.state.version !== 1 || (store.state.providerId !== null && typeof store.state.providerId !== 'string')) throw new Error('Invalid local-model manager state');
  store.state.configuration ||= structuredClone(defaultConfiguration);validate(store.state.configuration,configurationSchema);
  const executableFile = await executablePath(executable), ollama = createOllamaControl({ runtime, fetchImpl });
  const hardware=createHardware({executable:executableFile,backendDirectories,runner:hardwareRunner});
  let library = { directory: '', models: [], warnings: [] }, processState = { status: 'stopped' }, current, closed = false, starting = false, stopping = false, stopPromise, preparing;
  const lifetime = new AbortController();
  let deleting=false,configuring=false,fileOperation;
  const redact = (value, operation) => String(value).split(operation.key).join('[redacted]');
  const ollamaTransitions = new Map();
  let providers = (await runtime.request('state.get')).providers;
  const unsubscribe = runtime.subscribe?.(event => { if (event.type === 'state') providers = event.state.providers; });
  function ownedConnection(providerId,model){
    const provider=providers.find(item=>item.id===providerId),expected=current?{baseUrl:`${current.baseUrl}/v1`,model:current.alias}:store.state.connection;
    return !!expected&&provider?.kind==='openai'&&provider.baseUrl===expected.baseUrl&&model===expected.model;
  }
  function endpoint(providerId, configurations = providers) {
    const provider = configurations.find(item => item.id === providerId);
    if (provider?.kind !== 'ollama') return providerId;
    try { const url = new URL(provider.baseUrl); const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname; return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}${url.pathname.replace(/\/+$/, '')}`; }
    catch { return providerId; }
  }
  const modelKey = (providerId, model, configurations) => `${endpoint(providerId, configurations)}\n${model.includes(':') ? model : `${model}:latest`}`;
  const snapshot = () => structuredClone({ ...library, configuration:store.state.configuration, installed: [], loaded: [], managedProviderId: store.state.providerId,
    runtime: { available: !!executableFile, ...(!executableFile ? { reason: 'llama-server is not installed. Install Ollama or put llama-server on PATH, then restart Faber.' } : {}) }, process: processState });
  function publish() { try { emit({ type: 'localModels', state: snapshot() }); } catch { /* Detached UI does not own the process. */ } }
  async function scan() { const hub = await getHubState(); library = await scanLocalModels({ directory: hub.downloadDirectory, downloads: hub.downloads }); return library; }
  const hardwareState=async signal=>({...await hardware.inspect(signal),configuration:structuredClone(store.state.configuration),observed:processState.observed||null});
  const controlOnly = (run, callerRunId) => run.id === callerRunId && Array.isArray(run.modelCalls) && run.modelCalls.length === 0;
  async function ensureIdle(callerRunId) {
    const state = await runtime.request('state.get');
    if (store.state.providerId && state.runs.some(run => active(run) && run.providerId === store.state.providerId && !controlOnly(run, callerRunId))) throw new Error('Stop chats using the downloaded local model before stopping or replacing it.');
  }
  async function dispose(operation) {
    operation.controller.abort(new Error('Local model stopped'));
    operation.originSignal?.removeEventListener('abort', operation.abortOrigin);
    await killProcess(operation.child);
    if (operation.child) {
      let timer;
      try { await Promise.race([operation.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned local model process did not exit; stop was not confirmed')), 10000); })]); }
      finally { clearTimeout(timer); }
    }
    await fs.rm(operation.keyFile, { force: true });
  }
  async function ready(operation, model) {
    try {
      const signal = operation.controller.signal, started = Date.now();
      while (true) {
        signal.throwIfAborted();
        if (operation.didExit) throw new Error(operation.spawnError || `Local model process exited before loading. ${operation.logs}`);
        if (Date.now() - started >= loadTimeoutMs) throw new Error(`Local model loading timed out. ${operation.logs}`);
        try {
          const response = await fetchImpl(`${operation.baseUrl}/health`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
          if (response.ok) {
            const listed = await fetchImpl(`${operation.baseUrl}/v1/models`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]), headers: { Authorization: `Bearer ${operation.key}` } });
            if (listed.ok && (await listed.json()).data?.some(item => item.id === operation.alias)) break;
          }
        } catch (error) { if (signal.aborted) throw error; }
        await pause(pollMs);
      }
      signal.throwIfAborted();
      if (current !== operation || operation.didExit) throw new Error('Local model process changed during startup');
      let contextCapacityTokens=null,thinkingSupported=false;
      try {
        const response=await fetchImpl(`${operation.baseUrl}/props`,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(1500)]),headers:{Authorization:`Bearer ${operation.key}`}});
        if(response.ok){
          let size=0;const chunks=[];
          for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw new Error('Runtime properties exceed inspection limit');chunks.push(chunk);}
          const properties=JSON.parse(Buffer.concat(chunks).toString('utf8')),value=properties.default_generation_settings?.n_ctx;
          if(Number.isSafeInteger(value)&&value>0)contextCapacityTokens=value;
          const template=typeof properties.chat_template==='string'?properties.chat_template.replace(/\{#[\s\S]*?#\}/g,''):'';
          // Template-declared parameter support; the model still determines how it responds.
          thinkingSupported=/\{%[^%]*\benable_thinking\b[^%]*%\}|\{\{[^}]*\benable_thinking\b[^}]*\}\}/.test(template);
        }else await response.body?.cancel();
      }catch(error){signal.throwIfAborted();}
      if(contextCapacityTokens===null){const match=[...(operation.placementLogs+operation.logTails.join('\n')).matchAll(/n_ctx_slot\s*=\s*(\d+)/g)].at(-1);const value=Number(match?.[1]);if(Number.isSafeInteger(value)&&value>0)contextCapacityTokens=value;}
      if(operation.contextTokens!==null&&contextCapacityTokens!==operation.contextTokens)throw new Error(`Requested ${operation.contextTokens} context tokens, but the runtime reported ${contextCapacityTokens??'no verified capacity'}. The model was stopped; choose a supported context size and start again.`);
      signal.throwIfAborted();
      if(current!==operation||operation.didExit)throw new Error('Local model process changed during context inspection');
      const observed=observePlacement(operation.placementLogs+operation.logTails.join('\n'));
      if(operation.requested.mode==='custom'&&(!observed.verified||!observed.gpuLayers||operation.requested.gpuIds.some(id=>!observed.devices.includes(id))))throw new Error('Selected GPU placement could not be confirmed. The model was stopped instead of silently falling back; inspect runtime compatibility or choose Automatic/CPU mode.');
      const providerId = store.state.providerId || randomUUID();
      if (!store.state.providerId) { store.state.providerId = providerId; await store.save(store.state); }
      signal.throwIfAborted();
      const saved=await runtime.request('provider.save', { id: providerId, name: 'Downloaded GGUF (local)', kind: 'openai', baseUrl: `${operation.baseUrl}/v1`, model: operation.alias, apiKey: operation.key });
      providers=[...providers.filter(provider=>provider.id!==providerId),saved];
      store.state.connection={baseUrl:`${operation.baseUrl}/v1`,model:operation.alias,thinkingSupported};await store.save(store.state);
      signal.throwIfAborted();
      operation.originSignal?.removeEventListener('abort', operation.abortOrigin);
      processState = { status: 'ready', operationId: operation.id, modelId: model.id, providerId, model: operation.alias, stage: 'Loaded and ready',requested:operation.requested,observed,contextTokens:operation.contextTokens,contextCapacityTokens,thinkingSupported }; publish();
    } catch (error) {
      if (current !== operation) return;
      const stopped = operation.controller.signal.aborted;
      try { await dispose(operation); } catch (cleanupError) {
        processState = { status: 'failed', operationId: operation.id, modelId: model.id, error: redact(`Could not release local runtime: ${cleanupError.message}`, operation) }; publish(); return;
      }
      if (current !== operation) return;
      current = undefined;
      processState = { status: stopped ? 'stopped' : 'failed', operationId: operation.id, modelId: model.id, stage: stopped ? 'Stopped' : 'Unable to load', ...(!stopped ? { error: redact(error.message, operation).slice(-5000) } : {}) }; publish();
    }
  }
  async function startFile(modelId, originSignal, callerRunId, contextTokens=null) {
    if (closed) throw new Error('Local model manager is closed');
    if (!executableFile) throw new Error(snapshot().runtime.reason);
    if (starting || stopping || current ||deleting||configuring|| ['loading', 'stopping'].includes(processState.status)) throw new Error('Stop the current local model and finish pending file/settings actions before starting another.');
    starting = true;
    originSignal = originSignal ? AbortSignal.any([originSignal, lifetime.signal]) : lifetime.signal;
    let prepared; preparing = new Promise(resolve => { prepared = resolve; });
    try {
      originSignal?.throwIfAborted(); await ensureIdle(callerRunId); await scan(); originSignal?.throwIfAborted();
      const model = library.models.find(item => item.id === modelId);
      if (!model) throw new Error('Model files changed or left the configured folder. Refresh the local model list.');
      if (!model.available || model.format !== 'gguf') throw new Error(model.reason || 'Only complete GGUF models can start in this runtime');
      const detected=await hardware.inspect(originSignal),requested=structuredClone(store.state.configuration),hardwareArgs=launchArguments(requested,detected);
      if(contextTokens!==null){
        if(!detected.capabilities.contextSize)throw new Error('This runtime does not support configurable context size; use provider default or update the runtime.');
        // One slot gives each queued request the selected capacity instead of dividing it across slots.
        hardwareArgs.push('--ctx-size',String(contextTokens),'--parallel','1');
      }
      const files=await Promise.all(model.files.map(async relative=>{const target=await outputPath(library.directory,relative);const stat=await fs.lstat(target);return {target,dev:stat.dev,ino:stat.ino};}));
      originSignal.throwIfAborted();
      const operationId = randomUUID(), keyFile = path.join(dataDir, 'local-models', `${operationId}.key`), key = randomBytes(32).toString('hex');
      const port = await freePort(); originSignal?.throwIfAborted();
      try { await fs.writeFile(keyFile, key, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') await fs.rm(keyFile, { force: true }).catch(() => {}); throw error; }
      if (originSignal?.aborted) { await fs.rm(keyFile, { force: true }); originSignal.throwIfAborted(); }
      const operation = { id: operationId, controller: new AbortController(), keyFile, key, alias: `faber-${model.id.slice(0, 16)}`, baseUrl: `http://127.0.0.1:${port}`, logs: '',placementLogs:'',logTails:['',''],requested,files,contextTokens, didExit: false, originSignal };
      current = operation;
      processState = { status: 'loading', operationId, modelId, stage: 'Loading GGUF into local runtime',requested,contextTokens }; publish();
      operation.abortOrigin = () => { operation.controller.abort(originSignal.reason); void Promise.resolve().then(() => stopFile()).catch(() => {}); };
      originSignal?.addEventListener('abort', operation.abortOrigin, { once: true });
      const env = hardware.environment();
      try {
        const child = spawnImpl(executableFile, ['--model', path.join(library.directory, model.relativePath), '--host', '127.0.0.1', '--port', String(port), '--alias', operation.alias, '--api-key-file', keyFile, '--offline', '--no-webui', '--no-mmproj', '--jinja',...hardwareArgs], { cwd: path.dirname(executableFile), env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        operation.child = child;
        operation.exited = new Promise(resolve => {
          child.once('error', error => { operation.spawnError = redact(error.message, operation); operation.didExit = true; resolve(); });
          child.once('close', () => {
            operation.didExit = true; resolve();
            if (current === operation && processState.status === 'ready') {
              processState = { status: 'failed', operationId, modelId, stage: 'Local runtime exited', error: redact(operation.logs, operation).slice(-5000) || 'Local model process exited unexpectedly' }; current = undefined; void fs.rm(keyFile, { force: true }).catch(() => {}); publish();
            }
          });
        });
        for (const [index,stream] of [child.stdout, child.stderr].entries()) stream?.setEncoding('utf8').on('data', chunk => {
          operation.logs = redact(operation.logs + chunk, operation).slice(-8000);
          const lines=(operation.logTails[index]+redact(chunk,operation)).split(/\r?\n/);operation.logTails[index]=lines.pop().slice(-2000);
          for(const line of lines)if(/using device|offloaded\s+\d+\s*\/|n_ctx_slot\s*=/i.test(line))operation.placementLogs=(operation.placementLogs+line+'\n').slice(-16000);
        });
      } catch (error) { operation.spawnError = redact(error.message, operation); operation.didExit = true; }
      operation.loading = ready(operation, model);
      if (originSignal?.aborted) operation.abortOrigin();
      return { ...snapshot(), accepted: true };
    } finally { starting = false; prepared(); preparing = undefined; }
  }
  async function stopFile(force = false, callerRunId) {
    if (stopPromise) return stopPromise;
    if (starting) throw new Error('Local model start is being prepared; retry Stop shortly.');
    stopping = true;
    stopPromise = (async () => {
      if (!force) await ensureIdle(callerRunId);
      const operation = current;
      if (!operation) { processState = { status: 'stopped' }; publish(); return snapshot(); }
      processState = { status: 'stopping', operationId: operation.id, modelId: processState.modelId, stage: 'Releasing local model memory' }; publish();
      // Fence the readiness continuation before awaiting process termination.
      current = undefined;
      try { await dispose(operation); await operation.loading; processState = { status: 'stopped', operationId: operation.id, stage: 'Stopped; model process exited' }; publish(); return snapshot(); }
      catch (error) { current = operation; const safeError = new Error(redact(error.message, operation)); processState = { status: 'failed', operationId: operation.id, error: safeError.message }; publish(); throw safeError; }
    })();
    try { return await stopPromise; } finally { stopping = false; stopPromise = undefined; }
  }
  async function ollamaAction(action, args, signal, callerRunId) {
    const key = modelKey(args.providerId, args.model), existing = ollamaTransitions.get(key);
    if (existing) {
      if (action !== 'stop' || existing.action !== 'start') throw new Error('This Ollama model already has a pending transition');
      existing.controller.abort(new Error('Ollama model start canceled by Stop')); await existing.done.catch(() => {});
      return ollamaAction(action, args, signal, callerRunId);
    }
    const controller = new AbortController(), operation = { action, controller };
    ollamaTransitions.set(key, operation);
    operation.done = (async () => {
      const state = await runtime.request('state.get');
      if (state.runs.some(run => active(run) && modelKey(run.providerId, run.model, state.providers) === key && !controlOnly(run, callerRunId))) throw new Error('Stop chats using this Ollama model before loading or unloading it.');
      return ollama[action](args, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
    })();
    try { const result = await operation.done; publish(); return result; } finally { if (ollamaTransitions.get(key) === operation) ollamaTransitions.delete(key); }
  }
  async function configure(args,signal){
    if(starting||stopping||current||deleting||configuring)throw new Error('Stop the managed model and finish pending actions before changing hardware settings');
    configuring=true;
    try{const detected=await hardware.inspect(signal);validateConfiguration(args,detected);signal.throwIfAborted();store.state.configuration=structuredClone(args);await store.save(store.state);publish();return {...detected,configuration:structuredClone(args),observed:processState.observed||null};}
    finally{configuring=false;}
  }
  async function remove(modelId,signal,callerRunId){
    if(starting||stopping||deleting||configuring)throw new Error('Wait for local model operations to finish before deleting files');
    if(!withModelFiles)throw new Error('Model download coordination is unavailable; deletion is disabled');
    deleting=true;
    fileOperation=(async()=>{
      await ensureIdle(callerRunId);await scan();signal.throwIfAborted();
      const model=library.models.find(item=>item.id===modelId),directory=library.directory;
      if(!model)throw new Error('Model files changed or left the configured folder; refresh before deleting');
      const result=await withModelFiles(directory,model.files,async()=>{
        // Repeat identity discovery inside the reservation: old history is never deletion authority.
        const fresh=await scan();signal.throwIfAborted();
        const selected=fresh.models.find(item=>item.id===modelId);
        if(!selected||fresh.directory!==directory)throw new Error('Model files changed before deletion; refresh the library');
        return recycleModel({directory,model:selected,currentFiles:current?.files,trashItem,signal});
      },signal);
      await scan();publish();return {...snapshot(),...result};
    })();
    try{return await fileOperation;}finally{deleting=false;fileOperation=undefined;}
  }
  async function request(method, args = {}, signal, callerRunId) {
    if (closed) throw new Error('Local model manager is closed');
    if (!Object.hasOwn(schemas,method)) throw new Error('Unknown local model request'); validate(args, schemas[method]);signal=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal; signal.throwIfAborted();
    if(method==='localModels.hardware')return hardwareState(signal);
    if(method==='localModels.configure')return configure(args,signal);
    if(method==='localModels.delete')return remove(args.modelId,signal,callerRunId);
    if(method==='localModels.details'){
      await scan();const model=library.models.find(item=>item.id===args.modelId);if(!model)throw new Error('Model files changed; refresh the library');
      const hub=await getHubState(),details=await localModelDetails({directory:library.directory,model,downloads:hub.downloads,signal});
      await scan();signal.throwIfAborted();if(!library.models.some(item=>item.id===args.modelId))throw new Error('Model files changed during details inspection');return details;
    }
    if (method === 'localModels.list') { await scan(); return { ...snapshot(), ...(args.providerId ? await ollama.list(args.providerId) : {}) }; }
    if (method === 'localModels.start') {
      if (args.modelId && !args.providerId && !args.model) return startFile(args.modelId, signal, callerRunId,args.contextTokens??null);
      if (!args.modelId && args.providerId && args.model) {if(args.contextTokens!=null)throw new Error('Configure Ollama context in the chat; local Start only loads the existing model.');return ollamaAction('start', args, signal, callerRunId);}
      throw new Error('Choose either a folder modelId or an installed providerId and model');
    }
    if (!args.providerId && !args.model) return stopFile(false, callerRunId);
    if (args.providerId && args.model) return ollamaAction('stop', args, signal, callerRunId);
    throw new Error('Choose both providerId and model for an Ollama stop');
  }
  return { request,
    providerControls(providerId,model){
      if(providerId!==store.state.providerId||!ownedConnection(providerId,model))return undefined;
      return {context:{configurable:!!executableFile,mode:'managed',capacityTokens:processState.status==='ready'&&processState.model===model?processState.contextCapacityTokens:null,requiresRestart:true},thinking:{supported:store.state.connection?.thinkingSupported===true,mode:'llama_cpp',effective:null}};
    },
    assertProviderAvailable(providerId, model, options={}) {
      if (providerId === store.state.providerId && (closed || starting || stopping || processState.status !== 'ready' || processState.model !== model)) throw new Error('Start this downloaded local model and wait until it is ready before sending a chat.');
      if(providerId===store.state.providerId&&!ownedConnection(providerId,model))throw new Error('The managed local connection was edited. Stop and start the downloaded model to restore its connection, or use a separate API connection.');
      if(providerId===store.state.providerId&&options.contextTokens!=null&&options.contextTokens!==processState.contextCapacityTokens)throw new Error(`Restart this downloaded local model with the chat's selected ${options.contextTokens}-token context before sending. Current capacity: ${processState.contextCapacityTokens??'unknown'}.`);
      if (ollamaTransitions.has(modelKey(providerId, model))) throw new Error('Wait for this local model to finish loading or stopping before sending a chat.');
    },
    tools: () => [
      {name:'local_model_hardware',description:'Inspect supported local runtime GPUs, logical CPUs, memory, configured defaults and observed placement. Metadata probes only; no model load. Remote API hardware is excluded.',parameters:schemas['localModels.hardware'],permission:'read',execute:(args,ctx)=>request('localModels.hardware',args,ctx.signal)},
      {name:'local_model_details',description:'Read bounded offline GGUF metadata and tensor descriptors for one detected model, with cached download metadata when available. Reports actual predominant encoding and stored tensor parameter counts when complete; estimates and unknowns are explicit. Never loads weights or fetches publisher content.',parameters:schemas['localModels.details'],permission:'read',execute:(args,ctx)=>request('localModels.details',args,ctx.signal)},
      {name:'local_model_configure',description:'Save global hardware defaults for the next managed GGUF Start. Stop the managed model first. Does not change external Ollama or API servers. CPU IDs select logical cores; empty means automatic. Memory mapping is disk-backed paging, not extra VRAM.',parameters:schemas['localModels.configure'],permission:'computer',execute:(args,ctx)=>request('localModels.configure',args,ctx.signal)},
      {name:'local_model_delete',description:'Move only the selected detected model files to the Recycle Bin, including existing shards of incomplete or invalid models. Rejects loaded/in-use or actively downloading files. Never guesses missing shards or deletes repository directories, other variants or external Ollama models.',parameters:schemas['localModels.delete'],permission:'files',execute:(args,ctx)=>request('localModels.delete',args,ctx.signal,ctx.runId)},
      { name: 'local_models_list', description: 'List complete local model files from the configured download folder and optionally installed models in a loopback Ollama connection. Does not load models.', parameters: schemas['localModels.list'], permission: 'read', execute: (args, ctx) => request('localModels.list', args, ctx.signal) },
      { name: 'local_model_start', description: 'Load a selected local GGUF, or an installed loopback Ollama model. Does not download weights or select a chat model. Poll local_models_list for readiness.', parameters: schemas['localModels.start'], permission: 'computer', execute: (args, ctx) => request('localModels.start', args, ctx.signal, ctx.runId) },
      { name: 'local_model_stop', description: 'Unload the owned GGUF process, or a specified installed Ollama model. Stop its active chats first. Does not delete model files.', parameters: schemas['localModels.stop'], permission: 'computer', execute: (args, ctx) => request('localModels.stop', args, ctx.signal, ctx.runId) },
    ],
    async close() { if (closed) return; closed = true; unsubscribe?.(); lifetime.abort(new Error('App shutting down')); await preparing;await fileOperation?.catch(()=>{}); for (const transition of ollamaTransitions.values()) transition.controller.abort(new Error('App shutting down')); await Promise.allSettled([...ollamaTransitions.values()].map(item => item.done)); await stopFile(true); await store.flush(); },
  };
}
