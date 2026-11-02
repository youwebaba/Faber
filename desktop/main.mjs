import {app,BrowserWindow,dialog,ipcMain,protocol,safeStorage,shell,session} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRuntime} from '../core/runtime.mjs';
import {containedPath,fileTools} from '../tools/files.mjs';
import {shellTool} from '../tools/process.mjs';
import {nativeAction,nativeTools} from './native.mjs';
import {createExtensions,extensionTools} from './extensions.mjs';
import {createUpgrades,upgradeTools} from './upgrades.mjs';
import {createVoice} from './voice.mjs';
import {atomicWrite} from './recovery.mjs';
import {createModelHub} from '../model-hub/index.mjs';
import {huggingFacePage} from './huggingface-page.mjs';
import {validateRequestPayload} from './request-payload.mjs';
import {createLocalModels} from '../local-models/index.mjs';
import {createUIReload} from './ui-reload.mjs';

const sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const smokeModels=process.argv.includes('--smoke-models');
const smokeFeatures=process.argv.includes('--smoke-features');
const smokeLocalModels=process.argv.includes('--smoke-local-models');
const smokeUIReload=process.argv.includes('--smoke-ui-reload');
const smoke=process.argv.includes('--smoke')||process.argv.includes('--smoke-live')||smokeModels||smokeFeatures||smokeLocalModels||smokeUIReload;
const dataDir=smoke?await fs.mkdtemp(path.join(os.tmpdir(),'SophiaHarness-smoke-')):path.join(process.env.LOCALAPPDATA??app.getPath('appData'),'SophiaHarness');
await fs.mkdir(dataDir,{recursive:true});
app.setPath('userData',dataDir);
if(!app.requestSingleInstanceLock()){app.quit();process.exit(0);}
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
protocol.registerSchemesAsPrivileged([{scheme:'sophia',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const modelMethods=new Set(['models.state','models.search','models.inspect','models.download','models.cancel','models.settings.save','models.chooseDirectory','models.openDirectory','models.openPage']);
const localMethods=new Set(['localModels.list','localModels.start','localModels.stop']);
const uiMethods=new Set(['app.reloadUI','app.uiState','app.uiStateAck']);
const methods=new Set(['state.get','project.create','project.update','chat.create','chat.update','chat.send','chat.stop','chat.archive','provider.save','provider.test','approval.resolve','tool.run','settings.update','extensions.reload','voice.start','voice.stop','voice.speak','voice.status','app.openPath','app.restart',...modelMethods,...localMethods,...uiMethods]);
let window,runtime,voice,extensions,modelHub,localModels,uiReload,featureFixture,reloadFixture,quitting=false,voiceBusy=false,voiceOperations=0;
const emit=event=>{if(window&&!window.isDestroyed())window.webContents.send('sophia:event',event);};
async function confirm(message){const result=await dialog.showMessageBox(window,{type:'warning',title:'Sophia Harness — explicit approval',message,buttons:['Cancel','Approve'],defaultId:0,cancelId:0,noLink:true});return result.response===1;}
const secretFile=path.join(dataDir,'secrets.json');
let secretQueue=Promise.resolve();
async function secrets(){try{return JSON.parse(await fs.readFile(secretFile,'utf8'));}catch(error){if(error.code==='ENOENT')return {};throw error;}}
const host={
  async getSecret(id){const values=await secrets();if(!values[id])return '';if(!safeStorage.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable');return safeStorage.decryptString(Buffer.from(values[id],'base64'));},
  setSecret(id,value){const result=secretQueue.catch(()=>{}).then(async()=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Cannot save API key: Windows credential encryption is unavailable');if(typeof id!=='string'||!id||['__proto__','constructor','prototype'].includes(id))throw new Error('Invalid secret ID');const values=await secrets();if(value)values[id]=safeStorage.encryptString(value).toString('base64');else delete values[id];await atomicWrite(secretFile,JSON.stringify(values));});secretQueue=result;return result;},
  async chooseDirectory(){const result=await dialog.showOpenDialog(window,{properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0];},
  async openPath(target){if(typeof target!=='string'||!path.isAbsolute(target)||target.includes('\0'))throw new Error('Choose an absolute local path');await fs.stat(target);const error=await shell.openPath(target);if(error)throw new Error(error);return {opened:true};},
  async openExternal(url){await shell.openExternal(huggingFacePage(url));return {opened:true};},
  desktop:nativeAction,
  async voice(action,args,signal){
    const guarded=action==='start'||action==='speak';
    if(guarded&&uiReload?.pending)throw new Error('Wait for the UI handoff to finish before starting voice.');
    if(guarded)voiceOperations++;
    try{return await voice.action(action,args,signal);}finally{if(guarded)voiceOperations--;}
  },
  assertProviderAvailable:(providerId,model)=>localModels?.assertProviderAvailable(providerId,model),
  reloadExtensions:()=>extensions.reload(),
  async restart(){if(!await confirm('Restart Sophia Harness? Running chats will stop.'))return {restarting:false};app.relaunch();app.quit();return {restarting:true};}
};
app.on('window-all-closed',()=>app.quit());
async function shutdown(){voice?.close();const results=await Promise.allSettled([modelHub?.close(),runtime?.close(),secretQueue]);try{await localModels?.close();}catch(error){console.error('Local model shutdown failed:',error);}await featureFixture?.close();await reloadFixture?.close();for(const result of results)if(result.status==='rejected')console.error('Shutdown failed:',result.reason);}
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;shutdown().finally(()=>app.quit());});
void app.whenReady().then(async()=>{
const reloadSmoke=smokeUIReload?await import('../test/desktop-ui-reload-smoke.mjs'):null;
if(reloadSmoke)reloadFixture=await reloadSmoke.createUIReloadSmoke(dataDir,sourceDir);
session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
session.defaultSession.setPermissionCheckHandler(()=>false);
session.defaultSession.on('will-download',event=>event.preventDefault());
protocol.handle('sophia',async request=>{
  try{
    const url=new URL(request.url);if(url.hostname!=='app'||request.method!=='GET')return new Response('Forbidden',{status:403});
    const relative=decodeURIComponent(url.pathname).replace(/^\//,'')||'index.html';
    const target=await containedPath(path.join(reloadFixture?.sourceDir||sourceDir,'renderer'),relative);
    const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[path.extname(target)]??'application/octet-stream';
    return new Response(await fs.readFile(target),{headers:{'Content-Type':mime,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",'X-Content-Type-Options':'nosniff'}});
  }catch{return new Response('Not found',{status:404});}
});
runtime=await createRuntime({dataDir,sourceDir,host});
const featureSmoke=smokeFeatures?await import('../test/desktop-features-smoke.mjs'):null;
if(featureSmoke)featureFixture=await featureSmoke.createFeatureSmoke(dataDir);
const modelSmoke=smokeModels?await import('../test/desktop-models-smoke.mjs'):null;
modelHub=await createModelHub({dataDir,sourceDir,host,emit:event=>runtime.emit(event),...(reloadFixture?{fetchImpl:reloadFixture.fetchImpl}:featureFixture?{fetchImpl:featureFixture.fetchImpl}:modelSmoke?{fetchImpl:modelSmoke.createHubSmokeFetch()}: {})});
const localSmoke=smokeLocalModels||smokeUIReload?await import('../test/desktop-local-models-smoke.mjs'):null;
const localFixture=localSmoke?await localSmoke.createLocalModelSmoke(dataDir,modelHub):null;
localModels=await createLocalModels({dataDir,runtime,getHubState:()=>modelHub.request('models.state'),emit:event=>runtime.emit(event),...localFixture?.options});
extensions=createExtensions({dataDir,runtime,confirm});
const upgrades=createUpgrades({sourceDir:reloadFixture?.sourceDir||featureFixture?.upgradeSourceDir||sourceDir,dataDir,confirm:reloadFixture?async()=>true:confirm,onApplied:({id})=>runtime.emit({type:'uiUpdate',id})});
// Recognition errors can leave a live session; only an explicit off event clears the reload barrier.
voice=createVoice({runtime,emit:event=>{if(['starting','listening','speaking'].includes(event.status))voiceBusy=true;else if(event.status==='off')voiceBusy=false;runtime.emit(event);}});
uiReload=createUIReload({activationStatus:()=>upgrades.activationStatus(),assertAllowed:()=>{if(voiceBusy||voiceOperations)throw new Error('Stop voice before reloading the UI.');},reload:()=>window.webContents.reloadIgnoringCache(),emit:event=>runtime.emit(event)});
runtime.registerTools([...fileTools(),shellTool(),...nativeTools(),...extensionTools(extensions,sourceDir),...upgradeTools(upgrades),...modelHub.tools(),...localModels.tools()]);
let extensionStartupError;
try{await extensions.initialize();}catch(error){extensionStartupError=error.message;await runtime.replaceExtensionTools([],[]);console.error('Extension startup failed:',error.message);}
if(!smoke&&(await runtime.request('state.get')).projects.length===0){const project=await runtime.request('project.create',{name:'Sophia Harness',path:sourceDir});await runtime.request('chat.create',{projectId:project.id,title:'New chat'});}
runtime.subscribe(emit);
window=new BrowserWindow({width:1440,height:960,minWidth:900,minHeight:640,title:'Sophia Harness',backgroundColor:'#101114',show:!smoke,webPreferences:{preload:path.join(sourceDir,'desktop','preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,spellcheck:false,backgroundThrottling:!smoke}});
window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
window.webContents.on('will-navigate',event=>event.preventDefault());
window.webContents.on('will-attach-webview',event=>event.preventDefault());
ipcMain.handle('sophia:request',async(event,method,params={})=>{
  if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!=='sophia://app/index.html')throw new Error('Untrusted request frame');
  if(!methods.has(method))throw new Error('Invalid bridge request');
  validateRequestPayload(method,params);
  if(uiMethods.has(method))return uiReload.request(method,params);
  if(method==='voice.status')return voice.action('status');
  if(modelMethods.has(method))return modelHub.request(method,params);
  if(localMethods.has(method))return localModels.request(method,params);
  return runtime.request(method,params);
});
await window.loadURL('sophia://app/index.html');
if(extensionStartupError)runtime.emit({type:'error',error:`Extensions could not load: ${extensionStartupError}`});
if(smoke){
  try{
    const fixture=path.join(dataDir,'fixture');await fs.mkdir(fixture);await fs.writeFile(path.join(fixture,'hello.txt'),'Sophia Harness isolated smoke fixture\n');
    const project=await runtime.request('project.create',{name:'Smoke workspace',path:fixture});
    const chat=await runtime.request('chat.create',{projectId:project.id,title:'Desktop smoke check'});
    const result=await window.webContents.executeJavaScript(`(async()=>{const state=await window.sophia.request('state.get');return {bridge:!!window.sophia,projects:state.projects.length,chats:state.chats.length,nodeExposed:typeof window.require!=='undefined',text:document.body.innerText.slice(0,500)}})()`);
    if(!result.bridge||!result.projects||!result.chats||result.nodeExposed)throw new Error('Smoke bridge check failed');
    await new Promise(resolve=>setTimeout(resolve,500));
    const screenshot=path.join(dataDir,'smoke.png');await fs.writeFile(screenshot,(await window.webContents.capturePage()).toPNG());
    const flows=smokeUIReload?await reloadSmoke.runUIReloadSmoke({window,runtime,modelHub,localModels,upgrades,uiReload,chat,dataDir,fixture:reloadFixture,localFixture}):smokeLocalModels?await localSmoke.runLocalModelSmoke({window,runtime,localModels,chat,dataDir,fixture:localFixture}):smokeFeatures?await featureSmoke.runFeatureSmoke({window,modelHub,runtime,chat,dataDir,fixture:featureFixture}):smokeModels?await modelSmoke.runModelHubSmoke({window,modelHub,runtime,chat,dataDir}):await (await import('../test/desktop-smoke.mjs')).runDesktopSmoke({window,runtime,chat,dataDir,live:process.argv.includes('--smoke-live')});
    console.log(JSON.stringify({ok:true,dataDir,screenshot,...result,...flows}));
    app.quit();
  }catch(error){console.error(error);await shutdown();app.exit(1);}
}
}).catch(async error=>{console.error(error);await shutdown();app.exit(1);});
