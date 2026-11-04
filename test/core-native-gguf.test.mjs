import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readGGUFMetadata} from '../local-models/details.mjs';
import {readGGUFMetadata as legacyMetadata} from './fixtures/legacy-gguf.mjs';

const u32=value=>{const bytes=Buffer.alloc(4);bytes.writeUInt32LE(value);return bytes;};
const u64=value=>{const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(BigInt(value));return bytes;};
const i64=value=>{const bytes=Buffer.alloc(8);bytes.writeBigInt64LE(BigInt(value));return bytes;};
const string=value=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);return Buffer.concat([u64(bytes.length),bytes]);};
const field=(name,type,value)=>Buffer.concat([string(name),u32(type),value]);
const tensor=(name,dimensions=[3,7])=>Buffer.concat([string(name),u32(dimensions.length),...dimensions.map(u64),u32(0),u64(0)]);
const gguf=({metadata=[],tensors=[],version=3}={})=>Buffer.concat([Buffer.from('GGUF'),u32(version),u64(tensors.length),u64(metadata.length),...metadata,...tensors]);
const array=(type,values)=>Buffer.concat([u32(type),u64(values.length),...values]);
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'faber-native-gguf-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return directory;
}
async function compare(directory,name,bytes,{remaining=8*1024*1024,deadline=Date.now()+30000}={}){
  const filename=path.join(directory,name+'.gguf');await fs.writeFile(filename,bytes);
  const oldBudget={remaining,deadline},newBudget={remaining,deadline};
  const expected=await legacyMetadata(filename,{budget:oldBudget});
  const actual=await readGGUFMetadata(filename,{budget:newBudget});
  assert.deepEqual(actual,expected,name);
  assert.deepEqual(newBudget,oldBudget,name+' shared budget');
  return actual;
}

test('Rust GGUF inherited-file parser preserves legacy selected fields, Unicode, scalar types and skipped arrays',async t=>{
  const directory=await fixture(t);
  const basic=[
    field('general.architecture',8,string('qwen3')),
    field('general.file_type',4,u32(7)),
    field('tokenizer.chat_template',8,string('untrusted '+ 'x'.repeat(2048))),
    field('split.count',2,Buffer.from([2,0])),
    field('split.no',0,Buffer.from([1])),
    field('split.tensors.count',10,u64(2)),
  ];
  const valid=await compare(directory,'selected',gguf({metadata:basic,tensors:[tensor('層.🚀.weight'),tensor('\uFEFFbom.weight')]}));
  assert.equal(valid.complete,true);assert.equal(valid.architecture,'qwen3');assert.equal(valid.tensors[1].name,'bom.weight');
  for(const version of [2,3])await compare(directory,'version-'+version,gguf({version,tensors:[tensor('matrix')]}));
  const scalars=[
    [0,Buffer.from([255])],[1,Buffer.from([0xff])],[2,Buffer.from([0xff,0xff])],
    [3,Buffer.from([0xff,0xff])],[4,u32(123)],[5,u32(0xffffffff)],[6,u32(0x3f800000)],
    [7,Buffer.from([7])],[10,u64(Number.MAX_SAFE_INTEGER)],[11,i64(42)],[12,Buffer.alloc(8)],
    [8,string('not numeric')],[9,array(4,[u32(1),u32(2)])],
  ];
  for(const [type,bytes] of scalars)await compare(directory,'scalar-'+type,gguf({metadata:[field('general.file_type',type,bytes)],tensors:[tensor('valid')]}));
  await compare(directory,'skipped-arrays',gguf({metadata:[
    field('numbers',9,array(10,[u64(1),u64(2),u64(3)])),
    field('strings',9,array(8,[string(Buffer.from([0xff])),string('never decoded')])),
    field('nested',9,array(9,[array(9,[array(8,[string('skip')])])])),
    field('general.architecture',8,string('\uFEFFqwen')),
  ],tensors:[tensor('a')]}));
});

