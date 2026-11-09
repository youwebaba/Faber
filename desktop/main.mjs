import {app,BrowserWindow,dialog,ipcMain,protocol,safeStorage,shell,session,Menu,WebContentsView,powerMonitor,powerSaveBlocker,clipboard,nativeImage} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRuntime} from '../core/runtime.mjs';
import {containedPath,fileTools} from '../tools/files.mjs';
import {shellTool} from '../tools/process.mjs';
import {nativeAction,nativeTools} from './native.mjs';
import {extensionTools} from './extensions.mjs';
import {createAddons,addonTools} from './addons.mjs';
import {createUpgrades,upgradeTools} from './upgrades.mjs';
import {createVoice} from './voice.mjs';
import {atomicWrite} from './recovery.mjs';
import {createModelHub} from '../model-hub/index.mjs';
import {huggingFacePage} from './huggingface-page.mjs';
import {validateRequestPayload} from './request-payload.mjs';
import {createLocalModels} from '../local-models/index.mjs';
import {createUIReload} from './ui-reload.mjs';
import {packagedRuntime} from './packaged-paths.mjs';
import {getProfileDirectory,createProfiles,assertProfileSwitchAllowed} from './profile-path.cjs';
import {validate} from '../core/registry.mjs';
import {createRemoteService,remoteMethods} from './remote-service.mjs';
import {createGateway} from './gateway.mjs';
import {createChatGPT} from './chatgpt.mjs';
import {externalWebUrl,releaseLabel} from '../core/bug-report.mjs';
import {imageTools} from '../tools/images.mjs';
import {mediaTools} from '../tools/media.mjs';
import {createLocalMusic} from '../local-music/index.mjs';
import {createChatMedia,mediaMethods} from './chat-media.mjs';
import {createBrowserManager,browserMethods} from './browser.mjs';

