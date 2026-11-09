import fs from 'node:fs/promises';
import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {containedPath} from '../tools/files.mjs';
import {runProcess} from '../tools/process.mjs';
import {validUpgradePath,atomicWrite,writeRecoveryRecord,readRecoveryRecord,restoreUpgrade,recoveryProfilePath} from './recovery.mjs';
import {buildNative} from '../native/build.mjs';
import {parseNativeManifest,verifyNativeRuntime} from '../native/integrity.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const sourceFolders=['core','desktop','renderer','tools','extensions','model-hub','local-models','local-music','bundled-addons','test','native','scripts'];
const nativeManifest='native/runtime.json';
const upgradeId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const scratchName=name=>name==='stage'||(name.startsWith('native-output-')&&upgradeId.test(name.slice(14)));
async function readOrNull(file){try{return await fs.readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function publishNativeBinary(root,{manifest,binaryBytes}){
  const target=await containedPath(root,`native/${manifest.binary}`,{missing:true}),temporary=`${target}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target),{recursive:true});
  try{
    await fs.writeFile(temporary,binaryBytes,{flag:'wx',mode:0o755});
    try{await fs.link(temporary,target);}catch(error){if(error.code!=='EEXIST')throw error;if(hash(await fs.readFile(target))!==manifest.sha256)throw new Error('Native binary name collision or tampering');}
  }finally{await fs.rm(temporary,{force:true});}
}
export function createUpgrades({sourceDir,dataDir,confirm,runner=runProcess,nativeBuilder=buildNative,onApplied}){
  const stages=new Map();
  async function removeScratch(id,name){
    if(!upgradeId.test(id)||!scratchName(name))throw new Error('Invalid upgrade scratch directory');
    const dir=await recoveryProfilePath(dataDir,`upgrades/${id}/${name}`);
    await fs.rm(dir,{recursive:true,force:true,maxRetries:2});
  }
  async function expireStages(){
    let entries;
    try{
      const root=await recoveryProfilePath(dataDir,'upgrades');
      entries=await fs.readdir(root,{withFileTypes:true});
    }catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries){
      if(!entry.isDirectory()||!upgradeId.test(entry.name)||stages.has(entry.name))continue;
      const dir=await recoveryProfilePath(dataDir,`upgrades/${entry.name}`);
      for(const child of await fs.readdir(dir,{withFileTypes:true})){
        if(child.isDirectory()&&scratchName(child.name))await removeScratch(entry.name,child.name);
      }
    }
  }
  // Capture bytes at construction, before any asynchronous staging or source edits.
  // Renderer/test changes do not replace modules already loaded by the host.
  function serverSnapshot(){
    const result=new Map();
    function visit(relative){
      if(relative==='native/target')return;
      const file=path.join(sourceDir,relative);let stat;
      try{stat=lstatSync(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(stat.isSymbolicLink())throw new Error(`Symlinks are not permitted in upgrade source: ${relative}`);
      if(relative==='native/bin')return;
      if(stat.isDirectory())for(const name of readdirSync(file).sort())visit(`${relative}/${name}`);
      else result.set(relative,hash(readFileSync(file)));
    }
    for(const name of ['core','desktop','tools','extensions','model-hub','local-models','local-music','bundled-addons','native','package.json','package-lock.json'])visit(name);
    if(result.has(nativeManifest))visit(`native/${parseNativeManifest(JSON.parse(readFileSync(path.join(sourceDir,nativeManifest),'utf8'))).binary}`);
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
    const native=await readOrNull(path.join(sourceDir,nativeManifest)),active=native?parseNativeManifest(JSON.parse(native)).binary:null;
    const files=[];for(const folder of sourceFolders){try{files.push(...(await inventory(path.join(sourceDir,folder),'',folder==='native')).filter(p=>folder!=='native'||!p.startsWith('bin/')||p===active).map(p=>`${folder}/${p}`));}catch(error){if(error.code!=='ENOENT')throw error;}}
    for(const name of ['package.json','package-lock.json'])if(await readOrNull(path.join(sourceDir,name))!==null)files.push(name);
    return files.sort();
  }
  async function coreInventory(){
    const names=new Set((await sourceInventory()).filter(file=>!/^native\/(vendor|target)\//.test(file)));
    for(const folder of ['build','docs'])try{for(const file of await inventory(path.join(sourceDir,folder)))names.add(`${folder}/${file}`);}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const entry of await fs.readdir(sourceDir,{withFileTypes:true}))if(entry.isFile()&&(/\.md$/i.test(entry.name)||['Start-Faber.cmd','Start-Faber.ps1'].includes(entry.name)))names.add(entry.name);
    return [...names].sort();
  }
  async function coreSnapshot(reason,signal,{id=crypto.randomUUID(),reuse=true}={}){
    signal?.throwIfAborted();const names=await coreInventory();
    const bytes=new Map(),files=[];
    for(const relative of names){signal?.throwIfAborted();const content=await fs.readFile(await containedPath(sourceDir,relative));bytes.set(relative,content);files.push({path:relative,sha256:hash(content)});}
    const pointer=path.join(dataDir,'upgrades','last-core-backup.json');
    if(reuse)try{const previous=JSON.parse(await fs.readFile(pointer,'utf8'));if(previous.schemaVersion===1&&previous.sourceDir===sourceDir&&JSON.stringify(previous.files)===JSON.stringify(files)){if(!/^[a-f0-9-]{36}$/.test(previous.id)||previous.backupDir!==path.join(dataDir,'upgrades',previous.id,'backup'))throw new Error('Invalid previous core backup path');for(const file of files)if(hash(await fs.readFile(await containedPath(previous.backupDir,file.path)))!==file.sha256)throw new Error('Previous core backup integrity mismatch');if(JSON.stringify(await coreInventory())!==JSON.stringify(names))throw new Error('Source inventory changed during core backup');for(const file of files)if(hash(await fs.readFile(await containedPath(sourceDir,file.path)))!==file.sha256)throw new Error(`Source changed during core backup: ${file.path}`);return {id:previous.id,backupDir:previous.backupDir,files:files.length,reused:true};}}catch(error){if(error.code!=='ENOENT'&&error.name!=='SyntaxError')throw error;}
    const backupDir=path.join(dataDir,'upgrades',id,'backup');await fs.mkdir(backupDir,{recursive:true});
    for(const [relative,content] of bytes){signal?.throwIfAborted();const target=await containedPath(backupDir,relative,{missing:true});await fs.mkdir(path.dirname(target),{recursive:true});try{await fs.writeFile(target,content,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;if(hash(await fs.readFile(target))!==hash(content))throw new Error(`Core backup integrity mismatch: ${relative}`);}}
    if(JSON.stringify(await coreInventory())!==JSON.stringify(names))throw new Error('Source inventory changed during core backup');
    for(const file of files)if(hash(await fs.readFile(await containedPath(sourceDir,file.path)))!==file.sha256)throw new Error(`Source changed during core backup: ${file.path}`);
    const record={schemaVersion:1,id,sourceDir,backupDir,reason,createdAt:new Date().toISOString(),files};
    signal?.throwIfAborted();await atomicWrite(path.join(dataDir,'upgrades',id,'core-backup.json'),JSON.stringify(record,null,2));await atomicWrite(pointer,JSON.stringify(record,null,2));
    return {id,backupDir,files:files.length,reused:false};
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
    if(stage.hasNative){await verifyNativeRuntime(sourceDir);await verifyNativeRuntime(stage.directory,{verifySource:!stage.needsNative||stage.nativeBuilt});}
  }
  async function inventory(root,prefix='',skipCargoTarget=false){
    let files=[];
    for(const entry of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){
      const relative=prefix?`${prefix}/${entry.name}`:entry.name;
      if(skipCargoTarget&&relative==='target')continue;
      if(entry.isSymbolicLink())throw new Error('Symlinks are not permitted in upgrade source');
      if(entry.isDirectory())files.push(...await inventory(root,relative,skipCargoTarget));else files.push(relative);
    }return files.sort();
  }
  const api={
    expireStages,
    async close(){
      stages.clear();
      await expireStages();
    },
    backupCore(reason='shell',signal){return coreSnapshot(reason,signal);},
    async stage(changes,signal){
      signal?.throwIfAborted();
      if(!Array.isArray(changes)||!changes.length||changes.length>100)throw new Error('Provide 1–100 changed files');
      const seen=new Set();
      for(const item of changes){if(!validUpgradePath(item.path)||seen.has(item.path)||typeof item.content!=='string'||item.content.length>2*1024*1024)throw new Error('Invalid upgrade path/content; recovery, package and dependencies are protected');seen.add(item.path);}
      const id=crypto.randomUUID(),directory=path.join(dataDir,'upgrades',id,'stage');
      const hasNative=await readOrNull(path.join(sourceDir,nativeManifest))!==null;
      const native=hasNative?await verifyNativeRuntime(sourceDir):null;
      const needsNative=changes.some(file=>file.path.startsWith('native/src/'));
      if(needsNative&&!hasNative)throw new Error('Compiled upgrades require the installed native runtime and locked build sources');
      const baseline=new Map();for(const relative of await sourceInventory())baseline.set(relative,hash(await fs.readFile(path.join(sourceDir,relative))));
      await fs.mkdir(dataDir,{recursive:true});
      await recoveryProfilePath(dataDir,`upgrades/${id}/stage`);
      try{
        await fs.mkdir(directory,{recursive:true});
        for(const folder of sourceFolders){
          const from=path.join(sourceDir,folder);
          try{await fs.cp(from,path.join(directory,folder),{recursive:true,filter:async file=>{
            if(file===path.join(sourceDir,'native','target'))return false;
            if((await fs.lstat(file)).isSymbolicLink())throw new Error('Upgrade source cannot contain symlinks');
            return file!==path.join(sourceDir,'native','bin');
          }});}catch(error){if(error.code!=='ENOENT')throw error;}
        }
        for(const name of ['package.json','package-lock.json'])if(baseline.has(name))await fs.copyFile(path.join(sourceDir,name),path.join(directory,name));
        if(native)await publishNativeBinary(directory,native);
        const files=[];
        for(const item of changes){
          signal?.throwIfAborted();
          const target=await containedPath(sourceDir,item.path,{missing:true}),original=await readOrNull(target);
          const staged=await containedPath(directory,item.path,{missing:true});await fs.mkdir(path.dirname(staged),{recursive:true});await fs.writeFile(staged,item.content);
          files.push({path:item.path,digest:hash(item.content),base:original===null?null:hash(original)});
        }
        const snapshot=new Map();for(const relative of await inventory(directory))snapshot.set(relative,hash(await fs.readFile(path.join(directory,relative))));
        signal?.throwIfAborted();stages.set(id,{id,directory,files,snapshot,baseline,hasNative,needsNative,nativeBuilt:false,verified:false});
        return {id,files:files.map(f=>({path:f.path,sha256:f.digest})),status:'staged',message:'Staged only. Verify, then explicitly apply. Stages expire when this app closes.'};
      }catch(error){await removeScratch(id,'stage');throw error;}
    },
    async verify(id,signal){
      const stage=stages.get(id);if(!stage)throw new Error('Unknown stage');stage.verified=false;await verifyIntegrity(stage);
      let compiled;
      if(stage.needsNative&&!stage.nativeBuilt){
        const outputDir=path.join(path.dirname(stage.directory),`native-output-${crypto.randomUUID()}`);
        try{
          compiled=await nativeBuilder({sourceDir:stage.directory,outputDir,signal});
          await verifyIntegrity(stage);
          const native=await verifyNativeRuntime(stage.directory,{runtimeDir:outputDir});
          signal?.throwIfAborted();await publishNativeBinary(stage.directory,native);
          await atomicWrite(path.join(stage.directory,nativeManifest),native.manifestBytes);
          stage.snapshot.set(`native/${native.manifest.binary}`,native.manifest.sha256);
          stage.snapshot.set(nativeManifest,hash(native.manifestBytes));
          stage.files.push({path:nativeManifest,digest:hash(native.manifestBytes),base:stage.baseline.get(nativeManifest)});
          stage.nativeBuilt=true;
          await verifyIntegrity(stage);
        }finally{await removeScratch(id,path.basename(outputDir));}
      }
      const tests=[...stage.snapshot.keys()].filter(p=>p.startsWith('test/')&&p.endsWith('.test.mjs'));
      if(!tests.length)throw new Error('Upgrade needs tests');
      const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_TEST_CONTEXT;
      const result=await runner(process.execPath,['--test',...tests],{cwd:stage.directory,signal,timeout:120000,env});
      await verifyIntegrity(stage);stage.verified=result.code===0;
      return {id,verified:stage.verified,...result,...(compiled?{stdout:[compiled.stdout,result.stdout].filter(Boolean).join('\n'),stderr:[compiled.stderr,result.stderr].filter(Boolean).join('\n')}: {})};
    },
    async apply(id,signal){
      signal?.throwIfAborted();
      const stage=stages.get(id);if(!stage?.verified)throw new Error('Verify the stage successfully before applying');await verifyIntegrity(stage);
      const uiOnly=stage.files.every(f=>/^(renderer|test)\//.test(f.path));
      if(!await confirm(`Apply verified upgrade?\n\n${stage.files.map(f=>f.path).join('\n')}\n\nSource files will change. ${uiOnly?'UI changes can refresh without restarting if backend source is unchanged.':'Restart is required.'} A rollback backup will be retained.`))throw new Error('Upgrade activation declined');
      signal?.throwIfAborted();
      await verifyIntegrity(stage);
      for(const file of stage.files){const bytes=await readOrNull(await containedPath(sourceDir,file.path,{missing:true}));if((bytes===null?null:hash(bytes))!==file.base)throw new Error(`Source changed during backup: ${file.path}`);}
      const {backupDir}=await coreSnapshot('upgrade',signal,{id:stage.id,reuse:false});
      if(stage.nativeBuilt){signal?.throwIfAborted();await publishNativeBinary(sourceDir,await verifyNativeRuntime(stage.directory));}
      const record={version:stage.nativeBuilt?2:1,id,sourceDir,files:stage.files,status:'applying'};
      signal?.throwIfAborted();await writeRecoveryRecord(dataDir,record);
      try{for(const file of stage.files){signal?.throwIfAborted();const target=await containedPath(sourceDir,file.path,{missing:true});const bytes=await fs.readFile(path.join(stage.directory,file.path));if(hash(bytes)!==file.digest)throw new Error(`Stage changed during activation: ${file.path}`);signal?.throwIfAborted();await atomicWrite(target,bytes);}signal?.throwIfAborted();await writeRecoveryRecord(dataDir,{...record,status:'applied'});}
      catch(error){await restoreUpgrade({dataDir,sourceDir,record});throw error;}
      stages.delete(id);
      let cleanupWarning;
      try{await removeScratch(id,'stage');}catch(error){cleanupWarning=error.message;}
      return {id,applied:true,backupDir,...(cleanupWarning?{cleanupWarning}:{}),...await activationResult(id,stage.files.map(f=>f.path))};
    },
    async rollback(signal){
      signal?.throwIfAborted();const record=await readRecoveryRecord(dataDir,sourceDir);
      if(!await confirm('Roll back the last applied upgrade and restore its source files? Backend changes require a restart. UI-only changes can refresh if backend source is unchanged.'))throw new Error('Rollback declined');
      signal?.throwIfAborted();await coreSnapshot('rollback',signal);const result=await restoreUpgrade({dataDir,sourceDir,record,signal});
      return {...result,...await activationResult(record.id,record.files.map(f=>f.path),true)};
    }
  };
  let queue=Promise.resolve();
  // This read-only check must not queue behind onApplied, whose host may consult it.
  return {activationStatus:async()=>activationStatus(),...Object.fromEntries(Object.entries(api).map(([name,method])=>[name,(...args)=>{const result=queue.catch(()=>{}).then(async()=>{if(name==='apply'||name==='rollback')mutating=true;try{return await method.apply(api,args);}finally{mutating=false;}});queue=result;return result;} ]))};
}
export function upgradeTools(manager){return [
  {name:'upgrade_stage',description:'Stage source changes separately. Allowed source/test files only; recovery, dependencies and user data are protected.',permission:'upgrade',parameters:{type:'object',properties:{changes:{type:'array',items:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}}},required:['changes'],additionalProperties:false},execute:(args,ctx)=>manager.stage(args.changes,ctx.signal)},
  ...['verify','apply'].map(action=>({name:`upgrade_${action}`,description:action==='verify'?'Compile and test staged Rust changes when present, then run the staged Node test suite; reject tampered stages.':'Apply a verified upgrade after native confirmation, with backups. UI-only changes request a UI refresh; backend/mixed changes require restart. Returns pending activation status, never restarts automatically.',permission:'upgrade',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:(args,ctx)=>manager[action](args.id,ctx.signal)})),
  {name:'upgrade_rollback',description:'Roll back the last saved upgrade after native confirmation, including after restart.',permission:'upgrade',parameters:{type:'object',properties:{},additionalProperties:false},execute:(args,ctx)=>manager.rollback(ctx.signal)}
];}
