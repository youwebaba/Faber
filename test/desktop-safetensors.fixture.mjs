import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory=process.argv[2];
const quantization=JSON.parse(process.argv[3]);assert.ok(['none','q4_0','q5_0','q8_0','mixed_q4_q8'].includes(quantization.mode));
assert.equal(JSON.parse(await fs.readFile(path.join(directory,'config.json'),'utf8')).model_type,'llama');
assert.ok(!(await fs.readdir(directory)).some(name=>name.endsWith('.gguf')));
function frame(value){const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32LE(body.length);process.stdout.write(Buffer.concat([header,body]));}
let pending=Buffer.alloc(0);
process.stdin.on('data',bytes=>{
  pending=Buffer.concat([pending,bytes]);
  while(pending.length>=4){const length=pending.readUInt32LE();assert.ok(length>0&&length<=16*1024*1024);if(pending.length<length+4)break;const command=JSON.parse(pending.subarray(4,length+4));pending=pending.subarray(length+4);
    if(command.kind==='cancel'){frame({kind:'done',id:command.id,canceled:true});continue;}
    assert.equal(command.kind,'generate');assert.equal(command.body.model,'worker-model');
    frame({kind:'chunk',id:command.id,value:{model:'worker-model',choices:[{index:0,delta:{role:'assistant',content:'Controlled native reply'},finish_reason:null}]}});
    frame({kind:'chunk',id:command.id,value:{model:'worker-model',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}});
    frame({kind:'done',id:command.id});
  }
});
process.stdin.on('end',()=>process.exit(0));
setTimeout(()=>frame({kind:'ready',protocol:3,model:'worker-model',backend:'cpu',quantization,precision:{verified:true,method:'controlled-fixture',effectiveBitsPerParameter:quantization.mode==='none'?32:quantization.mode==='q5_0'?5.5:4.5,parameters:1024,formats:{[quantization.mode==='none'?'f32':quantization.mode]:1},fallbackCount:0,verificationRemoved:true}}),250);
