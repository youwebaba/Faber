import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatParameters, formatVram, selectedFiles, downloadProgress, requestGate, quantizationGroups, modelDownloadRequest } from '../renderer/model-helpers.mjs';

test('model metadata distinguishes unknown values from real zero and estimates', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '1024']) assert.equal(formatBytes(value), 'Unknown');
  assert.equal(formatBytes(0), '0 B'); assert.equal(formatBytes(1536), '1.5 KiB'); assert.equal(formatBytes(1073741824), '1 GiB');
  assert.equal(formatParameters(7_000_000_000), '7B'); assert.equal(formatParameters(124_500_000), '124.5M');
  assert.equal(formatParameters(null), 'Unknown'); assert.equal(formatParameters(0), 'Unknown');
  assert.equal(formatVram(null), 'Unknown'); assert.equal(formatVram({ bytes: null }), 'Unknown');
  assert.equal(formatVram({ bytes: 8 * 1024 ** 3, estimated: true }), '~8 GiB');
});

test('download size counts only explicit selected files and never conceals unknown sizes', () => {
  const files = [{ path: 'q4.gguf', size: 4096 }, { path: 'q8.gguf', size: 8192 }, { path: 'config.json', size: null }];
  assert.deepEqual(selectedFiles(files, new Set()), { paths: [], count: 0, knownBytes: 0, unknownCount: 0, sizeLabel: '0 B' });
  const chosen = selectedFiles(files, new Set(['q4.gguf', 'config.json', 'missing']));
  assert.deepEqual(chosen.paths, ['q4.gguf', 'config.json']); assert.equal(chosen.count, 2); assert.equal(chosen.knownBytes, 4096);
  assert.equal(chosen.sizeLabel, '4 KiB known + 1 unknown size');
  assert.equal(selectedFiles(files, new Set(['q8.gguf'])).sizeLabel, '8 KiB');
});

test('download progress preserves indeterminate totals and reports actual transfer speed', () => {
  const running = downloadProgress({ status: 'downloading', progress: .125, downloadedBytes: 1024, totalBytes: 8192, speedBytesPerSecond: 2048 });
  assert.deepEqual(running, { progress: .125, percent: '12%', bytes: '1 KiB / 8 KiB', speed: '2 KiB/s', active: true });
  const unknown = downloadProgress({ status: 'downloading', progress: null, downloadedBytes: 1024, totalBytes: null, speedBytesPerSecond: null });
  assert.equal(unknown.progress, null); assert.equal(unknown.percent, 'Size unknown'); assert.equal(unknown.speed, '—');
  assert.equal(downloadProgress({ status: 'completed', progress: null }).progress, 1);
  assert.equal(downloadProgress({ status: 'canceled', progress: .3, speedBytesPerSecond: 200 }).speed, '—');
  assert.equal(downloadProgress({ status: 'failed', progress: .3 }).active, false);
  assert.equal(downloadProgress({ status: 'interrupted', progress: .3 }).progress, .3);
  assert.equal(downloadProgress({ status: 'downloading', progress: 2 }).progress, 1);
});

test('out-of-order searches and inspections cannot replace a newer selection', async () => {
  const issue = requestGate(); const writes = [];
  let finishOld;
  const old = issue(); const oldResult = new Promise(resolve => { finishOld = resolve; });
  const oldTask = oldResult.then(value => { if (old()) writes.push(value); });
  const current = issue(); if (current()) writes.push('new model');
  finishOld('stale model'); await oldTask;
  assert.deepEqual(writes, ['new model']);
  assert.equal(old(), false); assert.equal(current(), true);
  issue(); assert.equal(current(), false);
});

test('quantization groups keep exact identities and all authoritative shard paths', () => {
  const first = { id: 'first', label: 'Model-Q4_K_M', encoding: 'Q4_K_M', bits: 4, files: ['part1.gguf', 'part2.gguf'], complete: true };
  const second = { ...first, id: 'second', label: 'Other-Q4_K_M', files: ['other.gguf'] };
  const high = { id: 'partial', bits: 8, complete: false, reason: 'Missing shard 2' };
  assert.deepEqual(quantizationGroups([high, first, second]), [{ bits: 4, variants: [first, second] }, { bits: 8, variants: [high] }]);
  const model = { id: 'org/model', revision: 'a'.repeat(40) };
  assert.deepEqual(modelDownloadRequest(model, ['ignored.gguf'], first), { repoId: 'org/model', revision: model.revision, quantizationId: 'first' });
  assert.deepEqual(modelDownloadRequest(model, ['manual.gguf']), { repoId: 'org/model', revision: model.revision, files: ['manual.gguf'] });
  assert.throws(() => modelDownloadRequest(model, [], high), /Missing shard 2/);
});
