import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAddons,readAddonPackage,addonPath,addonTools} from '../desktop/addons.mjs';
import {checkTool,validate} from '../core/registry.mjs';

async function fixture(t, confirm=async()=>true) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'faber-addons-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let tools=[],metadata=[],writes=0;
  const runtime={request:async()=>({tools:[{name:'builtin_tool'},...tools]}),replaceExtensionTools(next,meta){
    const names=new Set(['builtin_tool']);for(const tool of next){checkTool(tool);if(names.has(tool.name))throw new Error('Tool collision');names.add(tool.name);} tools=next;metadata=meta;writes++;
  }};
  const manager=createAddons({dataDir:root,runtime,confirm});
  return {root,runtime,manager,get tools(){return tools;},get metadata(){return metadata;},get writes(){return writes;}};
}
function kit(id,version='1.0.0',extra='') {
  const manifest={schemaVersion:1,id,name:`Example ${id}`,version,entry:'index.mjs',hostApi:1,permissions:['read']};
  const code=`import fs from 'node:fs/promises';\nimport path from 'node:path';\nimport {answer} from './helper.mjs';\n${extra}\nexport const manifest=${JSON.stringify({schemaVersion:1,id,name:manifest.name,version,actions:[{id:'run',label:'Run',tool:`${id.replaceAll('-','_')}_read`,fields:[]}]})};\nexport const tools=[{name:'${id.replaceAll('-','_')}_read',description:'Read example',permission:'read',parameters:{type:'object',properties:{},additionalProperties:false},execute:async(args,ctx)=>{await fs.writeFile(path.join(ctx.addon.dataDir,'value.txt'),answer);return answer;}}];`;
  return {schemaVersion:1,manifest,files:[{path:'index.mjs',content:code},{path:'helper.mjs',content:`export const answer=${JSON.stringify(version)};`}]};
}
async function writeKit(root,packageFile,name='import.faber-addon.json') {const file=path.join(root,name);await fs.writeFile(file,JSON.stringify(packageFile));return file;}

test('multi-file addon approval, lifecycle, data retention, reset, and registry tools',async t=>{
  let confirmations=0;const f=await fixture(t,async()=>{confirmations++;return true;});
  await f.manager.initialize();
  const file=await writeKit(f.root,kit('notes'));
  let result=await f.manager.installPath(file);
  assert.equal(confirmations,1);assert.equal(result.addons[0].status,'enabled');assert.equal(f.metadata[0].actions[0].tool,'notes_read');
  assert.equal(await f.tools[0].execute({},{}),'1.0.0');
  result=await f.manager.request('addons.list');assert.equal(result.addons[0].hasData,true);
  const writes=f.writes;await f.manager.request('addons.list');assert.equal(f.writes,writes,'reading status must not rewrite the chat registry');
  await assert.rejects(f.manager.request('addons.reset',{id:'notes'}),/Disable/);
  result=await f.manager.request('addons.disable',{id:'notes'});assert.equal(result.addons[0].enabled,false);assert.equal(f.tools.length,0);
  await f.manager.request('addons.enable',{id:'notes'});assert.equal(f.tools.length,1);
  result=await f.manager.request('addons.uninstall',{id:'notes'});assert.equal(result.addons.length,0);assert.equal(f.tools.length,0);
  assert.equal(await fs.readFile(path.join(f.root,'addon-data','notes','value.txt'),'utf8'),'1.0.0');
  await f.manager.request('addons.reset',{id:'notes'});await assert.rejects(fs.access(path.join(f.root,'addon-data','notes')),/ENOENT/);
  for(const tool of addonTools(f.manager))checkTool(tool);
  await assert.rejects(f.manager.request('addons.uninstall',{id:'../outside'}),/invalid string/);
  await assert.rejects(f.manager.request('addons.list',{extra:true}),/unknown property/);
});

