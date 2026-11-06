import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../core/runtime.mjs';
import { createMediaStore, mediaBytesLimit, mediaChunkLimit, validateMediaRef } from '../core/media.mjs';
import { mediaTools } from '../tools/media.mjs';
import { waveFixture } from './fixtures/media.mjs';

async function fixture(t,provider) {
  const root = await fs.mkdtemp(path.join(tmpdir(),'faber-chat-media-test-'));
  const options = {dataDir:path.join(root,'data'),sourceDir:path.join(root,'source'),provider};
  await fs.mkdir(options.sourceDir); let runtime = await createRuntime(options); runtime.registerTools(mediaTools());
  const project = await runtime.request('project.create',{name:'Media',path:options.sourceDir});
  const chat = await runtime.request('chat.create',{projectId:project.id});
  t.after(async()=>{await runtime.close();assert.ok(path.basename(root).startsWith('faber-chat-media-test-'));await fs.rm(root,{recursive:true,force:true});});
  return {root,options,project,chat,get runtime(){return runtime;},async restart(){await runtime.close();runtime=await createRuntime(options);runtime.registerTools(mediaTools());},
    async publish(name='tone.wav',bytes=waveFixture()){await fs.writeFile(path.join(options.sourceDir,name),bytes);return (await runtime.request('tool.run',{chatId:chat.id,name:'media_show',args:{path:name}})).media;}};
}
async function binaries(directory) {
  try { return (await fs.readdir(directory,{recursive:true})).filter(name=>/\.bin(?:\.tmp)?$/.test(name)); } catch(error) { if(error.code==='ENOENT')return [];throw error; }
}

test('media_show publishes bounded durable chat-owned snapshots, never media bytes or source paths into history',async t=>{
  const f = await fixture(t), bytes = waveFixture(), media = await f.publish();
  assert.equal(media.kind,'audio');assert.equal(media.mimeType,'audio/wav');assert.equal(media.bytes,bytes.length);assert.equal(media.name,'tone.wav');
  const request = {chatId:f.chat.id,mediaId:media.id,offset:4,length:12};
  assert.deepEqual(Buffer.from((await f.runtime.readMedia(request)).data,'base64'),bytes.subarray(4,16));
  const page = await f.runtime.remoteRequest('chat.read',{chatId:f.chat.id,mediaMode:'references'});
  assert.deepEqual(page.runs.at(-1).toolEvents[0].mediaRefs,[media]);
  const legacy = await f.runtime.remoteRequest('chat.read',{chatId:f.chat.id});assert.equal(legacy.runs.at(-1).toolEvents[0].mediaRefs,undefined);
  const serialized = await fs.readFile(path.join(f.options.dataDir,'state.json'),'utf8');
  assert.ok(!serialized.includes(bytes.toString('base64')));assert.ok(!serialized.includes(path.join(f.options.sourceDir,'tone.wav').replaceAll('\\','\\\\')));
  await fs.rm(path.join(f.options.sourceDir,'tone.wav'));await f.restart();
  assert.deepEqual(Buffer.from((await f.runtime.remoteRequest('chat.media',request)).data,'base64'),bytes.subarray(4,16));
  const other = await f.runtime.request('chat.create',{projectId:f.project.id});
  for (const args of [{...request,chatId:other.id},{...request,chatId:'missing'},{...request,mediaId:randomUUID()},{...request,mediaId:'../../state.json'},
    {...request,mediaId:'file:///tone.wav'},{...request,path:'tone.wav'},{...request,offset:-1},{...request,length:mediaChunkLimit+1},{...request,offset:bytes.length+1}]) await assert.rejects(()=>f.runtime.remoteRequest('chat.media',args));
  await assert.rejects(()=>f.runtime.readMedia(request,AbortSignal.abort()));
  await f.runtime.request('chat.delete',{chatId:f.chat.id});
  assert.deepEqual(await binaries(path.join(f.options.dataDir,'chat-media')),[]);await assert.rejects(()=>f.runtime.readMedia(request));
});

test('model media tool messages retain descriptors and projection, without adding audio to provider input',async t=>{
  const inputs=[];
  const f=await fixture(t,async function*({messages}){inputs.push(messages);if(!messages.some(row=>row.role==='tool'))yield {type:'tool',id:'show',name:'media_show',args:{path:'tone.wav'}};else yield {type:'delta',text:'Audio is ready'};});
  await fs.writeFile(path.join(f.options.sourceDir,'tone.wav'),waveFixture());
  const {runId}=await f.runtime.request('chat.send',{chatId:f.chat.id,text:'Show audio'});
  for(let n=0;n<200;n++){const state=await f.runtime.request('state.get');if(state.runs.find(run=>run.id===runId)?.endedAt)break;await new Promise(resolve=>setTimeout(resolve,10));}
  const state=await f.runtime.request('state.get'), run=state.runs.find(run=>run.id===runId);assert.equal(run.status,'completed');
  const message=state.chats[0].messages.find(row=>row.role==='tool');assert.equal(message.mediaRefs.length,1);
  const page=await f.runtime.remoteRequest('chat.read',{chatId:f.chat.id,mediaMode:'references'});
  assert.deepEqual(page.chat.messages.find(row=>row.id===message.id).mediaRefs,message.mediaRefs);
  assert.ok(inputs[1].find(row=>row.role==='tool').content.includes('audio/wav'));assert.ok(!JSON.stringify(inputs).includes('base64'));
  await f.runtime.request('project.delete',{projectId:f.project.id});assert.deepEqual(await binaries(path.join(f.options.dataDir,'chat-media')),[]);
});

