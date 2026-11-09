import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { packageCatalog, selectPackage, musicRoles } from '../model-hub/packages.mjs';
import { quantizationCatalog } from '../model-hub/quantizations.mjs';
import { createModelHub } from '../model-hub/index.mjs';
import { scanLocalModels } from '../local-models/library.mjs';
import { modelDownloadRequest } from '../renderer/model-helpers.mjs';
import { localChoices } from '../renderer/local-picker.mjs';
import { validate } from '../core/registry.mjs';

const repoId = 'fixture/packages', revision = 'c'.repeat(40);
const descriptor = name => ({ path: name, size: 64, format: name.endsWith('.gguf') ? 'gguf' : name.endsWith('.safetensors') ? 'safetensors' : 'other' });
const indexName = 'nested/model.safetensors.index.json', shard1 = 'nested/model-00001-of-00002.safetensors', shard2 = 'nested/model-00002-of-00002.safetensors';
const index = { weight_map: { a: path.posix.basename(shard2), b: path.posix.basename(shard1), c: path.posix.basename(shard2) } };
const safeNames = [indexName, shard1, shard2, 'nested/config.json', 'nested/tokenizer/tokenizer.json', 'nested/tokenizer/spiece.model', 'nested/tokenizer/chat_template.jinja', 'nested/alternate.safetensors', 'nested/pytorch_model.bin', 'nested/model.py', 'other/config.json'];
const musicNames = musicRoles.map(role => `MiniMax-Music3-${role}-${['condition_encoder', 'vocoder'].includes(role) ? 'F32' : 'Q8_0'}.gguf`);
const catalog = names => packageCatalog(names.map(descriptor), {}, quantizationCatalog(names.map(descriptor), () => null));

test('Safetensors package follows the index and includes nested tokenizer/support data without alternate weights or code', () => {
  const items = packageCatalog(safeNames.map(descriptor), { [indexName]: index });
  const item = items.find(item => item.label === indexName);
  assert.equal(item.complete, true); assert.deepEqual(item.weightFiles, [shard1, shard2]);
  for (const name of safeNames.slice(0, 7)) assert.ok(item.files.includes(name), name);
  for (const name of safeNames.slice(7)) assert.ok(!item.files.includes(name), name);
  assert.equal(item.sizeBytes, 7 * 64);
  for (const value of [{ weight_map: { a: '../escape.safetensors' } }, { weight_map: { a: '/outside.safetensors' } }, { weight_map: { a: 'unsafe.py' } }, { weight_map: {} }, null]) {
    const broken = packageCatalog(safeNames.map(descriptor), { [indexName]: value }).find(item => item.label === indexName);
    assert.equal(broken.complete, false); assert.match(broken.reason, /Invalid Safetensors index/);
  }
  const missing = packageCatalog(safeNames.filter(name => name !== shard2).map(descriptor), { [indexName]: index }).find(item => item.label === indexName);
  assert.equal(missing.complete, false); assert.match(missing.reason, /Missing indexed shard/);
  assert.equal(packageCatalog([descriptor('model.safetensors')])[0].complete, false);
});

test('Music3 requires exact roles and compatible per-component variants; one component is never a complete pipeline', () => {
  const [pipeline] = catalog([...musicNames, 'MiniMax-Music3-language_model-Q5_K_M.gguf', 'MiniMax-Music3-vocoder-Q4_K_M.gguf']);
  assert.equal(pipeline.type, 'minimax-music3'); assert.equal(pipeline.complete, true); assert.equal(pipeline.components.length, 5);
  const choices = Object.fromEntries(pipeline.components.map(component => [component.role, component.variants.find(variant => variant.complete).id]));
  const selected = selectPackage([pipeline], pipeline.id, choices); assert.equal(selected.files.length, 5); assert.equal(Object.keys(selected.components).length, 5);
  assert.throws(() => selectPackage([pipeline], pipeline.id, { language_model: choices.language_model }), /five/);
  assert.throws(() => selectPackage([pipeline], pipeline.id, { ...choices, vocoder: choices.language_model }), /incompatible/);
  assert.throws(() => selectPackage([pipeline], pipeline.id, { ...choices, vocoder: pipeline.components.find(component => component.role === 'vocoder').variants.find(variant => !variant.complete).id }), /incompatible/);
  const [missing] = catalog(musicNames.slice(1)); assert.equal(missing.complete, false); assert.match(missing.reason, /Language model/);
  assert.throws(() => selectPackage([missing], missing.id, choices), /unavailable/);
  assert.deepEqual(modelDownloadRequest({ id: repoId, revision }, [], undefined, { ...pipeline, choices }), { repoId, revision, packageId: pipeline.id, components: choices });
});

test('native Music3 Safetensors pipeline includes all five components and shared tokenizer/scheduler, excluding training checkpoints', () => {
  const names = [...musicRoles.flatMap(role => [`${role}/config.json`, `${role}/model.safetensors`]), 'config.json', 'modular_model_index.json', 'tokenizer/tokenizer.json', 'scheduler/scheduler_config.json', 'qwen_7B/training.safetensors'];
  const items = packageCatalog(names.map(descriptor), { 'modular_model_index.json': { _class_name: 'MiniMaxMusic3ModularPipeline' } });
  const native = items.find(item => item.pipeline === 'minimax-music3-native'); assert.equal(native.complete, true); assert.equal(native.weightFiles.length, 5);
  assert.ok(native.files.includes('tokenizer/tokenizer.json')); assert.ok(native.files.includes('scheduler/scheduler_config.json')); assert.ok(!native.files.includes('qwen_7B/training.safetensors'));
  const broken = packageCatalog(names.filter(name => name !== 'vocoder/model.safetensors').map(descriptor), { 'modular_model_index.json': { _class_name: 'MiniMaxMusic3ModularPipeline' } }).find(item => item.pipeline === 'minimax-music3-native'); assert.equal(broken.complete, false); assert.match(broken.reason, /Vocoder/);
});

