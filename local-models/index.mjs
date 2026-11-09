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
import {createSafetensorsRuntime} from './safetensors-runtime.mjs';
import {savedNativeQuantization,resolveNativeQuantization,quantizationSchema} from './quantization.mjs';
import {nativeFit} from './fit.mjs';
import {processMemory} from './observations.mjs';
import {speculationSchema,savedSpeculation,resolveSpeculation,prepareSpeculation,inspectSpeculation,speculationTiming} from './speculation.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1, maxLength: 300 };
const schemas = { 'localModels.list': object({ providerId: id }), 'localModels.start': object({ modelId: id, providerId: id, model: id, contextTokens:contextTokensSchema,quantization:quantizationSchema,speculation:speculationSchema }), 'localModels.stop': object({ providerId: id, model: id }) };
schemas['localModels.hardware']=object({});schemas['localModels.configure']=configurationSchema;schemas['localModels.delete']=object({modelId:id},['modelId']);
schemas['localModels.details']=object({modelId:id,quantization:quantizationSchema},['modelId']);
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

export async function createLocalModels({ dataDir, runtime, getHubState, emit = () => {}, executable, safetensorsExecutable, safetensorsVerify, backendDirectories,hardwareRunner,speculationReader,trashItem,withModelFiles,fetchImpl = fetch, spawnImpl = spawn, killProcess = killOwnedProcess, loadTimeoutMs = 300000, pollMs = 250 }) {
  const store = await openStore(path.join(dataDir, 'local-models'), { version: 1, providerId: null });
  if (store.state.version !== 1 || (store.state.providerId !== null && typeof store.state.providerId !== 'string')) throw new Error('Invalid local-model manager state');
  store.state.configuration ||= structuredClone(defaultConfiguration);validate(store.state.configuration,configurationSchema);
  store.state.loadProfiles||={};if(typeof store.state.loadProfiles!=='object'||Array.isArray(store.state.loadProfiles))throw new Error('Invalid native load profiles');
  store.state.precisionProfiles||={};if(typeof store.state.precisionProfiles!=='object'||Array.isArray(store.state.precisionProfiles))throw new Error('Invalid native precision records');
  store.state.speculationProfiles||={};if(typeof store.state.speculationProfiles!=='object'||Array.isArray(store.state.speculationProfiles))throw new Error('Invalid speculation profiles');
  const executableFile = await executablePath(executable), ollama = createOllamaControl({ runtime, fetchImpl });
  const safetensors = await createSafetensorsRuntime({dataDir,executable:safetensorsExecutable,fetchImpl,verifyImpl:safetensorsVerify});
  const hardware=createHardware({executable:executableFile,backendDirectories,runner:hardwareRunner});
  let library = { directory: '', models: [], warnings: [] }, processState = { status: 'stopped' }, current, closed = false, starting = false, stopping = false, stopPromise, preparing;
  const lifetime = new AbortController();
  let deleting=false,configuring=false,fileOperation,preparationController,speculationProbe;const speculationCache=new Map();
  const redact = (value, operation) => String(value).split(operation.key).join('[redacted]');
  const ollamaTransitions = new Map();
  let providers = (await runtime.request('state.get')).providers;
  const unsubscribe = runtime.subscribe?.(event => { if (event.type === 'state') providers = event.state.providers; });
  function ownedConnection(providerId,model){
    const provider=providers.find(item=>item.id===providerId),expected=current?{baseUrl:`${current.baseUrl}/v1`,model:current.alias}:store.state.connection;
    return !!expected&&provider?.kind==='openai'&&provider.baseUrl===expected.baseUrl&&model===expected.model;
  }
  function modelLabel(providerId,model){
    if(providerId!==store.state.providerId||!ownedConnection(providerId,model)||providers.find(provider=>provider.id===providerId)?.model!==model)return null;
    const matches=library.models.filter(item=>`faber-${item.id.slice(0,16)}`===model);
    const connection=store.state.connection?.model===model?store.state.connection:null,scanned=matches.length===1?matches[0]:null;
    const displayName=typeof connection?.displayName==='string'&&connection.displayName.trim()?connection.displayName:scanned?.label;
    const modelId=typeof connection?.modelId==='string'&&`faber-${connection.modelId.slice(0,16)}`===model?connection.modelId:scanned?.id;
    return displayName?{providerId,model,displayName,...(modelId?{modelId}:{})}:null;
  }
  function endpoint(providerId, configurations = providers) {
    const provider = configurations.find(item => item.id === providerId);
    if (provider?.kind !== 'ollama') return providerId;
    try { const url = new URL(provider.baseUrl); const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname; return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}${url.pathname.replace(/\/+$/, '')}`; }
    catch { return providerId; }
  }
  const modelKey = (providerId, model, configurations) => `${endpoint(providerId, configurations)}\n${model.includes(':') ? model : `${model}:latest`}`;
  const snapshot = () => {
    const providerId=store.state.providerId,label=modelLabel(providerId,store.state.connection?.model);
    return structuredClone({ ...library, modelLabels:label?[label]:[], configuration:store.state.configuration, installed: [], loaded: [], managedProviderId: providerId,
      runtime: { available: !!executableFile, safetensors:safetensors.status, ...(!executableFile ? { reason: 'llama-server is not installed. Install Ollama or put llama-server on PATH, then restart Faber.' } : {}) }, process: processState });
  };
  function publish() { try { emit({ type: 'localModels', state: snapshot() }); } catch { /* Detached UI does not own the process. */ } }
  async function scan() { const hub = await getHubState(),scanned=await scanLocalModels({ directory: hub.downloadDirectory, downloads: hub.downloads });scanned.models=await Promise.all(scanned.models.map(async model=>({...model,...(model.format==='safetensors'?{...await safetensors.describe(scanned.directory,model),...savedNativeQuantization(store.state.loadProfiles[model.id]),effectivePrecision:store.state.precisionProfiles[model.id]}:{}),...savedSpeculation(store.state.speculationProfiles[model.id])})));library=scanned;return library; }
  async function speculationInfo(model,signal){if(speculationCache.has(model.id))return structuredClone(speculationCache.get(model.id));let capabilities={};if(model.format==='gguf'&&executableFile){speculationProbe||=hardware.inspect(signal).then(value=>value.speculation).catch(error=>{speculationProbe=undefined;throw error;});capabilities=await speculationProbe;}const info=await inspectSpeculation({directory:library.directory,model,capabilities,signal,reader:speculationReader});speculationCache.set(model.id,info);return structuredClone(info);}
  const hardwareState=async signal=>({...await hardware.inspect(signal),configuration:structuredClone(store.state.configuration),observed:processState.observed||null});
  const controlOnly = (run, callerRunId) => run.id === callerRunId && Array.isArray(run.modelCalls) && run.modelCalls.length === 0;
  async function ensureIdle(callerRunId) {
    const state = await runtime.request('state.get');
    if (store.state.providerId && state.runs.some(run => active(run) && run.providerId === store.state.providerId && !controlOnly(run, callerRunId))) throw new Error('Stop chats using the downloaded local model before stopping or replacing it.');
  }
  async function dispose(operation) {
    clearTimeout(operation.statsTimer);
    operation.controller.abort(new Error('Local model stopped'));
    operation.originSignal?.removeEventListener('abort', operation.abortOrigin);
    await killProcess(operation.child);
    if (operation.child) {
      let timer;
      try { await Promise.race([operation.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned local model process did not exit; stop was not confirmed')), 10000); })]); }
      finally { clearTimeout(timer); }
    }
    await operation.native?.close();
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
          const response = await fetchImpl(`${operation.baseUrl}/health`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),headers:{Authorization:`Bearer ${operation.key}`} });
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
      const nativeObservation=operation.native?.observed();
      const observed=operation.native?{backend:'cpu',gpuLayers:0,totalLayers:null,devices:[],verified:true,quantization:nativeObservation.quantization,precision:nativeObservation.precision,memory:await processMemory(operation.child?.pid)}:observePlacement(operation.placementLogs+operation.logTails.join('\n'));
      let speculationObserved={mode:'off',tokens:0,verified:true};
      if(operation.speculation.mode!=='off'){
        if(operation.speculationFailure)throw new Error(operation.speculationFailure);
        const kind=operation.speculation.mode==='native_mtp'?'draft-mtp':'draft-simple';
        const types=[...operation.speculationLogs.matchAll(/adding speculative implementation ['"]([^'"]+)['"]/g)].map(match=>match[1]);
        const max=Number([...operation.speculationLogs.matchAll(/- n_max=(\d+),/g)].at(-1)?.[1]);
        const response=await fetchImpl(`${operation.baseUrl}/slots`,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(2000)]),headers:{Authorization:`Bearer ${operation.key}`}});
        if(!response.ok)throw new Error('Speculative slot monitoring is unavailable; the model was stopped.');
        let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw new Error('Runtime speculative slots exceed inspection limit');chunks.push(chunk);}const slots=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(slots)||!slots.length||slots.some(slot=>slot.speculative!==true)||!types.includes(kind)||max!==operation.speculation.tokens)throw new Error('The runtime did not confirm the selected speculative implementation and token count; the model was stopped.');
        speculationObserved={mode:operation.speculation.mode,implementation:kind,tokens:max,verified:true,vocabularyVerified:operation.speculation.mode==='draft_model',draft:operation.speculationPlan.draft||null,metrics:operation.speculationMetrics||null};
      }
      observed.speculation=speculationObserved;if(!operation.native)observed.memory=await processMemory(operation.child?.pid);
      if(operation.requested.mode==='custom'&&(!observed.verified||!observed.gpuLayers||operation.requested.gpuIds.some(id=>!observed.devices.includes(id))))throw new Error('Selected GPU placement could not be confirmed. The model was stopped instead of silently falling back; inspect runtime compatibility or choose Automatic/CPU mode.');
      const providerId = store.state.providerId || randomUUID();
      if (!store.state.providerId) { store.state.providerId = providerId; await store.save(store.state); }
      signal.throwIfAborted();
      const saved=await runtime.request('provider.save', { id: providerId, name: operation.native?'Downloaded Safetensors (CPU)':'Downloaded GGUF (local)', kind: 'openai', baseUrl: `${operation.baseUrl}/v1`, model: operation.alias, apiKey: operation.key });
      providers=[...providers.filter(provider=>provider.id!==providerId),saved];
      if(operation.native)store.state.loadProfiles[model.id]=operation.quantization;
      store.state.speculationProfiles[model.id]=operation.speculation;
      if(operation.native)store.state.precisionProfiles[model.id]={quantization:operation.quantization,precision:nativeObservation.precision,payloadId:nativeObservation.payloadId,checkedAt:new Date().toISOString()};
      store.state.connection={baseUrl:`${operation.baseUrl}/v1`,model:operation.alias,displayName:model.label,modelId:model.id,thinkingSupported,format:model.format};await store.save(store.state);
      signal.throwIfAborted();
      operation.originSignal?.removeEventListener('abort', operation.abortOrigin);
      processState = { status: 'ready', operationId: operation.id, modelId: model.id, providerId, model: operation.alias, stage: 'Loaded and ready',requested:operation.requested,observed,speculation:operation.speculation,...(operation.native?{quantization:operation.quantization}:{}),contextTokens:operation.contextTokens,contextCapacityTokens,thinkingSupported }; publish();
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
  async function startFile(modelId, originSignal, callerRunId, contextTokens=null,quantization,speculation) {
    if (closed) throw new Error('Local model manager is closed');
    if (starting || stopping || current ||deleting||configuring|| ['loading', 'stopping'].includes(processState.status)) throw new Error('Stop the current local model and finish pending file/settings actions before starting another.');
    starting = true;
    preparationController=new AbortController();originSignal=AbortSignal.any([...(originSignal?[originSignal]:[]),lifetime.signal,preparationController.signal]);
    let prepared; preparing = new Promise(resolve => { prepared = resolve; });
    try {
      originSignal?.throwIfAborted(); await ensureIdle(callerRunId); await scan(); originSignal?.throwIfAborted();
      const model = library.models.find(item => item.id === modelId);
      if (!model) throw new Error('Model files changed or left the configured folder. Refresh the local model list.');
      if (!model.available || !['gguf','safetensors'].includes(model.format)) throw new Error(model.reason || 'Choose a complete model supported by this runtime');
      const nativeSafe=model.format==='safetensors';
      speculation=resolveSpeculation(speculation,store.state.speculationProfiles[model.id]);
      if(!nativeSafe&&quantization!==undefined)throw new Error('On-load quantization applies to original Safetensors packages only. Choose a published GGUF encoding or its existing runtime controls.');
      if(nativeSafe)quantization=resolveNativeQuantization(quantization,store.state.loadProfiles[model.id]);
      if(!nativeSafe&&!executableFile)throw new Error(snapshot().runtime.reason);
      const detected=nativeSafe?null:await hardware.inspect(originSignal),requested=structuredClone(store.state.configuration),hardwareArgs=nativeSafe?[]:launchArguments(requested,detected);
      const speculationPlan=await prepareSpeculation({directory:library.directory,model,models:library.models,profile:speculation,capabilities:detected?.speculation,configuration:requested,signal:originSignal,reader:speculationReader});
      if(speculation.mode!=='off'){await scan();if(!library.models.some(item=>item.id===model.id)||speculationPlan.draft&&!library.models.some(item=>item.id===speculationPlan.draft.id))throw new Error('Target or draft files changed during validation; refresh the library');}
      hardwareArgs.push(...speculationPlan.args);
      if(contextTokens!==null){
        if(nativeSafe)throw new Error('This native Safetensors CPU loader currently supports Default context only. Select Default and start again.');
        if(!detected.capabilities.contextSize)throw new Error('This runtime does not support configurable context size; use provider default or update the runtime.');
        // One slot gives each queued request the selected capacity instead of dividing it across slots.
        hardwareArgs.push('--ctx-size',String(contextTokens),'--parallel','1');
      }
      const files=await Promise.all([...model.files,...speculationPlan.draftFiles,...(nativeSafe?model.supportFiles||[]:[])].map(async relative=>{const target=await outputPath(library.directory,relative);const stat=await fs.lstat(target);return {target,dev:stat.dev,ino:stat.ino};}));
      originSignal.throwIfAborted();
      const operationId = randomUUID(), keyFile = path.join(dataDir, 'local-models', `${operationId}.key`), key = randomBytes(32).toString('hex');
      const port = nativeSafe?null:await freePort(); originSignal?.throwIfAborted();
      try { await fs.writeFile(keyFile, key, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') await fs.rm(keyFile, { force: true }).catch(() => {}); throw error; }
      if (originSignal?.aborted) { await fs.rm(keyFile, { force: true }); originSignal.throwIfAborted(); }
      const operation = { id: operationId, controller: new AbortController(), keyFile, key, alias: `faber-${model.id.slice(0, 16)}`, baseUrl: `http://127.0.0.1:${port}`, logs: '',placementLogs:'',speculationLogs:'',speculation,speculationPlan,logTails:['',''],requested,files,contextTokens,quantization, didExit: false, originSignal };
      current = operation;
      processState = { status: 'loading', operationId, modelId, stage: nativeSafe?'Loading Safetensors on native CPU runtime':'Loading GGUF into local runtime',requested,contextTokens,speculation,...(nativeSafe?{quantization}: {}) }; publish();
      operation.abortOrigin = () => { operation.controller.abort(originSignal.reason); void Promise.resolve().then(() => stopFile()).catch(() => {}); };
      originSignal?.addEventListener('abort', operation.abortOrigin, { once: true });
      const env = nativeSafe?null:hardware.environment();
      try {
        let binary=executableFile,args=['--model', path.join(library.directory, model.relativePath), '--host', '127.0.0.1', '--port', String(port), '--alias', operation.alias, '--api-key-file', keyFile, '--offline', '--no-webui', '--no-mmproj', '--jinja',...hardwareArgs],environment=env;
        if(nativeSafe){operation.native=await safetensors.prepare({directory:library.directory,model,operation,nativePort:port,configuration:requested,contextTokens});binary=operation.native.executable;args=operation.native.args;environment=operation.native.env;operation.baseUrl=operation.native.baseUrl;}
        const child = spawnImpl(binary,args, { cwd: path.dirname(binary), env:environment, windowsHide: true, detached: process.platform !== 'win32', stdio: [nativeSafe?'pipe':'ignore', 'pipe', 'pipe'] });
        operation.child = child;
        operation.exited = new Promise(resolve => {
          child.once('error', error => { operation.spawnError = redact(error.message, operation); operation.didExit = true; resolve(); });
          child.once('close', () => {
            operation.didExit = true; resolve();
            if (current === operation && processState.status === 'ready') {
              processState = { status: 'failed', operationId, modelId, stage: 'Local runtime exited', error: redact(operation.logs, operation).slice(-5000) || 'Local model process exited unexpectedly' }; current = undefined; void operation.native?.close().catch(()=>{});void fs.rm(keyFile, { force: true }).catch(() => {}); publish();
            }
          });
        });
        operation.native?.attach(child);
        for (const [index,stream] of [operation.native?null:child.stdout, child.stderr].entries()) stream?.setEncoding('utf8').on('data', chunk => {
          operation.logs = redact(operation.logs + chunk, operation).slice(-8000);
          const lines=(operation.logTails[index]+redact(chunk,operation)).split(/\r?\n/);operation.logTails[index]=lines.pop().slice(-2000);
          for(const line of lines){if(/using device|offloaded\s+\d+\s*\/|n_ctx_slot\s*=/i.test(line))operation.placementLogs=(operation.placementLogs+line+'\n').slice(-16000);
            if(/spec\s+common_specu.*target and draft vocabs are not compatible/.test(line))operation.speculationFailure='The native runtime rejected incompatible target and draft vocabularies. Choose a compatible draft or Off; this model was stopped.';
            if(/speculative|spec\s+common_specu|n_max=/.test(line))operation.speculationLogs=(operation.speculationLogs+line+'\n').slice(-16000);
            const metrics=speculationTiming(line,operation.speculationMetrics);if(metrics){operation.speculationMetrics=metrics;if(current===operation&&processState.status==='ready'){processState.observed.speculation.metrics=metrics;if(!operation.statsTimer)operation.statsTimer=setTimeout(()=>{operation.statsTimer=null;if(current===operation)publish();},100);}}
          }
        });
      } catch (error) { operation.spawnError = redact(error.message, operation); operation.didExit = true; }
      operation.loading = ready(operation, model);
      if (originSignal?.aborted) operation.abortOrigin();
      return { ...snapshot(), accepted: true };
    } finally { starting = false;preparationController=undefined; prepared(); preparing = undefined; }
  }
  async function stopFile(force = false, callerRunId) {
    if (stopPromise) return stopPromise;
    if (starting) {if(!force)await ensureIdle(callerRunId);stopping=true;try{preparationController?.abort(new Error('Local model Start canceled'));await preparing;}finally{stopping=false;}return stopFile(force,callerRunId);}
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
      if(args.quantization!==undefined&&model.format!=='safetensors')throw new Error('Native fit profiles apply to Safetensors packages only');
      const hub=await getHubState(),details=await localModelDetails({directory:library.directory,model,downloads:hub.downloads,signal});
      const fit=model.format==='safetensors'?(model.quantizationWarning&&args.quantization===undefined?{available:false,reason:model.quantizationWarning}:await nativeFit(library.directory,model,args.quantization)):undefined;
      const speculation=await speculationInfo(model,signal);
      await scan();signal.throwIfAborted();if(!library.models.some(item=>item.id===args.modelId))throw new Error('Model files changed during details inspection');return {...details,speculation,...(fit?{nativeFit:fit}: {})};
    }
    if (method === 'localModels.list') { await scan(); return { ...snapshot(), ...(args.providerId ? await ollama.list(args.providerId) : {}) }; }
    if (method === 'localModels.start') {
      if (args.modelId && !args.providerId && !args.model) return startFile(args.modelId, signal, callerRunId,args.contextTokens??null,args.quantization,args.speculation);
      if (!args.modelId && args.providerId && args.model) {if(args.speculation!==undefined)throw new Error('Speculation controls apply to owned downloaded models; configure other providers separately.');if(args.quantization!==undefined)throw new Error('On-load quantization applies to original Safetensors packages managed by Faber. Configure external Ollama separately.');if(args.contextTokens!=null)throw new Error('Configure Ollama context in the chat; local Start only loads the existing model.');return ollamaAction('start', args, signal, callerRunId);}
      throw new Error('Choose either a folder modelId or an installed providerId and model');
    }
    if (!args.providerId && !args.model) return stopFile(false, callerRunId);
    if (args.providerId && args.model) return ollamaAction('stop', args, signal, callerRunId);
    throw new Error('Choose both providerId and model for an Ollama stop');
  }
  return { request,
    modelDisplayName(providerId,model){return modelLabel(providerId,model)?.displayName??null;},
    providerControls(providerId,model){
      if(providerId!==store.state.providerId||!ownedConnection(providerId,model))return undefined;
      return {context:{configurable:!!executableFile&&store.state.connection?.format!=='safetensors',mode:'managed',capacityTokens:processState.status==='ready'&&processState.model===model?processState.contextCapacityTokens:null,requiresRestart:true},thinking:{supported:store.state.connection?.thinkingSupported===true,mode:'llama_cpp',effective:null}};
    },
    assertProviderAvailable(providerId, model, options={}) {
      if (providerId === store.state.providerId && (closed || starting || stopping || processState.status !== 'ready' || processState.model !== model)) throw new Error('Start this downloaded local model and wait until it is ready before sending a chat.');
      if(providerId===store.state.providerId&&!ownedConnection(providerId,model))throw new Error('The managed local connection was edited. Stop and start the downloaded model to restore its connection, or use a separate API connection.');
      if(providerId===store.state.providerId&&options.contextTokens!=null&&options.contextTokens!==processState.contextCapacityTokens)throw new Error(`Restart this downloaded local model with the chat's selected ${options.contextTokens}-token context before sending. Current capacity: ${processState.contextCapacityTokens??'unknown'}.`);
      if (ollamaTransitions.has(modelKey(providerId, model))) throw new Error('Wait for this local model to finish loading or stopping before sending a chat.');
    },
    tools: () => [
      {name:'local_model_hardware',description:'Inspect supported local runtime GPUs, logical CPUs, memory, configured defaults and observed placement. Metadata probes only; no model load. Remote API hardware is excluded.',parameters:schemas['localModels.hardware'],permission:'read',execute:(args,ctx)=>request('localModels.hardware',args,ctx.signal)},
      {name:'local_model_details',description:'Read bounded offline metadata for one detected model. GGUF reports encoding, parameter counts and separately validated native-MTP/draft capabilities. Safetensors adds native CPU fit estimates for an optional quantization profile, split across VRAM/RAM/disk and weights/context/workspace with headroom. Actual effective precision is reported after verified Start. Never loads weights or fetches publisher content.',parameters:schemas['localModels.details'],permission:'read',execute:(args,ctx)=>request('localModels.details',args,ctx.signal)},
      {name:'local_model_configure',description:'Save global hardware defaults for the next managed GGUF Start. Stop the managed model first. Does not change external Ollama or API servers. CPU IDs select logical cores; empty means automatic. Memory mapping is disk-backed paging, not extra VRAM.',parameters:schemas['localModels.configure'],permission:'computer',execute:(args,ctx)=>request('localModels.configure',args,ctx.signal)},
      {name:'local_model_delete',description:'Move only the selected detected model files to the Recycle Bin, including existing shards of incomplete or invalid models. Rejects loaded/in-use or actively downloading files. Never guesses missing shards or deletes repository directories, other variants or external Ollama models.',parameters:schemas['localModels.delete'],permission:'files',execute:(args,ctx)=>request('localModels.delete',args,ctx.signal,ctx.runId)},
      { name: 'local_models_list', description: 'List complete local model files from the configured download folder and optionally installed models in a loopback Ollama connection. Does not load models.', parameters: schemas['localModels.list'], permission: 'read', execute: (args, ctx) => request('localModels.list', args, ctx.signal) },
      { name: 'local_model_start', description: 'Load a supported complete local GGUF or native CPU Safetensors package, or an installed loopback Ollama model. Native modes none/q4_0/q5_0/q8_0/mixed_q4_q8 use Default context and qualified text architectures. Quantized Start uses temporary disk to verify actual formats, then deletes it. Originals stay unchanged. Speculation defaults to the last successful per-model profile (initially Off); native_mtp requires qualified actual heads, draft_model requires distinct compatible GGUF weights and saved CPU hardware. tokens is 1..16. Poll local_models_list for verified effective speculation, completed-request acceptance counters and precision. Does not download weights or select a chat model.', parameters: schemas['localModels.start'], permission: 'computer', execute: (args, ctx) => request('localModels.start', args, ctx.signal, ctx.runId) },
      { name: 'local_model_stop', description: 'Unload the owned local model process, or a specified installed Ollama model. Stop its active chats first. Does not delete model files.', parameters: schemas['localModels.stop'], permission: 'computer', execute: (args, ctx) => request('localModels.stop', args, ctx.signal, ctx.runId) },
    ],
    async close() { if (closed) return; closed = true; unsubscribe?.(); lifetime.abort(new Error('App shutting down')); await preparing;await fileOperation?.catch(()=>{}); for (const transition of ollamaTransitions.values()) transition.controller.abort(new Error('App shutting down')); await Promise.allSettled([...ollamaTransitions.values()].map(item => item.done)); await stopFile(true); await store.flush(); },
  };
}
