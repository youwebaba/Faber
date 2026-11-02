import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {containedPath,fileTools} from '../tools/files.mjs';
import {runProcess} from '../tools/process.mjs';
import {activationTarget} from '../desktop/voice.mjs';
const temp=()=>fs.mkdtemp(path.join(os.tmpdir(),'harness-tools-test-'));

test('workspace paths reject traversal, absolute paths, ADS and external junctions',async t=>{
  const root=await temp(),outside=await temp();t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(outside,{recursive:true,force:true})]));
  await fs.writeFile(path.join(root,'inside.txt'),'hello');
  assert.equal(await containedPath(root,'inside.txt'),path.join(root,'inside.txt'));
  for(const value of ['../escape','C:\\escape','\\\\host\\share','file.txt:secret',path.resolve(root,'..','escape')])await assert.rejects(containedPath(root,value));
  await fs.symlink(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(containedPath(root,'linked/new.txt',{missing:true}),/escapes/);
  const write=fileTools().find(t=>t.name==='files_write');
  await write.execute({path:'nested/file.txt',text:'saved'},{project:{path:root}});
  assert.equal(await fs.readFile(path.join(root,'nested','file.txt'),'utf8'),'saved');
  await assert.rejects(write.execute({path:'linked/new.txt',text:'bad'},{project:{path:root}}),/escapes/);
  const backupRoot=path.join(root,'private-data');
  const result=await write.execute({path:'nested/file.txt',text:'updated'},{project:{path:root},dataDir:backupRoot});
  assert.equal(await fs.readFile(result.backup,'utf8'),'saved');
  await assert.rejects(write.execute({path:'nested/file.txt',text:'overwrite',expectedSha256:'0'.repeat(64)},{project:{path:root},dataDir:backupRoot}),/changed/);
  const canceled=new AbortController();canceled.abort();await assert.rejects(write.execute({path:'never.txt',text:'no'},{project:{path:root},dataDir:backupRoot,signal:canceled.signal}));
  await assert.rejects(write.execute({path:'nested/file.txt',text:'source edit'},{project:{path:root},dataDir:backupRoot,sourceDir:root}),/protected/);
  const lateAbort=new AbortController(),originalRead=fs.readFile;let reads=0;
  fs.readFile=async(file,...args)=>{const result=await originalRead(file,...args);if(file===path.join(root,'nested','file.txt')&&++reads===2)lateAbort.abort();return result;};
  try{await assert.rejects(write.execute({path:'nested/file.txt',text:'cancelled edit'},{project:{path:root},dataDir:backupRoot,signal:lateAbort.signal}),/abort/i);}finally{fs.readFile=originalRead;}
  assert.equal(await fs.readFile(path.join(root,'nested','file.txt'),'utf8'),'updated');
});

test('bounded process captures output and rejects timeout/output overflow',async()=>{
  const result=await runProcess(process.execPath,['-e','console.log("done")'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});assert.equal(result.code,0);assert.match(result.stdout,/done/);
  await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:150,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}),/timed out/);
  await assert.rejects(runProcess(process.execPath,['-e','console.log("x".repeat(10000))'],{maxOutput:100,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}),/output limit/);
});

test('cancel kills process and its child tree',async t=>{
  const root=await temp();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pidFile=path.join(root,'pid.txt'),controller=new AbortController();
  const code=`const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
  const execution=runProcess(process.execPath,['-e',code],{signal:controller.signal,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  const rejected=assert.rejects(execution,/cancelled/);
  let pid;
  for(let i=0;i<100;i++){try{pid=Number(await fs.readFile(pidFile,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,25));}}
  assert.ok(pid,'child launched');controller.abort();await rejected;
  let alive=true;
  for(let i=0;i<40;i++){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,25));}
  assert.equal(alive,false,'descendant is gone');
});

test('voice routing requires enabled phrase, resolves selected duplicate, and honors phrase boundary',()=>{
  const chats=[{id:'a',voice:{enabled:true,phrase:'Hey Faber'}},{id:'b',voice:{enabled:true,phrase:'Hey Faber'}},{id:'c',voice:{enabled:false,phrase:'Computer'}}];
  assert.deepEqual(activationTarget(chats,'hey faber, summarize','b'),{chatId:'b',text:'summarize'});
  assert.equal(activationTarget(chats,'Hey Fabernna hello','a'),null);
  assert.equal(activationTarget(chats,'Computer hello','c'),null);
  assert.throws(()=>activationTarget(chats,'Hey Faber hello','missing'),/Several chats/);
});
