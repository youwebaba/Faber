import {randomBytes} from 'node:crypto';
import {validate} from '../core/registry.mjs';
import {mediaIdSchema,mediaChunkLimit,validateMediaRef} from '../core/media.mjs';
import {mediaGraphRevision,validAssetName} from '../core/media-artifacts.mjs';

export const artifactScheme={scheme:'faber-artifact',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}};
const id={type:'string',minLength:1,maxLength:256},rect={type:'object',properties:{x:{type:'number',minimum:0,maximum:20000},y:{type:'number',minimum:0,maximum:20000},width:{type:'number',minimum:1,maximum:20000},height:{type:'number',minimum:1,maximum:20000}},required:['x','y','width','height'],additionalProperties:false};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const schemas={
  'media.preview.open':object({leaseId:mediaIdSchema,chatId:id,mediaId:mediaIdSchema,deviceId:id,bounds:rect},['leaseId','chatId','mediaId','bounds']),
  'media.preview.layout':object({leaseId:mediaIdSchema,bounds:rect,visible:{type:'boolean'}},['leaseId','visible']),
  ...Object.fromEntries(['pause','resume','stop','state'].map(action=>['media.preview.'+action,object({leaseId:mediaIdSchema})])),
};
export const interactiveMethods=Object.keys(schemas);
const forbiddenFeatures=['camera','microphone','geolocation','midi','usb','serial','hid','display-capture','clipboard-read','clipboard-write','fullscreen','payment','publickey-credentials-get','publickey-credentials-create','screen-wake-lock','speaker-selection','web-share','window-management','xr-spatial-tracking','accelerometer','gyroscope','magnetometer'];
export const artifactPermissions=forbiddenFeatures.map(feature=>feature+'=()').join(', ');
export function artifactPolicy(origin,wrapper=false){return "default-src 'none'; "+(wrapper?'':'sandbox allow-scripts; ')+"script-src "+(wrapper?"'none'":"'unsafe-inline' "+origin)+"; style-src 'unsafe-inline' "+origin+"; img-src data: blob: "+origin+"; font-src "+origin+"; media-src 'none'; connect-src "+origin+"; worker-src 'none'; object-src 'none'; frame-src "+(wrapper?origin+'/index.html':"'none'")+"; base-uri 'none'; form-action 'none'; frame-ancestors "+origin;}
export function artifactPath(url,origin){try{if(/%(?:2f|5c|2e)/i.test(url))return null;const target=new URL(url);if(target.protocol!=='faber-artifact:'||target.hostname!==origin.slice('faber-artifact://'.length)||target.port||target.username||target.password||target.search||target.hash||/%(?:2f|5c|2e)/i.test(target.pathname))return null;const name=decodeURIComponent(target.pathname.slice(1));return ['wrapper.html','index.html'].includes(name)||validAssetName(name)?name:null;}catch{return null;}}

