import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {verifyNativeRuntime, parseNativeManifest} from '../native/integrity.mjs';
import {prepareWorkbench} from '../desktop/packaged-paths.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-native-integrity-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const bundle = path.join(root, 'bundle');
  for (const name of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'src', 'worker.mjs', 'integrity.mjs', 'runtime.json']) {
    await fs.cp(path.join(source, 'native', name), path.join(bundle, 'native', name), {recursive: true});
  }
  const {manifest, binaryPath} = await verifyNativeRuntime(source);
  const target = path.join(bundle, 'native', manifest.binary);
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.copyFile(binaryPath, target);
  return {root, bundle, manifest, target};
}

test('compiled worker verification rejects stale source, altered binaries and escaping manifest paths', async t => {
  const {bundle, manifest, target} = await fixture(t);
  await verifyNativeRuntime(bundle);
  await fs.appendFile(path.join(bundle, 'native/src/main.rs'), '\n// unbuilt edit\n');
  await assert.rejects(verifyNativeRuntime(bundle), /does not match its source/);
  await verifyNativeRuntime(bundle, {verifySource: false});
  await fs.appendFile(target, 'tampered');
  await assert.rejects(verifyNativeRuntime(bundle, {verifySource: false}), /integrity mismatch/);
  for (const binary of ['../outside.exe', 'bin/../../outside.exe', `bin/${manifest.sha256}.cmd`]) {
    assert.throws(() => parseNativeManifest({...manifest, binary}), /Invalid/);
  }
});

test('versioned workbenches retain executable Rust source and preserve the previous workbench', async t => {
  const {root, bundle} = await fixture(t);
  const workbenchRoot = path.join(root, 'workbench');
  const previous = await prepareWorkbench({bundledSource: bundle, workbenchRoot, version: '2.0.1-beta.1'});
  await fs.writeFile(path.join(previous, 'native/src/main.rs'), 'older custom source');
  const current = await prepareWorkbench({bundledSource: bundle, workbenchRoot, version: '2.0.1-rm.beta.1'});
  await verifyNativeRuntime(current);
  assert.equal(await fs.readFile(path.join(previous, 'native/src/main.rs'), 'utf8'), 'older custom source');
  const file = path.join(root, 'fixture.gguf'), bytes = Buffer.alloc(24);
  bytes.write('GGUF'); bytes.writeUInt32LE(3, 4); await fs.writeFile(file, bytes);
  const handle = await fs.open(file, 'r');
  try {
    const {readNativeGGUF} = await import(pathToFileURL(path.join(current, 'native/worker.mjs')));
    const result = await readNativeGGUF(handle.fd, {remaining: 1024, deadline: Date.now() + 5000});
    assert.equal(result.metadata.complete, true);
    assert.equal(result.remaining, 1000);
    await fs.writeFile(path.join(current, 'native/runtime.json'), '{}');
    // An existing backend keeps its compiled version until restart.
    assert.equal((await readNativeGGUF(handle.fd, {remaining: 1024, deadline: Date.now() + 5000})).metadata.complete, true);
    const restarted = await import(pathToFileURL(path.join(current, 'native/worker.mjs')).href + '?restart');
    await assert.rejects(restarted.readNativeGGUF(handle.fd, {remaining: 1024, deadline: Date.now() + 5000}), /unavailable/);
  } finally { await handle.close(); }
});

test('compiled worker integrity refuses a linked binary directory', async t => {
  const {root, bundle, manifest} = await fixture(t);
  const original = path.join(bundle, 'native/bin'), moved = path.join(root, 'outside');
  await fs.rename(original, moved);
  await fs.symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyNativeRuntime(bundle), /symlinks or junctions/);
  assert.ok((await fs.stat(path.join(moved, path.basename(manifest.binary)))).isFile());
});
