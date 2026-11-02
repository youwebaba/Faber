// Explicit opt-in: load an existing local weight file, never infer or download.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createRuntime } from '../core/runtime.mjs';
import { createLocalModels } from '../local-models/index.mjs';

if (!process.argv.includes('--allow-existing-local-load')) throw new Error('Requires --allow-existing-local-load; allocates GPU/RAM until Stop.');
const original = 'C:\\Users\\youwe\\.ollama\\models\\blobs\\sha256-6aa74acf170f8fb8e6ff8dae9bc9ea918d3a14b6ba95d0b0287da31b09a4848c';
const before = await fs.stat(original); assert.equal(before.size, 3825807040);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'SophiaHarness-local-live-')), directory = path.join(root, 'models');
await fs.mkdir(directory); const linked = path.join(directory, 'fixture.gguf'); await fs.link(original, linked);
const secrets = new Map(), children = []; let manager, runtime;
const started = Date.now();
try {
  const sourceDir = path.join(root, 'source'); await fs.mkdir(sourceDir);
  runtime = await createRuntime({ dataDir: path.join(root, 'data'), sourceDir, host: {
    getSecret: async id => secrets.get(id) || '', setSecret: async (id, value) => { secrets.set(id, value); },
    assertProviderAvailable: (providerId, model) => manager?.assertProviderAvailable(providerId, model),
  } });
  manager = await createLocalModels({ dataDir: path.join(root, 'data'), runtime, getHubState: async () => ({ downloadDirectory: directory, downloads: [] }), loadTimeoutMs: 180000,
    spawnImpl: (executable, args, options) => { const child = spawn(executable, args, options); children.push(child); return child; },
  });
  const listed = await manager.request('localModels.list'); assert.equal(listed.models.length, 1); assert.equal(listed.models[0].available, true); assert.equal(listed.runtime.available, true);
  await manager.request('localModels.start', { modelId: listed.models[0].id });
  let current;
  while (Date.now() - started < 195000) {
    current = await manager.request('localModels.list');
    if (current.process.status === 'ready') break;
    if (current.process.status === 'failed') throw new Error(current.process.error);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(current.process.status, 'ready'); const loadElapsedMs = Date.now() - started;
  const tested = await runtime.request('provider.test', { id: current.process.providerId });
  assert.ok(tested.models.some(item => (typeof item === 'string' ? item : item.id) === current.process.model));
  const stopped = await manager.request('localModels.stop'); assert.equal(stopped.process.status, 'stopped');
  assert.ok(children.length === 1 && children.every(child => child.exitCode !== null || child.signalCode));
  assert.ok(!(await fs.readdir(path.join(root, 'data', 'local-models'))).some(name => name.endsWith('.key')));
  const after = await fs.stat(original); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ino, before.ino);
  const report = { ok: true, sourceModel: 'llama2-uncensored:7b (existing Ollama weight)', sourceBytes: before.size, hardLinkOnly: true, loadElapsedMs, ready: true, authenticatedModelListing: true, stoppedAndExited: true, privateKeyFileRemoved: true, inferenceRequests: 0, downloadedBytes: 0 };
  const reportPath = path.join(root, 'report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, reportPath }));
} finally {
  try { await runtime?.close(); }
  finally { try { await manager?.close(); } finally { secrets.clear(); await fs.rm(linked, { force: true }); } }
}
