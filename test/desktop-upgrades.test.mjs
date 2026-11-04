import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUpgrades} from '../desktop/upgrades.mjs';

async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-upgrade-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sourceDir=path.join(root,'source'),dataDir=path.join(root,'data');await fs.mkdir(path.join(sourceDir,'core'),{recursive:true});await fs.mkdir(path.join(sourceDir,'test'));
  await fs.writeFile(path.join(sourceDir,'core','value.mjs'),'export const value=1;');
  await fs.writeFile(path.join(sourceDir,'test','value.test.mjs'),"import {value} from '../core/value.mjs';import assert from 'node:assert/strict';assert.equal(value,2);");
  return {sourceDir,dataDir,manager:createUpgrades({sourceDir,dataDir,confirm:async()=>true,...options})};
}
test('upgrade runs real staged tests, applies explicitly, then rolls back preserving data',async t=>{
  const {sourceDir,dataDir,manager}=await fixture(t);await fs.mkdir(dataDir);await fs.writeFile(path.join(dataDir,'state.json'),'preserved');
  const stage=await manager.stage([{path:'core/value.mjs',content:'export const value=2;'}]);
  assert.equal(await fs.readFile(path.join(sourceDir,'core','value.mjs'),'utf8'),'export const value=1;');
  await assert.rejects(manager.apply(stage.id),/Verify/);
  assert.equal((await manager.verify(stage.id)).verified,true);
  assert.equal((await manager.apply(stage.id)).restartRequired,true);
  assert.equal(await fs.readFile(path.join(sourceDir,'core','value.mjs'),'utf8'),'export const value=2;');
  const restarted=createUpgrades({sourceDir,dataDir,confirm:async()=>true});
  assert.equal((await restarted.rollback()).rolledBack,true);
  assert.equal(await fs.readFile(path.join(sourceDir,'core','value.mjs'),'utf8'),'export const value=1;');
  assert.equal(await fs.readFile(path.join(dataDir,'state.json'),'utf8'),'preserved');
});
test('upgrade rejects forbidden paths, failed tests, changed stage and unverified additions',async t=>{
  const {dataDir,manager}=await fixture(t);
  for(const name of ['../outside.mjs','core/../desktop/main.mjs','package.json','node_modules/x.mjs','desktop/recovery.mjs','desktop/Recovery.mjs','desktop/bootstrap.cjs','desktop/Bootstrap.cjs','desktop/packaged-paths.mjs'])await assert.rejects(manager.stage([{path:name,content:'x'}]),/Invalid/);
  const failed=await manager.stage([{path:'core/value.mjs',content:'export const value=3;'}]);assert.equal((await manager.verify(failed.id)).verified,false);await assert.rejects(manager.apply(failed.id),/Verify/);
  const changed=await manager.stage([{path:'core/value.mjs',content:'export const value=2;'}]);await manager.verify(changed.id);
  await fs.writeFile(path.join(dataDir,'upgrades',changed.id,'stage','core','value.mjs'),'tampered');await assert.rejects(manager.apply(changed.id),/changed/);
  const extra=await manager.stage([{path:'core/value.mjs',content:'export const value=2;'}]);await manager.verify(extra.id);
  await fs.writeFile(path.join(dataDir,'upgrades',extra.id,'stage','extra.mjs'),'tampered');await assert.rejects(manager.apply(extra.id),/unverified/);
});
test('partial apply failure restores files and rollback refuses newer edits',async t=>{
  const {sourceDir,manager}=await fixture(t);
  const stage=await manager.stage([{path:'core/value.mjs',content:'export const value=2;'},{path:'core/second.mjs',content:'export const second=2;'}]);await manager.verify(stage.id);
  const originalRename=fs.rename;
  fs.rename=async(from,to)=>{if(to===path.join(sourceDir,'core','second.mjs'))throw new Error('Synthetic disk write failure');return originalRename(from,to);};
  try{await assert.rejects(manager.apply(stage.id),/Synthetic/);}finally{fs.rename=originalRename;}
  assert.equal(await fs.readFile(path.join(sourceDir,'core','value.mjs'),'utf8'),'export const value=1;');
  await manager.apply(stage.id);await fs.writeFile(path.join(sourceDir,'core','value.mjs'),'newer edit');await assert.rejects(manager.rollback(),/newer changes/);
});
test('cancelled approval cannot apply, unchanged dependencies are part of the baseline',async t=>{
  const controller=new AbortController();
  const {sourceDir,manager}=await fixture(t,{confirm:async()=>{controller.abort();return true;}});
  const stage=await manager.stage([{path:'core/value.mjs',content:'export const value=2;'}]);await manager.verify(stage.id);
  await assert.rejects(manager.apply(stage.id,controller.signal),/abort/i);
  assert.equal(await fs.readFile(path.join(sourceDir,'core','value.mjs'),'utf8'),'export const value=1;');
  await fs.writeFile(path.join(sourceDir,'test','value.test.mjs'),'// changed dependency');await assert.rejects(manager.apply(stage.id),/Source changed/);
});
test('concurrent apply requests serialize and reject an obsolete baseline',async t=>{
  const {manager}=await fixture(t);
  const first=await manager.stage([{path:'core/value.mjs',content:'export const value=2;'}]),second=await manager.stage([{path:'core/value.mjs',content:'export const value=2; // second'}]);
  await manager.verify(first.id);await manager.verify(second.id);
  const outcomes=await Promise.allSettled([manager.apply(first.id),manager.apply(second.id)]);
  assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[1].status,'rejected');assert.match(outcomes[1].reason.message,/Source changed/);
});
test('upgrade stages include model hub dependencies and permit their source updates',async t=>{
  const {sourceDir,manager}=await fixture(t);await fs.mkdir(path.join(sourceDir,'model-hub'));await fs.writeFile(path.join(sourceDir,'model-hub','value.mjs'),'export const value=1;');
  await fs.writeFile(path.join(sourceDir,'test','value.test.mjs'),"import {value} from '../model-hub/value.mjs';import assert from 'node:assert/strict';assert.equal(value,2);");
  const stage=await manager.stage([{path:'model-hub/value.mjs',content:'export const value=2;'}]);assert.equal((await manager.verify(stage.id)).verified,true);
});

