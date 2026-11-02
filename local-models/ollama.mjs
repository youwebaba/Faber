import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { validateBaseUrl } from '../core/provider.mjs';

const nameOf = model => model?.name || model?.model;

async function readJson(response, signal) {
  if (!response.body) throw new Error('Ollama returned an empty response');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > 4 * 1024 * 1024) throw new Error('Ollama metadata response exceeds 4 MiB');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Ollama returned invalid JSON'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createOllamaControl({ runtime, fetchImpl = fetch, spawnImpl = spawn, executable = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : undefined }) {
  async function configuration(providerId) {
    const state = await runtime.request('state.get');
    const provider = state.providers.find(item => item.id === providerId);
    if (!provider || provider.kind !== 'ollama') throw new Error('Select a native Ollama connection');
    const baseUrl = validateBaseUrl(provider.baseUrl), url = new URL(baseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || provider.hasKey) throw new Error('Local model control requires a loopback Ollama connection without credentials');
    return { provider, baseUrl, url };
  }
  async function request(baseUrl, route, signal, body, timeoutMs = 2500) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${route}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: combined,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw Object.assign(new Error(`Ollama is unreachable: ${deadline.aborted ? 'request timed out' : error.message}`), { code: 'OLLAMA_OFFLINE' });
    }
    const value = await readJson(response, combined);
    if (!response.ok || value.error) throw new Error(`Ollama ${response.status}: ${String(value.error || response.statusText || 'Request failed').slice(0, 800)}`);
    return value;
  }
  function models(value) {
    if (!Array.isArray(value.models) || value.models.length > 10000 || value.models.some(model => typeof nameOf(model) !== 'string' || !nameOf(model))) throw new Error('Ollama returned an invalid model list');
    return value.models;
  }
  async function stateAt(baseUrl, signal) {
    const [tags, ps] = await Promise.all([request(baseUrl, '/api/tags', signal), request(baseUrl, '/api/ps', signal)]);
    return { installed: models(tags).map(model => ({ id: nameOf(model), label: nameOf(model), ...(Number.isSafeInteger(model.size) && model.size >= 0 ? { sizeBytes: model.size } : {}) })), loaded: models(ps).map(nameOf), ollama: { online: true } };
  }
  async function list(providerId) {
    const { baseUrl } = await configuration(providerId);
    try { return await stateAt(baseUrl); }
    catch (error) { return { installed: [], loaded: [], ollama: { online: false, error: error.message } }; }
  }
  async function ensureServer(config, signal) {
    try { return await stateAt(config.baseUrl, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (error.code !== 'OLLAMA_OFFLINE') throw error;
      if (config.url.protocol !== 'http:' || config.url.port !== '11434' || config.url.pathname !== '/') throw new Error('Ollama is offline; automatic server startup is available only at the standard local HTTP port 11434');
    }
    if (!executable || !path.isAbsolute(executable) || !(await fs.stat(executable)).isFile()) throw new Error('Installed Ollama executable was not found; install or start Ollama first');
    signal?.throwIfAborted();
    const child = spawnImpl(executable, ['serve'], { windowsHide: true, detached: true, stdio: 'ignore', shell: false, env: { ...process.env, OLLAMA_HOST: config.baseUrl } });
    let startupError;
    child.once('error', error => { startupError = error; });
    child.once('exit', code => { if (code !== 0) startupError ||= new Error(`Ollama server exited with code ${code}`); });
    child.unref();
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      signal?.throwIfAborted();
      try { return await stateAt(config.baseUrl, signal); } catch (error) {
        signal?.throwIfAborted(); if (startupError) throw new Error(`Could not start Ollama: ${startupError.message}`);
        if (error.code !== 'OLLAMA_OFFLINE') throw error;
      }
      await delay(250, undefined, { signal });
    }
    throw new Error('Ollama did not become available after starting its server');
  }
  async function change({ providerId, model }, loading, signal) {
    if (typeof model !== 'string' || !model.trim() || model.length > 300) throw new Error('Choose an installed Ollama model');
    const config = await configuration(providerId);
    const before = loading ? await ensureServer(config, signal) : await stateAt(config.baseUrl, signal);
    const installed = before.installed.find(item => item.id === model || item.id === `${model}:latest`);
    if (!installed) throw new Error('Model is not installed in Ollama; no download was attempted');
    signal?.throwIfAborted();
    async function unchanged() {
      const current = await configuration(providerId); signal?.throwIfAborted();
      if (current.baseUrl !== config.baseUrl) throw new Error('Ollama connection changed during the operation');
    }
    // The manager serializes lifecycle effects and fences active/new chat runs.
    await unchanged();
    await request(config.baseUrl, '/api/generate', signal, { model: installed.id, keep_alive: loading ? -1 : 0, stream: false }, loading ? 120000 : 30000);
    await unchanged();
    const until = Date.now() + 5000;
    do {
      signal?.throwIfAborted();
      const after = await stateAt(config.baseUrl, signal);
      if (after.loaded.includes(installed.id) === loading) { await unchanged(); return { ...after, providerId, model: installed.id }; }
      await delay(200, undefined, { signal });
    } while (Date.now() < until);
    throw new Error(`Ollama did not confirm that ${installed.id} was ${loading ? 'loaded' : 'unloaded'}`);
  }
  return { list, start: (args, signal) => change(args, true, signal), stop: (args, signal) => change(args, false, signal) };
}
