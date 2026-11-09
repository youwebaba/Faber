import path from 'node:path';
import {createHash} from 'node:crypto';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const localTools=new Set(['system_time','files_list','files_read','files_write','folder_report']);
const localPath=value=>typeof value==='string'&&path.isAbsolute(value)&&!value.startsWith('\\\\')&&!value.startsWith('//')&&!/[\\/]OneDrive(?:[ -][^\\/]+)?[\\/]/i.test(value);
const modelIdentity=model=>({id:model.id,format:model.format,directory:model.directory,files:model.files,sizeBytes:model.sizeBytes,mtimeMs:model.mtimeMs});
export function bootEligibility({routine,project,model}){
  const definition=routine?.definition,reasons=[];
  if(!definition)return {eligible:false,reasons:['Review a routine first']};
  if(routine.revokedAt||routine.restoreRequired)reasons.push('Restore or revoked authority requires interactive review');
  if(!project||project.archived||project.id!==definition.projectId||!localPath(project.path))reasons.push('Select a reviewed local project outside network and sign-in-dependent sync folders');
  if(definition.resourceScope)reasons.push('Connected-account credentials and actions require the interactive worker');
  if(definition.tools.some(tool=>!localTools.has(tool)))reasons.push('Desktop, browser, shell, network, connector and delegated tools wait for an interactive session');
  if(definition.tools.some(tool=>['files_write','folder_report'].includes(tool))&&!definition.grants.includes('files'))reasons.push('File writes require the separately reviewed scoped grant');
  if(!definition.localModelId||!model?.available||model.id!==definition.localModelId||!['gguf','safetensors'].includes(model.format))reasons.push('Select an available owned local model; external/API credentials are unavailable before sign-in');
  if(model&&!localPath(model.directory))reasons.push('Boot weights must be stored on local disk outside network and sign-in-dependent sync folders');
  if(!definition.limits||definition.limits.runtimeMs===0)reasons.push('Choose a finite per-job runtime budget for boot work');
  if(definition.report&&!definition.tools.includes('folder_report'))reasons.push('Review the structured folder-report tool');
  return {eligible:reasons.length===0,reasons};
}
export function reviewBootGrant({routine,project,model,hardware={mode:'cpu',threads:2},clock=()=>new Date().toISOString()}){
  const result=bootEligibility({routine,project,model});if(!result.eligible)throw new Error(result.reasons.join('; '));if(hardware.mode!=='cpu'||!Number.isInteger(hardware.threads)||hardware.threads<1||hardware.threads>64)throw new Error('Review a bounded CPU-only boot hardware profile');
  return {schemaVersion:1,eligible:true,reviewedAt:clock(),authorization:routine.authorization,definitionHash:digest(routine.definition),projectPath:project.path,modelIdentityHash:digest(modelIdentity(model)),hardware:{...hardware}};
}
export function checkBootGrant({routine,project,model}){
  const eligibility=bootEligibility({routine,project,model}),grant=routine?.bootGrant;
  if(!grant?.eligible)return {eligible:false,reasons:['This routine has no explicit boot grant']};
  if(grant.schemaVersion!==1||grant.authorization!==routine.authorization||grant.definitionHash!==digest(routine.definition)||grant.projectPath!==project?.path||grant.modelIdentityHash!==digest(modelIdentity(model||{})))return {eligible:false,reasons:['Reviewed boot scope, grants, model files or project identity changed; review in the signed-in app']};
  return eligibility;
}
export const bootToolNames=Object.freeze([...localTools]);