export function createInteractivePreviews({readAttachment,getWindow,createView,sessionFor,chromiumVersion,memoryUsage=()=>[]}){
  const records=new Map();let active,closed=false,isolatedSession;
  const state=record=>record?{leaseId:record.id,status:record.status,denials:record.denials,lastIssue:record.issue||'',name:record.media?.name||'',assets:(record.media?.assets||[]).map(row=>row.name)}:{status:'stopped'};
  function deny(record,issue='An unlisted resource or privileged action was blocked.'){record.denials++;record.issue=issue;}
  function bounds(record,value){const window=getWindow();if(!window||window.isDestroyed())throw new Error('Preview window unavailable');const zoom=window.webContents.getZoomFactor(),size=window.getContentBounds(),box=Object.fromEntries(Object.entries(value).map(([key,n])=>[key,Math.round(n*zoom)]));if(box.x<0||box.y<0||box.width<1||box.height<1||box.x+box.width>size.width+1||box.y+box.height>size.height+1)throw new Error('Preview bounds must remain inside the application');record.view.setBounds(box);}
  async function command(record,method,params={},sessionId){if(record.controller.signal.aborted)throw new Error('Preview stopped');let timer,cancel;const failed=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Preview control timed out')),1500);cancel=()=>reject(new Error('Preview stopped'));record.controller.signal.addEventListener('abort',cancel,{once:true});});try{return await Promise.race([record.view.webContents.debugger.sendCommand(method,params,sessionId||undefined),failed]);}finally{clearTimeout(timer);record.controller.signal.removeEventListener('abort',cancel);}}
  async function configureTarget(record,sessionId=''){
    await command(record,'Page.enable',{},sessionId);await command(record,'Page.setInterceptFileChooserDialog',{enabled:true},sessionId);await command(record,'Debugger.enable',{},sessionId);await command(record,'Animation.enable',{},sessionId);
    if(!record.visible){await command(record,'Animation.setPlaybackRate',{playbackRate:0},sessionId);await command(record,'Debugger.pause',{},sessionId);}
    if(sessionId)await command(record,'Runtime.runIfWaitingForDebugger',{},sessionId);
  }
  async function pause(record){
    if(!record?.view||!['running','pausing','paused'].includes(record.status))return state(record);if(record.status==='paused')return state(record);record.status='pausing';record.view.webContents.setAudioMuted(true);
    try{const targets=record.targets.size?[...record.targets]:[''];for(const target of targets){await command(record,'Animation.setPlaybackRate',{playbackRate:0},target);await command(record,'Debugger.pause',{},target);}return state(record);}catch{return stop(record,'Preview control failed; the isolated process was stopped.');}
  }
  async function resume(record){
    if(!record?.view||!['paused','pausing'].includes(record.status))return state(record);try{for(const target of record.paused){await command(record,'Debugger.resume',{},target);}record.paused.clear();for(const target of record.targets.size?record.targets:[''])await command(record,'Animation.setPlaybackRate',{playbackRate:1},target);record.status='running';record.resumedAt=Date.now();return state(record);}catch{return stop(record,'Preview control failed; the isolated process was stopped.');}
  }
  function detach(record){const window=getWindow();try{if(window&&!window.isDestroyed()&&record.attached)window.contentView.removeChildView(record.view);}catch{}record.attached=false;}
  async function stop(record,issue='Preview stopped.'){
    if(!record)return{status:'stopped'};if(record.stopping)return record.stopping;
    record.stopping=(async()=>{record.controller.abort();record.status='stopped';record.issue=issue;clearInterval(record.watchdog);if(active===record)active=null;detach(record);await record.predecessor;const contents=record.view?.webContents;
      if(contents&&!contents.isDestroyed()){
        const destroyed=new Promise(resolve=>contents.once('destroyed',resolve));contents.close({waitForBeforeUnload:false});
        let timer;await Promise.race([destroyed,new Promise(resolve=>{timer=setTimeout(()=>{try{if(!contents.isDestroyed()){contents.forcefullyCrashRenderer();contents.close({waitForBeforeUnload:false});}}catch{}resolve();},500);})]);clearTimeout(timer);
      }
      try{record.session?.protocol.unhandle('faber-artifact');}catch{}for(const [event,listener]of record.sessionEvents||[])record.session.removeListener(event,listener);if(record.session){record.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(_details,callback)=>callback({cancel:true}));await record.session.clearStorageData().catch(()=>{});}return state(record);
    })();return record.stopping;
  }
  function security(record){
    const contents=record.view.webContents,ses=record.session;
    const listen=(event,listener)=>{record.sessionEvents??=[];record.sessionEvents.push([event,listener]);ses.on(event,listener);};
    ses.setPermissionCheckHandler(()=>false);ses.setPermissionRequestHandler((_contents,_permission,callback)=>{deny(record);callback(false);});ses.setDevicePermissionHandler(()=>false);ses.setDisplayMediaRequestHandler((_request,callback)=>{deny(record);callback(null);});listen('will-download',event=>{deny(record);event.preventDefault();});
    for(const [event,empty]of [['select-usb-device',''],['select-hid-device',[]],['select-serial-port','']])listen(event,(event,_details,callback)=>{event.preventDefault();deny(record);callback(empty);});
    ses.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{const allowed=artifactPath(details.url,record.origin)!==null;if(!allowed)deny(record);callback({cancel:!allowed});});
    contents.setWindowOpenHandler(()=>{deny(record,'Popups are blocked.');return{action:'deny'};});contents.setAudioMuted(true);contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.on('content-bounds-updated',event=>{event.preventDefault();deny(record,'The demo cannot move or resize the application window.');});
    contents.on('select-bluetooth-device',(event,_devices,callback)=>{event.preventDefault();deny(record);callback('');});contents.on('will-attach-webview',event=>event.preventDefault());
    contents.on('will-navigate',event=>{if(event.url!==record.origin+'/wrapper.html'){event.preventDefault();deny(record,'Navigation is blocked.');}});
    contents.on('will-frame-navigate',event=>{if(event.isMainFrame?event.url!==record.origin+'/wrapper.html':event.url!==record.origin+'/index.html'){event.preventDefault();deny(record,'Navigation and child frames are blocked.');}});
    contents.on('did-start-navigation',event=>{if(record.status==='loading'&&event.url==='about:blank')return;if(event.isMainFrame?event.url!==record.origin+'/wrapper.html':event.url!==record.origin+'/index.html'){deny(record,'Navigation and child frames are blocked.');void stop(record,'A blocked document navigation stopped this preview.');}});
    contents.on('console-message',event=>{if(/Content Security Policy|Permissions Policy|Connection-Allowlist|Blocked|not allowed|denied/i.test(event.message||''))deny(record);else if(event.level==='error'||event.level>=2)record.issue='Demo error: '+String(event.message).slice(0,300);});
    contents.on('render-process-gone',()=>{if(!record.controller.signal.aborted)void stop(record,'The isolated preview process stopped.');});
    contents.on('destroyed',()=>{if(!record.controller.signal.aborted)void stop(record,'Preview closed.');});
    contents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.key==='Escape'){event.preventDefault();void stop(record);getWindow()?.webContents.focus();}});
    contents.debugger.on('message',(_event,method,params,sessionId)=>{
      if(method==='Target.attachedToTarget'){if(params.targetInfo.type==='iframe')record.targets.add(params.sessionId);void configureTarget(record,params.sessionId).catch(()=>{if(!record.controller.signal.aborted)void stop(record,'Preview isolation could not be initialized.');});}
      if(method==='Target.detachedFromTarget'){record.targets.delete(params.sessionId);record.paused.delete(params.sessionId);}
      if(method==='Debugger.paused'){record.paused.add(sessionId||'');record.status='paused';}
      if(method==='Debugger.resumed'){record.paused.delete(sessionId||'');if(!record.paused.size&&record.status!=='stopped')record.status='running';}
      if(method==='Page.fileChooserOpened'){deny(record,'Local file selection is blocked.');if(params.backendNodeId)void command(record,'DOM.setFileInputFiles',{files:[],backendNodeId:params.backendNodeId},sessionId).catch(()=>{});}
    });
  }
  async function protocol(record,request){
    const name=artifactPath(request.url,record.origin),headers={'Content-Security-Policy':artifactPolicy(record.origin,name==='wrapper.html'),'Connection-Allowlist':'(response-origin)','Permissions-Policy':artifactPermissions,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Access-Control-Allow-Origin':'null','Cross-Origin-Resource-Policy':'cross-origin'};
    if(record.controller.signal.aborted||!name||!['GET','HEAD'].includes(request.method)){deny(record);return new Response('Forbidden',{status:403,headers});}
    if(name==='wrapper.html'){const body=`<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow="${forbiddenFeatures.map(feature=>feature+" 'none'").join('; ')}" title="Isolated HTML demo"></iframe></body></html>`;return new Response(request.method==='HEAD'?null:body,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});}
    const ref=name==='index.html'?record.media:record.media.assets.find(row=>row.name===name)?.media;
    if(!ref){deny(record,'Unlisted artifact asset blocked.');return new Response('Unlisted asset',{status:404,headers});}
    try{
      const transfer=new AbortController(),signal=AbortSignal.any([record.controller.signal,request.signal,transfer.signal]),owner=record.owner;let offset=0;
      const current=await readAttachment(owner,ref.id,0,0,signal);if(JSON.stringify(current.media)!==JSON.stringify(ref))throw new Error('Artifact member changed');
      const stream=new ReadableStream({async pull(controller){try{signal.throwIfAborted();if(offset>=ref.bytes){controller.close();return;}const result=await readAttachment(owner,ref.id,offset,Math.min(mediaChunkLimit,ref.bytes-offset),signal);if(JSON.stringify(result.media)!==JSON.stringify(ref))throw new Error('Artifact member changed');offset+=result.bytes.length;controller.enqueue(result.bytes);if(offset===ref.bytes)controller.close();}catch(error){if(!signal.aborted)deny(record,'A saved asset is no longer available or authorized.');controller.error(error);}},cancel(){transfer.abort();}},{highWaterMark:0});
      return new Response(request.method==='HEAD'?null:stream,{headers:{...headers,'Content-Type':ref.mimeType+(ref.mimeType.startsWith('text/')?'; charset=utf-8':''),'Content-Length':String(ref.bytes)}});
    }catch{deny(record,'A saved asset is no longer available or authorized.');return new Response('Artifact unavailable',{status:404,headers});}
  }
  async function open(params){
    if(Number.parseInt(chromiumVersion,10)<152)throw new Error('Interactive HTML requires the bundled Chromium connection allowlist support');
    if(records.has(params.leaseId)){const prior=records.get(params.leaseId);if(JSON.stringify(prior.owner)!==JSON.stringify({chatId:params.chatId,...(params.deviceId?{deviceId:params.deviceId}:{})})||prior.mediaId!==params.mediaId)throw new Error('Preview lease belongs to another artifact');return state(prior);}
    const previous=active,record={id:params.leaseId,owner:{chatId:params.chatId,...(params.deviceId?{deviceId:params.deviceId}:{})},mediaId:params.mediaId,origin:'faber-artifact://'+randomBytes(32).toString('hex'),controller:new AbortController(),status:'loading',visible:true,denials:0,targets:new Set(),paused:new Set()};records.set(record.id,record);active=record;record.predecessor=previous?stop(previous):Promise.resolve();
    while(records.size>24){const oldest=[...records].find(([,value])=>value!==active&&value.status==='stopped');if(!oldest)break;records.delete(oldest[0]);}
    try{
      await record.predecessor;record.controller.signal.throwIfAborted();
      const result=await readAttachment(record.owner,record.mediaId,0,0,record.controller.signal);record.media=validateMediaRef(result.media);if(record.media.kind!=='html'||!record.media.assets||record.media.graphRevision!==mediaGraphRevision(record.media))throw new Error('Invalid artifact graph');record.controller.signal.throwIfAborted();
      isolatedSession??=sessionFor('faber-artifacts-'+randomBytes(32).toString('hex'));record.session=isolatedSession;record.session.protocol.handle('faber-artifact',request=>protocol(record,request));record.view=createView({session:record.session,sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,webgl:false,plugins:false,devTools:false,spellcheck:false,backgroundThrottling:false});security(record);
      await record.view.webContents.loadURL(record.origin+'/wrapper.html');record.controller.signal.throwIfAborted();record.view.webContents.debugger.attach('1.3');await configureTarget(record);await command(record,'Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});record.controller.signal.throwIfAborted();
      bounds(record,params.bounds);if(record.visible){getWindow().contentView.addChildView(record.view);record.attached=true;}record.view.setVisible(record.visible);record.status='running';record.resumedAt=Date.now();
      record.watchdog=setInterval(()=>{if(record.controller.signal.aborted)return;const pids=new Set(record.view.webContents.mainFrame.framesInSubtree.map(frame=>frame.osProcessId)),large=memoryUsage().some(item=>pids.has(item.pid)&&item.memory?.workingSetSize>256*1024);if(large)void stop(record,'Preview exceeded its 256 MiB process memory budget.');else if(record.status==='running'&&Date.now()-record.resumedAt>60000)void pause(record).catch(()=>stop(record));},500);record.watchdog.unref?.();
      await record.view.webContents.executeJavaScript('document.querySelector("iframe").src='+JSON.stringify(record.origin+'/index.html'));record.controller.signal.throwIfAborted();return state(record);
    }catch(error){record.failure=error.message;if(!record.controller.signal.aborted)await stop(record,'Could not load this isolated artifact. Save original to inspect it.');return state(record);}
  }
  return{
    async request(method,params={}){if(!schemas[method])throw new Error('Unknown interactive preview method');validate(params,schemas[method]);if(closed)throw new Error('Interactive previews closed');if(method==='media.preview.open')return open(params);const record=records.get(params.leaseId);if(method==='media.preview.state')return state(record);if(!record)return{status:'stopped'};if(method==='media.preview.stop')return stop(record);if(method==='media.preview.pause')return pause(record);if(method==='media.preview.resume')return resume(record);if(method==='media.preview.layout'){record.visible=params.visible;if(record.view&&!record.controller.signal.aborted){if(params.visible){if(!params.bounds)throw new Error('Preview bounds required');bounds(record,params.bounds);if(!record.attached){getWindow().contentView.addChildView(record.view);record.attached=true;}record.view.setVisible(true);}else{record.view.setVisible(false);detach(record);await pause(record);}}}return state(record);},
    async release(owner){if(active&&active.owner.chatId===owner.chatId&&active.owner.deviceId===owner.deviceId)await stop(active);},
    async hide(){if(active){active.visible=false;if(active.view){active.view.setVisible(false);detach(active);await pause(active);}}},
    async stopAll(){if(active)await stop(active);},
    inspect(leaseId){return records.get(leaseId);},
    async dispose(){closed=true;await Promise.all([...records.values()].map(record=>stop(record)));records.clear();},
  };
}