test('agent package download re-inspects pinned index, approves exact files and discovers one offline package', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faber-package-test-'));
  const bytes = Buffer.from('fixture weights'), payloads = new Map(safeNames.slice(0, 7).map(name => [name, bytes])); payloads.set(indexName, Buffer.from(JSON.stringify(index)));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let siblings = [...payloads].map(([rfilename, bytes]) => ({ rfilename, size: bytes.length, lfs: { size: bytes.length, sha256: hash(bytes) } })), fileTransfers = [];
  const fetchImpl = async url => {
    if (String(url).includes('/api/models/')) return Response.json({ id: repoId, sha: revision, siblings });
    assert.ok(String(url).includes(`/resolve/${revision}/`)); const name = decodeURIComponent(String(url).split(`/resolve/${revision}/`)[1]);
    fileTransfers.push(name); return new Response(payloads.get(name));
  };
  const hub = await createModelHub({ dataDir: path.join(root, 'data'), sourceDir: path.join(root, 'source'), fetchImpl });
  t.after(async () => { await hub.close(); await fs.rm(root, { recursive: true, force: true }); });
  const details = await hub.request('models.inspect', { repoId }), item = details.packages.find(item => item.label === indexName);
  const tool = hub.tools().find(tool => tool.name === 'hf_download_model'), args = { repoId, revision, packageId: item.id };
  validate(args, tool.parameters);
  await assert.rejects(hub.request('models.download', { ...args, files: [shard1] }), /exactly one/);
  siblings = siblings.filter(file => file.rfilename !== shard2);
  await assert.rejects(tool.execute(args, { signal: new AbortController().signal, approve() { assert.fail('Incomplete package must fail before approval'); } }), /Missing indexed shard/);
  siblings = [...payloads].map(([rfilename, bytes]) => ({ rfilename, size: bytes.length, lfs: { size: bytes.length, sha256: hash(bytes) } }));
  const approvals = []; const job = await tool.execute(args, { signal: new AbortController().signal, approve: async (...args) => approvals.push(args) });
  assert.equal(approvals[0][0], 'files'); assert.match(approvals[0][1], /7 selected files/); assert.ok(approvals[0][1].includes(job.directory));
  for (let count = 0; count < 200; count++) { const current = (await hub.request('models.state')).downloads[0]; if (current.status === 'completed') break; if (current.status === 'failed') assert.fail(current.error); await new Promise(resolve => setTimeout(resolve, 10)); }
  const completed = (await hub.request('models.state')).downloads[0]; assert.equal(completed.status, 'completed'); assert.equal(completed.packageType, 'safetensors');
  assert.deepEqual(completed.files.map(file => file.path).sort(), item.files);
  const local = await scanLocalModels({ directory: job.directory, downloads: [completed] });
  assert.equal(local.models.length, 1); assert.equal(local.models[0].complete, true); assert.equal(local.models[0].available, false);
  assert.deepEqual(local.models[0].files, [shard1, shard2]); assert.equal(local.models[0].supportFiles.length, 5);
  await fs.rm(path.join(job.directory, 'nested/config.json')); const broken = (await scanLocalModels({ directory: job.directory })).models[0]; assert.equal(broken.complete, false); assert.match(broken.reason, /Missing configuration/);
});

test('offline Music3 groups exactly five components, rejects incomplete/ambiguous sets and stays out of chat picker', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faber-music-package-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const header = Buffer.alloc(64); header.write('GGUF'); header.writeUInt32LE(3, 4);
  for (const name of musicNames) await fs.writeFile(path.join(root, name), header);
  let local = await scanLocalModels({ directory: root }); assert.equal(local.models.length, 1);
  assert.equal(local.models[0].format, 'minimax-music3'); assert.equal(local.models[0].available, true); assert.deepEqual(local.models[0].files.sort(), musicNames.slice().sort());
  assert.deepEqual(localChoices(local), []);
  const alternate = 'MiniMax-Music3-language_model-Q5_K_M.gguf'; await fs.writeFile(path.join(root, alternate), header);
  local = await scanLocalModels({ directory: root }); assert.equal(local.models[0].available, false); assert.match(local.models[0].reason, /Multiple/);
  const components = Object.fromEntries(musicRoles.map((role, index) => [role, musicNames[index]]));
  local = await scanLocalModels({ directory: root, downloads: [{ directory: root, packageType: 'minimax-music3', components, status: 'completed', files: musicNames.map(name => ({ path: name, size: 64, status: 'completed' })) }] });
  assert.equal(local.models[0].available, true); assert.deepEqual(local.models[0].components, components);
  await fs.rm(path.join(root, musicNames[4])); local = await scanLocalModels({ directory: root }); assert.equal(local.models[0].available, false); assert.match(local.models[0].reason, /Vocoder/);
});
