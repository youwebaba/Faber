import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { imageTools } from '../tools/images.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'faber-image-test-'));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  t.after(async () => { assert.ok(path.basename(root).startsWith('faber-image-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const tool = imageTools()[0], ctx = { project: { path: project } };
  return { root, project, tool, run: relative => tool.execute({ path: relative }, ctx) };
}

test('images_show returns a project image through the existing image-result contract without modifying the file', async t => {
  const { project, tool, run } = await fixture(t);
  assert.equal(tool.name, 'images_show'); assert.equal(tool.permission, 'read');
  const samples = [['capture.PNG', 'png', png], ['photo.jpg', 'jpeg', Buffer.from([255, 216, 255, 224])], ['plot.webp', 'webp', Buffer.from('RIFF1234WEBP')]];
  for (const [name, format, bytes] of samples) {
    const file = path.join(project, name); await fs.writeFile(file, bytes);
    const result = await run(name);
    assert.deepEqual(result, { path: name, mimeType: `image/${format}`, bytes: bytes.length, image: `data:image/${format};base64,${bytes.toString('base64')}` });
    assert.deepEqual(await fs.readFile(file), bytes);
  }
});

test('images_show rejects unsupported formats, mismatched signatures, directories, and oversized images', async t => {
  const { project, run } = await fixture(t);
  for (const name of ['vector.svg', 'vector.png', 'mismatch.jpg']) await fs.writeFile(path.join(project, name), name === 'mismatch.jpg' ? png : '<svg onload="alert(1)"/>');
  await fs.mkdir(path.join(project, 'folder.png'));
  await fs.writeFile(path.join(project, 'huge.png'), Buffer.alloc(6 * 1024 * 1024));
  await fs.writeFile(path.join(project, 'empty.png'), '');
  await assert.rejects(run('vector.svg'), /PNG, JPEG, or WebP/);
  for (const name of ['vector.png', 'mismatch.jpg', 'empty.png']) await assert.rejects(run(name), /signature|encoding|base64/);
  for (const name of ['folder.png', 'huge.png']) await assert.rejects(run(name));
});

test('images_show enforces project containment and respects cancellation', async t => {
  const { root, project, run, tool } = await fixture(t);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'hidden.png'), png);
  await fs.writeFile(path.join(project, 'valid.png'), png);
  for (const name of ['../outside/hidden.png', path.join(outside, 'hidden.png'), 'valid.png:alternate']) await assert.rejects(run(name), /workspace/);
  await assert.rejects(tool.execute({ path: 'valid.png' }, { project: { path: project }, signal: AbortSignal.abort() }), /abort/i);
  await t.test('directory junctions cannot expose another project', async subtest => {
    const link = path.join(project, 'linked');
    try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') { subtest.skip('This environment does not permit symlink/junction creation'); return; } throw error; }
    await assert.rejects(run('linked/hidden.png'), /Symlink escapes workspace/);
  });
});

test('images_show waits for nested-project authorization and revalidates the path before opening it', async t => {
  const { project, tool } = await fixture(t);
  const file = path.join(project, 'capture.png'); await fs.writeFile(file, png);
  let authorizations = 0;
  await assert.rejects(tool.execute({ path: 'capture.png' }, { project: { path: project }, authorizePath: async target => {
    authorizations++; assert.equal(target, file); throw new Error('Project access denied');
  } }), /Project access denied/);
  assert.equal(authorizations, 1);
  await assert.rejects(tool.execute({ path: 'capture.png' }, { project: { path: project }, authorizePath: async () => { await fs.rename(file, file + '.moved'); } }), /ENOENT/);
});
