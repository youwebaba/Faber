import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {outputPath,noLinks} from '../model-hub/paths.mjs';
import {estimateVram} from '../model-hub/metadata.mjs';

// GGUF v2/v3 structure and llama_ftype values; unknown future values stay numeric.
// https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
// https://github.com/ggml-org/llama.cpp/blob/master/include/llama.h
const fileTypes={0:'F32',1:'F16',2:'Q4_0',3:'Q4_1',7:'Q8_0',8:'Q5_0',9:'Q5_1',10:'Q2_K',11:'Q3_K_S',12:'Q3_K_M',13:'Q3_K_L',14:'Q4_K_S',15:'Q4_K_M',16:'Q5_K_S',17:'Q5_K_M',18:'Q6_K',19:'IQ2_XXS',20:'IQ2_XS',21:'Q2_K_S',22:'IQ3_XS',23:'IQ3_XXS',24:'IQ1_S',25:'IQ4_NL',26:'IQ3_S',27:'IQ3_M',28:'IQ2_S',29:'IQ2_M',30:'IQ4_XS',31:'IQ1_M',32:'BF16',36:'TQ1_0',37:'TQ2_0',38:'MXFP4_MOE',39:'NVFP4',40:'Q1_0',41:'Q2_0',42:'F8_E4M3'};
const widths={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};
const number=value=>{const result=Number(value);if(!Number.isSafeInteger(result)||result<0)throw new Error('GGUF integer exceeds supported range');return result;};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;

export async function readGGUFMetadata(filename,{signal,budget={remaining:8*1024*1024,deadline:Date.now()+5000}}={}){
  await noLinks(filename);const before=await fs.lstat(filename);
  if(!before.isFile()||before.isSymbolicLink())throw new Error('Model file is no longer an ordinary file');
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  const result={architecture:null,fileType:null,splitCount:null,splitNo:null,splitTensors:null,tensors:[],complete:false,bytesRead:0,warnings:[]};
  let offset=0;
  function check(length){signal?.throwIfAborted();if(!Number.isSafeInteger(length)||length<0||length>before.size-offset)throw new Error('Truncated or invalid GGUF metadata');if(length>budget.remaining||Date.now()>budget.deadline)throw new Error('GGUF metadata inspection limit reached; remaining fields are unknown');}
  async function bytes(length){check(length);const buffer=Buffer.alloc(length);const read=await handle.read(buffer,0,length,offset);if(read.bytesRead!==length)throw new Error('Truncated GGUF metadata');offset+=length;budget.remaining-=length;result.bytesRead+=length;return buffer;}
  function skip(length){check(length);offset+=length;budget.remaining-=length;}
  const u32=async()=>(await bytes(4)).readUInt32LE();
  const u64=async()=>number((await bytes(8)).readBigUInt64LE());
  async function string(keep=false,max=1024){const length=await u64();if(!keep){skip(length);return;}if(length>max)throw new Error('GGUF metadata string exceeds inspection limit');return new TextDecoder('utf-8',{fatal:true}).decode(await bytes(length));}
  async function value(type,keep=false,depth=0){
    if(type===8)return string(keep,512);
    if(type===9){if(depth>2)throw new Error('GGUF nested array exceeds inspection limit');const subtype=await u32(),count=await u64();if(count>1000000)throw new Error('GGUF array exceeds inspection limit');if(Object.hasOwn(widths,subtype)){skip(widths[subtype]*count);return;}for(let i=0;i<count;i++)await value(subtype,false,depth+1);return;}
    if(!Object.hasOwn(widths,type))throw new Error('Unsupported GGUF metadata type');
    if(!keep){skip(widths[type]);return;}
    const data=await bytes(widths[type]);
    if(type===0||type===7)return data.readUInt8();if(type===1)return data.readInt8();if(type===2)return data.readUInt16LE();if(type===3)return data.readInt16LE();if(type===4)return data.readUInt32LE();if(type===5)return data.readInt32LE();if(type===10)return number(data.readBigUInt64LE());if(type===11)return number(data.readBigInt64LE());return null;
  }
  try{
    if(!same(before,await handle.stat()))throw new Error('Model changed before metadata inspection');
    try{
      if(!(await bytes(4)).equals(Buffer.from('GGUF')))throw new Error('Invalid GGUF header');const version=await u32();if(![2,3].includes(version))throw new Error('Unsupported GGUF version or byte order');
      const tensorCount=await u64(),metadataCount=await u64();if(tensorCount>100000||metadataCount>10000)throw new Error('GGUF entry count exceeds inspection limit');
      const keys=new Set(),selected={'general.architecture':'architecture','general.file_type':'fileType','split.count':'splitCount','split.no':'splitNo','split.tensors.count':'splitTensors'};
      for(let i=0;i<metadataCount;i++){const key=await string(true),type=await u32();if(keys.has(key))throw new Error('Duplicate GGUF metadata key');keys.add(key);const keep=Object.hasOwn(selected,key),found=await value(type,keep);if(keep){if(key==='general.architecture'){if(typeof found==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(found))result.architecture=found;}else if(Number.isSafeInteger(found)&&found>=0)result[selected[key]]=found;}}
      const names=new Set();
      for(let i=0;i<tensorCount;i++){
        const name=await string(true,64),dimensions=await u32();if(!name||names.has(name)||dimensions<1||dimensions>4)throw new Error('Invalid GGUF tensor descriptor');names.add(name);
        let elements=1;for(let dimension=0;dimension<dimensions;dimension++){const size=await u64();if(!size)throw new Error('Invalid GGUF tensor dimension');elements*=size;if(!Number.isSafeInteger(elements))throw new Error('GGUF tensor exceeds supported range');}
        await u32();await u64();result.tensors.push({name,elements});
      }
      result.complete=true;
    }catch(error){signal?.throwIfAborted();result.warnings.push(error.message);result.tensors=[];}
    if(!same(before,await handle.stat())||!same(before,await fs.lstat(filename)))throw new Error('Model changed during metadata inspection');
    return result;
  }finally{await handle.close();}
}

