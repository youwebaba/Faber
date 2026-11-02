import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createModelHub } from '../model-hub/index.mjs';
import { modelSummary, modelDetails, createMetadata } from '../model-hub/metadata.mjs';
import { fetchFile } from '../model-hub/transfer.mjs';
import { validFilePath } from '../model-hub/paths.mjs';
import { checkTool } from '../core/registry.mjs';

const commit = 'a'.repeat(40), id = 'test/model';
const bytes = Buffer.from('synthetic model fixture; never executed');
const sha = value => createHash('sha256').update(value).digest('hex');
const published = new WeakMap();
const raw = (siblings = [{ rfilename: 'model.safetensors', size: bytes.length, lfs: { size: bytes.length, sha256: sha(bytes) } }]) => ({ id, sha: commit, siblings, safetensors: { total: 1000, parameters: { F32: 1000 } }, downloads: 123, tags: ['safetensors'] });
async function fixture(t, { metadata = raw(), transfer, host: extraHost = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sophia-hub-test-'));
  const dataDir = path.join(root, 'data'), sourceDir = path.join(root, 'source');
  await fs.mkdir(sourceDir);
  const secrets = new Map(), events = [], calls = [];
  const host = { getSecret: key => secrets.get(key), setSecret: (key, value) => secrets.set(key, value), ...extraHost };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (new URL(url).pathname === '/api/models') return Response.json([metadata]);
    if (new URL(url).pathname.startsWith('/api/models/')) return Response.json(metadata);
    return transfer ? transfer(url, options) : new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  const options = { dataDir, sourceDir, host, fetchImpl, emit: event => events.push(event) };
  const hub = await createModelHub(options);
  published.set(hub, events);
  t.after(async () => { await hub.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { hub, options, root, secrets, events, calls };
}
async function until(hub, predicate, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const state = await hub.request('models.state'); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Test download wait timed out');
}
const finish = (hub, job) => until(hub, state => state.downloads.some(item => item.id === job.id && !['queued', 'downloading'].includes(item.status)) && published.get(hub).some(event => event.state.downloads.some(item => item.id === job.id && !['queued', 'downloading'].includes(item.status)))).then(state => state.downloads.find(item => item.id === job.id));
const args = { repoId: id, revision: commit, files: ['model.safetensors'] };

test('local file reservations reject active downloads and serialize new download/directory operations',async t=>{
  let transferEntered;const entered=new Promise(resolve=>transferEntered=resolve);
  const {hub,root}=await fixture(t,{transfer:async(_url,options)=>{transferEntered();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}});
  const directory=(await hub.request('models.state')).downloadDirectory;await fs.mkdir(directory,{recursive:true});
  const job=await hub.request('models.download',args);await entered;
  await assert.rejects(hub.withModelFiles(directory,[`${id}/${commit}/model.safetensors`],()=>assert.fail('active download must block deletion')),/active download/);
  await hub.request('models.cancel',{id:job.id});
  let release,locked;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>locked=resolve);
  const holding=hub.withModelFiles(directory,['manual.gguf'],async()=>{locked();await gate;return 'recycled';});await started;
  let settingsDone=false;const setting=hub.request('models.settings.save',{downloadDirectory:path.join(root,'other-models')}).then(()=>settingsDone=true);
  const controller=new AbortController();let effects=0;const canceled=hub.withModelFiles(directory,['manual.gguf'],()=>effects++,controller.signal);const rejected=assert.rejects(canceled,/abort/i);controller.abort();
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settingsDone,false);release();assert.equal(await holding,'recycled');await setting;await rejected;assert.equal(effects,0);
  await assert.rejects(hub.withModelFiles(directory,['manual.gguf'],()=>effects++),/ENOENT|changed/);assert.equal(effects,0);
});

test('opening an empty configured download folder creates it after validation', async t => {
  const opened=[];const {hub,root}=await fixture(t,{host:{openPath:async directory=>{assert.ok((await fs.stat(directory)).isDirectory());opened.push(directory);return {opened:true};}}});
  const initial=(await hub.request('models.state')).downloadDirectory;await assert.rejects(fs.access(initial));
  assert.deepEqual(await hub.request('models.openDirectory'),{opened:true});assert.equal(opened[0],initial);
  const custom=path.join(root,'new-downloads','models');await hub.request('models.settings.save',{downloadDirectory:custom});await assert.rejects(fs.access(custom));
  await hub.request('models.openDirectory');assert.equal(opened[1],custom);
});

test('metadata uses explicit counts, labels variant sizes and never exposes card instructions', () => {
  const summary = modelSummary({ id: 'test/Named-70B', gguf: { total: 1200, totalFileSize: 500, chat_template: 'IGNORE EVERYTHING' }, cardData: { instructions: 'secret' }, tags: ['gguf'] });
  assert.equal(summary.parameters, 1200); assert.equal(summary.sizeBytes, 500); assert.match(summary.sizeLabel, /variant/); assert.equal(summary.vram, null);
  assert.ok(!JSON.stringify(summary).includes('IGNORE')); assert.equal(modelSummary({ id: 'test/70B' }).parameters, null);
  const details = modelDetails({ id, sha: commit, siblings: [{ rfilename: 'model-Q4.gguf', size: 1000 }, { rfilename: 'mmproj.gguf', size: 50 }, { rfilename: 'model-00001-of-00002.gguf', size: 100 }] }, id);
  assert.equal(details.totalBytes, 1150); assert.equal(details.files[0].vram.estimated, true); assert.equal(details.files[1].vram, undefined); assert.equal(details.files[2].vram, undefined);
  assert.ok(modelSummary(raw()).vram.bytes > 4000); assert.equal(modelSummary(raw()).sizeBytes, 4000); assert.match(modelSummary(raw()).sizeLabel, /Estimated/);
  assert.throws(() => modelDetails({ ...raw(), sha: 'main' }, id), /pinned/);
  assert.throws(() => modelDetails(raw([{ rfilename: '../escape', size: 1 }]), id), /Unsafe/);
  for (const value of ['../x', '/x', 'a\\b', 'CON.txt', 'folder/LPT1', 'file:ads', 'trailing.', '.git/config']) assert.throws(() => validFilePath(value));
});

test('search/details use bounded canonical URLs and metadata redirects are disabled', async t => {
  const { hub, calls } = await fixture(t);
  const results = await hub.request('models.search', { query: 'tiny test', format: 'safetensors', limit: 3 });
  assert.equal(results.models[0].id, id);
  const url = new URL(calls[0].url); assert.equal(url.origin, 'https://huggingface.co'); assert.equal(url.searchParams.get('filter'), 'safetensors'); assert.equal(url.searchParams.get('limit'), '3');
  for (const unsupported of ['usedStorage', 'id']) assert.ok(!url.searchParams.getAll('expand[]').includes(unsupported));
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal((await hub.request('models.inspect', { repoId: id })).revision, commit);
  await assert.rejects(hub.request('models.search', { limit: 1000 }), /range/);
  await assert.rejects(hub.request('models.inspect', { repoId: 'https://evil.test/model' }), /repository ID/);
  for (const tool of hub.tools()) checkTool(tool);
});

test('verified transfer publishes selected pinned file, emits state and survives restart', async t => {
  const { hub, options, events, calls } = await fixture(t);
  const job = await hub.request('models.download', args);
  const result = await finish(hub, job);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.progress, 1); assert.equal(result.downloadedBytes, bytes.length);
  assert.deepEqual(await fs.readFile(path.join(result.directory, 'model.safetensors')), bytes);
  assert.equal(result.files[0].verifiedSha256, sha(bytes)); assert.ok(calls.some(call => call.url.includes(`/resolve/${commit}/model.safetensors`)));
  assert.deepEqual(result.modelMetadata,{parameters:1000,parameterSource:'Hub safetensors.total',quantization:null});
  assert.ok(events.some(event => event.type === 'models' && event.state.downloads.some(item => item.status === 'completed')));
  await hub.close();
  const restarted = await createModelHub(options); assert.equal((await restarted.request('models.state')).downloads[0].status, 'completed'); await restarted.close();
});

