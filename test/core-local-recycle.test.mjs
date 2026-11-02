import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {recycleModel} from '../local-models/recycle.mjs';

async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'faber-recycle-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));for(const file of ['one.gguf','two.gguf'])await fs.writeFile(path.join(directory,file),'synthetic');return {directory,model:{id:'fixture',complete:true,files:['one.gguf','two.gguf']}};}
test('recycle partial failure and cancellation preserve remaining files and report exact successful paths',async t=>{
  for(const cancel of [false,true])await t.test(cancel?'cancel':'trash failure',async t=>{
    const f=await fixture(t),controller=new AbortController();let effects=0;
    const result=await recycleModel({...f,signal:controller.signal,trashItem:async file=>{if(effects++)throw new Error('Synthetic trash failure');await fs.rename(file,file+'.recycled');if(cancel)controller.abort(new Error('Canceled fixture'));}});
    assert.equal(result.deleted,false);assert.deepEqual(result.files,['one.gguf']);assert.deepEqual(result.remainingFiles,['two.gguf']);await fs.access(path.join(f.directory,'two.gguf'));assert.match(result.error,cancel?/Canceled/:/trash failure/);
  });
});
test('recycle rechecks each path and refuses junction traversal, outside paths and replacement',async t=>{
  const f=await fixture(t);await assert.rejects(recycleModel({...f,model:{...f.model,files:['../outside.gguf']},trashItem:async()=>assert.fail('effect')}),/Unsafe|escapes/);
  const result=await recycleModel({...f,trashItem:async file=>{await fs.rename(file,file+'.recycled');await fs.appendFile(path.join(f.directory,'two.gguf'),'changed');}});
  assert.equal(result.deleted,false);assert.match(result.error,/changed/);assert.deepEqual(result.files,['one.gguf']);
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'faber-recycle-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.writeFile(path.join(outside,'model.gguf'),'preserve');await fs.symlink(outside,path.join(f.directory,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(recycleModel({...f,model:{...f.model,files:['linked/model.gguf']},trashItem:async()=>assert.fail('effect')}),/Symlinks|junctions/);assert.equal(await fs.readFile(path.join(outside,'model.gguf'),'utf8'),'preserve');
});
