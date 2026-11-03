import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {CDP,loopbackEndpoint} from '../bundled-addons/lightpanda/cdp.mjs';
import {createBrowser,webURL} from '../bundled-addons/lightpanda/browser.mjs';
import {createOwnedRuntime} from '../bundled-addons/lightpanda/runtime.mjs';
const temporary=async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-Lightpanda-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;};
class Socket extends EventTarget {
  constructor(){super();this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  send(raw){this.last=JSON.parse(raw);}
  reply(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
}
test('CDP matches commands, cancels only the selected call, and drains event waiters on close',async()=>{
  const cdp=await new CDP('ws://127.0.0.1:9222',{Socket}).connect();
  const result=cdp.send('Runtime.evaluate',{expression:'1'},'chat-a');assert.equal(cdp.socket.last.sessionId,'chat-a');cdp.socket.reply({id:cdp.socket.last.id,result:{value:1}});assert.deepEqual(await result,{value:1});
  const abort=new AbortController(),pending=cdp.send('Runtime.evaluate',{},'chat-a',abort.signal);abort.abort(Error('fixture cancel'));await assert.rejects(pending,/fixture cancel/);assert.equal(cdp.pending.size,0);
  const event=cdp.event('Page.loadEventFired','chat-a');cdp.close();await assert.rejects(event.promise,/canceled/);assert.equal(cdp.waiters.size,0);assert.equal(cdp.listeners.size,0);
});
test('CDP endpoints and navigation reject nonloopback control, credentials and local files',()=>{
  for(const value of ['ws://example.com:9222','wss://127.0.0.1','ws://user:password@localhost','file:///C:/secret'])assert.throws(()=>loopbackEndpoint(value));
  assert.equal(loopbackEndpoint('ws://localhost:9222'),'ws://localhost:9222/');
  for(const value of ['file:///etc/passwd','javascript:alert(1)','https://user:password@example.com'])assert.throws(()=>webURL(value));
});
test('failed Lightpanda context creation releases owned connection and permits retry',async t=>{
  const dataDir=await temporary(t);let fail=true,stops=0,closed=0;
  const owned={start:async()=> 'ws://127.0.0.1:9222',stop:async()=>{stops++;},close:async()=>{}};
  class Client {async connect(){return this;}close(){closed++;}async send(method){if(method==='Target.createBrowserContext'){if(fail){fail=false;throw Error('fixture creation failed');}return{browserContextId:'ctx'};}if(method==='Target.createTarget')return{targetId:'target'};if(method==='Target.attachToTarget')return{sessionId:'session'};return{};}}
  const browser=createBrowser({dataDir,owned,Client}),ctx={chatId:'a',approve:async()=>true};
  await assert.rejects(browser.action('connect',{},ctx),/fixture creation failed/);assert.equal(stops,1);assert.equal(closed,1);
  assert.equal((await browser.action('connect',{},ctx)).connected,true);await browser.close();
});
test('owned WSL start cancellation terminates only its verified distro; foreign registration blocks removal',async t=>{
  const dataDir=await temporary(t),installDir=path.join(dataDir,'runtime');await fs.mkdir(installDir);
  const distro=`FaberLightpanda-${crypto.createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0,16)}`,token='a'.repeat(64);
  await fs.writeFile(path.join(dataDir,'wsl-owner.json'),JSON.stringify({distro,installDir,token,phase:'ready'}));
  const calls=[];let foreign=false;const abort=new AbortController();
  const command=async(exe,args)=>{calls.push([exe,args]);if(exe==='powershell.exe')return JSON.stringify({DistributionName:distro,BasePath:foreign?path.join(dataDir,'foreign'):installDir});if(args.includes('cat'))return token;return'';};
  const spawnImpl=()=>{const child=new EventEmitter();child.exitCode=null;child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>abort.abort(Error('fixture stop')));return child;};
  const owned=createOwnedRuntime({dataDir,resources:'unused',command,spawnImpl});await assert.rejects(owned.start(abort.signal),/fixture stop/);
  assert.ok(calls.some(([,args])=>args[0]==='--terminate'&&args[1]===distro));assert.equal((await owned.status()).running,false);
  foreign=true;await assert.rejects(owned.uninstall(),/another folder/);assert.ok(!calls.some(([,args])=>args[0]==='--unregister'));
});

test('first use reports missing WSL without importing or enabling system features',async t=>{
 const dataDir=await temporary(t),calls=[];const owned=createOwnedRuntime({dataDir,resources:'unused',command:async(exe,args)=>{calls.push([exe,args]);throw Error('WSL unavailable');}});
 await assert.rejects(owned.start(),/already working WSL2 installation/);assert.deepEqual(calls.map(([,args])=>args),[['--status']]);await owned.close();
});

test('exclusive chat lease preserves its owner when another chat tries; idle cleanup permits automatic next acquisition',async t=>{
 const dataDir=await temporary(t);let starts=0,stops=0,sequence=0;const commands=[];
 const owned={start:async()=>{starts++;return 'ws://127.0.0.1:9222';},stop:async()=>{stops++;},close:async()=>{},status:async()=>({})};
 class Client{async connect(){return this;}close(){}async send(method,args){commands.push([method,args]);if(method==='Target.createBrowserContext')return{browserContextId:`c${++sequence}`};if(method==='Target.createTarget')return{targetId:`t${sequence}`};if(method==='Target.attachToTarget')return{sessionId:`s${sequence}`};return{};}}
 const browser=createBrowser({dataDir,owned,Client,idleMs:25});t.after(()=>browser.close());
 const a=await browser.action('connect',{}, {chatId:'a',runId:'run-a'});await assert.rejects(browser.action('connect',{}, {chatId:'b',runId:'run-b'}),/busy with another chat/);assert.equal(sequence,1);assert.equal(starts,1);assert.equal(stops,0);
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal((await browser.action('status',{})).activeRuns,1);assert.equal((await browser.action('stop',{}, {chatId:'b'})).stopped,false);assert.equal(stops,0);
 await browser.releaseRun('run-a');await new Promise(resolve=>setTimeout(resolve,80));assert.equal(stops,1);const b=await browser.action('connect',{}, {chatId:'b',runId:'run-b'});assert.notEqual(a.browserContextId,b.browserContextId);assert.equal(starts,2);assert.ok(!commands.some(([method])=>method==='Browser.close'));
});

test('canceling an owner disposes its page and permits a different chat without sharing state',async t=>{
 const dataDir=await temporary(t);let sequence=0;const abort=new AbortController(),disposed=[];
 const owned={start:async()=> 'ws://127.0.0.1:9222',stop:async()=>{},close:async()=>{}};
 class Client{async connect(){return this;}close(){}async send(method,args,_session,signal){if(method==='Target.createBrowserContext')return{browserContextId:`c${++sequence}`};if(method==='Target.createTarget')return{targetId:`t${sequence}`};if(method==='Target.attachToTarget')return{sessionId:`s${sequence}`};if(method==='Target.disposeBrowserContext')disposed.push(args.browserContextId);if(method==='Runtime.evaluate'){abort.abort(Error('fixture stop'));signal.throwIfAborted();}return{};}}
 const browser=createBrowser({dataDir,owned,Client});t.after(()=>browser.close());await browser.action('connect',{}, {chatId:'a',runId:'a'});
 await assert.rejects(browser.action('evaluate',{expression:'1'},{chatId:'a',runId:'a',signal:abort.signal}),/fixture stop/);assert.deepEqual(disposed,['c1']);assert.equal((await browser.action('connect',{}, {chatId:'b',runId:'b'})).browserContextId,'c2');
});
