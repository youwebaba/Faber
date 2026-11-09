import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createLocalMusic,runMusicProcess} from '../local-music/index.mjs';
import {musicDigest,verifyMusicRuntime} from '../local-music/integrity.mjs';
import {scanLocalModels} from '../local-models/library.mjs';
import {createMediaStore} from '../core/media.mjs';

const names={language_model:'Q5_K_M',rvq_depth_decoder:'Q8_0',transformer:'Q4_K_M',condition_encoder:'F32',vocoder:'F32'};
const arches={language_model:'mm3-lm',rvq_depth_decoder:'mm3-depth',transformer:'mm3-dit',condition_encoder:'mm3-cond',vocoder:'mm3-vae'};
function wav(){const bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(44100,24);bytes.writeUInt32LE(176400,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4,40);return bytes;}
async function fixture(t,overrides={}){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-music-test-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const models=path.join(dir,'models'),source=path.join(dir,'source'),data=path.join(dir,'profile');await fs.mkdir(models);await fs.mkdir(path.join(source,'build'),{recursive:true});await fs.writeFile(path.join(source,'build','music-runtime-lock.json'),'{}');
  for(const [role,quant] of Object.entries(names)){const header=Buffer.alloc(24);header.write('GGUF');header.writeUInt32LE(3,4);await fs.writeFile(path.join(models,`MiniMax-Music3-${role}-${quant}.gguf`),header);}
  const library=await scanLocalModels({directory:models}),selected=library.models.find(model=>model.format==='minimax-music3');assert.ok(selected?.available);
  let published,received;
  const store=createMediaStore({dataDir:data,findReference:(_chat,id)=>published?.id===id?published:undefined});
  const manager=createLocalMusic({dataDir:data,sourceDir:source,getHubState:async()=>({downloadDirectory:models,downloads:[]}),withModelFiles:async(_root,_files,callback)=>callback(),verifyRuntime:async()=>'/pinned/mm-synth.exe',readMetadata:async target=>({complete:true,architecture:arches[Object.keys(names).find(role=>path.basename(target).includes(`-${role}-`))]}),runProcess:async(executable,args,options)=>{received={executable,args,request:JSON.parse(await fs.readFile(args[args.indexOf('--request')+1],'utf8')),options};await fs.writeFile(args[args.indexOf('--out')+1],wav());},...overrides});
  t.after(()=>manager.close());
  const ctx={chat:{id:'chat-music'},signal:new AbortController().signal,runtime:{publishMedia:async options=>(published=await store.publish(options))}};
  return {dir,models,selected,manager,ctx,store,received:()=>received,published:()=>published,call:args=>manager.tools()[0].execute({modelId:selected.id,caption:'Quiet piano, 80 BPM',lyrics:'[instrumental]',...args},ctx)};
}

test('Music3 request routes all five components and publishes bounded durable WAV bytes',async t=>{
  const f=await fixture(t),result=await f.call({duration:2,steps:2,seed:7});assert.equal(result.media.kind,'audio');assert.equal(result.media.bytes,48);
  const request=f.received().request;assert.equal(request.output_format,'wav16');assert.equal(request.lm_batch_size,1);assert.equal(request.seed,7);
  for(const field of ['lm_model','depth_model','dit_model','cond_model','vae_model'])assert.match(request[field],/^MiniMax-Music3-.*\.gguf$/);
  assert.equal((await fs.readdir(path.join(f.dir,'profile','music-jobs'))).length,0);
  assert.deepEqual(Buffer.from((await f.store.read({chatId:'chat-music',mediaId:result.media.id,length:48})).data,'base64'),wav());
  await assert.rejects(f.store.read({chatId:'another-chat',mediaId:result.media.id,length:48}));
});
test('Music3 validates tool arguments and actual component architecture before spawning',async t=>{
  const f=await fixture(t,{readMetadata:async()=>({complete:true,architecture:'qwen3'})});
  await assert.rejects(f.call({duration:361}),/range/);await assert.rejects(f.call({steps:1}),/range/);await assert.rejects(f.call({caption:' '}),/caption/);
  await assert.rejects(f.call(),/architecture/);assert.equal(f.received(),undefined);assert.equal(f.published(),undefined);
});
test('Music3 cancellation kills owned process, waits for close and rejects without publication',async()=>{
  const controller=new AbortController();let child,killed=false;
  const running=runMusicProcess('unused',[],{cwd:os.tmpdir(),signal:controller.signal,spawnImpl:()=>{child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe'],windowsHide:true});return child;},killProcess:async owned=>{assert.equal(owned,child);killed=true;owned.kill();}});
  controller.abort(new Error('Stopped by user'));await assert.rejects(running,/Stopped by user/);assert.equal(killed,true);assert.ok(child.exitCode!==null||child.signalCode!==null);
});
test('Music3 close cancels active generation, cleans temporary request and rejects concurrent work',async t=>{
  let started;const began=new Promise(resolve=>started=resolve);
  const f=await fixture(t,{runProcess:async(_exe,_args,{signal})=>{started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const pending=f.call();await began;await assert.rejects(f.call(),/already running/);const rejected=assert.rejects(pending,/closed/);await f.manager.close();await rejected;
  assert.equal(f.published(),undefined);assert.deepEqual(await fs.readdir(path.join(f.dir,'profile','music-jobs')),[]);
});
test('Music3 runtime rejects tampered binaries and unreviewed backend DLLs',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'faber-music-lock-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const binary=path.join(directory,'mm-synth.exe');await fs.writeFile(binary,'pinned runner');const manifest={schemaVersion:1,executable:'mm-synth.exe',files:[{path:'mm-synth.exe',size:13,sha256:await musicDigest(binary)}]};await fs.writeFile(path.join(directory,'runtime-manifest.json'),JSON.stringify(manifest));
  assert.equal(await verifyMusicRuntime(directory,manifest),binary);await fs.writeFile(path.join(directory,'ggml-unreviewed.dll'),'extra');await assert.rejects(verifyMusicRuntime(directory,manifest),/Unreviewed/);await fs.rm(path.join(directory,'ggml-unreviewed.dll'));await fs.writeFile(binary,'changed bytes');await assert.rejects(verifyMusicRuntime(directory,manifest),/integrity mismatch/);
});
