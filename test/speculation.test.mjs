import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectSpeculation,prepareSpeculation,speculationProfile,savedSpeculation,resolveSpeculation,speculationCapabilities,speculationTiming} from '../local-models/speculation.mjs';
const capabilities={nativeMtp:true,draftModel:true,draftDevice:true},head=['eh_proj','enorm','hnorm','shared_head_norm'].map(part=>({name:`blk.24.nextn.${part}.weight`,elements:1024})),metadata=(tensors=head,architecture='qwen35')=>({complete:true,architecture,tensors,splitCount:null,splitNo:null,splitTensors:null}),model={id:'target',format:'gguf',complete:true,available:true,files:['target.gguf'],relativePath:'target.gguf'};
test('native MTP requires complete actual heads and a qualified architecture, not an MTP repository label',async()=>{
 const inspect=reader=>inspectSpeculation({directory:os.tmpdir(),model:{...model,label:'MTP-native'},capabilities,reader});
 assert.equal((await inspect(async()=>metadata())).nativeMtp.supported,true);
 for(const data of [metadata([]),metadata(head.slice(1)),metadata(head,'llama'),{...metadata(),complete:false}])assert.equal((await inspect(async()=>data)).nativeMtp.supported,false);
 const duplicate=await inspect(async()=>metadata([...head,...head]));assert.equal(duplicate.metadataComplete,false);
 const split=await inspectSpeculation({directory:os.tmpdir(),model:{...model,files:['one.gguf','two.gguf']},capabilities,reader:async()=>metadata()});assert.equal(split.nativeMtp.supported,false);
});
test('Safetensors CPU and music routes have explicit unavailable speculation; Off needs no metadata',async()=>{
 for(const format of ['safetensors','minimax-music3']){const info=await inspectSpeculation({directory:os.tmpdir(),model:{...model,format},capabilities,reader:()=>{throw Error('Unexpected read');}});assert.equal(info.nativeMtp.supported,false);assert.equal(info.draftModel.supported,false);}
 assert.deepEqual((await prepareSpeculation({profile:{mode:'off',tokens:7}})).args,[]);
});
test('profiles reject invalid token counts, unknown options and unsupported saved values without losing them',()=>{
 for(const value of [{mode:'native_mtp',tokens:0},{mode:'native_mtp',tokens:17},{mode:'native_mtp',tokens:1.5},{mode:'off',tokens:3,command:'unsafe'},{mode:'draft_model',tokens:3},{mode:'off',tokens:3,draftModelId:'other'}])assert.throws(()=>speculationProfile(value));
 const future={mode:'future',tokens:24,opaque:['keep']};assert.equal(savedSpeculation(future).speculation,null);assert.throws(()=>resolveSpeculation(undefined,future),/Choose a supported/);assert.deepEqual(resolveSpeculation({mode:'off',tokens:3},future),{mode:'off',tokens:3});assert.deepEqual(future,{mode:'future',tokens:24,opaque:['keep']});
});
test('runtime flags are feature detected separately for native heads, full drafts and draft placement',()=>{
 assert.deepEqual(speculationCapabilities('--spec-type draft-mtp --spec-draft-n-max --slots'),{nativeMtp:true,draftModel:false,draftDevice:false});assert.equal(speculationCapabilities('--spec-type draft-simple --spec-draft-model --slots').draftModel,false);
});
test('separate drafts require distinct compatible assets and CPU placement, with explicit immutable file arguments',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-spec-assets-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.writeFile(path.join(directory,'target.gguf'),'target');await fs.writeFile(path.join(directory,'draft.gguf'),'draft');const draft={...model,id:'draft',files:['draft.gguf'],relativePath:'draft.gguf'},options={directory,model,models:[model,draft],profile:{mode:'draft_model',tokens:4,draftModelId:draft.id},capabilities,configuration:{mode:'cpu',threads:2},reader:async()=>metadata()};
 const result=await prepareSpeculation(options);assert.deepEqual(result.draftFiles,draft.files);assert.ok(result.args.includes('draft-simple'));assert.equal(result.args[result.args.indexOf('--spec-draft-n-max')+1],'4');assert.equal(result.args[result.args.indexOf('--spec-draft-device')+1],'none');
 await assert.rejects(prepareSpeculation({...options,models:[model]}),/distinct complete/);await assert.rejects(prepareSpeculation({...options,profile:{...options.profile,draftModelId:model.id}}),/distinct complete/);await assert.rejects(prepareSpeculation({...options,configuration:{mode:'auto'}}),/CPU mode only/);await assert.rejects(prepareSpeculation({...options,reader:async filename=>metadata(head,filename.endsWith('draft.gguf')?'llama':'qwen35')}),/architectures/);
 await fs.rm(path.join(directory,'draft.gguf'));await fs.link(path.join(directory,'target.gguf'),path.join(directory,'draft.gguf'));await assert.rejects(prepareSpeculation(options),/aliases target/);
});
test('native timing counters are scoped to completed-request tasks and never parse arbitrary prompt text',()=>{
 const line='0.04.853 I slot print_timing: id  0 | task 20 | ';const accepted=speculationTiming(line+'draft acceptance = 0.93333 (28 accepted / 30 generated), mean len = 3.80');assert.equal(accepted.draftedTokens,30);assert.equal(accepted.acceptedTokens,28);
 const decode=speculationTiming(line+'eval time = 1852.87 ms / 39 tokens (48.76 ms per token, 20.51 tokens per second)',accepted);assert.equal(decode.tokensPerSecond,20.51);assert.equal(decode.draftedTokens,30);
 const next=speculationTiming(line.replace('task 20','task 21')+'prompt eval time = 20.0 ms / 17 tokens');assert.equal(next.draftedTokens,undefined);assert.equal(speculationTiming('user says draft acceptance = 1.0 (9 accepted / 9 generated)'),null);
});
