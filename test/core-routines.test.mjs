import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRuntime} from '../core/runtime.mjs';
import {fileTools} from '../tools/files.mjs';

const until=async check=>{for(let index=0;index<200;index++){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Routine test timed out');};
async function fixture(t,provider,host={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-routine-test-'))),dataDir=path.join(root,'profile'),sourceDir=path.join(root,'source'),projectPath=path.join(root,'project');await fs.mkdir(sourceDir);await fs.mkdir(projectPath);
  let runtime=await createRuntime({dataDir,sourceDir,provider,host});runtime.registerTools(fileTools());await runtime.startRoutines();
  const project=await runtime.request('project.create',{name:'Routine project',path:projectPath});
  const definition={name:'Write report',projectId:project.id,providerId:'local-ollama',model:'fixture',instructions:'Read inputs and write one report.',inputs:'Known local inputs',outputs:'report.txt',completion:'A report exists',tools:['files_read','files_write'],paths:['.'],grants:['files']};
  t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,dataDir,sourceDir,projectPath,definition,get runtime(){return runtime;},async restart(){await runtime.close();runtime=await createRuntime({dataDir,sourceDir,provider,host});runtime.registerTools(fileTools());await runtime.startRoutines();return runtime;},async routine(){const routine=await runtime.request('routines.save',definition);await runtime.request('routines.enable',{id:routine.id,enabled:true});return routine;}};
}
const writing=async function*({messages}){if(messages.at(-1)?.role==='tool')yield {type:'delta',text:'Report written.'};else yield {type:'tool',id:'write-'+messages.length,name:'files_write',args:{path:'report.txt',text:'one report'}};};
const jobState=async(runtime,id)=> (await runtime.request('routines.state')).jobs.find(job=>job.id===id);

test('a routine binds a reviewed read-only MCP tool to its project and the exact grant',async t=>{
  let reads=0;
  const name='mcp_fixture_read',provider=async function*({messages}){if(messages.at(-1)?.role==='tool')yield {type:'delta',text:'Verified.'};else yield {type:'tool',id:'read',name,args:{}};};
  const f=await fixture(t,provider);
  const tool={name,parameters:{type:'object',properties:{},additionalProperties:false},permission:'network',description:'Read fixture',projectId:f.definition.projectId,execute:async()=>{reads++;return {value:'marker'};}};
  const publish=revision=>f.runtime.replaceConnectorTools([{...tool,mcpGrant:{fingerprint:'v1',revision,effect:'read'}}]);publish('original');
  const routine=await f.runtime.request('routines.save',{...f.definition,tools:[name],grants:[]});await f.runtime.request('routines.enable',{id:routine.id,enabled:true});
  const job=await f.runtime.request('routines.run',{id:routine.id});await until(async()=>(await jobState(f.runtime,job.id)).status==='completed');assert.equal(reads,1);
  const project=await f.runtime.request('project.create',{name:'Other project',path:f.sourceDir});
  await assert.rejects(f.runtime.request('routines.save',{...f.definition,projectId:project.id,tools:[name]}),/this project/);
  publish('reapproved');const changed=await f.runtime.request('routines.run',{id:routine.id});
  await until(async()=>(await jobState(f.runtime,changed.id)).status==='needs_attention');
  assert.match((await jobState(f.runtime,changed.id)).reason,/MCP tool or grant changed/);assert.equal(reads,1);
});

test('manual routine records an immutable revision, action intent and verified receipt',async t=>{
  const f=await fixture(t,writing),routine=await f.routine(),job=await f.runtime.request('routines.run',{id:routine.id,inputs:'fixed input snapshot'});
  const finished=await until(async()=>{const row=await jobState(f.runtime,job.id);return row.status==='completed'&&row;});
  assert.equal(await fs.readFile(path.join(f.projectPath,'report.txt'),'utf8'),'one report');assert.equal(finished.inputs,'fixed input snapshot');assert.equal(finished.outputs.length,1);assert.equal(finished.attempts,1);assert.ok(finished.chatId);
  const run=(await f.runtime.request('state.get')).runs.find(value=>value.id===finished.runId);assert.equal(run.toolEvents[0].intent.phase,'received');assert.equal(run.toolEvents[0].intent.receipt.verified,true);
  await f.runtime.request('routines.save',{...f.definition,id:routine.id,instructions:'Future revision'});const state=await f.runtime.request('routines.state');assert.equal(state.routines[0].revision,2);assert.equal(state.jobs[0].definition.instructions,f.definition.instructions);assert.equal(state.routines[0].revisions[0].definition.instructions,f.definition.instructions);
  await assert.rejects(f.runtime.request('chat.update',{id:finished.chatId,grants:['shell']}),/routine definition/);
});
test('preview records proposed writes without running them; enable is explicit',async t=>{
  const f=await fixture(t,writing),routine=await f.runtime.request('routines.save',f.definition);await assert.rejects(f.runtime.request('routines.run',{id:routine.id}),/enable/);
  const job=await f.runtime.request('routines.run',{id:routine.id,preview:true});const finished=await until(async()=>{const row=await jobState(f.runtime,job.id);return row.status==='completed'&&row;});assert.equal(finished.proposals.length,1);assert.equal(finished.outputs.length,0);await assert.rejects(fs.stat(path.join(f.projectPath,'report.txt')),/ENOENT/);
});
test('routine path limits reject escape and revocation stops pending approval without expanding grants',async t=>{
  const f=await fixture(t,writing);await fs.mkdir(path.join(f.projectPath,'approved'));f.definition.paths=['approved'];f.definition.grants=[];const routine=await f.routine(),job=await f.runtime.request('routines.run',{id:routine.id});
  await until(async()=> (await f.runtime.request('state.get')).approvals.length);
  const approval=(await f.runtime.request('state.get')).approvals[0];assert.equal(approval.rememberable,false);await assert.rejects(f.runtime.request('approval.resolve',{id:approval.id,allow:true,remember:true}),/only to this operation/);
  await f.runtime.request('routines.revoke',{id:routine.id});assert.equal((await jobState(f.runtime,job.id)).status,'canceled');await assert.rejects(f.runtime.request('approval.resolve',{id:approval.id,allow:true}),/no longer/);await assert.rejects(fs.stat(path.join(f.projectPath,'report.txt')),/ENOENT/);
});
test('interrupted writes reconcile matching destination evidence without automatic replay',async t=>{
  const f=await fixture(t,writing),routine=await f.routine();await f.runtime.request('routines.pause',{paused:true});const job=await f.runtime.request('routines.run',{id:routine.id});await f.runtime.close();
  const file=path.join(f.dataDir,'state.json'),state=JSON.parse(await fs.readFile(file,'utf8')),stored=state.jobs.find(value=>value.id===job.id);stored.status='running';stored.attempts=1;stored.chatId='crashed-chat';stored.runId='crashed-run';stored.runIds=['crashed-run'];
  state.chats.push({id:'crashed-chat',projectId:f.definition.projectId,title:'Interrupted routine',providerId:'local-ollama',model:'fixture',grants:[],projectGrants:[],inbox:[],messages:[],voice:{enabled:false},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false,routineJobId:job.id});
  state.runs.push({id:'crashed-run',chatId:'crashed-chat',jobId:job.id,status:'running',startedAt:new Date().toISOString(),grants:['files'],projectGrants:[],modelCalls:[],toolEvents:[{id:'write-event',name:'files_write',args:{path:'report.txt',text:'one report'},status:'running',intent:{id:'intent-write',key:'test-key',phase:'dispatching',permission:'files'}}]});
  await fs.writeFile(path.join(f.projectPath,'report.txt'),'one report');await fs.writeFile(file,JSON.stringify(state));await f.restart();const recovered=await jobState(f.runtime,job.id);assert.equal(recovered.status,'needs_attention');assert.equal(recovered.reviewRequired,false);assert.equal(recovered.outputs[0].result.reconciled,true);assert.equal(recovered.outputs[0].result.path,'report.txt');assert.equal(recovered.attempts,1);
  await assert.rejects(f.runtime.request('routines.resume',{jobId:job.id}),/Review/);await f.runtime.request('routines.review',{jobId:job.id,outcome:'verified',note:'Matched the expected report digest; continue from its receipt.'});assert.equal((await jobState(f.runtime,job.id)).status,'paused');
});
test('editing a routine changes future admissions while an admitted revision retains its scope',async t=>{
  let release,started;const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  const provider=async function*({messages}){if(messages.at(-1)?.role==='tool')yield {type:'delta',text:'done'};else yield {type:'tool',id:'held-write',name:'fixture_write',args:{path:'report.txt',text:'old revision'}};};
  const f=await fixture(t,provider),write=fileTools().find(tool=>tool.name==='files_write');f.runtime.registerTools([{...write,name:'fixture_write',async execute(args,ctx){started();await gate;return write.execute(args,ctx);}}]);f.definition.tools=['fixture_write'];const routine=await f.routine(),job=await f.runtime.request('routines.run',{id:routine.id});await began;
  await fs.mkdir(path.join(f.projectPath,'future'));await f.runtime.request('routines.save',{...f.definition,id:routine.id,instructions:'Future work',paths:['future']});assert.equal((await jobState(f.runtime,job.id)).status,'running');release();await until(async()=> (await jobState(f.runtime,job.id)).status==='completed');assert.equal(await fs.readFile(path.join(f.projectPath,'report.txt'),'utf8'),'old revision');assert.equal((await jobState(f.runtime,job.id)).revision,1);await assert.rejects(f.runtime.request('routines.run',{id:routine.id}),/enable/);
});
test('approved file grant cannot escape a routine path and denied actions produce no output receipt',async t=>{
  const f=await fixture(t,writing);await fs.mkdir(path.join(f.projectPath,'approved'));f.definition.paths=['approved'];const routine=await f.routine(),job=await f.runtime.request('routines.run',{id:routine.id});await until(async()=> (await jobState(f.runtime,job.id)).status==='needs_attention');await assert.rejects(fs.stat(path.join(f.projectPath,'report.txt')),/ENOENT/);assert.equal((await jobState(f.runtime,job.id)).outputs.length,0);
  const second=await f.runtime.request('routines.save',{...f.definition,name:'Needs approval',paths:['.'],grants:[]});await f.runtime.request('routines.enable',{id:second.id,enabled:true});const next=await f.runtime.request('routines.run',{id:second.id});await until(async()=> (await f.runtime.request('state.get')).approvals.length);const approval=(await f.runtime.request('state.get')).approvals[0];await f.runtime.request('approval.resolve',{id:approval.id,allow:false});await until(async()=> ['completed','needs_attention'].includes((await jobState(f.runtime,next.id)).status));assert.equal((await jobState(f.runtime,next.id)).outputs.length,0);assert.equal((await jobState(f.runtime,next.id)).reviewRequired,undefined);
});
test('changing a saved connection requires routine reauthorization and does not silently expand credentials',async t=>{
  let calls=0;const f=await fixture(t,async function*(){calls++;yield {type:'delta',text:'answer'};}),routine=await f.routine();await f.runtime.request('routines.pause',{paused:true});const job=await f.runtime.request('routines.run',{id:routine.id});await f.runtime.request('provider.save',{id:'local-ollama',name:'Edited endpoint',kind:'ollama',baseUrl:'http://127.0.0.1:11435',model:'fixture'});await f.runtime.request('routines.pause',{paused:false});await until(async()=> (await jobState(f.runtime,job.id)).status==='needs_attention');assert.equal(calls,0);assert.match((await jobState(f.runtime,job.id)).reason,/connection or credentials changed/);
});
test('desktop-dependent routine waits for an attached UI and Stop cancels that wait',async t=>{
  let attached=false,calls=0;const provider=async function*(){yield {type:'tool',id:'desktop',name:'fixture_desktop',args:{}};};const f=await fixture(t,provider,{interactionAvailable:()=>attached});f.runtime.registerTools([{name:'fixture_desktop',permission:'computer',description:'Controlled interaction fixture',parameters:{type:'object',properties:{},additionalProperties:false},execute:()=>{calls++;return {ok:true};}}]);f.definition.tools=['fixture_desktop'];f.definition.grants=[];const routine=await f.routine(),job=await f.runtime.request('routines.run',{id:routine.id});await until(async()=> (await jobState(f.runtime,job.id)).status==='waiting_interaction');assert.equal(calls,0);await f.runtime.request('routines.stop',{jobId:job.id});assert.equal((await jobState(f.runtime,job.id)).status,'canceled');assert.equal(calls,0);attached=true;
});
test('steering across the awaited durable intent prevents the superseded write from dispatching',async t=>{
  const provider=async function*({messages}){if(messages.some(message=>message.role==='user'&&message.content.includes('Do not write')))yield {type:'delta',text:'Correction applied without a write.'};else yield {type:'tool',id:'obsolete-write',name:'files_write',args:{path:'report.txt',text:'obsolete'}};};
  const f=await fixture(t,provider),routine=await f.routine();let steered=false,correction;
  const unsubscribe=f.runtime.subscribe(event=>{if(event.type!=='state'||steered)return;const run=event.state.runs.find(run=>run.jobId&&run.toolEvents.some(tool=>tool.intent?.phase==='dispatching'));if(run){steered=true;correction=f.runtime.request('chat.steer',{chatId:run.chatId,runId:run.id,text:'Do not write; acknowledge this correction.',correctionId:'intent-journal-correction'});}});
  const job=await f.runtime.request('routines.run',{id:routine.id});await until(async()=> (await jobState(f.runtime,job.id)).status==='completed');unsubscribe();await correction;assert.equal(steered,true);await assert.rejects(fs.stat(path.join(f.projectPath,'report.txt')),/ENOENT/);assert.equal((await jobState(f.runtime,job.id)).outputs.length,0);const run=(await f.runtime.request('state.get')).runs.find(run=>run.jobId===job.id);assert.equal(run.toolEvents[0].status,'superseded');assert.equal(run.toolEvents[0].intent.phase,'not_executed');
});
test('a verified action key returns its receipt instead of repeating an identical effect',async t=>{
  const provider=async function*({messages}){if(messages.at(-1)?.role==='tool')yield {type:'delta',text:'done'};else{yield {type:'tool',id:'write-first',name:'files_write',args:{path:'report.txt',text:'once'}};yield {type:'tool',id:'write-repeat',name:'files_write',args:{text:'once',path:'report.txt'}};}};
  const f=await fixture(t,provider),routine=await f.routine(),job=await f.runtime.request('routines.run',{id:routine.id});await until(async()=> (await jobState(f.runtime,job.id)).status==='completed');const run=(await f.runtime.request('state.get')).runs.find(run=>run.jobId===job.id);assert.equal(run.toolEvents[1].intent.phase,'reused');assert.equal((await jobState(f.runtime,job.id)).outputs.length,1);await assert.rejects(fs.stat(path.join(f.dataDir,'file-backups')),/ENOENT/);
});
test('safe read-only recovery retries the stable job within its attempt bound',async t=>{
  let calls=0;const f=await fixture(t,async function*(){calls++;yield {type:'delta',text:'read-only result'};}),routine=await f.routine();await f.runtime.request('routines.pause',{paused:true});const job=await f.runtime.request('routines.run',{id:routine.id});await f.runtime.close();
  const file=path.join(f.dataDir,'state.json'),state=JSON.parse(await fs.readFile(file,'utf8'));state.jobs[0].status='running';state.jobs[0].attempts=1;state.workerQueue.paused=false;await fs.writeFile(file,JSON.stringify(state));await f.restart();await until(async()=> (await jobState(f.runtime,job.id)).status==='completed');assert.equal(calls,1);assert.equal((await jobState(f.runtime,job.id)).attempts,2);
  await f.runtime.close();const capped=JSON.parse(await fs.readFile(file,'utf8'));capped.jobs[0].status='running';capped.jobs[0].attempts=3;await fs.writeFile(file,JSON.stringify(capped));await f.restart();assert.equal((await jobState(f.runtime,job.id)).status,'needs_attention');assert.equal(calls,1);
});
test('revoke preserves review-required state for an interrupted dispatched effect',async t=>{
  let started;const began=new Promise(resolve=>started=resolve),provider=async function*(){yield {type:'tool',id:'uncertain',name:'fixture_effect',args:{}};};const f=await fixture(t,provider);f.runtime.registerTools([{name:'fixture_effect',permission:'files',description:'Controlled uncertain effect',parameters:{type:'object',properties:{},additionalProperties:false},execute:async(_args,{signal})=>{started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}]);f.definition.tools=['fixture_effect'];const routine=await f.routine(),job=await f.runtime.request('routines.run',{id:routine.id});await began;await f.runtime.request('routines.revoke',{id:routine.id});const stopped=await jobState(f.runtime,job.id);assert.equal(stopped.status,'needs_attention');assert.equal(stopped.reviewRequired,true);await assert.rejects(f.runtime.request('routines.resume',{jobId:job.id}),/revoked/);
});
test('observed input hashes and durable job records survive deletion of their activity chat',async t=>{
  const provider=async function*({messages}){if(messages.at(-1)?.role==='tool')yield {type:'delta',text:'input inspected'};else yield {type:'tool',id:'read-input',name:'files_read',args:{path:'input.txt'}};};const f=await fixture(t,provider);await fs.writeFile(path.join(f.projectPath,'input.txt'),'known input');const routine=await f.routine(),job=await f.runtime.request('routines.run',{id:routine.id,inputs:'input.txt revision to inspect'});await until(async()=> (await jobState(f.runtime,job.id)).status==='completed');const finished=await jobState(f.runtime,job.id);assert.equal(finished.inputReceipts[0].path,'input.txt');assert.match(finished.inputReceipts[0].sha256,/^[a-f0-9]{64}$/);await f.runtime.request('chat.delete',{chatId:finished.chatId});assert.equal((await jobState(f.runtime,job.id)).inputReceipts[0].sha256,finished.inputReceipts[0].sha256);assert.equal((await jobState(f.runtime,job.id)).inputs,'input.txt revision to inspect');
});