export async function localModelDetails({directory,model,downloads=[],signal,budget}){
  const result={modelId:model.id,files:[...model.files],complete:model.complete,format:model.format,sizeBytes:model.sizeBytes,architecture:null,parameters:null,parameterSource:null,quantization:null,fileType:null,vram:null,metadataSource:'unknown',warnings:[]};
  const targets=await Promise.all(model.files.map(file=>outputPath(directory,file)));
  const parsed=[],limits=budget||{remaining:8*1024*1024,deadline:Date.now()+5000};
  if(model.format==='gguf')for(const target of targets){signal?.throwIfAborted();if(limits.remaining<=0||Date.now()>limits.deadline){result.warnings.push('GGUF metadata inspection limit reached');break;}const metadata=await readGGUFMetadata(target,{signal,budget:limits});parsed.push(metadata);result.warnings.push(...metadata.warnings);}
  const consistent=key=>{const known=parsed.map(value=>value[key]).filter(value=>value!==null);return known.length&&known.every(value=>value===known[0])?known[0]:null;};
  result.architecture=consistent('architecture');result.fileType=consistent('fileType');
  if(result.fileType!==null){result.quantization=fileTypes[result.fileType]||`GGUF file type ${result.fileType}`;result.quantizationSource='GGUF general.file_type (predominant tensor encoding)';}
  if(parsed.length&&parsed.some(value=>value.complete||value.architecture||value.fileType!==null))result.metadataSource='gguf';
  if(model.complete&&parsed.length===targets.length&&parsed.every(value=>value.complete)){
    const tensors=parsed.flatMap(value=>value.tensors),unique=new Set(tensors.map(value=>value.name));
    const declaredSplit=parsed.some(value=>value.splitCount!==null);
    const compatible=parsed.every(value=>(value.architecture===null||value.architecture===result.architecture)&&(value.fileType===null||value.fileType===result.fileType));
    const splitValid=compatible&&(declaredSplit?parsed.every((value,index)=>value.splitCount===targets.length&&value.splitNo===index&&(value.splitTensors===null||value.splitTensors===tensors.length)):targets.length===1);
    const total=tensors.reduce((sum,value)=>sum+value.elements,0);
    if(splitValid&&unique.size===tensors.length&&tensors.length&&Number.isSafeInteger(total)){result.parameters=total;result.parameterSource='Sum of stored tensor elements across the complete GGUF file set';}
    else if(tensors.length)result.warnings.push('Tensor counts across shards could not be validated; parameter total is unknown');
  }
  const normalized=file=>path.resolve(file).toLowerCase();
  const cached=[...downloads].reverse().find(job=>job.status==='completed'&&job.modelMetadata&&typeof job.directory==='string'&&Array.isArray(job.files)&&targets.every(target=>job.files.some(file=>file.status==='completed'&&typeof file.path==='string'&&normalized(path.join(job.directory,file.path))===normalized(target))));
  if(cached&&model.complete){
    if(result.parameters===null&&Number.isSafeInteger(cached.modelMetadata.parameters)&&cached.modelMetadata.parameters>0){result.parameters=cached.modelMetadata.parameters;result.parameterSource='Cached Hugging Face parameter metadata; local contents not rehashed';if(result.metadataSource==='unknown')result.metadataSource='cached-huggingface';}
    if(!result.quantization&&typeof cached.modelMetadata.quantization==='string'){result.quantization=cached.modelMetadata.quantization;result.quantizationSource='Cached download filename encoding label';}
  }
  if(model.complete&&model.available&&model.format==='gguf')result.vram=estimateVram(model.sizeBytes,'Selected complete local GGUF files; file bytes include headers');
  result.warnings=[...new Set(result.warnings)];return result;
}
