import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readRoutineBackup} from '../core/routine-backup.mjs';
import {validate} from '../core/registry.mjs';
export const backupMethods=['backups.export','backups.chooseRestore','backups.restore'];
const empty={type:'object',properties:{},additionalProperties:false},restore={type:'object',properties:{id:{type:'string',minLength:1,maxLength:100}},required:['id'],additionalProperties:false};
export function createRoutineBackups({runtime,ledger,chooseSave,chooseOpen,confirm}){
  const pending=new Map();
  return {async request(method,args={}){
    if(!backupMethods.includes(method))throw new Error('Unknown routine backup operation');validate(args,method==='backups.restore'?restore:empty);
    if(method==='backups.export'){
      const archive=await runtime.exportRoutineBackup(),target=await chooseSave();if(!target)return {canceled:true};if(!path.isAbsolute(target))throw new Error('Choose an absolute backup destination');const temporary=target+'.'+randomUUID()+'.tmp';
      try{await fs.writeFile(temporary,JSON.stringify(archive,null,2),{flag:'wx',mode:0o600,flush:true});await fs.rename(temporary,target);}finally{await fs.rm(temporary,{force:true});}return {saved:true,name:path.basename(target),routines:archive.routines.length,jobs:archive.jobs.length};
    }
    if(method==='backups.chooseRestore'){
      const filename=await chooseOpen();if(!filename)return {canceled:true};if(!path.isAbsolute(filename))throw new Error('Choose an absolute backup source');const expected=await fs.lstat(filename);if(!expected.isFile()||expected.isSymbolicLink()||expected.size>32*1024*1024)throw new Error('Choose an ordinary routine backup up to 32 MiB');
      const handle=await fs.open(filename,'r');let bytes;try{const opened=await handle.stat();if(opened.ino!==expected.ino||opened.dev!==expected.dev||opened.size!==expected.size||opened.mtimeMs!==expected.mtimeMs)throw new Error('Backup changed before reading');const buffer=Buffer.alloc(expected.size+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0),after=await handle.stat();if(bytesRead!==expected.size||after.size!==expected.size||after.mtimeMs!==expected.mtimeMs)throw new Error('Backup changed while reading');bytes=buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
      const archive=JSON.parse(bytes),watermark=ledger.snapshot(),payload=readRoutineBackup(archive,{namespace:watermark.namespace,watermark}),id=randomUUID();for(const [key,value]of pending)if(Date.now()>value.expires)pending.delete(key);if(pending.size>=3)pending.delete(pending.keys().next().value);pending.set(id,{archive,expires:Date.now()+600000});
      return {id,name:path.basename(filename),createdAt:payload.createdAt,routines:payload.routines.map(row=>({id:row.id,name:row.definition.name,tools:row.definition.tools,paths:row.definition.paths,requestedGrants:row.definition.grants,accountScope:row.reviewedResourceScope||null})),jobs:payload.jobs.length,paused:true,requiresProjectReview:true,requiresConnectionReview:true,requiresGrantReview:true,independentWatermark:watermark.sequence,backupWatermark:payload.watermark.sequence};
    }
    const selected=pending.get(args.id);if(!selected||Date.now()>selected.expires)throw new Error('Choose and review the backup again');if(!await confirm('Restore routine evidence into this profile? Work stays paused. Existing newer receipts are retained. Projects, connections and grants must be reviewed before any restored job resumes.'))return {canceled:true};const result=await runtime.restoreRoutineBackup(selected.archive);pending.delete(args.id);return {restored:true,routines:result.routines.length,jobs:result.jobs.length,paused:true};
  },close(){pending.clear();}};
}
