import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOutlook} from '../desktop/outlook.mjs';
import {outlookAuth,outlookScopes} from '../desktop/outlook-auth.mjs';
import ledgerModule from '../desktop/action-ledger.cjs';

const caps={inbox:true,drafts:true,send:true,calendar:true,events:true};
const config={projectId:'project',clientId:'00000000-0000-4000-8000-000000000001',tenant:'common',caps};
function service(){
  const messages=new Map([['source',{id:'source',subject:'Controlled message',body:{content:'Draft a response.'}}]]),events=new Map();
  let connected=false,sendCount=0,eventCount=0,loseSend=true;
  return {messages,events,get sendCount(){return sendCount;},get eventCount(){return eventCount;},
    begin:async()=>({}),poll:async()=>{connected=true;return {accountId:'test-account',accountName:'Test account'};},
    connected:async()=>connected,disconnect:async()=>{connected=false;},close(){},cancel(){},
    async api(_record,route,options={}){
      const url=new URL('https://graph.microsoft.com'+route);
      if(!connected)throw Error('Reconnect Outlook');
      const operation=url.pathname;
      if(url.searchParams.has('$filter')&&url.searchParams.has('$expand')){
        const id=url.searchParams.get('$filter').match(/p\/value eq '([a-f0-9]{64})'/)?.[1];
        const rows=operation==='/me/events'?events:messages;
        return {value:[...rows.values()].filter(row=>row.singleValueExtendedProperties?.some(p=>p.value===id))};
      }
      if(operation==='/me/mailFolders/inbox/messages')return {value:[messages.get('source')]};
      if(operation==='/me/mailFolders/inbox/messages/source')return messages.get('source');
      if(operation==='/me/messages/source/createReply'){
        const row={id:'immutable-draft',subject:'RE: Controlled message',changeKey:'c1',isDraft:true,toRecipients:[{emailAddress:{address:'fixture@example.invalid'}}],...options.body.message};messages.set(row.id,row);return row;
      }
      if(operation==='/me/messages/immutable-draft/send'){
        sendCount++;const row=messages.get('immutable-draft');row.isDraft=false;row.sentDateTime='2026-01-02T12:00:00Z';
        if(loseSend){loseSend=false;throw Error('Lost acknowledgement');}return {};
      }
      if(operation==='/me/messages/immutable-draft')return messages.get('immutable-draft');
      if(operation==='/me/calendarView')return {value:[...events.values()]};
      if(operation==='/me/events'&&options.method==='POST'){eventCount++;const row={...options.body,id:'immutable-event'};events.set(row.id,row);return row;}
      if(operation==='/me/events/immutable-event')return events.get('immutable-event');
      throw Object.assign(Error('Fixture route unavailable'),{status:404});
    }
  };
}

