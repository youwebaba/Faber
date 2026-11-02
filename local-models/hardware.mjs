import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runProcess} from '../tools/process.mjs';
import {validate} from '../core/registry.mjs';

export const defaultConfiguration = {mode:'auto',gpuIds:[],cpuIds:[],threads:0,memoryMap:true};
export const configurationSchema = {type:'object',additionalProperties:false,required:Object.keys(defaultConfiguration),properties:{
  mode:{enum:['auto','cpu','custom']},gpuIds:{type:'array',maxItems:32,items:{type:'string',minLength:1,maxLength:100}},
  cpuIds:{type:'array',maxItems:4096,items:{type:'integer',minimum:0,maximum:4095}},threads:{type:'integer',minimum:0,maximum:4096},memoryMap:{type:'boolean'},
}};
export function runnerEnvironment(executable, backendFile) {
  const env={...process.env};
  for(const name of Object.keys(env))if(/^(LLAMA_|GGML_|CUDA_VISIBLE_DEVICES$|HIP_VISIBLE_DEVICES$|ROCR_VISIBLE_DEVICES$|HF_TOKEN$|HUGGING_FACE_HUB_TOKEN$)/i.test(name))delete env[name];
  const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path')||'PATH';
  env[pathKey]=[...(backendFile?[path.dirname(backendFile)]:[]),path.dirname(executable),env[pathKey]||''].join(path.delimiter);
  if(backendFile)env.GGML_BACKEND_PATH=backendFile;
  return env;
}
export function parseDevices(text) {
  const devices=[];
  for(const line of text.split(/\r?\n/)){
    const match=/^\s*([A-Za-z][A-Za-z0-9_.-]*):\s+(.+?)\s+\((\d+) MiB,\s*(\d+) MiB free\)\s*$/.exec(line);
    if(match&&!/^CPU/i.test(match[1])&&!devices.some(device=>device.id===match[1]))devices.push({id:match[1],name:match[2],totalBytes:Number(match[3])*1048576,freeBytes:Number(match[4])*1048576});
  }
  return devices;
}
export function observePlacement(logs) {
  const matches=[...logs.matchAll(/offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers to GPU/gi)],last=matches.at(-1);
  const devices=[...new Set([...logs.matchAll(/using device\s+([A-Za-z][A-Za-z0-9_.-]*)\s*\(/gi)].map(match=>match[1]))];
  return {backend:last?(Number(last[1])>0?'gpu':'cpu'):'unknown',gpuLayers:last?Number(last[1]):null,totalLayers:last?Number(last[2]):null,devices,verified:!!last};
}
export function validateConfiguration(config, hardware) {
  validate(config,configurationSchema);
  if(new Set(config.gpuIds).size!==config.gpuIds.length||new Set(config.cpuIds).size!==config.cpuIds.length)throw new Error('Hardware selections must not contain duplicates');
  if(config.mode!=='custom'&&config.gpuIds.length)throw new Error('Select GPUs only in custom mode');
  if(config.mode==='custom'&&(!config.gpuIds.length||!hardware.capabilities.gpuSelection))throw new Error('Custom mode requires supported GPUs and device selection in this runtime');
  for(const id of config.gpuIds)if(!hardware.gpus.some(gpu=>gpu.id===id))throw new Error(`Selected GPU is unavailable in this runtime: ${id}`);
  for(const id of config.cpuIds)if(!hardware.cpus.some(cpu=>cpu.id===id))throw new Error(`Selected logical CPU is unavailable: ${id}`);
  if(config.cpuIds.length&&!hardware.capabilities.cpuAffinity)throw new Error('CPU core affinity is not supported by this runtime/platform topology; use automatic cores');
  if(config.threads>(config.cpuIds.length||hardware.cpus.length))throw new Error('Thread count exceeds selected logical CPUs');
  if(config.threads&&!hardware.capabilities.threads)throw new Error('This runtime does not support CPU thread controls');
  if(!hardware.capabilities.memoryMap)throw new Error('This runtime does not expose a supported memory-mapping control');
  if(config.mode==='cpu'&&!hardware.capabilities.gpuSelection)throw new Error('This runtime cannot guarantee CPU-only device selection');
}
export function launchArguments(config,hardware) {
  validateConfiguration(config,hardware);const args=[];
  // Recent llama.cpp maps library INFO (including actual GPU placement) to TRACE.
  // Server defaults at level 3 hide these messages; level 4 keeps verification observable.
  if(hardware.placementLogging)args.push('--verbosity','4');
  if(config.mode==='cpu')args.push('--device','none','--n-gpu-layers','0');
  else if(config.mode==='custom')args.push('--device',config.gpuIds.join(','));
  const threads=config.threads||config.cpuIds.length;
  if(threads)args.push('--threads',String(threads),'--threads-batch',String(threads));
  if(config.cpuIds.length){const mask=config.cpuIds.reduce((mask,id)=>mask|(1n<<BigInt(id)),0n).toString(16);args.push('--cpu-mask',mask,'--cpu-strict','1','--cpu-mask-batch',mask,'--cpu-strict-batch','1');}
  if(hardware.loadMode)args.push('--load-mode',config.memoryMap?'mmap':'none');else args.push(config.memoryMap?'--mmap':'--no-mmap');
  return args;
}

export function createHardware({executable,backendDirectories=[],runner=runProcess,cpuInfo=()=>os.cpus(),platform=process.platform}) {
  let selectedBackend,help,version;
  async function probe(signal) {
    const cpus=cpuInfo().map((cpu,id)=>({id,name:`Logical CPU ${id}`,model:cpu.model}));
    const base={runtime:{available:!!executable,...(executable?{executable}:{reason:'Install a compatible local runtime before starting a model.'})},cpus,memory:{totalBytes:os.totalmem(),freeBytes:os.freemem()},gpus:[],capabilities:{gpuSelection:false,cpuAffinity:false,threads:false,memoryMap:false},warnings:[],checkedAt:new Date().toISOString()};
    if(!executable)return base;
    const run=(args,backendFile)=>runner(executable,args,{cwd:path.dirname(executable),env:runnerEnvironment(executable,backendFile),signal,timeout:15000,maxOutput:1024*1024});
    if(help===undefined){const result=await run(['--help']);if(result.code!==0)throw new Error('Local runtime capability probe failed');help=result.stdout+'\n'+result.stderr;const info=await run(['--version']);version=(info.stdout+' '+info.stderr).trim().slice(0,300);}
    base.runtime.version=version;
    base.loadMode=/--load-mode\b/.test(help);
    base.placementLogging=/--verbosity\b/.test(help);
    base.capabilities={gpuSelection:/--device\b/.test(help)&&/--n-gpu-layers\b/.test(help),cpuAffinity:cpus.length<=64&&/--cpu-mask-batch\b/.test(help)&&/--cpu-strict-batch\b/.test(help),threads:/--threads-batch\b/.test(help),memoryMap:base.loadMode||/--no-mmap\b/.test(help)};
    if(cpus.length>64)base.warnings.push('Core affinity across Windows processor groups is not supported here; use automatic cores and a thread count.');
    const root=path.dirname(executable),directories=[...backendDirectories,...['cuda_v13','cuda_v12','rocm_v7_1','vulkan'].map(name=>path.join(root,name))];
    const candidates=[];
    if(selectedBackend)candidates.push(selectedBackend);
    for(const directory of directories)for(const name of (platform==='win32'?['ggml-cuda.dll','ggml-hip.dll','ggml-vulkan.dll']:['libggml-cuda.so','libggml-hip.so','libggml-vulkan.so'])){
      const candidate=path.join(directory,name);try{if((await fs.stat(candidate)).isFile()&&!candidates.includes(candidate))candidates.push(candidate);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    candidates.push(undefined);
    if(/--list-devices\b/.test(help))for(const backend of candidates){
      signal?.throwIfAborted();
      try{const result=await run(['--list-devices'],backend);const devices=result.code===0?parseDevices(result.stdout+'\n'+result.stderr):[];
        if(devices.length){base.gpus=devices;selectedBackend=backend;base.runtime.backend=backend?path.basename(path.dirname(backend)):'built-in';break;}
      }catch(error){signal?.throwIfAborted();base.warnings.push(`Backend ${backend?path.basename(path.dirname(backend)):'built-in'} unavailable: ${error.message}`);}
    }
    if(!base.gpus.length){selectedBackend=undefined;base.warnings.push('No supported GPUs were reported by this runtime. Automatic mode may use CPU.');}
    base.warnings.push('Memory mapping uses disk-backed file pages, not extra VRAM. Windows may still page memory when mapping is disabled.');
    return base;
  }
  let pending;
  return {async inspect(signal){if(pending)return structuredClone(await pending);pending=probe(signal);try{return await pending;}finally{pending=undefined;}},environment:()=>runnerEnvironment(executable,selectedBackend)};
}
