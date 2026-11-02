// Explicit opt-in: load existing weights; a second flag permits one tiny GPU inference.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRuntime } from '../core/runtime.mjs';
import { createLocalModels } from '../local-models/index.mjs';

if (!process.argv.includes('--allow-existing-local-load')) throw new Error('Requires --allow-existing-local-load; allocates GPU/RAM until Stop.');
const infer = process.argv.includes('--allow-bundled-gpu-inference');
const contextIndex=process.argv.indexOf('--context-tokens'),contextTokens=contextIndex===-1?null:Number(process.argv[contextIndex+1]);
assert.ok(contextTokens===null||Number.isSafeInteger(contextTokens)&&contextTokens>0&&contextTokens<=2147483647,'--context-tokens requires a positive runtime context size');
const executable = infer ? fileURLToPath(new URL('../release/win-unpacked/resources/local-runtime/llama-server.exe', import.meta.url)) : undefined;
if (executable) assert.ok((await fs.stat(executable)).isFile());
const gpuMemory = async () => (await promisify(execFile)('nvidia-smi.exe', ['--query-gpu=name,memory.total,memory.used,memory.free', '--format=csv,noheader'], { windowsHide: true, timeout: 10000 })).stdout.trim();
const memoryBefore = infer ? await gpuMemory() : undefined;
const original = 'C:\\Users\\youwe\\.ollama\\models\\blobs\\sha256-6aa74acf170f8fb8e6ff8dae9bc9ea918d3a14b6ba95d0b0287da31b09a4848c';
const before = await fs.stat(original); assert.equal(before.size, 3825807040);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'FaberHarness-local-live-')), directory = path.join(root, 'models');
await fs.mkdir(directory); const linked = path.join(directory, 'fixture.gguf'); await fs.link(original, linked);
const secrets = new Map(), children = []; let manager, runtime, startupLog='';
const started = Date.now();
try {
  const sourceDir = path.join(root, 'source'); await fs.mkdir(sourceDir);
  runtime = await createRuntime({ dataDir: path.join(root, 'data'), sourceDir, host: {
    getSecret: async id => secrets.get(id) || '', setSecret: async (id, value) => { secrets.set(id, value); },
    assertProviderAvailable: (providerId, model, options) => manager?.assertProviderAvailable(providerId, model, options),
    providerControls: (providerId,model)=>manager?.providerControls(providerId,model),
  } });
  manager = await createLocalModels({ dataDir: path.join(root, 'data'), runtime, executable, getHubState: async () => ({ downloadDirectory: directory, downloads: [] }), loadTimeoutMs: 180000,
    spawnImpl: (executable, args, options) => { const child = spawn(executable, args, options); children.push(child); for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{startupLog=(startupLog+chunk).slice(-100000);}); return child; },
  });
  const listed = await manager.request('localModels.list'); assert.equal(listed.models.length, 1); assert.equal(listed.models[0].available, true); assert.equal(listed.runtime.available, true);
  const details = await manager.request('localModels.details', {modelId:listed.models[0].id});
  let hardware;
  if (infer) {
    hardware = await manager.request('localModels.hardware'); assert.equal(hardware.runtime.executable, await fs.realpath(executable)); assert.ok(hardware.gpus.length);
    await manager.request('localModels.configure', {mode:'custom',gpuIds:[hardware.gpus[0].id],cpuIds:hardware.cpus.slice(0,4).map(cpu=>cpu.id),threads:Math.min(4,hardware.cpus.length),memoryMap:true});
  }
  await manager.request('localModels.start', { modelId: listed.models[0].id,contextTokens });
  let current;
  while (Date.now() - started < 195000) {
    current = await manager.request('localModels.list');
    if (current.process.status === 'ready') break;
    if (current.process.status === 'failed') throw new Error(`${current.process.error}\nRunner log bytes: ${startupLog.length}\n${startupLog.slice(-8000).replace(/[a-f0-9]{64}/g,'[hash]')}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(current.process.status, 'ready'); const loadElapsedMs = Date.now() - started;
  if(contextTokens!==null){
    assert.equal(current.process.contextCapacityTokens,contextTokens);
    const project=await runtime.request('project.create',{name:'Isolated context proof',path:sourceDir});
    const chat=await runtime.request('chat.create',{projectId:project.id});
    await runtime.request('chat.update',{id:chat.id,providerId:current.process.providerId,model:current.process.model,contextTokens});
    const controls=await runtime.request('chat.controls',{chatId:chat.id});assert.equal(controls.context.capacityTokens,contextTokens);
    await runtime.request('chat.update',{id:chat.id,contextTokens:contextTokens+1024});
    await assert.rejects(runtime.request('chat.send',{chatId:chat.id,text:'This rejected call must never generate.'}),/Restart this downloaded/);
    assert.equal((await runtime.request('state.get')).chats.find(item=>item.id===chat.id).messages.length,0);
  }
  const tested = await runtime.request('provider.test', { id: current.process.providerId });
  assert.ok(tested.models.some(item => (typeof item === 'string' ? item : item.id) === current.process.model));
  let inference, memoryLoaded;
  if (infer) {
    assert.equal(current.process.observed.backend,'gpu'); assert.ok(current.process.observed.gpuLayers > 0);
    memoryLoaded = await gpuMemory();
    const provider = (await runtime.request('state.get')).providers.find(item=>item.id===current.process.providerId);
    assert.equal(new URL(provider.baseUrl).hostname,'127.0.0.1');
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${secrets.get(provider.id)}`},body:JSON.stringify({model:current.process.model,messages:[{role:'user',content:'Reply with the single word READY.'}],max_tokens:12,temperature:0,stream:false})});
    assert.equal(response.status,200); const result=await response.json();
    assert.ok(result.choices?.[0]?.message?.content?.trim()); assert.ok(result.usage?.completion_tokens > 0);
    inference={usage:result.usage,output:result.choices[0].message.content,observed:current.process.observed,requested:current.process.requested,bundledRuntime:hardware.runtime};
  }
  const stopped = await manager.request('localModels.stop'); assert.equal(stopped.process.status, 'stopped');
  assert.ok(children.length === 1 && children.every(child => child.exitCode !== null || child.signalCode));
  assert.ok(!(await fs.readdir(path.join(root, 'data', 'local-models'))).some(name => name.endsWith('.key')));
  const after = await fs.stat(original); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ino, before.ino);
  const report = { ok: true, sourceModel: 'llama2-uncensored:7b (existing Ollama weight)', sourceBytes: before.size, hardLinkOnly: true, loadElapsedMs, ready: true, authenticatedModelListing: true, stoppedAndExited: true, privateKeyFileRemoved: true, inferenceRequests: infer?1:0, downloadedBytes: 0, details,requestedContextTokens:contextTokens,observedContextCapacityTokens:current.process.contextCapacityTokens,
    ...(infer?{inference,gpuMemory:{scope:'Total device memory, including other applications; runner logs independently verify offloaded layers.',before:memoryBefore,loaded:memoryLoaded,afterStop:await gpuMemory()}}:{}) };
  const reportPath = path.join(root, 'report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, reportPath }));
} finally {
  try { await runtime?.close(); }
  finally { try { await manager?.close(); } finally { secrets.clear(); await fs.rm(linked, { force: true }); } }
}