test('Outlook project-scoped drafts, denied send, lost acknowledgement and older restore produce one external change',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'faber-outlook-'));
  const ledger=await ledgerModule.openActionLedger({directory:path.join(directory,'ledger'),namespace:'a'.repeat(64)});
  const auth=service(),runtime={request:async(method,args)=>method==='state.get'?{projects:[{id:'project'},{id:'second'}]}:args};
  let app=await createOutlook({dataDir:path.join(directory,'profile'),runtime,host:{actionLedger:ledger},auth});
  t.after(async()=>{await app.close();await ledger.close();await fs.rm(directory,{recursive:true,force:true});});
  await app.request('outlook.configure',config);await app.request('outlook.poll',{projectId:'project'});
  const backup=path.join(directory,'old');await fs.cp(path.join(directory,'profile'),backup,{recursive:true});
  let allowed=false,asked=0;
  const call=(name,args,projectId='project')=>{
    const tool=app.tools.find(t=>t.name===name);
    return tool.execute(args,{project:{id:projectId},chat:{},signal:new AbortController().signal,approve:async(_p,summary,force)=>{assert.equal(force,true);assert.ok(summary);asked++;if(!allowed)throw Error('Denied');}});
  };
  assert.equal(app.tools.find(t=>t.name==='outlook_inbox').availableFor('second'),false);
  await assert.rejects(call('outlook_inbox',{},'second'),/not been enabled/);
  assert.equal((await call('outlook_inbox',{})).messages[0].id,'source');
  await call('outlook_classify',{messageId:'source',category:'needs-reply',reason:'Requested a draft'});
  const args={messageId:'source',text:'Controlled draft'},draft=await call('outlook_draft_reply',args);
  await assert.rejects(call('outlook_send_draft',{draftActionId:draft.id}),/Denied/);
  assert.equal(auth.sendCount,0);allowed=true;
  await assert.rejects(call('outlook_send_draft',{draftActionId:draft.id}),/outcome needs review/);
  assert.equal((await call('outlook_send_draft',{draftActionId:draft.id})).status,'confirmed');
  const recordedSend=ledger.snapshot().entries.find(row=>row.tool==='outlook_send');
  assert.equal(recordedSend.type,'reconciled');assert.equal(recordedSend.receipt.externalId,draft.externalId);
  assert.equal(auth.sendCount,1);assert.equal(asked,2);
  const proposal={requestKey:'meeting',subject:'Trial event',start:'2026-01-05T12:00:00-05:00',end:'2026-01-05T12:15:00-05:00'};
  const event=await call('outlook_propose_event',proposal);
  await call('outlook_create_event',{proposalId:event.id});assert.equal(auth.eventCount,1);
  assert.equal((await call('outlook_calendar',{start:proposal.start,end:proposal.end})).events[0].start.dateTime,'2026-01-05T17:00:00.000');
  await app.close();app=await createOutlook({dataDir:backup,runtime,host:{actionLedger:ledger},auth});
  const recovered=await call('outlook_draft_reply',args);
  await assert.rejects(call('outlook_draft_reply',{...args,text:'Different draft'}),/different inputs/);
  await call('outlook_send_draft',{draftActionId:recovered.id});
  const recoveredEvent=await call('outlook_propose_event',proposal);await call('outlook_create_event',{proposalId:recoveredEvent.id});
  assert.equal(auth.sendCount,1);assert.equal(auth.eventCount,1);
  const scope=app.routineScope('project',['outlook_draft_reply','outlook_send_draft']);assert.deepEqual(scope.actions,['outlook_draft_reply']);
  await app.request('outlook.disconnect',{projectId:'project'});await assert.rejects(call('outlook_inbox',{}),/not been enabled/);
});

test('closing the account while Microsoft issues a device code invalidates the pending sign-in',async()=>{
  let entered,release;
  const waiting=new Promise(resolve=>{entered=resolve;}),response=new Promise(resolve=>{release=resolve;});
  const auth=outlookAuth({host:{setSecret:async()=>{},getSecret:async()=>''},fetcher:async()=>{entered();await response;return Response.json({verification_uri:'https://microsoft.com/devicelogin',device_code:'fixture',user_code:'fixture'});}});
  const record={...config,id:randomUUID()},begin=auth.begin(record);
  await waiting;auth.close();release();
  await assert.rejects(begin,/abort/i);await assert.rejects(auth.poll(record),/Start Outlook sign-in again/);
});

