import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryEntries, libraryMetadata } from '../renderer/library.mjs';
import { hardwarePayload } from '../renderer/hardware.mjs';
import { addonStatus, addonResetState, addonNotices } from '../renderer/addons.mjs';

const model = { id: 'disk', label: 'model-Q4.gguf', files: ['repo/model-Q4.gguf'], format: 'gguf', sizeBytes: 512, available: true, complete: true };
const local = { directory: 'C:\\Models', models: [model], process: { status: 'stopped' } };
const job = { id: 'job', repoId: 'publisher/model', directory: 'c:/models/repo', files: [{ path: 'model-Q4.gguf', size: 512 }], status: 'completed', totalBytes: 512, quantizationLabel: 'model-Q4' };
test('disk library is backed by scanner files and never equates download history with current files', () => {
  assert.deepEqual(libraryEntries({ ...local, models: [] }, [job]), []);
  const [entry] = libraryEntries(local, [job]); assert.equal(entry.kind, 'disk'); assert.equal(entry.job.id, job.id); assert.equal(entry.model.sizeBytes, 512); assert.equal(entry.canDelete, true);
  const [untracked] = libraryEntries(local, [{ ...job, directory: 'C:/Elsewhere/repo' }]); assert.equal(untracked.job, undefined); assert.equal(untracked.kind, 'disk');
});
test('active transfer becomes one progress card; loaded files are guarded and inactive broken files remain recyclable', () => {
  const [transfer] = libraryEntries(local, [{ ...job, status: 'downloading' }]); assert.equal(transfer.kind, 'transfer'); assert.equal(transfer.label, 'model-Q4');
  assert.equal(libraryEntries({ ...local, process: { status: 'ready', modelId: model.id } }, [job])[0].canDelete, false);
  assert.equal(libraryEntries({ ...local, models: [{ ...model, complete: false }] }, [job])[0].canDelete, true);
  assert.equal(libraryEntries({ ...local, models: [{ ...model, available: false, reason: 'Unsupported format' }] }, [job])[0].canDelete, true);
});
test('hardware payload retains supported IDs and explicit memory choice without claiming actual placement', () => {
  const hardware = { gpus: [{ id: 'CUDA0' }], cpus: [{ id: 0 }, { id: 1 }] };
  const values = { mode: 'custom', gpuIds: ['CUDA0'], cpuIds: [1], automaticCpus: false, threads: '1', memoryMap: false };
  assert.deepEqual(hardwarePayload(values, hardware), { mode: 'custom', gpuIds: ['CUDA0'], cpuIds: [1], threads: 1, memoryMap: false });
  assert.deepEqual(hardwarePayload({ ...values, mode: 'auto' }, hardware), { mode: 'auto', gpuIds: [], cpuIds: [], threads: 0, memoryMap: false });
  assert.deepEqual(hardwarePayload({ ...values, mode: 'cpu' }, hardware).gpuIds, []);
  for (const change of [{ gpuIds: [] }, { gpuIds: ['fake'] }, { cpuIds: [] }, { cpuIds: [7] }, { threads: 2 }]) assert.throws(() => hardwarePayload({ ...values, ...change }, hardware));
});
test('addon status does not label unapproved or incompatible code trusted', () => {
  assert.match(addonStatus({ status: 'enabled' }), /trusted local code/);
  assert.equal(addonStatus({ status: 'untrusted' }), 'Needs trust approval');
  assert.equal(addonStatus({ status: 'incompatible' }), 'Incompatible');
  assert.equal(addonStatus({ status: 'mystery' }), 'Status unknown');
});
test('addon restart and warnings remain visible, and reset requires a disabled addon with data', () => {
  assert.deepEqual(addonResetState({ enabled: true, hasData: true }), { disabled: true, title: 'Disable before Reset' });
  assert.equal(addonResetState({ enabled: false, hasData: true }).disabled, false);
  assert.equal(addonResetState({ enabled: false, hasData: false }).disabled, true);
  const notices = addonNotices({ restartRequired: true, warnings: ['Approval could not be read', 'Legacy addon failed'] });
  assert.match(notices[0], /Restart Faber/); assert.deepEqual(notices.slice(1), ['Approval could not be read', 'Legacy addon failed']);
  assert.deepEqual(addonNotices({ restartRequired: false, warnings: [] }), []);
});
test('library details prefer canonical offline metadata, retain cached provenance, and never infer counts from filenames', () => {
  const unknown = libraryMetadata({ model: { label: 'Model-70B-Q4.gguf' } }); assert.equal(unknown.parameters, null); assert.equal(unknown.quantization, null);
  const cached = { job: { quantizationLabel: 'Q4_K_M', modelMetadata: { parameters: 7000000000, architecture: 'llama', vram: { bytes: 8000000000, estimated: true, basis: 'Weights plus reserve' } } } };
  const saved = libraryMetadata(cached); assert.equal(saved.parameters, 7000000000); assert.equal(saved.metadataSource, 'cached-huggingface'); assert.equal(saved.quantization, 'Q4_K_M');
  const actual = libraryMetadata(cached, { parameters: 8000000000, quantization: 'Q8_0', architecture: 'actual', metadataSource: 'gguf', parameterSource: 'tensor dimensions', warnings: ['Runtime support is not known'] });
  assert.equal(actual.parameters, 8000000000); assert.equal(actual.quantization, 'Q8_0'); assert.equal(actual.metadataSource, 'gguf'); assert.deepEqual(actual.warnings, ['Runtime support is not known']);
  assert.equal(libraryMetadata(cached, { metadataSource: 'unknown', quantization: null }).quantization, null);
});
