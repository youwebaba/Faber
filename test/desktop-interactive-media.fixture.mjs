import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import {once} from 'node:events';
import {chartFixture,mapFixture,diagramFixture,htmlFixture,scriptFixture,cssFixture,pixelFixture} from './fixtures/interactive-media.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function frameScript(frame,code,userGesture=false){let timer;try{return await Promise.race([frame.executeJavaScript(code,userGesture),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Sandbox fixture script timed out: '+code.slice(0,140))),4000);})]);}finally{clearTimeout(timer);}}

// Production bridge, protocols, native view and renderer controls. All files are synthetic.
export async function prepareInteractiveMedia({window,runtime,chat,project,bridge,until,save,checks,capture,interactive}){
  const js=async code=>{try{return await window.webContents.executeJavaScript(code,true);}catch(error){throw new Error('Interactive viewer fixture failed: '+code.slice(0,500)+'; '+error.message);}},files={'output.chart.json':Buffer.from(JSON.stringify(chartFixture)),'world.geojson':Buffer.from(JSON.stringify(mapFixture)),'flow.diagram.json':Buffer.from(JSON.stringify(diagramFixture)),'demo.html':htmlFixture,'demo.js':scriptFixture,'demo.css':cssFixture,'pixel.png':pixelFixture},refs=[];
  for(const [name,bytes]of Object.entries(files))await fs.writeFile(path.join(project.path,name),bytes);
  for(const name of ['output.chart.json','world.geojson','flow.diagram.json','demo.html'])refs.push((await bridge('tool.run',{chatId:chat.id,name:'media_show',args:{path:name,...(name==='demo.html'?{assets:['demo.js','demo.css','pixel.png'].map(path=>({path}))}:{})}})).media);
  const selector=(ref,scope)=>`${scope} [data-media-id="${ref.id}"]`;
  async function button(query,label){await js(`(()=>{const node=document.querySelector(${JSON.stringify(query)}),button=[...node.querySelectorAll('button')].find(node=>node.textContent===${JSON.stringify(label)});if(!button||button.disabled)throw Error('Unavailable control: '+${JSON.stringify(label)});button.click();})()`);}
  async function reveal(ref,scope){const query=selector(ref,scope);await js(`document.querySelectorAll(${JSON.stringify(scope+' details')}).forEach(node=>node.open=true);document.querySelector(${JSON.stringify(query)})?.scrollIntoView({block:'center'})`);await until(()=>js(`!!document.querySelector(${JSON.stringify(query)})`),ref.name+' visible');return query;}
  async function structured(scope,deviceId){
    for(const ref of refs.filter(row=>row.kind!=='html')){
      const query=await reveal(ref,scope);await until(()=>js(`document.querySelector(${JSON.stringify(query)})?.dataset.previewLoaded==='true'`),ref.name+' actual preview',20000);
      const src=await js(`document.querySelector(${JSON.stringify(query+' iframe')}).src`),frame=window.webContents.mainFrame.frames.find(row=>row.url===src);assert.ok(frame,ref.name+' separate frame');
      assert.equal(await frameScript(frame,`typeof faber==='undefined'&&typeof require==='undefined'&&(()=>{try{parent.document;return false}catch{return true}})()`),true);
      assert.ok(await frameScript(frame,`document.querySelectorAll('svg [role=button]').length`));
      await frameScript(frame,`(()=>{const item=document.querySelector('svg [role=button]');item.dispatchEvent(new PointerEvent('pointerenter'));item.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`);
      assert.ok(await frameScript(frame,`document.querySelector('#inspector').textContent.length>0&&document.querySelector('.selected').getAttribute('aria-pressed')==='true'`));
      if(ref.kind==='map')assert.equal(await frameScript(frame,`!!document.querySelector('#page script,svg script')`),false,'map labels stay inert');
      const old=await frameScript(frame,`document.querySelector('svg').getAttribute('viewBox')`);
      await frameScript(frame,`[...document.querySelectorAll('button')].find(button=>button.textContent==='Zoom in').click()`);
      const zoomed=await frameScript(frame,`document.querySelector('svg').getAttribute('viewBox')`);assert.notEqual(old,zoomed);
      await frameScript(frame,`(()=>{const svg=document.querySelector('svg');svg.dispatchEvent(new PointerEvent('pointerdown',{clientX:200,clientY:200,pointerId:1}));svg.dispatchEvent(new PointerEvent('pointermove',{clientX:100,clientY:150,pointerId:1}));svg.dispatchEvent(new PointerEvent('pointerup',{pointerId:1}));})()`);
      assert.notEqual(await frameScript(frame,`document.querySelector('svg').getAttribute('viewBox')`),zoomed);
      if(ref.kind==='chart'){await frameScript(frame,`document.querySelector('.legend').click()`);assert.equal(await frameScript(frame,`document.querySelector('[data-series]').getAttribute('data-hidden')`),'true');}
      await save({chatId:chat.id,mediaId:ref.id,...(deviceId?{deviceId}:{})},files[ref.name],(deviceId?'remote-':'local-')+ref.name);
    }
    checks.push(`${deviceId?'Paired TLS':'Local'} chart/GeoJSON/diagram content renders, selects and inspects labels, pans/zooms and saves unchanged sources`);
  }
  async function openHtml(scope){
    const ref=refs.at(-1),query=await reveal(ref,scope);
    await until(()=>js(`Boolean([...document.querySelector(${JSON.stringify(query)})?.querySelectorAll('button')||[]].find(button=>button.textContent==='Run demo'&&!button.disabled))`),'HTML Run available');
    const lease=await js(`(()=>{const node=document.querySelector(${JSON.stringify(query)});[...node.querySelectorAll('button')].find(button=>button.textContent==='Run demo').click();return node.dataset.previewLease;})()`);assert.ok(lease,'Run assigns a lease synchronously');
    const record=await until(()=>Promise.resolve(interactive.inspect(lease)),'native HTML lease');await until(()=>Promise.resolve(record&&['running','stopped'].includes(record.status)),'HTML open acknowledgement');if(record.status==='stopped')throw new Error('HTML stopped: '+record.issue+'; '+record.failure);
    await until(()=>record.view.webContents.mainFrame.framesInSubtree.some(frame=>frame.url===record.origin+'/index.html'),'opaque HTML frame');const frame=record.view.webContents.mainFrame.framesInSubtree.find(frame=>frame.url===record.origin+'/index.html');
    try{await until(()=>frameScript(frame,`typeof window.ticks==='number'&&document.querySelector('img').naturalWidth===1`),'approved HTML assets');}catch(error){throw new Error(error.message+'; '+await frameScript(frame,`JSON.stringify({url:location.href,body:document.body.innerText,script:typeof ticks,image:document.querySelector('img')?.naturalWidth})`));}return{ref,query,record,frame};
  }
  async function html(scope,deviceId,{denials=true}={}){
    let {ref,query,record,frame}=await openHtml(scope);let native=record.view.webContents;
    assert.equal(await frameScript(frame,`typeof window.faber==='undefined'&&typeof require==='undefined'&&typeof process==='undefined'&&origin==='null'&&(()=>{try{parent.document;return false}catch{return true}})()`),true,'opaque HTML frame has no parent DOM, Node or bridge');
    assert.notEqual(frame.osProcessId,window.webContents.mainFrame.osProcessId,'HTML process differs from privileged app renderer');
    assert.equal(await frameScript(frame,`getComputedStyle(document.body).backgroundColor`),'rgb(234, 241, 247)','declared CSS asset works');
    await frameScript(frame,`document.querySelector('#increment').click()`);assert.equal(await frameScript(frame,`window.count`),1);
    let pausedFrame,pausedSession;
    const paused=(_event,method,params,sessionId)=>{if(method==='Debugger.paused'){pausedFrame=params.callFrames[0]?.callFrameId;pausedSession=sessionId;}};native.debugger.on('message',paused);
    await button(query,'Pause');await until(()=>Promise.resolve(record.status==='paused'&&pausedFrame),'real debugger pause');
    const evaluate=async expression=>(await native.debugger.sendCommand('Debugger.evaluateOnCallFrame',{callFrameId:pausedFrame,expression,returnByValue:true},pausedSession||undefined)).result.value;
    const before=await evaluate('window.ticks');await wait(220);assert.equal(await evaluate('window.ticks'),before,'timers do not advance while paused');
    await button(query,'Resume');await until(()=>frameScript(frame,`window.ticks>${before}`),'resume advances actual demo');native.debugger.removeListener('message',paused);
    await frameScript(frame,`setTimeout(()=>{throw new Error('Synthetic demo failure')},0);true`);await until(()=>js(`document.querySelector(${JSON.stringify(query+' .media-status')})?.textContent.includes('Synthetic demo failure')`),'demo error surfaced outside sandbox');
    await js(deviceId?`document.querySelector(${JSON.stringify(query)}).dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true,cancelable:true}))`:`document.querySelector('#open-settings').click()`);await until(()=>Promise.resolve(record.status==='paused'&&!record.attached),'overlay hides and pauses native view');await js(deviceId?`document.querySelector('#content-context-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`:`document.querySelector('#close-modal').click()`);await until(()=>Promise.resolve(record.attached),'closing overlay restores paused view');await button(query,'Resume');await until(()=>Promise.resolve(record.status==='running'),'explicit resume after overlay');
    checks.push(`${deviceId?'Paired TLS':'Local'} opaque HTML process loads its declared JS/CSS/image, responds to controls and actually freezes/resumes timers`);
    if(denials){console.log('Interactive HTML: modal and error verified; testing denials');await verifyDenials({record,frame,checks});await until(()=>js(`document.querySelector(${JSON.stringify(query)}).dataset.previewStatus==='stopped'`),'denied navigation stops preview');({record,frame}=await openHtml(scope));native=record.view.webContents;}
    await save({chatId:chat.id,mediaId:ref.id,...(deviceId?{deviceId}:{})},files[ref.name],(deviceId?'remote-':'local-')+ref.name);
    for(const asset of ref.assets)await save({chatId:chat.id,mediaId:asset.media.id,...(deviceId?{deviceId}:{})},files[asset.media.name],(deviceId?'remote-':'local-')+asset.media.name);
    console.log('Interactive HTML: denials verified; testing infinite loop');const priorOrigin=record.origin;await frameScript(frame,`setTimeout(()=>{while(true){}},0);true`);await wait(80);const start=Date.now();await button(query,'Stop');await until(()=>Promise.resolve(native.isDestroyed()),'Stop destroys a looping native HTML process',2500);assert.ok(Date.now()-start<2500);
    ({record,frame}=await openHtml(scope));assert.notEqual(record.origin,priorOrigin,'Run creates fresh origin');assert.equal(await frameScript(frame,`window.count`),0,'run state is discarded');if(capture){const wasVisible=window.isVisible();if(!wasVisible)window.showInactive();try{await wait(180);await capture((deviceId?'remote':'local')+'-interactive-html');await capture((deviceId?'remote':'local')+'-interactive-html-native',record.view.webContents);}finally{if(!wasVisible)window.hide();}}const finalNative=record.view.webContents;await button(query,'Stop');await until(()=>Promise.resolve(finalNative.isDestroyed()),'final HTML disposal');
    checks.push(`${deviceId?'Paired TLS':'Local'} Stop terminates an infinite-loop process while app controls remain responsive; next Run resets state at a new origin; root and approved assets save byte-identically`);
  }
  async function run(scope,deviceId,options){await structured(scope,deviceId);await html(scope,deviceId,options);}
  return{refs,files,run,structured,html,openHtml,button};
}

