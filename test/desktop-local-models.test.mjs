import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createLocalModels } from '../local-models/index.mjs';
import { checkTool } from '../core/registry.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const header = () => { const bytes = Buffer.alloc(24); bytes.write('GGUF'); bytes.writeUInt32LE(3, 4); return bytes; };

test('Ollama aliases share active-run and synchronous lifecycle guards by endpoint and model', async t => {
  const state = { providers: [
    { id: 'one', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', hasKey: false },
    { id: 'two', kind: 'ollama', baseUrl: 'http://localhost:11434/', hasKey: false },
  ], runs: [{ id: 'active', providerId: 'one', model: 'fixture:latest', status: 'running', modelCalls: [{}] }] };
  let requests = 0;
  const runtime = { request: async () => structuredClone(state) };
  const f = await fixture(t, { runtime, fetchImpl: async (_url, options) => { requests++; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); } });
  await assert.rejects(f.manager.request('localModels.stop', { providerId: 'two', model: 'fixture' }), /Stop chats/); assert.equal(requests, 0);
  state.runs = []; const controller = new AbortController();
  const stopping = f.manager.request('localModels.stop', { providerId: 'two', model: 'fixture' }, controller.signal);
  assert.throws(() => f.manager.assertProviderAvailable('one', 'fixture:latest'), /finish loading or stopping/);
  while (!requests) await pause(1); controller.abort(new Error('fixture canceled')); await assert.rejects(stopping, /fixture canceled/);
  assert.doesNotThrow(() => f.manager.assertProviderAvailable('one', 'fixture:latest'));
});
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faber-local-manager-')), directory = path.join(root, 'models'); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'fixture-Q4_K_M.gguf'), header());
  const state = { providers: [{ id: 'unrelated', name: 'Preserve this', kind: 'openai', baseUrl: 'https://example.com/v1', model: 'unrelated' }], runs: [], chats: [{ id: 'chat', providerId: 'unrelated', model: 'unrelated' }] };
  const secrets = new Map(), children = [], events = [], readiness = { ready: false }, calls = [], listeners=new Set();
  const runtime = {subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},async request(method, args) { calls.push(method); if (method === 'state.get') return structuredClone(state); if (method === 'provider.save') { secrets.set(args.id, args.apiKey); const provider = { ...args, hasKey: true }; delete provider.apiKey; const existing = state.providers.find(item => item.id === args.id); if (existing) Object.assign(existing, provider); else state.providers.push(provider);for(const listener of listeners)listener({type:'state',state:structuredClone(state)}); return provider; } throw new Error(method); } };
  const options = { dataDir: path.join(root, 'data'), runtime, getHubState: async () => ({ downloadDirectory: directory, downloads: [] }), executable: process.execPath, pollMs: 5, loadTimeoutMs: 1000,
    hardwareRunner:async(_executable,args)=>({code:0,stdout:args[0]==='--help'?'--device --n-gpu-layers --threads-batch --cpu-mask-batch --cpu-strict-batch --load-mode --list-devices --ctx-size --parallel':args[0]==='--version'?'Synthetic fixture runtime':'Available devices:\n  CUDA0: Fixture GPU (8192 MiB, 7000 MiB free)',stderr:''}),
    emit: event => events.push(event),
    spawnImpl(executable, args, options) {
      const child = new EventEmitter(); Object.assign(child, { pid: 12345 + children.length, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), args, options, executable }); children.push(child); return child;
    },
    killProcess: async child => { if (child && child.exitCode === null) { child.exitCode = 0; child.emit('close', 0); } },
    fetchImpl: async (url, options) => { const child = children.at(-1); if (String(url).endsWith('/health')) return Response.json(readiness.ready ? { status: 'ok' } : { error: 'Loading' }, { status: readiness.ready ? 200 : 503 }); const key = await fs.readFile(child.args[child.args.indexOf('--api-key-file') + 1], 'utf8'); assert.equal(options.headers.Authorization, `Bearer ${key}`); if(String(url).endsWith('/props'))return Response.json({chat_template:readiness.template,default_generation_settings:{n_ctx:readiness.capacity??(child.args.includes('--ctx-size')?Number(child.args[child.args.indexOf('--ctx-size')+1]):2048)}}); return Response.json({ data: [{ id: child.args[child.args.indexOf('--alias') + 1] }] }); }, ...extra };
  const manager = await createLocalModels(options);
  t.after(async () => { await manager.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { manager, options, root, directory, state, secrets, children, events, readiness, calls };
}
async function until(manager, status) { for (let i = 0; i < 300; i++) { const state = await manager.request('localModels.list'); if (state.process.status === status) return state; await pause(5); } throw new Error(`Expected ${status}`); }

test('native MTP must be confirmed at readiness, persists per target, reports counters and refuses missing heads before spawning',async t=>{
 const tensors=['eh_proj','enorm','hnorm','shared_head_norm'].map(part=>({name:`blk.24.nextn.${part}.weight`,elements:1024}));let heads=true,f;
 f=await fixture(t,{speculationReader:async()=>({architecture:'qwen35',complete:true,tensors:heads?tensors:[],splitCount:null}),hardwareRunner:async(_exe,args)=>({code:0,stdout:args[0]==='--help'?'--device --n-gpu-layers --threads-batch --load-mode --ctx-size --parallel --verbosity --spec-type draft-mtp draft-simple --spec-draft-model --spec-draft-n-max --slots --spec-draft-device --spec-draft-ngl':'Fixture runtime',stderr:''}),fetchImpl:async url=>String(url).endsWith('/health')?Response.json({}, {status:f.readiness.ready?200:503}):String(url).endsWith('/props')?Response.json({}):String(url).endsWith('/slots')?Response.json([{speculative:true}]):Response.json({data:[{id:f.children.at(-1).args[f.children.at(-1).args.indexOf('--alias')+1]}]})});
 const model=(await f.manager.request('localModels.list')).models[0],profile={mode:'native_mtp',tokens:4};await f.manager.request('localModels.start',{modelId:model.id,speculation:profile});f.children[0].stderr.write("I spec common_specu: adding speculative implementation 'draft-mtp'\nI spec common_specu: - n_max=4, n_min=0, p_min=0.00\n");f.readiness.ready=true;const ready=await until(f.manager,'ready');assert.deepEqual(ready.models[0].speculation,profile);assert.equal(ready.process.observed.speculation.implementation,'draft-mtp');
 f.children[0].stderr.write('I slot print_timing: id 0 | task 0 | draft acceptance = 0.75 (3 accepted / 4 generated)\n');await pause(2);assert.equal((await f.manager.request('localModels.list')).process.observed.speculation.metrics.acceptedTokens,3);await f.manager.request('localModels.stop');
 heads=false;await assert.rejects(f.manager.request('localModels.start',{modelId:model.id}),/no complete embedded/);assert.equal(f.children.length,1);await assert.rejects(f.manager.request('localModels.start',{providerId:'unrelated',model:'remote',speculation:profile}),/owned downloaded/);
 heads=true;await f.manager.request('localModels.start',{modelId:model.id});await until(f.manager,'failed');assert.equal(f.children[1].exitCode,0,'Missing effective implementation stops the process instead of silently disabling MTP');
});

test('unknown future speculation remains lossless across startup and unrelated settings saves, and refuses implicit Start',async t=>{
 const f=await fixture(t),model=(await f.manager.request('localModels.list')).models[0];await f.manager.close();const filename=path.join(f.options.dataDir,'local-models','state.json'),state={version:1,providerId:null},future={mode:'future_mtp',tokens:24,opaque:{keep:true}};state.speculationProfiles={[model.id]:future};await fs.writeFile(filename,JSON.stringify(state));const reopened=await createLocalModels(f.options);t.after(()=>reopened.close());const listed=await reopened.request('localModels.list');assert.equal(listed.models[0].speculation,null);assert.match(listed.models[0].speculationWarning,/Choose a supported/);await assert.rejects(reopened.request('localModels.start',{modelId:model.id}),/Choose a supported/);await reopened.request('localModels.configure',listed.configuration);await reopened.close();assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')).speculationProfiles,{[model.id]:future});assert.equal(f.children.length,0);
});

test('Stop cancels bounded speculation metadata preparation before any child or key is created',async t=>{
 let inspecting=false;const f=await fixture(t,{speculationReader:async(_file,{signal})=>{inspecting=true;return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}}),model=(await f.manager.request('localModels.list')).models[0];const starting=f.manager.request('localModels.start',{modelId:model.id,speculation:{mode:'native_mtp',tokens:3}}),rejected=assert.rejects(starting,/canceled/);while(!inspecting)await pause(1);const stopped=await f.manager.request('localModels.stop');await rejected;assert.equal(stopped.process.status,'stopped');assert.equal(f.children.length,0);assert.ok(!(await fs.readdir(path.join(f.options.dataDir,'local-models'))).some(name=>name.endsWith('.key')));
});

test('owned GGUF lifecycle uses validated files, registers only after readiness, preserves chat/provider and unloads process', async t => {
  const f = await fixture(t); const listed = await f.manager.request('localModels.list'); for (const tool of f.manager.tools()) checkTool(tool);
  const started = await f.manager.request('localModels.start', { modelId: listed.models[0].id }); assert.equal(started.process.status, 'loading'); assert.equal(f.state.providers.length, 1); assert.equal(f.state.chats[0].providerId, 'unrelated');
  const child = f.children[0]; assert.equal(child.options.windowsHide, true); assert.ok(child.args.includes('--offline')); assert.ok(child.args.includes('--no-webui')); assert.ok(child.args.includes('--no-mmproj')); assert.equal(child.args[child.args.indexOf('--host') + 1], '127.0.0.1'); assert.ok(!child.args.includes('--ctx-size'));
  await assert.rejects(f.manager.request('localModels.start', { modelId: listed.models[0].id }), /Stop the current/);
  f.readiness.ready = true; const ready = await until(f.manager, 'ready'); assert.equal(f.state.providers.length, 2); assert.equal(ready.process.providerId, ready.managedProviderId); f.manager.assertProviderAvailable(ready.process.providerId, ready.process.model);
  f.state.runs.push({ id: 'busy', providerId: ready.process.providerId, model: ready.process.model, modelCalls: [{}], status: 'running' });
  await assert.rejects(f.manager.request('localModels.stop'), /Stop chats/); assert.equal(child.exitCode, null); f.manager.assertProviderAvailable(ready.process.providerId, ready.process.model);
  f.state.runs[0].status = 'completed'; const stopped = await f.manager.request('localModels.stop'); assert.equal(stopped.process.status, 'stopped'); assert.equal(child.exitCode, 0); assert.throws(() => f.manager.assertProviderAvailable(ready.process.providerId, ready.process.model), /Start this/);
  await assert.rejects(fs.access(child.args[child.args.indexOf('--api-key-file') + 1])); assert.ok(!JSON.stringify(f.events).includes(f.secrets.get(ready.process.providerId)));
  await f.manager.close(); const reopened = await createLocalModels(f.options); try { assert.equal((await reopened.request('localModels.list')).managedProviderId, ready.managedProviderId); assert.throws(() => reopened.assertProviderAvailable(ready.process.providerId, ready.process.model), /Start this/); } finally { await reopened.close(); }
});

test('native load quantization cannot silently affect GGUF or external Ollama routes',async t=>{
  const f=await fixture(t),model=(await f.manager.request('localModels.list')).models[0];
  await assert.rejects(f.manager.request('localModels.start',{modelId:model.id,quantization:{mode:'q4_0'}}),/Safetensors packages only/);
  await assert.rejects(f.manager.request('localModels.start',{providerId:'unrelated',model:'fixture',quantization:{mode:'q8_0'}}),/Configure external Ollama separately/);
  await assert.rejects(f.manager.request('localModels.start',{modelId:model.id,quantization:{mode:'q4_0',shell:true}}));
  assert.equal(f.children.length,0);
});

test('managed model labels retain the scanner name after Stop and restart without changing the API alias',async t=>{
  const f=await fixture(t);const listed=await f.manager.request('localModels.list'),model=listed.models[0];
  assert.deepEqual(listed.modelLabels,[]);assert.equal(f.manager.modelDisplayName('unrelated','unrelated'),null);
  f.readiness.ready=true;await f.manager.request('localModels.start',{modelId:model.id});const ready=await until(f.manager,'ready');
  const {providerId,model:alias}=ready.process,label={providerId,model:alias,displayName:model.label,modelId:model.id};
  assert.equal(alias,`faber-${model.id.slice(0,16)}`);assert.deepEqual(ready.modelLabels,[label]);
  assert.equal(f.manager.modelDisplayName(providerId,alias),model.label);
  assert.equal(f.state.providers.find(item=>item.id===providerId).model,alias);
  const stopped=await f.manager.request('localModels.stop');assert.deepEqual(stopped.modelLabels,[label]);
  await f.manager.close();await fs.rename(path.join(f.directory,model.relativePath),path.join(f.directory,'renamed.gguf'));
  const reopened=await createLocalModels(f.options);try{
    assert.equal(reopened.modelDisplayName(providerId,alias),model.label);
    assert.deepEqual((await reopened.request('localModels.list')).modelLabels,[label]);
    assert.equal(reopened.modelDisplayName(providerId,'different-model'),null);
  }finally{await reopened.close();}
});

test('legacy managed connections recover a name only from an exact scanned model alias',async t=>{
  const f=await fixture(t);const model=(await f.manager.request('localModels.list')).models[0],alias=`faber-${model.id.slice(0,16)}`,providerId='legacy-local',baseUrl='http://127.0.0.1:1234/v1';
  await f.manager.close();
  await fs.writeFile(path.join(f.options.dataDir,'local-models','state.json'),JSON.stringify({version:1,providerId,connection:{baseUrl,model:alias}}));
  await f.options.runtime.request('provider.save',{id:providerId,name:'Downloaded GGUF (local)',kind:'openai',baseUrl,model:alias,apiKey:'fixture-key'});
  const reopened=await createLocalModels(f.options);try{
    assert.equal(reopened.modelDisplayName(providerId,alias),null);
    assert.deepEqual((await reopened.request('localModels.list')).modelLabels,[{providerId,model:alias,displayName:model.label,modelId:model.id}]);
    assert.equal(reopened.modelDisplayName(providerId,alias),model.label);
    await fs.appendFile(path.join(f.directory,model.relativePath),'changed');
    assert.deepEqual((await reopened.request('localModels.list')).modelLabels,[]);
    assert.equal(reopened.modelDisplayName(providerId,alias),null);
  }finally{await reopened.close();}
});

test('managed model names do not label edited connections, different models or copied providers',async t=>{
  const f=await fixture(t);const model=(await f.manager.request('localModels.list')).models[0];f.readiness.ready=true;
  await f.manager.request('localModels.start',{modelId:model.id});const ready=await until(f.manager,'ready');
  const provider={...f.state.providers.find(item=>item.id===ready.process.providerId)};
  await f.options.runtime.request('provider.save',{...provider,id:'copied-provider'});
  assert.equal(f.manager.modelDisplayName('copied-provider',provider.model),null);
  for(const change of [{baseUrl:'https://example.com/v1'},{kind:'openai-responses'},{model:'different-model'}]){
    await f.options.runtime.request('provider.save',{...provider,...change});
    assert.equal(f.manager.modelDisplayName(provider.id,provider.model),null);
    assert.deepEqual((await f.manager.request('localModels.list')).modelLabels,[]);
    await f.options.runtime.request('provider.save',provider);
    assert.equal(f.manager.modelDisplayName(provider.id,provider.model),model.label);
  }
  await f.manager.request('localModels.stop');
  await f.options.runtime.request('provider.save',{...provider,baseUrl:'https://example.com/v1'});
  assert.equal(f.manager.modelDisplayName(provider.id,provider.model),null);
  assert.deepEqual((await f.manager.request('localModels.list')).modelLabels,[]);
});

test('selected context uses one full-size slot, verifies runtime capacity and rejects mismatched chat requests',async t=>{
  const f=await fixture(t);const model=(await f.manager.request('localModels.list')).models[0];
  await f.manager.request('localModels.start',{modelId:model.id,contextTokens:8192});f.readiness.ready=true;
  const ready=await until(f.manager,'ready'),args=f.children[0].args;
  assert.equal(args[args.indexOf('--ctx-size')+1],'8192');assert.equal(args[args.indexOf('--parallel')+1],'1');
  assert.equal(ready.process.contextCapacityTokens,8192);assert.equal(ready.process.contextTokens,8192);
  const controls=f.manager.providerControls(ready.process.providerId,ready.process.model);assert.equal(controls.context.capacityTokens,8192);assert.equal(controls.context.requiresRestart,true);
  assert.equal(f.manager.providerControls('unrelated','unrelated'),undefined);
  f.manager.assertProviderAvailable(ready.process.providerId,ready.process.model,{contextTokens:8192});
  assert.throws(()=>f.manager.assertProviderAvailable(ready.process.providerId,ready.process.model,{contextTokens:16384}),/Restart.*16384/);
  await f.manager.request('localModels.stop');assert.equal(f.manager.providerControls(ready.process.providerId,ready.process.model).context.capacityTokens,null);
});

test('requested context cannot silently differ from runtime-reported capacity or escape start validation',async t=>{
  const f=await fixture(t);const model=(await f.manager.request('localModels.list')).models[0];
  for(const contextTokens of [-1,0,1.5,2147483648])await assert.rejects(f.manager.request('localModels.start',{modelId:model.id,contextTokens}));
  assert.equal(f.children.length,0);
  await assert.rejects(f.manager.request('localModels.start',{providerId:'unrelated',model:'fixture',contextTokens:8192}),/Configure Ollama context/);
  f.readiness.capacity=4096;f.readiness.ready=true;await f.manager.request('localModels.start',{modelId:model.id,contextTokens:8192});
  const failed=await until(f.manager,'failed');assert.match(failed.process.error,/Requested 8192.*reported 4096/);assert.equal(f.children[0].exitCode,0);assert.equal(f.state.providers.length,1);
});

test('editing a managed provider cannot confer owned context or thinking capabilities on an external endpoint',async t=>{
  const f=await fixture(t);const model=(await f.manager.request('localModels.list')).models[0];f.readiness.ready=true;
  await f.manager.request('localModels.start',{modelId:model.id});const ready=await until(f.manager,'ready');
  const provider=f.state.providers.find(item=>item.id===ready.process.providerId);
  assert.equal(f.manager.providerControls(provider.id,provider.model).context.mode,'managed');
  await f.options.runtime.request('provider.save',{...provider,baseUrl:'https://example.com/v1',apiKey:'fixture-replacement'});
  assert.equal(f.manager.providerControls(provider.id,provider.model),undefined);
  assert.throws(()=>f.manager.assertProviderAvailable(provider.id,provider.model),/connection was edited/);
  await f.manager.request('localModels.stop');
  assert.equal(f.manager.providerControls(provider.id,provider.model),undefined);
});

test('managed thinking is declared by the loaded template, stays available while stopped, and clears for other templates',async t=>{
  const f=await fixture(t);const model=(await f.manager.request('localModels.list')).models[0];f.readiness.ready=true;
  f.readiness.template='{% if enable_thinking %}<think>{% endif %}';
  await f.manager.request('localModels.start',{modelId:model.id});const ready=await until(f.manager,'ready');
  assert.equal(f.manager.providerControls(ready.process.providerId,ready.process.model).thinking.supported,true);
  await f.manager.request('localModels.stop');
  assert.equal(f.manager.providerControls(ready.process.providerId,ready.process.model).thinking.supported,true);
  f.readiness.template='{# enable_thinking is not supported #}{{ messages }}';
  await f.manager.request('localModels.start',{modelId:model.id});await until(f.manager,'ready');
  assert.equal(f.manager.providerControls(ready.process.providerId,ready.process.model).thinking.supported,false);
});

test('Stop while loading fences readiness, controls own process once and never registers a late provider', async t => {
  const f = await fixture(t); const model = (await f.manager.request('localModels.list')).models[0]; await f.manager.request('localModels.start', { modelId: model.id });
  await Promise.all([f.manager.request('localModels.stop'), f.manager.request('localModels.stop')]); f.readiness.ready = true; await pause(20);
  assert.equal(f.state.providers.length, 1); assert.equal(f.children[0].exitCode, 0); assert.equal((await f.manager.request('localModels.list')).process.status, 'stopped');
});

test('changed file IDs and contradictory selections fail before spawn', async t => {
  const f = await fixture(t); const model = (await f.manager.request('localModels.list')).models[0]; await fs.appendFile(path.join(f.directory, model.relativePath), 'changed');
  await assert.rejects(f.manager.request('localModels.start', { modelId: model.id }), /changed/);
  await assert.rejects(f.manager.request('localModels.start', { modelId: model.id, providerId: 'unrelated', model: 'x' }), /either/);
  await assert.rejects(f.manager.request('localModels.stop', { providerId: 'unrelated' }), /both/); assert.equal(f.children.length, 0);
});

test('close during asynchronous startup preparation prevents orphan process and key', async t => {
  let release, entered; const pending = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t); const model = (await f.manager.request('localModels.list')).models[0]; await f.manager.close();
  const manager = await createLocalModels({ ...f.options, getHubState: async () => { entered(); await pending; return { downloadDirectory: f.directory, downloads: [] }; } });
  const starting = manager.request('localModels.start', { modelId: model.id }); const rejected = assert.rejects(starting, /shutting down/); await observed;
  const closing = manager.close(); release(); await Promise.all([rejected, closing]); assert.equal(f.children.length, 0);
  assert.ok(!(await fs.readdir(path.join(f.root, 'data', 'local-models'))).some(name => name.endsWith('.key')));
});

