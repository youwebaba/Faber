import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {scanStableFiles} from '../core/file-triggers.mjs';

async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-file-trigger-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'input'));await fs.mkdir(path.join(root,'reports'));return {root,trigger:{directory:'.',excludePaths:['reports'],stableMs:1000},observations:new Map(),processed:new Set()};}
test('partial copies wait for stable bytes; duplicate notifications and watcher restarts retain one identity',async t=>{
  const f=await fixture(t),file=path.join(f.root,'input','new.txt');await fs.writeFile(file,'partial');assert.equal((await scanStableFiles({...f,projectRoot:f.root,now:1000})).events.length,0);await fs.appendFile(file,' completed');assert.equal((await scanStableFiles({...f,projectRoot:f.root,now:2000})).events.length,0);const ready=await scanStableFiles({...f,projectRoot:f.root,now:3000});assert.equal(ready.events.length,1);assert.equal(ready.events[0].path,'input/new.txt');f.processed.add(ready.events[0].key);assert.equal((await scanStableFiles({...f,projectRoot:f.root,now:4000})).events.length,0);
  f.observations=new Map();await scanStableFiles({...f,projectRoot:f.root,now:5000});assert.equal((await scanStableFiles({...f,projectRoot:f.root,now:6000})).events.length,0);
});
test('replacing bytes at the same path creates a new identity while outputs never trigger',async t=>{
  const f=await fixture(t),file=path.join(f.root,'input','same.txt');await fs.writeFile(file,'first');await fs.writeFile(path.join(f.root,'reports','own.md'),'own output');await scanStableFiles({...f,projectRoot:f.root,now:1000});const original=(await scanStableFiles({...f,projectRoot:f.root,now:2000})).events[0];f.processed.add(original.key);await fs.writeFile(file,'second');await scanStableFiles({...f,projectRoot:f.root,now:3000});const changed=await scanStableFiles({...f,projectRoot:f.root,now:4000});assert.equal(changed.events.length,1);assert.notEqual(changed.events[0].key,original.key);assert.equal(changed.events[0].path,'input/same.txt');
});
test('scope revocation, output races and oversized files yield no unauthorized ready event',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'input','large.txt'),'12345');const result=await scanStableFiles({...f,projectRoot:f.root,now:1000,maxBytes:4});assert.equal(result.events.length,0);assert.match(result.errors[0].message,/4 bytes/);let permitted=true;await scanStableFiles({...f,projectRoot:f.root,now:2000,allowed:async()=>permitted});permitted=false;assert.equal((await scanStableFiles({...f,projectRoot:f.root,now:3000,allowed:async()=>permitted})).events.length,0);
  const race=await scanStableFiles({...f,projectRoot:f.root,now:4000,isOutput:name=>name==='input/large.txt'});assert.equal(race.events.length,0);
});
