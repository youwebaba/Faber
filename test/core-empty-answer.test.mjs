import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRuntime} from '../core/runtime.mjs';

async function fixture(t,provider){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'faber-empty-answer-'));
 const runtime=await createRuntime({dataDir:path.join(root,'data'),sourceDir:path.join(root,'source'),provider});
 t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
 const project=await runtime.request('project.create',{name:'Fixture',path:path.join(root,'workspace')});
 const chat=await runtime.request('chat.create',{projectId:project.id});
 async function send(){const {runId}=await runtime.request('chat.send',{chatId:chat.id,text:'Fixture request'});const end=Date.now()+5000;while(Date.now()<end){const state=await runtime.request('state.get'),run=state.runs.find(item=>item.id===runId);if(['failed','completed','canceled'].includes(run.status))return{state,run,chat:state.chats.find(item=>item.id===chat.id)};await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Run fixture timeout');}
 return{runtime,send};
}
for(const content of ['', ' \n\t '])test(`empty final (${content?'whitespace':'no deltas'}) fails clearly without blank assistant and retains reported usage`,async t=>{
 const {send}=await fixture(t,async function*(){if(content)yield{type:'delta',text:content};yield{type:'usage',usage:{inputTokens:120,outputTokens:16,reasoningTokens:12}};});
 const {run,chat,state}=await send();assert.equal(run.status,'failed');assert.match(run.error,/no visible answer.*Retry.*thinking off/);assert.equal(run.modelCalls[0].status,'failed');assert.deepEqual(run.modelCalls[0].usage,{inputTokens:120,outputTokens:16,reasoningTokens:12});assert.ok(run.modelCalls[0].endedAt);assert.deepEqual(chat.messages.map(message=>message.role),['user']);assert.equal(state.streams.length,0);
});
test('tool-only turn still executes and continues to an ordinary visible final answer',async t=>{
 let turns=0;const {send}=await fixture(t,async function*(){if(turns++===0){yield{type:'tool',id:'fixture-clock',name:'system_time',args:{}};yield{type:'usage',usage:{inputTokens:20,outputTokens:3}};}else yield{type:'delta',text:'Clock checked.'};});
 const {run,chat}=await send();assert.equal(run.status,'completed');assert.equal(turns,2);assert.deepEqual(chat.messages.map(message=>message.role),['user','assistant','tool','assistant']);assert.equal(chat.messages[1].content,'');assert.equal(chat.messages[1].toolCalls[0].name,'system_time');assert.equal(run.toolEvents[0].status,'completed');assert.equal(chat.messages.at(-1).content,'Clock checked.');assert.equal(run.modelCalls[0].usage.outputTokens,3);
});
test('ordinary visible response is preserved exactly',async t=>{
 const text='  Faber test OK.\n';const {send}=await fixture(t,async function*(){yield{type:'delta',text};yield{type:'usage',usage:{inputTokens:4,outputTokens:5}};});
 const {run,chat}=await send();assert.equal(run.status,'completed');assert.equal(run.modelCalls[0].status,'completed');assert.equal(chat.messages.at(-1).content,text);assert.equal(run.modelCalls[0].usage.outputTokens,5);
});