test('generated local key is redacted from process failure diagnostics and key file is removed', async t => {
  const f = await fixture(t); await f.manager.request('localModels.start', { modelId: (await f.manager.request('localModels.list')).models[0].id });
  const child = f.children[0], keyPath = child.args[child.args.indexOf('--api-key-file') + 1], key = await fs.readFile(keyPath, 'utf8'); child.stderr.write(`load failed; key=${key}`); child.exitCode = 1; child.emit('close', 1);
  const failed = await until(f.manager, 'failed'); assert.ok(failed.process.error.includes('[redacted]')); assert.ok(!JSON.stringify(f.events).includes(key)); await assert.rejects(fs.access(keyPath));
});

test('explicit control-only tool run can stop an idle model while normal model runs remain guarded', async t => {
  const f = await fixture(t); f.readiness.ready = true; await f.manager.request('localModels.start', { modelId: (await f.manager.request('localModels.list')).models[0].id }); const ready = await until(f.manager, 'ready');
  f.state.runs.push({ id: 'tool-ui', providerId: ready.process.providerId, model: ready.process.model, status: 'running', modelCalls: [] });
  const result = await f.manager.tools().find(tool => tool.name === 'local_model_stop').execute({}, { runId: 'tool-ui', signal: new AbortController().signal }); assert.equal(result.process.status, 'stopped');
});

