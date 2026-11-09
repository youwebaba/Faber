import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {authorizedPath,replaceProjectFile} from './files.mjs';

const text={type:'string',minLength:1,maxLength:256},file={type:'string',minLength:1,maxLength:2048};
const cell={anyOf:[{type:'string',maxLength:32767},{type:'number'},{type:'boolean'},{type:'null'}]};
const schema=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

async function processWorkbook(bytes,args,signal){
  signal?.throwIfAborted();
  const worker=new Worker(new URL('./workbook-worker.mjs',import.meta.url),{workerData:{bytes,args},resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32}});
  try{return await new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new Error('Workbook operation canceled'));
    const timer=setTimeout(()=>reject(new Error('Workbook processing exceeded the time limit.')),15000);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    worker.once('message',reply=>{cleanup();if(reply.error)reject(new Error(reply.error));else resolve(reply.result);});
    worker.once('error',error=>{cleanup();reject(error);});
    worker.once('exit',code=>{cleanup();reject(new Error('Workbook worker exited before returning a result ('+code+').'));});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });}finally{await worker.terminate();}
}
async function run(args,ctx){
  if(path.extname(args.path).toLowerCase()!=='.xlsx')throw new Error('Choose an XLSX workbook.');
  const file=await authorizedPath(ctx,args.path),handle=await fs.open(file,'r');
  let bytes;
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size>32*1024*1024)throw new Error('Choose a workbook up to 32 MiB.');
    bytes=Buffer.alloc(stat.size);let read=0;while(read<bytes.length){ctx.signal?.throwIfAborted();const piece=await handle.read(bytes,read,bytes.length-read,read);if(!piece.bytesRead)throw Error('Workbook changed during read');read+=piece.bytesRead;}
    const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||await authorizedPath(ctx,args.path)!==file)throw new Error('Workbook changed during read');
  }finally{await handle.close();}
  const hash=sha(bytes), stale=args.values&&args.expectedSha256!==hash;
  let options={sheet:args.sheet,range:args.range};if(args.values&&!stale)options.values=args.values;
  const {output,...result}=await processWorkbook(bytes,options,ctx.signal);
  if(JSON.stringify(result).length>512*1024)throw new Error('Choose a smaller range.');
  if(stale){
    if(JSON.stringify(result.values)!==JSON.stringify(args.values))throw new Error('Workbook changed since it was read. Review the current range.');
    return {path:args.path,sha256:hash,sheet:args.sheet,range:args.range,alreadyApplied:true};
  }
  if(!output)return {path:args.path,sha256:hash,...result};
  const receipt=await replaceProjectFile(ctx,args.path,output,hash);
  return {...receipt,sheet:args.sheet,range:args.range,cells:result.values.reduce((n,row)=>n+row.length,0)};
}
export function workbookTools(){return [
  {name:'workbook_read',permission:'read',description:'List sheets in a project XLSX workbook, or read a selected sheet and A1 range. Formula cells include their original formula and last saved value. Returns the source SHA-256 for an edit.',parameters:schema({path:file,sheet:text,range:text},['path']),execute:run},
  {name:'workbook_update',permission:'files',description:'Set literal values in one rectangular XLSX range with the digest returned by workbook_read. Preserve other cells, styles and worksheets. An identical retry returns the existing content.',parameters:schema({path:file,sheet:text,range:text,expectedSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},values:{type:'array',minItems:1,maxItems:4096,items:{type:'array',minItems:1,maxItems:4096,items:cell}}},['path','sheet','range','expectedSha256','values']),execute:run}
];}

