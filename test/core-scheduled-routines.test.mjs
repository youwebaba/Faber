import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRuntime} from '../core/runtime.mjs';
import {fileTools} from '../tools/files.mjs';
import {defaultWorkLimits} from '../core/work-budget.mjs';
import {providerBody} from '../core/provider.mjs';

const until=async check=>{for(let i=0;i<400;i++){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Scheduled routine timeout');};
async function fixture(t,provider,host={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-scheduled-test-'))),dataDir=path.join(root,'profile'),sourceDir=path.join(root,'source'),projectPath=path.join(root,'project');await fs.mkdir(sourceDir);await fs.mkdir(projectPath);
  const runtime=await createRuntime({dataDir,sourceDir,provider,host});runtime.registerTools(fileTools());await runtime.startRoutines();t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const project=await runtime.request('project.create',{name:'Scheduled fixture',path:projectPath}),definition={name:'Reviewed report',projectId:project.id,providerId:'local-ollama',model:'qwen-fixture',instructions:'Summarize the approved inputs.',inputs:'Ten files',outputs:'One dated report',completion:'Every input has a summary or an explicit exception',tools:['folder_report'],paths:['.'],grants:['files'],limits:{...defaultWorkLimits,perCallOutputTokens:128}};
  const job=id=>runtime.request('routines.state').then(state=>state.jobs.find(job=>job.id===id));
  return {root,dataDir,projectPath,runtime,definition,job,async save(){const routine=await runtime.request('routines.save',definition);await runtime.request('routines.enable',{id:routine.id,enabled:true});return routine;}};
}
const managed={providerControls:()=>({context:{mode:'managed',capacityTokens:4096},thinking:{supported:true,mode:'llama_cpp'}}),routineModelInfo:()=>({local:true,architecture:'qwen35',contextTokens:4096,label:'Controlled Qwen'})};

test('normal routine API publishes ten-file coverage with durable call budgets and reuses the dated receipt',async t=>{
  let calls=0;const f=await fixture(t,async function*({provider,messages,tools}){calls++;assert.equal(provider.workOutputTokens,128);assert.equal(providerBody({provider,messages,tools}).options.num_predict,128);assert.equal(tools.length,0);yield {type:'delta',text:'The source describes a reviewed local work item.'};yield {type:'usage',usage:{inputTokens:75,outputTokens:12}};},managed);
  await fs.mkdir(path.join(f.projectPath,'input'));for(let i=0;i<9;i++)await fs.writeFile(path.join(f.projectPath,'input',`${i}.txt`),`Work item ${i}: check the local source.`);await fs.writeFile(path.join(f.projectPath,'input','unreadable.txt'),Buffer.from([255,254]));
  f.definition.report={inputDirectory:'input',outputDirectory:'reports',timeZone:'UTC'};f.definition.limits.maxTokens=50000;f.definition.limits.maxSpend=0;
  const routine=await f.save(),job=await f.runtime.request('routines.run',{id:routine.id});await until(async()=> (await f.job(job.id)).status==='needs_attention');const result=await f.job(job.id);
  assert.equal(result.report.inputs.length,10);assert.equal(result.report.inputs.filter(value=>value.status==='summarized').length,9);assert.equal(result.report.inputs.filter(value=>value.status==='needs_review').length,1);assert.equal(calls,9);assert.equal(result.budget.calls.length,9);assert.ok(result.budget.calls.every(call=>call.status==='settled'&&call.chargedTokens===87&&call.chargedCost===0));assert.equal(result.outputs.length,1);
  const original=await fs.readFile(path.join(f.projectPath,result.report.path),'utf8');assert.match(original,/unreadable.txt/);assert.match(original,/Needs review/);
  const repeat=await f.runtime.request('routines.run',{id:routine.id});await until(async()=> ['completed','needs_attention'].includes((await f.job(repeat.id)).status));const reused=await f.job(repeat.id);assert.equal(reused.report.reused,true);assert.equal(reused.report.inputs.filter(value=>value.status==='summarized').length,9);assert.equal(reused.report.needsReview,true);assert.equal(reused.status,'needs_attention');assert.equal(calls,9);assert.equal(await fs.readFile(path.join(f.projectPath,result.report.path),'utf8'),original);
});

test('strict unknown provider bounds pause before any model request',async t=>{
  let calls=0;const f=await fixture(t,async function*(){calls++;yield {type:'delta',text:'Should not dispatch'};});f.definition.tools=[];f.definition.limits.maxSpend=0;const routine=await f.save(),job=await f.runtime.request('routines.run',{id:routine.id});await until(async()=> (await f.job(job.id)).status==='needs_attention');assert.equal(calls,0);assert.match((await f.job(job.id)).reason,/cost ceiling/);
});

test('routine runtime remains independent of the global chat timeout and Stop aborts the transport',async t=>{
  let entered,aborted=false;const began=new Promise(resolve=>entered=resolve),provider=async function*({signal}){entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));};
  const f=await fixture(t,provider);await f.runtime.request('settings.update',{runTimeoutMs:1000});f.definition.tools=[];f.definition.limits.runtimeMs=10000;const routine=await f.save(),job=await f.runtime.request('routines.run',{id:routine.id});await began;await new Promise(resolve=>setTimeout(resolve,1100));assert.equal((await f.job(job.id)).status,'running');await f.runtime.request('routines.stop',{jobId:job.id});assert.equal(aborted,true);assert.equal((await f.job(job.id)).status,'canceled');
});

test('routine children share scope and budget and parent completion waits for the child tree',async t=>{
  let release,began;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>began=resolve);
  const provider=async function*({messages}){const last=messages.at(-1);if(last.role==='tool'){yield {type:'delta',text:'Parent returned.'};return;}if(last.content==='child task'){began();await gate;yield {type:'delta',text:'Child returned.'};return;}yield {type:'tool',id:'spawn',name:'agent_create',args:{task:'child task'}};};
  const f=await fixture(t,provider,managed);f.definition.tools=['agent_create'];f.definition.grants=[];const routine=await f.save(),job=await f.runtime.request('routines.run',{id:routine.id});await started;await until(async()=> (await f.runtime.request('state.get')).runs.some(run=>run.jobId===job.id&&!run.parentRunId&&run.status==='completed'));assert.equal((await f.job(job.id)).status,'running');const runs=(await f.runtime.request('state.get')).runs.filter(run=>run.jobId===job.id);assert.equal(runs.length,2);assert.ok(runs.every(run=>run.projectGrants.length===0&&run.grants.length===0));release();await until(async()=> (await f.job(job.id)).status==='completed');assert.equal((await f.job(job.id)).budget.calls.length,3);
});

