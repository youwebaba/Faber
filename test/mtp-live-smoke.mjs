// Opt-in: downloads one pinned public MTP model (~550 MB) and a tiny negative fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createModelHub } from '../model-hub/index.mjs';
import { readGGUFMetadata } from '../local-models/details.mjs';
import { runnerEnvironment } from '../local-models/hardware.mjs';
import { runProcess } from '../tools/process.mjs';

const executable = process.env.FABER_LLAMA_EXECUTABLE, root = process.env.FABER_RUNTIME_QUALIFICATION_DIR;
if (!executable || !root || !path.isAbsolute(executable) || !path.isAbsolute(root)) throw new Error('Set absolute FABER_LLAMA_EXECUTABLE and isolated FABER_RUNTIME_QUALIFICATION_DIR');
await fs.mkdir(root, { recursive: true });
const version = await runProcess(executable, ['--version'], { env: runnerEnvironment(executable) });
assert.match(`${version.stdout}\n${version.stderr}`, /commit a37cc4610/, 'MTP evidence must use the exact qualified managed runtime');
const dataDir = path.join(root, 'mtp-data'), hub = await createModelHub({ dataDir, sourceDir: path.resolve(import.meta.dirname, '..') });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function download(repoId, revision, filename) {
  const state = await hub.request('models.state');
  const existing = state.downloads.findLast(job => job.repoId === repoId && job.revision === revision && job.status === 'completed' && job.files.length === 1 && job.files[0].path === filename);
  const job = existing || await hub.request('models.download', { repoId, revision, files: [filename] });
  for (let count = 0; ; count++) {
    const current = (await hub.request('models.state')).downloads.find(value => value.id === job.id);
    if (current.status === 'completed') return { path: path.join(current.directory, filename), record: current.files[0], repoId, revision };
    if (!['queued', 'downloading'].includes(current.status)) throw new Error(current.error || current.status);
    if (count >= 6000) throw new Error('Pinned public download timed out');
    await pause(100);
  }
}
async function run(model, mtp, expectedFailure = false) {
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const secret = randomBytes(24).toString('hex');
  const args = ['--model', model.path, '--alias', 'qualification', '--host', '127.0.0.1', '--port', String(port), '--api-key', secret, '--ctx-size', '512', '--parallel', '1', '--n-gpu-layers', '0', '--device', 'none', '--threads', '2', '--threads-batch', '2', '--offline', '--slots', '--verbosity', '5', ...(mtp ? ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '3'] : [])];
  const child = spawn(executable, args, { env: runnerEnvironment(executable), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', error; child.on('error', value => { error = value; });
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', chunk => { logs = (logs + chunk).slice(-4 * 1024 * 1024); });
  const base = `http://127.0.0.1:${port}`, headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
  try {
    let ready = false;
    for (let count = 0; count < 1200; count++) {
      if (error) throw error;
      if (child.exitCode !== null) break;
      try { const response = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch {}
      await pause(100);
    }
    if (expectedFailure) { assert.equal(ready, false, 'Unsupported model must not silently become ready without MTP'); assert.notEqual(child.exitCode, null, 'Unsupported MTP must terminate'); assert.match(logs, /model doesn't contain MTP layers/); return { rejected: true, exitCode: child.exitCode, error: "Model doesn't contain MTP layers; failed to create MTP context" }; }
    assert.ok(ready, logs.slice(-8000));
    const response = await fetch(`${base}/completion`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'List the integers from one to ten: 1, 2, 3,', n_predict: 32, temperature: 0, seed: 42, stream: false }), signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200, await response.clone().text()); const completion = await response.json(); assert.ok(completion.tokens_predicted > 0);
    const slots = await (await fetch(`${base}/slots`, { headers })).json();
    if (mtp) {
      assert.match(logs, /adding speculative implementation ['"]draft-mtp['"]/);
      assert.match(logs, /speculative decoding context initialized/);
      assert.ok(slots.length && slots.every(slot => slot.speculative === true));
      assert.ok(completion.timings?.draft_n > 0, 'Actual MTP draft tokens must be reported');
    }
    return { mtp, content: completion.content, tokensPredicted: completion.tokens_predicted, timings: completion.timings, slots: slots.map(slot => ({ id: slot.id, speculative: slot.speculative })) };
  } finally {
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'close'), pause(5000)]); }
    await fs.writeFile(path.join(root, `mtp-${expectedFailure ? 'negative' : mtp ? 'enabled' : 'baseline'}.log`), logs);
  }
}
try {
  const model = await download('unsloth/Qwen3.5-0.8B-MTP-GGUF', 'cf8a611f6ed2c2060046219a19f12cd3d5ecd67c', 'Qwen3.5-0.8B-Q4_K_M.gguf');
  const metadata = await readGGUFMetadata(model.path, { budget: { remaining: 16 * 1024 * 1024, deadline: Date.now() + 30000 } }); assert.equal(metadata.complete, true, metadata.warnings.join('; ')); assert.equal(metadata.architecture, 'qwen35');
  assert.ok(metadata.tensors.some(tensor => /nextn/.test(tensor.name)), 'Published GGUF must actually contain its native MTP head');
  const baseline = await run(model, false), enabled = await run(model, true); assert.equal(enabled.content, baseline.content, 'Greedy sample should agree with the non-MTP run');
  const tiny = await download('ggml-org/models-moved', '499bc8821c6b12b4e53c5bffcb21ec206f212d81', 'tinyllamas/stories260K.gguf');
  const negative = await run(tiny, true, true);
  const report = { schemaVersion: 1, runtimeCommit: 'a37cc46104eb50900d5ab4a9ba02a0abdac039db', model: { repoId: model.repoId, revision: model.revision, file: model.record.path, sha256: model.record.verifiedSha256, architecture: metadata.architecture, mtpTensorNames: metadata.tensors.filter(tensor => /nextn/.test(tensor.name)).map(tensor => tensor.name) }, cpu: true, baseline, enabled, negative, limits: ['One embedded native MTP head qualified; separate-head compatibility and other architectures require their own evidence', 'Short CPU check establishes operation, not sustained throughput or GPU fit'] };
  await fs.writeFile(path.join(root, 'mtp-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await hub.close(); }
