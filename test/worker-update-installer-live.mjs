// Explicit isolated probe: old packaged Electron/ASAR, current extracted helper,
// old packaged uninstall helper, then current trusted startup. No installed app
// or owner profile is selected implicitly. This does not execute the NSIS UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareWorkerStartup} from '../desktop/worker-update.cjs';
import {openProfileActionLedger} from '../desktop/action-ledger.cjs';
const option=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
const executable=option('--old-executable');
if(!executable||!path.isAbsolute(executable))throw new Error('Supply a read-only old packaged executable explicitly');
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'Faber-checkpoint-packaged-'))),install=path.dirname(executable),asar=path.join(install,'resources','app.asar'),cli=fileURLToPath(new URL('../desktop/worker-update-cli.cjs',import.meta.url));
assert.equal((await fs.stat(asar)).isFile(),true,'The previous application must contain a real ASAR');
function execute(args){return new Promise((resolve,reject)=>{const child=spawn(executable,args,{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));});}
const versionResult=await execute(['-e',`console.log(require(${JSON.stringify(path.join(asar,'package.json'))}).version)`]);assert.equal(versionResult.code,0,versionResult.stderr);const oldVersion=versionResult.stdout.trim();
const cases=[];
for(const variant of ['legacy','needs_attention','modern']){
  const local=path.join(root,variant),dataDir=path.join(local,'Faber'),registryRoot=path.join(local,'FaberProfiles');await fs.mkdir(dataDir,{recursive:true});
  const legacy={version:1,projects:[],chats:[],runs:[],providers:[],settings:{}},state=variant==='modern'?{...legacy,workerProtocol:1,workerQueue:{paused:false},routines:[{id:'routine',enabled:true,bootGrant:{eligible:true}}],jobs:[{id:'job',status:'completed',outputs:[{externalId:'sent-once'}]}],runs:[{id:'run',toolEvents:[{id:'event',intent:{phase:'received',receipt:{externalId:'sent-once'}}}]}]}:legacy;
  await fs.writeFile(path.join(dataDir,'state.json'),JSON.stringify(state));
  const args=['--install-root',install,'--to-version','3.0.1','--isolated-local-app-data',local],steps=[];
  if(variant!=='modern'){
    const publishedArgs=[...args];publishedArgs[publishedArgs.indexOf('--to-version')+1]='3.0.0';
    const failed=await execute([path.join(asar,'desktop','worker-update-cli.cjs'),'--mode','prepare',...publishedArgs]);assert.equal(failed.code,1);assert.match(failed.stderr,/Migration omitted the worker journal/);steps.push({step:'old-published-helper',target:'3.0.0',exit:failed.code,expectedFailure:true});
    if(variant==='needs_attention'){
      const recovery=await execute(['-e',`require(${JSON.stringify(path.join(asar,'desktop','worker-update.cjs'))}).prepareWorkerStartup(${JSON.stringify({dataDir,registryRoot,isolated:true})}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;})`]);assert.equal(recovery.code,0,recovery.stderr);assert.equal(JSON.parse(recovery.stdout).safeMode,true);
    }
  }
  for(const mode of ['prepare','prepare']){const result=await execute([cli,'--mode',mode,...args]);assert.equal(result.code,0,result.stderr);steps.push({step:'patched-'+mode,exit:result.code});}
  const uninstalled=await execute([path.join(asar,'desktop','worker-update-cli.cjs'),'--mode','uninstall',...args]);assert.equal(uninstalled.code,0,uninstalled.stderr);steps.push({step:'old-asar-uninstall',exit:uninstalled.code});
  const retry=await execute([cli,'--mode','prepare',...args]);assert.equal(retry.code,0,retry.stderr);steps.push({step:'patched-post-uninstall-retry',exit:retry.code});
  const result=await prepareWorkerStartup({dataDir,registryRoot,isolated:true});assert.equal(result.queuePaused,true);assert.equal((await prepareWorkerStartup({dataDir,registryRoot,isolated:true})).safeMode,false);
  const final=JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'));assert.equal(final.workerQueue.paused,true);assert.deepEqual(final.jobs,state.jobs||[]);assert.deepEqual(final.runs,state.runs);if(variant==='modern')assert.equal(final.routines[0].bootGrant,undefined);
  const ledger=await openProfileActionLedger({dataDir,registryRoot,isolated:true});try{const transaction=JSON.parse(await fs.readFile(path.join(ledger.directory,'updates','worker-update.json'),'utf8'));assert.equal(transaction.fromVersion,oldVersion,'Node-mode fs/promises must resolve the real installed ASAR');assert.equal(transaction.phase,'committed');}finally{await ledger.close();}
  cases.push({variant,steps,firstStartup:true,secondStartup:true,queuePaused:true,receiptsRetained:true});
}
const evidence={ok:true,oldVersion,actualPackagedElectron:true,actualAsar:true,ownerProfileAccessed:false,actualNsisExecuted:false,cases};await fs.writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({evidence:path.join(root,'evidence.json'),...evidence}));