test('hardware defaults persist and exact selected GPU/core settings reach only the managed process with observed placement',async t=>{
  const f=await fixture(t);const hardware=await f.manager.request('localModels.hardware');assert.equal(hardware.gpus[0].id,'CUDA0');assert.equal(hardware.observed,null);
  const configuration={mode:'custom',gpuIds:['CUDA0'],cpuIds:[0],threads:1,memoryMap:false};
  await f.manager.request('localModels.configure',configuration);await f.manager.close();
  const manager=await createLocalModels(f.options);t.after(()=>manager.close());
  assert.deepEqual((await manager.request('localModels.hardware')).configuration,configuration);
  const model=(await manager.request('localModels.list')).models[0];await manager.request('localModels.start',{modelId:model.id});
  const child=f.children.at(-1);assert.ok(child.args.includes('--cpu-mask'));assert.equal(child.args[child.args.indexOf('--device')+1],'CUDA0');assert.equal(child.args[child.args.indexOf('--load-mode')+1],'none');
  child.stderr.write('using device CUDA');child.stdout.write('unrelated stdout line\n');child.stderr.write('0 (Fixture GPU)\n');child.stderr.write('ordinary model metadata\n'.repeat(10000));child.stderr.write('load_tensors: offloaded 4/8 layers to GPU\n');f.readiness.ready=true;
  const ready=await until(manager,'ready');assert.deepEqual(ready.process.requested,configuration);assert.equal(ready.process.observed.backend,'gpu');assert.equal(ready.process.observed.gpuLayers,4);
  await assert.rejects(manager.request('localModels.configure',configuration),/Stop the managed/);
  await assert.rejects(manager.request('localModels.configure',{...configuration,providerId:'unrelated'}),/Unknown|Unexpected|property/i);
});

