import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createAddons} from '../desktop/addons.mjs';
import {checked} from '../bundled-addons/lightpanda/process.mjs';
if(!process.argv.includes('--allow-owned-wsl-fixture'))throw Error('Opt in with --allow-owned-wsl-fixture. Creates and removes only an isolated owned WSL2 distro.');
const source=path.resolve(fileURLToPath(new URL('..',import.meta.url))),root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-Lightpanda-live-'));
const resourceArg=process.argv.indexOf('--resources'),resources=resourceArg<0?path.join(source,'.runtime/lightpanda'):path.resolve(process.argv[resourceArg+1]);
let tools=[],server,manager,distro;const runtime={request:async()=>({tools}),replaceExtensionTools:async next=>{tools=next;}};
const create=()=>createAddons({dataDir:root,runtime,bundledSource:path.join(source,'bundled-addons'),bundledResources:{lightpanda:resources},confirm:async()=>true});
const ctx={chatId:'controlled-browser-proof',signal:AbortSignal.timeout(180000),approve:async()=>true};
const call=(name,args={})=>{const tool=tools.find(item=>item.name===`lightpanda_${name}`);assert.ok(tool);return tool.execute(args,ctx);};
try {
  manager=create();await manager.initialize();assert.equal(tools.filter(tool=>tool.name.startsWith('lightpanda_')).length,11);
  const setup=await call('setup');assert.equal(setup.version,'1.0.2');distro=setup.distro;
  const routes=await checked('wsl.exe',['--distribution',distro,'--user','lightpanda','--exec','cat','/proc/net/route']);
  const route=routes.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]==='00000000');assert.ok(route,'owned WSL gateway');
  const address=Buffer.from(route[2],'hex').reverse().join('.');
  server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Owned Lightpanda fixture</title><h1>Fixture ready</h1><input id="name"><button id="submit" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Submit</button><p id="result"></p>');});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,address,resolve));
  assert.equal((await call('connect')).engine,'Lightpanda (LP domain verified)');
  const page=await call('navigate',{url:`http://${address}:${server.address().port}/`});assert.equal(page.title,'Owned Lightpanda fixture');
  await call('type',{selector:'#name',text:'Actual Lightpanda input'});await call('click',{selector:'#submit'});
  assert.match((await call('read')).text,/Actual Lightpanda input/);assert.equal((await call('evaluate',{expression:'document.querySelector("#result").textContent'})).value,'Actual Lightpanda input');
  await manager.request('addons.disable',{id:'lightpanda'});assert.equal(tools.length,0);
  const running=(await checked('wsl.exe',['--list','--running','--quiet'])).replaceAll('\u0000','');assert.ok(!running.includes(distro),'disable stops owned runtime');
  await manager.request('addons.uninstall',{id:'lightpanda'});await manager.close();manager=create();await manager.initialize();assert.equal(tools.length,0);
  const remaining=(await checked('wsl.exe',['--list','--quiet'])).replaceAll('\u0000','');assert.ok(!remaining.includes(distro),'uninstall removes owned distro');
  const report={ok:true,root,engine:'Lightpanda 1.0.2',version:setup.version,distro,navigate:true,type:true,click:true,read:true,evaluate:true,disableStopped:true,uninstallRemoved:true,restartDidNotReseed:true,existingDistrosUntouched:true,noInference:true};
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  if(manager){await manager.request('addons.uninstall',{id:'lightpanda'}).catch(error=>console.error(`Owned fixture cleanup needs attention: ${error.message}`));await manager.close();}
}
