import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createOllamaControl } from '../local-models/ollama.mjs';

const provider = { id: 'local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', hasKey: false };
function setup(overrides = {}) {
  const state = { providers: [{ ...provider }], runs: [] }, calls = [], loaded = new Set();
  let online = true;
  const runtime = { request: async method => { assert.equal(method, 'state.get'); return structuredClone(state); } };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options }); options.signal.throwIfAborted();
    if (!online) throw new Error('fixture offline');
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'fixture:latest', size: 64 }] });
    if (url.endsWith('/api/ps')) return Response.json({ models: [...loaded].map(name => ({ name })) });
    if (url.endsWith('/api/generate')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['keep_alive', 'model', 'stream']);
      assert.equal(body.stream, false); assert.equal(body.model, 'fixture:latest');
      if (body.keep_alive === -1) loaded.add(body.model); else if (body.keep_alive === 0) loaded.delete(body.model); else assert.fail('Unexpected generation request');
      return Response.json({ done: true });
    }
    assert.fail(`Unexpected route: ${url}`);
  };
  const control = createOllamaControl({ runtime, fetchImpl, ...overrides });
  return { state, calls, loaded, runtime, fetchImpl, control, online: value => { online = value; } };
}

test('installed Ollama models load and unload without prompts, downloads or server termination', async () => {
  const fixture = setup({ spawnImpl: () => assert.fail('Online server must not spawn') });
  assert.deepEqual(await fixture.control.list('local'), { installed: [{ id: 'fixture:latest', label: 'fixture:latest', sizeBytes: 64 }], loaded: [], ollama: { online: true } });
  const started = await fixture.control.start({ providerId: 'local', model: 'fixture' });
  assert.deepEqual(started.loaded, ['fixture:latest']); assert.equal(started.model, 'fixture:latest');
  assert.deepEqual((await fixture.control.stop({ providerId: 'local', model: 'fixture:latest' })).loaded, []);
  assert.ok(fixture.calls.every(call => call.options.redirect === 'error'));
  assert.deepEqual(fixture.calls.filter(call => call.url.endsWith('/api/generate')).map(call => JSON.parse(call.options.body).keep_alive), [-1, 0]);
});

test('unknown models and remote/credentialed providers reject before a load request', async () => {
  const fixture = setup();
  await assert.rejects(fixture.control.start({ providerId: 'local', model: 'not-installed' }), /not installed/);
  assert.ok(!fixture.calls.some(call => call.url.endsWith('/api/generate')));
  for (const change of [{ baseUrl: 'https://remote.example' }, { hasKey: true }, { kind: 'openai' }]) {
    Object.assign(fixture.state.providers[0], provider, change);
    const count = fixture.calls.length; await assert.rejects(fixture.control.start({ providerId: 'local', model: 'fixture' })); assert.equal(fixture.calls.length, count);
  }
});

test('offline standard endpoint starts the existing executable hidden then validates installed names', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'sophia-ollama-helper-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'fixture.exe'); await fs.writeFile(executable, 'fixture only, never executed');
  let fixture, starts = 0;
  fixture = setup({ executable, spawnImpl: (file, args, options) => {
    starts++; assert.equal(file, executable); assert.deepEqual(args, ['serve']);
    assert.equal(options.windowsHide, true); assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore'); assert.equal(options.shell, false);
    assert.equal(options.env.OLLAMA_HOST, provider.baseUrl);
    fixture.online(true); const child = new EventEmitter(); child.unref = () => {}; child.kill = () => assert.fail('Do not kill shared server'); return child;
  } });
  fixture.online(false);
  assert.equal((await fixture.control.list('local')).ollama.online, false); assert.equal(starts, 0);
  await fixture.control.start({ providerId: 'local', model: 'fixture' }); assert.equal(starts, 1);
  await fixture.control.stop({ providerId: 'local', model: 'fixture' }); assert.equal(starts, 1);
});

test('offline nonstandard endpoints never spawn; cancellation aborts a pending load', async () => {
  const fixture = setup({ spawnImpl: () => assert.fail('Do not start a server on custom ports') }); fixture.online(false); fixture.state.providers[0].baseUrl = 'http://127.0.0.1:9999';
  await assert.rejects(fixture.control.start({ providerId: 'local', model: 'fixture' }), /standard local/);
  const ready = setup(); let loading;
  const entered = new Promise(resolve => { loading = resolve; });
  const control = createOllamaControl({ runtime: ready.runtime, fetchImpl: (url, options) => {
    if (!url.endsWith('/api/generate')) return ready.fetchImpl(url, options);
    loading(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const abort = new AbortController(), pending = control.start({ providerId: 'local', model: 'fixture' }, abort.signal);
  const rejection = assert.rejects(pending, /test cancellation/); await entered; abort.abort(new Error('test cancellation')); await rejection;
});

test('verification uses actual ps state after load/unload and rechecks changed connections', async () => {
  const fixture = setup(); let generated = false, psAfter = 0;
  const control = createOllamaControl({ runtime: fixture.runtime, fetchImpl: async (url, options) => {
    if (url.endsWith('/api/generate')) generated = true;
    if (url.endsWith('/api/ps') && generated && ++psAfter === 1) return Response.json({ models: [] });
    return fixture.fetchImpl(url, options);
  } });
  assert.deepEqual((await control.start({ providerId: 'local', model: 'fixture' })).loaded, ['fixture:latest']); assert.equal(psAfter, 2);
  const changed = setup();
  const changedControl = createOllamaControl({ runtime: changed.runtime, fetchImpl: async (url, options) => {
    const response = await changed.fetchImpl(url, options); if (url.endsWith('/api/tags')) changed.state.providers[0].baseUrl = 'http://127.0.0.1:9999'; return response;
  } });
  await assert.rejects(changedControl.start({ providerId: 'local', model: 'fixture' }), /connection changed/);
  assert.ok(!changed.calls.some(call => call.url.endsWith('/api/generate')));
  const changedDuringLoad = setup();
  const changedDuringLoadControl = createOllamaControl({ runtime: changedDuringLoad.runtime, fetchImpl: async (url, options) => {
    const response = await changedDuringLoad.fetchImpl(url, options); if (url.endsWith('/api/generate')) changedDuringLoad.state.providers[0].baseUrl = 'http://127.0.0.1:9999'; return response;
  } });
  await assert.rejects(changedDuringLoadControl.start({ providerId: 'local', model: 'fixture' }), /connection changed/);
});
