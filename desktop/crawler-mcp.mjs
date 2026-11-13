import path from 'node:path';
import sdk from './vendor/mcp-client.cjs';
import {crawlerTools} from '../tools/web-crawler/catalog.mjs';

const {Client,StdioClientTransport}=sdk;
const limit=2*1024*1024,active=run=>run&&['running','waiting_approval'].includes(run.status);

export async function createCrawlerMcp({runtime,sourceDir,safeMode=false,executable=process.execPath}){
  const sessions=new Map(),closing=new Set();
  let closed=false,state=await runtime.request('state.get');
  function stop(session,reason){
    if(session.closing)return session.closing;
    session.revoked=true;session.controller.abort(new Error(reason));session.detach();
    const work=session.client.close().catch(()=>{});
    session.closing=work;closing.add(work);void work.finally(()=>closing.delete(work));
    return work;
  }
  function scope(ctx){
    const chat=state.chats.find(chat=>chat.id===ctx.chat.id),run=state.runs.find(run=>run.id===ctx.runId);
    const project=state.projects.find(project=>project.id===ctx.project.id);
    if(closed||safeMode)throw new Error('The built-in crawler is paused in Safe Mode or during shutdown.');
    if(!active(run)||run.chatId!==chat?.id||!chat||chat.archived||chat.projectId!==project?.id||!project||project.archived)throw new Error('The crawler run, chat or project is no longer active.');
    if(run.jobId||run.externalSessionId||chat.externalSessionId)throw new Error('The built-in crawler is available only to ordinary chats and their child agents.');
    ctx.signal.throwIfAborted();return chat;
  }
  const unsubscribe=runtime.subscribe(event=>{
    state=event.state;
    for(const [id,session] of sessions){
      const run=state.runs.find(run=>run.id===id),chat=state.chats.find(chat=>chat.id===session.chatId),project=state.projects.find(project=>project.id===session.projectId);
      if(!active(run)||!chat||chat.archived||chat.projectId!==session.projectId||!project||project.archived||session.networkGranted&&!chat.grants.includes('network')){
        void stop(session,'Crawler scope or network permission ended.');
        if(!active(run))sessions.delete(id);
      }else if(chat.grants.includes('network'))session.networkGranted=true;
    }
  },{accept:type=>type==='state'&&sessions.size>0});
  async function connect(ctx,chat){
    if(sessions.size+closing.size>=4)throw new Error('The built-in crawler already has four active or closing run sessions.');
    const controller=new AbortController(),client=new Client({name:'Faber built-in crawler',version:'1.0.0'},{capabilities:{},listMaxPages:1});
    const transport=new StdioClientTransport({command:executable,args:[path.join(sourceDir,'tools','web-crawler','server.mjs')],cwd:sourceDir,env:{ELECTRON_RUN_AS_NODE:'1'},stderr:'ignore',maxBufferSize:limit});
    const session={client,controller,chatId:chat.id,projectId:chat.projectId,networkGranted:chat.grants.includes('network'),revoked:false,detach:()=>ctx.signal.removeEventListener('abort',cancel)};
    const cancel=()=>{void stop(session,'Crawler run canceled.');};
    sessions.set(ctx.runId,session);ctx.signal.addEventListener('abort',cancel,{once:true});
    client.onclose=()=>{if(!session.revoked)void stop(session,'Crawler worker disconnected; its jobs have expired.');};
    client.onerror=()=>{void stop(session,'Crawler transport failed; its jobs have expired.');};
    const signal=AbortSignal.any([ctx.signal,controller.signal]);
    session.ready=(async()=>{
      try{
        await client.connect(transport,{signal,timeout:10000});
        const discovered=await client.listTools(undefined,{signal,timeout:10000});
        if(JSON.stringify(discovered.tools)!==JSON.stringify(crawlerTools))throw new Error('The built-in crawler catalog does not match the shipped tools.');
        signal.throwIfAborted();
      }catch(error){await stop(session,'Crawler connection failed.');throw error;}
    })();
    await session.ready;return session;
  }
  if(!safeMode)runtime.registerTools(crawlerTools.map(tool=>({
    name:tool.name,description:tool.description+' Jobs and results belong only to this run and expire when it ends. Poll and read results before completing the run.',parameters:tool.inputSchema,permission:'network',
    async execute(args,ctx){
      if(!sessions.size)state=await runtime.request('state.get');
      const chat=scope(ctx);
      if(Buffer.byteLength(JSON.stringify(args))>limit)throw new Error('Crawler arguments exceed 2 MiB.');
      const session=sessions.get(ctx.runId)??await connect(ctx,chat);
      if(session.chatId!==chat.id||session.projectId!==chat.projectId||session.revoked)throw new Error('This crawler session has expired. Start a new run.');
      await session.ready;scope(ctx);
      const signal=AbortSignal.any([ctx.signal,session.controller.signal]);
      try{
        const result=await session.client.callTool({name:tool.name,arguments:args},{signal,timeout:30000,maxTotalTimeout:30000});
        signal.throwIfAborted();scope(ctx);
        if(Buffer.byteLength(JSON.stringify(result))>limit)throw new Error('Crawler result exceeds 2 MiB.');
        if(result.isError)throw new Error(String(result.content?.find(item=>item.type==='text')?.text||'Crawler tool failed.').slice(0,2000));
        if(!result.structuredContent||typeof result.structuredContent!=='object'||Array.isArray(result.structuredContent))throw new Error('Crawler returned an invalid structured result.');
        return result.structuredContent;
      }catch(error){
        // A timed-out request must not leave a crawl running outside its caller's control.
        if(error.code===-32001)await stop(session,'Crawler request timed out.');
        throw error;
      }
    }
  })));
  return {async close(){if(closed)return;closed=true;unsubscribe();await Promise.allSettled([...sessions.values()].map(session=>stop(session,'Faber is closing.')));await Promise.allSettled([...closing]);sessions.clear();}};
}
