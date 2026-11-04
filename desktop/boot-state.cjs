// Installer-owned startup journal; this module never imports editable application code.
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const filename=dataDir=>path.join(dataDir,'boot-state.json');
function readBootState(dataDir){
  try{const value=JSON.parse(fs.readFileSync(filename(dataDir),'utf8'));if(value.schemaVersion!==1||typeof value.id!=='string'||!['starting','ready','clean','failed'].includes(value.phase))throw Error('Invalid startup journal');return value;}
  catch(error){if(error.code==='ENOENT')return null;return {phase:'failed',error:'The previous startup journal could not be read.'};}
}
function writeBootState(dataDir,value){fs.mkdirSync(dataDir,{recursive:true});const file=filename(dataDir),temporary=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600,flush:true});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}}
function beginBoot(dataDir,{safeMode=false,pid=process.pid}={}){
  const previous=readBootState(dataDir),incomplete=previous&&previous.phase!=='clean';
  const value={schemaVersion:1,id:randomUUID(),pid,phase:'starting',safeMode:safeMode||!!incomplete,reason:incomplete?(previous.error||'Faber did not finish its previous startup or shutdown.') : safeMode?'Safe Mode was requested.':'',startedAt:new Date().toISOString()};
  writeBootState(dataDir,value);return value;
}
function updateBoot(dataDir,id,phase,error){const current=readBootState(dataDir);if(current?.id!==id)return false;if(phase==='failed'&&current.phase!=='starting')return false;writeBootState(dataDir,{...current,phase,...(error?{error:String(error).slice(0,2000)}:{})});return true;}
module.exports={readBootState,beginBoot,updateBoot};
if(process.argv[2]==='--watch-boot'){
  const [dataDir,id]=process.argv.slice(3),started=Date.now();
  const timer=setInterval(()=>{const current=readBootState(dataDir);if(current?.id!==id||current.phase!=='starting'){clearInterval(timer);return;}if(Date.now()-started>=60000){updateBoot(dataDir,id,'failed','Startup did not become ready within one minute. The next launch will use Safe Mode.');clearInterval(timer);}},500);
}