test('atomic create-only writes preserve an unexpected existing destination',async t=>{
  const f=await fixture(t,async function*(){}),tool=fileTools().find(value=>value.name==='files_write'),ctx={project:{path:f.projectPath},dataDir:f.dataDir,signal:new AbortController().signal,authorizePath:async()=>{}};
  await tool.execute({path:'created.txt',text:'first',expectedSha256:null},ctx);await assert.rejects(tool.execute({path:'created.txt',text:'replacement',expectedSha256:null},ctx),/changed|expected|match/i);assert.equal(await fs.readFile(path.join(f.projectPath,'created.txt'),'utf8'),'first');
});

test('a reviewed successful retry is not failed by a previous attempt in the same durable job',async t=>{
  let fail=true;const f=await fixture(t,async function*(){if(fail)throw new Error('Controlled read-only failure');yield {type:'delta',text:'Recovered successfully.'};});f.definition.tools=[];const routine=await f.save(),job=await f.runtime.request('routines.run',{id:routine.id});await until(async()=> (await f.job(job.id)).status==='needs_attention');await f.runtime.request('routines.review',{jobId:job.id,outcome:'verified',note:'No external effect occurred; source inspection complete.'});fail=false;await f.runtime.request('routines.resume',{jobId:job.id});await until(async()=> (await f.job(job.id)).status==='completed');assert.equal((await f.job(job.id)).attempts,2);
});
