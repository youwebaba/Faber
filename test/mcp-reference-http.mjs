// Point this opt-in check at the independent server-filesystem distribution's server.js.
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {createMcp} from '../desktop/mcp.mjs';
const entry=process.env.FABER_MCP_FILESYSTEM_FACTORY;
assert.ok(entry&&path.isAbsolute(entry),'Set FABER_MCP_FILESYSTEM_FACTORY to the reference server.js');
const {createServer}=await import(pathToFileURL(entry));
const {WebStandardStreamableHTTPServerTransport}=createRequire(entry)('@modelcontextprotocol/server');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'faber-mcp-reference-http-')),project=path.join(root,'project');
await fs.mkdir(project);await fs.writeFile(path.join(project,'fixture.txt'),'verified-reference-http');
const server=createServer([project]),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true});
await server.connect(transport);
const bearer=randomBytes(24).toString('hex'),store=new Map();
const listener=http.createServer(async(req,res)=>{
  try{
    if(req.headers.authorization!=='Bearer '+bearer){res.writeHead(401);res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
    const request=new Request('http://127.0.0.1:'+listener.address().port+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})});
    const response=await transport.handleRequest(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if(!response.body){res.end();return;}
    const readable=Readable.fromWeb(response.body);res.on('close',()=>readable.destroy());readable.pipe(res);
  }catch{if(!res.headersSent)res.writeHead(500);res.end();}
});
listener.listen(0,'127.0.0.1');await once(listener,'listening');let manager,tools=[];
try{
  const runtime={request:async()=>({projects:[{id:'project',path:project}]}),replaceConnectorTools:value=>{tools=value;}};
  manager=await createMcp({dataDir:path.join(root,'profile'),runtime,host:{getSecret:async k=>store.get(k)||'',setSecret:async(k,v)=>store.set(k,v)}});
  const result=await manager.request('mcp.save',{name:'Reference filesystem HTTP',projectId:'project',transport:'http',url:'http://127.0.0.1:'+listener.address().port+'/mcp',credential:bearer});
  const id=result.connections[0].id,conn=(await manager.request('mcp.connect',{id})).connections[0],read=conn.tools.find(t=>t.name==='read_text_file');
  assert.equal(conn.state,'connected',conn.error);assert.ok(read);await manager.request('mcp.grant',{id,name:read.name,fingerprint:read.fingerprint,effect:'read',enabled:true});
  const response=await tools[0].execute({path:path.join(project,'fixture.txt')},{project:{id:'project'},signal:new AbortController().signal});
  assert.equal(response.content[0].text,'verified-reference-http');console.log('Independent reference filesystem over authenticated Streamable HTTP passed.');
}finally{await manager?.close();await server.close();listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));await fs.rm(root,{recursive:true,force:true});}
