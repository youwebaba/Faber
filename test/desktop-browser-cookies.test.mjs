import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {rememberSessionCookies} from '../desktop/browser-cookies.mjs';
const cookie={name:'sid',value:'fake-session',domain:'example.test',path:'/',secure:true,httpOnly:true,hostOnly:true,sameSite:'lax'};
test('cookie change bursts coalesce and logout during a write survives final close',async()=>{
  const jar=new EventEmitter(),saved=[];let active=[],release,started;
  const firstWrite=new Promise(resolve=>{started=resolve;});
  jar.get=async filter=>filter.session?active:[];
  const owner=await rememberSessionCookies({cookies:jar},'fixture',{read:async()=>null,write:async(_key,value)=>{
    saved.push(JSON.parse(value));if(saved.length===1){started();await new Promise(resolve=>{release=resolve;});}
  }});
  active=[cookie];for(let i=0;i<100;i++)jar.emit('changed');
  await firstWrite;active=[];for(let i=0;i<100;i++)jar.emit('changed');
  const closed=owner.close();release();await closed;await owner.close();
  assert.equal(saved.length,2);assert.equal(saved[0][0].name,'sid');assert.deepEqual(saved[1],[]);
});
test('an existing persistent cookie supersedes a restored session cookie at startup',async()=>{
  const jar=new EventEmitter(),written=[];jar.get=async q=>q.session?[]:[{...cookie,value:'persistent'}];jar.set=async()=>assert.fail('Would overwrite persistent sign-in');
  const owner=await rememberSessionCookies({cookies:jar},'fixture',{read:async()=>JSON.stringify([cookie]),write:async(_key,value)=>written.push(value)});
  await owner.close();assert.deepEqual(written,['[]']);
});
