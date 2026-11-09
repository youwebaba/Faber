// Run with Electron. The only selectable desktop source is a window created by this test.
const {app,BrowserWindow,desktopCapturer,protocol,session}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const camera=process.argv.includes('--fixture-camera');
if(camera)app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const root=require('node:fs').mkdtempSync(path.join(os.tmpdir(),'faber-live-media-'));
app.setPath('userData',root);
protocol.registerSchemesAsPrivileged([{scheme:'faber',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let target,host,share,phase='startup';const timer=setTimeout(()=>{console.error('Capture fixture timed out during '+phase);app.exit(1);},50000);
app.whenReady().then(async()=>{
  const {createLiveShare}=await import('../desktop/live-share.mjs'),{installCapturePermissions}=await import('../desktop/capture-permissions.mjs');
  protocol.handle('faber',({url})=>new Response(url.endsWith('/fixture')?'<body style="background:rgb(212,45,62);margin:0"></body>':'<body><video muted autoplay></video><canvas></canvas></body>',{headers:{'Content-Type':'text/html'}}));
  target=new BrowserWindow({width:340,height:240,show:false,frame:false,webPreferences:{sandbox:true}});
  await target.loadURL('faber://app/fixture');target.showInactive();
  host=new BrowserWindow({width:360,height:260,x:0,y:0,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});await host.loadURL('faber://app/index.html');host.showInactive();
  const id=target.getMediaSourceId(),sources=async()=>(await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0}})).filter(row=>row.id===id);
  const controller={role:'controller',id:'fixture-controller',name:'Fixture controller',online:true};
  let nativeConsents=0;
  share=createLiveShare({sources,controllers:async()=>[controller],confirm:async()=>{nativeConsents++;return true;},emit:()=>{}});
  installCapturePermissions({session:session.defaultSession,share,contents:()=>host.webContents,sources,allowFullscreen:()=>false});
  phase='source discovery and grant';const grant=await share.request('capture.prepare',{kind:camera?'camera':'window',source:camera?'default':id,deviceId:controller.id});
  const js=(code,gesture=false)=>host.webContents.executeJavaScript(code,gesture);
  const source=camera?'navigator.mediaDevices.getUserMedia({video:true,audio:false})':'navigator.mediaDevices.getDisplayMedia({video:true,audio:false})';
  phase='first capture and playback';const tracks=await js(`(async()=>{window.fixtureStream=await ${source};document.querySelector('video').srcObject=fixtureStream;await document.querySelector('video').play();return fixtureStream.getTracks().map(t=>t.kind)})()`,true);
  assert.deepEqual(tracks,['video']);await share.request('capture.started',{id:grant.id});
  const {createRemoteHost,createRemoteController,generateRemoteIdentity}=await import('../desktop/remote-transport.mjs');
  const {createRelayServer}=await import('../relay/server.mjs');
  const {createRelayHostAdapter,connectRelayController,generateRouteSecret,deriveRouteId}=await import('../desktop/remote-relay.mjs');
  const vault=()=>{const values=new Map();return {getSecret:async k=>values.get(k)||'',setSecret:async(k,v)=>values.set(k,v)};};
  phase='encrypted pairing';const registrationSecret=generateRouteSecret(),routeId=deriveRouteId(registrationSecret);
  const relay=createRelayServer({allowedRouteIds:[routeId]});const {port}=await relay.start();
  const route={relayUrl:'ws://127.0.0.1:'+port,routeId,hostName:'Capture fixture'},options={allowLocalRelay:true};
  const receiver=await createRemoteHost({host:vault(),...options,createIdentity:generateRemoteIdentity,dispatch:(m,p,c)=>{assert.equal(m,'workspace.rpc');return share.remoteRequest(p.method,p.params,c);}});
  const bound=await receiver.start();const adapter=await createRelayHostAdapter({...route,...options,registrationSecret,targetPort:bound.port});
  const sender=await createRemoteController({host:vault(),...options,dial:(r,opts)=>connectRelayController(r,{...options,...opts})});
  try{
    const pending=await sender.pair({...await receiver.createInvitation(route),deviceName:'Fixture controller'});await receiver.acceptPairing(pending.id);const connection=(await sender.completePairing()).connection;
    // The test grant uses a fixed fixture identity. Re-authorize the actual paired ID before transferring.
    controller.id=pending.id;await share.request('capture.stop');
    const actual=await share.request('capture.prepare',{kind:camera?'camera':'window',source:camera?'default':id,deviceId:controller.id});
    await js('fixtureStream.getTracks().forEach(track=>track.stop())');
    phase='fresh paired grant and playback';assert.deepEqual(await js(`(async()=>{window.fixtureStream=await ${source};document.querySelector('video').srcObject=fixtureStream;await document.querySelector('video').play();return fixtureStream.getTracks().map(t=>t.kind)})()`,true),['video']);
    await share.request('capture.started',{id:actual.id});
    const view={id:actual.id,view:randomUUID()};
    const rpc=(method,params)=>sender.request(connection.id,'workspace.rpc',{method,params});
    // The encrypted host transport receives an RPC envelope, like createRemoteService.
    const capture=async()=>{
      const result=await js(`(()=>{const v=document.querySelector('video'),c=document.querySelector('canvas');c.width=240;c.height=160;const ctx=c.getContext('2d');ctx.drawImage(v,0,0,240,160);return {jpeg:c.toDataURL('image/jpeg',.65),pixel:Array.from(ctx.getImageData(120,80,1,1).data).slice(0,3)};})()`);
      await share.request('capture.frame',{id:actual.id,jpeg:result.jpeg});return result;
    };
    phase='paired frame transfer';await rpc('capture.join',view);const first=await capture(),frame=await rpc('capture.read',{...view,after:0});assert.equal(frame.jpeg,first.jpeg);
    if(!camera){assert.ok(first.pixel[0]>135&&first.pixel[1]<125,'Captured the actual red fixture window');await target.webContents.executeJavaScript("document.body.style.background='rgb(32,112,220)'");}
    let next,second;
    for(let i=0;i<8;i++){await new Promise(r=>setTimeout(r,240));next=await capture();second=await rpc('capture.read',{...view,after:frame.sequence});if(camera||next.pixel[2]>150&&next.pixel[0]<125)break;}
    assert.ok(second.sequence>frame.sequence);assert.equal(second.jpeg,next.jpeg);
    if(!camera)assert.ok(next.pixel[2]>150&&next.pixel[0]<125,'Live window pixels changed to blue');
    await rpc('capture.leave',view);await assert.rejects(rpc('capture.read',{...view,after:0}));await js('fixtureStream.getTracks().forEach(track=>track.stop())');
    console.log(JSON.stringify({passed:true,source:camera?'Chromium synthetic camera':'owned Windows window',frames:2,encryptedRelay:true,freshHostConsent:nativeConsents,originalWindowColorChecked:!camera}));
  }finally{phase='transport shutdown';await sender.dispose();await receiver.dispose();await adapter.close();await relay.close();}
}).then(()=>{clearTimeout(timer);share?.close();target?.destroy();host?.destroy();app.exit(0);},e=>{console.error(e);clearTimeout(timer);app.exit(1);});