test('the Outlook settings action creates a real account-bound draft routine with no file access',async t=>{
  const {createRuntime}=await import('../core/runtime.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'faber-outlook-routine-')),projectPath=path.join(root,'project');
  await fs.mkdir(projectPath);let app;
  const host={routineResourceScope:(projectId,names)=>app?.routineScope(projectId,names)};
  const runtime=await createRuntime({dataDir:path.join(root,'data'),sourceDir:projectPath,host});
  app=await createOutlook({dataDir:path.join(root,'data'),runtime,host,auth:service()});runtime.registerTools(app.tools);
  t.after(async()=>{await app.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const project=await runtime.request('project.create',{name:'Controlled mail',path:projectPath});
  await app.request('outlook.configure',{...config,projectId:project.id});await app.request('outlook.poll',{projectId:project.id});
  const provider=(await runtime.request('state.get')).providers[0];
  const routine=await app.request('outlook.triageRoutine',{projectId:project.id,providerId:provider.id,model:provider.model});
  assert.equal(routine.enabled,false);assert.deepEqual(routine.definition.paths,[]);assert.deepEqual(routine.definition.grants,[]);
  assert.equal(routine.definition.resourceScope.accountId,'test-account');assert.ok(!routine.definition.tools.includes('outlook_send_draft'));
  const {connection,resourceScope,...fields}=routine.definition;
  await assert.rejects(runtime.request('routines.save',{...fields,grants:['files']}),/approved path/);
});

test('token refresh cannot restore a credential after disconnection and external sign-in URLs are refused',async()=>{
  const values=new Map();let entered,release;
  const started=new Promise(r=>{entered=r;}),proceed=new Promise(r=>{release=r;});
  const record={...config,id:randomUUID()},host={getSecret:async key=>values.get(key),setSecret:async(key,value)=>{values.set(key,value);}};
  await host.setSecret('outlook:'+record.id,JSON.stringify({access:'fixture',refresh:'fixture',expires:0}));
  const auth=outlookAuth({host,fetcher:async(url,options)=>{
    if(url.endsWith('/devicecode'))return Response.json({verification_uri:'https://untrusted.invalid',device_code:'fixture',user_code:'fixture'});
    entered();await proceed;return Response.json({access_token:randomUUID(),refresh_token:randomUUID(),token_type:'Bearer',expires_in:3600});
  }});
  assert.ok(!outlookScopes({...caps,send:false}).includes('Mail.Send'));
  const operation=auth.api(record,'/me');await started;await auth.disconnect(record.id);release();
  await assert.rejects(operation);assert.equal(await auth.connected(record.id),false);
  await assert.rejects(auth.begin(record),/Invalid Microsoft sign-in/);auth.close();
});

async function pagedGraph(t,{count=125}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'faber-outlook-pages-')),values=new Map(),requests=[],links=[],projects=[{id:'project'},{id:'other'}],access=randomUUID(),tokens=new Map();let time=Date.now(),accountId='paged-account',nextOverride,failNext,holdNext;
  const messages=Array.from({length:count},(_,i)=>({id:'message-'+i,subject:'Controlled unread '+i,isRead:false,receivedDateTime:i===count-1?'1901-01-01T00:00:00Z':'2026-01-02T12:00:00Z',bodyPreview:'Untrusted fixture text'}));
  const host={getSecret:async key=>values.get(key)||'',setSecret:async(key,value)=>{values.set(key,value);}},auth=outlookAuth({host,now:()=>time,fetcher:async(url,options)=>{
    requests.push(url);assert.equal(new URL(url).origin,'https://graph.microsoft.com');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+access);assert.match(options.headers.Prefer,/ImmutableId/);
    const u=new URL(url);assert.equal(u.pathname,'/v1.0/me/mailFolders/inbox/messages');
    if(u.searchParams.get('$filter')==='isRead eq false'&&u.searchParams.has('$orderby'))return Response.json({error:{code:'InefficientFilter'}},{status:400});
    const cursor=u.searchParams.get('$skiptoken'),offset=cursor?tokens.get(cursor):0,limit=Number(u.searchParams.get('$top'));
    if(cursor&&holdNext){const gate=holdNext;holdNext=undefined;gate.enter();await gate.wait;}
    if(cursor&&failNext){const status=failNext;failNext=undefined;return Response.json({error:{code:'ControlledFailure'}},{status});}
    if(offset===undefined)return Response.json({error:{code:'InvalidSkipToken'}},{status:410});
    const response={value:messages.slice(offset,offset+limit)};
    if(offset+limit<messages.length){const next=new URL(url),token='opaque+'+(offset+limit)+'/=';tokens.set(token,offset+limit);next.searchParams.set('$skiptoken',token);response['@odata.nextLink']=nextOverride??next.href;links.push(response['@odata.nextLink']);}
    return Response.json(response);
  }}),runtime={request:async(method,args)=>method==='state.get'?{projects}:args};
  const app=await createOutlook({dataDir:path.join(root,'profile'),runtime,host,auth:{...auth,poll:async()=>({accountId,accountName:'Controlled account'})},clock:()=>time});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  async function link(projectId='project'){await app.request('outlook.configure',{...config,projectId});const connection=(await app.request('outlook.state')).connections.find(row=>row.projectId===projectId);await host.setSecret('outlook:'+connection.id,JSON.stringify({access,expires:time+3600000}));await app.request('outlook.poll',{projectId});}
  await link();
  const call=(args={},projectId='project',signal=new AbortController().signal)=>app.tools.find(tool=>tool.name==='outlook_inbox').execute(args,{project:{id:projectId},signal});
  return {app,call,link,requests,links,projects,messages,setNext(value){nextOverride=value;},fail(status){failNext=status;},advance(ms){time+=ms;},account(value){accountId=value;},hold(){let enter,release;const entered=new Promise(resolve=>enter=resolve),wait=new Promise(resolve=>release=resolve);holdNext={enter,wait};return{entered,release};}};
}

