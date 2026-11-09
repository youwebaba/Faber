import {createHash,randomUUID} from 'node:crypto';
import {validate} from './registry.mjs';
import {routineDefinitionSchema} from './routines.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const definitionKeys=['name','projectId','providerId','model','instructions','inputs','outputs','completion','tools','paths','grants','schedule','fileTrigger','fileOverlap','limits','report','localModelId'];
const pick=(row,keys)=>Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
const credential=/^(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|password|client[-_]?secret|authorization|credentials?|cookies?|headers?|secret|private[-_]?key)$/i;
function scrub(value,depth=0){
  if(depth>40)throw new Error('Backup structure exceeds its depth bound');
  if(Array.isArray(value))return value.map(item=>scrub(item,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!credential.test(key)&&!['__proto__','constructor','prototype'].includes(key)).map(([key,item])=>[key,scrub(item,depth+1)]));
  if(typeof value!=='string')return value;
  return value.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi,'[authorization redacted]').replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}/g,'[credential redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[token redacted]').replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|client_secret|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,'$1[redacted]').replace(/https?:\/\/[^\s<>"']+/gi,text=>{try{const url=new URL(text);url.username='';url.password='';url.search='';url.hash='';return url.href;}catch{return '[URL redacted]';}});
}
const cleanDefinition=value=>scrub(pick(value,definitionKeys));
export function exportRoutineBackup({state,namespace,watermark,clock=()=>new Date().toISOString()}){
  if(typeof namespace!=='string'||!namespace||!watermark||watermark.namespace!==namespace||!Number.isSafeInteger(watermark.sequence)||watermark.sequence<0||!/^[a-f0-9]{64}$/.test(watermark.head))throw new Error('An independent profile ledger watermark is required before backup');
  const payload={schemaVersion:1,kind:'faber-routine-backup',namespace,createdAt:clock(),watermark:pick(watermark,['namespace','sequence','head']),projects:state.projects.map(project=>pick(project,['id','name'])),connections:state.providers.map(provider=>pick(provider,['id','name','kind','model'])),
    routines:state.routines.map(routine=>({...pick(routine,['id','revision','createdAt','updatedAt','revokedAt']),reviewedResourceScope:scrub(routine.definition.resourceScope||null),definition:cleanDefinition(routine.definition),revisions:(routine.revisions||[]).map(revision=>({...pick(revision,['revision','createdAt']),definition:cleanDefinition(revision.definition)}))})),
    jobs:state.jobs.map(job=>({...scrub(pick(job,['id','routineId','revision','inputs','preview','status','attempts','runIds','proposals','outputs','createdAt','startedAt','endedAt','limits','budget','triggers','reportDate','report','inputReceipts','review','reviewRequired','reason','effectWatermark'])),definition:cleanDefinition(job.definition),reviewedResourceScope:scrub(job.definition.resourceScope||null),journal:state.runs.filter(run=>run.jobId===job.id).map(run=>scrub(pick(run,['id','parentRunId','status','startedAt','endedAt','error','toolEvents'])))})),scheduler:scrub(state.scheduler||{cursors:{},receipts:[],notices:[]})};
  const sanitized=scrub(payload),serialized=JSON.stringify(sanitized);if(Buffer.byteLength(serialized)>32*1024*1024)throw new Error('Routine backup exceeds 32 MiB; no partial archive was created');return {...sanitized,sha256:digest(serialized)};
}
export function readRoutineBackup(value,{namespace,watermark}){
  if(typeof value==='string'){if(Buffer.byteLength(value)>32*1024*1024)throw new Error('Backup exceeds 32 MiB');value=JSON.parse(value);}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid routine backup');const {sha256,...payload}=value;
  if(payload.schemaVersion!==1||payload.kind!=='faber-routine-backup'||payload.namespace!==namespace||sha256!==digest(JSON.stringify(payload))||JSON.stringify(scrub(payload))!==JSON.stringify(payload))throw new Error('Backup integrity, credential filtering or profile namespace differs');
  if(!watermark||watermark.namespace!==namespace||payload.watermark?.namespace!==namespace||!Number.isSafeInteger(payload.watermark?.sequence)||payload.watermark.sequence<0||!/^[a-f0-9]{64}$/.test(payload.watermark.head)||payload.watermark.sequence>watermark.sequence||payload.watermark.sequence===watermark.sequence&&payload.watermark.head!==watermark.head)throw new Error('The independent effect history is missing or older than this backup; restore cannot authorize effects');
  for(const collection of ['routines','jobs','projects','connections'])if(!Array.isArray(payload[collection])||payload[collection].length>100000||new Set(payload[collection].map(row=>row.id)).size!==payload[collection].length)throw new Error('Invalid backup collection');
  for(const row of [...payload.routines,...payload.jobs]){validate(row.definition,routineDefinitionSchema);if(typeof row.id!=='string'||!row.id||['__proto__','constructor','prototype'].includes(row.id)||typeof row.routineId==='string'&&!payload.routines.some(routine=>routine.id===row.routineId))throw new Error('Backup has an invalid routine/job identity');}
  return structuredClone(payload);
}
// Restore adds evidence to the existing profile; it never restores credentials, authority or effect history.
export function restoreRoutineBackup(state,backup,{namespace,watermark,clock=()=>new Date().toISOString()}){
  const payload=readRoutineBackup(backup,{namespace,watermark}),at=clock(),result=structuredClone(state);result.workerQueue={paused:true};result.routines??=[];result.jobs??=[];result.runs??=[];
  const restored=[];
  for(const source of payload.routines){let routine=result.routines.find(row=>row.id===source.id);const newer=routine&&routine.revision>source.revision,definition=newer?cleanDefinition(routine.definition):source.definition;if(!routine){routine={...source,enabled:false,authorization:randomUUID(),restoredAt:at,restoreRequired:true};result.routines.push(routine);}else{routine.enabled=false;routine.authorization=randomUUID();routine.restoreRequired=true;routine.restoredAt=at;}
    routine.restoredRequestedDefinition=cleanDefinition(source.definition);routine.restoredResourceScope=source.reviewedResourceScope;routine.definition={...definition,grants:[]};if(!newer)routine.revisions=source.revisions||[];routine.restoreRequirements={project:true,connection:true,grants:true};delete routine.bootGrant;restored.push(routine.id);
  }
  for(const source of payload.jobs){const existing=result.jobs.find(job=>job.id===source.id);if(existing){existing.status='needs_attention';existing.reason='Older backup was merged with newer local evidence; review destination receipts before resuming';existing.restoreRequired=true;existing.requiresEffectApproval=true;existing.independentEffects=(watermark.entries||[]).filter(entry=>entry.jobId===existing.id);continue;}
    const job={...source,restoredResourceScope:source.reviewedResourceScope||null,definition:{...source.definition,grants:[]},status:'needs_attention',authorization:null,restoreRequired:true,requiresEffectApproval:true,independentEffects:(watermark.entries||[]).filter(entry=>entry.jobId===source.id),restoredAt:at,reason:'Restored paused. Rebind project and connection, approve grants, and reconcile independent effect receipts before resuming.',reviewRequired:true};delete job.journal;job.restoredJournal=source.journal;result.jobs.push(job);
  }
  result.restoreHistory??=[];result.restoreHistory.push({id:randomUUID(),at,backupCreatedAt:payload.createdAt,backupWatermark:payload.watermark.sequence,currentWatermark:watermark.sequence,routineIds:restored});
  // Keep the current cursor and ever-observed source receipts; an old archive cannot rewind admission.
  result.scheduler??={cursors:{},receipts:[],notices:[]};const seen=new Set(result.scheduler.receipts.map(row=>row.key));for(const receipt of payload.scheduler?.receipts||[])if(!seen.has(receipt.key)){result.scheduler.receipts.push(receipt);seen.add(receipt.key);}return result;
}
