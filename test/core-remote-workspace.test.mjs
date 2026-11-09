import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRemoteWorkspace } from '../core/remote-workspace.mjs';

function fixture() {
  const state = {providers:[{id:'p',name:'Host model',model:'demo',baseUrl:'private.invalid',models:[{id:'demo',name:'Demo'}]}],
    projects:[{id:'one',name:'Home',path:'private project path'},{id:'two',name:'Other'}],runs:[],approvals:[],
    chats:[{id:'main',title:'Conversation',projectId:'one',providerId:'p',systemPrompt:'private instructions',messages:[
      {id:'first',role:'user',content:'Hello'}, {id:'internal',role:'tool',content:'private raw tool result'},
      {id:'last',role:'assistant',content:'Hi',providerOutput:['private protocol items']}]},
      {id:'other',projectId:'two',messages:[],archived:true}]};
  let stateRevision = 0; const streams = new Map(), calls = [];
  const service = createRemoteWorkspace({current:()=>({state,stateRevision,streams}),request:async(method,args)=>{calls.push([method,args]);return {ok:true};}});
  return {state,streams,service,calls,tick(){stateRevision++;service.notify({type:'state'});}};
}
test('remote directory and transcript expose selected fields, paging and conditional reads',async()=>{
  const {service} = fixture(), read = service.dispatch;
  const first = await read('workspace.list',{limit:1}); assert.equal(first.projects.length,1); assert.equal(first.nextOffset,1);
  assert.equal(first.projects[0].path,undefined); assert.deepEqual(await read('workspace.list',{since:first.revision}),{unchanged:true,revision:first.revision,capabilities:{imageReferences:true,mediaReferences:true,sceneReferences:true,steering:true,workInbox:true,liveCapture:true}});
  const second = await read('workspace.list',{offset:2}); assert.equal(second.chats.length,2);assert.equal(second.nextOffset,null);
  const last = await read('chat.read',{chatId:'main',limit:1}); assert.equal(last.chat.messages[0].id,'last');
  const earlier = await read('chat.read',{chatId:'main',before:last.before}); assert.deepEqual(earlier.chat.messages.map(m=>m.id),['first']);
  const models = await read('workspace.models',{});
  assert.ok(!JSON.stringify([last,earlier,models,second]).includes('private'));
  assert.equal(models.providers[0].models[0].id,'demo');
  for(const [method,args] of [['settings.update',{}],['chat.read',{chatId:'main',includeSecrets:true}],['chat.read',{chatId:'main',before:'missing'}]]) await assert.rejects(()=>read(method,args));
  service.close();
});

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
const jpeg = 'data:image/jpeg;base64,/9j/AA==';

test('remote image references include persisted attachments, queued images and images_show activity without polling image bytes',async()=>{
  const {service,state} = fixture(), chat = state.chats[0], read = service.dispatch;
  chat.messages.push({id:'upload',role:'user',content:'Look',images:[png]},
    {id:'output',role:'assistant',content:'Created this image',images:[jpeg]},
    {id:'inline',role:'assistant',content:`Here is the image: ![result](${png})`},
    {id:'request-image',role:'assistant',runId:'run',content:'',toolCalls:[{id:'call',name:'images_show'}]},
    {id:'shown',role:'tool',toolCallId:'call',runId:'run',image:png,content:'{"path":"result.png","image":"[image supplied to model]"}'});
  chat.inbox = [{id:'queued-image',source:'user',text:'Next',images:[jpeg]}];
  state.runs.push({id:'run',chatId:'main',status:'completed',toolEvents:[{id:'image-event',name:'images_show',toolCallId:'call',status:'completed',result:{image:png,path:'private raw image path',secret:'private result secret'}}]});
  const value = await read('chat.read',{chatId:'main',imageMode:'references'});
  assert.equal(JSON.stringify(value).includes(png),false); assert.equal(JSON.stringify(value).includes(jpeg),false);
  assert.equal(JSON.stringify(value).includes('private'),false);
  const refs = [value.chat.messages.find(m=>m.id==='upload').imageRefs[0],value.chat.messages.find(m=>m.id==='output').imageRefs[0],
    value.chat.messages.find(m=>m.id==='inline').imageRefs[0],value.chat.messages.find(m=>m.id==='shown').imageRefs[0],
    value.chat.inbox[0].imageRefs[0],value.runs[0].toolEvents[0].imageRefs[0]];
  for (const [index,ref] of refs.entries()) {
    const image = [png,jpeg,png,png,jpeg,png][index];
    assert.deepEqual(await read('chat.image',{chatId:'main',imageId:ref.id}),{imageId:ref.id,image});
    assert.equal(ref.mimeType,image.slice(5,image.indexOf(';'))); assert.equal(ref.bytes,Buffer.from(image.split(',')[1],'base64').length);
  }
  assert.equal(value.chat.messages.find(m=>m.id==='inline').content,'Here is the image: [Image output below]');
  const changed = await read('chat.read',{chatId:'main',imageMode:'references'});
  assert.deepEqual(changed.runs[0].toolEvents[0].imageRefs,value.runs[0].toolEvents[0].imageRefs,'Stable IDs permit controller caching');
  const legacy = await read('chat.read',{chatId:'main'});
  assert.deepEqual(legacy.chat.messages.find(m=>m.id==='upload').images,[png]);
  assert.equal(legacy.runs[0].toolEvents[0].image,png); assert.deepEqual(legacy.chat.inbox[0].images,[jpeg]);
  assert.equal(legacy.chat.messages.find(m=>m.id==='inline').content,`Here is the image: ![result](${png})`);
  assert.equal((await read('workspace.ping',{})).capabilities.imageReferences,true);
  service.close();
});