test('real Graph auth adapter pages beyond fifty unread messages without date cutoffs or invalid filter/order and retries return the same page',async t=>{
  const f=await pagedGraph(t),first=await f.call({limit:50,unread:true});assert.equal(first.messages.length,50);assert.equal(first.page,1);assert.equal(first.hasMore,true);assert.match(first.nextCursor,/^[a-f0-9-]{36}$/);assert.ok(!JSON.stringify(first).includes('https://graph.microsoft.com'));
  const query=new URL(f.requests[0]);assert.equal(query.searchParams.get('$filter'),'isRead eq false');assert.equal(query.searchParams.has('$orderby'),false);assert.ok(!query.searchParams.get('$filter').includes('receivedDateTime'));
  f.fail(503);await assert.rejects(f.call({cursor:first.nextCursor}),/503/);const second=await f.call({cursor:first.nextCursor});assert.equal(second.page,2);assert.equal(second.messages[0].id,'message-50');const before=f.requests.length;assert.deepEqual(await f.call({cursor:first.nextCursor}),second);assert.equal(f.requests.length,before,'successful cursor retry reuses cached page and child cursor');
  const last=await f.call({cursor:second.nextCursor});assert.equal(last.messages.length,25);assert.equal(last.hasMore,false);assert.equal(last.nextCursor,null);assert.equal(last.truncated,false);assert.equal(last.messages.at(-1).received,'1901-01-01T00:00:00Z');assert.equal(new Set([...first.messages,...second.messages,...last.messages].map(row=>row.id)).size,125);
  assert.ok(f.requests[1].includes('%2B')&&f.requests[1].includes('%2F'),'Graph opaque paging bytes retained');assert.equal(f.requests[1],f.links[0],'entire Graph-issued continuation is reused verbatim');assert.equal(f.requests[1],f.requests[2],'failed GET retries the unchanged Graph continuation');
  await assert.rejects(f.call({cursor:first.nextCursor,unread:false}),/original limit and unread filter/);await assert.rejects(f.call({cursor:first.nextCursor,limit:20}),/original limit and unread filter/);
});

