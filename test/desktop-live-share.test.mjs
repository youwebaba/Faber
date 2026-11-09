import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLiveShare} from '../desktop/live-share.mjs';
import {installCapturePermissions} from '../desktop/capture-permissions.mjs';

function fixture(t){
  let time=10000,allowed=true,online=true;
  const sources=async()=>[{id:'window:8:0',name:'Fixture'}],devices=()=>[{role:'controller',id:'viewer',name:'Paired fixture',online}],events=[];
  const share=createLiveShare({sources,controllers:devices,confirm:async()=>allowed,now:()=>time,emit:e=>events.push(e)});
  t.after(()=>share.close());
  return {share,sources,events,now:n=>{time+=n;},allow:v=>{allowed=v;},offline:()=>{online=false;share.reconcile(devices());}};
}
const selection={kind:'window',source:'window:8:0',deviceId:'viewer'},ctx={device:{id:'viewer'}};
const jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]).toString('base64');
test('one host grant binds one source and viewer; disconnect, revoke and stale frames clear the share',async t=>{
  const f=fixture(t),s=f.share;
  f.allow(false);await assert.rejects(s.request('capture.prepare',selection),/not authorized/);f.allow(true);
  const grant=await s.request('capture.prepare',selection);
  await assert.rejects(s.request('capture.started',{id:grant.id}),/approved source/);
  assert.equal(s.capturePermission('camera',true),null);assert.equal(s.capturePermission('window',true).source,selection.source);assert.equal(s.capturePermission('window',true),null);
  await s.request('capture.started',{id:grant.id});const view=randomUUID();
  assert.equal(s.remoteRequest('capture.status',{},{device:{id:'other'}}).id,null);
  s.remoteRequest('capture.join',{id:grant.id,view},ctx);await s.request('capture.frame',{id:grant.id,jpeg});
  assert.equal(s.remoteRequest('capture.read',{id:grant.id,view,after:0},ctx).jpeg,jpeg);
  assert.equal(s.remoteRequest('capture.read',{id:grant.id,view,after:1},ctx).jpeg,undefined);
  assert.throws(()=>s.remoteRequest('capture.read',{id:grant.id,view,after:0},{device:{id:'other'}}),/unavailable/);
  f.now(4300);assert.equal(s.remoteRequest('capture.status',{},ctx).id,null);
  assert.throws(()=>s.remoteRequest('capture.join',{id:grant.id,view},ctx),/unavailable/);
  const next=await s.request('capture.prepare',selection);s.capturePermission('window',true);await s.request('capture.started',{id:next.id});
  s.remoteRequest('capture.join',{id:next.id,view},ctx);
  assert.throws(()=>s.remoteRequest('capture.join',{id:next.id,view:randomUUID()},ctx),/fresh host/);
  const last=await s.request('capture.prepare',selection);f.offline();await assert.rejects(s.request('capture.frame',{id:last.id,jpeg}),/ended/);
});

test('display capture grants only the approved live window to the trusted top frame and excludes audio',async t=>{
  const f=fixture(t),url='faber://app/index.html',frame={url},owner={mainFrame:frame},session={
    setPermissionRequestHandler(v){this.ask=v;},setPermissionCheckHandler(v){this.check=v;},setDisplayMediaRequestHandler(v){this.display=v;}
  };
  installCapturePermissions({session,contents:()=>owner,share:f.share,sources:f.sources,allowFullscreen:()=>false});
  const detail={isMainFrame:true,requestingUrl:url},ask=(permission,extra)=>new Promise(resolve=>session.ask(owner,permission,resolve,{...detail,...extra}));
  const request={frame,securityOrigin:'faber://app',videoRequested:true,audioRequested:false,userGesture:true},display=overrides=>new Promise(resolve=>session.display({...request,...overrides},resolve));
  assert.equal(await ask('media',{mediaTypes:['video']}),false);assert.equal(await display({}),null);
  await f.share.request('capture.prepare',selection);assert.equal(await display({audioRequested:true}),null);assert.equal(await display({userGesture:false}),null);
  assert.equal(await display({frame:{url:'faber-preview://viewer/index.html'}}),null);
  assert.equal((await display({})).video.id,selection.source);assert.equal(await display({}),null);
  await f.share.request('capture.stop');
  await f.share.request('capture.prepare',{kind:'camera',source:'default'});
  assert.equal(await ask('media',{isMainFrame:false,mediaTypes:['video']}),false);
  assert.equal(await ask('media',{mediaTypes:['video','audio']}),false);
  assert.equal(await ask('media',{mediaTypes:['video']}),true);
});
