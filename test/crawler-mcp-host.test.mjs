import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRuntime} from '../core/runtime.mjs';
import {createCrawlerMcp} from '../desktop/crawler-mcp.mjs';
import {crawlerTools} from '../tools/web-crawler/catalog.mjs';
import {gatewayToolNames} from '../desktop/gateway.mjs';
import {prepareWorkbench} from '../desktop/packaged-paths.mjs';

const rootSource=fileURLToPath(new URL('..',import.meta.url));
async function until(runtime,predicate,timeout=10000){
  let state=await runtime.request('state.get');if(predicate(state))return state;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{unsubscribe();reject(new Error('Crawler state wait timed out: '+JSON.stringify(state.runs.map(({status,error,toolEvents})=>({status,error,tools:toolEvents.map(({name,status,error})=>({name,status,error}))})))));},timeout);
    const unsubscribe=runtime.subscribe(event=>{if(event.type==='state'){state=event.state;if(predicate(state)){clearTimeout(timer);unsubscribe();resolve(state);}}});
  });
}
async function exited(pid){
  for(let i=0;i<100;i++){
    try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw error;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('Crawler worker remained alive after revocation: '+pid);
}
async function fixture(t,provider,{safeMode=false,real=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-crawler-host-')),sourceDir=real?rootSource:path.join(root,'source');
  if(!real){
    await fs.mkdir(path.join(sourceDir,'tools','web-crawler'),{recursive:true});
    await fs.writeFile(path.join(sourceDir,'tools','web-crawler','server.mjs'),`
      import {createInterface} from 'node:readline';
      import fs from 'node:fs/promises';
      const tools=${JSON.stringify(crawlerTools)},jobs=new Set();
      process.stdin.on('end',()=>process.exit(0));
      async function reply(message){
        if(message.id===undefined)return;
        let result;
        if(message.method==='initialize')result={protocolVersion:'2025-11-25',serverInfo:{name:'crawler-host-fixture',version:'1'},capabilities:{tools:{}}};
        else if(message.method==='tools/list')result={tools};
        else if(message.method==='tools/call'){
          const {name,arguments:args}=message.params;
          await fs.appendFile('calls.ndjson',JSON.stringify({name,args,pid:process.pid})+'\\n');
          if(args.query==='crash')process.exit(17);
          if(args.query==='hold')await new Promise(()=>{});
          const value={pid:process.pid,name,args,secret:process.env.FABER_CRAWLER_TEST_SECRET??null,node:process.env.ELECTRON_RUN_AS_NODE,cwd:process.cwd()};
          result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
        }else result={};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
      }
      for await(const line of createInterface({input:process.stdin}))await reply(JSON.parse(line));
    `);
  }
  const runtime=await createRuntime({dataDir:path.join(root,'profile'),sourceDir,provider});
  const manager=await createCrawlerMcp({runtime,sourceDir,safeMode});
  const project=await runtime.request('project.create',{name:'Crawler fixture',path:root}),chat=await runtime.request('chat.create',{projectId:project.id});
  t.after(async()=>{await manager.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  return {runtime,manager,project,chat,sourceDir,root};
}

test('ordinary main and child model runs receive crawler schemas and call genuine stdio MCP after network approval',async t=>{
  const secret=process.env.FABER_CRAWLER_TEST_SECRET;process.env.FABER_CRAWLER_TEST_SECRET='must-not-reach-worker';
  t.after(()=>{if(secret===undefined)delete process.env.FABER_CRAWLER_TEST_SECRET;else process.env.FABER_CRAWLER_TEST_SECRET=secret;});
  const advertised=[],provider=async function*({messages,tools}){
    advertised.push(tools.map(tool=>tool.name));
    assert.match(messages[0].content,/web_search[\s\S]*web_scrape[\s\S]*web_crawl/);
    for(const tool of crawlerTools)assert.ok(tools.some(item=>item.name===tool.name));
    const last=messages.at(-1);
    if(last.role==='tool'&&last.toolName==='web_search'){yield {type:'delta',text:'Read '+last.content};return;}
    if(last.content==='start')yield {type:'tool',name:'agent_create',args:{task:'child'}};
    else yield {type:'tool',name:'web_search',args:{query:last.content==='child'?'child':'parent'}};
  };
  const f=await fixture(t,provider),{runtime,chat}=f;
  const denied=runtime.request('tool.run',{chatId:chat.id,name:'web_search',args:{query:'denied'}}),rejected=assert.rejects(denied,/denied/i);
  const waiting=await until(runtime,state=>state.approvals.length===1);
  assert.equal(waiting.approvals[0].permission,'network');
  await assert.rejects(fs.readFile(path.join(f.sourceDir,'calls.ndjson')),error=>error.code==='ENOENT');
  await runtime.request('approval.resolve',{id:waiting.approvals[0].id,allow:false});await rejected;
  const {runId}=await runtime.request('chat.send',{chatId:chat.id,text:'start'}),approvedChats=new Set(),approvedIds=new Set();
  let state;
  for(let i=0;i<4;i++){
    state=await until(runtime,state=>state.approvals.some(approval=>!approvedIds.has(approval.id))||state.runs.filter(run=>run.id===runId||run.parentRunId===runId).every(run=>!['running','waiting_approval'].includes(run.status)));
    const pending=state.approvals.filter(approval=>!approvedIds.has(approval.id));if(!pending.length)break;
    for(const approval of pending){approvedIds.add(approval.id);approvedChats.add(approval.chatId);await runtime.request('approval.resolve',{id:approval.id,allow:true});}
  }
  state=await until(runtime,state=>state.runs.filter(run=>run.id===runId||run.parentRunId===runId).length===2&&state.runs.filter(run=>run.id===runId||run.parentRunId===runId).every(run=>run.status==='completed'));
  assert.equal(approvedChats.size,2);assert.ok(advertised.length>=4);
  const values=state.runs.flatMap(run=>run.toolEvents.filter(event=>event.name==='web_search'&&event.status==='completed').map(event=>event.result));
  assert.equal(values.length,2);assert.equal(new Set(values.map(value=>value.pid)).size,2);
  for(const value of values){assert.equal(value.secret,null);assert.equal(value.node,'1');assert.equal(value.cwd,f.sourceDir);await exited(value.pid);}
  assert.ok(crawlerTools.every(tool=>!gatewayToolNames.includes(tool.name)));
});

test('Stop cancels a worker while its MCP call is still pending',async t=>{
  const f=await fixture(t,async function*(){yield {type:'tool',name:'web_search',args:{query:'hold'}};});
  await f.runtime.request('chat.update',{id:f.chat.id,grants:['network']});
  await f.runtime.request('chat.send',{chatId:f.chat.id,text:'start'});
  let calls;
  for(let i=0;i<200;i++){
    calls=await fs.readFile(path.join(f.sourceDir,'calls.ndjson'),'utf8').catch(()=>'');if(calls)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(calls);const pid=JSON.parse(calls.trim()).pid;
  await f.runtime.request('chat.stop',{chatId:f.chat.id});await exited(pid);
  const state=await until(f.runtime,state=>state.runs.every(run=>run.status==='canceled'));
  assert.equal(state.runs[0].toolEvents[0].status,'canceled');
});

test('persisted network grant revocation ends the worker between model turns',async t=>{
  const f=await fixture(t,async function*({messages}){
    if(messages.at(-1).role==='tool')await new Promise(()=>{});
    else yield {type:'tool',name:'web_search',args:{query:'ready'}};
  });
  await f.runtime.request('chat.update',{id:f.chat.id,grants:['network']});
  await f.runtime.request('chat.send',{chatId:f.chat.id,text:'start'});
  const state=await until(f.runtime,state=>state.runs.some(run=>run.toolEvents.some(event=>event.status==='completed'))),pid=state.runs[0].toolEvents[0].result.pid;
  await f.runtime.request('chat.update',{id:f.chat.id,grants:[]});await exited(pid);
});

test('Safe Mode never advertises or starts the built-in crawler',async t=>{
  const f=await fixture(t,async function*({messages}) { assert.doesNotMatch(messages[0].content,/discover sources with web_search/); yield {type:'delta',text:'ok'}; },{safeMode:true});
  const state=await f.runtime.request('state.get');assert.ok(crawlerTools.every(tool=>!state.tools.some(item=>item.name===tool.name)));
  await assert.rejects(f.runtime.request('tool.run',{chatId:f.chat.id,name:'web_search',args:{query:'blocked'}}),/Unknown tool/);
  await assert.rejects(fs.readFile(path.join(f.sourceDir,'calls.ndjson')),error=>error.code==='ENOENT');
  const {runId}=await f.runtime.request('chat.send',{chatId:f.chat.id,text:'Hello'});
  await until(f.runtime,s=>s.runs.some(run=>run.id===runId && run.status==='completed'));
});

test('a worker crash fails closed without restarting jobs in the same run',async t=>{
  const f=await fixture(t,async function*({messages}){
    const calls=messages.filter(message=>message.role==='tool').length;
    if(calls<2)yield {type:'tool',name:'web_search',args:{query:calls?'retry':'crash'}};
    else yield {type:'delta',text:'Worker failure reported'};
  });
  await f.runtime.request('chat.update',{id:f.chat.id,grants:['network']});
  await f.runtime.request('chat.send',{chatId:f.chat.id,text:'start'});
  const state=await until(f.runtime,state=>state.runs[0]?.status==='completed'),events=state.runs[0].toolEvents;
  assert.equal(events.length,2);assert.ok(events.every(event=>event.status==='failed'));assert.match(events[1].error,/expired/i);
  const calls=(await fs.readFile(path.join(f.sourceDir,'calls.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length,1);await exited(calls[0].pid);
});

test('scope validation rejects routine, external, mismatched and completed run contexts before spawning',async t=>{
  const state={projects:[{id:'p'}],chats:[{id:'c',projectId:'p',grants:['network']}],runs:[{id:'r',chatId:'c',status:'running'}]};
  let registered=[],listener;
  const manager=await createCrawlerMcp({sourceDir:rootSource,runtime:{request:async()=>state,subscribe:fn=>{listener=fn;return()=>{};},registerTools:tools=>{registered=tools;}}});
  t.after(()=>manager.close());
  const execute=registered.find(tool=>tool.name==='web_search').execute,ctx={chat:state.chats[0],project:state.projects[0],runId:'r',signal:new AbortController().signal};
  for(const key of ['jobId','externalSessionId']){
    state.runs[0][key]='forbidden';await assert.rejects(execute({query:'blocked'},ctx),/ordinary chats/);delete state.runs[0][key];
  }
  state.chats[0].externalSessionId='external';await assert.rejects(execute({query:'blocked'},ctx),/ordinary chats/);delete state.chats[0].externalSessionId;
  await assert.rejects(execute({query:'blocked'},{...ctx,chat:{id:'another-chat'}}),/no longer active/);
  await assert.rejects(execute({query:'blocked'},{...ctx,project:{id:'another-project'}}),/no longer active/);
  state.runs[0].status='completed';listener({type:'state',state});await assert.rejects(execute({query:'blocked'},ctx),/no longer active/);
});

test('real crawler jobs cannot cross chat/run workers and the host bounds simultaneous workers',async t=>{
  const state={projects:[{id:'p'}],chats:[],runs:[]};
  const contexts=Array.from({length:5},(_,i)=>{
    const chat={id:'c'+i,projectId:'p',grants:['network']},run={id:'r'+i,chatId:chat.id,status:'running'};
    state.chats.push(chat);state.runs.push(run);
    return {chat,project:state.projects[0],runId:run.id,signal:new AbortController().signal};
  });
  let tools=[],listener;
  const manager=await createCrawlerMcp({sourceDir:rootSource,runtime:{request:async()=>state,subscribe:fn=>{listener=fn;return()=>{};},registerTools:value=>{tools=value;}}});
  t.after(()=>manager.close());
  const call=(name,args,ctx)=>tools.find(tool=>tool.name===name).execute(args,ctx);
  const first=await call('web_crawl',{urls:['http://127.0.0.1/private'],maxPages:1,maxDepth:0},contexts[0]);
  assert.ok(first.id);
  await assert.rejects(call('web_crawl_status',{id:first.id},contexts[1]),/not found|not owned|unknown/i);
  assert.equal((await call('web_crawl_status',{id:first.id},contexts[0])).id,first.id);
  for(const ctx of contexts.slice(2,4))await assert.rejects(call('web_crawl_status',{id:first.id},ctx),/not found|not owned|unknown/i);
  await assert.rejects(call('web_crawl_status',{id:first.id},contexts[4]),/four active or closing/i);
  state.runs[0].status='completed';listener({type:'state',state});
  await assert.rejects(call('web_crawl_status',{id:first.id},contexts[0]),/no longer active/);
});

test('the shipped crawler worker executes through the ordinary registry and MCP transport',async t=>{
  const f=await fixture(t,undefined,{real:true});
  await f.runtime.request('chat.update',{id:f.chat.id,grants:['network']});
  const result=await f.runtime.request('tool.run',{chatId:f.chat.id,name:'web_scrape',args:{url:'http://127.0.0.1/private'}});
  assert.match(JSON.stringify(result),/public|private|loopback|blocked|denied/i);
  assert.ok(result.page?.error);assert.equal(result.untrusted,true);
  const state=await f.runtime.request('state.get');assert.equal(state.runs[0].toolEvents[0].status,'completed');
});

test('source-only packaged workbench starts its shipped MCP worker with Electron in Node mode',async t=>{
  const executable=path.join(rootSource,'node_modules','electron','dist',process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron');
  try{await fs.access(executable);}catch{t.skip('Electron executable is unavailable');return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-crawler-workbench-')),bundle=path.join(root,'bundle');
  let runtime,manager;
  t.after(async()=>{await manager?.close();await runtime?.close();await fs.rm(root,{recursive:true,force:true});});
  for(const relative of ['desktop/crawler-mcp.mjs','desktop/vendor/mcp-client.cjs','tools/web-crawler','tools/vendor/crawler-mcp-server.cjs','tools/vendor/web-html.cjs','core/registry.mjs']){
    await fs.mkdir(path.dirname(path.join(bundle,relative)),{recursive:true});await fs.cp(path.join(rootSource,relative),path.join(bundle,relative),{recursive:true});
  }
  await fs.writeFile(path.join(bundle,'package.json'),JSON.stringify({type:'module'}));
  const sourceDir=await prepareWorkbench({bundledSource:bundle,workbenchRoot:path.join(root,'workbench'),version:'0.0.1'});
  await assert.rejects(fs.access(path.join(sourceDir,'node_modules')),error=>error.code==='ENOENT');
  const copied=await import(pathToFileURL(path.join(sourceDir,'desktop','crawler-mcp.mjs')).href);
  runtime=await createRuntime({dataDir:path.join(root,'profile'),sourceDir});manager=await copied.createCrawlerMcp({runtime,sourceDir,executable});
  const project=await runtime.request('project.create',{name:'Workbench fixture',path:root}),chat=await runtime.request('chat.create',{projectId:project.id});
  await runtime.request('chat.update',{id:chat.id,grants:['network']});
  const result=await runtime.request('tool.run',{chatId:chat.id,name:'web_scrape',args:{url:'http://127.0.0.1/private'}});
  assert.ok(result.page?.error);assert.equal(result.untrusted,true);
});