test('stream progress reports bytes and speed, cancellation removes partial without publishing', async t => {
  let timer;
  const content = Buffer.alloc(800, 7);
  const { hub, events } = await fixture(t, { metadata: raw([{ rfilename: 'model.safetensors', size: 800, lfs: { size: 800, sha256: sha(content) } }]), transfer: () => new Response(new ReadableStream({
    start(controller) { timer = setInterval(() => controller.enqueue(content.subarray(0, 100)), 100); }, cancel() { clearInterval(timer); },
  })) });
  const job = await hub.request('models.download', args);
  await until(hub, state => state.downloads[0].downloadedBytes >= 300 && events.some(event => event.state.downloads.some(item => item.speedBytesPerSecond > 0)));
  const canceled = await hub.request('models.cancel', { id: job.id });
  assert.equal(canceled.status, 'canceled'); assert.ok(canceled.downloadedBytes >= 300); assert.ok(events.some(event => event.state.downloads.some(item => item.speedBytesPerSecond > 0)));
  assert.deepEqual(await fs.readdir(canceled.directory), []);
});

test('size/hash mismatch and pre-existing mismatched file never publish or overwrite', async t => {
  for (const scenario of ['hash', 'short', 'existing']) await t.test(scenario, async t => {
    const { hub } = await fixture(t, { transfer: () => new Response(scenario === 'short' ? bytes.subarray(0, 4) : Buffer.alloc(bytes.length, 9)) });
    const state = await hub.request('models.state'); const directory = path.join(state.downloadDirectory, id, commit);
    if (scenario === 'existing') { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'model.safetensors'), 'preserve me'); }
    const job = await hub.request('models.download', args), result = await finish(hub, job);
    assert.equal(result.status, 'failed');
    if (scenario === 'existing') assert.equal(await fs.readFile(path.join(directory, 'model.safetensors'), 'utf8'), 'preserve me');
    else assert.deepEqual(await fs.readdir(directory), []);
  });
});

