import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startWorkerControl,callWorkerControl} from '../desktop/worker-control.cjs';
test('profile-authenticated handoff permits only narrow lifecycle commands and keeps tokens outside backup state',async t=>{const dataDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-control-test-'))),calls=[],server=await startWorkerControl({dataDir,kind:'boot',handler:async command=>{calls.push(command);return {kind:'boot',checkpointed:command==='handoff'};}});t.after(async()=>{await server.close();await fs.rm(dataDir,{recursive:true,force:true});});assert.equal((await callWorkerControl({dataDir,command:'status'})).kind,'boot');assert.equal((await callWorkerControl({dataDir,command:'handoff'})).checkpointed,true);await assert.rejects(callWorkerControl({dataDir,command:'tool.run'}),/Unknown/);const file=path.join(dataDir,'worker-control.json'),metadata=JSON.parse(await fs.readFile(file,'utf8'));metadata.token='b'.repeat(64);await fs.writeFile(file,JSON.stringify(metadata));await assert.rejects(callWorkerControl({dataDir,command:'shutdown'}),/authority/);assert.deepEqual(calls,['status','handoff']);});