test('custom GPU start refuses unconfirmed CPU fallback and does not register a provider',async t=>{
  const f=await fixture(t);await f.manager.request('localModels.configure',{mode:'custom',gpuIds:['CUDA0'],cpuIds:[],threads:0,memoryMap:true});
  await f.manager.request('localModels.start',{modelId:(await f.manager.request('localModels.list')).models[0].id});f.children[0].stderr.write('offloaded 0/8 layers to GPU');f.readiness.ready=true;
  const failed=await until(f.manager,'failed');assert.match(failed.process.error,/placement could not be confirmed/);assert.equal(f.children[0].exitCode,0);assert.equal(f.state.providers.length,1);
});

test('Recycle Bin operation moves exact complete shards, preserves sibling variants and returns partial failures honestly',async t=>{
  const f=await fixture(t);await f.manager.close();const moved=[];const recycle=path.join(f.root,'fake-recycle-bin');await fs.mkdir(recycle);
  for(const name of ['chosen-00001-of-00002.gguf','chosen-00002-of-00002.gguf','other-Q8.gguf'])await fs.writeFile(path.join(f.directory,name),header());
  const manager=await createLocalModels({...f.options,withModelFiles:async(directory,files,operation)=>{assert.equal(directory,await fs.realpath(f.directory));assert.equal(files.length,2);return operation();},trashItem:async file=>{moved.push(path.basename(file));await fs.rename(file,path.join(recycle,path.basename(file)));}});t.after(()=>manager.close());
  const model=(await manager.request('localModels.list')).models.find(item=>item.files.length===2);
  const result=await manager.request('localModels.delete',{modelId:model.id});assert.equal(result.deleted,true);assert.deepEqual(result.files,model.files);assert.equal(moved.length,2);await fs.access(path.join(f.directory,'other-Q8.gguf'));assert.ok(result.models.every(item=>item.id!==model.id));
  await assert.rejects(manager.request('localModels.delete',{modelId:model.id}),/changed|left/);
});

