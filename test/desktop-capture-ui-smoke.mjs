import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {BrowserWindow,desktopCapturer,dialog} from 'electron';
import {generateRouteSecret,deriveRouteId} from '../desktop/remote-relay.mjs';
import {createRelayServer} from '../relay/server.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check,label){for(let i=0;i<300;i++){const result=await check();if(result)return result;await pause(50);}throw new Error('Capture UI timeout: '+label);}

export async function runCaptureUI({window,runtime,liveShare,remote,dataDir,host}){
  const target=new BrowserWindow({width:320,height:200,show:false,frame:false,webPreferences:{sandbox:true}});
  await target.loadURL('data:text/html,<title>Faber capture fixture</title><body style="margin:0;background:rgb(215,45,60)">');
  target.showInactive();window.showInactive();
  const sourceId=target.getMediaSourceId(),sources=desktopCapturer.getSources,confirm=dialog.showMessageBox,remoteRequest=remote.request,permission=liveShare.capturePermission;
  const permissionChecks=[];
  const js=code=>window.webContents.executeJavaScript(code,true).catch(error=>{throw Error('Capture UI expression failed: '+code,{cause:error});});
  const button=text=>`[...document.querySelectorAll('button')].find(b=>!b.hidden&&b.textContent===${JSON.stringify(text)})`;
  const click=async text=>{await waitFor(()=>js(`!!${button(text)}`),text);await js(`${button(text)}.click()`);};
  let relay,consents=0,allowed=false,frameReads=0;
  try {
    desktopCapturer.getSources=async options=>(await sources.call(desktopCapturer,{...options,types:['window'],thumbnailSize:{width:0,height:0}})).filter(item=>item.id===sourceId);
    liveShare.capturePermission=(kind,consume)=>{const grant=permission(kind,consume);permissionChecks.push([kind,Boolean(consume),Boolean(grant)]);return grant;};
    dialog.showMessageBox=async(_window,options)=>{assert.equal(options.defaultId,0);assert.match(options.message,/Faber capture fixture/i);consents++;return {response:allowed?1:0};};
    const nonce=generateRouteSecret(),routeId=deriveRouteId(nonce);relay=createRelayServer({allowedRouteIds:[routeId]});const {port}=await relay.start();
    await host.setSecret('remote-relay-registration-v1',nonce);
    await remote.request('remote.configure',{allowConnections:true,relayUrl:'ws://127.0.0.1:'+port,deviceName:'Fixture host'});
    await waitFor(async()=>(await remote.request('remote.status')).hosting.state==='online','fixture host registration');
    const {invite}=await remote.request('remote.invite');
    await remote.request('remote.pair',{invite,deviceName:'Fixture controller'});
    const pending=await waitFor(async()=>(await remote.request('remote.status')).pending[0],'host approval');
    await remote.request('remote.approve',{id:pending.id,allow:true});
    const connection=await waitFor(async()=>(await remote.request('remote.status')).devices.find(d=>d.role==='host'&&d.online),'paired controller');
    await remote.request('remote.request',{deviceId:connection.id,method:'workspace.ping',params:{}});
    remote.request=async(method,params={},options={})=>{
      if(method==='remote.request'&&params.method==='capture.read')frameReads++;
      return remoteRequest.call(remote,method,params,options);
    };
    const projectPath=path.join(dataDir,'capture-project');await fs.mkdir(projectPath);
    const project=await runtime.request('project.create',{name:'Capture fixture',path:projectPath}),chat=await runtime.request('chat.create',{projectId:project.id});
    runtime.emit({type:'remote',state:await remote.request('remote.status')});
    await waitFor(()=>js("document.documentElement.dataset.uiReady==='true'"),'renderer');
    await js("window.captureEvents=[];window.faber.subscribe(e=>{if(e.type==='capture')window.captureEvents.push([e.state.phase,e.state.reason]);});true");
    await click('Share video');
    await waitFor(()=>js("!!document.querySelector('.capture-dialog[open] select')"),'source menu');
    await js(`(()=>{const [s,v]=document.querySelectorAll('.capture-dialog[open] select');s.value=[...s.options].find(o=>/Faber capture fixture/i.test(o.textContent)).value;v.value=${JSON.stringify(pending.id)};})()`);
    await click('Review share');
    await waitFor(()=>js("document.querySelector('.capture-dialog[open]').innerText.includes('not authorized')"),'explicit denial');
    assert.equal((await liveShare.request('capture.state')).phase,'off');allowed=true;
    await click('Review share');
    await waitFor(()=>js(`!!${button('Start sharing')}`),'start button');
    const point=await js(`(()=>{const r=${button('Start sharing')}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    const input=window.webContents.debugger;
    input.attach('1.3');
    try{for(const type of ['mousePressed','mouseReleased'])await input.sendCommand('Input.dispatchMouseEvent',{...point,type,button:'left',clickCount:1});}finally{input.detach();}
    await waitFor(()=>js("!document.querySelector('.capture-indicator').hidden"),'live indicator');
    assert.equal(await js("document.querySelector('video.capture-preview').srcObject.getAudioTracks().length"),0);
    await click('Return to chat');
    const remoteChat=`#remote-projects [data-remote-device-id="${connection.id}"][data-remote-chat-id="${chat.id}"]`;
    await waitFor(()=>js(`!!document.querySelector(${JSON.stringify(remoteChat)})`),'paired chat');
    await js(`document.querySelector(${JSON.stringify(remoteChat)}).click()`);
    await waitFor(()=>js("!document.querySelector('#remote-watch-live').hidden&&!document.querySelector('#remote-watch-live').disabled"),'paired watch control');
    await click('Watch live');
    const pixel=`(()=>{const image=document.querySelector('dialog[open] img.capture-preview');if(!image?.naturalWidth)return [];const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(image,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];})()`;
    await waitFor(async()=>{const [r,g]=await js(pixel);return r>145&&g<110;},'remote red frame');
    await target.webContents.executeJavaScript("document.body.style.background='rgb(32,112,220)'");
    await waitFor(async()=>{const [r,,b]=await js(pixel);return b>150&&r<100;},'remote blue frame');
    await click('Stop watching');
    await waitFor(async()=>(await liveShare.request('capture.state')).phase==='off','host revoked by viewer stop');
    await waitFor(()=>js("document.querySelector('.capture-indicator').hidden&&!document.querySelector('video.capture-preview')?.srcObject"),'camera indicator and tracks released');
    assert.equal(consents,2);assert.ok(frameReads>=2);
    return {passed:true,consents,frameReads,source:'owned Windows fixture',controller:'encrypted loopback',nativeDialog:'intercepted',automaticResume:false};
  }catch(error){
    const display=await js("document.querySelector('.capture-dialog[open]')?.innerText||document.querySelector('.capture-indicator')?.innerText");
    throw new Error(error.message+' · '+display+' · '+JSON.stringify({state:await liveShare.request('capture.state'),consents,permissionChecks,events:await js('window.captureEvents')}),{cause:error});
  }finally{
    desktopCapturer.getSources=sources;dialog.showMessageBox=confirm;remote.request=remoteRequest;liveShare.capturePermission=permission;liveShare.stop();
    target.destroy();await remote.request('remote.configure',{allowConnections:false});await relay?.close();
  }
}
