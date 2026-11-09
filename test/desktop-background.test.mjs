import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createBackgroundWorker} from '../desktop/background.mjs';
import {acquireProfileOwner} from '../desktop/profile-owner.cjs';

test('background and sign-in require separate explicit settings bound to the chosen profile',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-background-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const registrations=[];let closed=0,paused=0;
  const options={dataDir:root,sourceDir:path.join(root,'source'),profileId:'default',app:{isPackaged:false,setLoginItemSettings:value=>registrations.push(value)},isAttached:()=>true,closeWindow:()=>closed++,pause:()=>paused++,quit:()=>{}};
  const worker=await createBackgroundWorker(options);assert.equal(worker.enabled,false);await assert.rejects(worker.request('worker.configure',{enabled:false,startAtLogin:true}),/Enable/);await worker.request('worker.configure',{enabled:true,startAtLogin:false});assert.equal(registrations.length,0);await worker.request('worker.configure',{enabled:true,startAtLogin:true});assert.deepEqual(registrations[0].args,[options.sourceDir,'--background-worker','--worker-profile','default']);assert.equal(registrations[0].openAtLogin,true);await worker.request('worker.closeWindow');await worker.request('worker.pause');assert.equal(closed,1);assert.equal(paused,1);await worker.close();const reopened=await createBackgroundWorker(options);assert.equal((await reopened.request('worker.state')).startAtLogin,true);await reopened.request('worker.configure',{enabled:false,startAtLogin:false});assert.equal(registrations.at(-1).openAtLogin,false);await reopened.close();
});
test('isolated worker smoke cannot mutate Windows login registration',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-background-login-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));let calls=0;const worker=await createBackgroundWorker({dataDir:root,sourceDir:root,app:{setLoginItemSettings:()=>calls++},isAttached:()=>false,allowLoginMutation:false});await assert.rejects(worker.request('worker.configure',{enabled:true,startAtLogin:true}),/disabled in isolated/);assert.equal(calls,0);assert.equal(worker.enabled,false);await worker.close();
});
test('kernel profile ownership rejects a second writer and can be reclaimed after close',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-owner-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const owner=await acquireProfileOwner(root);try{await assert.rejects(acquireProfileOwner(root),/EADDRINUSE|EACCES/);}finally{await owner.close();}const reclaimed=await acquireProfileOwner(root);await reclaimed.close();
});
