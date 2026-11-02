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

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1, maxLength: 300 };
const schemas = { 'localModels.list': object({ providerId: id }), 'localModels.start': object({ modelId: id, providerId: id, model: id }), 'localModels.stop': object({ providerId: id, model: id }) };
const active = run => ['running', 'waiting_approval'].includes(run.status);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function executablePath(explicit) {
  const candidates = explicit ? [explicit] : [
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

export async function createLocalModels({ dataDir, runtime, getHubState, emit = () => {}, executable, fetchImpl = fetch, spawnImpl = spawn, killProcess = killOwnedProcess, loadTimeoutMs = 300000, pollMs = 250 }) {
  const store = await openStore(path.join(dataDir, 'local-models'), { version: 1, providerId: null });
  if (store.state.version !== 1 || (store.state.providerId !== null && typeof store.state.providerId !== 'string')) throw new Error('Invalid local-model manager state');
  const executableFile = await executablePath(executable), ollama = createOllamaControl({ runtime, fetchImpl });
  let library = { directory: '', models: [], warnings: [] }, processState = { status: 'stopped' }, current, closed = false, starting = false, stopping = false, stopPromise, preparing;
  const lifetime = new AbortController();
  const redact = (value, operation) => String(value).split(operation.key).join('[redacted]');
  const ollamaTransitions = new Map();
  let providers = (await runtime.request('state.get')).providers;
  const unsubscribe = runtime.subscribe?.(event => { if (event.type === 'state') providers = event.state.providers; });
  function endpoint(providerId, configurations = providers) {
    const provider = configurations.find(item => item.id === providerId);
    if (provider?.kind !== 'ollama') return providerId;
    try { const url = new URL(provider.baseUrl); const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname; return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}${url.pathname.replace(/\/+$/, '')}`; }
    catch { return providerId; }
  }
  const modelKey = (providerId, model, configurations) => `${endpoint(providerId, configurations)}\n${model.includes(':') ? model : `${model}:latest`}`;
  const snapshot = () => structuredClone({ ...library, installed: [], loaded: [], managedProviderId: store.state.providerId,
    runtime: { available: !!executableFile, ...(!executableFile ? { reason: 'llama-server is not installed. Install Ollama or put llama-server on PATH, then restart Sophia.' } : {}) }, process: processState });
  function publish() { try { emit({ type: 'localModels', state: snapshot() }); } catch { /* Detached UI does not own the process. */ } }
  async function scan() { const hub = await getHubState(); library = await scanLocalModels({ directory: hub.downloadDirectory, downloads: hub.downloads }); return library; }
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
      const providerId = store.state.providerId || randomUUID();
      if (!store.state.providerId) { store.state.providerId = providerId; await store.save(store.state); }
      signal.throwIfAborted();
      await runtime.request('provider.save', { id: providerId, name: 'Downloaded GGUF (local)', kind: 'openai', baseUrl: `${operation.baseUrl}/v1`, model: operation.alias, apiKey: operation.key });
      signal.throwIfAborted();
      operation.originSignal?.removeEventListener('abort', operation.abortOrigin);
      processState = { status: 'ready', operationId: operation.id, modelId: model.id, providerId, model: operation.alias, stage: 'Loaded and ready' }; publish();
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
  async function startFile(modelId, originSignal, callerRunId) {
    if (closed) throw new Error('Local model manager is closed');
    if (!executableFile) throw new Error(snapshot().runtime.reason);
    if (starting || stopping || current || ['loading', 'stopping'].includes(processState.status)) throw new Error('Stop the current local model before starting another.');
    starting = true;
    originSignal = originSignal ? AbortSignal.any([originSignal, lifetime.signal]) : lifetime.signal;
    let prepared; preparing = new Promise(resolve => { prepared = resolve; });
    try {
      originSignal?.throwIfAborted(); await ensureIdle(callerRunId); await scan(); originSignal?.throwIfAborted();
      const model = library.models.find(item => item.id === modelId);
      if (!model) throw new Error('Model files changed or left the configured folder. Refresh the local model list.');
      if (!model.available || model.format !== 'gguf') throw new Error(model.reason || 'Only complete GGUF models can start in this runtime');
      const operationId = randomUUID(), keyFile = path.join(dataDir, 'local-models', `${operationId}.key`), key = randomBytes(32).toString('hex');
      const port = await freePort(); originSignal?.throwIfAborted();
      try { await fs.writeFile(keyFile, key, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') await fs.rm(keyFile, { force: true }).catch(() => {}); throw error; }
      if (originSignal?.aborted) { await fs.rm(keyFile, { force: true }); originSignal.throwIfAborted(); }
      const operation = { id: operationId, controller: new AbortController(), keyFile, key, alias: `sophia-${model.id.slice(0, 16)}`, baseUrl: `http://127.0.0.1:${port}`, logs: '', didExit: false, originSignal };
      current = operation;
      processState = { status: 'loading', operationId, modelId, stage: 'Loading GGUF into local runtime' }; publish();
      operation.abortOrigin = () => { operation.controller.abort(originSignal.reason); void Promise.resolve().then(() => stopFile()).catch(() => {}); };
      originSignal?.addEventListener('abort', operation.abortOrigin, { once: true });
      const env = { ...process.env };
      for (const name of Object.keys(env)) if (/^(LLAMA_|HF_TOKEN$|HUGGING_FACE_HUB_TOKEN$)/i.test(name)) delete env[name];
      try {
        const child = spawnImpl(executableFile, ['--model', path.join(library.directory, model.relativePath), '--host', '127.0.0.1', '--port', String(port), '--alias', operation.alias, '--api-key-file', keyFile, '--offline', '--no-webui', '--no-mmproj', '--jinja'], { cwd: path.dirname(executableFile), env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
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
        for (const stream of [child.stdout, child.stderr]) stream?.setEncoding('utf8').on('data', chunk => { operation.logs = redact(operation.logs + chunk, operation).slice(-8000); });
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
  async function request(method, args = {}, signal, callerRunId) {
    if (closed) throw new Error('Local model manager is closed');
    if (!schemas[method]) throw new Error('Unknown local model request'); validate(args, schemas[method]); signal?.throwIfAborted();
    if (method === 'localModels.list') { await scan(); return { ...snapshot(), ...(args.providerId ? await ollama.list(args.providerId) : {}) }; }
    if (method === 'localModels.start') {
      if (args.modelId && !args.providerId && !args.model) return startFile(args.modelId, signal, callerRunId);
      if (!args.modelId && args.providerId && args.model) return ollamaAction('start', args, signal, callerRunId);
      throw new Error('Choose either a folder modelId or an installed providerId and model');
    }
    if (!args.providerId && !args.model) return stopFile(false, callerRunId);
    if (args.providerId && args.model) return ollamaAction('stop', args, signal, callerRunId);
    throw new Error('Choose both providerId and model for an Ollama stop');
  }
  return { request,
    assertProviderAvailable(providerId, model) {
      if (providerId === store.state.providerId && (closed || starting || stopping || processState.status !== 'ready' || processState.model !== model)) throw new Error('Start this downloaded local model and wait until it is ready before sending a chat.');
      if (ollamaTransitions.has(modelKey(providerId, model))) throw new Error('Wait for this local model to finish loading or stopping before sending a chat.');
    },
    tools: () => [
      { name: 'local_models_list', description: 'List complete local model files from the configured download folder and optionally installed models in a loopback Ollama connection. Does not load models.', parameters: schemas['localModels.list'], permission: 'read', execute: (args, ctx) => request('localModels.list', args, ctx.signal) },
      { name: 'local_model_start', description: 'Load a selected local GGUF, or an installed loopback Ollama model. Does not download weights or select a chat model. Poll local_models_list for readiness.', parameters: schemas['localModels.start'], permission: 'computer', execute: (args, ctx) => request('localModels.start', args, ctx.signal, ctx.runId) },
      { name: 'local_model_stop', description: 'Unload the owned GGUF process, or a specified installed Ollama model. Stop its active chats first. Does not delete model files.', parameters: schemas['localModels.stop'], permission: 'computer', execute: (args, ctx) => request('localModels.stop', args, ctx.signal, ctx.runId) },
    ],
    async close() { if (closed) return; closed = true; unsubscribe?.(); lifetime.abort(new Error('App shutting down')); await preparing; for (const transition of ollamaTransitions.values()) transition.controller.abort(new Error('App shutting down')); await Promise.allSettled([...ollamaTransitions.values()].map(item => item.done)); await stopFile(true); await store.flush(); },
  };
}
