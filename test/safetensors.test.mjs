import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createSafetensorsProxy } from '../local-models/safetensors-proxy.mjs';
import { createSafetensorsRuntime, inspectSafetensorsPackage } from '../local-models/safetensors-runtime.mjs';
import { createSafetensorsTransport } from '../local-models/safetensors-transport.mjs';
import { verifySafetensorsPrivacy } from '../scripts/safetensors-privacy.mjs';
import { safetensorsDigest } from '../local-models/safetensors-integrity.mjs';

const key='a'.repeat(64),alias='managed-model';

test('immutable native payload privacy gate scans complete binary bytes and retains legal attribution',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-native-privacy-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const executable=path.join(directory,'faber-safetensors.exe'),notice=path.join(directory,'licenses','NOTICE.txt');await fs.mkdir(path.dirname(notice));
  await fs.writeFile(notice,'Copyright Fixture Maintainer. MIT license.');
  const manifest={schemaVersion:1,protocol:3,executable:'faber-safetensors.exe',engineCommit:'465191d0b0a7e2432d327b0de06204ab3f94d3a2',files:[]},identity={terms:['Fixture Maintainer'],configured:true};
  const refresh=async()=>{manifest.files=await Promise.all(['faber-safetensors.exe','licenses/NOTICE.txt'].map(async name=>({path:name,size:(await fs.stat(path.join(directory,name))).size,sha256:await safetensorsDigest(path.join(directory,name))})));};
  const privateFixturePath=['C:','Users','fixture-maintainer','private','cache','source.rs'].join('/');
  await fs.writeFile(executable,Buffer.concat([Buffer.alloc(10000),Buffer.from(privateFixturePath)]));await refresh();
  await assert.rejects(verifySafetensorsPrivacy(directory,manifest,{identity}),/binary-user-path/);
  await fs.writeFile(executable,'MZ /faber-build-home/cache/source.rs');await refresh();await verifySafetensorsPrivacy(directory,manifest,{identity});
  await fs.writeFile(path.join(directory,'private-build.pdb'),'unneeded');await assert.rejects(verifySafetensorsPrivacy(directory,manifest,{identity}),/Unexpected native Safetensors artifact/);await fs.rm(path.join(directory,'private-build.pdb'));
  await fs.appendFile(executable,'changed');await assert.rejects(verifySafetensorsPrivacy(directory,manifest,{identity}),/integrity mismatch/);
});
async function proxyFixture(t,handler){
  const calls=[];const server=http.createServer(async(request,response)=>{calls.push(request.url);assert.equal(request.headers.authorization,undefined);if(request.url==='/v1/models'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{id:'/private/native/model'}]}));return;}const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));assert.equal(body.model,'/private/native/model');await handler(request,response,body);});
  server.listen(0,'127.0.0.1');await once(server,'listening');const proxy=await createSafetensorsProxy({upstream:`http://127.0.0.1:${server.address().port}`,key,alias});
  t.after(async()=>{await proxy.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const request=(route,options={})=>fetch(proxy.baseUrl+route,{...options,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',...options.headers}});
  await request('/health');return {proxy,request,calls};
}

test('native proxy authenticates exact routes, strips upstream credentials and hides native model paths',async t=>{
  const {proxy,request,calls}=await proxyFixture(t,async(_request,response,body)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({model:body.model,choices:[{message:{content:'local'}}]}));});
  assert.equal((await fetch(proxy.baseUrl+'/v1/models')).status,401);
  assert.equal((await request('/v1/models',{headers:{Authorization:`Bearer ${'b'.repeat(64)}`}})).status,401);
  assert.equal((await request('/v1/models',{headers:{Origin:'https://untrusted.example'}})).status,401);
  assert.equal((await request('/v1/models',{headers:{Origin:''}})).status,401);
  const models=await(await request('/v1/models')).json();assert.deepEqual(models.data,[{id:alias,object:'model'}]);
  const baseline=calls.length;for(const route of ['/ui','/v1/models?extra=1','/mcp','/v1/files'])assert.equal((await request(route)).status,404);
  const absoluteStatus=await new Promise((resolve,reject)=>{const req=http.request(new URL(proxy.baseUrl),{path:'http://untrusted.example/',headers:{Authorization:`Bearer ${key}`}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(absoluteStatus,404);assert.equal(calls.length,baseline);
  const result=await request('/v1/chat/completions',{method:'POST',body:JSON.stringify({model:alias,messages:[{role:'user',content:'hello'}]})});assert.equal(result.status,200);assert.equal((await result.json()).model,alias);
  for(const body of [{model:alias,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'http://remote.example/image'}}]}]},{model:alias,messages:[],tool_dispatch_url:'http://remote.example'},{model:alias,messages:[],tools:[{type:'web_search'}]},{model:alias,messages:[],tool_choice:{type:'code_interpreter'}},{model:'other',messages:[]}])assert.equal((await request('/v1/chat/completions',{method:'POST',body:JSON.stringify(body)})).status,400);
});

