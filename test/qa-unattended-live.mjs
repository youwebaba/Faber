import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runUnattendedAcceptance} from './qa-unattended.fixture.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-a30-qa-acceptance-')),report=await runUnattendedAcceptance(root);console.log(JSON.stringify({report:path.join(root,'unattended-acceptance.json'),...report}));
