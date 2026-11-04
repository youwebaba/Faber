import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFS from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const require=createRequire(import.meta.url),filename=fileURLToPath(import.meta.url),sourceRoot=path.resolve(path.dirname(filename),'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let n=0;n<500;n++){const value=await check();if(value)return value;await delay(20);}throw Error('Host acceptance timed out: '+label);}
const readJSON=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function missing(file){try{await fs.lstat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
function temporaryRoot(root){const rel=path.relative(os.tmpdir(),root);assert.ok(path.basename(root).startsWith('Faber-host-acceptance-')&&rel&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel),'Fixture must stay under the system temporary directory');}

if(process.argv.includes('--host-acceptance-driver')){
  const [root,phase]=process.argv.slice(process.argv.indexOf('--host-acceptance-driver')+1);temporaryRoot(root);
  const {app,BrowserWindow,dialog}=require('electron'),fixture=await readJSON(path.join(root,'fixture.json'));
  const source=path.join(root,phase==='recovery'?'broken-source':'source'),profile=phase==='recovery'?path.join(root,'recovery-local','Faber'):phase==='corrupt'?path.join(root,'corrupt-local','Faber'):phase==='selected'||phase==='off-restart'?fixture.secondary:fixture.defaultDir;
  const report={phase,ok:false,noInference:true},output=path.join(root,phase+'-report.json');
  let relaunch,holdQuit=false,quitRequested=false;
  app.on('browser-window-created',(_event,window)=>window.hide());
  const realQuit=app.quit.bind(app);app.quit=()=>{if(holdQuit){quitRequested=true;return;}return realQuit();};app.relaunch=options=>{relaunch=options;};
  app.on('quit',()=>syncFS.writeFileSync(output,JSON.stringify({...report,relaunch,quitRequested},null,2)));
  if(phase==='recovery'){
    let choices=0;
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(profile,'addons','broken')]});
    dialog.showMessageBox=async(first,second)=>{
      const options=second||first;
      if(options.title==='Faber Safe Mode recovery'){
        assert.match(options.detail,/Controlled editable startup failure/);
        if(choices++===0)return {response:2};
        if(choices===2){assert.equal((await readJSON(path.join(profile,'addon-manager','state.json'))).records.broken.enabled,false);report.disabledWithoutImport=true;return {response:3};}
        assert.equal(await missing(path.join(profile,'addons','broken')),true);
        assert.equal(await fs.readFile(path.join(profile,'addon-data','broken','retain.txt'),'utf8'),'private fixture data');
        assert.equal(await missing(path.join(profile,'addon-imported.txt')),true);assert.equal((await readJSON(path.join(profile,'boot-state.json'))).phase,'failed');
        Object.assign(report,{removedWithoutImport:true,privateDataPreserved:true,independentRecovery:true,ok:true});return {response:5};
      }
      return {response:options.message?.startsWith('Remove this addon')?1:0};
    };
  }else if(phase==='corrupt'){
    dialog.showErrorBox=(title,message)=>{assert.equal(title,'Faber startup recovery');assert.match(message,/profile registry could not be read/i);Object.assign(report,{failedClosed:true,ok:true});syncFS.writeFileSync(output,JSON.stringify(report,null,2));};
  }else{
    dialog.showMessageBox=async()=>({response:0});
    void(async()=>{
      try{
        const window=await until(()=>BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL()==='faber://app/index.html'),'real host page');
        await until(()=>window.webContents.executeJavaScript('document.readyState==="complete"&&!!window.faber').catch(()=>false),'actual preload bridge');
        const request=(method,params={})=>window.webContents.executeJavaScript('window.faber.request('+JSON.stringify(method)+','+JSON.stringify(params)+')');
        await delay(150);assert.equal((await readJSON(path.join(profile,'boot-state.json'))).phase,'starting','loadURL must not mark startup ready');report.readinessWaitsForRenderer=true;
        const recovery=await request('app.recoveryStatus');assert.equal(recovery.safeMode,true);assert.match(recovery.reason,phase==='selected'?/previous/:/requested/);report[phase==='selected'?'automaticSafeMode':'explicitSafeMode']=true;
        await request('app.uiReady');assert.equal((await readJSON(path.join(profile,'boot-state.json'))).phase,'ready');report.realReadyHandshake=true;
        assert.equal(app.getPath('userData'),profile);assert.equal(app.getPath('sessionData'),profile);
        const state=await request('state.get'),serialized=JSON.stringify(state),isSecondary=phase==='selected'||phase==='off-restart';
        assert.equal(serialized.includes(isSecondary?'DEFAULT_PROFILE_ONLY':'SECONDARY_PROFILE_ONLY'),false);assert.ok(serialized.includes(isSecondary?'SECONDARY_PROFILE_ONLY':'DEFAULT_PROFILE_ONLY'));
        assert.equal((await request('profiles.list')).currentId,isSecondary?fixture.secondaryId:'default');report.selectedProfileIsolated=true;
        if(phase==='off-restart'){assert.equal(state.settings.runTimeoutMs,0);report.timeoutOffSurvivedRestart=true;}
        if(phase==='selected'){
          await request('settings.update',{runTimeoutMs:0});assert.equal((await request('state.get')).settings.runTimeoutMs,0);
          const addons=await request('addons.list');assert.equal(addons.safeMode,true);assert.equal(addons.addons.find(row=>row.id==='broken').safeDisabled,true);assert.equal(await missing(path.join(profile,'addon-imported.txt')),true);
          assert.equal((await readJSON(path.join(profile,'addon-manager','state.json'))).records.broken.enabled,true);report.enabledBrokenAddonSkipped=true;
          const project=await request('project.create',{name:'Ancestor fixture',path:fixture.localData}),chat=await request('chat.create',{projectId:project.id,title:'Host guard checks'});
          for(const privateFile of ['Faber/state.json','Faber/secrets.json','FaberProfiles/profiles.json',path.relative(fixture.localData,path.join(fixture.secondary,'state.json')).replaceAll('\\','/')]){
            const result=await request('tool.run',{chatId:chat.id,name:'files_read',args:{path:privateFile}}).then(value=>({value}),error=>({error:String(error)}));assert.match(result.error||result.value?.error||'',/Private Faber profile/);
          }
          report.inactiveAndActiveProfileFilesDenied=true;
          await assert.rejects(request('profiles.switch',{id:'default',draftsCleared:false}),/draft|constant|const|invalid/i);
          await window.webContents.executeJavaScript('globalThis.pendingHostTool=window.faber.request("tool.run",'+JSON.stringify({chatId:chat.id,name:'files_write',args:{path:'blocked-write.txt',text:'must remain absent'}})+').then(value=>({value}),error=>({error:String(error)}));true');
          await until(async()=>(await request('state.get')).approvals.some(item=>item.chatId===chat.id),'actual pending tool approval');
          await assert.rejects(request('profiles.switch',{id:'default',draftsCleared:true}),/Stop running chats/);assert.equal((await request('profiles.list')).currentId,fixture.secondaryId);report.activeRunSwitchRejected=true;
          await request('chat.stop',{chatId:chat.id});await window.webContents.executeJavaScript('globalThis.pendingHostTool');assert.equal(await missing(path.join(fixture.localData,'blocked-write.txt')),true);report.timeoutOffStillStops=true;
          await request('gateway.configure',{bindAddress:'127.0.0.1',port:0,projectId:project.id,providerId:'local-ollama',model:'fixture-model'});
          const token=(await request('gateway.rotateToken')).token,gateway=await request('gateway.start');
          const pending=http.request(gateway.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':1000}});pending.on('error',()=>{});pending.write('{');
          await until(async()=>(await request('gateway.status')).activeRequests===1,'partial external request');
          await assert.rejects(request('profiles.switch',{id:'default',draftsCleared:true}),/external API requests/);report.externalBodySwitchRejected=true;
          await request('gateway.stop');pending.destroy();assert.equal((await request('gateway.status')).activeRequests,0);
          holdQuit=true;assert.equal((await request('profiles.switch',{id:'default',draftsCleared:true})).restarting,true);
          assert.equal((await readJSON(path.join(fixture.localData,'FaberProfiles','profiles.json'))).currentId,'default');assert.equal(quitRequested,true);assert.ok(Array.isArray(relaunch?.args));assert.ok(!relaunch.args.includes('--safe-mode'));
          await assert.rejects(request('chat.create',{projectId:project.id,title:'Must be blocked after switch'}),/restarting or switching/);report.realSwitchSelectedExactProfile=true;report.postSwitchMutationFenced=true;
        }
        report.ok=true;holdQuit=false;realQuit();
      }catch(error){report.error=error.stack;console.error(error);holdQuit=false;app.exit(1);}
    })();
  }
  require(path.join(source,'desktop','bootstrap.cjs'));
}else{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-host-acceptance-'));temporaryRoot(root);
  const {createRuntime}=await import('../core/runtime.mjs'),{createProfiles}=require('../desktop/profile-path.cjs'),{readAddonPackage}=await import('../desktop/addons.mjs');
  const source=path.join(root,'source'),localData=path.join(root,'local'),defaultDir=path.join(localData,'Faber');await fs.mkdir(source);
  for(const folder of ['desktop','core','tools','model-hub','local-models','extensions','native'])await fs.cp(path.join(sourceRoot,folder),path.join(source,folder),{recursive:true,filter:file=>!file.includes(path.sep+'target')&&!file.includes(path.sep+'vendor')&&!file.includes(path.sep+'bin')});
  await fs.copyFile(path.join(sourceRoot,'package.json'),path.join(source,'package.json'));await fs.mkdir(path.join(source,'renderer'));await fs.writeFile(path.join(source,'renderer','index.html'),'<!doctype html><html><body>Isolated real host fixture; readiness is intentionally withheld.</body></html>');await fs.mkdir(path.join(source,'build'));await fs.copyFile(path.join(sourceRoot,'build','faber.ico'),path.join(source,'build','faber.ico'));
  const profiles=createProfiles(localData),secondaryId=profiles.create('Secondary fixture').id,secondary=profiles.directory(secondaryId);profiles.select(secondaryId);
  const fixture={root,source,localData,defaultDir,secondaryId,secondary};await fs.writeFile(path.join(root,'fixture.json'),JSON.stringify(fixture));
  async function seed(directory,title){const runtime=await createRuntime({dataDir:directory,sourceDir:source});const project=await runtime.request('project.create',{name:title,path:root});await runtime.request('chat.create',{projectId:project.id,title});await runtime.close();await fs.writeFile(path.join(directory,'secrets.json'),'{"synthetic-unused":"fixture-only"}');}
  async function brokenAddon(directory){
    const addon=path.join(directory,'addons','broken');await fs.mkdir(addon,{recursive:true});await fs.mkdir(path.join(directory,'addon-manager'),{recursive:true});await fs.mkdir(path.join(directory,'addon-data','broken'),{recursive:true});
    await fs.writeFile(path.join(addon,'addon.json'),JSON.stringify({schemaVersion:1,id:'broken',name:'Broken fixture',version:'1.0.0',entry:'index.mjs',hostApi:1,permissions:[]}));
    await fs.writeFile(path.join(addon,'index.mjs'),'import fs from "node:fs";fs.writeFileSync('+JSON.stringify(path.join(directory,'addon-imported.txt'))+',"must not import");throw Error("Controlled addon import");');
    const pkg=await readAddonPackage(addon);await fs.writeFile(path.join(directory,'addon-manager','state.json'),JSON.stringify({schemaVersion:1,legacyMigrated:true,bundledSeen:[],records:{broken:{enabled:true,digest:pkg.digest}}}));await fs.writeFile(path.join(directory,'addon-data','broken','retain.txt'),'private fixture data');
  }
  await seed(defaultDir,'DEFAULT_PROFILE_ONLY');await seed(secondary,'SECONDARY_PROFILE_ONLY');await brokenAddon(secondary);await fs.writeFile(path.join(secondary,'boot-state.json'),JSON.stringify({schemaVersion:1,id:'interrupted-fixture',phase:'starting',pid:0}));
  const defaultBefore=await fs.readFile(path.join(defaultDir,'state.json')),defaultSecrets=await fs.readFile(path.join(defaultDir,'secrets.json')),electron=require('electron'),reports=[];
  async function run(phase,{safe=false,expectedCode=0}={}){
    const local=phase==='recovery'?path.join(root,'recovery-local'):phase==='corrupt'?path.join(root,'corrupt-local'):localData,roaming=path.join(root,phase+'-roaming');await fs.mkdir(roaming);
    const env={...process.env,LOCALAPPDATA:local,APPDATA:roaming};delete env.ELECTRON_RUN_AS_NODE;
    const result=await new Promise((resolve,reject)=>{const child=spawn(electron,[filename,'--host-acceptance-driver',root,phase,...(safe?['--safe-mode']:[])],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const timer=setTimeout(()=>{child.kill();reject(Error(phase+' exceeded 45s: '+output));},45000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,output});});});
    assert.equal(result.code,expectedCode,phase+': '+result.output);assert.equal(await missing(path.join(root,phase+'-report.json')),false,phase+' did not record its proof: '+result.output);const report=await readJSON(path.join(root,phase+'-report.json'));assert.equal(report.ok,true,report.error||phase+' failed');reports.push(report);
  }
  async function legacyLock(){
    const holder=path.join(root,'legacy-holder'),contender=path.join(root,'lock-contender'),ready=path.join(root,'legacy-holder-ready'),stop=path.join(root,'legacy-holder-stop'),marker=path.join(root,'lock-contender-imported');
    await fs.mkdir(holder);await fs.cp(source,contender,{recursive:true});
    const packageInfo=await readJSON(path.join(source,'package.json'));await fs.writeFile(path.join(holder,'package.json'),JSON.stringify({...packageInfo,main:'main.cjs'}));
    await fs.writeFile(path.join(holder,'main.cjs'),'const {app}=require("electron"),fs=require("node:fs");app.setPath("userData",'+JSON.stringify(defaultDir)+');app.setAppUserModelId("ai.clocal.faber");if(!app.requestSingleInstanceLock())throw Error("Legacy fixture could not acquire lock");fs.writeFileSync('+JSON.stringify(ready)+',app.getName());const timer=setInterval(()=>{if(fs.existsSync('+JSON.stringify(stop)+')){clearInterval(timer);app.quit();}},20);');
    await fs.writeFile(path.join(contender,'desktop','main.mjs'),'import fs from "node:fs";import {app} from "electron";fs.writeFileSync('+JSON.stringify(marker)+',"must not import");app.exit(0);');
    const journalBefore=await fs.readFile(path.join(secondary,'boot-state.json')),env={...process.env,LOCALAPPDATA:localData,APPDATA:path.join(root,'lock-roaming')};delete env.ELECTRON_RUN_AS_NODE;
    const holding=spawn(electron,[holder],{env,windowsHide:true,stdio:'ignore'}),holderExit=new Promise(resolve=>holding.once('exit',resolve));
    try{
      await until(async()=>!await missing(ready),'legacy default-profile lock');assert.equal(await fs.readFile(ready,'utf8'),'Faber');
      const result=await new Promise((resolve,reject)=>{const child=spawn(electron,[contender],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const timer=setTimeout(()=>{child.kill();reject(Error('Lock contender exceeded 15s: '+output));},15000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,output});});});
      assert.equal(result.code,0,result.output);assert.equal(await missing(marker),true,'An old default-profile host must block new named-profile bootstrap before importing application code');
      assert.deepEqual(await fs.readFile(path.join(secondary,'boot-state.json')),journalBefore,'Rejected bootstrap must not change the selected profile startup journal');assert.deepEqual(await fs.readFile(path.join(defaultDir,'state.json')),defaultBefore);
      reports.push({phase:'legacy-singleton',ok:true,realElectronProcesses:true,legacyDefaultLockBlocksNewNamedProfile:true,noEditableImport:true,selectedProfileJournalUntouched:true});
    }finally{await fs.writeFile(stop,'stop');const timer=setTimeout(()=>holding.kill(),5000);await holderExit;clearTimeout(timer);}
  }
  await legacyLock();
  await run('selected');assert.deepEqual(await fs.readFile(path.join(defaultDir,'state.json')),defaultBefore);assert.deepEqual(await fs.readFile(path.join(defaultDir,'secrets.json')),defaultSecrets);assert.equal((await readJSON(path.join(secondary,'boot-state.json'))).phase,'clean');
  createProfiles(localData).select(secondaryId);await run('off-restart',{safe:true});createProfiles(localData).select('default');await run('explicit',{safe:true});assert.equal((await readJSON(path.join(defaultDir,'boot-state.json'))).phase,'clean');
  const brokenSource=path.join(root,'broken-source');await fs.cp(source,brokenSource,{recursive:true});await fs.writeFile(path.join(brokenSource,'desktop','main.mjs'),'throw Error("Controlled editable startup failure");');await brokenAddon(path.join(root,'recovery-local','Faber'));await run('recovery',{expectedCode:1});
  const corruptData=path.join(root,'corrupt-local'),corruptRegistry=path.join(corruptData,'FaberProfiles','profiles.json');await fs.mkdir(path.dirname(corruptRegistry),{recursive:true});await fs.writeFile(corruptRegistry,'{intentionally broken registry');await fs.mkdir(path.join(corruptData,'Faber'));await fs.writeFile(path.join(corruptData,'Faber','retain.txt'),'preserved');await run('corrupt',{expectedCode:1});assert.equal(await fs.readFile(corruptRegistry,'utf8'),'{intentionally broken registry');assert.equal(await fs.readFile(path.join(corruptData,'Faber','retain.txt'),'utf8'),'preserved');
  const report={ok:true,root,realBootstrapAndMain:true,actualPreloadIPC:true,noInference:true,untouchedInactiveProfileBytes:true,reports},reportPath=path.join(sourceRoot,'release','verification','remaining-roadmap-20261104','host-acceptance-report.json');await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,root,reportPath,phases:reports.map(item=>item.phase)}));
}
