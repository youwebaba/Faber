import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createMcp} from '../desktop/mcp.mjs';
const script=fileURLToPath(new URL('./mcp-fixture.mjs',import.meta.url));

for(const transport of ['stdio','http'])test('MCP discovery, project scope and revocation over '+transport,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-mcp-'));
  const secret=new Map(),projects=[{id:'p',path:root,name:'Example'}];let tools=[];
  const runtime={request:async()=>({projects}),replaceConnectorTools:value=>{tools=value;}};
  const manager=await createMcp({dataDir:root,runtime,host:{getSecret:id=>secret.get(id),setSecret:(id,v)=>secret.set(id,v)}});
  let stopServer=async()=>{};
  t.after(async()=>{await manager.close();await stopServer();await fs.rm(root,{recursive:true,force:true});});
  let endpoint={command:process.execPath,args:[script]};
  if(transport==='http'){
    const child=spawn(process.execPath,[script,'--http'],{cwd:root,stdio:['ignore','pipe','ignore'],windowsHide:true});
    const exited=once(child,'exit');stopServer=async()=>{child.kill();await exited;};
    const port=Number((await once(child.stdout,'data'))[0]);assert.ok(port>0);
    endpoint={url:'http://127.0.0.1:'+port,credential:'fake-local-mcp-key'};
  }
  const saved=await manager.request('mcp.save',{name:'Fixture',projectId:'p',transport,...endpoint});
  const id=saved.connections[0].id,conn=(await manager.request('mcp.connect',{id})).connections[0];assert.equal(conn.state,'connected');
  assert.equal(conn.tools.length,2);assert.equal(tools.length,0);
  const row=conn.tools.find(r=>r.name==='append'),grant={id,name:row.name,fingerprint:row.fingerprint,enabled:true,effect:'write'};
  await manager.request('mcp.grant',grant);assert.equal(tools.length,1);assert.equal(tools[0].alwaysAsk,true);
  const tool=tools[0],ctx={project:projects[0],signal:new AbortController().signal};
  await assert.rejects(tool.execute({text:'wrong'},{...ctx,project:{id:'other'}}),/project/i);
  assert.equal((await tool.execute({text:'once'},ctx)).content[0].text,'once');
  await manager.request('mcp.grant',{...grant,enabled:false});assert.equal(tools.length,0);
  await assert.rejects(tool.execute({text:'again'},ctx),/grant/);
  assert.equal(await fs.readFile(path.join(root,'journal.txt'),'utf8'),'once\n');
  await manager.request('mcp.grant',grant);
  const slow=tools[0].execute({text:'slow'},ctx);
  const interrupted=assert.rejects(slow,/may have occurred/);
  for(let i=0;i<100;i++){if((await fs.readFile(path.join(root,'journal.txt'),'utf8')).includes('slow'))break;await new Promise(r=>setTimeout(r,5));}
  await manager.request('mcp.grant',{...grant,enabled:false});await interrupted;
  assert.equal(await fs.readFile(path.join(root,'journal.txt'),'utf8'),'once\nslow\n');
  await manager.request('mcp.grant',grant);
  await fs.writeFile(path.join(root,'catalog-version'),'changed semantics');
  await manager.request('mcp.refresh',{id});assert.equal(tools.length,0);
  await assert.rejects(manager.request('mcp.grant',grant),/changed tool/);
  assert.ok(!(await fs.readFile(path.join(root,'mcp-connections.json'),'utf8')).includes('fake-local-mcp-key'));
  await manager.request('mcp.disable',{id});assert.equal((await manager.request('mcp.list')).connections[0].state,'disabled');
});

