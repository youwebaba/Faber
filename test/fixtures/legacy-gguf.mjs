// Frozen b2.0.1 JavaScript parser: differential oracle for the Rust migration only.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {noLinks} from '../../model-hub/paths.mjs';

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
