// Opt-in acceptance against a real local Safetensors package and pinned private worker.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRuntime } from '../core/runtime.mjs';
import { createLocalModels } from '../local-models/index.mjs';
import { runProcess } from '../tools/process.mjs';

const directory=process.env.FABER_SAFETENSORS_MODEL_DIRECTORY;
if(!directory||!path.isAbsolute(directory))throw new Error('Set FABER_SAFETENSORS_MODEL_DIRECTORY to an absolute complete local model package');
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-safetensors-managed-')),secrets=new Map(),children=[];
let localModels;
const runtime=await createRuntime({dataDir,sourceDir:path.resolve(import.meta.dirname,'..'),host:{getSecret:async id=>secrets.get(id),setSecret:async(id,value)=>secrets.set(id,value),assertProviderAvailable:(...args)=>localModels?.assertProviderAvailable(...args),providerControls:(...args)=>localModels?.providerControls(...args),modelDisplayName:(...args)=>localModels?.modelDisplayName(...args)}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  localModels=await createLocalModels({dataDir,runtime,getHubState:async()=>({downloadDirectory:directory,downloads:[]}),emit:event=>runtime.emit(event),pollMs:50,loadTimeoutMs:120000,spawnImpl:(executable,args,options)=>{assert.equal(args.length,1,'Native worker must receive no network or service arguments');assert.equal(options.stdio[0],'pipe');const child=spawn(executable,args,options);children.push(child);return child;}});
  runtime.registerTools(localModels.tools());
  const project=await runtime.request('project.create',{name:'Native acceptance',path:dataDir}),chat=await runtime.request('chat.create',{projectId:project.id,title:'Native acceptance'});
  await runtime.request('chat.update',{id:chat.id,grants:['computer']});
  const listed=await runtime.request('tool.run',{chatId:chat.id,name:'local_models_list',args:{}}),model=listed.models.find(model=>model.format==='safetensors');assert.ok(model?.available,model?.reason||'No eligible native package');
  await runtime.request('tool.run',{chatId:chat.id,name:'local_model_start',args:{modelId:model.id}});
  let ready;
  for(let count=0;count<1200;count++){ready=await localModels.request('localModels.list');if(ready.process.status==='ready')break;if(ready.process.status==='failed')throw new Error(ready.process.error);await pause(100);}
  assert.equal(ready.process.status,'ready');assert.equal(ready.process.observed.backend,'cpu');
  assert.equal((await runtime.request('state.get')).chats.find(item=>item.id===chat.id).providerId,chat.providerId,'Start must preserve explicit chat selection');
  const provider=(await runtime.request('state.get')).providers.find(item=>item.id===ready.process.providerId),key=secrets.get(provider.id),base=provider.baseUrl.replace(/\/v1$/,'');assert.equal(new URL(base).hostname,'127.0.0.1');
  const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  assert.equal((await fetch(`${base}/v1/models`)).status,401);assert.equal((await fetch(`${base}/v1/models`,{headers:{...headers,Origin:'https://untrusted.example'}})).status,401);
  for(const route of ['/v1/files','/v1/models/reload','/ui','/mcp'])assert.equal((await fetch(base+route,{headers})).status,404);
  const generate=async(stream,signal,max_tokens=8)=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers,body:JSON.stringify({model:ready.process.model,messages:[{role:'user',content:'Hello'}],temperature:0,max_tokens,stream}),signal});
  const response=await generate(false);assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.ok(result.choices?.[0]?.message?.content);assert.equal(result.model,ready.process.model);
  const streaming=await generate(true);assert.equal(streaming.status,200);assert.match(await streaming.text(),/\[DONE\]/);
  const controller=new AbortController(),active=await generate(true,controller.signal,1000),reader=active.body.getReader();assert.ok(!(await reader.read()).done);controller.abort();await reader.cancel().catch(()=>{});
  const afterCancel=await generate(false);assert.equal(afterCancel.status,200);await afterCancel.json();assert.equal((await localModels.request('localModels.list')).process.status,'ready');
  let workerHasNoListener=null;
  if(process.platform==='win32'){
    const pid=children.at(-1).pid;
    const check=await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',`@(Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue).Count`],{timeout:30000});
    assert.equal(check.code,0);assert.equal(check.stdout.trim(),'0','Native worker must have no listening socket');workerHasNoListener=true;
  }
  await runtime.request('tool.run',{chatId:chat.id,name:'local_model_stop',args:{}});assert.equal((await localModels.request('localModels.list')).process.status,'stopped');assert.ok(children.every(child=>child.exitCode!==null||child.signalCode));
  await assert.rejects(fetch(`${base}/v1/models`,{headers}));assert.ok(!(await fs.readdir(directory)).some(name=>name.startsWith('.faber-safetensors-')));
  assert.ok(!(await fs.readdir(path.join(dataDir,'local-models'))).some(name=>name.endsWith('.key')));
  const report={ok:true,kind:'real-private-native-worker',cpu:true,registeredToolStartStop:true,explicitChatSelectionPreserved:true,authenticatedEndpoint:true,browserOriginRejected:true,privilegedRoutesAbsent:true,realCompletions:true,realStreaming:true,cancelAndReuse:true,workerHasNoListener,processStopped:true,stagingRemoved:true,keyFilesRemoved:true,limits:['Tiny model establishes runtime operation, not production model quality or GPU compatibility']};
  await fs.writeFile(path.join(dataDir,'safetensors-managed-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,reportDirectory:dataDir}));
}finally{await localModels?.close();await runtime.close();}
