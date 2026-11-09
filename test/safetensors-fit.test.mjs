import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {safetensorsHeader} from '../local-models/safetensors-metadata.mjs';
import {nativeFit} from '../local-models/fit.mjs';

async function writeTensorFile(filename,tensors,dataBytes){const header=Buffer.from(JSON.stringify(tensors)),prefix=Buffer.alloc(8);prefix.writeBigUInt64LE(BigInt(header.length));await fs.writeFile(filename,Buffer.concat([prefix,header,Buffer.alloc(dataBytes)]));}
test('native fit distinguishes requested weight formats, full context, startup workspace and additional disk with headroom',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-native-fit-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await writeTensorFile(path.join(directory,'model.safetensors'),{'model.layers.0.q.weight':{dtype:'F32',shape:[32,32],data_offsets:[0,4096]},'model.layers.1.q.weight':{dtype:'F32',shape:[32,32],data_offsets:[4096,8192]},'model.norm.weight':{dtype:'F32',shape:[32],data_offsets:[8192,8320]}},8320);
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({num_hidden_layers:2,hidden_size:32,num_attention_heads:2,num_key_value_heads:1,max_position_embeddings:256}));
  const model={complete:true,files:['model.safetensors'],supportFiles:['config.json']},fits={};for(const mode of ['none','q4_0','q5_0','q8_0','mixed_q4_q8'])fits[mode]=await nativeFit(directory,model,{mode});
  assert.ok(Object.values(fits).every(fit=>fit.available));assert.equal(fits.none.parameters,2080);assert.equal(fits.none.rows.ram.weights,8320);assert.equal(fits.none.rows.ram.context,65536);
  assert.ok(fits.q4_0.rows.ram.weights<fits.q5_0.rows.ram.weights&&fits.q5_0.rows.ram.weights<fits.q8_0.rows.ram.weights&&fits.q8_0.rows.ram.weights<fits.none.rows.ram.weights);
  assert.equal(fits.mixed_q4_q8.rows.ram.weights,1792);assert.equal(fits.q4_0.rows.vram.total,0);assert.equal(fits.q4_0.capacities.vram.supported,false);
  assert.ok(fits.q4_0.rows.ram.workspace>fits.none.rows.ram.workspace);assert.ok(fits.q4_0.rows.disk.workspace>fits.none.rows.disk.workspace);assert.ok(fits.q4_0.rows.ram.headroom>0&&fits.q4_0.rows.disk.headroom>0);
  assert.equal(fits.none.rows.disk.weights,(await fs.stat(path.join(directory,'model.safetensors'))).size);assert.equal(fits.q4_0.rows.disk.additionalBytes,fits.q4_0.rows.disk.workspace);
  assert.equal((await nativeFit(directory,{...model,complete:false},{mode:'q4_0'})).available,false);
});
test('bounded tensor metadata rejects overlapping, truncated and oversized descriptors without loading tensor data',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-native-header-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const file=path.join(directory,'model.safetensors');
  await writeTensorFile(file,{a:{dtype:'F32',shape:[1],data_offsets:[0,4]},b:{dtype:'F32',shape:[1],data_offsets:[0,4]}},8);await assert.rejects(safetensorsHeader(file),/Overlapping/);
  await fs.writeFile(file,'short');await assert.rejects(safetensorsHeader(file),/Incomplete/);
  const huge=Buffer.alloc(8);huge.writeBigUInt64LE(8388609n);await fs.writeFile(file,huge);await assert.rejects(safetensorsHeader(file),/bounded/);
  await writeTensorFile(file,{a:{dtype:'F32',shape:[2],data_offsets:[0,4]}},4);await assert.rejects(safetensorsHeader(file),/byte range/);
});
