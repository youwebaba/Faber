import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateExtension} from '../desktop/extensions.mjs';
import {createAddons} from '../desktop/addons.mjs';
import * as sample from '../extensions/workspace-summary.mjs';

test('sample has a registered action that executes its real workspace tool',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-extension-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'one.txt'),'one');await fs.mkdir(path.join(root,'folder'));
  const {tools,metadata}=validateExtension(sample);assert.equal(metadata.actions[0].tool,tools[0].name);
  assert.deepEqual(await tools[0].execute({}, {project:{path:root}}),{files:1,directories:1,symlinks:0});
});
test('extension activation is explicit, atomic on failure, and checks approved digest',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-extension-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let active=[],confirmations=0;
  const runtime={replaceExtensionTools(tools,metadata){active=metadata;}};
  const manager=createAddons({dataDir:root,runtime,confirm:async()=>{confirmations++;return true;}});await manager.initialize();
  const source=await fs.readFile(new URL('../extensions/workspace-summary.mjs',import.meta.url),'utf8');
  await manager.install({id:'workspace-summary',source});assert.equal(confirmations,1);assert.equal(active.length,1);
  const reloaded=createAddons({dataDir:root,runtime,confirm:async()=>{throw new Error('Restart must reuse exact approved source');}});await reloaded.initialize();assert.equal(active.length,1);
  await assert.rejects(manager.install({id:'workspace-summary',source:'export const manifest={};export const tools=[];'}),/Invalid/);assert.equal(active.length,1);
  await fs.appendFile(path.join(root,'addons','workspace-summary','index.mjs'),'\n// tampered');
  const rechecked=await manager.reload();assert.equal(rechecked.addons.find(row=>row.id==='workspace-summary').enabled,false);assert.equal(active.length,0);
  await manager.disable('workspace-summary');assert.equal(active.length,0);
  const denied=createAddons({dataDir:root,runtime,confirm:async()=>false});await assert.rejects(denied.install({id:'workspace-summary',source}),/declined/);
});
test('cancellation while trust dialog is open never imports executable extension',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-extension-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const controller=new AbortController();
  const manager=createAddons({dataDir:root,runtime:{replaceExtensionTools(){}},confirm:async()=>{controller.abort();return true;}});
  await assert.rejects(manager.install({id:'canceled',source:'throw new Error("must not execute")'},controller.signal),/abort/i);
  await assert.rejects(fs.access(path.join(root,'extensions')));
});
test('concurrent installs serialize registry and durable approvals; queued canceled disable has no effect',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-extension-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let active=[];
  const manager=createAddons({dataDir:root,runtime:{replaceExtensionTools(tools,metadata){active=metadata;}},confirm:async()=>{await new Promise(r=>setTimeout(r,10));return true;}});await manager.initialize();
  const sampleSource=await fs.readFile(new URL('../extensions/workspace-summary.mjs',import.meta.url),'utf8');
  await Promise.all(['first','second'].map(id=>manager.install({id,source:sampleSource.replaceAll('workspace-summary',id).replaceAll('workspace_summary',id+'_summary')})));
  assert.deepEqual(active.map(m=>m.id),['first','second']);assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(root,'addon-manager','state.json'),'utf8')).records).sort(),['first','second']);
  const controller=new AbortController();controller.abort();await assert.rejects(manager.disable('first',controller.signal),/abort/i);assert.equal(active.length,2);
});
