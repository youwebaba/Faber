import fs from 'node:fs/promises';
import {validate} from '../core/registry.mjs';
import {outputPath} from '../model-hub/paths.mjs';
import {readGGUFMetadata} from './details.mjs';

export const defaultSpeculation={mode:'off',tokens:3};
export const speculationSchema={type:'object',additionalProperties:false,required:['mode','tokens'],properties:{mode:{enum:['off','native_mtp','draft_model']},tokens:{type:'integer',minimum:1,maximum:16},draftModelId:{type:'string',minLength:1,maxLength:300}}};
export function speculationProfile(value=defaultSpeculation){validate(value,speculationSchema);if(value.mode==='draft_model'&&!value.draftModelId)throw new Error('Choose a complete separate draft model');if(value.mode!=='draft_model'&&value.draftModelId!==undefined)throw new Error('Select a draft model only in separate-draft mode');return structuredClone(value);}
export function savedSpeculation(value){try{return {speculation:speculationProfile(value)};}catch{return {speculation:null,speculationWarning:'The saved speculation profile is unsupported in this version. Choose a supported mode before Start.'};}}
export function resolveSpeculation(explicit,saved){if(explicit!==undefined)return speculationProfile(explicit);const result=savedSpeculation(saved);if(!result.speculation)throw new Error(result.speculationWarning);return result.speculation;}
export function speculationCapabilities(help){const base=/--spec-type\b/.test(help)&&/--spec-draft-n-max\b/.test(help)&&/--slots\b/.test(help);return {nativeMtp:base&&/\bdraft-mtp\b/.test(help),draftModel:base&&/\bdraft-simple\b/.test(help)&&/--spec-draft-model\b/.test(help),draftDevice:/--spec-draft-device\b/.test(help)&&/--spec-draft-ngl\b/.test(help)};}

