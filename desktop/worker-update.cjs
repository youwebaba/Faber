// Installer-owned transaction metadata and migration checkpoints, outside portable backups.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Extension descriptors are rebuilt from approved addon records and clear during normal shutdown.
const migrationDigest=value=>digest({...value,extensions:[]});
const validId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const validDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Pre-worker releases have no routine/job arrays. Add only absent fields, never
// coerce a damaged journal or discard an older release's unknown data.
function normalizeJournal(value){
  if(!object(value))throw new Error('Invalid worker profile; original state preserved');
  const state=structuredClone(value);
  if(Object.hasOwn(state,'workerProtocol')&&['routines','jobs','runs'].some(key=>!Object.hasOwn(state,key)))throw new Error('Invalid versioned worker journal; original state preserved');
  for(const key of ['routines','jobs','runs']){
    if(!Object.hasOwn(state,key))state[key]=[];
    if(!Array.isArray(state[key])||state[key].some(row=>!object(row)||typeof row.id!=='string'||!row.id)||new Set(state[key].map(row=>row.id)).size!==state[key].length)throw new Error('Invalid worker journal; original state preserved');
  }
  for(const job of state.jobs)if(Object.hasOwn(job,'outputs')&&(!Array.isArray(job.outputs)||job.outputs.some(row=>!object(row))))throw new Error('Invalid output journal; original state preserved');
  for(const run of state.runs){
    if(Object.hasOwn(run,'toolEvents')&&(!Array.isArray(run.toolEvents)||run.toolEvents.some(row=>!object(row)||typeof row.id!=='string'||!row.id)||new Set(run.toolEvents.map(row=>row.id)).size!==run.toolEvents.length))throw new Error('Invalid action journal; original state preserved');
    for(const event of run.toolEvents||[])if(Object.hasOwn(event,'intent')&&event.intent!==undefined&&!object(event.intent))throw new Error('Invalid action intent; original state preserved');
  }
  if(!Object.hasOwn(state,'workerQueue'))state.workerQueue={paused:false};
  if(!object(state.workerQueue)||typeof state.workerQueue.paused!=='boolean'||Object.hasOwn(state,'workerProtocol')&&(!Number.isSafeInteger(state.workerProtocol)||state.workerProtocol<1))throw new Error('Invalid worker protocol or queue; original state preserved');
  return state;
}
// The old uninstaller pauses admission and revokes boot grants after prepare.
// Carry those exact authority reductions forward; never restore a removed grant.
function shutdownState(before,current){
  const next=normalizeJournal(before),now=normalizeJournal(current);
  if(now.workerQueue.paused===true)next.workerQueue.paused=true;
  for(const routine of next.routines){const row=now.routines.find(value=>value.id===routine.id);if(row&&!Object.hasOwn(row,'bootGrant'))delete routine.bootGrant;}
  if(Object.hasOwn(now,'extensions'))next.extensions=now.extensions;
  return next;
}
function matchesCheckpoint(before,current){return migrationDigest(shutdownState(before,current))===migrationDigest(normalizeJournal(current));}
function downgrade(from,to){const tuple=value=>/^a?(\d+)\.(\d+)(?:\.(\d+))?/.exec(value)?.slice(1).map(value=>Number(value||0)),a=tuple(from),b=tuple(to);if(!a||!b)return true;for(let i=0;i<3;i++){if(b[i]<a[i])return true;if(b[i]>a[i])return false;}return false;}
async function atomic(file,value){const temporary=file+'.'+randomUUID()+'.tmp';try{await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600,flush:true});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}}
function assertEvidence(before,after){
  before=normalizeJournal(before);after=normalizeJournal(after);
  if(!after||!Array.isArray(after.jobs)||!Array.isArray(after.runs)||!Array.isArray(after.routines))throw new Error('Migration omitted the worker journal');
  for(const job of before.jobs||[]){const current=after.jobs.find(value=>value.id===job.id);if(!current||(job.outputs||[]).some(output=>!(current.outputs||[]).some(value=>digest(value)===digest(output))))throw new Error('Migration lost a stable job or committed output receipt');}
  for(const run of before.runs||[])for(const event of run.toolEvents||[]){if(!event.intent)continue;const current=after.runs.find(value=>value.id===run.id)?.toolEvents?.find(value=>value.id===event.id);if(!current||digest(current.intent)!==digest(event.intent))throw new Error('Migration changed a pending or completed action intent/receipt');}
}
async function createWorkerUpdate({directory,namespace,protocol=1,clock=()=>new Date().toISOString(),onPhase=()=>{}}){
  if(!path.isAbsolute(directory)||!namespace||!Number.isSafeInteger(protocol)||protocol<1)throw new Error('Invalid independent worker update location');await fs.mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'worker-update.json');let transaction;try{transaction=JSON.parse(await fs.readFile(file,'utf8'));if(!object(transaction)||transaction.namespace!==namespace||transaction.schemaVersion!==1||!validId(transaction.id)||!['requested','quiescing','quiesced','migrating','migrated','committed','rolled_back','needs_attention'].includes(transaction.phase)||typeof transaction.fromVersion!=='string'||typeof transaction.toVersion!=='string'||typeof transaction.wasPaused!=='boolean'||!Number.isSafeInteger(transaction.fromProtocol)||transaction.fromProtocol<1||!Number.isSafeInteger(transaction.toProtocol)||transaction.toProtocol<1||transaction.checkpoint!==undefined&&transaction.checkpoint!==transaction.id+'.before.json'||(transaction.checkpoint!==undefined)!==(transaction.checkpointDigest!==undefined)||transaction.checkpointDigest!==undefined&&!validDigest(transaction.checkpointDigest)||transaction.migratedDigest!==undefined&&!validDigest(transaction.migratedDigest)||['quiesced','migrating','migrated','committed'].includes(transaction.phase)&&!transaction.checkpoint)throw new Error('Update journal belongs to another profile or schema');}catch(error){if(error.code!=='ENOENT')throw error;}
  async function phase(value,extra={}){transaction={...transaction,...extra,phase:value,updatedAt:clock()};await atomic(file,transaction);await onPhase(value,structuredClone(transaction));return structuredClone(transaction);}
  return {
    status:()=>transaction?structuredClone(transaction):null,
    async verifyCheckpoint({readState}){
      if(!transaction||transaction.phase!=='quiesced'||!transaction.checkpoint)throw new Error('Worker checkpoint requires review before installer handoff');
      const before=JSON.parse(await fs.readFile(path.join(directory,transaction.checkpoint),'utf8'));if(digest(before)!==transaction.checkpointDigest)throw new Error('Worker checkpoint differs from its receipt');
      const current=normalizeJournal(await readState());assertEvidence(before,current);
      if(current.workerQueue.paused!==true||!matchesCheckpoint(before,current))throw new Error('Profile changed after quiesce; installer handoff requires review');
      return structuredClone(transaction);
    },
    async prepare({id=randomUUID(),fromVersion,toVersion,fromProtocol=1,toProtocol=protocol,wasPaused,quiesce,checkpoint}){
      if(!validId(id)||typeof fromVersion!=='string'||typeof toVersion!=='string'||!Number.isSafeInteger(fromProtocol)||!Number.isSafeInteger(toProtocol)||fromProtocol<1||toProtocol<1||typeof wasPaused!=='boolean')throw new Error('Invalid worker update request');
      if(transaction&&!['committed','rolled_back'].includes(transaction.phase)){
        // A retry is not permission to adopt newer effects or an arbitrary
        // pre-existing snapshot. Inspect both metadata and the actual file.
        const snapshot=path.join(directory,transaction.id+'.before.json');let before;
        try{before=JSON.parse(await fs.readFile(snapshot,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
        if(before!==undefined||transaction.checkpoint||transaction.checkpointDigest||transaction.migratedDigest){
          if(before===undefined||transaction.checkpointDigest&&digest(before)!==transaction.checkpointDigest)throw new Error('Worker checkpoint differs from its receipt');
          if(!transaction.checkpoint&&transaction.phase!=='quiescing')throw new Error('Unreceipted worker checkpoint requires review');
          if(transaction.toVersion!==toVersion||transaction.toProtocol!==toProtocol||!['quiescing','quiesced','migrating'].includes(transaction.phase)||transaction.migratedDigest)throw new Error('Recover the existing worker update before starting another');
          await quiesce();const current=normalizeJournal(await checkpoint());assertEvidence(before,current);
          if(!matchesCheckpoint(before,current))throw new Error('Profile changed after quiesce; migration requires review');
          return phase('quiesced',{checkpoint:path.basename(snapshot),checkpointDigest:digest(before),bootDisabled:transaction.toProtocol<transaction.fromProtocol||downgrade(transaction.fromVersion,transaction.toVersion)});
        }
        if(!['requested','quiescing','needs_attention'].includes(transaction.phase))throw new Error('Recover the existing worker update before starting another');
        // Published legacy failures left only quiescing/needs_attention metadata.
        // Archive it for diagnosis. No snapshot, intent or receipt is removed.
        const current=normalizeJournal(await checkpoint());assertEvidence(current,current);
        await atomic(path.join(directory,transaction.id+'.'+randomUUID()+'.superseded.json'),transaction);
      }
      // Validate before creating failure metadata; take the final snapshot only
      // after quiesce, which may finish and persist an in-flight receipt.
      normalizeJournal(await checkpoint());
      try{await fs.lstat(path.join(directory,id+'.before.json'));throw new Error('Worker checkpoint identity already exists; original snapshot preserved');}catch(error){if(error.code!=='ENOENT')throw error;}
      transaction={schemaVersion:1,namespace,id,fromVersion,toVersion,fromProtocol,toProtocol,wasPaused,createdAt:clock(),phase:'requested'};await phase('quiescing');await quiesce();const state=normalizeJournal(await checkpoint());assertEvidence(state,state);const snapshot=path.join(directory,id+'.before.json');await atomic(snapshot,state);return phase('quiesced',{checkpointDigest:digest(state),checkpoint:path.basename(snapshot),pendingJobs:(state.jobs||[]).filter(job=>!['completed','failed','canceled','abandoned'].includes(job.status)).map(job=>({id:job.id,status:job.status,step:job.step||null})),bootDisabled:toProtocol<fromProtocol||downgrade(fromVersion,toVersion)});
    },
    async migrate({readState,writeState,transform=value=>value}){
      if(!transaction||!['quiesced','migrating'].includes(transaction.phase))throw new Error('Worker must be quiesced before migration');
      const before=JSON.parse(await fs.readFile(path.join(directory,transaction.checkpoint),'utf8'));if(digest(before)!==transaction.checkpointDigest)throw new Error('Worker checkpoint differs from its receipt');
      if(transaction.toProtocol>protocol)throw new Error('This worker cannot load the requested newer schema');await phase('migrating');const current=await readState();
      const next=normalizeJournal(await transform(normalizeJournal(before)));assertEvidence(before,next);next.workerProtocol=transaction.toProtocol;next.workerQueue={...(next.workerQueue||{}),paused:true};
      if(transaction.bootDisabled)for(const routine of next.routines){routine.enabled=false;delete routine.bootGrant;routine.upgradeReviewRequired=true;}
      if(!matchesCheckpoint(before,current)&&!matchesCheckpoint(next,current))throw new Error('Profile changed after quiesce; migration requires review');
      const reduced=shutdownState(next,current);await writeState(reduced);return phase('migrated',{migratedDigest:digest(reduced)});
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
      assertEvidence(current,before);
      // Conversations, projects and other non-action data are evidence too.
      // An unknown transform or a later writer must be reviewed, not rolled back.
      if(!matchesCheckpoint(before,current))throw new Error('Profile changed after quiesce; recovery requires review');
      const restored=shutdownState(before,current);restored.workerQueue.paused=true;for(const routine of restored.routines)delete routine.bootGrant;await writeState(restored);return phase('rolled_back',{reopened:false});
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
module.exports={createWorkerUpdate,prepareWorkerStartup,assertWorkerEvidenceRetained:assertEvidence,normalizeWorkerJournal:normalizeJournal};
