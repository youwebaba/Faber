// Installer-owned, Node-mode helper. It never kills a process or overwrites an active profile.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {createProfiles}=require('./profile-path.cjs');
const {acquireProfileOwner}=require('./profile-owner.cjs');
const {callWorkerControl}=require('./worker-control.cjs');
const {openProfileActionLedger}=require('./action-ledger.cjs');
const {createWorkerUpdate,normalizeWorkerJournal}=require('./worker-update.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Only these stable classes enter the installer UI. Raw stderr is diagnostic
// output and may contain filesystem paths, so never use it as dialog text.
function workerUpdateExitCode(error){
  const message=error?.message||'';
  if(error instanceof SyntaxError||/^Invalid |^Installer must |^An isolated |^Isolated installer |^Update journal belongs |^Migration omitted /.test(message))return 20;
  if(/checkpoint differs|checkpoint identity already exists|checkpoint requires review|changed after quiesce|Recover the existing worker update|Migration lost|Migration changed|newer schema|differs before activation/i.test(message))return 21;
  if(/^Quit the running Faber|^Worker did not finish|closed before|timed out/i.test(message))return 22;
  return 23;
}
async function main(){
  const option=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];},mode=option('--mode')||'prepare',toVersion=option('--to-version'),installedRoot=option('--install-root');if(!['prepare','uninstall','handoff'].includes(mode)||!installedRoot||!path.isAbsolute(installedRoot)||!toVersion||toVersion.length>100)throw new Error('Installer must supply its local install root and target release');
  const override=option('--isolated-local-app-data');if(process.argv.includes('--isolated-local-app-data')&&!override)throw new Error('An isolated installer probe must provide its temporary profile root');let localAppData=process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local');if(override){const relative=path.relative(os.tmpdir(),override);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Isolated installer profiles must be under the temporary directory');localAppData=override;}
  const profiles=createProfiles(localAppData),results=[];let fromVersion='legacy';try{fromVersion=JSON.parse(await fs.readFile(path.join(installedRoot,'resources','app.asar','package.json'),'utf8')).version;}catch{/* Legacy or development fixture: reopen paused for explicit review. */}
  for(const profile of profiles.list().profiles){const dataDir=profiles.directory(profile.id);let state;try{state=JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
    // A parent installer's receipt never authorizes stopping a worker reopened
    // since prepare. Handoff only checks exclusive ownership and saved evidence.
    let active;if(mode!=='handoff')try{active=await callWorkerControl({dataDir,command:'status',timeoutMs:2000});}catch(error){if(!['ENOENT','ECONNREFUSED','EPIPE'].includes(error.code)&&!error.message.includes('closed before'))throw error;}
    if(active){await callWorkerControl({dataDir,command:mode==='prepare'?'prepare_update':'shutdown',updateId:randomUUID(),toVersion,toProtocol:1,timeoutMs:30000});for(let i=0;i<300;i++){let alive=true;try{process.kill(active.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}if(!alive)break;if(i===299)throw new Error('Worker did not finish its checkpoint and shutdown; installation stopped');await pause(100);}}
    let owner;try{owner=await acquireProfileOwner(dataDir);}catch(error){if(['EADDRINUSE','EACCES'].includes(error.code))throw new Error('Quit the running Faber normally before installing this update. Its older worker does not support checkpoint handoff.');throw error;}
    let ledger;try{
      // The running worker may have committed final receipts while ownership changed.
      // Only the state re-read under this kernel lock can become a migration checkpoint.
      state=normalizeWorkerJournal(JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8')));
      ledger=await openProfileActionLedger({dataDir,registryRoot:profiles.privatePaths[0],isolated:!!override});const update=await createWorkerUpdate({directory:path.join(ledger.directory,'updates'),namespace:ledger.namespace,protocol:1});
      if(mode==='handoff'){
        // The uninstall binary may belong to the previous release. Its compiled
        // VERSION is not the incoming target; verify the existing transaction.
        const checked=await update.verifyCheckpoint({readState:async()=>JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'))});
        results.push({profileId:profile.id,checkpointVerified:true,transactionId:checked.id,paused:true});continue;
      }
      if(mode==='prepare'){
        const wasPaused=state.workerQueue.paused===true;
        // The current installer must verify the old worker's checkpoint too:
        // older helpers may have left a partial transaction or stale snapshot.
        await update.prepare({fromVersion:active?.version||fromVersion,toVersion,fromProtocol:state.workerProtocol||active?.protocol||1,toProtocol:1,wasPaused,
          quiesce:async()=>{const latest=normalizeWorkerJournal(JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8')));latest.workerQueue.paused=true;const temporary=path.join(dataDir,'state.json.'+randomUUID()+'.tmp');try{await fs.writeFile(temporary,JSON.stringify(latest),{mode:0o600,flag:'wx',flush:true});await fs.rename(temporary,path.join(dataDir,'state.json'));}finally{await fs.rm(temporary,{force:true});}},
          checkpoint:async()=>JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'))});
      }
      state=JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'));state.workerQueue={...(state.workerQueue||{}),paused:true};if(mode==='uninstall')for(const routine of state.routines||[])delete routine.bootGrant;const temporary=path.join(dataDir,'state.json.'+randomUUID()+'.tmp');await fs.writeFile(temporary,JSON.stringify(state),{mode:0o600,flag:'wx',flush:true});await fs.rename(temporary,path.join(dataDir,'state.json'));results.push({profileId:profile.id,checkpointed:true,paused:true});
      if(mode==='uninstall'){let settings;const file=path.join(dataDir,'boot-worker','state.json');try{settings=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}if(settings){settings.enabled=false;await fs.writeFile(file,JSON.stringify(settings),{mode:0o600,flush:true});if(settings.taskName&&settings.ownerSid){const {spawn}=require('node:child_process'),payload=Buffer.from(JSON.stringify({action:'remove',taskName:settings.taskName,ownerSid:settings.ownerSid})).toString('base64'),script=path.join(installedRoot,'resources','app.asar.unpacked','desktop','boot-task.ps1');await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Payload',payload],{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Boot registration removal failed; profile policy is disabled and its data was preserved')));});}}}
    }finally{await ledger?.close();await owner.close();}
  }
  console.log(JSON.stringify({ok:true,mode,profiles:results,modelsPreserved:true,credentialsUntouched:true}));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=workerUpdateExitCode(error);});
module.exports={runWorkerUpdateCli:main,workerUpdateExitCode};
