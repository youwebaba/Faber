import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime} from '../core/runtime.mjs';
import {streamProvider,providerBody} from '../core/provider.mjs';
import {configuredControls} from '../core/controls.mjs';
import {callMetrics,estimateInputTokens} from '../core/metrics.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const empty={type:'object',properties:{},additionalProperties:false};
async function fixture(t,provider,host={}){
  const root=await fs.mkdtemp(join(tmpdir(),'faber-chat-controls-')),options={dataDir:join(root,'data'),sourceDir:join(root,'source'),provider,host};
  const runtime=await createRuntime(options);t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const project=await runtime.request('project.create',{name:'Fixture',path:join(root,'workspace')});
  const chat=await runtime.request('chat.create',{projectId:project.id});return {runtime,chat,project,options,root};
}
async function until(runtime,predicate){for(let i=0;i<300;i++){const state=await runtime.request('state.get');if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Fixture state timeout');}
const finished=(runtime,id)=>until(runtime,state=>state.runs.some(run=>run.id===id&&['completed','failed','canceled'].includes(run.status)));

test('provider-specific context and thinking controls preserve the entire wire input and do not set output caps',async()=>{
  const messages=[{role:'user',content:'history'.repeat(30000)}],tools=[];
  const base={id:'fixture',baseUrl:'http://127.0.0.1:1',model:'fixture'};
  const ollama={...base,kind:'ollama',chatOptions:{contextTokens:131072,thinking:true,thinkingMode:'ollama'}};
  const body=providerBody({provider:ollama,messages,tools});assert.equal(body.options.num_ctx,131072);assert.equal(body.think,true);assert.equal(body.messages[0].content,messages[0].content);assert.equal(body.num_predict,undefined);
  assert.equal(providerBody({provider:{...ollama,chatOptions:{thinking:null}},messages,tools}).think,null);
  const llama={...base,kind:'openai',chatOptions:{contextTokens:65536,thinking:false,thinkingMode:'llama_cpp'}};
  const local=providerBody({provider:llama,messages,tools});assert.deepEqual(local.chat_template_kwargs,{enable_thinking:false});assert.equal(local.max_tokens,undefined);assert.equal(local.options,undefined);
  assert.throws(()=>configuredControls({...base,kind:'openai'},{contextTokens:8192}),/fixed context/);
  assert.throws(()=>configuredControls({...base,kind:'openai'},{contextTokens:8192},{context:{mode:'managed',configurable:false}}),/fixed context/);
  assert.throws(()=>configuredControls({...base,kind:'openai-responses',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-sol'},{thinking:false}),/unsupported/);
  const terra={...base,kind:'openai-responses',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-terra'};
  const capabilities=configuredControls(terra,{thinking:false});assert.equal(capabilities.thinking.supported,true);
  assert.equal(providerBody({provider:{...terra,chatOptions:{thinking:false,thinkingMode:capabilities.thinking.mode}},messages,tools}).reasoning.effort,'none');
  assert.throws(()=>configuredControls({...terra,baseUrl:'https://unverified.example/v1'},{thinking:false}),/unsupported/);
});

test('stream adapters report validated provider durations separately from token usage',async()=>{
  for(const kind of ['ollama','openai']){
    let request;
    const frame=kind==='ollama'?{message:{content:'ok'},done:true,prompt_eval_count:20,eval_count:4,eval_duration:2000000000}:{choices:[{delta:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:4},timings:{predicted_ms:2000}};
    const events=[];
    for await(const event of streamProvider({provider:{id:'fixture',kind,baseUrl:'http://127.0.0.1:1',model:'fixture',chatOptions:{thinking:false,contextTokens:32000}},messages:[{role:'user',content:'hello'}],tools:[],signal:new AbortController().signal,fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);return new Response(kind==='ollama'?JSON.stringify(frame)+'\n':'data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n');}}))events.push(event);
    assert.deepEqual(events.find(event=>event.type==='timing').timing,{generationMs:2000});assert.equal(events.find(event=>event.type==='usage').usage.outputTokens,4);
    if(kind==='ollama'){assert.equal(request.think,false);assert.equal(request.options.num_ctx,32000);}else assert.equal(request.stream_options.include_usage,true);
  }
});

test('metrics use exact counts and provider eval time when available, otherwise clearly separate estimates and wall-clock rates',()=>{
  const measure={started:1000,firstToken:1500,characters:40,estimatedInputTokens:30,capacityTokens:8192};
  const estimated=callMetrics(measure,3000);assert.equal(estimated.tokensPerSecond,5);assert.equal(estimated.inputTokens,undefined);assert.equal(estimated.outputTokens,undefined);assert.equal(estimated.tokensPerSecondEstimated,true);assert.equal(estimated.firstTokenMs,500);
  const actual=callMetrics({...measure,usage:{inputTokens:31,outputTokens:12},timing:{generationMs:500}},3000);assert.equal(actual.tokensPerSecond,24);assert.equal(actual.tokensPerSecondBasis,'provider-eval');assert.equal(actual.inputTokens,31);assert.equal(actual.tokensPerSecondEstimated,false);
  const wall=callMetrics({...measure,usage:{outputTokens:12}},3000);assert.equal(wall.tokensPerSecond,6);assert.equal(wall.tokensPerSecondBasis,'wall-clock');
  assert.ok(estimateInputTokens({content:'data:image/png;base64,'+'A'.repeat(100000)})<100);
});

test('wire-input estimates exclude image bytes for Ollama, Chat Completions and Responses',()=>{
  const image=size=>'data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(size)]).toString('base64');
  for(const kind of ['ollama','openai','openai-responses']){
    const body=size=>providerBody({provider:{kind,model:'fixture'},messages:[{role:'user',content:'Describe the image',images:[image(size)]}],tools:[]});
    assert.equal(estimateInputTokens(body(0)),estimateInputTokens(body(75000)),kind);
  }
});

test('per-chat controls are captured per run; live metrics survive snapshots and terminal usage is persisted without entering prompts',async t=>{
  const pause=deferred(),streamed=deferred(),calls=[];
  const {runtime,chat,options}=await fixture(t,async function*({provider,messages}){calls.push({provider,messages});yield {type:'delta',text:'12345678'};streamed.resolve();await pause.promise;yield {type:'usage',usage:{inputTokens:123,outputTokens:10}};yield {type:'usage',usage:{inputTokens:123,outputTokens:10}};yield {type:'timing',timing:{generationMs:2000}};});
  await runtime.request('chat.update',{id:chat.id,contextTokens:65536,thinking:true});
  const controls=await runtime.request('chat.controls',{chatId:chat.id});assert.equal(controls.context.configurable,true);assert.equal(controls.thinking.effective,true);assert.ok(controls.context.estimatedTokens>0);
  const deltas=[];runtime.subscribe(event=>{if(event.type==='delta')deltas.push(event);});
  const {runId}=await runtime.request('chat.send',{chatId:chat.id,text:'Fixture'});await streamed.promise;
  await runtime.request('chat.update',{id:chat.id,contextTokens:32768,thinking:false});
  const snapshot=await runtime.request('state.get');assert.equal(snapshot.streams[0].metrics.capacityTokens,65536);assert.equal(snapshot.streams[0].metrics.outputTokens,undefined);assert.equal(deltas[0].modelCallId,snapshot.runs[0].modelCalls[0].id);
  assert.equal(calls[0].provider.chatOptions.contextTokens,65536);assert.equal(calls[0].provider.chatOptions.thinking,true);assert.ok(!JSON.stringify(calls[0].messages).includes('estimatedInputTokens'));
  pause.resolve();const terminal=await finished(runtime,runId),call=terminal.runs[0].modelCalls[0];assert.equal(call.metrics.tokensPerSecond,5);assert.equal(call.metrics.inputTokens,123);assert.equal(call.usage.outputTokens,10);assert.equal(call.metrics.tokensPerSecondBasis,'provider-eval');
  const disk=JSON.parse(await fs.readFile(join(options.dataDir,'state.json'),'utf8'));assert.equal(disk.runs[0].modelCalls[0].metrics.inputTokens,123);
  await assert.rejects(runtime.request('chat.update',{id:chat.id,contextTokens:0}));
  const cloud=await runtime.request('provider.save',{name:'Cloud fixture',kind:'openai-responses',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-sol'});
  const switched=await runtime.request('chat.update',{id:chat.id,providerId:cloud.id,model:'gpt-6.1-sol'});assert.equal(switched.contextTokens,null);assert.equal(switched.thinking,null);assert.equal((await runtime.request('chat.controls',{chatId:chat.id})).thinking.supported,false);
});

test('managed context mismatch rejects before user-message mutation and manual tools remain available',async t=>{
  const host={providerControls:()=>({context:{mode:'managed',capacityTokens:8192},thinking:{supported:true,mode:'llama_cpp'}}),assertProviderAvailable:(_id,_model,options)=>{if(options.contextTokens&&options.contextTokens!==8192)throw new Error('Restart managed model with selected context');}};
  const {runtime,chat}=await fixture(t,async function*(){yield {type:'delta',text:'ok'};},host);
  const provider=await runtime.request('provider.save',{name:'Managed fixture',kind:'openai',baseUrl:'http://127.0.0.1:1/v1',model:'fixture'});
  await runtime.request('chat.update',{id:chat.id,providerId:provider.id,contextTokens:16384,thinking:false});
  const before=await runtime.request('state.get');await assert.rejects(runtime.request('chat.send',{chatId:chat.id,text:'do not append'}),/Restart/);assert.deepEqual(await runtime.request('state.get'),before);
  assert.ok(Array.isArray(await runtime.request('tool.run',{chatId:chat.id,name:'project_list',args:{}})));
});

test('force stop settles an abort-ignoring provider and child approvals, deletes only that chat tree, and preserves files/other chats',async t=>{
  const never=new Promise(()=>{});
  const {runtime,chat,project,root,options}=await fixture(t,async function*({messages}){
    const task=messages.find(message=>message.role==='user')?.content;
    if(task==='parent'&&!messages.some(message=>message.role==='tool')){yield {type:'tool',id:'spawn-child',name:'agent_create',args:{task:'child'}};return;}
    if(task==='child'){yield {type:'tool',id:'permission',name:'privileged_fixture',args:{}};return;}
    yield {type:'delta',text:'Waiting'};await never;
  });
  runtime.registerTools([{name:'privileged_fixture',description:'Synthetic fixture',parameters:empty,permission:'files',execute:()=>assert.fail('Denied tool must not execute')}]);
  await fs.mkdir(project.path);const sentinel=join(project.path,'keep.txt');await fs.writeFile(sentinel,'preserve workspace');
  const other=await runtime.request('chat.create',{projectId:project.id});const unrelated=await runtime.request('chat.send',{chatId:other.id,text:'other'});
  await runtime.request('chat.send',{chatId:chat.id,text:'parent'});await until(runtime,state=>state.approvals.length===1&&state.chats.length===3);
  await assert.rejects(runtime.request('chat.delete',{chatId:chat.id}),/Stop/);
  const result=await runtime.request('chat.forceStop',{chatId:chat.id});assert.equal(result.settled,true);assert.equal(result.stopped.length,2);
  const stopped=await runtime.request('state.get');assert.equal(stopped.approvals.length,0);assert.equal(stopped.runs.find(run=>run.id===unrelated.runId).status,'running');assert.equal(stopped.runs.filter(run=>run.status==='canceled').length,2);
  const removed=await runtime.request('chat.delete',{chatId:chat.id});assert.equal(removed.deletedChatIds.length,2);assert.equal((await runtime.request('state.get')).chats.length,1);assert.equal(await fs.readFile(sentinel,'utf8'),'preserve workspace');
  assert.ok(!(await runtime.request('state.get')).tools.some(tool=>/^(chat_delete|chat_move|project_delete|project_archive|chat_force_stop)$/.test(tool.name)));
  await runtime.request('chat.forceStop',{chatId:other.id});await runtime.close();
  const restarted=await createRuntime(options);t.after(()=>restarted.close());assert.deepEqual((await restarted.request('state.get')).chats.map(item=>item.id),[other.id]);assert.equal((await restarted.request('state.get')).runs.length,1);
});

test('late abort-ignoring tool completion cannot resurrect deleted transcript; move and project archive/delete are atomic metadata operations',async t=>{
  const pending=deferred(),entered=deferred();const {runtime,chat,project,options}=await fixture(t,async function*(){yield {type:'delta',text:'done'};});
  runtime.registerTools([{name:'hang_fixture',description:'Synthetic ignoring-abort tool',parameters:empty,permission:'read',execute:async()=>{entered.resolve();return pending.promise;}}]);
  const tool=runtime.request('tool.run',{chatId:chat.id,name:'hang_fixture',args:{}}).catch(error=>error);await entered.promise;
  const destination=await runtime.request('project.create',{name:'Destination',path:join(options.sourceDir,'other')});await assert.rejects(runtime.request('chat.move',{chatId:chat.id,projectId:destination.id}),/Stop/);
  await runtime.request('chat.forceStop',{chatId:chat.id});assert.match((await tool).message,/Stopped/);
  const child=await runtime.request('tool.run',{chatId:chat.id,name:'chat_create',args:{projectId:project.id,title:'Child'}});
  const moved=await runtime.request('chat.move',{chatId:chat.id,projectId:destination.id});assert.equal(moved.chatIds.length,2);assert.ok((await runtime.request('state.get')).chats.every(item=>item.projectId===destination.id));
  await runtime.request('project.archive',{projectId:destination.id});const archived=await runtime.request('state.get');assert.ok(archived.chats.every(item=>item.archived));assert.ok(archived.runs.length);await assert.rejects(runtime.request('chat.send',{chatId:child.id,text:'blocked'}),/archived/);
  await runtime.request('project.delete',{projectId:destination.id});pending.resolve({late:'must not resurrect'});await new Promise(resolve=>setTimeout(resolve,20));const final=await runtime.request('state.get');assert.equal(final.chats.length,0);assert.equal(final.runs.length,0);assert.deepEqual(final.projects.map(item=>item.id),[project.id]);
  const disk=JSON.parse(await fs.readFile(join(options.dataDir,'state.json'),'utf8'));assert.equal(disk.chats.length,0);assert.equal(disk.runs.length,0);
});

test('archiving a chat fences and hides its child chats while canceled runs settle',async t=>{
  const {runtime,chat,project}=await fixture(t,async function*(){yield {type:'delta',text:'Working'};await new Promise(()=>{});});
  const child=await runtime.request('tool.run',{chatId:chat.id,name:'chat_create',args:{projectId:project.id,title:'Child'}});
  await runtime.request('chat.forceStop',{chatId:chat.id});
  const old=await runtime.request('chat.send',{chatId:child.id,text:'Old child task'});
  let attempted;
  const unsubscribe=runtime.subscribe(event=>{
    if(event.type==='state'&&!attempted&&event.state.chats.find(item=>item.id===chat.id)?.archived&&event.state.runs.find(run=>run.id===old.runId)?.status==='canceled'){
      attempted=runtime.request('chat.send',{chatId:child.id,text:'Task during archive'}).then(()=>null,error=>error);
    }
  });
  try{await runtime.request('chat.archive',{chatId:chat.id});}finally{unsubscribe();}
  assert.ok(attempted);assert.match((await attempted).message,/archived|being stopped or changed/);
  const state=await runtime.request('state.get');assert.ok(state.chats.every(item=>item.archived));
  assert.equal(state.runs.filter(run=>run.chatId===child.id).length,1);assert.ok(state.runs.every(run=>!['running','waiting_approval'].includes(run.status)));
  await assert.rejects(runtime.request('chat.send',{chatId:child.id,text:'Task after archive'}),/archived/);
  assert.ok(state.chats.find(item=>item.id===child.id).messages.length);
});

for(const action of ['delete','move'])test(`agent delivery rejects a target ${action} during workspace approval without creating an orphan run`,async t=>{
  const {runtime,chat,project}=await fixture(t,async function*(){assert.fail('Changed target must not reach the provider');});
  const other=await runtime.request('project.create',{name:'Other',path:join(project.path,'other')});
  const target=await runtime.request('chat.create',{projectId:other.id});
  const delivery=runtime.request('tool.run',{chatId:chat.id,name:'agent_send',args:{chatId:target.id,text:'Pending task'}}).then(()=>null,error=>error);
  const pending=await until(runtime,state=>state.approvals.length===1);
  await runtime.request(`chat.${action}`,{chatId:target.id,...(action==='move'?{projectId:project.id}:{})});
  await runtime.request('approval.resolve',{id:pending.approvals[0].id,allow:true});
  assert.match((await delivery).message,action==='delete'?/Unknown chats/:/moved while waiting/);
  const state=await runtime.request('state.get');assert.ok(state.runs.every(run=>state.chats.some(item=>item.id===run.chatId)));
  assert.equal(state.runs.filter(run=>run.chatId===target.id).length,0);
  if(action==='move')assert.equal(state.chats.find(item=>item.id===target.id).messages.length,0);
});

test('deleting a project detaches surviving cross-project chat/run lineage and preserves their history',async t=>{
  const {runtime,chat,project}=await fixture(t,async function*(){yield {type:'delta',text:'Preserved child reply'};});
  const other=await runtime.request('project.create',{name:'Other project',path:project.path});
  await runtime.request('chat.update',{id:chat.id,projectGrants:[other.id]});
  const child=await runtime.request('tool.run',{chatId:chat.id,name:'chat_create',args:{projectId:other.id,title:'Cross-project child'}});
  const sent=await runtime.request('tool.run',{chatId:chat.id,name:'agent_send',args:{chatId:child.id,text:'reply'}});await finished(runtime,sent.runId);
  // Completion status can be published just before the execution settlement fence clears.
  await runtime.request('chat.forceStop',{chatId:chat.id});
  await runtime.request('project.delete',{projectId:project.id});const state=await runtime.request('state.get');
  assert.deepEqual(state.projects.map(item=>item.id),[other.id]);assert.equal(state.chats.length,1);assert.equal(state.chats[0].parentChatId,undefined);assert.equal(state.chats[0].messages.at(-1).content,'Preserved child reply');
  assert.equal(state.runs.length,1);assert.equal(state.runs[0].parentRunId,undefined);assert.equal(state.runs[0].chatId,child.id);
});
