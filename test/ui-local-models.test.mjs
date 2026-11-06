import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalOllama, localChoices, localSelection, localModelLabel } from '../renderer/local-picker.mjs';

const provider = { id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' };
const download = { id: 'folder-model', label: 'Model Q4_K_M', available: true, format: 'gguf', sizeBytes: 1024, files: ['Model.gguf'] };
test('local controls apply to loopback Ollama; remote and API connections keep their exact-ID path', () => {
  assert.equal(isLocalOllama(provider), true);
  assert.equal(isLocalOllama({ ...provider, baseUrl: 'http://[::1]:11434' }), true);
  for (const changed of [{ baseUrl: 'http://192.168.1.2:11434' }, { baseUrl: 'https://localhost.example.com' }, { kind: 'openai' }]) assert.equal(isLocalOllama({ ...provider, ...changed }), false);
});
test('download and installed choices stay distinct; incomplete files are disabled with their reason', () => {
  const choices = localChoices({ models: [download, { ...download, id: 'partial', available: false, reason: 'Missing shard 2' }], installed: [{ id: 'folder-model', label: 'Existing Ollama model' }], ollama: { online: true } }, provider);
  assert.equal(choices[0].group, 'Downloads'); assert.equal(choices[2].group, 'Installed in Ollama');
  assert.notEqual(choices[0].value, choices[2].value); assert.equal(choices[1].disabled, true); assert.match(choices[1].label, /Unavailable/); assert.equal(choices[1].reason, 'Missing shard 2');
  assert.equal(localSelection({}, choices[1], provider).canStart, false);
});

test('local picker labels omit repository folders and revision hashes while preserving model, quantization, size and IDs', () => {
  const revision = '0123456789abcdef0123456789abcdef01234567';
  const relativePath = `publisher/model/${revision}/weights/Qwen3-8B-Q4_K_M.gguf`;
  const item = { ...download, label: relativePath, relativePath };
  const [choice] = localChoices({ models: [item] });
  assert.equal(choice.label, 'Qwen3-8B-Q4_K_M · 1 KiB'); assert.equal(choice.value, `download:${item.id}`); assert.equal(choice.relativePath, relativePath);
  assert.equal(localModelLabel({ label: `publisher\\model\\${revision}\\Qwen3-8B-Q4_K_M (2/2 shards)` }), 'Qwen3-8B-Q4_K_M');
  assert.equal(localModelLabel({ relativePath: `${relativePath.slice(0, -5)}-00001-of-00002.gguf` }), 'Qwen3-8B-Q4_K_M');
  const long = localModelLabel({ label: `model-${'very-long-name-'.repeat(20)}Q4_K_M.gguf` }); assert.ok(long.length <= 48); assert.match(long, /Q4_K_M$/);
  const installed = localChoices({ installed: [{ id: 'publisher/model:Q8_0', label: 'publisher/model:Q8_0' }] }, provider)[0];
  assert.equal(installed.label, 'model:Q8_0'); assert.equal(installed.id, 'publisher/model:Q8_0');
});
test('offline configured model is not claimed installed and can still be explicitly started or used', () => {
  const [choice] = localChoices({ ollama: { online: false } }, provider, 'existing:latest');
  assert.equal(choice.group, 'Configured model'); assert.match(choice.label, /not checked/);
  assert.equal(localSelection({}, choice, provider).canUse, true); assert.equal(localSelection({}, choice, provider).canStart, true);
  const [missing] = localChoices({ ollama: { online: true }, installed: [] }, provider, 'missing'); assert.equal(missing.disabled, true);
});
test('download Use requires exact ready source and server-provided connection tuple', () => {
  const [choice] = localChoices({ models: [download] });
  const state = { runtime: { available: true }, process: { status: 'ready', modelId: download.id, providerId: 'managed', model: 'loaded-model' } };
  assert.deepEqual(localSelection(state, choice), { canStart: false, canStop: true, canUse: true, busy: false, providerId: 'managed', model: 'loaded-model', note: 'Loaded and ready.' });
  for (const process of [{ ...state.process, modelId: 'other' }, { ...state.process, status: 'loading' }, { ...state.process, status: 'stopped' }, { ...state.process, providerId: undefined }]) assert.equal(localSelection({ ...state, process }, choice).canUse, false);
  const loading = localSelection({ ...state, process: { modelId: download.id, status: 'loading', stage: 'Loading weights' } }, choice);
  assert.equal(loading.canStart, false); assert.equal(loading.canStop, true); assert.equal(loading.busy, true); assert.equal(loading.note, 'Loading weights');
});
test('actual loaded Ollama state controls unload and failed local loads retain actionable errors', () => {
  const choice = { id: 'installed', source: 'installed' };
  assert.equal(localSelection({ loaded: ['installed'] }, choice, provider).canStop, true);
  assert.equal(localSelection({ loaded: ['other'] }, choice, provider).canStop, false);
  const [file] = localChoices({ models: [download] });
  const failed = localSelection({ runtime: { available: true }, process: { modelId: file.id, status: 'failed', error: 'Insufficient memory' } }, file);
  assert.equal(failed.note, 'Insufficient memory'); assert.equal(failed.canStart, true); assert.equal(failed.canUse, false);
});

test('running folder model retains a Stop-only choice when refreshed files disappear, change or become unavailable', () => {
  const process = { status: 'ready', modelId: download.id, providerId: 'managed', model: 'exact-loaded-model' };
  for (const models of [[], [{ ...download, id: 'changed-file' }], [{ ...download, available: false, reason: 'Download incomplete' }]]) {
    const state = { models, process, runtime: { available: true } };
    const choice = localChoices(state).find(item => item.id === process.modelId);
    assert.ok(choice); assert.equal(choice.source, 'download'); assert.equal(choice.value, `download:${download.id}`);
    assert.equal(choice.disabled, false); assert.equal(choice.stopOnly, true);
    const selected = localSelection(state, choice);
    assert.equal(selected.canStop, true); assert.equal(selected.canStart, false); assert.equal(selected.canUse, false);
    assert.equal(selected.providerId, undefined); assert.equal(selected.model, undefined);
    assert.equal(localSelection({ ...state, process: { ...process, modelId: 'different-running-model' } }, choice).canStop, false);
    assert.equal(localSelection({ ...state, process: { ...process, status: 'stopped' } }, choice).canStop, false);
  }
  const restored = { models: [download], process };
  const choice = localChoices(restored)[0]; assert.equal(choice.stopOnly, undefined);
  assert.equal(localSelection(restored, choice).providerId, 'managed'); assert.equal(localSelection(restored, choice).model, 'exact-loaded-model');
});