test('remote image IDs are bound to current sources and the selected chat, never filesystem paths',async()=>{
  const {service,state} = fixture(), read = service.dispatch, chat = state.chats[0];
  chat.messages.push({id:'image-message',role:'user',content:'',images:[png]});
  state.chats[1].messages.push({id:'image-message',role:'user',content:'',images:[png]});
  const value = await read('chat.read',{chatId:'main',imageMode:'references'}), imageId = value.chat.messages.at(-1).imageRefs[0].id;
  for (const args of [{chatId:'other',imageId},{chatId:'missing',imageId},{chatId:'main',imageId:imageId.slice(0,-1)+(imageId.endsWith('0')?'1':'0')},
    {chatId:'main',imageId:'../../credentials.json'},{chatId:'main',imageId:'file:///private.png'},{chatId:'main',imageId,path:'private.png'}]) await assert.rejects(()=>read('chat.image',args));
  chat.messages.at(-1).images = [jpeg]; await assert.rejects(()=>read('chat.image',{chatId:'main',imageId}),/no longer available/);
  chat.messages.at(-1).images = [png]; chat.messages.pop(); await assert.rejects(()=>read('chat.image',{chatId:'main',imageId}),/no longer available/);
  await assert.rejects(()=>read('chat.image',{chatId:'main',imageId},{signal:AbortSignal.abort()}));
  service.close(); await assert.rejects(()=>read('chat.image',{chatId:'main',imageId}),/closed/);
});

test('remote image references from child activity bind to the owning run chat and expire when its source moves',async()=>{
  const {service,state} = fixture(), read = service.dispatch;
  state.chats.push({id:'child',projectId:'one',parentChatId:'main',messages:[]});
  state.runs.push({id:'parent-run',chatId:'main',status:'completed',toolEvents:[]},
    {id:'child-run',chatId:'child',parentRunId:'parent-run',status:'completed',toolEvents:[{id:'child-image',name:'images_show',result:{image:png}}]});
  const page = await read('chat.read',{chatId:'main',imageMode:'references'}), childRun = page.runs.find(run=>run.id==='child-run'), imageId = childRun.toolEvents[0].imageRefs[0].id;
  assert.deepEqual(await read('chat.image',{chatId:childRun.chatId,imageId}),{imageId,image:png});
  await assert.rejects(()=>read('chat.image',{chatId:'main',imageId}),/no longer available/);
  state.runs[1].chatId = 'other'; await assert.rejects(()=>read('chat.image',{chatId:'child',imageId}),/no longer available/);
  service.close();
});

