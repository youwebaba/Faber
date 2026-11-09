import test from 'node:test';
import assert from 'node:assert/strict';
import {validUpgradePath} from '../desktop/recovery.mjs';
test('model-authored core upgrades cannot replace installer-owned effect, boot, migration or control authority',()=>{for(const name of ['action-ledger.cjs','worker-update.cjs','worker-update-cli.cjs','worker-control.cjs','boot-task.mjs','boot-task.ps1','boot-launch.ps1','boot-worker.cjs','boot-runtime.mjs','boot-control.mjs'])assert.equal(validUpgradePath('desktop/'+name),false,name);assert.equal(validUpgradePath('core/routines.mjs'),true);assert.equal(validUpgradePath('renderer/routines.mjs'),true);});
