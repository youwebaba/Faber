import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { scanLocalModels } from '../local-models/library.mjs';

// Tiny synthetic GGUF headers exercise discovery, not real model loading.
function gguf(version = 3) {
  const bytes = Buffer.alloc(64);
  bytes.write('GGUF'); bytes.writeUInt32LE(version, 4); bytes.writeBigUInt64LE(1n, 8);
  return bytes;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'sophia-local-library-'));
  const directory = path.join(root, 'models'); await fs.mkdir(directory);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(name, content = gguf()) {
    const file = path.join(directory, ...name.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file;
  }
  return { root, directory, write };
}

test('discovers arbitrary GGUF names and nested complete original shards without requiring a known quantization', async t => {
  const { directory, write } = await fixture(t);
  await write('my-favorite.gguf'); await write('nested/unusual-quant-name-00002-of-00002.gguf'); await write('nested/unusual-quant-name-00001-of-00002.gguf');
  for (const name of ['.hidden.gguf', '.cache/hidden.gguf', 'work.partial.gguf', 'model.gguf.partial', 'mmproj-model.gguf', 'model-MTP.gguf', 'adapter_model.gguf', 'lora.gguf']) await write(name);
  await write('config.json', '{untrusted:model code}'); await write('weights.safetensors', Buffer.from('not parsed'));
  const found = await scanLocalModels({ directory });
  assert.equal(found.directory, await fs.realpath(directory)); assert.equal(found.models.length, 3); assert.deepEqual(found.warnings, []);
  const single = found.models.find(model => model.relativePath === 'my-favorite.gguf');
  assert.equal(single.available, true); assert.equal(single.sizeBytes, 64); assert.equal(single.format, 'gguf');
  const split = found.models.find(model => model.files.length === 2);
  assert.equal(split.available, true); assert.equal(split.relativePath, 'nested/unusual-quant-name-00001-of-00002.gguf');
  assert.deepEqual(split.files, ['nested/unusual-quant-name-00001-of-00002.gguf', 'nested/unusual-quant-name-00002-of-00002.gguf']); assert.equal(split.sizeBytes, 128);
  const unsupported = found.models.find(model => model.format === 'safetensors');
  assert.equal(unsupported.available, false); assert.match(unsupported.reason, /compatible runtime|conversion/);
});

test('incomplete, malformed and inconsistent shards and invalid headers remain unavailable', async t => {
  const { directory, write } = await fixture(t);
  for (const name of ['missing-00001-of-00002.gguf', 'bad-width-1-of-1.gguf', 'zero-00000-of-00001.gguf', 'different-00001-of-00002.gguf', 'different-00002-of-00003.gguf']) await write(name);
  await write('short.gguf', Buffer.from('GGUF')); await write('fake.gguf', Buffer.alloc(64)); await write('new-version.gguf', gguf(999));
  const highBits = gguf(); for (let index = 0; index < 4; index++) highBits[index] |= 128; await write('false-magic.gguf', highBits);
  const { models } = await scanLocalModels({ directory });
  assert.equal(models.length, 8); assert.ok(models.every(model => !model.available && model.reason));
  assert.match(models.find(model => model.relativePath.startsWith('missing')).reason, /Incomplete/);
  assert.match(models.find(model => model.relativePath.startsWith('bad-width')).reason, /numbering/);
  assert.match(models.find(model => model.relativePath === 'fake.gguf').reason, /header/);
  assert.match(models.find(model => model.relativePath === 'new-version.gguf').reason, /version/);
});

test('tracked active/failed downloads block published files; completed retries and matching sizes are eligible', async t => {
  const { directory, write } = await fixture(t);
  for (const name of ['active.gguf', 'failed.gguf', 'retry.gguf', 'changed.gguf', 'manual.gguf', 'shards-00001-of-00002.gguf', 'shards-00002-of-00002.gguf']) await write(name);
  const record = (file, status, fileStatus = 'completed', size = 64) => ({ directory, status, files: [{ path: file, status: fileStatus, size }] });
  const downloads = [record('active.gguf', 'downloading'), record('failed.gguf', 'failed'), record('retry.gguf', 'failed'), record('retry.gguf', 'completed'), record('changed.gguf', 'completed', 'completed', 65), record('shards-00002-of-00002.gguf', 'interrupted')];
  const { models } = await scanLocalModels({ directory, downloads });
  for (const file of ['active.gguf', 'failed.gguf', 'shards-00001-of-00002.gguf']) {
    const model = models.find(model => model.relativePath === file); assert.equal(model.available, false); assert.match(model.reason, /download is not complete/);
  }
  assert.equal(models.find(model => model.relativePath === 'retry.gguf').available, true);
  assert.equal(models.find(model => model.relativePath === 'manual.gguf').available, true);
  assert.match(models.find(model => model.relativePath === 'changed.gguf').reason, /size differs/);
});

test('stable IDs incorporate canonical root, relative paths, size and modification time', async t => {
  const { root, directory, write } = await fixture(t);
  const file = await write('model.gguf');
  const first = (await scanLocalModels({ directory })).models[0];
  assert.equal((await scanLocalModels({ directory: path.join(directory, '..', 'models') })).models[0].id, first.id);
  const modified = new Date(Date.now() + 20000); await fs.utimes(file, modified, modified);
  const changed = (await scanLocalModels({ directory })).models[0]; assert.notEqual(changed.id, first.id); assert.notEqual(changed.mtimeMs, first.mtimeMs);
  await fs.rename(file, path.join(directory, 'renamed.gguf'));
  assert.notEqual((await scanLocalModels({ directory })).models[0].id, changed.id);
  const another = path.join(root, 'another'); await fs.mkdir(another); await fs.copyFile(path.join(directory, 'renamed.gguf'), path.join(another, 'renamed.gguf'));
  assert.notEqual((await scanLocalModels({ directory: another })).models[0].id, (await scanLocalModels({ directory })).models[0].id);
});

test('junctions/symlinks cannot expand discovery or authorize an aliased scan root', async t => {
  const { root, directory, write } = await fixture(t);
  await write('inside.gguf');
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'outside.gguf'), gguf());
  const link = path.join(directory, 'escape'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const found = await scanLocalModels({ directory });
  assert.deepEqual(found.models.map(model => model.relativePath), ['inside.gguf']);
  assert.match(found.warnings.find(warning => warning.path === 'escape').reason, /junction|Symlink/i);
  await assert.rejects(scanLocalModels({ directory: link }), /junction|Symlink/i);
  await assert.rejects(scanLocalModels({ directory: path.join(link, 'nested') }), /junction|Symlink/i);
});

test('missing folders report empty state and nonlocal/relative directory inputs are rejected', async t => {
  const { root } = await fixture(t);
  const missing = await scanLocalModels({ directory: path.join(root, 'not-created') });
  assert.deepEqual(missing.models, []); assert.match(missing.warnings[0].reason, /does not exist/);
  for (const directory of ['relative', '\\example.invalid\share\models', '//example.invalid/share/models', '\\?\C:\models', 'C:/bad' + String.fromCharCode(0)]) await assert.rejects(scanLocalModels({ directory }), /absolute local/);
});