test('remote image validation and aggregate budgets reject unsupported, mismatched and oversized bytes',async()=>{
  const {service,state} = fixture(), read = service.dispatch;
  const raster = (size,tail) => {const bytes = Buffer.alloc(size); Buffer.from('89504e470d0a1a0a','hex').copy(bytes); bytes[bytes.length-1]=tail; return `data:image/png;base64,${bytes.toString('base64')}`;};
  const images = Array.from({length:8},(_,i)=>raster(2*1024*1024,i));
  state.chats[0].messages = [{id:'many',role:'user',content:'Eight persisted candidates',images},
    {id:'invalid',role:'assistant',content:'Invalid images remain unavailable',images:['file:///private.png','https://example.com/track.png','data:image/svg+xml;base64,PHN2Zy8+',jpeg.replace('image/jpeg','image/png'),raster(6*1024*1024,1)]}];
  state.runs.push({id:'run',chatId:'main',status:'completed',toolEvents:Array.from({length:8},(_,i)=>({id:`event-${i}`,name:'images_show',status:'completed',result:{image:images[0]}}))});
  const value = await read('chat.read',{chatId:'main',imageMode:'references'});
  assert.equal(value.chat.messages[1].imageRefs,undefined); assert.equal(value.chat.messages[0].imageRefs.length,2);
  assert.ok(Buffer.byteLength(JSON.stringify(value))<10000,'Many large outputs produce only bounded metadata in polls');
  const legacy = await read('chat.read',{chatId:'main'});
  assert.ok(Buffer.byteLength(JSON.stringify(legacy))<11*1024*1024,'Legacy output also retains a combined image budget');
  assert.equal(legacy.runs[0].toolEvents.filter(event=>event.image).length,1);
  await assert.rejects(()=>read('chat.image',{chatId:'main',imageId:'x'.repeat(2049)}));
  service.close();
});
test('remote long polls wake on a change, abort, timeout or profile close',async()=>{
  const {service,streams} = fixture(), read = args=>service.dispatch('chat.read',{chatId:'main',...args});
  const {revision:since} = await read({});
  const next = read({since,waitMs:15000});
  streams.set('r',{runId:'r',chatId:'main',sequence:1,text:'live'});
  service.notify({type:'delta',chatId:'main'}); const live = await next; assert.equal(live.streams[0].text,'live'); assert.equal(live.liveOnly,true); assert.equal(live.chat,undefined);
  assert.ok((await read({since:live.revision,waitMs:1})).unchanged);
  const ctl = new AbortController();
  const aborted = service.dispatch('chat.read',{chatId:'main',since:live.revision,waitMs:15000},{signal:ctl.signal});
  ctl.abort(); await assert.rejects(aborted);
  const onClose = read({since:live.revision,waitMs:15000}); service.close(); await assert.rejects(onClose);
});
test('remote writes deduplicate concurrent sends and bind approval to the named chat',async()=>{
  const {service,state,calls} = fixture(), authority = {device:{id:'paired'},requestId:randomUUID()};
  const send = {chatId:'main',text:'Once'};
  await Promise.all([service.dispatch('chat.send',send,authority),service.dispatch('chat.send',send,authority)]);
  assert.equal(calls.length,1); await assert.rejects(()=>service.dispatch('chat.send',{...send,text:'Again'},authority));
  const write = (method,args)=>service.dispatch(method,args,{...authority,requestId:randomUUID()});
  state.approvals.push({id:'ticket',chatId:'other'});
  await assert.rejects(()=>write('approval.resolve',{chatId:'main',id:'ticket',allow:true}));
  state.approvals[0].chatId='main';
  await assert.rejects(()=>write('approval.resolve',{chatId:'main',id:'ticket',allow:true,remember:true}));
  await write('approval.resolve',{chatId:'main',id:'ticket',allow:false});
  assert.deepEqual(calls.at(-1),['approval.resolve',{id:'ticket',allow:false}]);
  await assert.rejects(()=>write('chat.stop',{chatId:'other'}));
  await assert.rejects(()=>write('chat.selectModel',{chatId:'main',providerId:'p',model:'unknown'}));
  await assert.rejects(()=>write('chat.send',{...send,grants:['shell']}));
  service.close();
});
test('paired supervision scopes approvals and steering to the exact job and preserves bounded evidence',async()=>{
  const f=fixture(),device={id:'paired'},scope={device};
  f.state.jobs=[{id:'job',routineId:'routine',revision:2,status:'waiting_approval',chatId:'main',runId:'attempt',attempts:1,definition:{projectId:'one',name:'Report',private:'hidden'},inputs:'sensitive internal details',report:{path:'report.md',inputs:[{path:'first.txt',status:'summarized',sha256:'a'.repeat(64)}]},outputs:[{tool:'files_write',result:{path:'report.md',sha256:'b'.repeat(64),backup:'private'}}]}];
  f.state.runs.push({id:'attempt',jobId:'job',chatId:'main',status:'waiting_approval'});
  f.state.approvals.push({id:'review-step',chatId:'main',runId:'attempt',summary:'Approve draft?'});
  const read=(method,params)=>f.service.dispatch(method,params,scope);
  const write=(method,params,requestId=randomUUID())=>f.service.dispatch(method,params,{device,requestId});
  await assert.rejects(f.service.dispatch('work.list',{}),/paired device/i);
  assert.deepEqual((await read('work.list',{})).jobs.map(j=>j.id),['job']);
  const detail=await read('work.read',{jobId:'job'});assert.equal(detail.outputs[0].path,'report.md');assert.equal(detail.outputs[0].backup,undefined);assert.equal(detail.definition,undefined);assert.equal(detail.sources[0].path,'first.txt');
  await assert.rejects(write('work.approve',{jobId:'job',runId:'unrelated',id:'review-step',allow:true}),/selected job/);
  const requestId=randomUUID(),params={jobId:'job',runId:'attempt',id:'review-step',allow:false};
  await write('work.approve',params,requestId);await write('work.approve',params,requestId);
  assert.equal(f.calls.filter(([method])=>method==='approval.resolve').length,1);
  await write('work.steer',{jobId:'job',runId:'attempt',correctionId:'correction',text:'Summarize first.txt'});
  await assert.rejects(write('work.stop',{jobId:'job',runId:'older'}),/attempt changed/);
  await write('work.stop',{jobId:'job',runId:'attempt'});assert.equal(f.calls.at(-1)[0],'routines.stop');
});
