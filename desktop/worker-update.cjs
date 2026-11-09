// Installer-owned transaction metadata and migration checkpoints, outside portable backups.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Extension descriptors are rebuilt from approved addon records and clear during normal shutdown.
const migrationDigest=value=>digest({...value,extensions:[]});
const validId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
function downgrade(from,to){const tuple=value=>/^a?(\d+)\.(\d+)(?:\.(\d+))?/.exec(value)?.slice(1).map(value=>Number(value||0)),a=tuple(from),b=tuple(to);if(!a||!b)return true;for(let i=0;i<3;i++){if(b[i]<a[i])return true;if(b[i]>a[i])return false;}return false;}
async function atomic(file,value){const temporary=file+'.'+randomUUID()+'.tmp';try{await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600,flush:true});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}}
function assertEvidence(before,after){
  if(!after||!Array.isArray(after.jobs)||!Array.isArray(after.runs)||!Array.isArray(after.routines))throw new Error('Migration omitted the worker journal');
  for(const job of before.jobs||[]){const current=after.jobs.find(value=>value.id===job.id);if(!current||(job.outputs||[]).some(output=>!(current.outputs||[]).some(value=>digest(value)===digest(output))))throw new Error('Migration lost a stable job or committed output receipt');}
  for(const run of before.runs||[])for(const event of run.toolEvents||[]){if(!event.intent)continue;const current=after.runs.find(value=>value.id===run.id)?.toolEvents?.find(value=>value.id===event.id);if(!current||digest(current.intent)!==digest(event.intent))throw new Error('Migration changed a pending or completed action intent/receipt');}
}
async function createWorkerUpdate({directory,namespace,protocol=1,clock=()=>new Date().toISOString(),onPhase=()=>{}}){
  if(!path.isAbsolute(directory)||!namespace||!Number.isSafeInteger(protocol)||protocol<1)throw new Error('Invalid independent worker update location');await fs.mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'worker-update.json');let transaction;try{transaction=JSON.parse(await fs.readFile(file,'utf8'));if(transaction.namespace!==namespace||transaction.schemaVersion!==1||!validId(transaction.id)||transaction.checkpoint!==undefined&&transaction.checkpoint!==transaction.id+'.before.json')throw new Error('Update journal belongs to another profile or schema');}catch(error){if(error.code!=='ENOENT')throw error;}
  async function phase(value,extra={}){transaction={...transaction,...extra,phase:value,updatedAt:clock()};await atomic(file,transaction);await onPhase(value,structuredClone(transaction));return structuredClone(transaction);}
  return {
    status:()=>transaction?structuredClone(transaction):null,
    async prepare({id=randomUUID(),fromVersion,toVersion,fromProtocol=1,toProtocol=protocol,wasPaused,quiesce,checkpoint}){
      if(!validId(id)||typeof fromVersion!=='string'||typeof toVersion!=='string'||!Number.isSafeInteger(fromProtocol)||!Number.isSafeInteger(toProtocol)||fromProtocol<1||toProtocol<1||typeof wasPaused!=='boolean')throw new Error('Invalid worker update request');
      if(transaction&&!['committed','rolled_back'].includes(transaction.phase)){if(transaction.id===id&&transaction.phase==='quiesced')return structuredClone(transaction);throw new Error('Recover the existing worker update before starting another');}
      transaction={schemaVersion:1,namespace,id,fromVersion,toVersion,fromProtocol,toProtocol,wasPaused,createdAt:clock(),phase:'requested'};await phase('quiescing');await quiesce();const state=await checkpoint();assertEvidence(state,state);const snapshot=path.join(directory,id+'.before.json');await atomic(snapshot,state);return phase('quiesced',{checkpointDigest:digest(state),checkpoint:path.basename(snapshot),pendingJobs:(state.jobs||[]).filter(job=>!['completed','failed','canceled','abandoned'].includes(job.status)).map(job=>({id:job.id,status:job.status,step:job.step||null})),bootDisabled:toProtocol<fromProtocol||downgrade(fromVersion,toVersion)});
    },
    async migrate({readState,writeState,transform=value=>value}){
      if(!transaction||!['quiesced','migrating'].includes(transaction.phase))throw new Error('Worker must be quiesced before migration');
      const before=JSON.parse(await fs.readFile(path.join(directory,transaction.checkpoint),'utf8'));if(digest(before)!==transaction.checkpointDigest)throw new Error('Worker checkpoint differs from its receipt');
      if(transaction.toProtocol>protocol)throw new Error('This worker cannot load the requested newer schema');await phase('migrating');const current=await readState();
      const next=await transform(structuredClone(before));assertEvidence(before,next);next.workerProtocol=transaction.toProtocol;next.workerQueue={...(next.workerQueue||{}),paused:true};
      if(transaction.bootDisabled)for(const routine of next.routines){routine.enabled=false;delete routine.bootGrant;routine.upgradeReviewRequired=true;}
      if(migrationDigest(current)!==migrationDigest(before)&&migrationDigest(current)!==migrationDigest(next))throw new Error('Profile changed after quiesce; migration requires review');
      if(Object.hasOwn(current,'extensions'))next.extensions=current.extensions;
      await writeState(next);return phase('migrated',{migratedDigest:digest(next)});
    },
    async activate({writeState,readState,resumeReviewed=false}){
      if(!transaction||transaction.phase!=='migrated')throw new Error('Migration must complete before activation');const state=await readState();if(digest(state)!==transaction.migratedDigest)throw new Error('Migrated profile differs before activation');
      // Recovery always opens paused unless the user explicitly chose to reopen the queue.
      state.workerQueue={...(state.workerQueue||{}),paused:!(resumeReviewed&&!transaction.wasPaused&&!transaction.bootDisabled)};await writeState(state);return phase('committed',{reopened:state.workerQueue.paused===false});
    },
    async recover({readState,writeState}){
      if(!transaction||['committed','rolled_back'].includes(transaction.phase))return {needed:false};
      if(!transaction.checkpoint)return phase('needs_attention',{reason:'Quiesce did not produce a checkpoint; existing profile and receipts are retained paused'});
      const before=JSON.parse(await fs.readFile(path.join(directory,transaction.checkpoint),'utf8'));if(digest(before)!==transaction.checkpointDigest)throw new Error('Recovery checkpoint differs');const current=await readState();
      if(current.workerProtocol===transaction.toProtocol&&transaction.migratedDigest&&digest(current)===transaction.migratedDigest)return {needed:true,readyForReview:true,transaction:structuredClone(transaction)};
      // Refuse to overwrite any newer observed effect, even during a failed installer update.
      assertEvidence(current,before);before.workerQueue={...(before.workerQueue||{}),paused:true};for(const routine of before.routines||[])delete routine.bootGrant;await writeState(before);return phase('rolled_back',{reopened:false});
    },
  };
}
async function prepareWorkerStartup({dataDir,registryRoot,isolated=false,protocol=1}){
  const {openProfileActionLedger}=require('./action-ledger.cjs'),ledger=await openProfileActionLedger({dataDir,registryRoot,isolated});
  try{const update=await createWorkerUpdate({directory:path.join(ledger.directory,'updates'),namespace:ledger.namespace,protocol}),status=update.status();if(!status||status.phase==='committed')return {safeMode:false};if(status.phase==='rolled_back')return {safeMode:true,reason:'An interrupted installer migration was rolled back. Review the paused queue.'};
    const stateFile=path.join(dataDir,'state.json'),io={readState:async()=>JSON.parse(await fs.readFile(stateFile,'utf8')),writeState:state=>atomic(stateFile,state)};
    if(['quiesced','migrating'].includes(status.phase)){await update.migrate(io);await update.activate({...io,resumeReviewed:false});return {safeMode:false,queuePaused:true};}
    if(status.phase==='migrated'){await update.activate({...io,resumeReviewed:false});return {safeMode:false,queuePaused:true};}
    await update.recover(io);return {safeMode:true,reason:'Installer checkpoint needs review. The existing profile and independent effect history were retained.'};
  }finally{await ledger.close();}
}
module.exports={createWorkerUpdate,prepareWorkerStartup,assertWorkerEvidenceRetained:assertEvidence};
