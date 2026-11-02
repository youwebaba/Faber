import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime} from '../core/runtime.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(t,provider){
  const root=await fs.mkdtemp(join(tmpdir(),'harness-reload-stream-')),dataDir=join(root,'data');
  const runtime=await createRuntime({sourceDir:join(root,'source'),dataDir,provider});
  t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const project=await runtime.request('project.create',{name:'Fixture',path:join(root,'project')});
  const chat=await runtime.request('chat.create',{projectId:project.id});
  return {runtime,chat,dataDir};
}
async function finished(runtime,runId){
  const terminal=state=>state.runs.some(run=>run.id===runId&&!['running','waiting_approval'].includes(run.status));
  const state=await runtime.request('state.get');if(terminal(state))return state;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{unsubscribe();reject(new Error('Fixture timeout'));},5000);
    const unsubscribe=runtime.subscribe(event=>{if(event.type==='state'&&terminal(event.state)){clearTimeout(timer);unsubscribe();resolve(event.state);}});
  });
}

test('UI reload snapshot plus newer chunk sequences reconstructs active output without duplicates or persistence',async t=>{
  const first=deferred(),second=deferred(),continueSecond=deferred(),complete=deferred();let invocation=0;const prompts=[];
  const {runtime,chat,dataDir}=await fixture(t,async function*({messages}){
    prompts.push(messages);
    if(++invocation===1){yield {type:'delta',text:'Earlier reply'};return;}
    yield {type:'delta',text:'Hello'};first.resolve();await continueSecond.promise;
    yield {type:'delta',text:' world'};second.resolve();await complete.promise;
  });
  const prior=await runtime.request('chat.send',{chatId:chat.id,text:'First'});await finished(runtime,prior.runId);
  const previous=(await runtime.request('state.get')).chats[0].messages.at(-1).id;
  // A new UI subscribes before requesting its initial snapshot.
  const events=[];runtime.subscribe(event=>{if(event.type==='delta')events.push(event);});
  const {runId}=await runtime.request('chat.send',{chatId:chat.id,text:'Next'});await first.promise;
  const snapshot=await runtime.request('state.get');assert.equal(snapshot.streams.length,1);
  assert.deepEqual(snapshot.streams[0],{chatId:chat.id,runId,text:'Hello',sequence:snapshot.streamSequence,lastAssistantId:previous});
  snapshot.streams[0].text='modified UI copy';assert.equal((await runtime.request('state.get')).streams[0].text,'Hello');
  const before=await runtime.request('state.get');continueSecond.resolve();await second.promise;
  const buffered=events.filter(event=>event.sequence>before.streamSequence);
  assert.equal(before.streams[0].text+buffered.map(event=>event.text).join(''),'Hello world');
  assert.equal(buffered.length,1);assert.equal(buffered[0].text,' world');assert.equal(buffered[0].lastAssistantId,previous);
  assert.equal(buffered[0].stream,undefined);assert.equal(buffered[0].sequence,buffered[0].streamSequence);
  const after=await runtime.request('state.get');assert.equal(after.streams[0].text,'Hello world');assert.ok(after.streamSequence>before.streamSequence);
  const disk=JSON.parse(await fs.readFile(join(dataDir,'state.json'),'utf8'));
  assert.equal(disk.streams,undefined);assert.equal(disk.streamSequence,undefined);assert.equal(disk.stateRevision,undefined);assert.ok(!JSON.stringify(prompts).includes('streamSequence'));assert.ok(!JSON.stringify(prompts).includes('stateRevision'));
  assert.ok(!disk.chats[0].messages.some(message=>message.content==='Hello'));
  complete.resolve();const end=await finished(runtime,runId);
  assert.deepEqual(end.streams,[]);assert.ok(end.streamSequence>after.streamSequence);
  assert.equal(end.chats[0].messages.at(-1).content,'Hello world');
});

test('whole-state revisions order ordinary project/chat changes independently of streams before persistence completes',async t=>{
  const {runtime,chat,dataDir}=await fixture(t,async function*(){});
  const events=[];runtime.subscribe(event=>{if(event.type==='state')events.push(event.state);});
  const old=await runtime.request('state.get');
  const changing=runtime.request('chat.update',{id:chat.id,title:'Updated during UI startup'});
  // request mutates synchronously; its save is still queued when this snapshot is taken.
  const during=await runtime.request('state.get');
  assert.ok(during.stateRevision>old.stateRevision);assert.equal(during.chats[0].title,'Updated during UI startup');
  assert.equal(during.streamSequence,old.streamSequence);await changing;
  assert.equal(events.at(-1).stateRevision,during.stateRevision);
  await runtime.request('project.update',{id:chat.projectId,name:'Updated project'});
  const latest=await runtime.request('state.get');
  assert.ok(latest.stateRevision>during.stateRevision);assert.equal(latest.streamSequence,old.streamSequence);
  assert.equal(events.at(-1).stateRevision,latest.stateRevision);
  assert.equal((await runtime.request('state.get')).stateRevision,latest.stateRevision);
  const disk=JSON.parse(await fs.readFile(join(dataDir,'state.json'),'utf8'));
  assert.equal(disk.stateRevision,undefined);assert.equal(disk.projects[0].name,'Updated project');
});

for(const mode of ['failed','canceled','closed'])test(`transient partial output clears when stream is ${mode}`,async t=>{
  const paused=deferred(),release=deferred();
  const {runtime,chat}=await fixture(t,async function*(){yield {type:'delta',text:'Partial'};paused.resolve();await release.promise;if(mode==='failed')throw new Error('Fixture stream failure');});
  const {runId}=await runtime.request('chat.send',{chatId:chat.id,text:'Fixture'});await paused.promise;
  const during=await runtime.request('state.get');assert.equal(during.streams[0].text,'Partial');
  let latest;runtime.subscribe(event=>{if(event.type==='state')latest=event.state;});
  if(mode==='failed')release.resolve();
  else if(mode==='canceled')await runtime.request('chat.stop',{chatId:chat.id});
  else await runtime.close();
  const end=mode==='closed'?latest:await finished(runtime,runId);
  assert.deepEqual(end.streams,[]);assert.ok(end.streamSequence>during.streamSequence);
  assert.equal(end.runs.find(run=>run.id===runId).status,mode==='failed'?'failed':'canceled');
  release.resolve();
});
