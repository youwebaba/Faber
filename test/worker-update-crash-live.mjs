// Real process interruption at the durable migration boundary, separate from installer UI execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openProfileActionLedger} from '../desktop/action-ledger.cjs';
import {createWorkerUpdate,prepareWorkerStartup} from '../desktop/worker-update.cjs';
const self=fileURLToPath(import.meta.url),childIndex=process.argv.indexOf('--child-root'),root=childIndex<0?await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'Faber-migration-crash-'))):process.argv[childIndex+1],dataDir=path.join(root,'profile'),registryRoot=path.join(root,'registry');
const relative=path.relative(os.tmpdir(),root);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Migration fixture must remain in the temporary directory');
const action={jobId:'stable-job',actionKey:'a'.repeat(64),tool:'fixture_delivery',scope:{projectId:'project',accountId:'account'},identity:'stable-message-draft'};
if(childIndex>=0){
  await fs.mkdir(dataDir,{recursive:true});const ledger=await openProfileActionLedger({dataDir,registryRoot,isolated:true}),reservation=await ledger.reserve(action);await ledger.markDispatch(reservation.key);await fs.appendFile(path.join(root,'destination.txt'),'once\n');await ledger.receipt(reservation.key,{verified:true,status:'completed',externalId:'immutable-delivery-id'});
  const state={version:1,workerProtocol:1,workerQueue:{paused:true},routines:[{id:'r',enabled:true}],jobs:[{id:'stable-job',status:'completed',outputs:[{externalId:'immutable-delivery-id'}]}],runs:[{id:'run',toolEvents:[{id:'event',intent:{key:reservation.key,phase:'received',receipt:{verified:true,result:{externalId:'immutable-delivery-id'}}}}]}]};await fs.writeFile(path.join(dataDir,'state.json'),JSON.stringify(state));
  const update=await createWorkerUpdate({directory:path.join(ledger.directory,'updates'),namespace:ledger.namespace,protocol:2,onPhase:phase=>{if(phase==='migrating')process.exit(94);}});await update.prepare({fromVersion:'2.8.0',toVersion:'2.9.0',fromProtocol:1,toProtocol:2,wasPaused:false,quiesce:async()=>{},checkpoint:async()=>state});await update.migrate({readState:async()=>state,writeState:value=>fs.writeFile(path.join(dataDir,'state.json'),JSON.stringify(value))});throw new Error('Controlled migration crash did not occur');
}else{
  const child=spawn(process.execPath,[self,'--child-root',root],{windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes.toString());const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,94,log);
  const recovered=await prepareWorkerStartup({dataDir,registryRoot,isolated:true,protocol:2});assert.equal(recovered.queuePaused,true);const state=JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'));assert.equal(state.workerProtocol,2);assert.equal(state.workerQueue.paused,true);assert.equal(state.jobs[0].outputs[0].externalId,'immutable-delivery-id');assert.equal(state.runs[0].toolEvents[0].intent.receipt.result.externalId,'immutable-delivery-id');
  const ledger=await openProfileActionLedger({dataDir,registryRoot,isolated:true});try{const replay=await ledger.reserve(action);assert.equal(replay.decision,'reuse');assert.equal(replay.receipt.externalId,'immutable-delivery-id');const update=await createWorkerUpdate({directory:path.join(ledger.directory,'updates'),namespace:ledger.namespace,protocol:2});assert.equal(update.status().phase,'committed');}finally{await ledger.close();}
  assert.equal(await fs.readFile(path.join(root,'destination.txt'),'utf8'),'once\n');const evidence={ok:true,actualProcessCrash:true,crashExitCode:94,queuePaused:true,schemaMigrated:2,immutableReceiptsRetained:true,duplicateEffects:0,actualInstallerExecuted:false};await fs.writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({evidence:path.join(root,'evidence.json'),...evidence}));
}
