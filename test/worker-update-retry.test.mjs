import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWorkerUpdate,prepareWorkerStartup} from '../desktop/worker-update.cjs';
import {openProfileActionLedger} from '../desktop/action-ledger.cjs';
import {workerUpdateExitCode} from '../desktop/worker-update-cli.cjs';
import {acquireProfileOwner} from '../desktop/profile-owner.cjs';
import {startWorkerControl} from '../desktop/worker-control.cjs';

const source=fileURLToPath(new URL('../',import.meta.url));
const legacy=()=>({version:1,projects:[],chats:[],runs:[],providers:[],settings:{},unknownLegacyField:{retained:true}});
const modern=()=>({...legacy(),workerProtocol:1,workerQueue:{paused:false},routines:[{id:'routine',enabled:true,bootGrant:{eligible:true}}],jobs:[{id:'job',status:'completed',outputs:[{externalId:'sent-once'}]}],runs:[{id:'run',toolEvents:[{id:'event',intent:{phase:'received',receipt:{externalId:'sent-once'}}}]}]});
async function fixture(t,state=modern()){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'Faber-checkpoint-retry-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'updates');let current=structuredClone(state);
  const update=await createWorkerUpdate({directory,namespace:'fixture'});
  const io={readState:async()=>structuredClone(current),writeState:async value=>current=structuredClone(value)};
  const options={fromVersion:'2.4.0',toVersion:'3.0.1',wasPaused:false,quiesce:async()=>{current.workerQueue={...(current.workerQueue||{}),paused:true};},checkpoint:io.readState};
  return {root,directory,update,io,options,get state(){return current;}};
}

test('legacy and partial journals add only absent arrays and preserve known receipts',async t=>{
  for(const state of [legacy(),{...legacy(),jobs:modern().jobs},modern()]){
    const f=await fixture(t,state);await f.update.prepare(f.options);await f.update.migrate(f.io);await f.update.activate(f.io);
    assert.deepEqual(f.state.unknownLegacyField,{retained:true});assert.equal(f.state.workerQueue.paused,true);
    assert.deepEqual(f.state.jobs,state.jobs||[]);assert.deepEqual(f.state.runs,state.runs);
  }
});

test('malformed partial journals fail before pause or transaction creation',async t=>{
  for(const bad of [{jobs:null},{runs:{}},{routines:[null]},{workerQueue:{}},{workerProtocol:0},{jobs:[{id:'j',outputs:null}]},{runs:[{id:'r',toolEvents:[{id:'e',intent:null}]}]}]){
    const f=await fixture(t,{...modern(),...bad}),before=structuredClone(f.state);
    await assert.rejects(f.update.prepare(f.options),/Invalid/);assert.deepEqual(f.state,before);assert.equal(f.update.status(),null);
  }
  for(const key of ['jobs','routines','runs']){const state=modern();delete state[key];const f=await fixture(t,state);await assert.rejects(f.update.prepare(f.options),/Invalid versioned worker journal/);assert.deepEqual(f.state,state);assert.equal(f.update.status(),null);}
});

test('rollback retains new chats, project edits and settings for review rather than overwriting them',async t=>{
  for(const change of [state=>state.chats.push({id:'new-chat',messages:[{content:'new message'}]}),state=>state.projects.push({id:'new-project'}),state=>state.settings.changed=true]){
    const f=await fixture(t);await f.update.prepare(f.options);const next=structuredClone(f.state);change(next);await f.io.writeState(next);
    await assert.rejects(f.update.recover(f.io),/changed after quiesce; recovery requires review/);assert.deepEqual(f.state,next);assert.equal(f.update.status().phase,'quiesced');
  }
  const f=await fixture(t,{...modern(),extensions:[{id:'approved-descriptor'}]});await f.update.prepare(f.options);
  const stopped=structuredClone(f.state);stopped.extensions=[];delete stopped.routines[0].bootGrant;await f.io.writeState(stopped);await f.update.recover(f.io);
  assert.deepEqual(f.state.extensions,[]);assert.equal(f.state.routines[0].bootGrant,undefined);assert.equal(f.update.status().phase,'rolled_back');
});

test('installer exit classes distinguish corruption, evidence review, live ownership and filesystem failures without displaying values',()=>{
  for(const [error,code] of [[new SyntaxError('Invalid JSON'),20],[new Error('Invalid versioned worker journal; original state preserved'),20],[new Error('Update journal belongs to another profile or schema'),20],[new Error('Worker checkpoint differs from its receipt'),21],[new Error('Profile changed after quiesce; recovery requires review'),21],[new Error('Quit the running Faber normally before installing this update.'),22],[new Error('Worker did not finish its checkpoint and shutdown; installation stopped'),22],[Object.assign(new Error('filesystem detail'),{code:'EACCES'}),23]])assert.equal(workerUpdateExitCode(error),code);
});

