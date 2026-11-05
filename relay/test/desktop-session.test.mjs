import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRelayServer } from '../server.mjs';
import { createRuntime } from '../../core/runtime.mjs';
import { createRemoteService } from '../../desktop/remote-service.mjs';
import { atomicWrite } from '../../desktop/recovery.mjs';

async function until(read, check, description, ms = 35000) {
  const limit = Date.now() + ms;
  let value;
  do { value = await read(); if (check(value)) return value; await sleep(150); } while (Date.now() < limit);
  throw new Error(description + (value?.hosting?.error ? ' (' + value.hosting.error + ')' : ''));
}
function vault() {
  const values = new Map();
  return {getSecret:async k=>values.get(k)||'',setSecret:async(k,v)=>{values.set(k,v);}};
}
async function exercise(t, publicRoute) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'faber-remote-test-'));
  const operator = publicRoute ? path.join(process.env.LOCALAPPDATA,'FaberRelay') : root;
  const routeFile = path.join(operator,'routes.json');
  let relay, home, laptop, runtime, routeId;
  t.after(async()=>{
    await Promise.allSettled([home?.close(),laptop?.close()]);
    if (publicRoute && routeId) {
      const allowed = JSON.parse(await fs.readFile(routeFile,'utf8'));
      await atomicWrite(routeFile,JSON.stringify({routes:allowed.routes.filter(route=>route!==routeId)}));
    }
    await relay?.close(); await runtime?.close(); await fs.rm(root,{recursive:true,force:true});
  });
  if (!publicRoute) {
    await fs.writeFile(routeFile,'{"routes":[]}');
    relay = createRelayServer({allowedRouteFile:routeFile});
    const {port} = await relay.start();
    await fs.writeFile(path.join(operator,'operator.json'),JSON.stringify({relayUrl:'ws://127.0.0.1:' + port,allowLocalEnrollment:true}));
  }
  let calls = 0, effects = 0;
  runtime = await createRuntime({dataDir:path.join(root,'home'),sourceDir:path.join(root,'source'),provider:async function*({signal}){
    calls++;
    if (calls===2) { yield {type:'tool',id:'demo-safe-effect',name:'fixture_action',args:{}}; return; }
    if (calls===3) { yield {type:'delta',text:'Working on host.'}; await sleep(30000,null,{signal}); }
    yield {type:'delta',text:'Verified on the home PC.'};
  }});
  runtime.registerTools([{name:'fixture_action',description:'In-memory fixture effect',parameters:{type:'object',properties:{},additionalProperties:false},permission:'files',execute:async()=>({count:++effects})}]);
  const project = await runtime.request('project.create',{name:'Proof project',path:root});
  const chat = await runtime.request('chat.create',{projectId:project.id,title:'Remote proof'});
  const homeOptions = { dataDir:path.join(root,'home'), operatorDir:operator, host:vault(), dispatch:runtime.remoteRequest, allowLocalRelay:!publicRoute };
  const clientDir = path.join(root,'client'); await fs.mkdir(clientDir);
  const clientOptions = { dataDir:clientDir,host:vault(),dispatch:()=>{throw new Error('Wrong execution PC')}, allowLocalRelay:!publicRoute };
  home = await createRemoteService(homeOptions); laptop = await createRemoteService(clientOptions);
  assert.equal((await home.request('remote.status')).hosting.state,'off');
  await home.request('remote.configure',{allowConnections:true,deviceName:'Test home'});
  const hostStatus = await until(()=>home.request('remote.status'),s=>s.hosting.state==='online','Home did not register');
  routeId = hostStatus.hostRouteId;
  const {invite} = await home.request('remote.invite');
  await laptop.request('remote.pair',{invite,deviceName:'Test laptop'});
  const {pending} = await home.request('remote.status'); assert.equal(pending[0].deviceName,'Test laptop');
  assert.deepEqual((await laptop.request('remote.status')).devices,[]);
  await home.request('remote.approve',{id:pending[0].id,allow:true});
  const client = await until(()=>laptop.request('remote.status'),s=>s.devices.some(d=>d.role==='host'),'Laptop did not pair');
  const deviceId = client.devices[0].id;
  const rpc = (method,params={},requestId)=>laptop.request('remote.request',{deviceId,method,params,...(requestId?{requestId}:{})});
  const listing = await rpc('workspace.list');
  assert.equal(listing.projects[0].name,'Proof project'); assert.equal(listing.projects[0].path,undefined);
  assert.equal(listing.chats[0].id,chat.id); assert.equal(listing.chats[0].systemPrompt,undefined);
  assert.ok((await rpc('workspace.models')).providers.length);
  const requestId = randomUUID(), send={chatId:chat.id,text:'Confirm execution.'};
  const result = await rpc('chat.send',send,requestId);
  assert.equal((await rpc('chat.send',send,requestId)).runId,result.runId);
  await assert.rejects(()=>rpc('chat.send',{...send,text:'Duplicate changed'},requestId));
  await until(()=>rpc('chat.read',{chatId:chat.id}),row=>row.chat.messages.some(m=>m.content==='Verified on the home PC.'),'Remote reply missing');
  assert.equal(calls,1);
  await assert.rejects(()=>rpc('state.get'));
  await laptop.close(); laptop = await createRemoteService(clientOptions);
  assert.equal((await rpc('workspace.list')).chats[0].id,chat.id);
  await home.close(); home = await createRemoteService(homeOptions);
  await until(()=>home.request('remote.status'),s=>s.hosting.state==='online','Home did not reconnect');
  assert.equal((await rpc('chat.read',{chatId:chat.id})).chat.messages.at(-1).content,'Verified on the home PC.');
  const second = await rpc('chat.create',{projectId:project.id,title:'Tool approval proof'},randomUUID());
  await rpc('chat.send',{chatId:second.id,text:'Exercise approval.'},randomUUID());
  const waiting = await until(()=>rpc('chat.read',{chatId:second.id}),view=>view.approvals.length,'Host approval missing');
  assert.equal(effects,0);
  const queued = await rpc('chat.send',{chatId:second.id,text:'Follow-up during work.'},randomUUID()); assert.equal(queued.queued,true);
  await rpc('approval.resolve',{id:waiting.approvals[0].id,chatId:second.id,allow:true},randomUUID());
  await until(()=>rpc('chat.read',{chatId:second.id}),view=>view.streams.some(s=>s.text==='Working on host.'),'Tool did not run after approval');
  assert.equal(effects,1);
  await rpc('chat.forceStop',{chatId:second.id},randomUUID());
  const stopped = await rpc('chat.read',{chatId:second.id}); assert.equal(stopped.runs.at(-1).status,'canceled');
  if (!publicRoute) {
    const targets = [];
    for (let i=0;i<6;i++) targets.push((await runtime.request('chat.create',{projectId:project.id,title:'Switch '+i})).id);
    const outstanding = [];
    for (const id of targets) {
      const {revision} = await rpc('chat.read',{chatId:id});
      outstanding.push(rpc('chat.read',{chatId:id,since:revision,waitMs:12000}).then(()=>false,()=>true));
      await sleep(20);
    }
    await rpc('chat.read',{chatId:chat.id});
    assert.ok((await Promise.all(outstanding)).every(Boolean),'previous chat polls are canceled when the laptop switches chats');
  }
  await home.request('remote.revoke',{id:pending[0].id});
  await assert.rejects(()=>rpc('workspace.list'));
  await home.request('remote.configure',{allowConnections:false});
  assert.equal((await home.request('remote.status')).hosting.state,'off');
}
test('two Faber profiles pair, run the host workspace, reconnect and revoke through the relay',
  {timeout:90000,skip:process.platform!=='win32'}, t=>exercise(t,false));
test('operator opt-in: two disposable Faber profiles use the public relay through pinned TLS',
  {timeout:180000,skip:process.env.FABER_TEST_REMOTE_PUBLIC!=='1'},t=>exercise(t,true));