test('upgrade stages retain and permit local runtime manager source dependencies',async t=>{
  const {sourceDir,manager}=await fixture(t);await fs.mkdir(path.join(sourceDir,'local-models'));await fs.writeFile(path.join(sourceDir,'local-models','value.mjs'),'export const value=1;');
  await fs.writeFile(path.join(sourceDir,'test','value.test.mjs'),"import {value} from '../local-models/value.mjs';import assert from 'node:assert/strict';assert.equal(value,2);");
  const stage=await manager.stage([{path:'local-models/value.mjs',content:'export const value=2;'}]);assert.equal((await manager.verify(stage.id)).verified,true);
});

// Synthetic successful runner isolates activation policy; the earlier fixtures run real tests.
const verifiedRunner=async()=>({code:0,stdout:'fixture verified',stderr:''});
async function applyChanges(manager,changes){const stage=await manager.stage(changes);assert.equal((await manager.verify(stage.id)).verified,true);return manager.apply(stage.id);}

test('renderer/test update requests UI refresh and rollback refresh without claiming activation',async t=>{
  const notifications=[];
  const {sourceDir,manager}=await fixture(t,{runner:verifiedRunner,onApplied:async event=>notifications.push(event)});
  const result=await applyChanges(manager,[{path:'renderer/app.mjs',content:'// UI v2'},{path:'test/ui.test.mjs',content:'// UI test'}]);
  assert.equal(result.applied,true);assert.equal(result.restartRequired,false);assert.equal(result.activation,'ui-refresh');
  assert.equal(result.uiRefreshRequested,true);assert.equal(result.uiRefreshPending,true);assert.equal(result.active,undefined);
  assert.deepEqual(notifications,[{id:result.id,files:['renderer/app.mjs','test/ui.test.mjs']}]);
  assert.deepEqual(await manager.activationStatus(),{restartRequired:false,changedFiles:[]});
  const rollback=await manager.rollback();assert.equal(rollback.rolledBack,true);assert.equal(rollback.restartRequired,false);assert.equal(rollback.uiRefreshRequested,true);
  assert.equal(notifications[1].rolledBack,true);assert.equal(notifications[1].id,result.id);
  await assert.rejects(fs.readFile(path.join(sourceDir,'renderer/app.mjs')),/ENOENT/);
});