test('native proxy preserves streamed frames and cancels its upstream when stopped',async t=>{
  let disconnected;const closed=new Promise(resolve=>disconnected=resolve);
  const {proxy,request}=await proxyFixture(t,async(_request,response,body)=>{response.setHeader('Content-Type','text/event-stream');response.write(`data: ${JSON.stringify({model:body.model,choices:[{delta:{content:'hello'}}]})}\n\n`);if(body.prompt==='hold'){response.on('close',disconnected);return;}response.end('data: [DONE]\n\n');});
  const response=await request('/v1/completions',{method:'POST',body:JSON.stringify({model:alias,prompt:'hello',stream:true})}),text=await response.text();assert.match(text,/"model":"managed-model"/);assert.ok(!text.includes('/private/'));assert.match(text,/\[DONE\]/);
  const holding=await request('/v1/completions',{method:'POST',body:JSON.stringify({model:alias,prompt:'hold',stream:true})});await holding.body.getReader().read();await proxy.close();await closed;
});

async function nativeFixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'faber-native-package-')),directory=path.join(root,'models');await fs.mkdir(directory);const executable=path.join(root,'fixture.exe');await fs.writeFile(executable,'controlled fixture');
  for(const [name,value]of Object.entries({'model.safetensors':'fixture weights','unselected.safetensors':'do not stage','config.json':JSON.stringify({model_type:'llama'}),'tokenizer.json':'{}','model.safetensors.index.json':JSON.stringify({weight_map:{a:'model.safetensors'}})}))await fs.writeFile(path.join(directory,name),value);
  const model={id:'fixture',format:'safetensors',complete:true,files:['model.safetensors'],supportFiles:['config.json','tokenizer.json','model.safetensors.index.json']},runtime=await createSafetensorsRuntime({dataDir:path.join(root,'data'),executable,verifyImpl:async()=>true});
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,directory,executable,model,runtime};
}
test('native package stages exact weights with immutable checked configuration and least-permission offline CPU flags',async t=>{
  const {root,directory,model,runtime}=await nativeFixture(t),configuration={mode:'auto',gpuIds:[],cpuIds:[],threads:2,memoryMap:true};
  assert.equal((await runtime.describe(directory,model)).available,true);
  const operation={key,alias,controller:new AbortController()},prepared=await runtime.prepare({directory,model,operation,nativePort:12345,configuration,contextTokens:null});
  t.after(()=>prepared.close());const stage=prepared.args[0];assert.deepEqual((await fs.readdir(stage)).sort(),['config.json','model.safetensors','model.safetensors.index.json','tokenizer.json']);
  assert.deepEqual(prepared.args,[stage,JSON.stringify({mode:'none'})]);assert.ok(!prepared.args.some(value=>/enable-shell|enable-code|--port|mcp/.test(value)));assert.equal(prepared.env.HF_HUB_OFFLINE,'1');assert.equal(prepared.env.RAYON_NUM_THREADS,'2');
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({auto_map:{unsafe:'model.py'},model_type:'llama'}));assert.deepEqual(JSON.parse(await fs.readFile(path.join(stage,'config.json'),'utf8')),{model_type:'llama'});
  await prepared.close();await assert.rejects(fs.access(stage));assert.equal(await fs.readFile(path.join(directory,'model.safetensors'),'utf8'),'fixture weights');
  assert.equal((await runtime.describe(directory,model)).available,false);
  await assert.rejects(runtime.prepare({directory,model,operation,nativePort:12345,configuration,contextTokens:4096}),/Default context/);
  await assert.rejects(runtime.prepare({directory,model,operation,nativePort:12345,configuration:{...configuration,mode:'custom'},contextTokens:null}),/Automatic\/CPU/);
  assert.ok(root);
});
test('native package rejects external index references, missing tokenizer, unsupported architecture and mismatched executable',async t=>{
  const {directory,executable,model,runtime}=await nativeFixture(t);
  await assert.rejects(inspectSafetensorsPackage(directory,{...model,supportFiles:['config.json']}),/tokenizer.json/);
  await fs.writeFile(path.join(directory,'model.safetensors.index.json'),JSON.stringify({weight_map:{a:'../outside.safetensors'}}));
  await assert.rejects(runtime.prepare({directory,model,operation:{key,alias,controller:new AbortController()},nativePort:12345,configuration:{mode:'cpu',cpuIds:[],threads:0,memoryMap:true},contextTokens:null}),/path|unselected|Unsafe/i);
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({model_type:'unsupported'}));assert.match((await runtime.describe(directory,model)).reason,/not qualified architecture/);
  const unavailable=await createSafetensorsRuntime({executable});assert.equal(unavailable.status.available,false);assert.match(unavailable.status.reason,/integrity|unavailable/);
});

