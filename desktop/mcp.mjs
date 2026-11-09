import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import sdk from './vendor/mcp-client.cjs';
import {validate,checkTool} from '../core/registry.mjs';
import {atomicWrite} from './recovery.mjs';

const {Client,StdioClientTransport,StreamableHTTPClientTransport}=sdk;
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const string=maxLength=>({type:'string',minLength:1,maxLength});
const id=string(128), enabled={type:'boolean'}, text={type:'string',maxLength:8192};
const endpoint=object({id,name:string(80),projectId:id,transport:{enum:['stdio','http']},url:string(2048),command:string(2048),args:{type:'array',items:text,maxItems:50},credentialEnv:string(64),credential:text},['name','projectId','transport']);
const methods={
  'mcp.list':object({}), 'mcp.save':endpoint,'mcp.connect':object({id}),'mcp.refresh':object({id}),
  'mcp.grant':object({id,name:string(256),fingerprint:string(64),enabled,effect:{enum:['read','write']}}),
  'mcp.disable':object({id}), 'mcp.remove':object({id})
};
export const mcpMethods=Object.keys(methods);
const LIMIT=2*1024*1024;
const sha=value=>createHash('sha256').update(value).digest('hex');
const unauthorized=error=>error?.code===401||error?.status===401||error?.name==='UnauthorizedError';
const slug=value=>value.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
const symbol=(server,name)=>'mcp_'+(slug(server.name).slice(0,15)||'server')+'_'+(slug(name).slice(0,32)||'tool')+'_'+sha(server.id+'\0'+name).slice(0,8);
function inspectSchema(schema){
  let nodes=0;
  function visit(value,depth){
    if(!value||typeof value!=='object')return;
    if(++nodes>256||depth>12)throw new Error('Schema exceeds inspection limits.');
    // A remote regular expression would run inside the state-owning process.
    if(Object.hasOwn(value,'pattern')||Object.hasOwn(value,'patternProperties'))throw new Error('Server-supplied regular expressions are unsupported.');
    for(const child of Object.values(value))visit(child,depth+1);
  }
  visit(schema,0);
}
function checkEndpoint(item){
  if(item.transport==='stdio'){
    if(!item.command||!path.isAbsolute(item.command)||item.command.includes('\0')||item.args?.some(arg=>arg.includes('\0')))throw new Error('Choose an absolute server executable and separate arguments.');
    if(item.credentialEnv&&(!/^[A-Z][A-Z0-9_]{0,55}(KEY|TOKEN|PASSWORD|SECRET)$/.test(item.credentialEnv)||/^(NODE_|LD_|DYLD_|ELECTRON_)/.test(item.credentialEnv)))throw new Error('Choose a credential environment variable ending in KEY, TOKEN, PASSWORD or SECRET.');
    if(item.url)throw new Error('A stdio connection takes an executable.');
  }else{
    const url=new URL(item.url);
    if(url.username||url.password||url.hash||url.search||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Use an HTTPS endpoint, or HTTP on loopback. Keep credentials in the credential field.');
    if(item.command||item.args?.length||item.credentialEnv)throw new Error('An HTTP connection takes a URL.');
  }
}
function catalog(tools,server){
  if(!Array.isArray(tools)||tools.length>256)throw new Error('Invalid MCP catalog or more than 256 tools.');
  const rows=new Map();
  for(const remote of tools){
    if(typeof remote?.name!=='string'||!remote.name.length||remote.name.length>256||rows.has(remote.name))throw new Error('Invalid or duplicate MCP tool name.');
    const fingerprint=sha(JSON.stringify([remote.name,remote.description??'',remote.inputSchema,remote.outputSchema??null]));
    const row={name:remote.name,fingerprint,description:String(remote.description??'').slice(0,800)};
    try{
      if(!remote.inputSchema||Buffer.byteLength(JSON.stringify(remote.inputSchema))>65536)throw new Error('Unsupported input schema size');
      inspectSchema(remote.inputSchema);if(remote.outputSchema)inspectSchema(remote.outputSchema);
      const parameters={...remote.inputSchema,additionalProperties:false};
      if(remote.inputSchema.additionalProperties&&remote.inputSchema.additionalProperties!==true)throw new Error('Schema requires dynamic argument names.');
      const def={name:symbol(server,remote.name),description:row.description||remote.name,permission:'network',parameters,execute:()=>{}};
      checkTool(def);row.parameters=parameters;row.qualifiedName=def.name;
    }catch(error){row.reason=error.message;}
    rows.set(row.name,row);
  }
  return rows;
}
function checkedFetch(endpoint,fetcher){
  const origin=new URL(endpoint).origin;
  return async(input,init={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    if(url.origin!==origin)throw new Error('MCP endpoint changed origin.');
    const response=await fetcher(input,{...init,redirect:'error'});
    if(!response.body)return response;
    if(Number(response.headers.get('content-length'))>LIMIT){await response.body.cancel();throw new Error('MCP response exceeds 2 MiB.');}
    let bytes=0;
    const body=response.body.pipeThrough(new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>LIMIT)throw new Error('MCP response exceeds 2 MiB.');controller.enqueue(chunk);}}));
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}