test('test-only updates need no activation, callback failures leave applied UI honestly pending',async t=>{
  let notifications=0;
  const {sourceDir,manager}=await fixture(t,{runner:verifiedRunner,onApplied:async()=>{notifications++;throw new Error('Fixture detached window');}});
  const tests=await applyChanges(manager,[{path:'test/extra.test.mjs',content:'// tests'}]);
  assert.equal(tests.activation,'none');assert.equal(tests.restartRequired,false);assert.equal(tests.uiRefreshPending,false);assert.equal(notifications,0);
  const ui=await applyChanges(manager,[{path:'renderer/app.mjs',content:'// applied despite failed notification'}]);
  assert.equal(ui.applied,true);assert.equal(ui.uiRefreshRequested,false);assert.equal(ui.uiRefreshPending,true);assert.match(ui.refreshError,/detached window/);
  assert.equal(await fs.readFile(path.join(sourceDir,'renderer/app.mjs'),'utf8'),'// applied despite failed notification');
  assert.equal((await manager.rollback()).rolledBack,true);assert.equal(notifications,2);
});

test('mixed/backend updates require restart; later UI apply cannot bypass pending backend changes',async t=>{
  let notifications=0;
  const {manager}=await fixture(t,{runner:verifiedRunner,onApplied:()=>notifications++});
  const mixed=await applyChanges(manager,[{path:'core/value.mjs',content:'export const value=2;'},{path:'renderer/app.mjs',content:'// UI'}]);
  assert.equal(mixed.restartRequired,true);assert.equal(mixed.activation,'restart');assert.equal(mixed.uiRefreshRequested,false);
  const ui=await applyChanges(manager,[{path:'renderer/app.mjs',content:'// newer UI'}]);
  assert.equal(ui.restartRequired,true);assert.equal(ui.uiRefreshPending,false);assert.equal(notifications,0);
  assert.deepEqual((await manager.activationStatus()).changedFiles,['core/value.mjs']);
  const rollback=await manager.rollback();assert.equal(rollback.restartRequired,true);assert.equal(notifications,0);
});

test('startup backend baseline detects out-of-band edits, additions, removals and manifests; exact restoration clears it',async t=>{
  const {sourceDir,manager}=await fixture(t,{runner:verifiedRunner});
  for(const relative of ['core/new.mjs','desktop/main.mjs','tools/tool.mjs','extensions/extension.mjs','model-hub/hub.mjs','local-models/model.mjs','package.json','package-lock.json']){
    const target=path.join(sourceDir,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'{}');
    assert.deepEqual(await manager.activationStatus(),{restartRequired:true,changedFiles:[relative]});
    await fs.rm(target);assert.equal((await manager.activationStatus()).restartRequired,false);
  }
  const original=path.join(sourceDir,'core/value.mjs');await fs.rm(original);
  assert.deepEqual((await manager.activationStatus()).changedFiles,['core/value.mjs']);
  await fs.writeFile(original,'export const value=1;');assert.equal((await manager.activationStatus()).restartRequired,false);
  await applyChanges(manager,[{path:'core/value.mjs',content:'export const value=2;'}]);await manager.rollback();
  assert.equal((await manager.activationStatus()).restartRequired,false);
});

test('activation check fails closed during an apply awaiting confirmation without queue deadlock',async t=>{
  let entered,release;const confirming=new Promise(resolve=>entered=resolve),answer=new Promise(resolve=>release=resolve);
  const {manager}=await fixture(t,{runner:verifiedRunner,confirm:async()=>{entered();return answer;}});
  const stage=await manager.stage([{path:'renderer/app.mjs',content:'// UI'}]);await manager.verify(stage.id);
  const applying=manager.apply(stage.id);await confirming;
  assert.deepEqual(await manager.activationStatus(),{restartRequired:true,busy:true,changedFiles:[]});
  release(true);const result=await applying;assert.equal(result.uiRefreshRequested,false);assert.equal(result.uiRefreshPending,true);
  assert.equal((await manager.activationStatus()).restartRequired,false);
});