test('published evidence-free quiescing and needs_attention failures can retry a patched target without erasing history',async t=>{
  for(const phase of ['quiescing','needs_attention']){
    const f=await fixture(t,legacy()),prior={schemaVersion:1,namespace:'fixture',id:randomUUID(),phase,fromVersion:'2.4.0',toVersion:'3.0.0',fromProtocol:1,toProtocol:1,wasPaused:false};
    await fs.writeFile(path.join(f.directory,'worker-update.json'),JSON.stringify(prior));
    const reopened=await createWorkerUpdate({directory:f.directory,namespace:'fixture'});await reopened.prepare(f.options);await reopened.migrate(f.io);await reopened.activate(f.io);
    assert.equal(reopened.status().phase,'committed');const archive=(await fs.readdir(f.directory)).find(name=>name.endsWith('.superseded.json'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,archive),'utf8')),prior);
  }
});

test('same-target retry reuses only a matching checkpoint, including the snapshot-before-phase crash window',async t=>{
  const f=await fixture(t);const first=await f.update.prepare(f.options),again=await f.update.prepare(f.options);assert.equal(again.id,first.id);
  await fs.writeFile(path.join(f.directory,'worker-update.json'),JSON.stringify({...first,phase:'quiescing',checkpoint:undefined,checkpointDigest:undefined}));
  const reopened=await createWorkerUpdate({directory:f.directory,namespace:'fixture'});assert.equal((await reopened.prepare(f.options)).id,first.id);
  await assert.rejects(reopened.prepare({...f.options,toVersion:'3.0.2'}),/Recover/);
  const newer=structuredClone(f.state);newer.jobs[0].outputs.push({externalId:'newer'});await f.io.writeState(newer);
  await assert.rejects(reopened.prepare(f.options),/changed after quiesce/);assert.equal(f.state.jobs[0].outputs.length,2);
});

test('retry refuses missing, corrupted or changed checkpoint evidence and newer intents',async t=>{
  for(const change of ['missing','corrupt','intent','state']){
    const f=await fixture(t),prepared=await f.update.prepare(f.options),snapshot=path.join(f.directory,prepared.checkpoint);
    if(change==='missing')await fs.rm(snapshot);else if(change==='corrupt')await fs.writeFile(snapshot,'{}');else {const next=structuredClone(f.state);if(change==='intent')next.runs[0].toolEvents[0].intent.receipt.externalId='newer';else next.settings.changed=true;await f.io.writeState(next);}
    await assert.rejects(f.update.prepare(f.options),/checkpoint differs|changed after quiesce|intent\/receipt/);
    assert.equal(f.update.status().id,prepared.id);assert.equal((await fs.readdir(f.directory)).some(name=>name.endsWith('.superseded.json')),false);
  }
});

test('checkpoint captures a receipt completed during quiesce and never resumes an unpaused queue',async t=>{
  const f=await fixture(t),options={...f.options,quiesce:async()=>{const next=structuredClone(f.state);next.jobs[0].outputs.push({externalId:'last-receipt'});next.workerQueue.paused=true;await f.io.writeState(next);}};
  const prepared=await f.update.prepare(options),saved=JSON.parse(await fs.readFile(path.join(f.directory,prepared.checkpoint),'utf8'));assert.equal(saved.jobs[0].outputs.length,2);
  const changed=structuredClone(f.state);changed.workerQueue.paused=false;await f.io.writeState(changed);await assert.rejects(f.update.migrate(f.io),/changed after quiesce/);
});

test('old uninstaller authority reduction survives retry and first launch without restoring boot grants',async t=>{
  const f=await fixture(t);await f.update.prepare(f.options);const uninstalled=structuredClone(f.state);delete uninstalled.routines[0].bootGrant;uninstalled.extensions=[];await f.io.writeState(uninstalled);
  await f.update.prepare(f.options);await f.update.migrate(f.io);await f.update.activate(f.io);
  assert.equal(f.state.routines[0].bootGrant,undefined);assert.equal(f.state.routines[0].enabled,true);assert.equal(f.state.workerQueue.paused,true);assert.equal(f.state.jobs[0].outputs[0].externalId,'sent-once');
});

test('a newly granted boot authority is not accepted as an uninstaller change',async t=>{
  const state=modern();delete state.routines[0].bootGrant;const f=await fixture(t,state);await f.update.prepare(f.options);
  const changed=structuredClone(f.state);changed.routines[0].bootGrant={eligible:true};await f.io.writeState(changed);await assert.rejects(f.update.migrate(f.io),/changed after quiesce/);
});

