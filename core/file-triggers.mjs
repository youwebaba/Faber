import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {containedPath} from '../tools/files.mjs';
import {validate} from './registry.mjs';

export const fileTriggerSchema={type:'object',additionalProperties:false,required:['directory','excludePaths','stableMs'],properties:{directory:{type:'string',minLength:1,maxLength:4096},excludePaths:{type:'array',maxItems:100,items:{type:'string',minLength:1,maxLength:4096}},stableMs:{type:'integer',minimum:500,maximum:60000}}};
const hash=value=>createHash('sha256').update(value).digest('hex');
const relative=(root,target)=>path.relative(root,target).split(path.sep).join('/');
const within=(root,target)=>{const value=path.relative(root,target);return !value||value!=='..'&&!value.startsWith('..'+path.sep)&&!path.isAbsolute(value);};
const signature=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join('/');

export async function scanStableFiles({projectRoot,trigger,observations,processed=new Set(),now=Date.now(),signal,allowed=async()=>true,isOutput=()=>false,maxBytes=64*1024*1024}){
  validate(trigger,fileTriggerSchema);if(!(observations instanceof Map)||!(processed instanceof Set)||!Number.isSafeInteger(now))throw new Error('Invalid file-trigger state');
  const root=await fs.realpath(projectRoot),directory=await containedPath(root,trigger.directory),excluded=[];
  for(const value of trigger.excludePaths)excluded.push(await containedPath(root,value,{missing:true}));
  const ignored=target=>excluded.some(value=>within(value,target))||isOutput(relative(root,target));
  if(ignored(directory))throw new Error('The watched folder is excluded as an output');
  const events=[],errors=[],seen=new Set(),pending=[directory];let count=0;
  const fail=(target,message,version='')=>{const file=relative(root,target);errors.push({path:file,message,key:hash(JSON.stringify([file,message,version]))});};
  while(pending.length){
    signal?.throwIfAborted();const folder=pending.shift();if(ignored(folder))continue;
    if(!await allowed(folder)){fail(folder,'Watched path is outside the routine’s current approved scope');continue;}
    let entries;try{entries=await fs.readdir(folder,{withFileTypes:true});}catch(error){fail(folder,`Cannot inspect watched folder (${error.code||'read error'})`);continue;}
    for(const entry of entries){
      signal?.throwIfAborted();const target=path.join(folder,entry.name),file=relative(root,target);if(ignored(target))continue;
      if(++count>10000)throw new Error('Watched folder exceeds 10,000 entries; select a narrower folder');
      if(entry.isSymbolicLink()){fail(target,'Links are not followed by file triggers');continue;}
      if(entry.isDirectory()){pending.push(target);continue;}if(!entry.isFile())continue;
      seen.add(file);
      try{
        if(!await allowed(target))throw new Error('File is outside the routine’s current approved scope');
        if(await containedPath(root,file)!==target)throw new Error('Watched file path changed');
        const expected=await fs.lstat(target);if(!expected.isFile()||expected.isSymbolicLink())throw new Error('Watched input changed before opening');
        const handle=await fs.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let stat,digest;
        try{
          stat=await handle.stat();if(signature(stat)!==signature(expected))throw new Error('Watched file identity changed before reading');if(!stat.isFile()||stat.size>maxBytes)throw new Error(`Watched input must be an ordinary file up to ${maxBytes} bytes`);
          if(!await allowed(target))throw new Error('Routine scope changed before reading the file');
          if(await containedPath(root,file)!==target||signature(await fs.lstat(target))!==signature(expected))throw new Error('Watched path changed before reading');
          const before=signature(stat),checksum=createHash('sha256');
          for await(const bytes of handle.createReadStream({autoClose:false})){signal?.throwIfAborted();checksum.update(bytes);}
          const after=await handle.stat(),current=await fs.lstat(target);
          if(current.isSymbolicLink()||before!==signature(after)||before!==signature(current))throw new Error('File changed while its identity was being read');
          digest=checksum.digest('hex');
        }finally{await handle.close();}
        const previous=observations.get(file),identity=hash(JSON.stringify([file,digest])),version=signature(stat);
        if(!previous||previous.sha256!==digest||previous.version!==version||now<previous.observedAt){observations.set(file,{sha256:digest,version,observedAt:now,lastSeenAt:now});continue;}
        previous.lastSeenAt=now;
        // shortcut: stability is an observed quiet window, use an application-specific ready marker for producers that pause longer than this interval.
        if(now-previous.observedAt<trigger.stableMs||processed.has(identity)||ignored(target)||!await allowed(target))continue;
        events.push({key:identity,path:file,sha256:digest,bytes:stat.size,readyAt:new Date(now).toISOString()});
      }catch(error){if(signal?.aborted)throw error;observations.delete(file);fail(target,error.message);}
    }
  }
  for(const file of observations.keys())if(!seen.has(file))observations.delete(file);
  return {events,errors};
}
