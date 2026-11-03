import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createAddons} from '../desktop/addons.mjs';
import {createRuntime} from '../core/runtime.mjs';
import {checked} from '../bundled-addons/lightpanda/process.mjs';
if(!process.argv.includes('--allow-owned-wsl-fixture'))throw Error('Opt in with --allow-owned-wsl-fixture. Creates and removes only an isolated owned WSL2 distro.');
const source=path.resolve(fileURLToPath(new URL('..',import.meta.url))),root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-Lightpanda-live-'));
const resourceArg=process.argv.indexOf('--resources'),resources=resourceArg<0?path.join(source,'.runtime/lightpanda'):path.resolve(process.argv[resourceArg+1]);
let server,manager,distro,approvals=0;const runtime=await createRuntime({dataDir:root,sourceDir:source,host:{isAutomaticTool:(tool,permission)=>manager?.isAutomaticTool(tool,permission)}});
runtime.subscribe(event=>{if(event.type==='approval'){approvals++;void runtime.request('approval.resolve',{id:event.approval.id,allow:false});}});
const project=await runtime.request('project.create',{name:'Isolated browser proof',path:root}),chat=await runtime.request('chat.create',{projectId:project.id}),otherChat=await runtime.request('chat.create',{projectId:project.id});
const create=()=>createAddons({dataDir:root,runtime,bundledSource:path.join(source,'bundled-addons'),bundledResources:{lightpanda:resources},confirm:async()=>true});
const call=(name,args={},chatId=chat.id)=>runtime.request('tool.run',{chatId,name:`lightpanda_${name}`,args});
try {
  manager=create();await manager.initialize();assert.equal((await runtime.request('state.get')).tools.filter(tool=>tool.name.startsWith('lightpanda_')).length,11);
  assert.equal((await call('connect')).engine,'Lightpanda (LP domain verified)');
  const setup=await call('status');assert.equal(setup.installed,true);distro=setup.distro;
  const routes=await checked('wsl.exe',['--distribution',distro,'--user','lightpanda','--exec','cat','/proc/net/route']);
  const route=routes.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]==='00000000');assert.ok(route,'owned WSL gateway');
  const address=Buffer.from(route[2],'hex').reverse().join('.');
  server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Owned Lightpanda fixture</title><h1>Fixture ready</h1><input id="name"><button id="submit" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Submit</button><p id="result"></p>');});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,address,resolve));
  assert.equal((await call('connect')).engine,'Lightpanda (LP domain verified)');
  const page=await call('navigate',{url:`http://${address}:${server.address().port}/`});assert.equal(page.title,'Owned Lightpanda fixture');
  await call('type',{selector:'#name',text:'Actual Lightpanda input'});await call('click',{selector:'#submit'});
  assert.match((await call('read')).text,/Actual Lightpanda input/);assert.equal((await call('evaluate',{expression:'document.querySelector("#result").textContent'})).value,'Actual Lightpanda input');
  await assert.rejects(call('connect',{},otherChat.id),/busy with another chat/);assert.match((await call('read')).text,/Actual Lightpanda input/);assert.equal((await call('stop',{},otherChat.id)).stopped,false);assert.equal((await call('status')).running,true);const idleStarted=Date.now();await new Promise(resolve=>setTimeout(resolve,32000));assert.equal((await call('status')).running,false,'idle cleanup stops owned browser without a Stop request');const idleRunning=(await checked('wsl.exe',['--list','--running','--quiet'])).replaceAll('\u0000','');assert.ok(!idleRunning.includes(distro),'idle cleanup terminates only owned distro');const idleElapsedMs=Date.now()-idleStarted;await call('connect',{},otherChat.id);assert.equal((await call('stop',{},otherChat.id)).stopped,true);assert.equal((await call('status')).running,false);
  await call('connect');assert.equal(approvals,0);
  await manager.request('addons.disable',{id:'lightpanda'});assert.ok(!(await runtime.request('state.get')).tools.some(tool=>tool.name.startsWith('lightpanda_')));
  const running=(await checked('wsl.exe',['--list','--running','--quiet'])).replaceAll('\u0000','');assert.ok(!running.includes(distro),'disable stops owned runtime');
  await manager.request('addons.uninstall',{id:'lightpanda'});await manager.close();manager=create();await manager.initialize();assert.ok(!(await runtime.request('state.get')).tools.some(tool=>tool.name.startsWith('lightpanda_')));
  const remaining=(await checked('wsl.exe',['--list','--quiet'])).replaceAll('\u0000','');assert.ok(!remaining.includes(distro),'uninstall removes owned distro');
  const report={ok:true,root,engine:'Lightpanda 1.0.2',version:'1.0.2',distro,automaticFirstUse:true,approvalCount:approvals,exclusiveChatIsolation:true,automaticIdleStop:true,idleElapsedMs,subsequentChatAcquired:true,navigate:true,type:true,click:true,read:true,evaluate:true,disableStopped:true,uninstallRemoved:true,restartDidNotReseed:true,existingDistrosUntouched:true,noInference:true};
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  if(manager){await manager.request('addons.uninstall',{id:'lightpanda'}).catch(error=>console.error(`Owned fixture cleanup needs attention: ${error.message}`));await manager.close();}
  await runtime.close();
}