async function verifyDenials({record,frame,checks}){
  const native=record.view.webContents;let requests=0,connections=0,datagrams=0;const sockets=new Set(),server=http.createServer((_request,response)=>{requests++;response.end('unapproved');});server.on('connection',socket=>{connections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});server.listen(0,'127.0.0.1');await once(server,'listening');const udp=dgram.createSocket('udp4');udp.on('message',()=>datagrams++);udp.bind(0,'127.0.0.1');await once(udp,'listening');const endpoint=`http://127.0.0.1:${server.address().port}`,stunPort=udp.address().port;
  const run=code=>frameScript(frame,code,true);
  try{
    const failures=await run(`(async()=>{const attempt=async task=>{try{await task();return 'unexpected'}catch{return 'blocked'}};return {http:await attempt(()=>fetch(${JSON.stringify(endpoint+'/fetch')})),file:await attempt(()=>fetch('file:///synthetic-unavailable.txt')),faber:await attempt(()=>fetch('faber://app/index.html')),websocket:await new Promise(resolve=>{try{const ws=new WebSocket(${JSON.stringify(endpoint.replace('http:','ws:')+'/socket')});ws.onopen=()=>{ws.close();resolve('unexpected')};ws.onerror=()=>resolve('blocked');setTimeout(()=>resolve('blocked'),500)}catch{resolve('blocked')}}),unlisted:await fetch(${JSON.stringify(record.origin+'/unlisted.js')}).then(response=>response.status,()=> 'blocked'),clipboard:await attempt(()=>navigator.clipboard.readText()),camera:await attempt(()=>navigator.mediaDevices.getUserMedia({video:true})),popup:window.open(${JSON.stringify(endpoint+'/popup')})===null};})()`);
    assert.deepEqual(failures,{http:'blocked',file:'blocked',faber:'blocked',websocket:'blocked',unlisted:404,clipboard:'blocked',camera:'blocked',popup:true});
    await run(`(()=>{try{const rtc=new RTCPeerConnection({iceServers:[{urls:${JSON.stringify('stun:127.0.0.1:'+stunPort)}},{urls:${JSON.stringify('turn:127.0.0.1:'+server.address().port+'?transport=tcp')},username:'fake-user',credential:'fake-turn-credential'}]});rtc.createDataChannel('denied');rtc.createOffer().then(offer=>rtc.setLocalDescription(offer)).catch(()=>{});window.fixtureRtc=rtc;}catch{}return true;})()`);
    await wait(800);assert.equal(datagrams,0,'WebRTC STUN sent no UDP');
    let chooser=0;const listener=(_event,method)=>{if(method==='Page.fileChooserOpened')chooser++;};record.view.webContents.debugger.on('message',listener);
    await run(`(()=>{const file=document.createElement('input');file.type='file';file.id='blocked-file';document.body.append(file);file.click();return true;})()`);await wait(150);assert.equal(await run(`document.querySelector('#blocked-file').files.length`),0);record.view.webContents.debugger.removeListener('message',listener);await run(`window.fixtureRtc?.close()`);
    // A rejected document navigation closes the native preview; the app controls survive.
    await run(`(()=>{const img=new Image();img.src=${JSON.stringify(endpoint+'/image')};document.body.append(img);const child=document.createElement('iframe');child.src=${JSON.stringify(endpoint+'/frame')};document.body.append(child);const form=document.createElement('form');form.method='POST';form.action=${JSON.stringify(endpoint+'/form')};document.body.append(form);form.submit();const link=document.createElement('a');link.href=${JSON.stringify(endpoint+'/navigate')};document.body.append(link);link.click();return true;})()`);
    await wait(500);assert.equal(record.status,'stopped','blocked navigation stops isolated preview');assert.equal(native.isDestroyed(),true);assert.equal(requests,0,'no HTTP/WebSocket request reached unapproved endpoint');assert.equal(connections,0,'no TCP connection, including TURN fallback, reached unapproved endpoint');
    checks.push('Real isolated HTML rejects HTTP/WebSocket/file/app fetches, unlisted assets, popups, child frames, forms, navigation, clipboard and camera; TCP and STUN sentinels observe zero requests; file input stays empty'+(chooser?' with native chooser interception':''));
  }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>udp.close(resolve));}
}
