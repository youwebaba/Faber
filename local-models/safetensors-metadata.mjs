import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {noLinks,outputPath} from '../model-hub/paths.mjs';

const widths={F64:8,F32:4,F16:2,BF16:2,I64:8,U64:8,I32:4,U32:4,I16:2,U16:2,I8:1,U8:1,BOOL:1,F8_E4M3:1,F8_E5M2:1};
export async function safetensorsHeader(filename){
  await noLinks(filename);const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const before=await handle.stat(),prefix=Buffer.alloc(8);if(!before.isFile()||(await handle.read(prefix,0,8,0)).bytesRead!==8)throw new Error('Incomplete Safetensors header');
    const length=prefix.readBigUInt64LE();if(length<2n||length>8388608n||length+8n>BigInt(before.size))throw new Error('Safetensors header exceeds the bounded inspection limit');
    const bytes=Buffer.alloc(Number(length));if((await handle.read(bytes,0,bytes.length,8)).bytesRead!==bytes.length)throw new Error('Incomplete Safetensors metadata');
    const data=JSON.parse(bytes.toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid Safetensors metadata');
    const tensors=[];for(const [name,tensor] of Object.entries(data)){
      if(name==='__metadata__')continue;
      if(!tensor||!widths[tensor.dtype]||!Array.isArray(tensor.shape)||tensor.shape.length>16||tensor.shape.some(n=>!Number.isSafeInteger(n)||n<0)||!Array.isArray(tensor.data_offsets)||tensor.data_offsets.length!==2)throw new Error('Unsupported or invalid Safetensors tensor metadata');
      const elements=tensor.shape.reduce((total,n)=>total*n,1),size=elements*widths[tensor.dtype],[start,end]=tensor.data_offsets;
      if(!Number.isSafeInteger(size)||![start,end].every(n=>Number.isSafeInteger(n)&&n>=0)||end<start||end-start!==size||end>before.size-8-Number(length))throw new Error('Invalid Safetensors tensor byte range');
      tensors.push({name,dtype:tensor.dtype,shape:tensor.shape,elements,size,start,end});
    }
    const ranges=[...tensors].sort((a,b)=>a.start-b.start);for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)throw new Error('Overlapping Safetensors tensor ranges');
    const after=await handle.stat();await noLinks(filename);const current=await fs.lstat(filename);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||current.dev!==after.dev||current.ino!==after.ino||current.size!==after.size||current.mtimeMs!==after.mtimeMs)throw new Error('Safetensors changed during inspection');
    return {tensors,headerBytes:Number(length),bytes:before.size,parameters:tensors.reduce((n,tensor)=>n+tensor.elements,0)};
  }finally{await handle.close();}
}
export async function packageTensorMetadata(directory,model){
  if(model.files.length>1024)throw new Error('Too many shards for bounded automatic fit inspection');
  const records=[];let headerBytes=0,tensorCount=0;
  for(const file of model.files){const record=await safetensorsHeader(await outputPath(directory,file));headerBytes+=record.headerBytes;tensorCount+=record.tensors.length;if(headerBytes>32*1024*1024||tensorCount>100000)throw new Error('Combined tensor metadata exceeds automatic fit inspection limits');records.push(record);}
  const tensors=records.flatMap(record=>record.tensors),seen=new Set();for(const tensor of tensors){if(seen.has(tensor.name))throw new Error('Duplicate tensor across Safetensors shards');seen.add(tensor.name);}
  const parameters=records.reduce((n,record)=>n+record.parameters,0);if(!Number.isSafeInteger(parameters))throw new Error('Tensor count exceeds the supported numeric range');
  return {tensors,parameters,bytes:records.reduce((n,record)=>n+record.bytes,0)};
}
