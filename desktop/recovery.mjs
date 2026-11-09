// Kept outside the upgrade allowlist so a broken core/UI upgrade cannot remove recovery.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {getProfileDirectory} from './profile-path.cjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const allowed=/^(core|desktop|renderer|tools|extensions|model-hub|local-models|test)\/[a-zA-Z0-9_./-]+\.(mjs|cjs|js|json|html|css|ps1)$/;
const rustSource=/^native\/src\/[a-zA-Z0-9_./-]+\.rs$/;
const nativeManifest='native/runtime.json';
export function validUpgradePath(value){return typeof value==='string'&&(allowed.test(value)||rustSource.test(value)||value==='native/worker.mjs')&&!value.split('/').some(p=>!p||p==='.'||p==='..')&&!['desktop/recovery.mjs','desktop/bootstrap.cjs','desktop/boot-state.cjs','desktop/packaged-paths.mjs','desktop/profile-path.cjs','desktop/profile-owner.cjs','desktop/action-ledger.cjs','desktop/worker-update.cjs','desktop/boot-task.mjs','desktop/boot-task.ps1','desktop/boot-launch.ps1','desktop/boot-worker.cjs','desktop/boot-runtime.mjs','desktop/boot-control.mjs','desktop/worker-update-cli.cjs','desktop/worker-control.cjs'].includes(value.toLowerCase());}
async function safePath(root,relative,{generated=false}={}){
  if(!validUpgradePath(relative)&&!(generated&&(relative===nativeManifest||/^native\/bin\/[a-f0-9]{64}(?:\.exe)?$/.test(relative))))throw new Error('Invalid recovery path');
  const base=await fs.realpath(root),target=path.resolve(base,relative);let probe=target;
  if(generated)for(let current=target;;current=path.dirname(current)){try{if((await fs.lstat(current)).isSymbolicLink())throw new Error('Native recovery path contains a symlink or junction');}catch(error){if(error.code!=='ENOENT')throw error;}if(current===base)break;}
  while(true){try{const real=await fs.realpath(probe),rel=path.relative(base,real);if(rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('Recovery path escapes root');break;}catch(error){if(error.code!=='ENOENT')throw error;probe=path.dirname(probe);}}
  return target;
}
export async function atomicWrite(file,bytes){const temporary=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(temporary,bytes,{flag:'wx'});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}}
const historyId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export async function writeRecoveryRecord(dataDir,record){
  await fs.mkdir(dataDir,{recursive:true});
  const pointer=await recoveryProfilePath(dataDir,'upgrades/last-applied.json');
  let previous;
  try{previous=JSON.parse(await fs.readFile(pointer,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous&&previous.id!==record.id){
    if(!historyId.test(previous.id)||!['applied','rolledBack'].includes(previous.status))throw new Error('The previous upgrade requires recovery before applying another.');
    const archive=await recoveryProfilePath(dataDir,`upgrades/${previous.id}/history.json`);
    await atomicWrite(archive,JSON.stringify(previous,null,2));
  }
  await atomicWrite(pointer,JSON.stringify(record,null,2));
}
export async function appliedUpgrades(dataDir,sourceDir){
  let entries;
  try{entries=await fs.readdir(await recoveryProfilePath(dataDir,'upgrades'),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const rows=new Map();
  async function collect(relative,latest){
    const file=await recoveryProfilePath(dataDir,relative);
    let bytes;
    try{bytes=await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}
    const record=JSON.parse(bytes);
    if(!historyId.test(record.id)||!['applied','applying','rolledBack'].includes(record.status)||!Array.isArray(record.files))throw new Error('Unrecognized upgrade history record');
    const files=record.files.map(item=>item.path).filter(name=>validUpgradePath(name)||name===nativeManifest);
    rows.set(record.id,{id:record.id,files,title:record.title||files.join(', '),status:record.status,
      appliedAt:record.appliedAt||null,verifiedAt:record.verifiedAt||null,
      canRollback:latest&&record.sourceDir===sourceDir&&record.status==='applied'});
  }
  for(const entry of entries)if(entry.isDirectory()&&historyId.test(entry.name))await collect(`upgrades/${entry.name}/history.json`,false);
  await collect('upgrades/last-applied.json',true);
  return [...rows.values()].sort((a,b)=>Number(b.canRollback)-Number(a.canRollback)||String(b.appliedAt||'').localeCompare(String(a.appliedAt||'')));
}
export async function recoveryProfilePath(dataDir,relative){
  const base=await fs.realpath(dataDir),target=path.join(base,relative);let current=base;
  for(const part of relative.split('/')){current=path.join(current,part);try{if((await fs.lstat(current)).isSymbolicLink())throw new Error('Recovery storage contains a link or junction');const resolved=await fs.realpath(current),inside=path.relative(base,resolved);if(inside==='..'||inside.startsWith(`..${path.sep}`)||path.isAbsolute(inside))throw new Error('Recovery storage escapes the profile');}catch(error){if(error.code!=='ENOENT')throw error;}}
  return target;
}
export async function disableRecoveryAddons(dataDir){
  const file=await recoveryProfilePath(dataDir,'addon-manager/state.json');let bytes,saved;
  try{bytes=await fs.readFile(file);saved=JSON.parse(bytes);}catch(error){if(error.code==='ENOENT')return {disabled:0};throw new Error('Addon approvals could not be read; original file was preserved');}
  if(saved.schemaVersion!==1||!saved.records||typeof saved.records!=='object'||Array.isArray(saved.records)||Object.values(saved.records).some(record=>!record||typeof record.enabled!=='boolean'))throw new Error('Invalid addon approvals; original file was preserved');
  await recoveryProfilePath(dataDir,'addon-manager/state.json');await fs.writeFile(file+'.recovery-'+crypto.randomUUID()+'.bak',bytes,{flag:'wx'});let disabled=0;
  for(const record of Object.values(saved.records)){if(record.enabled)disabled++;record.enabled=false;}
  await recoveryProfilePath(dataDir,'addon-manager/state.json');await atomicWrite(file,JSON.stringify(saved,null,2));return {disabled};
}
export async function removeRecoveryAddon(dataDir,selected){
  const root=await fs.realpath(await recoveryProfilePath(dataDir,'addons')),target=await fs.realpath(selected),id=path.basename(target);
  if(path.dirname(target)!==root||!/^[a-z][a-z0-9-]{0,63}$/.test(id)||(await fs.lstat(selected)).isSymbolicLink())throw new Error('Choose one ordinary addon folder directly inside this profile’s addons directory');
  if(await recoveryProfilePath(dataDir,'addons')!==root)throw new Error('Addon storage changed during recovery');await fs.rm(target,{recursive:true});return {removed:id,privateDataRetained:true,cleanupSkipped:true};
}
export async function readRecoveryRecord(dataDir,sourceDir){
  let record;try{record=JSON.parse(await fs.readFile(path.join(dataDir,'upgrades','last-applied.json'),'utf8'));}catch(error){if(error.code==='ENOENT')throw new Error('No saved upgrade recovery record');throw error;}
  if(![1,2].includes(record.version)||!['applying','applied','rolledBack'].includes(record.status)||!/^[-a-f0-9]{36}$/.test(record.id)||!Array.isArray(record.files)||path.resolve(record.sourceDir)!==path.resolve(sourceDir))throw new Error('Invalid upgrade recovery record');
  const seen=new Set();
  for(const file of record.files){if((!validUpgradePath(file.path)&&!(record.version===2&&file.path===nativeManifest))||seen.has(file.path)||!/^[a-f0-9]{64}$/.test(file.digest)||(file.base!==null&&!/^[a-f0-9]{64}$/.test(file.base)))throw new Error('Invalid upgrade backup manifest');seen.add(file.path);}
  if(record.version===2&&(!seen.has(nativeManifest)||!record.files.some(file=>rustSource.test(file.path))))throw new Error('Invalid compiled upgrade recovery record');
  return record;
}
export async function restoreUpgrade({dataDir,sourceDir,record,signal}){
  if(record.status==='rolledBack')throw new Error('Upgrade already rolled back');
  const backupDir=path.join(dataDir,'upgrades',record.id,'backup'),restores=[];
  for(const file of record.files){
    signal?.throwIfAborted();const generated=record.version===2&&file.path===nativeManifest,target=await safePath(sourceDir,file.path,{generated});
    let current=null;try{current=hash(await fs.readFile(target));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(current!==file.digest&&current!==file.base)throw new Error(`Source has newer changes: ${file.path}`);
    let bytes=null;if(file.base!==null){bytes=await fs.readFile(await safePath(backupDir,file.path,{generated}));if(hash(bytes)!==file.base)throw new Error(`Backup integrity mismatch: ${file.path}`);}
    if(generated&&bytes!==null){
      // Recovery must work even when every editable native module is broken.
      let manifest;try{manifest=JSON.parse(bytes);}catch{throw new Error('Invalid native recovery manifest');}
      if(manifest.schemaVersion!==1||manifest.protocol!==1||!/^[a-f0-9]{64}$/.test(manifest.sourceHash)||!/^[a-f0-9]{64}$/.test(manifest.sha256)||manifest.binary!==`bin/${manifest.sha256}${process.platform==='win32'?'.exe':''}`)throw new Error('Invalid native recovery manifest');
      if(hash(await fs.readFile(await safePath(sourceDir,`native/${manifest.binary}`,{generated:true})))!==manifest.sha256)throw new Error('Native rollback binary integrity mismatch');
    }
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
    const dataDir=getProfileDirectory(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData','Local'));
    const record=await readRecoveryRecord(dataDir,sourceDir);console.log(JSON.stringify(await restoreUpgrade({dataDir,sourceDir,record}),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