test('changed files cannot run after restart and one removed or broken folder leaves other addons usable',async t=>{
  const f=await fixture(t);await f.manager.initialize();
  for(const id of ['first','second','broken'])await f.manager.installPath(await writeKit(f.root,kit(id),`${id}.json`));
  await fs.rm(path.join(f.root,'addons','first'),{recursive:true});
  await fs.writeFile(path.join(f.root,'addons','broken','addon.json'),'{invalid');
  await fs.appendFile(path.join(f.root,'addons','second','helper.mjs'),'\nglobalThis.__changedAddonExecuted=true;');
  await f.manager.request('addons.list');assert.equal(f.tools.length,0);
  await f.manager.close();
  const manager=createAddons({dataDir:f.root,runtime:f.runtime,confirm:async()=>{throw new Error('Startup cannot approve code');}});
  const result=await manager.initialize();
  assert.deepEqual(result.addons.map(row=>row.status),['error','untrusted']);assert.equal(f.tools.length,0);assert.equal(globalThis.__changedAddonExecuted,undefined);
  await fs.rm(path.join(f.root,'addons','broken'),{recursive:true});
  const trusted=createAddons({dataDir:f.root,runtime:f.runtime,confirm:async()=>true});await trusted.initialize();
  await trusted.request('addons.enable',{id:'second'});assert.equal(f.tools[0].name,'second_read');
  delete globalThis.__changedAddonExecuted;
});

test('upgrade and rollback keep private data and load changed relative imports',async t=>{
  const f=await fixture(t);await f.manager.initialize();
  await f.manager.installPath(await writeKit(f.root,kit('versioned')));await f.tools[0].execute({},{});
  const next=await f.manager.installPath(await writeKit(f.root,kit('versioned','2.0.0')));
  assert.equal(next.addons[0].canRollback,true);assert.equal(await f.tools[0].execute({},{}),'2.0.0');
  const restored=await f.manager.request('addons.rollback',{id:'versioned'});
  assert.equal(restored.addons[0].version,'1.0.0');
  assert.equal(await fs.readFile(path.join(f.root,'addon-data','versioned','value.txt'),'utf8'),'2.0.0','code rollback must not erase data');
  assert.equal(await f.tools[0].execute({},{}),'1.0.0');
});

test('declined or canceled trust never imports executable code',async t=>{
  const f=await fixture(t,async()=>false);const file=await writeKit(f.root,kit('denied','1.0.0','globalThis.__deniedAddonExecuted=true;'));
  await assert.rejects(f.manager.installPath(file),/declined/);assert.equal(globalThis.__deniedAddonExecuted,undefined);
  const controller=new AbortController();
  const manager=createAddons({dataDir:f.root,runtime:f.runtime,confirm:async()=>{controller.abort();return true;}});
  await assert.rejects(manager.installPath(file,controller.signal),/abort/i);assert.equal(globalThis.__deniedAddonExecuted,undefined);
});

test('failed replacement preserves existing visible package, approvals and live tools',async t=>{
  const f=await fixture(t);await f.manager.initialize();await f.manager.installPath(await writeKit(f.root,kit('stable')));
  const bad=kit('stable','2.0.0');bad.files[0].content=bad.files[0].content.replaceAll('stable_read','builtin_tool');
  await assert.rejects(f.manager.installPath(await writeKit(f.root,bad)),/collision/i);
  const row=(await f.manager.request('addons.list')).addons[0];assert.equal(row.version,'1.0.0');assert.equal(row.enabled,true);
  assert.equal(await f.tools[0].execute({},{}),'1.0.0');
});

test('package paths, links, compatibility and duplicate casing are checked before importing',async t=>{
  const f=await fixture(t);
  for(const value of ['../secret','C:/secret','/absolute','a\\b','a/../b','a:stream','NUL.txt','a.','node_modules/x.js'])assert.throws(()=>addonPath(value));
  const bad=kit('invalid');bad.files.push({path:'HELPER.mjs',content:'duplicate'});
  await assert.rejects(readAddonPackage(await writeKit(f.root,bad)),/Duplicate/);
  const future=kit('future');future.manifest.hostApi=2;
  await assert.rejects(readAddonPackage(await writeKit(f.root,future)),/Incompatible/);
  const encoded=kit('encoded');encoded.files.push({path:'asset.bin',encoding:'base64',content:'not base64!'});
  await assert.rejects(readAddonPackage(await writeKit(f.root,encoded)),/encoding/);
});

test('native chooser cancellation is inert and legacy source install migrates to an owned folder',async t=>{
  const f=await fixture(t);
  const manager=createAddons({dataDir:f.root,runtime:f.runtime,confirm:async()=>true,chooseAddon:async()=>null});
  assert.equal((await manager.request('addons.import',{kind:'file'})).canceled,true);
  const source=await fs.readFile(new URL('../extensions/workspace-summary.mjs',import.meta.url),'utf8');
  await manager.install({id:'workspace-summary',source});
  assert.equal((await manager.request('addons.list')).addons[0].enabled,true);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'addons','workspace-summary','addon.json'),'utf8')).id,'workspace-summary');
  await manager.close();
  const restarted=createAddons({dataDir:f.root,runtime:f.runtime,confirm:async()=>{throw new Error('Should reuse approved digest');}});
  assert.equal((await restarted.initialize()).addons[0].enabled,true);
});

