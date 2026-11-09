// Installer-owned bootstrap stays outside the editable application's import graph.
const { app, dialog, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn}=require('node:child_process');
const { pathToFileURL } = require('node:url');
const appRoot = path.resolve(__dirname, '..');
const smokeModes = new Set(['--smoke','--smoke-live','--smoke-models','--smoke-features','--smoke-local-models','--smoke-ui-reload','--smoke-package','--smoke-faber','--smoke-installed','--smoke-b11','--smoke-b12','--smoke-b201','--smoke-thinking','--smoke-browser','--smoke-media']);
smokeModes.add('--smoke-worker');
const smoke = process.argv.some(value => smokeModes.has(value));
const profileIndex = process.argv.indexOf('--smoke-profile');
const workerProfileIndex=process.argv.indexOf('--worker-profile');
const workerProfileId=workerProfileIndex<0?null:process.argv[workerProfileIndex+1];
let dataDir;
void (async()=>{try {
  const {createProfiles}=require('./profile-path.cjs');
  const {beginBoot,updateBoot}=require('./boot-state.cjs');
  const localAppData=process.env.LOCALAPPDATA||app.getPath('appData');
  let profiles;
  if (profileIndex !== -1) {
    if (!smoke || !path.isAbsolute(process.argv[profileIndex + 1] || '')) throw new Error('--smoke-profile requires a smoke mode and an absolute isolated directory');
    dataDir = path.resolve(process.argv[profileIndex + 1]);
    const temporaryRelative = path.relative(path.resolve(os.tmpdir()), dataDir);
    if (!temporaryRelative || temporaryRelative === '..' || temporaryRelative.startsWith(`..${path.sep}`) || path.isAbsolute(temporaryRelative)) throw new Error('Smoke profiles must be isolated children of the system temporary directory');
  } else if(smoke)dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'Faber-smoke-'));
  else{profiles=createProfiles(localAppData);dataDir=profiles.directory(workerProfileId||profiles.currentId);}
  fs.mkdirSync(dataDir, { recursive: true });
  if(smoke)profiles=createProfiles(path.join(dataDir,'profile-registry'),{defaultDirectory:dataDir});
  if(workerProfileIndex>=0&&(!process.argv.includes('--background-worker')||!workerProfileId))throw new Error('A worker profile requires the background sign-in launch mode');
  // Old releases lock the default profile; keep that identity across all profiles.
  const lockDirectory=profiles.directory('default');
  fs.mkdirSync(lockDirectory,{recursive:true});app.setPath('userData',lockDirectory);
  app.setAppUserModelId('ai.clocal.faber');
  protocol.registerSchemesAsPrivileged([{ scheme: 'faber', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },{scheme:'faber-preview',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
  if (!app.requestSingleInstanceLock()) { if (process.argv.includes('--rollback-last')) { console.error('Close Faber before running recovery.'); app.quit(); process.exit(1); } app.quit(); process.exit(0); }
  const profileOwner=await require('./profile-owner.cjs').acquireProfileOwner(dataDir);
  if(workerProfileId&&profiles.currentId!==workerProfileId)profiles.select(workerProfileId);
  app.on('will-quit',()=>{void profileOwner.close();});
  app.setPath('userData',dataDir);app.setPath('sessionData',dataDir);
  const boot=beginBoot(dataDir,{safeMode:process.argv.includes('--safe-mode')});let ready=false,cleanShutdown=false,recovering=false,sourceDir=appRoot;
  app.on('quit',(_event,code)=>{if(code===0&&ready&&cleanShutdown)updateBoot(dataDir,boot.id,'clean');});
  const watchdog=spawn(process.execPath,[path.join(appRoot,'desktop','boot-state.cjs'),'--watch-boot',dataDir,boot.id],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,detached:true,stdio:'ignore'});watchdog.on('error',error=>console.error('Startup watchdog unavailable:',error.message));watchdog.unref();
  async function recover(error){
    if(recovering)return;recovering=true;
    updateBoot(dataDir,boot.id,'failed',error?.message||String(error));console.error(error);
    if(smoke){app.exit(1);return;}
    await app.whenReady();
    const recovery=await import(pathToFileURL(path.join(appRoot,'desktop','recovery.mjs')).href);
    for(;;){
      const choice=await dialog.showMessageBox({type:'warning',title:'Faber Safe Mode recovery',message:'Faber could not load its editable application.',detail:`${error?.message||error}\n\nYour profile and workbench are preserved. Recovery uses installer-owned code. Removing an addon skips its executable cleanup hook and retains private data; owned external services may require manual cleanup.`,buttons:['Start Safe Mode','Roll back last upgrade','Disable all addons','Remove an addon','Open addons folder','Quit'],defaultId:0,cancelId:5,noLink:true});
      try{
        if(choice.response===0){app.relaunch({args:[...process.argv.slice(1).filter(value=>value!=='--safe-mode'),'--safe-mode']});app.exit(0);return;}
        if(choice.response===1){await recovery.restoreUpgrade({dataDir,sourceDir,record:await recovery.readRecoveryRecord(dataDir,sourceDir)});await dialog.showMessageBox({message:'The last upgrade was restored. Start Safe Mode to review the recovered app.'});}
        else if(choice.response===2){const result=await recovery.disableRecoveryAddons(dataDir);await dialog.showMessageBox({message:`Disabled ${result.disabled} addons without loading their code.`});}
        else if(choice.response===3){const selected=await dialog.showOpenDialog({title:'Choose the addon folder to remove',defaultPath:path.join(dataDir,'addons'),properties:['openDirectory']});if(!selected.canceled){const approval=await dialog.showMessageBox({type:'warning',message:'Remove this addon’s installed code? Its private data stays; its executable cleanup hook will not run.',detail:selected.filePaths[0],buttons:['Cancel','Remove addon'],defaultId:0,cancelId:0});if(approval.response===1)await recovery.removeRecoveryAddon(dataDir,selected.filePaths[0]);}}
        else if(choice.response===4){fs.mkdirSync(path.join(dataDir,'addons'),{recursive:true});const {shell}=require('electron');await shell.openPath(path.join(dataDir,'addons'));}
        else{app.exit(1);return;}
      }catch(actionError){await dialog.showMessageBox({type:'error',message:actionError.message});}
    }
  }
  void (async () => {
    const packaged = app.isPackaged;
    const { prepareWorkbench } = await import(pathToFileURL(path.join(appRoot, 'desktop', 'packaged-paths.mjs')).href);
    const workbenchRoot = smoke ? `${dataDir}-workbench` : path.join(localAppData, 'FaberWorkbench');
    sourceDir=packaged?path.join(workbenchRoot,app.getVersion()):appRoot;
    if(packaged)sourceDir=await prepareWorkbench({ bundledSource: appRoot, workbenchRoot, version: app.getVersion() });
    globalThis.__FABER_BOOTSTRAP__ = Object.freeze({ dataDir, sourceDir, packaged, resourcesPath: process.resourcesPath, version: app.getVersion(), hasLock: true, profiles, safeMode:boot.safeMode,recoveryReason:boot.reason,onReady(){ready=true;updateBoot(dataDir,boot.id,'ready');},onShutdown(clean){cleanShutdown=clean===true;},onFailure:recover,bundledSource: path.join(appRoot,'bundled-addons'), addonResources: packaged?path.join(process.resourcesPath,'lightpanda'):path.join(appRoot,'.runtime','lightpanda') });
    if (process.argv.includes('--rollback-last')) {
      const { readRecoveryRecord, restoreUpgrade } = await import(pathToFileURL(path.join(appRoot, 'desktop', 'recovery.mjs')).href);
      const result = await restoreUpgrade({ dataDir, sourceDir, record: await readRecoveryRecord(dataDir, sourceDir) });
      if(smoke) { fs.writeFileSync(path.join(dataDir,'recovery-report.json'),JSON.stringify(result)); console.log(JSON.stringify(result)); }
      else { await app.whenReady(); await dialog.showMessageBox({ type: 'info', title: 'Faber recovery', message: `Restored upgrade ${result.id}. Start Faber again to load the recovered source.` }); }
      updateBoot(dataDir,boot.id,'clean');app.quit(); return;
    }
    await import(pathToFileURL(path.join(sourceDir, 'desktop', 'main.mjs')).href);
  })().catch(recover);
} catch (error) {
  console.error(error);
  void app.whenReady().then(()=>{if(!smoke)dialog.showErrorBox('Faber startup recovery',`${error.message}\n\nStartup stopped before selecting a usable profile. Existing profiles and their data were preserved; Faber did not choose a different profile. Review the profile registry at ${path.join(process.env.LOCALAPPDATA||app.getPath('appData'),'FaberProfiles','profiles.json')} or restore the installer-owned startup files.`);}).finally(()=>app.exit(1));
}})();
