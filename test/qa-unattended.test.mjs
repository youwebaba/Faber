import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runUnattendedAcceptance} from './qa-unattended.fixture.mjs';
test('unattended production HTTP flow bounds idle/Stop/offline/budget/scope and reuses a saved effect after reopening',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-a30-qa-unit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await runUnattendedAcceptance(root);});
