import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {packageTensorMetadata} from './safetensors-metadata.mjs';
import {nativeQuantization} from './quantization.mjs';
import {outputPath,noLinks} from '../model-hub/paths.mjs';

const MiB=1048576,GiB=1024*MiB;
const integer=(value,fallback)=>Number.isSafeInteger(value)&&value>0?value:fallback;
export function tensorWeightEstimate(tensors,profile,layers){
  const mode=profile.mode;let bytes=0;
  for(const tensor of tensors){
    const index=/(?:^|\.)(?:layers|h)\.(\d+)(?:\.|$)/.exec(tensor.name),sensitive=/(?:lm_head|embed_tokens|word_embeddings|output)\.weight$/.test(tensor.name);
    let bits=/^(?:F|BF)/.test(tensor.dtype)?32:tensor.elements?tensor.size*8/tensor.elements:0;
    if(mode!=='none'&&tensor.shape.length>=2&&tensor.name.endsWith('.weight')){
      bits=mode==='q5_0'?5.5:mode==='q8_0'?8.5:mode==='mixed_q4_q8'&&index&&Number(index[1])>=Math.floor(layers/2)?8.5:4.5;
      if(sensitive)bits=mode==='q4_0'||mode==='mixed_q4_q8'?6:8.5;
      // Q*_0 requires rows divisible by 32; native shape fallbacks retain higher precision.
      if(tensor.shape.at(-1)%32)bits=32;
    }
    bytes+=Math.ceil(tensor.elements*bits/8);
  }
  return bytes;
}
export async function nativeFit(directory,model,requested){
  const quantization=nativeQuantization(requested??model.quantization),memory={totalBytes:os.totalmem(),freeBytes:os.freemem()};
  const disk=await fs.statfs(directory,{bigint:true}).then(info=>({freeBytes:Number(info.bavail*info.bsize),totalBytes:Number(info.blocks*info.bsize)})).catch(()=>({freeBytes:null,totalBytes:null}));
  const capacities={ram:memory,disk,vram:{selectedBytes:0,supported:false,reason:'This pinned native runtime supports CPU only; GPU placement and RAM/GPU splitting are unavailable.'}};
  try{
    if(!model.complete)throw new Error(model.reason||'Complete all model shards and support files before estimating fit');
    const metadata=await packageTensorMetadata(directory,model),folder=path.posix.dirname(model.files[0]),configFile=await outputPath(directory,folder==='.'?'config.json':`${folder}/config.json`);await noLinks(configFile);
    const stat=await fs.stat(configFile);if(stat.size>1048576)throw new Error('Model configuration exceeds the fit inspection limit');const config=JSON.parse(await fs.readFile(configFile,'utf8'));
    const layers=integer(config.num_hidden_layers,null),hidden=integer(config.hidden_size,null),heads=integer(config.num_attention_heads,null),kvHeads=integer(config.num_key_value_heads,heads),headSize=integer(config.head_dim,hidden&&heads?hidden/heads:null),contextTokens=integer(config.max_position_embeddings,null);
    const weights=tensorWeightEstimate(metadata.tensors,quantization,layers||0),context=layers&&kvHeads&&headSize&&contextTokens?2*layers*kvHeads*headSize*contextTokens*4:null;
    const unquantized=metadata.parameters*4,workspace=Math.max(256*MiB,Math.ceil(unquantized*0.15))+(quantization.mode==='none'?0:unquantized);
    const ramHeadroom=Math.max(2*GiB,Math.ceil(memory.totalBytes*0.15)),diskHeadroom=Math.max(GiB,Number.isFinite(disk.totalBytes)?Math.ceil(disk.totalBytes*0.02):0);
    let supportBytes=0;for(const file of model.supportFiles||[])supportBytes+=(await fs.stat(await outputPath(directory,file))).size;
    const temporary=quantization.mode==='none'?supportBytes:Math.ceil(weights*1.1)+supportBytes*2+16*MiB;
    const total=context===null?null:weights+context+workspace;
    return {available:true,estimated:true,checkedAt:new Date().toISOString(),quantization,parameters:metadata.parameters,defaultContextTokens:contextTokens,capacities,
      rows:{vram:{weights:0,context:0,workspace:0,total:0,capacity:0,headroom:0,placement:'unavailable'},ram:{weights,context,workspace,total,capacity:memory.freeBytes,headroom:ramHeadroom,fits:total===null?null:total+ramHeadroom<=memory.freeBytes},disk:{weights:metadata.bytes,context:0,workspace:temporary,total:metadata.bytes+temporary,additionalBytes:temporary,capacity:disk.freeBytes,headroom:diskHeadroom,fits:disk.freeBytes===null?null:temporary+diskHeadroom<=disk.freeBytes}},
      notes:['RAM weights are shape-based estimates; native formats and allocation can differ.','Context estimates full default-capacity float32 K/V storage; lazy allocation, sliding windows and model-specific caches can differ.','RAM workspace is a conservative startup reserve, including float32 quantization working space.','Disk includes existing original weights and temporary native precision-verification files; existing weights do not consume that free space again.','Disk is SSD/HDD backing, not VRAM; physical drive type is unknown.']};
  }catch(error){return {available:false,estimated:true,quantization,capacities,reason:error.message};}
}