test('deletion rejects loaded renamed files and missing coordination but recycles only found incomplete/invalid files',async t=>{
  const f=await fixture(t);const first=(await f.manager.request('localModels.list')).models[0];
  await assert.rejects(f.manager.request('localModels.delete',{modelId:first.id}),/coordination/);await f.manager.close();
  let effects=0;const manager=await createLocalModels({...f.options,withModelFiles:async(_root,_files,operation)=>operation(),trashItem:async file=>{effects++;await fs.rename(file,file+'.recycled');}});t.after(()=>manager.close());
  await manager.request('localModels.start',{modelId:first.id});await fs.rename(path.join(f.directory,first.relativePath),path.join(f.directory,'renamed.gguf'));
  const renamed=(await manager.request('localModels.list')).models[0];await assert.rejects(manager.request('localModels.delete',{modelId:renamed.id}),/Stop the loaded/);assert.equal(effects,0);await manager.request('localModels.stop');
  await fs.writeFile(path.join(f.directory,'incomplete-00001-of-00002.gguf'),header());const incomplete=(await manager.request('localModels.list')).models.find(item=>!item.complete);
  const removed=await manager.request('localModels.delete',{modelId:incomplete.id});assert.equal(removed.deleted,true);assert.deepEqual(removed.files,['incomplete-00001-of-00002.gguf']);assert.equal(effects,1);await fs.access(path.join(f.directory,'renamed.gguf'));
  await fs.writeFile(path.join(f.directory,'invalid.gguf'),'broken fixture');const invalid=(await manager.request('localModels.list')).models.find(item=>item.relativePath==='invalid.gguf');assert.equal(invalid.available,false);
  assert.equal((await manager.request('localModels.delete',{modelId:invalid.id})).deleted,true);assert.equal(effects,2);
});
