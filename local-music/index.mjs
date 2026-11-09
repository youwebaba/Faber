import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {validate} from '../core/registry.mjs';
import {scanLocalModels} from '../local-models/library.mjs';
import {readGGUFMetadata} from '../local-models/details.mjs';
import {killOwnedProcess} from '../local-models/index.mjs';
import {noLinks,outputPath} from '../model-hub/paths.mjs';
import {verifyMusicRuntime} from './integrity.mjs';

const roles={language_model:['mm3-lm','lm_model'],rvq_depth_decoder:['mm3-depth','depth_model'],transformer:['mm3-dit','dit_model'],condition_encoder:['mm3-cond','cond_model'],vocoder:['mm3-vae','vae_model']};
export const musicGenerationSchema={type:'object',additionalProperties:false,required:['modelId','caption','lyrics'],properties:{
  modelId:{type:'string',minLength:1,maxLength:300},caption:{type:'string',minLength:1,maxLength:12000},lyrics:{type:'string',minLength:1,maxLength:12000},
  duration:{type:'number',minimum:1,maximum:360},steps:{type:'integer',minimum:2,maximum:100},seed:{type:'integer',minimum:0,maximum:4294967295},
}};

// One owned CLI per generation: no open server port, Python/model code, or cloud fallback.
export function runMusicProcess(executable,args,{cwd,signal,spawnImpl=spawn,killProcess=killOwnedProcess}={}){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const env={...process.env};delete env.GGML_BACKEND_PATH;
    const child=spawnImpl(executable,args,{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let logs='',failure,kill;
    const abort=()=>{failure=signal.reason instanceof Error?signal.reason:new Error('Music generation canceled');kill=killProcess(child).catch(error=>{failure=error;});};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    for(const stream of [child.stdout,child.stderr])stream?.on('data',bytes=>{logs=(logs+bytes.toString('utf8')).slice(-16000);});
    child.once('error',error=>{failure=error;});
    child.once('close',async code=>{
      signal?.removeEventListener('abort',abort);await kill;
      if(failure)return reject(failure);
      if(code!==0)return reject(new Error(`Music3 generation failed (${code}). ${logs}`));
      resolve();
    });
  });
}

export function createLocalMusic({dataDir,sourceDir,getHubState,withModelFiles,runtimeDirectory=path.join(sourceDir,'.runtime','music-runtime'),runProcess=runMusicProcess,verifyRuntime=verifyMusicRuntime,readMetadata=readGGUFMetadata}){
  const lifetime=new AbortController(),operations=new Set();let running=false,closed=false;
  async function generate(args,ctx){
    validate(args,musicGenerationSchema);ctx.signal?.throwIfAborted();
    if(closed)throw new Error('Music runtime is closed');
    if(running)throw new Error('Music generation is already running. Wait or stop that chat first.');
    if(!ctx.runtime?.publishMedia)throw new Error('Chat audio publishing is unavailable in this session');
    if(!withModelFiles)throw new Error('Music model file coordination is unavailable');
    if(!args.caption.trim()||!args.lyrics.trim())throw new Error('Provide a music caption and lyrics with section tags');
    running=true;
    const signal=ctx.signal?AbortSignal.any([ctx.signal,lifetime.signal]):lifetime.signal;
    try{
      const hub=await getHubState(),library=await scanLocalModels({directory:hub.downloadDirectory,downloads:hub.downloads});
      const selected=library.models.find(model=>model.id===args.modelId&&model.format==='minimax-music3');
      if(!selected?.available)throw new Error(selected?.reason||'Select a complete MiniMax Music3 package from Models');
      const lock=JSON.parse(await fs.readFile(path.join(sourceDir,'build','music-runtime-lock.json'),'utf8'));
      const executable=await verifyRuntime(runtimeDirectory,lock,signal);
      return await withModelFiles(library.directory,selected.files,async()=>{
        signal.throwIfAborted();
        const current=await scanLocalModels({directory:library.directory,downloads:hub.downloads});
        const model=current.models.find(value=>value.id===selected.id&&value.available);
        if(!model)throw new Error('Music model files changed; refresh Models before generating');
        const request={caption:args.caption,lyrics:args.lyrics,duration:args.duration??30,steps:args.steps??30,seed:args.seed??42,lm_seed:args.seed??42,output_format:'wav16',lm_batch_size:1,synth_batch_size:1};
        let modelDirectory;
        const identities=[];
        for(const [role,[architecture,field]] of Object.entries(roles)){
          const relative=model.components?.[role];if(typeof relative!=='string'||!model.files.includes(relative))throw new Error(`Missing Music3 component: ${role}`);
          const target=await outputPath(library.directory,relative),parent=path.dirname(target);
          if(modelDirectory&&modelDirectory!==parent)throw new Error('Music3 components must be in the same model folder');modelDirectory=parent;
          const metadata=await readMetadata(target,{signal});
          if(!metadata.complete||metadata.architecture!==architecture)throw new Error(`Invalid Music3 ${role} GGUF architecture`);
          identities.push([target,await fs.stat(target)]);request[field]=path.basename(target);
        }
        const jobs=path.join(dataDir,'music-jobs');await fs.mkdir(jobs,{recursive:true});await noLinks(jobs);
        const job=await fs.mkdtemp(path.join(jobs,'generation-'));
        try{
          const input=path.join(job,'request.json'),output=path.join(job,'music.wav');
          await fs.writeFile(input,JSON.stringify(request),{flag:'wx',mode:0o600});signal.throwIfAborted();
          // Bound the upstream registry scan to the selected folder and recheck identities after metadata reads.
          for(const [target,before] of identities){await noLinks(target);const after=await fs.stat(target);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Music component changed before generation');}
          await runProcess(executable,['--models',modelDirectory,'--request',input,'--out',output],{cwd:job,signal});
          signal.throwIfAborted();await noLinks(output);
          const file=await fs.open(output,'r');
          try{return {media:await ctx.runtime.publishMedia({chatId:ctx.chat.id,file,name:'music.wav',signal}),modelId:model.id,durationRequested:request.duration,seed:request.seed};}
          finally{await file.close();}
        }finally{await fs.rm(job,{recursive:true,force:true});}
      },signal);
    }finally{running=false;}
  }
  return {
    tools(){return [{name:'music_generate',permission:'files',description:'Generate a local MiniMax Music3 song from a caption and section-tagged lyrics using a complete downloaded five-component Music3 package. Returns playable chat audio (also over paired remote sessions); no cloud service or paid API. modelId comes from local_models_list. Duration 1–360 seconds (the model may end earlier); default 30 seconds, 30 synthesis steps, seed 42. CPU generation can be slow. Does not load the package as a chat model.',parameters:musicGenerationSchema,execute(args,ctx){const operation=generate(args,ctx);operations.add(operation);operation.then(()=>operations.delete(operation),()=>operations.delete(operation));return operation;}}];},
    async close(){closed=true;lifetime.abort(new Error('Music runtime closed'));await Promise.allSettled([...operations]);},
  };
}
