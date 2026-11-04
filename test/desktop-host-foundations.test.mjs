import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createProfiles,assertProfileSwitchAllowed} from '../desktop/profile-path.cjs';
import {beginBoot,readBootState,updateBoot} from '../desktop/boot-state.cjs';
import {disableRecoveryAddons,removeRecoveryAddon,validUpgradePath} from '../desktop/recovery.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-host-foundations-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('profiles preserve the legacy directory and isolate new UUID paths and registry selection',async t=>{
  const root=await fixture(t),legacy=path.join(root,'SophiaHarness');await fs.mkdir(legacy);await fs.writeFile(path.join(legacy,'secrets.json'),'original credentials');
  const profiles=createProfiles(root);assert.equal(profiles.directory('default'),legacy);
  assert.ok(profiles.privatePaths.includes(legacy));assert.ok(profiles.privatePaths.includes(path.join(root,'FaberProfiles')));assert.equal(Object.isFrozen(profiles.privatePaths),true);
  const added=profiles.create('../A display name');assert.match(added.id,/^[a-f0-9-]{36}$/);assert.equal(profiles.directory(added.id),path.join(root,'FaberProfiles','profiles',added.id));
  profiles.rename(added.id,'Work');profiles.select(added.id);
  const restored=createProfiles(root);assert.equal(restored.currentId,added.id);assert.equal(restored.list().profiles.find(row=>row.id===added.id).name,'Work');
  assert.equal(await fs.readFile(path.join(legacy,'secrets.json'),'utf8'),'original credentials');await assert.rejects(fs.stat(path.join(profiles.directory(added.id),'secrets.json')),/ENOENT/);
  assert.throws(()=>profiles.directory('../escape'),/Unknown/);assert.throws(()=>profiles.create('   '),/name/);
  const registry=path.join(root,'FaberProfiles','profiles.json'),saved=JSON.parse(await fs.readFile(registry,'utf8'));saved.defaultDirectory=path.join(root,'outside');await fs.writeFile(registry,JSON.stringify(saved));assert.throws(()=>createProfiles(root),/Invalid profile registry/);
  await fs.writeFile(registry,'{broken registry');assert.throws(()=>createProfiles(root),/could not be read/);assert.equal(await fs.readFile(registry,'utf8'),'{broken registry');assert.equal(await fs.readFile(path.join(legacy,'secrets.json'),'utf8'),'original credentials');
});

test('profile switching refuses drafts, active chats/downloads, voice, updates and external calls',()=>{
  const idle={draftsCleared:true};assert.doesNotThrow(()=>assertProfileSwitchAllowed(idle));
  for(const extra of [{draftsCleared:false},{runs:[{status:'running'}]},{runs:[{status:'waiting_approval'}]},{downloads:[{status:'queued'}]},{downloads:[{status:'downloading'}]},{voiceBusy:true},{uiPending:true},{updating:true},{gatewayActive:1}])assert.throws(()=>assertProfileSwitchAllowed({...idle,...extra}));
  assert.doesNotThrow(()=>assertProfileSwitchAllowed({...idle,runs:[{status:'completed'}],downloads:[{status:'completed'}]}));
});

test('startup journal only recovers failed/incomplete sessions and never marks a healthy startup failed',async t=>{
  const root=await fixture(t),first=beginBoot(root);assert.equal(first.safeMode,false);
  assert.equal(updateBoot(root,'wrong-boot','failed','stale watchdog'),false);
  updateBoot(root,first.id,'ready');assert.equal(updateBoot(root,first.id,'failed','late watchdog'),false);
  const recovered=beginBoot(root);assert.equal(recovered.safeMode,true);assert.match(recovered.reason,/previous/);
  updateBoot(root,recovered.id,'ready');updateBoot(root,recovered.id,'clean');assert.equal(beginBoot(root).safeMode,false);
  const forced=beginBoot(await fixture(t),{safeMode:true});assert.equal(forced.safeMode,true);assert.match(forced.reason,/requested/);
  const corrupt=await fixture(t);await fs.writeFile(path.join(corrupt,'boot-state.json'),'{broken journal');const repaired=beginBoot(corrupt);assert.equal(repaired.safeMode,true);assert.match(repaired.reason,/could not be read/);
  assert.equal(readBootState(root).phase,'starting');assert.equal(validUpgradePath('desktop/boot-state.cjs'),false);
});

test('installer recovery disables and removes addon files without executing their modules',async t=>{
  const root=await fixture(t),manager=path.join(root,'addon-manager'),addon=path.join(root,'addons','broken');await fs.mkdir(manager);await fs.mkdir(addon,{recursive:true});
  await fs.writeFile(path.join(addon,'index.mjs'),'throw Error("This code must never be imported by recovery");');
  await fs.writeFile(path.join(manager,'state.json'),JSON.stringify({schemaVersion:1,records:{broken:{enabled:true,digest:'a'.repeat(64)}}}));
  assert.equal((await disableRecoveryAddons(root)).disabled,1);assert.equal(JSON.parse(await fs.readFile(path.join(manager,'state.json'),'utf8')).records.broken.enabled,false);
  assert.equal((await fs.readdir(manager)).filter(name=>name.includes('.recovery-')).length,1);
  const data=path.join(root,'addon-data','broken');await fs.mkdir(data,{recursive:true});await fs.writeFile(path.join(data,'private.txt'),'retain');
  await assert.rejects(removeRecoveryAddon(root,manager),/Choose one/);assert.equal((await removeRecoveryAddon(root,addon)).cleanupSkipped,true);assert.equal(await fs.readFile(path.join(data,'private.txt'),'utf8'),'retain');
});

test('installer addon recovery rejects storage junction escapes and never follows addon descendants',async t=>{
  const root=await fixture(t),outside=await fixture(t),externalAddon=path.join(outside,'external-addon');await fs.mkdir(externalAddon);await fs.writeFile(path.join(externalAddon,'sentinel'),'retain');await fs.writeFile(path.join(outside,'state.json'),JSON.stringify({schemaVersion:1,records:{external:{enabled:true}}}));
  try{await fs.symlink(outside,path.join(root,'addons'),process.platform==='win32'?'junction':'dir');await fs.symlink(outside,path.join(root,'addon-manager'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Filesystem links are unavailable');return;}throw error;}
  await assert.rejects(removeRecoveryAddon(root,externalAddon),/link or junction|escapes/);await assert.rejects(disableRecoveryAddons(root),/link or junction|escapes/);
  assert.equal(await fs.readFile(path.join(externalAddon,'sentinel'),'utf8'),'retain');assert.equal(JSON.parse(await fs.readFile(path.join(outside,'state.json'),'utf8')).records.external.enabled,true);
  await fs.unlink(path.join(root,'addons'));const owned=path.join(root,'addons','owned');await fs.mkdir(owned,{recursive:true});await fs.symlink(externalAddon,path.join(owned,'linked'),process.platform==='win32'?'junction':'dir');
  await removeRecoveryAddon(root,owned);assert.equal(await fs.readFile(path.join(externalAddon,'sentinel'),'utf8'),'retain');
});
