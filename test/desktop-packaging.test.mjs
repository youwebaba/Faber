import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareWorkbench, packagedRuntime } from '../desktop/packaged-paths.mjs';

test('packaged workbench is seeded once, preserves edits, and keeps prior installer versions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-package-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundledSource = path.join(root, 'bundle'), workbenchRoot = path.join(root, 'workbench'); await fs.mkdir(path.join(bundledSource, 'desktop'), { recursive: true });
  await fs.writeFile(path.join(bundledSource, 'desktop', 'main.mjs'), 'original'); await fs.writeFile(path.join(bundledSource, 'README.md'), 'instructions'); await fs.writeFile(path.join(bundledSource, 'package.json'), '{}');
  const first = await prepareWorkbench({ bundledSource, workbenchRoot, version: '1.0.0-beta.1' });
  assert.equal(await fs.readFile(path.join(first, 'desktop', 'main.mjs'), 'utf8'), 'original');
  await fs.writeFile(path.join(first, 'desktop', 'main.mjs'), 'approved self-upgrade');
  assert.equal(await prepareWorkbench({ bundledSource, workbenchRoot, version: '1.0.0-beta.1' }), first);
  assert.equal(await fs.readFile(path.join(first, 'desktop', 'main.mjs'), 'utf8'), 'approved self-upgrade');
  const second = await prepareWorkbench({ bundledSource, workbenchRoot, version: '1.0.0-beta.2' }); assert.notEqual(second, first);
  assert.equal(await fs.readFile(path.join(second, 'desktop', 'main.mjs'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(first, 'desktop', 'main.mjs'), 'utf8'), 'approved self-upgrade');
  await assert.rejects(prepareWorkbench({ bundledSource, workbenchRoot, version: '../escape' }), /Invalid/);
  await fs.mkdir(path.join(workbenchRoot, '1.0.0-beta.3')); await assert.rejects(prepareWorkbench({ bundledSource, workbenchRoot, version: '1.0.0-beta.3' }), /Incomplete/);
});
test('packaged runner resolves entirely within bundled real resources', () => {
  const root = path.resolve('fixture-resources'), result = packagedRuntime(root);
  assert.equal(result.executable, path.join(root, 'local-runtime', 'llama-server.exe'));
  assert.deepEqual(result.backendDirectories, ['cuda_v13', 'vulkan'].map(name => path.join(root, 'local-runtime', name)));
});

test('runtime packaging rejects unlocked binaries and changed reviewed bytes',async t=>{
  const {createHash}=await import('node:crypto'),{verifyRuntime}=await import('../desktop/runtime-integrity.cjs').then(module=>module.default);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-runtime-lock-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'.runtime','local-runtime');await fs.mkdir(directory,{recursive:true});await fs.mkdir(path.join(root,'build'));
  const bytes=Buffer.from('fixture'),manifest={files:[{path:'runner.exe',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
  await fs.writeFile(path.join(root,'build','runtime-lock.json'),JSON.stringify(manifest));await fs.writeFile(path.join(directory,'runtime-manifest.json'),JSON.stringify(manifest));await fs.writeFile(path.join(directory,'runner.exe'),bytes);
  await verifyRuntime(root);await fs.writeFile(path.join(directory,'unreviewed.dll'),'x');await assert.rejects(verifyRuntime(root),/Unreviewed/);await fs.unlink(path.join(directory,'unreviewed.dll'));
  await fs.writeFile(path.join(directory,'runner.exe'),'changed');await assert.rejects(verifyRuntime(root),/integrity mismatch/);
});

