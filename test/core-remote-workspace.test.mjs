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
  assert.equal(first.projects[0].path,undefined); assert.deepEqual(await read('workspace.list',{since:first.revision}),{unchanged:true,revision:first.revision});
  const second = await read('workspace.list',{offset:2}); assert.equal(second.chats.length,2);assert.equal(second.nextOffset,null);
  const last = await read('chat.read',{chatId:'main',limit:1}); assert.equal(last.chat.messages[0].id,'last');
  const earlier = await read('chat.read',{chatId:'main',before:last.before}); assert.deepEqual(earlier.chat.messages.map(m=>m.id),['first']);
  const models = await read('workspace.models',{});
  assert.ok(!JSON.stringify([last,earlier,models,second]).includes('private'));
  assert.equal(models.providers[0].models[0].id,'demo');
  for(const [method,args] of [['settings.update',{}],['chat.read',{chatId:'main',includeSecrets:true}],['chat.read',{chatId:'main',before:'missing'}]]) await assert.rejects(()=>read(method,args));
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
