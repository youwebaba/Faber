import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../core/runtime.mjs';

test('background subscriptions omit chat contents; public listeners get independent durable revisions', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'faber-state-events-'));
  const runtime=await createRuntime({dataDir:path.join(dir,'data'),sourceDir:path.join(dir,'code')});
  t.after(async()=>{await runtime.close();await fs.rm(dir,{recursive:true,force:true});});
  let lifecycle; const snapshots=[];
  runtime.subscribe(e=>{lifecycle=e.state;},{accept:type=>type==='state',view:'lifecycle'});
  const detach=runtime.subscribe(e=>{e.state.projects.length=0;},{accept:type=>type==='state'});
  runtime.subscribe(e=>snapshots.push(e.state),{accept:type=>type==='state'});
  let cloned=false;
  runtime.emit({type:'test-unmatched',get payload(){cloned=true;return 'ignored';}});
  assert.equal(cloned,false);
  const project=await runtime.request('project.create',{name:'Fixture',path:dir});
  detach();
  await runtime.request('chat.create',{projectId:project.id,title:'Retained'});
  const state=await runtime.request('state.get');
  assert.deepEqual(snapshots.at(-1),state);
  assert.ok(snapshots.at(-2).stateRevision<snapshots.at(-1).stateRevision);
  assert.equal(lifecycle.stateRevision,state.stateRevision);
  assert.deepEqual(Object.keys(lifecycle.chats[0]).sort(),['archived','id']);
  assert.equal(lifecycle.projects,undefined);
});
