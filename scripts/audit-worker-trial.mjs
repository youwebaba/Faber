// Read-only audit of an explicitly selected isolated trial. No worker IPC or process changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assessWorkerTrial} from '../core/acceptance/worker-trial.mjs';

const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--trial-root'||!path.isAbsolute(args[1])||args[2]!=='--expected-source'||!(/^[a-f0-9]{64}$/).test(args[3]))throw Error('Usage: node scripts/audit-worker-trial.mjs --trial-root <absolute isolated trial directory> --expected-source <independently recorded SHA-256>');
const root=await fs.realpath(args[1]),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function read(relative,max=16777216){
  const target=path.resolve(root,relative),rel=path.relative(root,target);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||await fs.realpath(target)!==target)throw Error('Evidence path is outside the selected real trial directory');
  const file=await fs.open(target,'r');
  try{
    const before=await file.stat(),current=await fs.lstat(target);
    if(!before.isFile()||before.size>max||current.isSymbolicLink()||current.ino!==before.ino||current.dev!==before.dev||await fs.realpath(target)!==target)throw Error('Evidence file exceeds its bounded type, identity or size');
    const bytes=Buffer.alloc(before.size);for(let offset=0;offset<bytes.length;){const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw Error('Evidence changed during audit; retry this read-only check');offset+=bytesRead;}
    const after=await file.stat(),latest=await fs.lstat(target);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||latest.isSymbolicLink()||latest.ino!==before.ino||latest.dev!==before.dev||await fs.realpath(target)!==target)throw Error('Evidence changed during audit; retry this read-only check');return bytes;
  }finally{await file.close();}
}
const trial=JSON.parse(await read('profile/schedule-trial.json',8388608)),state=JSON.parse(await read('profile/state.json',134217728)),manifest=JSON.parse(await read('snapshot-manifest.json',8388608));
if(!Array.isArray(manifest.files)||manifest.files.length>20000)throw Error('Invalid bounded source manifest');
const manifestMatches=sha(JSON.stringify(manifest.files))===manifest.sourceDigest&&manifest.sourceDigest===trial.sourceDigest;let filesMatch=manifestMatches;
if(filesMatch)for(const row of manifest.files){if(typeof row.path!=='string'||!row.path||path.isAbsolute(row.path)||row.path.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')||!/^[a-f0-9]{64}$/.test(row.sha256)){filesMatch=false;break;}try{if(sha(await read(path.join('source',row.path),67108864))!==row.sha256){filesMatch=false;break;}}catch{filesMatch=false;break;}}
let processAlive=false;if(Number.isSafeInteger(trial.pid)&&trial.pid>0)try{process.kill(trial.pid,0);processAlive=true;}catch{}
const destinations=[];for(const job of state.jobs||[]){
  if(job.routineId!==trial.routineId||job.report?.stage!=='completed')continue;let matches=false,manifestMatches=false;
  try{
    const project=state.projects.find(row=>row.id===job.definition.projectId),relative=path.relative(root,path.join(project.path,job.report.path)),bytes=await read(relative,16777216);
    matches=sha(bytes)===job.report.sha256;
    const digest=sha(JSON.stringify(job.report.inputs.map(({path,sha256,bytes,error})=>({path,sha256,bytes,error}))));
    manifestMatches=digest===job.report.manifestDigest&&bytes.toString('utf8').includes('Input snapshot: '+digest);
  }catch{}
  destinations.push({jobId:job.id,matches,manifestMatches});
}
const result=assessWorkerTrial({trial,state,now:Date.now(),sourceVerification:{manifestMatches,filesMatch,expectedDigestMatches:manifest.sourceDigest===args[3]&&trial.sourceDigest===args[3]},destinations,processAlive});
console.log(JSON.stringify({...result,platform:process.platform,processHealthLimit:'PID existence only; profile ownership needs separate Windows lifecycle evidence',evidenceKind:'read-only evidence audit; physical conditions and original trial provenance require independent review'},null,2));
