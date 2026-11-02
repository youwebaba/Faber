import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareWorkbench } from '../desktop/packaged-paths.mjs';
import { createUpgrades } from '../desktop/upgrades.mjs';

export async function runPackagedSmoke({window,runtime,localModels,dataDir,sourceDir}) {
  const bootstrap = globalThis.__FABER_BOOTSTRAP__; assert.equal(bootstrap.packaged,true);
  assert.ok(!sourceDir.includes('app.asar')); assert.notEqual(sourceDir,dataDir);
  for(const name of ['native.ps1','voice.ps1','preload.cjs'])assert.ok((await fs.stat(path.join(sourceDir,'desktop',name))).isFile());
  const hardware = await localModels.request('localModels.hardware'); assert.equal(hardware.runtime.available,true);
  const state = await runtime.request('state.get');
  for(const name of ['shell_run','upgrade_stage','upgrade_verify','upgrade_apply','local_model_start','local_model_delete'])assert.ok(state.tools.some(tool=>tool.name===name),`Missing packaged tool ${name}`);
  assert.match(await window.webContents.executeJavaScript('document.body.innerText'),/Faber/);
  const fixture=path.join(dataDir,'recovery-source');await fs.mkdir(path.join(fixture,'desktop'),{recursive:true});await fs.mkdir(path.join(fixture,'test'));
  const original='export const fixture = true;\n';await fs.writeFile(path.join(fixture,'desktop','main.mjs'),original);
  await fs.writeFile(path.join(fixture,'test','fixture.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('packaged Node verifier',()=>assert.ok(process.versions.node));");
  await fs.writeFile(path.join(fixture,'package.json'),'{"type":"module"}');
  const recoveryProfile=path.join(dataDir,'recovery-profile');await fs.mkdir(recoveryProfile);
  const recoverySource=await prepareWorkbench({bundledSource:fixture,workbenchRoot:`${recoveryProfile}-workbench`,version:bootstrap.version});
  const upgrades=createUpgrades({sourceDir:recoverySource,dataDir:recoveryProfile,confirm:async()=>true});
  const staged=await upgrades.stage([{path:'desktop/main.mjs',content:'throw new Error("Controlled broken app must not import during recovery");'}]);
  const verified=await upgrades.verify(staged.id);assert.equal(verified.verified,true,verified.stderr);await upgrades.apply(staged.id);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await promisify(execFile)(process.execPath,['--smoke-package','--smoke-profile',recoveryProfile,'--rollback-last'],{env,windowsHide:true,timeout:30000});
  assert.equal((JSON.parse(await fs.readFile(path.join(recoveryProfile,'recovery-report.json'),'utf8'))).rolledBack,true);
  assert.equal(await fs.readFile(path.join(recoverySource,'desktop','main.mjs'),'utf8'),original);
  const screenshot=path.join(dataDir,'packaged-faber.png');await fs.writeFile(screenshot,(await window.webContents.capturePage()).toPNG());
  const report={ok:true,packaged:true,version:bootstrap.version,sourceDir,dataDir,node:process.versions.node,electron:process.versions.electron,tools:state.tools.length,bundledRuntime:hardware.runtime,gpus:hardware.gpus.map(item=>({id:item.id,name:item.name})),nativeScriptsRealPaths:true,packagedNodeVerifier:true,independentRecovery:true,noInference:true,screenshot};
  const reportPath=path.join(dataDir,'packaged-report.json');await fs.writeFile(reportPath,JSON.stringify(report,null,2));return {...report,reportPath};
}