test('installer handoff verifies unchanged paused evidence without adopting, mutating or pausing changed state',async t=>{
  const f=await fixture(t);await assert.rejects(f.update.verifyCheckpoint({readState:f.io.readState}),/checkpoint requires review/);await f.update.prepare(f.options);
  const journal=await fs.readFile(path.join(f.directory,'worker-update.json'),'utf8'),before=structuredClone(f.state);await f.update.verifyCheckpoint({readState:f.io.readState});assert.deepEqual(f.state,before);assert.equal(await fs.readFile(path.join(f.directory,'worker-update.json'),'utf8'),journal);
  for(const change of [state=>state.workerQueue.paused=false,state=>state.jobs[0].outputs.push({externalId:'later'}),state=>state.settings.changed=true]){const next=structuredClone(before);change(next);await f.io.writeState(next);await assert.rejects(f.update.verifyCheckpoint({readState:f.io.readState}),/changed after quiesce/);assert.deepEqual(f.state,next);}
});

test('incoherent metadata and a pre-existing new transaction snapshot are never adopted or overwritten',async t=>{
  for(const changed of [{checkpointDigest:''},{phase:'quiesced'},{migratedDigest:'invalid'}]){
    const f=await fixture(t),prior={schemaVersion:1,namespace:'fixture',id:randomUUID(),phase:'quiescing',fromVersion:'2.4.0',toVersion:'3.0.1',fromProtocol:1,toProtocol:1,wasPaused:false,...changed};
    await fs.writeFile(path.join(f.directory,'worker-update.json'),JSON.stringify(prior));await assert.rejects(createWorkerUpdate({directory:f.directory,namespace:'fixture'}),/journal/);
  }
  const f=await fixture(t),id=randomUUID(),file=path.join(f.directory,id+'.before.json');await fs.writeFile(file,'pre-existing evidence');
  await assert.rejects(f.update.prepare({...f.options,id}),/identity already exists/);assert.equal(await fs.readFile(file,'utf8'),'pre-existing evidence');assert.equal(f.update.status(),null);
});

function execute(binary,args,env={}){return new Promise((resolve,reject)=>{const child=spawn(binary,args,{windowsHide:true,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));});}

test('real file-backed CLI install retry, old uninstall and trusted first startup retain receipts',async t=>{
  const f=await fixture(t),local=path.join(f.root,'local'),dataDir=path.join(local,'Faber'),install=path.join(f.root,'install');await fs.mkdir(dataDir,{recursive:true});await fs.mkdir(path.join(install,'resources','app.asar'),{recursive:true});
  await fs.writeFile(path.join(install,'resources','app.asar','package.json'),JSON.stringify({version:'2.4.0'}));await fs.writeFile(path.join(dataDir,'state.json'),JSON.stringify(modern()));
  const cli=path.join(source,'desktop','worker-update-cli.cjs'),args=['--install-root',install,'--to-version','3.0.1','--isolated-local-app-data',local];
  for(const mode of ['prepare','prepare','uninstall','prepare']){const result=await execute(process.execPath,[cli,'--mode',mode,...args]);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).ok,true);}
  const startup=await prepareWorkerStartup({dataDir,registryRoot:path.join(local,'FaberProfiles'),isolated:true});assert.equal(startup.queuePaused,true);
  const state=JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'));assert.equal(state.routines[0].bootGrant,undefined);assert.equal(state.jobs[0].outputs[0].externalId,'sent-once');assert.equal(state.runs[0].toolEvents[0].intent.receipt.externalId,'sent-once');
  const ledger=await openProfileActionLedger({dataDir,registryRoot:path.join(local,'FaberProfiles'),isolated:true});try{const update=await createWorkerUpdate({directory:path.join(ledger.directory,'updates'),namespace:ledger.namespace});assert.equal(update.status().phase,'committed');assert.equal(update.status().checkpointDigest.length,64);}finally{await ledger.close();}
});

test('CLI handoff rejects a reopened kernel owner without sending shutdown, then verifies the old-uninstaller target read-only',async t=>{
  const f=await fixture(t),local=path.join(f.root,'local'),dataDir=path.join(local,'Faber'),install=path.join(f.root,'install');await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(path.join(dataDir,'state.json'),JSON.stringify(modern()));
  const cli=path.join(source,'desktop','worker-update-cli.cjs'),args=['--install-root',install,'--to-version','3.0.1','--isolated-local-app-data',local];
  assert.equal((await execute(process.execPath,[cli,'--mode','prepare',...args])).code,0);
  const owner=await acquireProfileOwner(dataDir);let controlCalls=0;const control=await startWorkerControl({dataDir,kind:'desktop',handler:async()=>{controlCalls++;return {};}});
  try{const result=await execute(process.execPath,[cli,'--mode','handoff',...args]);assert.equal(result.code,22,result.stderr);assert.equal(controlCalls,0);}finally{await control.close();await owner.close();}
  const before=await fs.readFile(path.join(dataDir,'state.json'),'utf8'),oldArgs=[...args];oldArgs[oldArgs.indexOf('--to-version')+1]='2.9.0';const result=await execute(process.execPath,[cli,'--mode','handoff',...oldArgs]);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).profiles[0].checkpointVerified,true);assert.equal(await fs.readFile(path.join(dataDir,'state.json'),'utf8'),before);
});