const bootstrap=globalThis.__FABER_BOOTSTRAP__;
const sourceDir=bootstrap?.sourceDir||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const smokeModels=process.argv.includes('--smoke-models');
const smokeFeatures=process.argv.includes('--smoke-features');
const smokeLocalModels=process.argv.includes('--smoke-local-models');
const smokeUIReload=process.argv.includes('--smoke-ui-reload');
const smokeB11=process.argv.includes('--smoke-b11');
const smokeB12=process.argv.includes('--smoke-b12');
const smokeB201=process.argv.includes('--smoke-b201');
const smokeThinking=process.argv.includes('--smoke-thinking');
const smokeBrowser=process.argv.includes('--smoke-browser');
const smokeMedia=process.argv.includes('--smoke-media');
const smokeInstalled=process.argv.includes('--smoke-installed');
const smokeFaber=process.argv.includes('--smoke-faber');
const smokePackage=process.argv.includes('--smoke-package');
const smoke=process.argv.includes('--smoke')||process.argv.includes('--smoke-live')||smokeModels||smokeFeatures||smokeLocalModels||smokeUIReload||smokePackage||smokeFaber||smokeInstalled||smokeB11||smokeB12||smokeB201||smokeThinking||smokeBrowser||smokeMedia;
const dataDir=bootstrap?.dataDir||(smoke?await fs.mkdtemp(path.join(os.tmpdir(),'Faber-smoke-')):getProfileDirectory(process.env.LOCALAPPDATA??app.getPath('appData')));
const profiles=bootstrap?.profiles||createProfiles(smoke?path.join(dataDir,'profile-registry'):process.env.LOCALAPPDATA??app.getPath('appData'),smoke?{defaultDirectory:dataDir}:{});
const recoveryStatus={safeMode:bootstrap?.safeMode===true,reason:bootstrap?.recoveryReason||''};
await fs.mkdir(dataDir,{recursive:true});
app.setPath('userData',dataDir);
app.setPath('sessionData',dataDir);
if(!bootstrap?.hasLock&&!app.requestSingleInstanceLock()){app.quit();process.exit(0);}
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
if(!bootstrap)protocol.registerSchemesAsPrivileged([{scheme:'faber',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
const modelMethods=new Set(['models.state','models.search','models.inspect','models.download','models.cancel','models.settings.save','models.chooseDirectory','models.openDirectory','models.openPage']);
const localMethods=new Set(['localModels.list','localModels.start','localModels.stop','localModels.details','localModels.hardware','localModels.configure','localModels.delete']);
const addonMethods=new Set(['addons.list','addons.import','addons.enable','addons.disable','addons.uninstall','addons.reset','addons.rollback','addons.openDirectory']);
const uiMethods=new Set(['app.reloadUI','app.uiState','app.uiStateAck']);
const chatGPTMethods=new Set(['chatgpt.status','chatgpt.signIn','chatgpt.cancel','chatgpt.signOut','chatgpt.select','chatgpt.models','chatgpt.usage']);
const gatewayMethods=new Set(['gateway.status','gateway.configure','gateway.start','gateway.stop','gateway.rotateToken']);
const profileMethods=new Set(['profiles.list','profiles.create','profiles.rename','profiles.switch']);
const methods=new Set(['state.get','project.create','project.update','chat.create','chat.update','chat.send','chat.steer','chat.compact','chat.stop','chat.archive','chat.controls','chat.forceStop','chat.delete','chat.move','project.archive','project.delete','provider.save','provider.test','approval.resolve','tool.run','settings.update','promptPresets.save','promptPresets.delete','promptPresets.reset','app.bugReportDraft','app.reportIssue','app.openLink','extensions.reload','voice.start','voice.stop','voice.speak','voice.status','app.openPath','app.restart','app.recoveryStatus','app.restartNormal','app.uiReady',...modelMethods,...localMethods,...uiMethods,...addonMethods,...chatGPTMethods,...gatewayMethods,...remoteMethods,...profileMethods,...browserMethods,...mediaMethods]);
let browserViewRequest=0,browserStartupError,browserChromeFocus,browser,browserParking,browserChats=[],window,runtime,media,music,voice,extensions,modelHub,localModels,uiReload,chatgpt,gateway,remote,remoteStartupError,upgrades,chatGPTStartupError,featureFixture,reloadFixture,bootTimer,uiReady=false,startupFailed=false,quitting=false,shutdownComplete=false,switchingProfile=false,voiceBusy=false,voiceOperations=0,lastZoom;
const emit=event=>{if(window&&!window.isDestroyed())window.webContents.send('faber:event',event);};
async function confirm(message){if(smokeFaber||smokeInstalled)return true;const result=await dialog.showMessageBox(window,{type:'warning',title:'Faber — explicit approval',message,buttons:['Cancel','Approve'],defaultId:0,cancelId:0,noLink:true});return result.response===1;}
const secretFile=path.join(dataDir,'secrets.json');
let secretQueue=Promise.resolve();
async function secrets(){try{return JSON.parse(await fs.readFile(secretFile,'utf8'));}catch(error){if(error.code==='ENOENT')return {};throw error;}}
const host={
  privatePaths:profiles.privatePaths,
  async getSecret(id){const values=await secrets();if(!values[id])return '';if(!safeStorage.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable');return safeStorage.decryptString(Buffer.from(values[id],'base64'));},
  setSecret(id,value){const result=secretQueue.catch(()=>{}).then(async()=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Cannot save API key: Windows credential encryption is unavailable');if(typeof id!=='string'||!id||['__proto__','constructor','prototype'].includes(id))throw new Error('Invalid secret ID');const values=await secrets();if(value)values[id]=safeStorage.encryptString(value).toString('base64');else delete values[id];await atomicWrite(secretFile,JSON.stringify(values));});secretQueue=result;return result;},
  async chooseDirectory(){const result=await dialog.showOpenDialog(window,{properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0];},
  async chooseAddon(kind){if(smokeFaber)return path.join(dataDir,'faber-smoke-addon.faber-addon.json');if(!['file','folder'].includes(kind))throw new Error('Choose an add-on file or folder');const result=await dialog.showOpenDialog(window,{title:'Import Faber add-on',properties:[kind==='folder'?'openDirectory':'openFile'],...(kind==='file'?{filters:[{name:'Faber add-on package',extensions:['faber-addon.json','json']}]}:{})});return result.canceled?null:result.filePaths[0];},
  async trashItem(target){if(!smokeFaber)return shell.trashItem(target);const fixtureRoot=path.join(path.dirname(dataDir),`${path.basename(dataDir)}-models`);if(path.dirname(target)!==fixtureRoot)throw new Error('Smoke recycle outside fixture');const bin=path.join(dataDir,'fixture-recycle');await fs.mkdir(bin,{recursive:true});await fs.rename(target,path.join(bin,path.basename(target)));},
  async openPath(target){if(typeof target!=='string'||!path.isAbsolute(target)||target.includes('\0'))throw new Error('Choose an absolute local path');await fs.stat(target);const error=await shell.openPath(target);if(error)throw new Error(error);return {opened:true};},
  async openExternal(url){await shell.openExternal(huggingFacePage(url));return {opened:true};},
  async openIssue(value){const url=new URL(value);if(url.origin!=='https://github.com'||url.pathname!=='/youwebaba/Faber/issues/new'||url.username||url.password||url.hash)throw new Error('Invalid Faber issue URL');await shell.openExternal(url.href);return {opened:true};},
  async openWebLink(value){await shell.openExternal(externalWebUrl(value));return {opened:true};},
  getChatGPTToken:(providerId,signal)=>{if(!chatgpt)throw new Error('ChatGPT account connection is unavailable');return chatgpt.accessToken(providerId,signal);},
  chatGPTModels:accountId=>{if(!chatgpt)throw new Error('ChatGPT account connection is unavailable');return chatgpt.request('chatgpt.models',{accountId,refresh:true});},
  desktop:nativeAction,
  async voice(action,args,signal){
    const guarded=action==='start'||action==='speak';
    if(guarded&&uiReload?.pending)throw new Error('Wait for the UI handoff to finish before starting voice.');
    if(guarded)voiceOperations++;
    try{return await voice.action(action,args,signal);}finally{if(guarded)voiceOperations--;}
  },
  providerControls:(providerId,model)=>providerId.startsWith('chatgpt:')?chatgpt?.controls(providerId,model):localModels?.providerControls(providerId,model),
  modelDisplayName:(providerId,model)=>providerId.startsWith('chatgpt:')?chatgpt?.status().accounts.find(account=>account.providerId===providerId)?.models.find(item=>item.id===model)?.name:localModels?.modelDisplayName(providerId,model),
  isAutomaticTool:(tool,permission)=>browser?.isAutomaticTool(tool,permission)===true||extensions?.isAutomaticTool(tool,permission)===true,
  assertProviderAvailable:(providerId,model,options)=>{if(providerId.startsWith('chatgpt:')){if(!chatgpt)throw new Error('ChatGPT account connection is unavailable');return chatgpt.assertAvailable(providerId,model,options);}return localModels?.assertProviderAvailable(providerId,model,options);},
  reloadExtensions:()=>extensions.reload(),
  backupCore:signal=>upgrades.backupCore('shell',signal),
  async restart(){if(!await confirm('Restart Faber? Running chats will stop.'))return {restarting:false};app.relaunch();app.quit();return {restarting:true};}
};
app.on('window-all-closed',()=>app.quit());
async function shutdown(){
  clearTimeout(bootTimer);voice?.close();media?.close();const failures=[];
  try{await remote?.close();}catch(error){failures.push(error);}
  try{await gateway?.close();}catch(error){failures.push(error);}
  const results=await Promise.allSettled([browser?.close(),music?.close(),modelHub?.close(),runtime?.close(),chatgpt?.close(),secretQueue]);
  for(const result of results)if(result.status==='rejected')failures.push(result.reason);
  try{await extensions?.close();}catch(error){failures.push(error);}
  try{await localModels?.close();}catch(error){failures.push(error);}
  try{await upgrades?.close();}catch(error){failures.push(error);}
  await featureFixture?.close();await reloadFixture?.close();if(browserParking&&!browserParking.isDestroyed())browserParking.destroy();
  for(const error of failures)console.error('Shutdown failed:',error);return failures.length===0;
}
async function startupFailure(error){if(startupFailed)return;startupFailed=true;clearTimeout(bootTimer);console.error(error);await shutdown();if(bootstrap?.onFailure)await bootstrap.onFailure(error);else app.exit(1);}
app.on('before-quit',event=>{
  if(shutdownComplete)return;
  // Closing the main window and the last browser window can both request quit during cleanup.
  event.preventDefault();
  if(quitting)return;
  quitting=true;
  void shutdown().then(clean=>bootstrap?.onShutdown?.(clean)).catch(error=>console.error('Shutdown failed:',error)).finally(()=>{shutdownComplete=true;app.quit();});
});
void app.whenReady().then(async()=>{
const reloadSmoke=smokeUIReload?await import('../test/desktop-ui-reload-smoke.mjs'):null;
if(reloadSmoke)reloadFixture=await reloadSmoke.createUIReloadSmoke(dataDir,sourceDir);
const allowAppFullscreen=(contents,permission,details)=>permission==='fullscreen'&&contents===window?.webContents&&details?.isMainFrame===true&&details.requestingUrl==='faber://app/index.html';
session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(allowAppFullscreen(contents,permission,details)));
session.defaultSession.setPermissionCheckHandler((contents,permission,_origin,details)=>allowAppFullscreen(contents,permission,details));
session.defaultSession.on('will-download',event=>event.preventDefault());
protocol.handle('faber',async request=>{
  try{
    const url=new URL(request.url);if(url.pathname.startsWith('/media/'))return media?media.protocol(request):new Response('Unavailable',{status:404});
    if(url.hostname!=='app'||request.method!=='GET')return new Response('Forbidden',{status:403});
    const relative=decodeURIComponent(url.pathname).replace(/^\//,'')||'index.html';
    const target=await containedPath(path.join(reloadFixture?.sourceDir||sourceDir,'renderer'),relative);
    const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[path.extname(target)]??'application/octet-stream';
    return new Response(await fs.readFile(target),{headers:{'Content-Type':mime,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",'X-Content-Type-Options':'nosniff'}});
  }catch{return new Response('Not found',{status:404});}
});
runtime=await createRuntime({dataDir,sourceDir,host});
media=createChatMedia({readMedia:runtime.readMedia,readImage:params=>runtime.remoteRequest('chat.image',params),remoteRequest:(deviceId,method,params,signal)=>{if(!remote)throw new Error('Remote connections unavailable');return remote.request('remote.request',{deviceId,method,params},{signal});},protectedPaths:[dataDir,...profiles.privatePaths],
  chooseSave:async({name,mimeType})=>{browser?.hideView();const result=await dialog.showSaveDialog(window,{title:'Save chat '+(mimeType.startsWith('image/')?'image':mimeType.startsWith('audio/')?'audio':'video'),defaultPath:name,filters:[{name:'Media file',extensions:[path.extname(name).slice(1)]}]});return result.canceled?null:result.filePath;},
  copyText:text=>clipboard.writeText(text),copyImage:data=>{const value=nativeImage.createFromDataURL(data);if(value.isEmpty())throw new Error('This image could not be copied');clipboard.writeImage(value);}
});
browserChats=(await runtime.request('state.get')).chats;
browser=createBrowserManager({dataDir,createView:options=>new WebContentsView(options),createSession:(partition,options)=>session.fromPartition(partition,options),emit:event=>runtime.emit(event),getChat:id=>browserChats.find(chat=>chat.id===id),
  readSessionCookies:key=>host.getSecret('browser-session-'+key),writeSessionCookies:(key,value)=>host.setSecret('browser-session-'+key,value),
  parkView:(view,size)=>{if(!browserParking||browserParking.isDestroyed())browserParking=new BrowserWindow({width:size.width,height:size.height,useContentSize:true,show:false,focusable:false,skipTaskbar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});browserParking.setContentSize(size.width,size.height);browserParking.contentView.addChildView(view);view.setBounds({x:0,y:0,...size});view.setVisible(true);},
  unparkView:view=>{if(browserParking&&!browserParking.isDestroyed())browserParking.contentView.removeChildView(view);},
  isMonitorAllowed:()=>!!window&&!window.isDestroyed()&&window.isVisible()&&!window.isMinimized(),
  focusChrome:()=>{if(window&&!window.isDestroyed()&&window.isFocused())window.webContents.focus();},
  isViewAllowed:()=>!!window&&!window.isDestroyed()&&window.isVisible()&&!window.isMinimized()&&window.isFocused(),
  attachView:(view,bounds)=>{const zoom=window.webContents.getZoomFactor(),size=window.getContentBounds(),x=Math.max(0,Math.round(bounds.x*zoom)),y=Math.max(0,Math.round(bounds.y*zoom));view.setBounds({x,y,width:Math.max(1,Math.min(Math.round(bounds.width*zoom),size.width-x)),height:Math.max(1,Math.min(Math.round(bounds.height*zoom),size.height-y))});window.contentView.addChildView(view);},
  detachView:view=>{if(window&&!window.isDestroyed())window.contentView.removeChildView(view);},
  chooseSave:async filename=>{browser.hideView();try{const result=await dialog.showSaveDialog(window,{title:'Save browser download',defaultPath:filename});return result.canceled?null:result.filePath;}finally{emit({type:'browserViewHidden'});}},
  chooseUpload:async multiple=>{browser.hideView();try{const result=await dialog.showOpenDialog(window,{title:'Choose files for this website',properties:['openFile',...(multiple?['multiSelections']:[])]});return result.canceled?null:result.filePaths;}finally{emit({type:'browserViewHidden'});}},
  confirmLeave:()=>{browser.hideView();try{return dialog.showMessageBoxSync(window,{type:'warning',title:'Leave this page?',message:'This page has unsaved changes. Leave anyway?',buttons:['Stay','Leave'],defaultId:0,cancelId:0,noLink:true})===1;}finally{emit({type:'browserViewHidden'});}},
  contextMenu:(_contents,params)=>Menu.buildFromTemplate([{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut',enabled:params.isEditable},{role:'copy'},{role:'paste',enabled:params.isEditable},{role:'selectAll'}]).popup({window})
});
try{await browser.initialize();}catch(error){browserStartupError='Browser unavailable; saved metadata was preserved. '+error.message;console.error(browserStartupError);}
try{chatgpt=await createChatGPT({dataDir,secureStorage:safeStorage,openExternal:url=>shell.openExternal(url),emit:event=>runtime.emit(event),syncProviders:providers=>runtime.setAccountProviders(providers),stopProvider:async providerId=>{const state=await runtime.request('state.get');for(const chatId of new Set(state.runs.filter(run=>run.providerId===providerId&&['running','waiting_approval'].includes(run.status)).map(run=>run.chatId)))await runtime.request('chat.stop',{chatId});}});}catch(error){chatGPTStartupError=error.message;const state=await runtime.request('state.get');await runtime.setAccountProviders(state.providers.filter(provider=>provider.authKind==='chatgpt').map(provider=>({...provider,connected:false})));}
if(smoke)await runtime.request('settings.update',{onboardingComplete:true});
const featureSmoke=smokeFeatures?await import('../test/desktop-features-smoke.mjs'):null;
if(featureSmoke)featureFixture=await featureSmoke.createFeatureSmoke(dataDir);
const modelSmoke=smokeModels||smokeFaber?await import('../test/desktop-models-smoke.mjs'):null;
modelHub=await createModelHub({dataDir,sourceDir,host,emit:event=>runtime.emit(event),...(reloadFixture?{fetchImpl:reloadFixture.fetchImpl}:featureFixture?{fetchImpl:featureFixture.fetchImpl}:modelSmoke?{fetchImpl:modelSmoke.createHubSmokeFetch()}: {})});
const localSmoke=smokeLocalModels||smokeUIReload||smokeFaber||smokeB12||smokeB201?await import('../test/desktop-local-models-smoke.mjs'):null;
const localFixture=localSmoke?await localSmoke.createLocalModelSmoke(dataDir,modelHub):null;
if(localFixture)localFixture.options.hardwareRunner=async(_executable,args)=>({code:0,stdout:args.includes('--help')?'--device --n-gpu-layers --threads-batch --cpu-mask-batch --cpu-strict-batch --load-mode --list-devices --ctx-size --parallel':args.includes('--list-devices')?'  CUDA0: Fixture GPU (8192 MiB, 7000 MiB free)':'Controlled fixture runtime',stderr:''});
localModels=await createLocalModels({dataDir,runtime,getHubState:()=>modelHub.request('models.state'),emit:event=>runtime.emit(event),trashItem:host.trashItem,withModelFiles:modelHub.withModelFiles,...(bootstrap?.packaged?packagedRuntime(bootstrap.resourcesPath):{}),...localFixture?.options});
music=createLocalMusic({dataDir,sourceDir,getHubState:()=>modelHub.request('models.state'),withModelFiles:modelHub.withModelFiles,...(bootstrap?.packaged?{runtimeDirectory:path.join(bootstrap.resourcesPath,'music-runtime')}:{})});
extensions=createAddons({dataDir,runtime,confirm,safeMode:recoveryStatus.safeMode,bundledSource:bootstrap?.bundledSource||path.join(sourceDir,'bundled-addons'),bundledResources:{lightpanda:bootstrap?.addonResources||path.join(sourceDir,'.runtime','lightpanda')},chooseAddon:host.chooseAddon,openPath:host.openPath,emit:event=>runtime.emit(event)});
upgrades=createUpgrades({sourceDir:reloadFixture?.sourceDir||featureFixture?.upgradeSourceDir||sourceDir,dataDir,confirm:reloadFixture?async()=>true:confirm,onApplied:({id})=>runtime.emit({type:'uiUpdate',id})});
await upgrades.expireStages().catch(error=>console.error('Expired upgrade cleanup failed:',error.message));
// Recognition errors can leave a live session; only an explicit off event clears the reload barrier.
voice=createVoice({runtime,emit:event=>{if(['starting','listening','speaking'].includes(event.status))voiceBusy=true;else if(event.status==='off')voiceBusy=false;runtime.emit(event);}});
uiReload=createUIReload({activationStatus:()=>upgrades.activationStatus(),assertAllowed:()=>{if(voiceBusy||voiceOperations)throw new Error('Stop voice before reloading the UI.');},reload:()=>window.webContents.reloadIgnoringCache(),emit:event=>runtime.emit(event)});
runtime.registerTools([...fileTools(),...imageTools(),...mediaTools(),...music.tools(),shellTool(),...nativeTools(),...extensionTools(extensions,sourceDir),...addonTools(extensions),...upgradeTools(upgrades),...modelHub.tools(),...localModels.tools(),...browser.tools()]);
let extensionStartupError;
try{await extensions.initialize();}catch(error){extensionStartupError=error.message;await runtime.replaceExtensionTools([],[]);console.error('Extension startup failed:',error.message);}
try{remote=await createRemoteService({dataDir,host,operatorDir:smoke?undefined:path.join(process.env.LOCALAPPDATA??app.getPath('appData'),'FaberRelay'),dispatch:runtime.remoteRequest,emit,powerMonitor,powerSaveBlocker,safeMode:recoveryStatus.safeMode,suspended:()=>quitting||switchingProfile});}catch(error){remoteStartupError=error.message;}
gateway=await createGateway({dataDir,runtime,host,emit:event=>runtime.emit(event)});
if(!smoke&&(await runtime.request('state.get')).projects.length===0){const project=await runtime.request('project.create',{name:'Faber',path:sourceDir});await runtime.request('chat.create',{projectId:project.id,title:'New chat'});}
function applyZoom(value){if(window&&!window.isDestroyed()&&Number.isFinite(value)&&value>=0.75&&value<=1.5&&lastZoom!==value){window.webContents.setZoomFactor(value);lastZoom=value;}}
browserChats=(await runtime.request('state.get')).chats;
runtime.subscribe(event=>{if(event.type==='state'){browserChats=event.state.chats;browser.reconcile(event.state);applyZoom(event.state.settings.uiScale);}emit(event);});
window=new BrowserWindow({width:1440,height:960,minWidth:900,minHeight:640,title:`Faber ${releaseLabel}`,icon:path.join(sourceDir,'build','faber.ico'),backgroundColor:'#101114',show:!smoke,webPreferences:{preload:path.join(sourceDir,'desktop','preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,spellcheck:false,backgroundThrottling:!smoke}});
Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'fileMenu'},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'},{type:'separator'},{label:'Settings',accelerator:'CmdOrCtrl+,',click:()=>{browser.hideView();emit({type:'openSettings'});}}]},{role:'viewMenu'},{role:'windowMenu'}]));
window.on('blur',()=>{browserViewRequest++;browser.hideView({keepMonitoring:true});});
for(const event of ['minimize','hide','resize'])window.on(event,()=>{browserViewRequest++;browser.hideView();});
window.on('closed',()=>app.quit());
window.webContents.on('did-start-navigation',()=>{browserViewRequest++;browser.hideView();media.cancel();});
window.on('focus',()=>{emit({type:'browserViewHidden'});void browser.request('browser.state').then(state=>emit({type:'browser',state})).catch(()=>{});});
window.webContents.on('blur',()=>{browserChromeFocus=null;});
window.webContents.on('before-input-event',(event,input)=>{if(!browserChromeFocus||input.type!=='keyDown'||(!input.control&&!input.meta)||input.alt)return;const key=input.key.length===1?input.key.toLowerCase():input.key;const action={l:'address',t:'newTab',w:'closeTab',f:'find',Tab:input.shift?'previousTab':'nextTab','+':'zoomIn','=':'zoomIn','-':'zoomOut','0':'zoomReset'}[key];if(action){event.preventDefault();emit({type:'browserShortcut',...browserChromeFocus,action});}});
window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
window.webContents.on('will-navigate',event=>event.preventDefault());
window.webContents.on('will-attach-webview',event=>event.preventDefault());
window.webContents.on('render-process-gone',(_event,details)=>{void startupFailure(new Error(`The interface process stopped: ${details.reason}`));});
ipcMain.handle('faber:request',async(event,method,params={})=>{
  if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!=='faber://app/index.html')throw new Error('Untrusted request frame');
  if(!methods.has(method))throw new Error('Invalid bridge request');
  validateRequestPayload(method,params);
  if((switchingProfile||quitting)&&!['state.get','profiles.list','app.recoveryStatus'].includes(method))throw new Error('Faber is restarting or switching profiles');
  if(mediaMethods.includes(method))return media.request(method,params);
  if(method==='app.uiReady'){validate(params,{type:'object',properties:{},additionalProperties:false});if(!uiReady){uiReady=true;clearTimeout(bootTimer);bootstrap?.onReady?.();}return {ready:true,...recoveryStatus};}
  if(method==='app.recoveryStatus'){validate(params,{type:'object',properties:{},additionalProperties:false});return {...recoveryStatus};}
  if(method==='app.restartNormal'){validate(params,{type:'object',properties:{},additionalProperties:false});if(!await confirm('Restart Faber normally? Addons enabled in this profile may run.'))return {restarting:false};app.relaunch({args:process.argv.slice(1).filter(value=>value!=='--safe-mode')});app.quit();return {restarting:true};}
  if(profileMethods.has(method)){
    const properties=method==='profiles.list'?{}:method==='profiles.create'?{name:{type:'string',minLength:1,maxLength:80}}:method==='profiles.rename'?{id:{type:'string',minLength:1,maxLength:36},name:{type:'string',minLength:1,maxLength:80}}:{id:{type:'string',minLength:1,maxLength:36},draftsCleared:{const:true}};
    validate(params,{type:'object',properties,required:Object.keys(properties),additionalProperties:false});
    if(method==='profiles.list')return profiles.list();
    if(method==='profiles.create')return profiles.create(params.name);
    if(method==='profiles.rename')return profiles.rename(params.id,params.name);
    profiles.directory(params.id);if(params.id===profiles.currentId)return {restarting:false,...profiles.list()};
    switchingProfile=true;
    try{
      const check=async()=>assertProfileSwitchAllowed({draftsCleared:params.draftsCleared,runs:(await runtime.request('state.get')).runs,downloads:(await modelHub.request('models.state')).downloads,voiceBusy:voiceBusy||voiceOperations>0,uiPending:uiReload.pending,updating:(await upgrades.activationStatus()).busy,gatewayActive:(await gateway.request('gateway.status')).activeRequests});
      await check();await gateway.request('gateway.stop');await check();media.cancel();profiles.select(params.id);
      app.relaunch({args:process.argv.slice(1).filter(value=>value!=='--safe-mode')});app.quit();return {restarting:true,currentId:params.id};
    }catch(error){switchingProfile=false;throw error;}
  }
  if(remoteMethods.includes(method)){if(!remote)throw new Error(remoteStartupError||'Remote connections unavailable');return remote.request(method,params);}
  if(gatewayMethods.has(method))return gateway.request(method,params);
  if(uiMethods.has(method))return uiReload.request(method,params);
  if(browserMethods.includes(method)){
    const viewRequest=method==='browser.view'?++browserViewRequest:null;
    if(method==='browser.chromeFocus'){const result=await browser.request(method,params);browserChromeFocus=params.active?{chatId:params.chatId,tabId:params.tabId}:null;return result;}
    if(method==='browser.view'&&params.visible){
      const bounds=await window.webContents.executeJavaScript(`(()=>{const slot=document.querySelector('#browser-page-slot'),chatId=document.querySelector('#browser-session')?.value,tabId=document.querySelector('[data-browser-tab][aria-selected=\"true\"]')?.dataset.browserTab;if(!slot||slot.closest('[hidden]')||document.querySelector('#modal')?.open||document.body.matches('.models-open,.browser-resizing,[aria-busy=\"true\"]')||document.body.inert||[...document.querySelectorAll('[data-browser-occludes]')].some(node=>!node.hidden&&node.getClientRects().length))return null;const r=slot.getBoundingClientRect();if(r.x<-.5||r.y<-.5||r.right>innerWidth+.5||r.bottom>innerHeight+.5||r.width<10||r.height<10)return null;for(let node=slot.parentElement;node;node=node.parentElement){const s=getComputedStyle(node);if(/auto|scroll|hidden|clip/.test(s.overflow+s.overflowX+s.overflowY)){const p=node.getBoundingClientRect();if(r.left<p.left-1||r.top<p.top-1||r.right>p.right+1||r.bottom>p.bottom+1)return null;}}return {x:r.x,y:r.y,width:r.width,height:r.height,chatId,tabId};})()`);
      if(viewRequest!==browserViewRequest)return {visible:false,superseded:true};
      if(!bounds||!bounds.tabId||bounds.chatId!==params.chatId||params.tabId&&bounds.tabId!==params.tabId||['x','y','width','height'].some(key=>!Number.isFinite(params[key])||Math.abs(params[key]-bounds[key])>2)){browser.hideView();return {visible:false};}
      params={...params,tabId:params.tabId||bounds.tabId};
    }
    return browser.request(method,params);
  }
  if(method==='voice.status')return voice.action('status');
  if(modelMethods.has(method))return modelHub.request(method,params);
  if(localMethods.has(method))return localModels.request(method,params);
  if(addonMethods.has(method))return extensions.request(method,params);
  if(chatGPTMethods.has(method)){if(!chatgpt){if(method==='chatgpt.status')return {accounts:[],activeAccountId:null,signIn:{status:'error',error:chatGPTStartupError||'ChatGPT account connection is unavailable'}};throw new Error(chatGPTStartupError||'ChatGPT account connection is unavailable');}return chatgpt.request(method,params);}
  return runtime.request(method,params);
});
bootTimer=setTimeout(()=>{if(!uiReady)void startupFailure(new Error('The interface did not finish startup within one minute.'));},60000);
await window.loadURL('faber://app/index.html');
applyZoom((await runtime.request('state.get')).settings.uiScale);
if(browserStartupError)runtime.emit({type:'error',error:browserStartupError});
if(chatGPTStartupError)runtime.emit({type:'error',error:chatGPTStartupError});
if(extensionStartupError)runtime.emit({type:'error',error:`Extensions could not load: ${extensionStartupError}`});
if(smokeInstalled){
  try{
    const deadline=Date.now()+10000;
    while(!uiReady){
      if(startupFailed||quitting)throw new Error('Installed smoke startup was interrupted.');
      if(Date.now()>=deadline)throw new Error('Installed smoke interface did not become ready within ten seconds.');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    console.log(JSON.stringify(await(await import('../test/desktop-installed-smoke.mjs')).runInstalledSmoke({runtime,modelHub,extensions,host,dataDir,sourceDir,window})));app.quit();
  }catch(error){console.error(error);await shutdown();app.exit(1);}return;
}
if(smokePackage){try{const result=await(await import('../test/desktop-packaged-smoke.mjs')).runPackagedSmoke({window,runtime,localModels,dataDir,sourceDir});console.log(JSON.stringify(result));window.close();}catch(error){console.error(error);await shutdown();app.exit(1);}return;}
if(smoke){
  try{
    const fixture=await fs.mkdtemp(path.join(path.dirname(dataDir),'Faber-smoke-workspace-'));await fs.writeFile(path.join(fixture,'hello.txt'),'Faber isolated smoke fixture\n');
    const project=await runtime.request('project.create',{name:'Smoke workspace',path:fixture});
    const chat=await runtime.request('chat.create',{projectId:project.id,title:'Desktop smoke check'});
    const result=await window.webContents.executeJavaScript(`(async()=>{const state=await window.faber.request('state.get');return {bridge:!!window.faber,projects:state.projects.length,chats:state.chats.length,nodeExposed:typeof window.require!=='undefined',text:document.body.innerText.slice(0,500)}})()`);
    if(!result.bridge||!result.projects||!result.chats||result.nodeExposed)throw new Error('Smoke bridge check failed');
    await new Promise(resolve=>setTimeout(resolve,500));
    const screenshot=path.join(dataDir,'smoke.png');await fs.writeFile(screenshot,(await window.webContents.capturePage()).toPNG());
    const flows=smokeMedia?await(await import('../test/desktop-media-smoke.mjs')).runMediaSmoke({window,runtime,dataDir,sourceDir,media,remote,host,chat}):smokeBrowser?await(await import('../test/desktop-browser-smoke.mjs')).runBrowserSmoke({window,runtime,browser,chat,dataDir,sourceDir}):smokeThinking?await(await import('../test/desktop-thinking-smoke.mjs')).runThinkingSmoke({window,runtime,chat,dataDir}):smokeB201?await(await import('../test/desktop-b201-smoke.mjs')).runB201Smoke({window,runtime,chat,dataDir}):smokeB12?await(await import('../test/desktop-b12-smoke.mjs')).runB12Smoke({window,runtime,chat,dataDir,localModels,fixture:localFixture}):smokeB11?await(await import('../test/desktop-b11-smoke.mjs')).runB11Smoke({window,runtime,chat,dataDir,host}):smokeFaber?await(await import('../test/desktop-faber-smoke.mjs')).runFaberSmoke({window,runtime,modelHub,localModels,chat,dataDir,fixture:localFixture}):smokeUIReload?await reloadSmoke.runUIReloadSmoke({window,runtime,modelHub,localModels,upgrades,uiReload,chat,dataDir,fixture:reloadFixture,localFixture}):smokeLocalModels?await localSmoke.runLocalModelSmoke({window,runtime,localModels,chat,dataDir,fixture:localFixture}):smokeFeatures?await featureSmoke.runFeatureSmoke({window,modelHub,runtime,chat,dataDir,fixture:featureFixture}):smokeModels?await modelSmoke.runModelHubSmoke({window,modelHub,runtime,chat,dataDir}):await (await import('../test/desktop-smoke.mjs')).runDesktopSmoke({window,runtime,chat,dataDir,live:process.argv.includes('--smoke-live')});
    console.log(JSON.stringify({ok:true,dataDir,screenshot,...result,...flows}));
    app.quit();
  }catch(error){console.error(error);await shutdown();app.exit(1);}
}
}).catch(startupFailure);
