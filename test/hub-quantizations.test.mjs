import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { modelDetails } from '../model-hub/metadata.mjs';
import { createModelHub } from '../model-hub/index.mjs';

const repoId = 'test/quantized', revision = 'a'.repeat(40);
const raw = names => ({ id: repoId, sha: revision, siblings: names.map((name, index) => typeof name === 'string' ? { rfilename: name, size: 100 + index } : name) });
const catalog = names => modelDetails(raw(names), repoId).quantizations;
test('quantization catalog keeps precise model and directory identities and totals full shards', () => {
  const variants = catalog(['a/Model-Q4_K_M-00002-of-00002.gguf', 'a/Model-Q4_K_M-00001-of-00002.gguf', 'b/Model-Q4_K_M.gguf', 'a/Other-Q4_K_M.gguf', 'Model-IQ2_XS.gguf', 'Model-TQ1_0.gguf', 'Model-MXFP4.gguf', 'Model-F16.gguf', 'Model-BF16.gguf', 'Model-F32.gguf']);
  assert.equal(variants.length, 9); assert.equal(new Set(variants.map(item => item.id)).size, 9);
  const split = variants.find(item => item.label === 'a/Model-Q4_K_M');
  assert.equal(split.complete, true); assert.equal(split.sizeBytes, 201); assert.deepEqual(split.files, ['a/Model-Q4_K_M-00001-of-00002.gguf', 'a/Model-Q4_K_M-00002-of-00002.gguf']);
  assert.equal(split.vram.bytes, Math.ceil(201 * 1.2 + 1024 ** 3)); assert.match(split.vram.note, /not a fit guarantee/);
  assert.equal(variants.find(item => item.encoding === 'BF16').bits, 16);
  assert.equal(variants.find(item => item.encoding === 'TQ1_0').bits, 1);
});
test('auxiliaries, ambiguous and undocumented names remain manual files only', () => {
  const names = ['mmproj-Model-Q4_K_M.gguf', 'mtp/Model-Q4_K_M.gguf', 'Model-Q4_K_M-LoRA.gguf', 'Model-vocab-F16.gguf', 'adapter.Model-F16.gguf', 'Model-Q4_UNKNOWN.gguf', 'Named-70B.gguf', 'Q4_K_M-model.gguf', 'Model-Q4_K_M-v2.gguf'];
  const details = modelDetails(raw(names), repoId); assert.equal(details.quantizations.length, 0); assert.equal(details.files.length, names.length); assert.equal(details.parameters, null);
});
test('missing, duplicate, mixed, invalid and inconsistent shards cannot be downloaded as variants', () => {
  const cases = [
    ['Model-Q4_K_M-00001-of-00002.gguf'],
    ['Model-Q4_K_M-00001-of-00002.gguf', 'Model-Q4_K_M-00002-of-00003.gguf'],
    ['Model-Q4_K_M-00000-of-00001.gguf'],
    ['Model-Q4_K_M-1-of-2.gguf', 'Model-Q4_K_M-01-of-02.gguf'],
    ['Model-Q4_K_M.gguf', 'Model-Q4_K_M-00001-of-00001.gguf'],
    ['Model-Q4_K_M-00001-of-00001.gguf', 'model-q4_k_m-00001-of-00001.gguf'],
  ];
  for (const names of cases) for (const variant of catalog(names)) { assert.equal(variant.complete, false, names.join(',')); assert.ok(variant.reason); assert.equal(variant.sizeBytes, null); assert.equal(variant.vram, null); }
  assert.throws(() => catalog(['Model-Q4_K_M.gguf', 'Model-Q4_K_M.gguf']), /Duplicate repository file/);
  const unknown = catalog([{ rfilename: 'Model-Q4_K_M.gguf' }])[0]; assert.equal(unknown.complete, true); assert.equal(unknown.sizeBytes, null); assert.equal(unknown.vram, null);
});

test('variant downloads re-inspect pinned metadata, expand exact shards and preserve tool approval/cancel', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sophia-quant-test-'));
  const bytes = Buffer.from('synthetic quantization shard'), hash = createHash('sha256').update(bytes).digest('hex');
  const names = ['a/Model-Q4_K_M-00001-of-00002.gguf', 'a/Model-Q4_K_M-00002-of-00002.gguf', 'b/Model-Q4_K_M.gguf', 'a/mmproj-Q4_K_M.gguf'];
  let metadata = raw(names.map(rfilename => ({ rfilename, size: bytes.length, lfs: { size: bytes.length, sha256: hash } }))), binaryCalls = 0, inspectCalls = 0;
  const hub = await createModelHub({ dataDir: path.join(root, 'data'), sourceDir: path.join(root, 'source'), fetchImpl: async url => {
    if (String(url).includes('/api/')) { inspectCalls++; assert.ok(String(url).includes(`/revision/${revision}`)); return Response.json(metadata); }
    binaryCalls++; return new Response(bytes);
  } });
  t.after(async () => { await hub.close(); await fs.rm(root, { recursive: true, force: true }); });
  const details = await hub.request('models.inspect', { repoId, revision }), variant = details.quantizations.find(item => item.label === 'a/Model-Q4_K_M');
  const args = { repoId, revision, quantizationId: variant.id };
  await assert.rejects(hub.request('models.download', { ...args, files: [names[0]] }), /exactly one/);
  await assert.rejects(hub.request('models.download', { repoId, revision }), /exactly one/);
  await assert.rejects(hub.request('models.download', { ...args, quantizationId: 'f'.repeat(64) }), /Unknown quantization/);
  metadata = { ...metadata, siblings: metadata.siblings.filter(item => item.rfilename !== names[1]) };
  await assert.rejects(hub.request('models.download', args), /unavailable.*Incomplete/); assert.equal(binaryCalls, 0);
  metadata = raw(names.map(rfilename => ({ rfilename, size: bytes.length, lfs: { size: bytes.length, sha256: hash } })));
  const controller = new AbortController(), approvals = [];
  const tool = hub.tools().find(item => item.name === 'hf_download_model');
  assert.equal(tool.permission, 'network');
  await assert.rejects(tool.execute(args, { signal: controller.signal, approve: async (permission, summary) => { approvals.push({ permission, summary }); controller.abort(new Error('Stopped')); } }), /Stopped/);
  assert.equal(binaryCalls, 0); assert.equal(approvals[0].permission, 'files'); assert.match(approvals[0].summary, /2 selected files/); assert.ok(approvals[0].summary.includes(`${bytes.length * 2} bytes`));
  const job = await hub.request('models.download', args);
  for (let count = 0; count < 200; count++) { const result = (await hub.request('models.state')).downloads[0]; if (result.status === 'completed') break; if (result.status === 'failed') assert.fail(result.error); await new Promise(resolve => setTimeout(resolve, 10)); }
  const completed = (await hub.request('models.state')).downloads[0]; assert.equal(completed.status, 'completed'); assert.equal(binaryCalls, 2); assert.ok(inspectCalls >= 5);
  assert.equal(completed.totalBytes, bytes.length * 2); assert.deepEqual(completed.files.map(file => file.path), names.slice(0, 2)); assert.equal(completed.quantizationId, variant.id);
  for (const name of names.slice(0, 2)) assert.deepEqual(await fs.readFile(path.join(job.directory, name)), bytes);
  await assert.rejects(fs.access(path.join(job.directory, names[2]))); await assert.rejects(fs.access(path.join(job.directory, names[3])));
});
