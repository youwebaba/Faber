// Installer-owned Node-mode entry. Task Scheduler invokes this without Electron UI or user credentials.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {createProfiles}=require('./profile-path.cjs');
const {acquireProfileOwner}=require('./profile-owner.cjs');
const {startWorkerControl}=require('./worker-control.cjs');
async function main(){
  if(process.platform!=='win32')throw new Error('Boot worker requires Windows');const index=process.argv.indexOf('--worker-profile'),profileId=index<0?null:process.argv[index+1];if(!profileId)throw new Error('Boot task must select one reviewed profile');
  const isolatedIndex=process.argv.indexOf('--isolated-local-app-data'),isolatedRoot=isolatedIndex<0?null:process.argv[isolatedIndex+1];if(isolatedIndex>=0&&!isolatedRoot)throw new Error('An isolated boot launch must provide its temporary profile root');if(isolatedRoot){const relative=path.relative(os.tmpdir(),isolatedRoot);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Isolated boot profiles must remain below the temporary directory');}
  const sourceDir=path.resolve(__dirname,'..'),profiles=createProfiles(isolatedRoot||process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')),dataDir=profiles.directory(profileId),settings=JSON.parse(await fs.readFile(path.join(dataDir,'boot-worker','state.json'),'utf8'));if(settings.schemaVersion!==1||!settings.enabled||settings.profileId!==profileId)return;
  const owner=await acquireProfileOwner(dataDir).catch(error=>{if(['EADDRINUSE','EACCES'].includes(error.code))return null;throw error;});if(!owner)return;
  let worker,control,closing=false;const statusFile=path.join(dataDir,'boot-worker','process-state.json');let previous;try{previous=JSON.parse(await fs.readFile(statusFile,'utf8'));}catch(error){if(error.code!=='ENOENT')previous={phase:'failed'};}
  async function mark(phase,extra={}){const temporary=statusFile+'.tmp';await fs.writeFile(temporary,JSON.stringify({schemaVersion:1,phase,pid:process.pid,profileId,at:new Date().toISOString(),...extra}),{mode:0o600,flush:true});await fs.rename(temporary,statusFile);}
  async function close(){if(closing)return;closing=true;try{await worker?.close();await mark('clean');}finally{await owner.close();}}
  try{await mark('starting');const {packagedRuntime}=await import(pathToFileURL(path.join(sourceDir,'desktop','packaged-paths.mjs')).href),runtimeOptions=sourceDir.endsWith('app.asar')?packagedRuntime(path.dirname(sourceDir)):{executable:path.join(sourceDir,'.runtime','local-runtime','llama-server.exe')};const {createBootRuntime}=await import(pathToFileURL(path.join(sourceDir,'desktop','boot-runtime.mjs')).href);worker=await createBootRuntime({dataDir,sourceDir,registryRoot:profiles.privatePaths[0],profileId,isolated:!!isolatedRoot,safeMode:previous&&previous.phase!=='clean',runtimeOptions});await mark('running');
    control=await startWorkerControl({dataDir,kind:'boot',handler:async command=>{if(command==='status')return worker.status();if(['handoff','shutdown','prepare_update'].includes(command)){await worker.checkpoint();await close();setImmediate(()=>void control.close().finally(()=>process.exit(0)));return {kind:'boot',checkpointed:true,ownerReleased:true};}throw new Error('Unknown boot control command');}});
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void close().finally(()=>control.close()).finally(()=>process.exit(0)));
  }catch(error){try{await worker?.close().catch(()=>{});await mark('failed',{error:error.message});}finally{await owner.close();}throw error;}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={runBootWorker:main};