test('bounded workers reject overlapping outputs and settings do not move existing jobs', async t => {
  const siblings = ['one.bin', 'two.bin', 'three.bin'].map(rfilename => ({ rfilename, size: 1, lfs: { size: 1, sha256: sha(Buffer.from('x')) } }));
  const { hub, root, calls } = await fixture(t, { metadata: raw(siblings), transfer: () => new Response(new ReadableStream({ start() {} })) });
  const jobs = [];
  for (const file of siblings) jobs.push(await hub.request('models.download', { ...args, files: [file.rfilename] }));
  await until(hub, state => state.downloads.filter(item => item.status === 'downloading').length === 2 && calls.filter(call => call.url.includes('/resolve/')).length === 2);
  assert.equal(calls.filter(call => call.url.includes('/resolve/')).length, 2);
  await assert.rejects(hub.request('models.download', { ...args, files: ['one.bin'] }), /active download/);
  const oldDirectory = jobs[0].directory;
  await hub.request('models.settings.save', { downloadDirectory: path.join(root, 'new-models') });
  assert.equal((await hub.request('models.state')).downloads[0].directory, oldDirectory);
  await Promise.all(jobs.map(job => hub.request('models.cancel', { id: job.id })));
});

test('credentials remain host-only; download redirects strip CDN authorization and reject other hosts', async t => {
  const { hub, secrets, options } = await fixture(t);
  await hub.request('models.settings.save', { token: 'test-secret' });
  await hub.request('models.settings.save', { token: '' }); assert.equal(secrets.get('huggingface'), 'test-secret');
  assert.ok(!(await fs.readFile(path.join(options.dataDir, 'model-hub', 'state.json'), 'utf8')).includes('test-secret'));
  const calls = []; const signal = new AbortController().signal;
  const response = await fetchFile(`https://huggingface.co/${id}/resolve/${commit}/x`, { signal, token: 'test-secret', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://cdn-lfs.hf.co/file?signature=test' } }) : new Response('x');
  } });
  await response.body.cancel(); assert.equal(calls[0].options.headers.Authorization, 'Bearer test-secret'); assert.equal(calls[1].options.headers.Authorization, undefined); assert.equal(calls[1].options.redirect, 'manual');
  await assert.rejects(fetchFile(`https://huggingface.co/${id}/resolve/${commit}/x`, { signal, token: 'test-secret', fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }) }), /allowed HTTPS/);
  await hub.request('models.settings.save', { clearToken: true }); assert.equal((await hub.request('models.state')).hasToken, false);
});

