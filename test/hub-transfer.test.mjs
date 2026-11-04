import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { transferFile } from '../model-hub/transfer.mjs';

const MiB = 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function payload(size) {
  const bytes = Buffer.alloc(size + 11);
  for (let index = 0; index < size; index++) bytes[index + 7] = index % 251;
  return bytes.subarray(7, size + 7);
}
function stream(chunks, canceled = () => {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); },
    cancel: canceled,
  }, { highWaterMark: 0 });
}
async function fixture(t, bytes, size = bytes.length) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'faber-transfer-test-'));
  const job = { directory: path.join(root, 'models'), repoId: 'fixture/model', revision: 'a'.repeat(40) };
  const file = { path: 'model.gguf', size, sha256: sha(bytes), bytes: 0, status: 'queued' }, controller = new AbortController(), progress = [];
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    job, file, controller, progress, target: path.join(job.directory, file.path),
    run: body => transferFile({ job, file, signal: controller.signal, fetchImpl: async () => new Response(body), progress: () => progress.push({ bytes: file.bytes, status: file.status }) }),
  };
}
function partialWrites(t, write) {
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.partial')) {
      const original = handle.write.bind(handle);
      t.mock.method(handle, 'write', (...args) => write(original, ...args));
    }
    return handle;
  });
}

test('batched transfer preserves offset views, varied and oversized chunks, and the final tail', async t => {
  for (const knownSize of [true, false]) await t.test(knownSize ? 'advertised size' : 'hash-only size', async t => {
    const bytes = payload(2 * MiB + 137), f = await fixture(t, bytes, knownSize ? bytes.length : null);
    const boundaries = [0, 3, 16384, 16385, MiB + 32791, bytes.length];
    const chunks = [Buffer.alloc(0), ...boundaries.slice(1).map((end, index) => bytes.subarray(boundaries[index], end))];
    await f.run(stream(chunks));
    assert.deepEqual(await fs.readFile(f.target), bytes);
    assert.equal(f.file.verifiedSha256, sha(bytes)); assert.equal(f.file.size, bytes.length); assert.equal(f.file.bytes, bytes.length); assert.equal(f.file.status, 'completed');
    assert.deepEqual(await fs.readdir(f.job.directory), ['model.gguf']);
    assert.equal(f.progress.at(-1).status, 'completed'); assert.equal(f.progress.at(-1).bytes, bytes.length);
    assert.ok(f.progress.every((entry, index) => entry.bytes >= (f.progress[index - 1]?.bytes ?? 0) && entry.bytes <= bytes.length));
  });
});

test('canceling with an unflushed tail cancels the reader and removes the partial without publication', { timeout: 3000 }, async t => {
  const bytes = payload(1024), f = await fixture(t, bytes);
  let pull = 0, canceled = false, blocked;
  const waiting = new Promise(resolve => { blocked = resolve; });
  const body = new ReadableStream({
    pull(controller) { if (pull++ === 0) controller.enqueue(bytes.subarray(0, 511)); else blocked(); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  const work = assert.rejects(f.run(body), /Canceled buffered transfer/);
  await waiting;
  assert.equal(f.file.bytes, 0, 'Buffered bytes must not be reported as written');
  f.controller.abort(new Error('Canceled buffered transfer')); await work;
  assert.equal(canceled, true); assert.notEqual(f.file.status, 'completed'); assert.deepEqual(await fs.readdir(f.job.directory), []);
});

test('advertised-size overflow counts an unflushed tail before accepting the next network chunk', async t => {
  const bytes = payload(1000), f = await fixture(t, bytes); let canceled = false;
  await assert.rejects(f.run(stream([bytes.subarray(0, 600), payload(500)], () => { canceled = true; })), /exceed the advertised file size/);
  assert.equal(canceled, true); assert.equal(f.file.bytes, 0); assert.notEqual(f.file.status, 'completed'); assert.deepEqual(await fs.readdir(f.job.directory), []);
});

test('short disk writes are retried at the right offset without losing or repeating bytes', async t => {
  const bytes = payload(MiB + 71), f = await fixture(t, bytes), requests = [];
  partialWrites(t, (write, buffer, offset, length, position) => {
    requests.push({ offset, length }); return write(buffer, offset, Math.min(length, 64 * 1024), position);
  });
  await f.run(stream([bytes]));
  assert.ok(requests.length > 2); assert.ok(requests.some(call => call.offset > 0 && call.length > 64 * 1024));
  assert.deepEqual(await fs.readFile(f.target), bytes); assert.equal(f.file.verifiedSha256, sha(bytes)); assert.equal(f.file.bytes, bytes.length); assert.equal(f.file.status, 'completed');
});

test('write errors and zero-byte writes clean up a partially written batch', async t => {
  for (const mode of ['error', 'zero']) await t.test(mode, async t => {
    const bytes = payload(MiB + 1), f = await fixture(t, bytes); let writes = 0, canceled = false;
    partialWrites(t, async (write, buffer, offset, length, position) => {
      if (++writes === 1) return write(buffer, offset, Math.min(length, 64 * 1024), position);
      if (mode === 'zero') return { bytesWritten: 0, buffer };
      throw Object.assign(new Error('Fixture disk failure'), { code: 'ENOSPC' });
    });
    await assert.rejects(f.run(stream([bytes], () => { canceled = true; })), mode === 'zero' ? /Unable to write downloaded file/ : /Fixture disk failure/);
    assert.equal(writes, 2); assert.equal(canceled, true); assert.equal(f.file.bytes, 0); assert.notEqual(f.file.status, 'completed'); assert.deepEqual(await fs.readdir(f.job.directory), []);
  });
});

test('a destination appearing after the initial check is never overwritten by publication', async t => {
  const bytes = payload(MiB + 33), f = await fixture(t, bytes), competing = 'Keep this independently created file';
  await assert.rejects(transferFile({
    job: f.job, file: f.file, signal: f.controller.signal, progress: () => {},
    fetchImpl: async () => { await fs.writeFile(f.target, competing, { flag: 'wx' }); return new Response(stream([bytes])); },
  }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(f.target, 'utf8'), competing); assert.notEqual(f.file.status, 'completed'); assert.equal(f.file.verifiedSha256, undefined);
  assert.deepEqual(await fs.readdir(f.job.directory), ['model.gguf']);
});