test('invalid legacy approval shape cannot prevent startup or import a local addon',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.root,'extensions'));
  await fs.writeFile(path.join(f.root,'extensions','approved.json'),'{"unexpected":true}');
  const state=await f.manager.initialize();assert.match(state.warnings.join(' '),/Invalid legacy/);assert.equal(f.tools.length,0);
  await f.manager.installPath(await writeKit(f.root,kit('recovered')));assert.equal(f.tools[0].name,'recovered_read');
});

test('non-resolving top-level await is bounded and leaves the addon manager usable',async t=>{
  const f=await fixture(t), manager=createAddons({dataDir:f.root,runtime:f.runtime,confirm:async()=>true,loadTimeoutMs:30});
  const file=await writeKit(f.root,kit('stalled','1.0.0','await new Promise(()=>{});'));
  await assert.rejects(manager.installPath(file),/timed out/);
  const result=await manager.request('addons.list');assert.equal(result.addons.length,0);assert.equal(result.restartRequired,true);
  await manager.close();
});

test('disabling an addon releases a tool caller even when addon code ignores abort',async t=>{
  const f=await fixture(t);await f.manager.initialize();const packageFile=kit('busy');
  packageFile.files[0].content=packageFile.files[0].content.replace('return answer;','return new Promise(()=>{});');
  await f.manager.installPath(await writeKit(f.root,packageFile));
  const result=f.tools[0].execute({},{});const rejected=assert.rejects(result,/disabled/);
  const disable=f.manager.request('addons.disable',{id:'busy'});
  await rejected;await disable;assert.equal(f.tools.length,0);
});

test('unchanged addon reads emit no event loop and do not rewrite approval state',async t=>{
  const f=await fixture(t);const events=[];
  const manager=createAddons({dataDir:f.root,runtime:f.runtime,confirm:async()=>true,emit:event=>events.push(event)});
  await manager.initialize();const before=await fs.stat(path.join(f.root,'addon-manager','state.json'));
  for(let i=0;i<3;i++)await manager.request('addons.list');
  assert.equal(events.length,1);assert.equal((await fs.stat(path.join(f.root,'addon-manager','state.json'))).mtimeMs,before.mtimeMs);
  await manager.installPath(await writeKit(f.root,kit('evented')));assert.equal(events.length,2);
  await manager.request('addons.list');assert.equal(events.length,2);
});

test('Safe Mode imports no enabled addon until individually approved and removal skips code hooks',async t=>{
  const f=await fixture(t),file=await writeKit(f.root,kit('unsafe','1.0.0','globalThis.__safeModeExecuted=(globalThis.__safeModeExecuted||0)+1; export function deactivate(){throw Error("Unsafe deactivate");} export function uninstall(){throw Error("Unsafe uninstall");}'));
  const pkg=await readAddonPackage(file),folder=path.join(f.root,'addons','unsafe');
  for(const [relative,bytes] of pkg.files){const target=path.join(folder,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
  await fs.mkdir(path.join(f.root,'addon-manager'),{recursive:true});await fs.writeFile(path.join(f.root,'addon-manager','state.json'),JSON.stringify({schemaVersion:1,legacyMigrated:true,records:{unsafe:{enabled:true,digest:pkg.digest}},bundledSeen:[]}));
  const manager=createAddons({dataDir:f.root,runtime:f.runtime,safeMode:true,confirm:async()=>true});t.after(()=>{delete globalThis.__safeModeExecuted;});
  let state=await manager.initialize();assert.equal(state.safeMode,true);assert.equal(state.addons[0].safeDisabled,true);assert.equal(f.tools.length,0);assert.equal(globalThis.__safeModeExecuted,undefined);
  await manager.request('addons.list');assert.equal(globalThis.__safeModeExecuted,undefined);
  await manager.request('addons.enable',{id:'unsafe'});assert.equal(globalThis.__safeModeExecuted,1);assert.equal(f.tools.length,1);
  await manager.request('addons.disable',{id:'unsafe'});assert.equal(f.tools.length,0);
  state=await manager.request('addons.uninstall',{id:'unsafe'});assert.equal(state.addons.length,0);assert.match(state.warnings.join(' '),/Safe Mode skipped executable cleanup/);
});
