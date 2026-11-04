import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRuntime} from '../core/runtime.mjs';

async function fixture(t, provider = async function*(){yield {type:'delta',text:'Done'};}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-prompts-'));
  const options={dataDir:path.join(directory,'data'),sourceDir:path.join(directory,'source'),provider};
  const runtime=await createRuntime(options);
  t.after(async()=>{await runtime.close();await fs.rm(directory,{recursive:true,force:true});});
  const project=await runtime.request('project.create',{name:'Fixture',path:options.sourceDir});
  const chat=await runtime.request('chat.create',{projectId:project.id});
  return {runtime,project,chat,options};
}
async function settled(runtime,runId){
  const match=state=>state.runs.find(run=>run.id===runId&&['completed','failed','canceled'].includes(run.status));
  const current=match(await runtime.request('state.get'));if(current)return current;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(Error('Run did not finish'));},3000);const off=runtime.subscribe(event=>{const run=event.type==='state'&&match(event.state);if(run){clearTimeout(timer);off();resolve(run);}});});
}

test('prompt library edits preserve chat snapshots; selections and custom empty prompts survive restart',async t=>{
  const f=await fixture(t);const initial=await f.runtime.request('state.get');
  assert.equal(initial.promptPresets.length,7);
  assert.match(f.chat.systemPrompt,/Avoid shell commands/);
  const coding=initial.promptPresets.find(preset=>preset.id==='coding');
  await f.runtime.request('chat.update',{id:f.chat.id,systemPromptPresetId:coding.id});
  await f.runtime.request('promptPresets.save',{id:coding.id,name:'My coding',text:'Changed library'});
  assert.equal((await f.runtime.request('state.get')).chats[0].systemPrompt,coding.text);
  const child=await f.runtime.request('chat.create',{projectId:f.project.id});
  await f.runtime.request('chat.update',{id:child.id,systemPromptPresetId:coding.id});
  assert.equal((await f.runtime.request('state.get')).chats[1].systemPrompt,'Changed library');
  await f.runtime.request('promptPresets.delete',{id:coding.id});
  const removed=(await f.runtime.request('state.get')).chats[1];
  assert.equal(removed.systemPrompt,'Changed library');assert.equal(removed.systemPromptPresetId,null);
  await f.runtime.request('chat.update',{id:f.chat.id,systemPrompt:''});
  await f.runtime.request('settings.update',{uiScale:1.25,onboardingComplete:true});
  await f.runtime.close();
  const reopened=await createRuntime(f.options);t.after(()=>reopened.close());
  const state=await reopened.request('state.get');
  assert.equal(state.chats[0].systemPrompt,'');assert.equal(state.chats[0].systemPromptPresetId,null);
  assert.equal(state.chats[1].systemPrompt,'Changed library');assert.equal(state.chats[1].systemPromptPresetId,null);
  assert.equal(state.settings.uiScale,1.25);assert.equal(state.settings.onboardingComplete,true);
  await reopened.request('promptPresets.reset',{id:'coding'});
  assert.equal((await reopened.request('state.get')).promptPresets.find(item=>item.id==='coding').text,coding.text);
  await reopened.close();
});

test('active run keeps its prompt snapshot and the next run uses the edited prompt',async t=>{
  const seen=[];let release,entered;const gate=new Promise(resolve=>{release=resolve;});const called=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,async function*({messages}){seen.push(messages[0].content);if(seen.length===1)yield {type:'tool',id:'wait-once',name:'fixture_wait',args:{}};else yield {type:'delta',text:'Done'};});
  f.runtime.registerTools([{name:'fixture_wait',description:'Isolated test',permission:'read',parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{entered();await gate;return {ok:true};}}]);
  await f.runtime.request('chat.update',{id:f.chat.id,systemPrompt:'ORIGINAL'});
  const first=await f.runtime.request('chat.send',{chatId:f.chat.id,text:'Start'});await called;
  await f.runtime.request('chat.update',{id:f.chat.id,systemPrompt:'UPDATED'});release();
  assert.equal((await settled(f.runtime,first.runId)).status,'completed');
  assert.equal(seen.length,2);assert.ok(seen.every(text=>text.startsWith('ORIGINAL')));
  const next=await f.runtime.request('chat.send',{chatId:f.chat.id,text:'Next'});await settled(f.runtime,next.runId);
  assert.match(seen[2],/^UPDATED/);
});

test('pre-b2 state migrates without losing messages and validates new preferences',async t=>{
  const f=await fixture(t);await f.runtime.close();
  const filename=path.join(f.options.dataDir,'state.json'),saved=JSON.parse(await fs.readFile(filename,'utf8'));
  delete saved.promptPresets;delete saved.settings.uiScale;delete saved.settings.onboardingComplete;
  delete saved.chats[0].systemPrompt;delete saved.chats[0].systemPromptPresetId;delete saved.chats[0].reasoningEffort;
  saved.chats[0].messages.push({id:'original-message',role:'user',content:'Keep me',createdAt:'2026-01-01T00:00:00Z'});
  await fs.writeFile(filename,JSON.stringify(saved));
  const reopened=await createRuntime(f.options);t.after(()=>reopened.close());
  const state=await reopened.request('state.get');assert.equal(state.chats[0].messages[0].content,'Keep me');assert.equal(state.settings.uiScale,1);
  for(const params of [{uiScale:0.1},{uiScale:2},{onboardingComplete:'yes'}])await assert.rejects(reopened.request('settings.update',params));
  await assert.rejects(reopened.request('chat.update',{id:f.chat.id,systemPrompt:'x'.repeat(65537)}));
  await assert.rejects(reopened.request('promptPresets.save',{name:' ',text:'x'}));
  await assert.rejects(reopened.request('promptPresets.delete',{id:'general'}));
  await reopened.close();
});

test('account provider registration is host-only, token-free, and preserves disconnected chats',async t=>{
  const f=await fixture(t),account={id:'chatgpt:fixture',accountId:'fixture',name:'ChatGPT · Account 1',kind:'openai-responses',authKind:'chatgpt',baseUrl:'https://api.openai.com/v1',model:'',hasKey:true,connected:true,models:[{id:'model-fixture',name:'Fixture',contextTokens:null,reasoningEfforts:[]}]};
  await assert.rejects(f.runtime.request('provider.save',{id:account.id,name:'Bad',kind:'openai',baseUrl:'http://localhost:1234',model:''}),/ChatGPT accounts/);
  await assert.rejects(f.runtime.setAccountProviders([{...account,access_token:'must-not-persist'}]),/unknown property/);
  await assert.rejects(f.runtime.setAccountProviders([{...account,baseUrl:'https://example.com'}]));
  await f.runtime.setAccountProviders([account]);
  await f.runtime.request('chat.update',{id:f.chat.id,providerId:account.id,model:'model-fixture'});
  await f.runtime.setAccountProviders([]);
  const state=await f.runtime.request('state.get');assert.equal(state.providers.find(provider=>provider.id===account.id).connected,false);assert.equal(state.chats[0].providerId,account.id);
  assert.equal(JSON.stringify(state).includes('must-not-persist'),false);
});
