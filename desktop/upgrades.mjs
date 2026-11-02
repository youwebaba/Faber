import fs from 'node:fs/promises';
import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {containedPath} from '../tools/files.mjs';
import {runProcess} from '../tools/process.mjs';
import {validUpgradePath,atomicWrite,writeRecoveryRecord,readRecoveryRecord,restoreUpgrade} from './recovery.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function readOrNull(file){try{return await fs.readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function createUpgrades({sourceDir,dataDir,confirm,runner=runProcess,onApplied}){
  const stages=new Map();
  // Capture bytes at construction, before any asynchronous staging or source edits.
  // Renderer/test changes do not replace modules already loaded by the host.
  function serverSnapshot(){
    const result=new Map();
    function visit(relative){
      const file=path.join(sourceDir,relative);let stat;
      try{stat=lstatSync(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(stat.isSymbolicLink())throw new Error(`Symlinks are not permitted in upgrade source: ${relative}`);
      if(stat.isDirectory())for(const name of readdirSync(file).sort())visit(`${relative}/${name}`);
      else result.set(relative,hash(readFileSync(file)));
    }
    for(const name of ['core','desktop','tools','extensions','model-hub','local-models','package.json','package-lock.json'])visit(name);
    return result;
  }
  let baseline,baselineError,mutating=false;
  try{baseline=serverSnapshot();}catch(error){baselineError=error.message;}
  function activationStatus(){
    if(mutating)return {restartRequired:true,busy:true,changedFiles:[]};
    try{
      if(baselineError)throw new Error(baselineError);
      const current=serverSnapshot(),changedFiles=[...new Set([...baseline.keys(),...current.keys()])].filter(file=>baseline.get(file)!==current.get(file)).sort();
      return {restartRequired:changedFiles.length>0,changedFiles};
    }catch(error){return {restartRequired:true,changedFiles:[],error:error.message};}
  }
  async function activationResult(id,files,rolledBack=false){
    mutating=false;
    const status=activationStatus(),uiOnly=files.every(file=>/^(renderer|test)\//.test(file)),hasUI=files.some(file=>file.startsWith('renderer/'));
    const restartRequired=status.restartRequired||!uiOnly;
    const activation=restartRequired?'restart':hasUI?'ui-refresh':'none';
    const result={...status,restartRequired,activation,uiRefreshRequested:false,uiRefreshPending:activation==='ui-refresh'};
    if(uiOnly&&activation==='ui-refresh'&&onApplied){
      try{await onApplied({id,files,...(rolledBack?{rolledBack:true}:{})});result.uiRefreshRequested=true;}
      catch(error){result.refreshError=error.message||String(error);}
    }
    return result;
  }
  async function sourceInventory(){
    const files=[];for(const folder of ['core','desktop','renderer','tools','extensions','model-hub','local-models','test']){try{files.push(...(await inventory(path.join(sourceDir,folder))).map(p=>`${folder}/${p}`));}catch(error){if(error.code!=='ENOENT')throw error;}}
    for(const name of ['package.json','package-lock.json'])if(await readOrNull(path.join(sourceDir,name))!==null)files.push(name);
    return files.sort();
  }
  async function verifyIntegrity(stage){
    const currentFiles=await sourceInventory();if(currentFiles.length!==stage.baseline.size)throw new Error('Source file inventory changed since staging');
    for(const relative of currentFiles)if(hash(await fs.readFile(await containedPath(sourceDir,relative)))!==stage.baseline.get(relative))throw new Error(`Source changed since staging: ${relative}`);
    for(const file of stage.files){
      if(hash(await fs.readFile(await containedPath(stage.directory,file.path)))!==file.digest)throw new Error(`Staged file changed: ${file.path}`);
      const current=await readOrNull(await containedPath(sourceDir,file.path,{missing:true}));
      if((current===null?null:hash(current))!==file.base)throw new Error(`Source changed since staging: ${file.path}`);
    }
    // Validate the entire testable source copy, not only the edited files.
    for(const [relative,digest] of stage.snapshot)if(hash(await fs.readFile(await containedPath(stage.directory,relative)))!==digest)throw new Error(`Stage integrity mismatch: ${relative}`);
    const actual=await inventory(stage.directory);
    if(actual.length!==stage.snapshot.size)throw new Error('Stage contains unverified files');
  }
  async function inventory(root,prefix=''){
    let files=[];
    for(const entry of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){
      const relative=prefix?`${prefix}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())throw new Error('Symlinks are not permitted in upgrade source');
      if(entry.isDirectory())files.push(...await inventory(root,relative));else files.push(relative);
    }return files.sort();
  }
  const api={
    async stage(changes,signal){
      signal?.throwIfAborted();
      if(!Array.isArray(changes)||!changes.length||changes.length>100)throw new Error('Provide 1–100 changed files');
      const seen=new Set();
      for(const item of changes){if(!validUpgradePath(item.path)||seen.has(item.path)||typeof item.content!=='string'||item.content.length>2*1024*1024)throw new Error('Invalid upgrade path/content; recovery, package and dependencies are protected');seen.add(item.path);}
      const id=crypto.randomUUID(),directory=path.join(dataDir,'upgrades',id,'stage');
      const baseline=new Map();for(const relative of await sourceInventory())baseline.set(relative,hash(await fs.readFile(path.join(sourceDir,relative))));
      await fs.mkdir(directory,{recursive:true});
      for(const folder of ['core','desktop','renderer','tools','extensions','model-hub','local-models','test']){
        const from=path.join(sourceDir,folder);
        try{await fs.cp(from,path.join(directory,folder),{recursive:true,filter:async file=>{if((await fs.lstat(file)).isSymbolicLink())throw new Error('Upgrade source cannot contain symlinks');return true;}});}catch(e){if(e.code!=='ENOENT')throw e;}
      }
      const files=[];
      for(const item of changes){
        signal?.throwIfAborted();
        const target=await containedPath(sourceDir,item.path,{missing:true}),original=await readOrNull(target);
        const staged=await containedPath(directory,item.path,{missing:true});await fs.mkdir(path.dirname(staged),{recursive:true});await fs.writeFile(staged,item.content);
        files.push({path:item.path,digest:hash(item.content),base:original===null?null:hash(original)});
      }
      const snapshot=new Map();for(const relative of await inventory(directory))snapshot.set(relative,hash(await fs.readFile(path.join(directory,relative))));
      signal?.throwIfAborted();stages.set(id,{id,directory,files,snapshot,baseline,verified:false});
      return {id,files:files.map(f=>({path:f.path,sha256:f.digest})),status:'staged',message:'Staged only. Verify, then explicitly apply. Stages expire when this app closes.'};
    },
    async verify(id,signal){
      const stage=stages.get(id);if(!stage)throw new Error('Unknown stage');stage.verified=false;await verifyIntegrity(stage);
      const tests=[...stage.snapshot.keys()].filter(p=>p.startsWith('test/')&&p.endsWith('.test.mjs'));
      if(!tests.length)throw new Error('Upgrade needs tests');
      const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_TEST_CONTEXT;
      const result=await runner(process.execPath,['--test',...tests],{cwd:stage.directory,signal,timeout:120000,env});
      await verifyIntegrity(stage);stage.verified=result.code===0;
      return {id,verified:stage.verified,...result};
    },
    async apply(id,signal){
      signal?.throwIfAborted();
      const stage=stages.get(id);if(!stage?.verified)throw new Error('Verify the stage successfully before applying');await verifyIntegrity(stage);
      const uiOnly=stage.files.every(f=>/^(renderer|test)\//.test(f.path));
      if(!await confirm(`Apply verified upgrade?\n\n${stage.files.map(f=>f.path).join('\n')}\n\nSource files will change. ${uiOnly?'UI changes can refresh without restarting if backend source is unchanged.':'Restart is required.'} A rollback backup will be retained.`))throw new Error('Upgrade activation declined');
      signal?.throwIfAborted();
      await verifyIntegrity(stage);
      const backup=new Map();
      for(const file of stage.files){const bytes=await readOrNull(await containedPath(sourceDir,file.path,{missing:true}));if((bytes===null?null:hash(bytes))!==file.base)throw new Error(`Source changed during backup: ${file.path}`);backup.set(file.path,bytes);}
      const backupDir=path.join(path.dirname(stage.directory),'backup');await fs.mkdir(backupDir,{recursive:true});
      for(const [relative,bytes] of backup)if(bytes!==null){const target=path.join(backupDir,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
      const record={version:1,id,sourceDir,files:stage.files,status:'applying'};
      signal?.throwIfAborted();await writeRecoveryRecord(dataDir,record);
      try{for(const file of stage.files){signal?.throwIfAborted();const target=await containedPath(sourceDir,file.path,{missing:true});const bytes=await fs.readFile(path.join(stage.directory,file.path));if(hash(bytes)!==file.digest)throw new Error(`Stage changed during activation: ${file.path}`);signal?.throwIfAborted();await atomicWrite(target,bytes);}signal?.throwIfAborted();await writeRecoveryRecord(dataDir,{...record,status:'applied'});}
      catch(error){await restoreUpgrade({dataDir,sourceDir,record});throw error;}
      stages.delete(id);return {id,applied:true,backupDir,...await activationResult(id,stage.files.map(f=>f.path))};
    },
    async rollback(signal){
      signal?.throwIfAborted();const record=await readRecoveryRecord(dataDir,sourceDir);
      if(!await confirm('Roll back the last applied upgrade and restore its source files? Backend changes require a restart. UI-only changes can refresh if backend source is unchanged.'))throw new Error('Rollback declined');
      signal?.throwIfAborted();const result=await restoreUpgrade({dataDir,sourceDir,record,signal});
      return {...result,...await activationResult(record.id,record.files.map(f=>f.path),true)};
    }
  };
  let queue=Promise.resolve();
  // This read-only check must not queue behind onApplied, whose host may consult it.
  return {activationStatus:async()=>activationStatus(),...Object.fromEntries(Object.entries(api).map(([name,method])=>[name,(...args)=>{const result=queue.catch(()=>{}).then(async()=>{if(name==='apply'||name==='rollback')mutating=true;try{return await method.apply(api,args);}finally{mutating=false;}});queue=result;return result;} ]))};
}
export function upgradeTools(manager){return [
  {name:'upgrade_stage',description:'Stage source changes separately. Allowed source/test files only; recovery, dependencies and user data are protected.',permission:'upgrade',parameters:{type:'object',properties:{changes:{type:'array',items:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}}},required:['changes'],additionalProperties:false},execute:(args,ctx)=>manager.stage(args.changes,ctx.signal)},
  ...['verify','apply'].map(action=>({name:`upgrade_${action}`,description:action==='verify'?'Run the staged Node test suite; reject tampered stages.':'Apply a verified upgrade after native confirmation, with backups. UI-only changes request a UI refresh; backend/mixed changes require restart. Returns pending activation status, never restarts automatically.',permission:'upgrade',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:(args,ctx)=>manager[action](args.id,ctx.signal)})),
  {name:'upgrade_rollback',description:'Roll back the last saved upgrade after native confirmation, including after restart.',permission:'upgrade',parameters:{type:'object',properties:{},additionalProperties:false},execute:(args,ctx)=>manager.rollback(ctx.signal)}
];}
