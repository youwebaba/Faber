// Opt-in native qualification; never included by node --test test/*.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createModelHub } from '../model-hub/index.mjs';
import { runProcess } from '../tools/process.mjs';

const executable = process.env.FABER_SAFETENSORS_EXECUTABLE, root = process.env.FABER_RUNTIME_QUALIFICATION_DIR;
if (!executable || !root || !path.isAbsolute(executable) || !path.isAbsolute(root)) throw new Error('Set absolute FABER_SAFETENSORS_EXECUTABLE and isolated FABER_RUNTIME_QUALIFICATION_DIR');
const repoId = 'hf-internal-testing/tiny-random-LlamaForCausalLM', revision = '9fb191250dd56d0ba7ec9785a025ed29c03d5998';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = JSON.parse(await fs.readFile(new URL('../build/safetensors-runtime-candidate.json', import.meta.url), 'utf8'));
const binary = await fs.readFile(executable), pinned = candidate.files.find(file => file.path === 'mistralrs.exe');
assert.equal(binary.length, pinned.size); assert.equal(digest(binary), pinned.sha256, 'Verify the pinned native executable before launching it');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
await fs.mkdir(root, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(root, 'safetensors-data-'));
const hub = await createModelHub({ dataDir, sourceDir: path.resolve(import.meta.dirname, '..') });
let child, logs = '', startupError;
try {
  const details = await hub.request('models.inspect', { repoId, revision }), item = details.packages.find(item => item.complete && item.weightFiles?.includes('model.safetensors'));
  assert.ok(item, 'Tiny real Safetensors package must be complete');
  const job = await hub.request('models.download', { repoId, revision, packageId: item.id });
  for (let count = 0; ; count++) {
    const state = await hub.request('models.state'), current = state.downloads.find(value => value.id === job.id);
    if (current.status === 'completed') break;
    if (!['queued', 'downloading'].includes(current.status)) throw new Error(current.error || current.status);
    if (count >= 1800) throw new Error('Public tiny-model download timed out');
    await pause(100);
  }
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, HF_HUB_OFFLINE: '1', HF_HOME: path.join(root, 'offline-cache') };
  for (const name of Object.keys(env)) if (/^(?:HF_TOKEN|HUGGING_FACE_HUB_TOKEN|HUGGINGFACE_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|MISTRALRS_.*)$/i.test(name)) delete env[name];
  const args = ['serve', '--host', '127.0.0.1', '--port', String(port), '--no-ui', '--cpu', '--format', 'plain', '--dtype', 'f32', '--max-seqs', '1', '--token-source', 'none', '-m', job.directory];
  child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { startupError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
  const base = `http://127.0.0.1:${port}`;
  let models;
  for (let count = 0; count < 600; count++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Native runtime exited ${child.exitCode}: ${logs.slice(-6000)}`);
    try { const response = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { models = await response.json(); break; } } catch {}
    await pause(100);
  }
  assert.ok(models?.data?.length, `Native runtime did not become ready: ${logs.slice(-6000)}`);
  const model = models.data[0].id;
  const request = async stream => {
    const response = await fetch(`${base}/v1/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: 'Hello', max_tokens: 8, temperature: 0, stream }), signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, await response.clone().text()); return stream ? response.text() : response.json();
  };
  const completion = await request(false); assert.equal(typeof completion.choices?.[0]?.text, 'string'); assert.ok(completion.usage?.completion_tokens > 0);
  const streaming = await request(true); assert.match(streaming, /data:/); assert.match(streaming, /\[DONE\]/);
  const mtpNegative = await runProcess(executable, [...args, '--mtp'], { env, timeout: 30000 });
  assert.notEqual(mtpNegative.code, 0, 'Native Safetensors runtime must reject an unsupported MTP model');
  const mtpError = `${mtpNegative.stdout}\n${mtpNegative.stderr}`; assert.match(mtpError, /MTP speculative decoding currently requires PagedAttention/);
  const report = { schemaVersion: 1, runtime: 'mistralrs', runtimeVersion: '0.9.5', executableSha256: digest(await fs.readFile(executable)), sourceCommit: '465191d0b0a7e2432d327b0de06204ab3f94d3a2',
    model: { repoId, revision, files: item.files, sizeBytes: item.sizeBytes }, cpu: true, offlineEnvironment: true, loopback: true,
    checks: ['Pinned public package downloaded through the Faber hub with length/hash verification', 'Native Windows CPU loader read original Safetensors without conversion', 'HTTP completions and SSE completed with actual generated tokens', 'No paid provider or token credentials used'],
    completionTokens: completion.usage.completion_tokens, streamingDone: true, unsupportedCpuMtpRejected: true, nativeMtpRejection: 'MTP speculative decoding currently requires PagedAttention for this pipeline',
    limits: ['Random tiny weights establish loader/API operation, not model quality or production architecture coverage', 'Native listener has no verified API-key gate; managed integration must add authentication before exposure', 'No GPU or MTP inference qualified by this CPU Safetensors test'] };
  await fs.writeFile(path.join(root, 'safetensors-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'close'), pause(5000)]); }
  await fs.writeFile(path.join(root, 'safetensors-native.log'), logs); await hub.close();
}