test('inbox cursors cannot authenticate attacker URLs or another pinned Graph route',async t=>{
  const f=await pagedGraph(t);
  for(const value of ['https://attacker.invalid/v1.0/me/mailFolders/inbox/messages?$skip=50','https://graph.microsoft.com.attacker.invalid/v1.0/me/mailFolders/inbox/messages?$skip=50','https://graph.microsoft.com@attacker.invalid/v1.0/me/mailFolders/inbox/messages?$skip=50','https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$skip=50','https://graph.microsoft.com/v1.0/me/messages?$skip=50','https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/../sentitems?$skip=50','https://graph.microsoft.com:443/v1.0/me/mailFolders/inbox/messages?$skip=50']){f.setNext(value);const before=f.requests.length;await assert.rejects(f.call({unread:true,limit:50}),/invalid inbox continuation/);assert.equal(f.requests.length,before+1,'only initial pinned inbox request was authenticated');}
  const before=f.requests.length;await assert.rejects(f.call({cursor:'https://graph.microsoft.com/v1.0/me/messages'}),/cursor/);assert.equal(f.requests.length,before);
  f.setNext('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=1000&$skip=50');await assert.rejects(f.call({unread:true,limit:50}),/bounded inbox query/);
});

test('page tokens bind project/account/revision, fail closed after revocation or expiry, and restart clearly after Graph token rejection',async t=>{
  const f=await pagedGraph(t),first=await f.call({unread:true,limit:50});await f.link('other');let before=f.requests.length;await assert.rejects(f.call({cursor:first.nextCursor},'other'),/unavailable for this project\/account/);assert.equal(f.requests.length,before);
  f.projects[0].archived=true;await assert.rejects(f.call({cursor:first.nextCursor}),/project is no longer active/);assert.equal(f.requests.length,before);f.projects[0].archived=false;
  f.fail(410);await assert.rejects(f.call({cursor:first.nextCursor}),/Restart without cursor/);before=f.requests.length;await assert.rejects(f.call({cursor:first.nextCursor}),/Restart without cursor/);assert.equal(f.requests.length,before);
  const restart=await f.call({unread:true});f.advance(16*60000);before=f.requests.length;await assert.rejects(f.call({cursor:restart.nextCursor}),/Restart without cursor/);assert.equal(f.requests.length,before);
  const fresh=await f.call({unread:true});f.account('changed-account');await f.app.request('outlook.poll',{projectId:'project'});before=f.requests.length;await assert.rejects(f.call({cursor:fresh.nextCursor}),/unavailable for this project\/account/);assert.equal(f.requests.length,before);
  const revoked=await f.call({unread:true});await f.app.request('outlook.disconnect',{projectId:'project'});before=f.requests.length;await assert.rejects(f.call({cursor:revoked.nextCursor}),/not been enabled/);assert.equal(f.requests.length,before);
});

test('revoking a project while the next Graph page is in flight withholds page data and continuation',async t=>{
  const f=await pagedGraph(t),first=await f.call({unread:true}),gate=f.hold(),next=f.call({cursor:first.nextCursor});await gate.entered;f.projects[0].archived=true;gate.release();await assert.rejects(next,/project is no longer active/);f.projects[0].archived=false;
  const second=await f.call({cursor:first.nextCursor});assert.equal(second.page,2,'read-only failure did not consume the continuation');
  const another=await f.call({unread:true}),held=f.hold(),pending=f.call({cursor:another.nextCursor});await held.entered;await f.app.request('outlook.disconnect',{projectId:'project'});held.release();await assert.rejects(pending,/revoked|abort/i);
});

test('paging storage and page count are bounded and completion never hides an unread remainder',async t=>{
  const f=await pagedGraph(t,{count:5001});let page=await f.call({unread:true,limit:50});for(let i=1;i<100;i++)page=await f.call({cursor:page.nextCursor});assert.equal(page.page,100);assert.equal(page.hasMore,true);assert.equal(page.truncated,true);assert.equal(page.nextCursor,null);assert.match(page.reason,/unprocessed remainder/);assert.equal(f.requests.length,100);
  const oldest=await f.call({unread:true});for(let i=0;i<130;i++)await f.call({unread:true});const before=f.requests.length;await assert.rejects(f.call({cursor:oldest.nextCursor}),/Restart without cursor/);assert.equal(f.requests.length,before,'evicted cursor never silently restarts at page one');
});
