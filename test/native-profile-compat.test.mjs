import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createLocalModels} from '../local-models/index.mjs';
import {defaultConfiguration} from '../local-models/hardware.mjs';
import {savedNativeQuantization,resolveNativeQuantization,quantizationSchema} from '../local-models/quantization.mjs';

test('future persisted native profiles survive startup and unrelated saves without an implicit default load',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-profile-compat-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const directory=path.join(root,'models'),dataDir=path.join(root,'data');await fs.mkdir(directory);await fs.mkdir(path.join(dataDir,'local-models'),{recursive:true});
  await fs.writeFile(path.join(directory,'model.safetensors'),'fixture weights');await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({model_type:'llama'}));await fs.writeFile(path.join(directory,'tokenizer.json'),'{}');
  let spawned=0;const options={dataDir,runtime:{request:async()=>({providers:[],runs:[]})},getHubState:async()=>({downloadDirectory:directory,downloads:[]}),executable:process.execPath,safetensorsExecutable:process.execPath,safetensorsVerify:async()=>true,spawnImpl:()=>{spawned++;throw new Error('Unexpected model spawn');},hardwareRunner:async(_file,args)=>({code:0,stdout:args[0]==='--help'?'--device --n-gpu-layers --threads-batch --load-mode':'Controlled runtime',stderr:''})};
  const initial=await createLocalModels(options),id=(await initial.request('localModels.list')).models[0].id;await initial.close();
  const future={mode:'future_native_12',settings:{targetBits:12,mixed:[4,10],keep:true}},state={version:1,providerId:null,configuration:defaultConfiguration,loadProfiles:{[id]:future,'future-unseen-model':{mode:'another_future_mode',opaque:['keep',false,17]}},futureRoot:{keep:'unchanged'}};
  const filename=path.join(dataDir,'local-models','state.json');await fs.writeFile(filename,JSON.stringify(state));
  const manager=await createLocalModels(options);t.after(()=>manager.close());const selected=(await manager.request('localModels.list')).models.find(model=>model.id===id);
  assert.equal(selected.available,true);assert.equal(selected.quantization,null);assert.match(selected.quantizationWarning,/unsupported.*Choose a supported/i);
  await assert.rejects(manager.request('localModels.start',{modelId:id}),/unsupported.*Choose a supported/i);assert.equal(spawned,0);
  await manager.request('localModels.configure',defaultConfiguration);await manager.close();
  const after=JSON.parse(await fs.readFile(filename,'utf8'));assert.deepEqual(after.loadProfiles,state.loadProfiles);assert.deepEqual(after.futureRoot,state.futureRoot);
  assert.deepEqual(resolveNativeQuantization({mode:'none'},future),{mode:'none'});assert.throws(()=>resolveNativeQuantization(undefined,future),/unsupported/);
});
test('saved profile compatibility follows the current release capability boundary',()=>{
  const supported=quantizationSchema.properties.mode.enum.includes('q5_0'),result=savedNativeQuantization({mode:'q5_0'});
  assert.equal(Boolean(result.quantization),supported);if(!supported)assert.match(result.quantizationWarning,/Choose a supported/);
});