test('core snapshots cover complete application source and reuse only verified unchanged backups',async t=>{
  const {sourceDir,dataDir,manager}=await fixture(t,{runner:verifiedRunner});
  for(const [relative,content] of [['desktop/bootstrap.cjs','immutable bootstrap'],['renderer/app.mjs','interface'],['docs/contract.md','contract'],['CONTRACT.md','root contract'],['package.json','{}'],['Start-Faber.ps1','launcher'],['native/vendor/dependency.c','dependency'],['node_modules/package/index.js','dependency'],['models/weights.gguf','weights'],['.git/config','git metadata']]){const file=path.join(sourceDir,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);}
  await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(path.join(dataDir,'secrets.json'),'never back up private state');
  const first=await manager.backupCore(),manifest=JSON.parse(await fs.readFile(path.join(dataDir,'upgrades',first.id,'core-backup.json'),'utf8'));
  assert.equal(manifest.schemaVersion,1);for(const name of ['core/value.mjs','desktop/bootstrap.cjs','renderer/app.mjs','docs/contract.md','CONTRACT.md','package.json','Start-Faber.ps1'])assert.ok(manifest.files.some(file=>file.path===name),name);
  assert.equal(manifest.files.some(file=>/node_modules|vendor|weights|secrets|\.git\//.test(file.path)),false);
  assert.equal((await manager.backupCore()).id,first.id);assert.equal((await manager.backupCore()).reused,true);
  await fs.writeFile(path.join(sourceDir,'core/value.mjs'),'export const value=9;');const changed=await manager.backupCore();assert.notEqual(changed.id,first.id);
  await fs.writeFile(path.join(changed.backupDir,'core/value.mjs'),'tampered');await assert.rejects(manager.backupCore(),/integrity mismatch/);
});

test('a staged mutation saves untouched core files too and backup failure prevents activation',async t=>{
  const {sourceDir,dataDir,manager}=await fixture(t,{runner:verifiedRunner});await fs.writeFile(path.join(sourceDir,'core/untouched.mjs'),'retain this source');
  const stage=await manager.stage([{path:'core/value.mjs',content:'export const value=2;'}]);await manager.verify(stage.id);
  const originalWrite=fs.writeFile.bind(fs);t.mock.method(fs,'writeFile',async(filename,...args)=>{if(String(filename).includes(`${path.sep}backup${path.sep}`))throw Error('Synthetic backup failure');return originalWrite(filename,...args);});
  await assert.rejects(manager.apply(stage.id),/backup failure/);assert.equal(await fs.readFile(path.join(sourceDir,'core/value.mjs'),'utf8'),'export const value=1;');t.mock.restoreAll();
  await manager.apply(stage.id);assert.equal(await fs.readFile(path.join(dataDir,'upgrades',stage.id,'backup/core/untouched.mjs'),'utf8'),'retain this source');
});

test('reusing a core snapshot rejects a source edit made after its initial byte capture',async t=>{
  const {sourceDir,dataDir,manager}=await fixture(t,{runner:verifiedRunner}),file=path.join(sourceDir,'core/value.mjs');
  const first=await manager.backupCore(),pointer=path.join(dataDir,'upgrades','last-core-backup.json'),readFile=fs.readFile.bind(fs);let edit=true;
  t.mock.method(fs,'readFile',async(filename,...args)=>{const bytes=await readFile(filename,...args);if(edit&&filename===pointer){edit=false;await fs.writeFile(file,'newer concurrent source');}return bytes;});
  await assert.rejects(manager.backupCore(),/Source changed during core backup/);
  assert.equal(await readFile(file,'utf8'),'newer concurrent source');
  assert.equal(await readFile(path.join(first.backupDir,'core/value.mjs'),'utf8'),'export const value=1;');
});