test('media_show rejects path escapes, mismatched containers, oversize files and lost project authority',async t=>{
  const f=await fixture(t), tool=mediaTools()[0], ctx={project:{path:f.options.sourceDir},chat:f.chat,runtime:f.runtime};
  for(const name of ['bad.wav','bad.mp4','bad.webm','bad.mp3','bad.m4a','bad.ogg','bad.svg'])await fs.writeFile(path.join(f.options.sourceDir,name),'not media');
  const big=await fs.open(path.join(f.options.sourceDir,'big.wav'),'w');await big.writeFile(waveFixture(1));await big.truncate(mediaBytesLimit+1);await big.close();
  for(const name of ['bad.wav','bad.mp4','bad.webm','bad.mp3','bad.m4a','bad.ogg','bad.svg','big.wav','../data/state.json','bad.wav:alternate',path.join(f.options.sourceDir,'bad.wav')])await assert.rejects(()=>tool.execute({path:name},ctx));
  await fs.writeFile(path.join(f.options.sourceDir,'tone.wav'),waveFixture());
  await assert.rejects(()=>tool.execute({path:'tone.wav'},{...ctx,authorizePath:()=>{throw new Error('Project revoked');}}),/Project revoked/);
  await assert.rejects(()=>tool.execute({path:'tone.wav'},{...ctx,signal:AbortSignal.abort()}));
  await assert.rejects(()=>tool.execute({path:'tone.wav'},{...ctx,runtime:{}}),/unavailable/);
  for(const value of [{id:randomUUID(),kind:'video',mimeType:'text/html',bytes:2,name:'x.mp4'},{id:randomUUID(),kind:'audio',mimeType:'audio/wav',bytes:2,name:'../x.wav'},
    {id:randomUUID(),kind:'audio',mimeType:'audio/wav',bytes:mediaBytesLimit+1,name:'x.wav'}])assert.throws(()=>validateMediaRef(value));
});

test('large snapshot copying and remote reads stay bounded, disk ownership survives forged cross-chat descriptors',async t=>{
  const f=await fixture(t), reference=new Map();
  const store=createMediaStore({dataDir:f.options.dataDir,findReference:(chatId,id)=>{const value=reference.get(chatId);if(value?.id!==id)throw new Error('Unpublished');return value;}});
  const source=await fs.open(path.join(f.options.sourceDir,'large.wav'),'w+');
  await source.writeFile(waveFixture());await source.truncate(mediaChunkLimit*5+17);
  let maxRead=0;const tracked={stat:()=>source.stat(),async read(buffer,offset,length,position){maxRead=Math.max(maxRead,length);return source.read(buffer,offset,length,position);}};
  const media=await store.publish({chatId:'one',file:tracked,name:'large.wav'});reference.set('one',media);await store.settle('one');
  assert.ok(maxRead<=mediaChunkLimit);assert.equal((await store.read({chatId:'one',mediaId:media.id,offset:mediaChunkLimit*4,length:mediaChunkLimit})).data.length,Math.ceil(mediaChunkLimit/3)*4);
  reference.set('two',media);await assert.rejects(()=>store.read({chatId:'two',mediaId:media.id,length:1}),/ENOENT/);
  await source.close();
});

test('failed/canceled publications and crash orphans are cleaned, persisted references survive startup pruning',async t=>{
  const f=await fixture(t), media=await f.publish();
  f.runtime.registerTools([{...mediaTools()[0],name:'publish_then_fail',async execute(args,ctx){await mediaTools()[0].execute(args,ctx);throw new Error('Failed before publication');}}]);
  await assert.rejects(()=>f.runtime.request('tool.run',{chatId:f.chat.id,name:'publish_then_fail',args:{path:'tone.wav'}}),/Failed before publication/);
  assert.equal((await binaries(path.join(f.options.dataDir,'chat-media'))).length,1);
  const store=createMediaStore({dataDir:f.options.dataDir,findReference:()=>{throw new Error('Unpublished');}}),controller=new AbortController();
  const source=await fs.open(path.join(f.options.sourceDir,'tone.wav'),'r');let reads=0;
  await assert.rejects(()=>store.publish({chatId:f.chat.id,name:'tone.wav',signal:controller.signal,file:{stat:()=>source.stat(),async read(...args){const result=await source.read(...args);if(++reads===2)controller.abort();return result;}}}));
  await source.close();assert.equal((await binaries(path.join(f.options.dataDir,'chat-media'))).length,1);
  const folder=path.join(f.options.dataDir,'chat-media',(await fs.readdir(path.join(f.options.dataDir,'chat-media')))[0]);
  await fs.writeFile(path.join(folder,randomUUID()+'.bin'),'orphan');await fs.writeFile(path.join(folder,randomUUID()+'.bin.tmp'),'partial');
  await f.restart();assert.equal((await binaries(path.join(f.options.dataDir,'chat-media'))).length,1);
  assert.equal((await f.runtime.readMedia({chatId:f.chat.id,mediaId:media.id})).media.id,media.id);
});
