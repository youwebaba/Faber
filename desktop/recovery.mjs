// Kept outside the upgrade allowlist so a broken core/UI upgrade cannot remove recovery.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const allowed=/^(core|desktop|renderer|tools|extensions|model-hub|local-models|test)\/[a-zA-Z0-9_./-]+\.(mjs|cjs|js|json|html|css|ps1)$/;
export function validUpgradePath(value){return typeof value==='string'&&allowed.test(value)&&!value.split('/').some(p=>p==='.'||p==='..')&&value!=='desktop/recovery.mjs';}
async function safePath(root,relative){
  if(!validUpgradePath(relative))throw new Error('Invalid recovery path');
  const base=await fs.realpath(root),target=path.resolve(base,relative);let probe=target;
  while(true){try{const real=await fs.realpath(probe),rel=path.relative(base,real);if(rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('Recovery path escapes root');break;}catch(error){if(error.code!=='ENOENT')throw error;probe=path.dirname(probe);}}
  return target;
}
export async function atomicWrite(file,bytes){const temporary=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(temporary,bytes,{flag:'wx'});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}}
export async function writeRecoveryRecord(dataDir,record){const target=path.join(dataDir,'upgrades','last-applied.json');await fs.mkdir(path.dirname(target),{recursive:true});await atomicWrite(target,JSON.stringify(record,null,2));}
export async function readRecoveryRecord(dataDir,sourceDir){
  let record;try{record=JSON.parse(await fs.readFile(path.join(dataDir,'upgrades','last-applied.json'),'utf8'));}catch(error){if(error.code==='ENOENT')throw new Error('No saved upgrade recovery record');throw error;}
  if(record.version!==1||!['applying','applied','rolledBack'].includes(record.status)||!/^[-a-f0-9]{36}$/.test(record.id)||!Array.isArray(record.files)||path.resolve(record.sourceDir)!==path.resolve(sourceDir))throw new Error('Invalid upgrade recovery record');
  for(const file of record.files)if(!validUpgradePath(file.path)||!/^[a-f0-9]{64}$/.test(file.digest)||(file.base!==null&&!/^[a-f0-9]{64}$/.test(file.base)))throw new Error('Invalid upgrade backup manifest');
  return record;
}
export async function restoreUpgrade({dataDir,sourceDir,record,signal}){
  if(record.status==='rolledBack')throw new Error('Upgrade already rolled back');
  const backupDir=path.join(dataDir,'upgrades',record.id,'backup'),restores=[];
  for(const file of record.files){
    signal?.throwIfAborted();const target=await safePath(sourceDir,file.path);
    let current=null;try{current=hash(await fs.readFile(target));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(current!==file.digest&&current!==file.base)throw new Error(`Source has newer changes: ${file.path}`);
    let bytes=null;if(file.base!==null){bytes=await fs.readFile(await safePath(backupDir,file.path));if(hash(bytes)!==file.base)throw new Error(`Backup integrity mismatch: ${file.path}`);}
    restores.push({target,bytes});
  }
  signal?.throwIfAborted();
  // Once restoration starts, finish it even if a caller cancels to avoid mixed source versions.
  for(const {target,bytes} of restores){if(bytes===null)await fs.rm(target,{force:true});else await atomicWrite(target,bytes);}
  await writeRecoveryRecord(dataDir,{...record,status:'rolledBack'});return {id:record.id,rolledBack:true,restartRequired:true};
}
if(process.argv.includes('--rollback-last')&&path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
  try{
    const sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    const dataDir=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData','Local'),'SophiaHarness');
    const record=await readRecoveryRecord(dataDir,sourceDir);console.log(JSON.stringify(await restoreUpgrade({dataDir,sourceDir,record}),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