test('Rust GGUF parser preserves partial metadata, malformed-input warnings and exact budget accounting',async t=>{
  const directory=await fixture(t);
  const architecture=field('general.architecture',8,string('llama'));
  const cases=[
    ['invalid-magic',Buffer.alloc(24)],
    ['version',gguf({version:1})],
    ['huge-count',Buffer.concat([Buffer.from('GGUF'),u32(3),u64(100001),u64(0)])],
    ['integer-overflow',Buffer.concat([Buffer.from('GGUF'),u32(3),u64(2n**53n),u64(0)])],
    ['negative-i64',gguf({metadata:[architecture,field('split.count',11,i64(-1))]})],
    ['unknown-type',gguf({metadata:[architecture,field('unknown',99,u32(0))]})],
    ['huge-array',gguf({metadata:[field('unknown',9,Buffer.concat([u32(8),u64(1000001)]))]})],
    ['deep-array',gguf({metadata:[field('deep',9,array(9,[array(9,[array(9,[array(8,[string('skip')])])])]))]})],
    ['duplicate-key',gguf({metadata:[architecture,field('\uFEFFgeneral.architecture',8,string('qwen'))]})],
    ['duplicate-tensor',gguf({metadata:[architecture],tensors:[tensor('same'),tensor('same')]})],
    ['empty-tensor',gguf({tensors:[tensor('')]})],
    ['dimensions-zero',gguf({tensors:[tensor('zero',[])]})],
    ['dimensions-many',gguf({tensors:[tensor('many',[1,1,1,1,1])]})],
    ['dimension-zero',gguf({tensors:[tensor('zero',[2,0])]})],
    ['elements-overflow',gguf({tensors:[tensor('large',[Number.MAX_SAFE_INTEGER,2])]})],
    ['invalid-key-utf8',gguf({metadata:[field(Buffer.from([0xff]),4,u32(1))]})],
    ['invalid-value-utf8',gguf({metadata:[field('general.architecture',8,string(Buffer.from([0xff])))]})],
    ['long-key',gguf({metadata:[field('x'.repeat(1025),4,u32(1))]})],
    ['long-selected-string',gguf({metadata:[field('general.architecture',8,string('x'.repeat(513)))]})],
    ['long-tensor-name',gguf({tensors:[tensor('x'.repeat(65))]})],
    ['bad-architecture',gguf({metadata:[field('general.architecture',8,string('invalid arch'))]})],
  ];
  const complete=gguf({metadata:[architecture,field('ignored',8,string('skip these bytes'))],tensors:[tensor('sample')]});
  for(const length of [0,3,4,7,8,15,16,23,24,31,32,40,complete.length-1])cases.push(['truncated-'+length,complete.subarray(0,length)]);
  for(const [name,bytes]of cases)await compare(directory,name,bytes);
  for(const remaining of [0,3,4,7,8,15,16,23,24,50,complete.length-1,complete.length]){
    await compare(directory,'budget-'+remaining,complete,{remaining});
  }
  await compare(directory,'expired',complete,{deadline:0});
});

test('Rust parser migration preserves cancellation and refuses paths that became a different file',async t=>{
  const directory=await fixture(t),filename=path.join(directory,'model.gguf');
  await fs.writeFile(filename,gguf({tensors:[tensor('a')]}));
  const controller=new AbortController(),reason=new Error('native fixture canceled');controller.abort(reason);
  await assert.rejects(readGGUFMetadata(filename,{signal:controller.signal}),error=>error===reason);
  const original=fs.lstat;let calls=0;
  fs.lstat=async(file,...args)=>{
    const stat=await original(file,...args);
    if(file===filename&&++calls===3)return {...stat,mtimeMs:stat.mtimeMs+1};
    return stat;
  };
  try{await assert.rejects(readGGUFMetadata(filename),/Model changed during metadata inspection/);}
  finally{fs.lstat=original;}
});