export async function inspectSpeculation({directory,model,capabilities,signal,reader=readGGUFMetadata}){
  const unavailable=reason=>({architecture:null,metadataComplete:false,nativeMtp:{supported:false,reason},draftModel:{supported:false,reason}});
  if(model.format==='safetensors')return unavailable('The pinned Safetensors CPU backend cannot enable native MTP/PagedAttention or separate-draft speculation. Use Off or a compatible managed GGUF runtime.');
  if(model.format!=='gguf'||!model.complete||!model.available)return unavailable('Select a complete available language-model GGUF set. Music and auxiliary assets cannot be speculative targets.');
  const budget={remaining:32*1024*1024,deadline:Date.now()+30000},metadata=[];
  for(const file of model.files){signal?.throwIfAborted();metadata.push(await reader(await outputPath(directory,file),{signal,budget}));}
  const architecture=metadata[0]?.architecture,tensors=metadata.flatMap(item=>item.tensors),names=new Set(tensors.map(tensor=>tensor.name)),split=metadata.some(item=>item.splitCount!==null&&item.splitCount!==undefined),complete=metadata.length===model.files.length&&metadata.every((item,index)=>item.complete&&item.architecture===architecture&&(!split?metadata.length===1:item.splitCount===metadata.length&&item.splitNo===index&&(item.splitTensors===null||item.splitTensors===tensors.length)))&&names.size===tensors.length,heads=[];
  for(const name of names){const match=/^(blk\.\d+\.nextn\.)eh_proj\.weight$/.exec(name);if(match&&['eh_proj','enorm','hnorm','shared_head_norm'].every(part=>names.has(match[1]+part+'.weight')))heads.push(match[1]);}
  const nativeReason=!complete?'Complete bounded metadata is required to validate native MTP heads.':architecture!=='qwen35'?'This managed adapter has qualified native MTP for qwen35 only.':!heads.length?'This target has no complete embedded MTP head; a repository name containing MTP is insufficient.':!capabilities?.nativeMtp?'The selected runtime does not advertise the qualified native-MTP flags.':null;
  const draftReason=!complete||!architecture?'Complete target metadata is required before pairing a draft model.':!capabilities?.draftModel?'This runtime does not advertise separate-draft model support.':null;
  return {architecture,metadataComplete:complete,nativeMtp:{supported:!nativeReason,heads,reason:nativeReason},draftModel:{supported:!draftReason,reason:draftReason,validation:'Matching architecture is checked before launch; the native runtime must validate token vocabularies during startup.'}};
}
export async function prepareSpeculation({directory,model,models,profile,capabilities,configuration,signal,reader=readGGUFMetadata}){
  profile=speculationProfile(profile);
  if(profile.mode==='off')return {profile,args:[],draftFiles:[],info:null};
  const info=await inspectSpeculation({directory,model,capabilities,signal,reader});
  if(profile.mode==='native_mtp'){
    if(!info.nativeMtp.supported)throw new Error(info.nativeMtp.reason);
    return {profile,args:['--spec-type','draft-mtp','--spec-draft-n-max',String(profile.tokens),'--slots'],draftFiles:[],info};
  }
  if(!info.draftModel.supported)throw new Error(info.draftModel.reason);
  if(configuration.mode!=='cpu')throw new Error('Separate-draft placement is qualified in CPU mode only. Select and save CPU hardware before Start, or choose Off/native MTP.');
  const draft=models.find(item=>item.id===profile.draftModelId);
  if(!draft||draft.id===model.id||draft.format!=='gguf'||!draft.complete||!draft.available)throw new Error('Select a distinct complete available GGUF draft model from this library.');
  const draftInfo=await inspectSpeculation({directory,model:draft,capabilities,signal,reader});
  if(!draftInfo.metadataComplete||draftInfo.architecture!==info.architecture)throw new Error('Target and draft architectures are incompatible or unverified. This adapter requires matching architectures and native vocabulary validation.');
  const mainStats=await Promise.all(model.files.map(async file=>fs.lstat(await outputPath(directory,file),{bigint:true}))),draftStats=await Promise.all(draft.files.map(async file=>fs.lstat(await outputPath(directory,file),{bigint:true})));
  if(mainStats.some(main=>draftStats.some(other=>main.dev===other.dev&&main.ino===other.ino)))throw new Error('The draft asset aliases target weights; select a distinct model file set.');
  const args=['--spec-type','draft-simple','--spec-draft-model',await outputPath(directory,draft.relativePath),'--spec-draft-n-max',String(profile.tokens),'--slots'];
  if(configuration.mode==='cpu'){
    if(!capabilities.draftDevice)throw new Error('This runtime cannot guarantee CPU-only draft placement. Update it or choose Off.');args.push('--spec-draft-device','none','--spec-draft-ngl','0');
  }else if(configuration.mode==='custom'){
    if(!capabilities.draftDevice)throw new Error('This runtime cannot apply the selected GPUs to a separate draft model. Choose CPU or Off.');args.push('--spec-draft-device',configuration.gpuIds.join(','));
  }
  if(configuration.threads)args.push('--spec-draft-threads',String(configuration.threads),'--spec-draft-threads-batch',String(configuration.threads));
  return {profile,args,draftFiles:draft.files,info,draft:{id:draft.id,label:draft.label,sizeBytes:draft.sizeBytes,architecture:draftInfo.architecture}};
}
export function speculationTiming(line,previous={}){
  const task=/\bslot\s+print_timing:\s+id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|/.exec(line);if(!task)return null;
  const taskId=`${task[1]}:${task[2]}`,next=previous.taskId===taskId?{...previous}:{taskId};let found=false,match;
  if((match=/draft acceptance\s*=\s*([\d.]+)\s*\(\s*(\d+) accepted\s*\/\s*(\d+) generated\)/.exec(line))){next.acceptedTokens=Number(match[2]);next.draftedTokens=Number(match[3]);next.acceptance=next.draftedTokens?next.acceptedTokens/next.draftedTokens:null;found=true;}
  if((match=/\|\s+eval time\s*=\s*([\d.]+) ms\s*\/\s*(\d+) tokens\s*\([^,]+,\s*([\d.]+) tokens per second\)/.exec(line))){next.decodeMs=Number(match[1]);next.generatedTokens=Number(match[2]);next.tokensPerSecond=Number(match[3]);found=true;}
  if((match=/prompt eval time\s*=\s*([\d.]+) ms\s*\/\s*(\d+) tokens/.exec(line))){next.promptMs=Number(match[1]);next.promptTokens=Number(match[2]);found=true;}
  return found?{...next,source:'Native completed-request timing log',checkedAt:new Date().toISOString()}:null;
}
