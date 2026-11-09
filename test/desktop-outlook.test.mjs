import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOutlook} from '../desktop/outlook.mjs';
import {outlookAuth,outlookScopes} from '../desktop/outlook-auth.mjs';
import {createRuntime} from '../core/runtime.mjs';
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
