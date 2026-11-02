import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHardware,parseDevices,observePlacement,defaultConfiguration,validateConfiguration,launchArguments,runnerEnvironment} from '../local-models/hardware.mjs';

const help='--device --n-gpu-layers --threads-batch --cpu-mask-batch --cpu-strict-batch --load-mode --list-devices --verbosity';
const fixtureHardware={gpus:[{id:'CUDA0'},{id:'CUDA1'}],cpus:[{id:0},{id:1},{id:2},{id:3}],loadMode:true,capabilities:{gpuSelection:true,cpuAffinity:true,threads:true,memoryMap:true}};
test('hardware parser reports only actual device memory and observed offload, never invents GPU placement',()=>{
  assert.deepEqual(parseDevices('Available devices:\n  CUDA0: GPU A (8192 MiB, 7000 MiB free)\n  CPU: Host (100 MiB, 50 MiB free)'),[{id:'CUDA0',name:'GPU A',totalBytes:8192*1048576,freeBytes:7000*1048576}]);
  assert.deepEqual(observePlacement('using device CUDA0 (GPU A)\nload_tensors: offloaded 12/40 layers to GPU'),{backend:'gpu',gpuLayers:12,totalLayers:40,devices:['CUDA0'],verified:true});
  assert.equal(observePlacement('model ready').backend,'unknown');assert.equal(observePlacement('offloaded 0/40 layers to GPU').backend,'cpu');
});
test('configuration validates exact GPUs, logical cores, counts and runtime capabilities',()=>{
  const custom={...defaultConfiguration,mode:'custom',gpuIds:['CUDA0','CUDA1'],cpuIds:[0,2],threads:2,memoryMap:false};
  assert.deepEqual(launchArguments(custom,fixtureHardware),['--device','CUDA0,CUDA1','--threads','2','--threads-batch','2','--cpu-mask','5','--cpu-strict','1','--cpu-mask-batch','5','--cpu-strict-batch','1','--load-mode','none']);
  assert.deepEqual(launchArguments({...defaultConfiguration,mode:'cpu'},fixtureHardware),['--device','none','--n-gpu-layers','0','--load-mode','mmap']);
  for(const change of [{gpuIds:['missing']},{gpuIds:[]},{gpuIds:['CUDA0','CUDA0']},{cpuIds:[9]},{cpuIds:[0,0]},{threads:3},{providerId:'external'}])assert.throws(()=>validateConfiguration({...custom,...change},fixtureHardware));
  assert.throws(()=>validateConfiguration(custom,{...fixtureHardware,capabilities:{...fixtureHardware.capabilities,cpuAffinity:false}}),/affinity/);
  assert.throws(()=>validateConfiguration({...defaultConfiguration,gpuIds:['CUDA0']},fixtureHardware),/only in custom/);
});
test('owned runtime requests library placement logs when supported without overriding automatic GPU fitting',()=>{
  const config={...defaultConfiguration,mode:'custom',gpuIds:['CUDA0']};
  const args=launchArguments(config,{...fixtureHardware,placementLogging:true});
  assert.deepEqual(args,['--verbosity','4','--device','CUDA0','--load-mode','mmap']);
  assert.ok(!args.includes('--n-gpu-layers'));
  assert.ok(!launchArguments(config,fixtureHardware).includes('--verbosity'));
});
test('backend discovery uses adjacent DLL plus dependency PATH and falls back when an earlier backend has no supported GPU',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'faber-hardware-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const name of ['cuda_v13','cuda_v12']){await fs.mkdir(path.join(root,name));await fs.writeFile(path.join(root,name,'ggml-cuda.dll'),'synthetic fixture, never loaded');}
  const calls=[];const executable=path.join(root,'llama-server.exe');
  const hardware=createHardware({executable,platform:'win32',cpuInfo:()=>[{model:'Fixture CPU'},{model:'Fixture CPU'}],runner:async(_exe,args,options)=>{
    calls.push({args,env:options.env});return {code:0,stderr:'',stdout:args[0]==='--help'?help:args[0]==='--version'?'Fixture 1':options.env.GGML_BACKEND_PATH?.includes('cuda_v12')?'  CUDA0: Fixture GPU (100 MiB, 80 MiB free)':''};
  }});
  const info=await hardware.inspect();assert.equal(info.runtime.backend,'cuda_v12');assert.equal(info.gpus[0].id,'CUDA0');assert.equal(info.cpus.length,2);assert.equal(info.capabilities.memoryMap,true);assert.equal(info.placementLogging,true);
  const env=hardware.environment();assert.equal(env.GGML_BACKEND_PATH,path.join(root,'cuda_v12','ggml-cuda.dll'));assert.ok(Object.entries(env).find(([key])=>key.toLowerCase()==='path')[1].startsWith(path.join(root,'cuda_v12')));
  assert.deepEqual(calls.map(call=>call.args[0]),['--help','--version','--list-devices','--list-devices']);assert.ok(calls.every(call=>!call.args.includes('--model')));
});
test('owned runtime environment does not inherit remote RPC or hidden device selection',()=>{
  const old={LLAMA_ARG_RPC:process.env.LLAMA_ARG_RPC,CUDA_VISIBLE_DEVICES:process.env.CUDA_VISIBLE_DEVICES};
  try{process.env.LLAMA_ARG_RPC='remote:5000';process.env.CUDA_VISIBLE_DEVICES='-1';const env=runnerEnvironment(process.execPath);assert.equal(env.LLAMA_ARG_RPC,undefined);assert.equal(env.CUDA_VISIBLE_DEVICES,undefined);}
  finally{for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