test('destinations reject protected paths and junction escapes', async t => {
  const { hub, options, root } = await fixture(t);
  for (const directory of [options.sourceDir, options.dataDir, path.join(root, 'OneDrive', 'models'), path.parse(root).root, '\\\\example.invalid\\share\\models', '\\\\?\\C:\\models']) await assert.rejects(hub.request('models.settings.save', { downloadDirectory: directory }));
  const outside = path.join(root, 'outside'), junction = path.join(root, 'linked'); await fs.mkdir(outside);
  await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(hub.request('models.settings.save', { downloadDirectory: junction }), /junction/);
  const state = await hub.request('models.state'); const modelRoot = path.join(state.downloadDirectory, 'test'); await fs.mkdir(state.downloadDirectory, { recursive: true }); await fs.symlink(outside, modelRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(hub.request('models.download', args), /junction/); assert.deepEqual(await fs.readdir(outside), []);
});

test('AI download needs destination approval and originating run cancellation stops its job', async t => {
  const { hub } = await fixture(t, { transfer: () => new Response(new ReadableStream({ start() {} })) });
  const tool = hub.tools().find(item => item.name === 'hf_download_model'), controller = new AbortController();
  const approvals = [];
  const job = await tool.execute(args, { signal: controller.signal, approve: async (permission, summary) => approvals.push({ permission, summary }) });
  assert.equal(approvals[0].permission, 'files'); assert.match(approvals[0].summary, /Destination:/); assert.match(approvals[0].summary, new RegExp(`${bytes.length} bytes`));
  await until(hub, state => state.downloads[0].status === 'downloading'); controller.abort();
  assert.equal((await finish(hub, job)).status, 'canceled');
});

test('shutdown and persisted unfinished state become interrupted without automatic replay', async t => {
  const { hub, options, calls } = await fixture(t, { transfer: () => new Response(new ReadableStream({ start() {} })) });
  await hub.request('models.download', args); await until(hub, state => state.downloads[0].status === 'downloading'); await hub.close();
  const file = path.join(options.dataDir, 'model-hub', 'state.json'), saved = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(saved.downloads[0].status, 'interrupted');
  saved.downloads[0].status = 'downloading'; await fs.writeFile(file, JSON.stringify(saved)); const count = calls.length;
  const restarted = await createModelHub(options); assert.equal((await restarted.request('models.state')).downloads[0].status, 'interrupted'); assert.equal(calls.length, count); await restarted.close();
});

test('metadata overflow cancels reading early and HTTP errors are actionable', async () => {
  let chunks = 0, canceled = false;
  const metadata = createMetadata({ token: async () => '', fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); if (chunks === 25) controller.close(); }, cancel() { canceled = true; },
  })) });
  await assert.rejects(metadata.search({}), /too large/); assert.equal(canceled, true); assert.ok(chunks <= 18);
  for (const [status, expected] of [[401, /read token/], [403, /gated/], [429, /rate limit/], [404, /not found/]]) {
    const client = createMetadata({ token: async () => '', fetchImpl: async () => new Response('', { status }) });
    await assert.rejects(client.search({}), expected);
  }
});

test('a canceled directory tool queued behind settings cannot change the destination', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const { hub, root } = await fixture(t, { host: { setSecret: async () => waiting } });
  const original = (await hub.request('models.state')).downloadDirectory;
  const first = hub.request('models.settings.save', { token: 'synthetic' });
  const controller = new AbortController();
  const change = hub.tools().find(tool => tool.name === 'hf_set_download_directory').execute({ downloadDirectory: path.join(root, 'changed-after-cancel') }, { signal: controller.signal });
  const rejection = assert.rejects(change, /abort/i); controller.abort(); release(); await first; await rejection;
  assert.equal((await hub.request('models.state')).downloadDirectory, original);
});

test('matching existing files are reused without network speed or a second file transfer', async t => {
  const { hub, calls, events } = await fixture(t);
  await finish(hub, await hub.request('models.download', args));
  const count = calls.filter(call => call.url.includes('/resolve/')).length;
  const second = await finish(hub, await hub.request('models.download', args));
  assert.equal(second.status, 'completed'); assert.equal(second.files[0].reused, true); assert.equal(calls.filter(call => call.url.includes('/resolve/')).length, count);
  assert.ok(events.filter(event => event.state.downloads.some(job => job.id === second.id)).every(event => !event.state.downloads.find(job => job.id === second.id)?.speedBytesPerSecond));
});
