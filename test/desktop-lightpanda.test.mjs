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