test('private pipe frames preserve streaming and cancellation without any native network listener',async()=>{
  const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),kill(){child.emit('close');}});
  const transport=createSafetensorsTransport();transport.attach(child);
  const frame=value=>{const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32LE(body.length);child.stdout.write(Buffer.concat([header,body]));};
  const commands=[];child.stdin.on('data',bytes=>{const command=JSON.parse(bytes.subarray(4));commands.push(command);if(command.kind==='cancel')frame({kind:'done',id:command.id,canceled:true});else{frame({kind:'chunk',id:command.id,value:{model:'worker-model',choices:[{index:0,delta:{content:'hello'},finish_reason:null}]}});if(command.body.prompt!=='hold'){frame({kind:'chunk',id:command.id,value:{model:'worker-model',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{completion_tokens:1}}});frame({kind:'done',id:command.id});}}});
  frame({kind:'ready',protocol:3,model:'worker-model',backend:'cpu',quantization:{mode:'none'},precision:{verified:true,effectiveBitsPerParameter:32,parameters:1}});assert.equal((await transport.fetch('http://127.0.0.1:1/v1/models')).status,200);
  const controller=new AbortController(),response=await transport.fetch('http://127.0.0.1:1/v1/chat/completions',{body:JSON.stringify({model:alias,prompt:'hold',stream:true}),signal:controller.signal});const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/hello/);controller.abort(new Error('fixture stopped'));await assert.rejects(reader.read(),/fixture stopped/);
  const next=await transport.fetch('http://127.0.0.1:1/v1/chat/completions',{body:JSON.stringify({model:alias,prompt:'next',stream:false})});assert.equal((await next.json()).choices[0].message.content,'hello');assert.ok(commands.some(command=>command.kind==='cancel'));transport.close();
});

test('native worker handshake must confirm the exact requested quantization before readiness',async()=>{
  let killed=false;const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),kill(){killed=true;child.emit('close');}});
  const transport=createSafetensorsTransport({quantization:{mode:'q4_0'}});transport.attach(child);
  const body=Buffer.from(JSON.stringify({kind:'ready',protocol:3,model:'worker-model',backend:'cpu',quantization:{mode:'q8_0'}})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);child.stdout.write(Buffer.concat([header,body]));
  assert.equal(killed,true);await assert.rejects(transport.fetch('http://127.0.0.1:1/v1/models'),/stopped/);assert.throws(()=>transport.observed(),/not confirmed/);
});
