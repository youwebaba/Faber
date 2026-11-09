// Opt-in interoperability with an independently installed reference filesystem server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createRuntime} from '../core/runtime.mjs';
import {streamProvider} from '../core/provider.mjs';
import {runnerEnvironment} from '../local-models/hardware.mjs';
import {createMcp} from '../desktop/mcp.mjs';
const {FABER_MCP_FILESYSTEM_SERVER:server,FABER_MCP_TEST_RUNNER:runner,FABER_MCP_TEST_MODEL:model}=process.env;
assert.ok(server&&runner&&model,'Provide paths to the reference Node server, managed llama.cpp runner and Qwen GGUF');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(100);}throw Error('Interoperability check timed out');}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-MCP-live-')),project=path.join(root,'project');
await fs.mkdir(project);await fs.writeFile(path.join(project,'marker.txt'),'orchid-718');
const bind=net.createServer();bind.listen(0,'127.0.0.1');await once(bind,'listening');const port=bind.address().port;await new Promise(resolve=>bind.close(resolve));
const secret=randomBytes(32).toString('hex'),base='http://127.0.0.1:'+port,keys=new Map();
const child=spawn(runner,['--model',model,'--alias','qwen-mcp-test','--host','127.0.0.1','--port',String(port),'--api-key',secret,'--n-gpu-layers','0','--device','none','--ctx-size','8192','--threads','2','--threads-batch','2','--offline','--jinja'],{stdio:'ignore',windowsHide:true,env:runnerEnvironment(runner)});
const exit=once(child,'exit');let manager,runtime;
try{
  await until(async()=>{try{return (await fetch(base+'/health',{headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(1200)})).ok;}catch{return false;}});
  const host={getSecret:async id=>keys.get(id)||'',setSecret:async(id,v)=>keys.set(id,v),providerControls:()=>({context:{mode:'managed',capacityTokens:8192},thinking:{supported:true,mode:'llama_cpp'}})};
  runtime=await createRuntime({dataDir:path.join(root,'data'),sourceDir:project,host,provider:args=>streamProvider({...args,tools:args.tools.filter(tool=>tool.name.startsWith('mcp_')),fetchImpl:(url,init)=>fetch(url,{...init,body:JSON.stringify({...JSON.parse(init.body),temperature:0,seed:42})})})});
  const proj=await runtime.request('project.create',{name:'MCP test project',path:project});
  manager=await createMcp({dataDir:path.join(root,'data'),runtime,host});
  const saved=await manager.request('mcp.save',{name:'Filesystem',projectId:proj.id,transport:'stdio',command:process.execPath,args:[server,project]});
  const id=saved.connections[0].id,conn=(await manager.request('mcp.connect',{id})).connections[0],tool=conn.tools.find(row=>row.name==='read_text_file');
  assert.ok(tool?.qualifiedName,JSON.stringify(conn.tools.map(r=>[r.name,r.reason])));
  await manager.request('mcp.grant',{id,name:tool.name,fingerprint:tool.fingerprint,effect:'read',enabled:true});
  const provider=await runtime.request('provider.save',{name:'Qwen API fixture',kind:'openai',baseUrl:base+'/v1',model:'qwen-mcp-test',apiKey:secret});
  const chat=await runtime.request('chat.create',{projectId:proj.id});
  await runtime.request('chat.update',{id:chat.id,providerId:provider.id,thinking:false,grants:['network'],systemPrompt:'Use the provided file-reading tool on the exact requested absolute path. When the tool returns, answer with the retrieved marker.'});
  const run=await runtime.request('chat.send',{chatId:chat.id,text:'Read '+path.join(project,'marker.txt')+' using '+tool.qualifiedName+'. Return its contents.'});
  const state=await until(async()=>{const s=await runtime.request('state.get');return s.runs.find(row=>row.id===run.runId)?.endedAt&&s;});
  const result=state.runs.find(row=>row.id===run.runId),events=result.toolEvents.filter(e=>e.name===tool.qualifiedName);
  assert.ok(events.some(e=>e.status==='completed'&&JSON.stringify(e.result).includes('orchid-718')),JSON.stringify(events));
  console.log(JSON.stringify({model:path.basename(model),tool:tool.name,completedRead:true,status:result.status,provider:'local OpenAI-compatible HTTP',cpuThreads:2,toolsAdvertised:1}));
}finally{await manager?.close();await runtime?.close();child.kill();await exit;await fs.rm(root,{recursive:true,force:true});}

