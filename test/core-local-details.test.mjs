import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readGGUFMetadata,localModelDetails} from '../local-models/details.mjs';
import {scanLocalModels} from '../local-models/library.mjs';

const u32=value=>{const buffer=Buffer.alloc(4);buffer.writeUInt32LE(value);return buffer;};
const u64=value=>{const buffer=Buffer.alloc(8);buffer.writeBigUInt64LE(BigInt(value));return buffer;};
const string=value=>Buffer.concat([u64(Buffer.byteLength(value)),Buffer.from(value)]);
function gguf({tensors=[['embedding.weight',[10,20]],['output.weight',[2,3]]],extra=[],fileType=15}={}){
  const metadata=[['general.architecture',8,string('llama')],['general.file_type',4,u32(fileType)],['tokenizer.chat_template',8,string('UNTRUSTED TEMPLATE MUST NOT BE RETURNED')],...extra];
  return Buffer.concat([Buffer.from('GGUF'),u32(3),u64(tensors.length),u64(metadata.length),...metadata.flatMap(([key,type,value])=>[string(key),u32(type),value]),...tensors.flatMap(([name,dimensions])=>[string(name),u32(dimensions.length),...dimensions.map(u64),u32(0),u64(0)])]);
}
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'faber-details-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const write=async(name,bytes)=>{const file=path.join(directory,name);await fs.writeFile(file,bytes);return file;};return {directory,write};}

test('selected GGUF details derive tensor element count and real file encoding without reading weight payload or template',async t=>{
  const {directory,write}=await fixture(t),metadata=gguf();const file=await write('unknown-name.gguf',Buffer.concat([metadata,Buffer.alloc(4096,0x7f)]));
  const parsed=await readGGUFMetadata(file);assert.equal(parsed.complete,true);assert.ok(parsed.bytesRead<metadata.length);assert.deepEqual(parsed.tensors,[{name:'embedding.weight',elements:200},{name:'output.weight',elements:6}]);
  const model=(await scanLocalModels({directory})).models[0];const details=await localModelDetails({directory,model});
  assert.equal(details.parameters,206);assert.equal(details.architecture,'llama');assert.equal(details.quantization,'Q4_K_M');assert.equal(details.fileType,15);assert.match(details.parameterSource,/tensor elements/);assert.equal(details.vram.estimated,true);assert.ok(details.vram.bytes>model.sizeBytes);assert.ok(!JSON.stringify(details).includes('UNTRUSTED TEMPLATE'));
});

test('only complete consistent shards with disjoint tensor names yield a model total',async t=>{
  const {directory,write}=await fixture(t);
  const split=(index,name)=>gguf({tensors:[[name,[5,7]]],extra:[['split.count',4,u32(2)],['split.no',4,u32(index)],['split.tensors.count',10,u64(2)]]});
  await write('split-00001-of-00002.gguf',split(0,'first'));let model=(await scanLocalModels({directory})).models[0];assert.equal((await localModelDetails({directory,model})).parameters,null);
  await write('split-00002-of-00002.gguf',split(1,'second'));model=(await scanLocalModels({directory})).models[0];assert.equal((await localModelDetails({directory,model})).parameters,70);
  await write('split-00002-of-00002.gguf',split(1,'first'));model=(await scanLocalModels({directory})).models[0];const duplicate=await localModelDetails({directory,model});assert.equal(duplicate.parameters,null);assert.match(duplicate.warnings.join(' '),/could not be validated/);
});

test('malformed sizes/types/dimensions and inspection budgets leave unknowns without unbounded reads',async t=>{
  const {directory,write}=await fixture(t);
  for(const [name,content]of [
    ['huge-array',gguf({extra:[['malicious',9,Buffer.concat([u32(8),u64(1000001)])]]})],
    ['unknown-type',gguf({extra:[['malicious',99,Buffer.alloc(4)]]})],
    ['overflow',gguf({tensors:[['weight',[Number.MAX_SAFE_INTEGER,2]]]})],
    ['short',Buffer.from('GGUF')],
  ]){const file=await write(name+'.gguf',content),result=await readGGUFMetadata(file);assert.equal(result.complete,false);assert.ok(result.warnings.length);assert.equal(result.tensors.length,0);assert.ok(result.bytesRead<=content.length);}
  const file=await write('budget.gguf',gguf());const bounded=await readGGUFMetadata(file,{budget:{remaining:50,deadline:Date.now()+1000}});assert.equal(bounded.complete,false);assert.ok(bounded.bytesRead<=50);assert.match(bounded.warnings[0],/limit/);
  const controller=new AbortController();controller.abort(new Error('fixture canceled'));await assert.rejects(readGGUFMetadata(file,{signal:controller.signal}),/fixture canceled/);
});

test('cached publisher metadata supplies offline fallback only for matched completed files, with explicit provenance',async t=>{
  const {directory,write}=await fixture(t);await write('model.safetensors','synthetic model');await write('config.json','{}');const model=(await scanLocalModels({directory})).models[0];
  const job={status:'completed',directory,modelMetadata:{parameters:1234,quantization:null},files:[{path:'model.safetensors',status:'completed'}]};
  const details=await localModelDetails({directory,model,downloads:[job]});assert.equal(details.parameters,1234);assert.equal(details.metadataSource,'cached-huggingface');assert.match(details.parameterSource,/not rehashed/);assert.equal(details.vram,null);
  assert.equal((await localModelDetails({directory,model,downloads:[{...job,status:'failed'}]})).parameters,null);
  assert.equal((await localModelDetails({directory,model,downloads:[{...job,files:[{path:'another.safetensors',status:'completed'}]}]})).parameters,null);
});
