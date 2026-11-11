import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { modelDetails } from '../model-hub/metadata.mjs';
import { createModelHub } from '../model-hub/index.mjs';
import { matchingProjectors, visionModelStem, visionProjector } from '../model-hub/vision.mjs';

const repoId = 'test/Qwen-GGUF', revision = 'b'.repeat(40), stem = 'Qwen3.5-9B-Kimi-k3-Distilled';
const main = `${stem}.Q4_K_M.gguf`, q8 = `${stem}.mmproj-Q8_0.gguf`, f16 = `${stem}.mmproj-f16.gguf`;
const names = [main, f16, q8, 'Other.mmproj-Q8_0.gguf', 'mmproj-Q8_0.gguf', 'Other.Q4_K_M.gguf'];
const raw = bytes => ({ id: repoId, sha: revision, siblings: names.map(rfilename => ({ rfilename, size: bytes.length, lfs: { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })) });

test('vision catalog matches the supplied Qwen stem, prefers Q8_0, and excludes auxiliaries from variants', () => {
  const model = modelDetails(raw(Buffer.from('fixture')), repoId);
  assert.equal(visionProjector(q8), true); assert.equal(visionProjector(main), false);
  assert.equal(visionModelStem(q8), visionModelStem(main));
  assert.equal(visionModelStem('mmproj-Q8_0.gguf'), '');
  assert.equal(visionModelStem('Qwen3-VL-8B-Instruct-Q4_K_M.gguf'), 'qwen3-vl-8b-instruct');
  assert.equal(visionProjector('owner/Model-mmproj-GGUF/revision/Model-Q4_K_M.gguf'), false);
  assert.deepEqual(matchingProjectors(main, [f16, q8, 'Other.mmproj-Q8_0.gguf', 'sub/' + q8]), [q8, f16]);
  assert.equal(model.quantizations.length, 2);
  assert.deepEqual(model.visionCompanions.find(file => file.path === q8).modelFiles, [main]);
  assert.deepEqual(model.visionCompanions.find(file => file.path === 'mmproj-Q8_0.gguf').modelFiles, []);
  assert.equal(model.files.find(file => file.path === q8).role, 'vision-projector');
  assert.deepEqual(matchingProjectors(main, ['mmproj-Q8_0.gguf'], { modelPaths: [main] }), ['mmproj-Q8_0.gguf']);
  assert.deepEqual(matchingProjectors(main, ['mmproj-Q8_0.gguf'], { modelPaths: [main, 'Other.Q4_K_M.gguf'] }), []);
  assert.deepEqual(matchingProjectors(main, ['mmproj-Q8_0.gguf', f16], { modelPaths: [main] }), [f16, 'mmproj-Q8_0.gguf']);
  assert.deepEqual(matchingProjectors(main, [`${stem}.mmproj-f16-00001-of-00002.gguf`, `${stem}.mmproj-Q8_0-00001-of-00002.gguf`]), [`${stem}.mmproj-Q8_0-00001-of-00002.gguf`, `${stem}.mmproj-f16-00001-of-00002.gguf`]);
});

test('normal model and agent downloads revalidate one matching companion; supplemental downloads request no main weights', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faber-vision-hub-')), bytes = Buffer.from('verified synthetic GGUF');
  const binaries = []; let metadata = raw(bytes), metadataCalls = 0;
  const hub = await createModelHub({ dataDir: path.join(root, 'data'), sourceDir: path.join(root, 'source'), fetchImpl: async url => {
    if (String(url).includes('/api/')) { metadataCalls++; return Response.json(metadata); }
    binaries.push(decodeURIComponent(String(url).split('/').at(-1))); return new Response(bytes);
  } });
  t.after(async () => { await hub.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.deepEqual(binaries, []); assert.equal(metadataCalls, 0);
  const details = await hub.request('models.inspect', { repoId, revision }), variant = details.quantizations.find(item => item.files.includes(main));
  const args = { repoId, revision, quantizationId: variant.id, projector: 'auto' };
  await assert.rejects(hub.request('models.download', { ...args, projector: names[3] }), /does not match/);
  await assert.rejects(hub.request('models.download', { repoId, revision, files: [q8], projector: 'auto' }), /requires a GGUF/);
  const wait = async id => { for (let count = 0; count < 200; count++) { const job = (await hub.request('models.state')).downloads.find(item => item.id === id); if (job.status === 'completed') return job; if (job.status === 'failed') assert.fail(job.error); await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Download did not finish'); };
  const job = await hub.request('models.download', args); await wait(job.id);
  assert.deepEqual(binaries, [main, q8]); assert.deepEqual(job.files.map(file => file.path), [main, q8]);
  assert.equal(job.files[1].role, 'vision-projector');
  const approvals = [], tool = hub.tools().find(item => item.name === 'hf_download_model');
  const supplemental = await tool.execute({ repoId, revision, files: [f16] }, { signal: new AbortController().signal, approve: async (...args) => approvals.push(args) });
  await wait(supplemental.id); assert.deepEqual(binaries, [main, q8, f16]);
  assert.equal(approvals[0][0], 'files'); assert.match(approvals[0][1], /1 selected files/);
  assert.equal(supplemental.files[0].role, 'vision-projector');
  metadata = { ...metadata, siblings: metadata.siblings.filter(file => file.rfilename !== q8) };
  await assert.rejects(hub.request('models.download', { ...args, projector: q8 }), /does not match/);
  metadata = { ...metadata, siblings: metadata.siblings.filter(file => file.rfilename !== f16) };
  await assert.rejects(hub.request('models.download', args), /No matching vision companion/);
});