export async function createMcp({dataDir,runtime,host,emit=()=>{},safeMode=false,fetcher=fetch}){
  const file=path.join(dataDir,'mcp-connections.json'),entries=new Map(),sessions=new Map();
  let queue=Promise.resolve(),closed=false;
  const save=()=>atomicWrite(file,JSON.stringify({version:1,connections:[...entries.values()]},null,2));
  let saved;
  try{
    const bytes=await fs.readFile(file);if(bytes.length>2*1024*1024)throw new Error('MCP settings exceed limit');saved=JSON.parse(bytes);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(saved){
    if(saved.version!==1||!Array.isArray(saved.connections)||saved.connections.length>32)throw new Error('Invalid MCP settings');
    for(const row of saved.connections){
      const {enabled,grants,...config}=row;validate(config,endpoint);checkEndpoint(config);
      if(Object.hasOwn(config,'credential')||typeof enabled!=='boolean'||!Array.isArray(grants)||grants.length>256||!config.id||entries.has(config.id))throw new Error('Invalid MCP connection record');
      for(const g of grants)validate(g,object({name:string(256),fingerprint:string(64),effect:{enum:['read','write']}}));
      entries.set(config.id,row);
    }
  }
  function state(){
    return {connections:[...entries.values()].map(item=>{
      const session=sessions.get(item.id);
      return {...item,state:session?.ready?'connected':session?.error?'disconnected':item.enabled?'offline':'disabled',error:session?.error,
        tools:[...(session?.tools?.values()??[])].map(({parameters,...row})=>({...row,allowed:item.grants.some(g=>g.name===row.name&&g.fingerprint===row.fingerprint)}))};
    })};
  }
  const changed=()=>emit({type:'mcp',state:state()});
  function publish(){
    const defs=[];
    for(const [id,session] of sessions){
      const record=entries.get(id);if(!record?.enabled||!session.ready)continue;
      for(const grant of record.grants){
        const row=session.tools.get(grant.name);if(!row?.qualifiedName||row.fingerprint!==grant.fingerprint)continue;
        const execute=async(args,ctx)=>{
          if(sessions.get(id)!==session||!session.ready||ctx.project.id!==record.projectId||!entries.get(id)?.grants.some(g=>g.name===row.name&&g.fingerprint===row.fingerprint&&g.effect===grant.effect)||session.tools.get(row.name)?.fingerprint!==row.fingerprint)throw new Error('The project MCP tool or its grant changed.');
          if(Buffer.byteLength(JSON.stringify(args))>LIMIT)throw new Error('MCP tool arguments exceed limit.');
          validate(args,row.parameters);
          const controller=new AbortController(),active={name:row.name,fingerprint:row.fingerprint,controller};
          session.active.add(active);
          try{
            const signal=AbortSignal.any([ctx.signal,controller.signal]);
            const result=await session.client.callTool({name:row.name,arguments:args},{signal,timeout:30000,maxTotalTimeout:30000});
            signal.throwIfAborted();
            const content=result.content??[];
            if(Buffer.byteLength(JSON.stringify(result))>LIMIT)throw new Error('MCP tool result exceeds limit.');
            if(result.isError)throw new Error(String(content.find(item=>item.type==='text')?.text||'The remote tool returned an error.').slice(0,2000));
            return {server:record.name,tool:row.name,content, ...(result.structuredContent!==undefined?{structuredContent:result.structuredContent}:{})};
          }catch(error){
            if(unauthorized(error)&&sessions.get(id)===session){
              session.ready=false;session.error='Authentication expired. Update the credential and reconnect.';publish();
              void session.client.close().catch(()=>{});
            }
            if(grant.effect==='write')throw new Error('The external change may have occurred. Check its destination before retrying.',{cause:error});
            throw error;
          }finally{session.active.delete(active);}
        };
        defs.push({name:row.qualifiedName,description:('External MCP tool from '+record.name+'. '+row.description).slice(0,1000),permission:'network',projectId:record.projectId,alwaysAsk:grant.effect==='write',parameters:row.parameters,execute});
      }
    }
    runtime.replaceConnectorTools(defs);changed();
  }
  function takeCatalog(record,session,tools){
    if(sessions.get(record.id)!==session)return;
    const next=catalog(tools,record);
    for(const call of session.active)if(next.get(call.name)?.fingerprint!==call.fingerprint)call.controller.abort(new Error('MCP tool schema changed during the call.'));
    session.tools=next;publish();
  }
  async function disconnect(id){
    const old=sessions.get(id);if(!old)return;
    sessions.delete(id);old.ready=false;
    for(const call of old.active)call.controller.abort(new Error('MCP connection closed. Verify the outcome of any change before retrying.'));
    publish();await old.client.close().catch(()=>{});
  }
  async function connect(record){
    if(closed||safeMode)throw new Error('External MCP connections are paused.');
    await disconnect(record.id);
    const project=(await runtime.request('state.get')).projects.find(p=>p.id===record.projectId&&!p.archived);
    if(!project)throw new Error('The selected project is not available.');
    const secret=await host.getSecret('mcp:'+record.id);
    const session={ready:false,tools:new Map(),active:new Set()};
    const client=new Client({name:'Faber',version:'2.8.0'},{capabilities:{},listMaxPages:8,listChanged:{tools:{onChanged:(error,tools)=>{
      if(sessions.get(record.id)!==session)return;
      if(error){session.error='Discovery failed. Reconnect to review tools.';takeCatalog(record,session,[]);return;}
      try{takeCatalog(record,session,tools);}catch{session.error='Unsupported MCP catalog';takeCatalog(record,session,[]);}
    }}}});
    session.client=client;sessions.set(record.id,session);
    client.onclose=()=>{if(sessions.get(record.id)!==session)return;session.ready=false;session.error ||= 'Server disconnected. Reconnect to resume.';for(const call of session.active)call.controller.abort(new Error('MCP server disconnected.'));publish();};
    const transport=record.transport==='stdio'?new StdioClientTransport({command:record.command,args:record.args??[],cwd:project.path,stderr:'ignore',maxBufferSize:LIMIT,...(secret&&record.credentialEnv?{env:{[record.credentialEnv]:secret}}:{})}):new StreamableHTTPClientTransport(new URL(record.url),{requestInit:{headers:secret?{Authorization:'Bearer '+secret}:{}},fetch:checkedFetch(record.url,fetcher)});
    try{
      await client.connect(transport,{timeout:10000,signal:AbortSignal.timeout(10000)});
      if(!client.getServerCapabilities()?.tools)throw new Error('The MCP server does not advertise tools.');
      const list=await client.listTools(undefined,{timeout:10000,signal:AbortSignal.timeout(10000)});
      session.ready=true;takeCatalog(record,session,list.tools);
    }catch(error){
      const message=unauthorized(error)?'MCP authentication failed. Update the credential and reconnect.':'MCP connection or discovery failed. Check the server, address and credential.';
      session.error=message;session.ready=false;await client.close().catch(()=>{});session.error=message;publish();throw new Error(message);
    }
  }
  async function request(method,params={}){
    if(!methods[method])throw new Error('Unknown MCP operation');validate(params,methods[method]);
    if(method==='mcp.list')return state();
    const record=entries.get(params.id);
    if(method==='mcp.save'){
      if(params.id&&!record)throw new Error('Unknown MCP connection');
      if(!record&&entries.size>=32)throw new Error('The profile already has 32 MCP connections.');
      const {credential,...config}=params;checkEndpoint(config);
      if(!(await runtime.request('state.get')).projects.some(p=>p.id===config.projectId&&!p.archived))throw new Error('Choose an active project.');
      const id=record?.id??randomUUID();
      if(record){await disconnect(id);if(record.projectId!==config.projectId||record.url!==config.url||record.command!==config.command||JSON.stringify(record.args)!==JSON.stringify(config.args))await host.setSecret('mcp:'+id,'');}
      if(credential!==undefined)await host.setSecret('mcp:'+id,credential);
      entries.set(id,{...config,id,enabled:false,grants:[]});await save();publish();return state();
    }
    if(!record)throw new Error('Unknown MCP connection.');
    if(method==='mcp.disable'||method==='mcp.remove'){
      record.enabled=false;const stopped=disconnect(record.id);await save();await stopped;
      if(method==='mcp.remove'){await host.setSecret('mcp:'+record.id,'');entries.delete(record.id);}
    }else if(method==='mcp.grant'){
      const session=sessions.get(record.id),row=session?.tools.get(params.name);
      if(params.enabled&&(!session?.ready||!row?.qualifiedName||row.fingerprint!==params.fingerprint))throw new Error('Refresh the changed tool before granting it.');
      record.grants=record.grants.filter(g=>g.name!==params.name);
      if(params.enabled)record.grants.push({name:params.name,fingerprint:params.fingerprint,effect:params.effect});
      for(const call of session?.active??[])if(call.name===params.name)call.controller.abort(new Error('MCP tool grant changed.'));
    }else if(method==='mcp.refresh'){
      const session=sessions.get(record.id);if(!session?.ready)throw new Error('Connect this MCP server first.');
      try{takeCatalog(record,session,(await session.client.listTools(undefined,{cacheMode:'refresh',timeout:10000,signal:AbortSignal.timeout(10000)})).tools);}
      catch(error){session.ready=false;session.error=unauthorized(error)?'Authentication expired. Update the credential and reconnect.':'Discovery failed. Reconnect before using these tools.';publish();await session.client.close().catch(()=>{});throw new Error(session.error);}
    }else{
      record.enabled=true;await save();await connect(record);
    }
    await save();publish();return state();
  }
  return {request:(method,params)=>{const work=queue.catch(()=>{}).then(()=>request(method,params));queue=work;return work;},
    async restore(){if(!safeMode)for(const record of entries.values())if(record.enabled)await connect(record).catch(()=>{});},
    async close(){closed=true;await queue.catch(()=>{});await Promise.allSettled([...sessions.keys()].map(disconnect));}};
}
