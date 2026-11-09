// Opt-in Windows test of the real NSIS/System/nsExec checkpoint path. This is
// deliberately separate from packaged-app smoke: it executes installer macros,
// but never writes uninstall registration, shortcuts, tasks or installed files.
// Supply released binaries and the pinned NSIS compiler/plugins explicitly.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {prepareWorkerStartup} from '../desktop/worker-update.cjs';
import {openProfileActionLedger} from '../desktop/action-ledger.cjs';
import {acquireProfileOwner} from '../desktop/profile-owner.cjs';

if(process.platform!=='win32')throw new Error('This explicit fixture requires Windows and the real NSIS plugins');
const option=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const required=name=>{const value=option(name);if(!value||!path.isAbsolute(value))throw new Error(`Supply ${name} as an explicit absolute path`);return value;};
const oldExecutable=required('--old-executable'),workerExecutable=required('--worker-executable'),baselineMacro=required('--baseline-macro'),makensis=required('--makensis'),plugins=required('--nsis-plugins');
const source=fileURLToPath(new URL('../',import.meta.url)),currentMacro=path.join(source,'build','installer.nsh'),root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'Faber-nsis-checkpoint-')));
const baselineVersion=JSON.parse(await fs.readFile(path.resolve(path.dirname(baselineMacro),'..','package.json'),'utf8')).version;
const require=createRequire(import.meta.url),{createPackage}=require('@electron/asar'),{NsisScriptGenerator,nsisEscapeString}=require('app-builder-lib/out/targets/nsis/nsisScriptGenerator.js');
const q=value=>nsisEscapeString(value.replaceAll('/','\\'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidence={ok:false,actualNsis:true,actualNsExec:true,realPackagedElectron:true,realAsar:true,installerRegistrationChanged:false,ownerProfileAccessed:false,steps:[]};
const env={...process.env,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp')};delete env.ELECTRON_RUN_AS_NODE;delete env.FABER_WORKER_PREPARE_HANDOFF;await fs.mkdir(env.TEMP,{recursive:true});
async function execute(file,args,extra={}){
  return new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd:root,windowsHide:true,env:{...env,...extra},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Owned NSIS probe exceeded its bounded runtime'));},90000);child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});});
}
async function copyApplication(executable,name){
  const input=path.dirname(executable),target=path.join(root,name);await fs.mkdir(path.join(target,'resources'),{recursive:true});
  // A real Electron Node-mode executable needs its matching top-level runtime
  // files. Heavy models, addons and inference runtimes are never copied/opened.
  for(const entry of await fs.readdir(input,{withFileTypes:true}))if(entry.isFile())await fs.copyFile(path.join(input,entry.name),path.join(target,entry.name));
  await fs.copyFile(path.join(input,'resources','app.asar'),path.join(target,'resources','app.asar'));
  const result=await execute(path.join(target,'Faber.exe'),['-e',`console.log(JSON.stringify({version:require(${JSON.stringify(path.join(target,'resources','app.asar','package.json'))}).version,node:process.versions.node,electron:process.versions.electron}))`],{ELECTRON_RUN_AS_NODE:'1',LOCALAPPDATA:path.join(root,'version-only')});assert.equal(result.code,0,result.stderr);
  return {target,...JSON.parse(result.stdout)};
}
const legacy=()=>({version:1,projects:[],chats:[],runs:[],providers:[],settings:{},unknownLegacyField:{retained:true}});
const modern=()=>({...legacy(),workerProtocol:1,workerQueue:{paused:false},routines:[{id:'routine',enabled:true,bootGrant:{eligible:true}}],jobs:[{id:'job',status:'completed',outputs:[{externalId:'sent-once'}]}],runs:[{id:'run',toolEvents:[{id:'event',intent:{phase:'received',receipt:{externalId:'sent-once'}}}]}]});
async function profile(name,state){const local=path.join(root,'cases',name),data=path.join(local,'Faber');await fs.mkdir(data,{recursive:true});await fs.writeFile(path.join(data,'state.json'),JSON.stringify(state));return {local,data};}
const stateOf=async p=>JSON.parse(await fs.readFile(path.join(p.data,'state.json'),'utf8'));
async function transaction(p){const ledger=await openProfileActionLedger({dataDir:p.data,registryRoot:path.join(p.local,'FaberProfiles')});try{const file=path.join(ledger.directory,'updates','worker-update.json'),bytes=await fs.readFile(file);return {...JSON.parse(bytes),file,digest:hash(bytes)};}finally{await ledger.close();}}
async function compile(name,macro,{uninstall=false,baseline=false}={}){
  const generator=new NsisScriptGenerator();generator.flags(['updated']);
  let include=macro;
  if(baseline){
    // Only redirect helper embedding and suppress the published modal in silent
    // QA. The released macro/helper/source are never modified.
    let text=await fs.readFile(macro,'utf8');text=text.replace(/^!define FABER_WORKER_HELPER_DIR .*$/m,`!define FABER_WORKER_HELPER_DIR "${q(path.resolve(path.dirname(macro),'..','desktop'))}"`).replace(/^(\s*MessageBox [^\r\n]*)$/m,'$1 /SD IDOK');
    include=path.join(root,name+'-baseline.nsh');await fs.writeFile(include,text);
  }
  const output=path.join(root,name+'.exe'),script=path.join(root,name+'.nsi'),uninstaller=path.join(root,name+'-uninstall.exe');
  const resultBlock=`ReadEnvStr $R8 "FABER_NSIS_PROBE_RESULT"\nFileOpen $R2 "$R8" w\nReadEnvStr $R3 "ELECTRON_RUN_AS_NODE"\nFileWrite $R2 "${baseline?'$R0':'$faberCheckpointExit'}|${baseline?'published':'$faberCheckpointMessage'}|$R3"\nFileClose $R2`;
  const prefix=`Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nSilentUnInstall silent\nName "Faber isolated checkpoint QA"\nOutFile "${q(output)}"\n!include "LogicLib.nsh"\n!include "${q(path.join(source,'node_modules','app-builder-lib','templates','nsis','include','StdUtils.nsh'))}"\n!addplugindir /x86-unicode "${q(plugins)}"\n${generator.build()}\n!define VERSION "${baseline?baselineVersion:'3.0.1'}"\n!define APP_EXECUTABLE_FILENAME "Faber.exe"\n${uninstall?'!define BUILD_UNINSTALLER\n':''}!include "${q(include)}"\nVar isForceCurrentInstall\n`;
  const hook=`ReadEnvStr $INSTDIR "FABER_NSIS_PROBE_INSTALL"\n!insertmacro customCheckAppRunning\n${resultBlock}`;
  const text=uninstall?`${prefix}\nSection\nWriteUninstaller "${q(uninstaller)}"\nSectionEnd\nSection "Uninstall"\n${hook}\nSectionEnd\nFunction un.onUninstFailed\n${resultBlock}\nFunctionEnd\n`:`${prefix}\nSection\n${hook}\nReadEnvStr $R8 "FABER_NSIS_PROBE_CHILD"\n\${If} $R8 != ""\nReadEnvStr $R9 "FABER_NSIS_PROBE_CHILD_RESULT"\nSystem::Call 'kernel32::SetEnvironmentVariableW(w "FABER_NSIS_PROBE_RESULT", w "$R9")'\nExecWait '"$R8" /S --updated _?=$INSTDIR' $R0\n\${If} $R0 != 0\nSetErrorLevel 2\nAbort\n\${EndIf}\n\${EndIf}\nSectionEnd\nFunction .onInstFailed\n${resultBlock}\nFunctionEnd\n`;
  await fs.writeFile(script,text);
  // /PPO in the pinned NSIS does not resolve external plugin commands. Its
  // genuine /V4 compile lists the expanded instructions and embedded plugins.
  const built=await execute(makensis,['/V4',script]);await fs.writeFile(path.join(root,name+'-compile.log'),built.stdout+built.stderr);assert.equal(built.code,0,built.stdout+built.stderr);
  if(uninstall){const made=await execute(output,['/S']);assert.equal(made.code,0,made.stderr);return uninstaller;}
  return output;
}
async function run(binary,p,install,name,{args=[],extra={}}={}){
  // _?= keeps an uninstaller in this process (the builder uses the same form),
  // so the native exit is the real hook result rather than the copy launcher.
  const report=path.join(root,name+'.txt'),result=await execute(binary,['/S',...args,...(binary.endsWith('-uninstall.exe')?['_?='+install]:[])],{LOCALAPPDATA:p.local,FABER_NSIS_PROBE_INSTALL:install,FABER_NSIS_PROBE_RESULT:report,FABER_NSIS_PROBE_CHILD:'',...extra});
  const safe=(await fs.readFile(report,'utf8')).split('|');return {...result,helperExit:safe[0],message:safe[1],restoredNodeEnvironment:safe[2]};
}
try{
  const old=await copyApplication(oldExecutable,'old-application'),worker=await copyApplication(workerExecutable,'worker-application');assert.equal(old.version,'2.4.0','Use the actual unopened 2.4.0 release');
  evidence.runtimes=[{category:'legacy',version:old.version,node:old.node,electron:old.electron},{category:'worker',version:worker.version,node:worker.node,electron:worker.electron}];
  const published=await compile('published-prepare',baselineMacro,{baseline:true}),patched=await compile('patched-prepare',currentMacro),oldUninstall=await compile('published-uninstall',baselineMacro,{baseline:true,uninstall:true}),newUninstall=await compile('patched-uninstall',currentMacro,{uninstall:true});
  const p=await profile('unopened-legacy',legacy());
  const failed=await run(published,p,old.target,'legacy-published');assert.notEqual(failed.code,0);assert.equal(failed.helperExit,'1');const stranded=await transaction(p);assert.equal(stranded.phase,'quiescing');assert.equal(stranded.checkpoint,undefined);
  const repeated=await run(published,p,old.target,'legacy-published-retry');assert.notEqual(repeated.code,0);assert.equal((await transaction(p)).id,stranded.id);
  evidence.steps.push({case:'published-legacy-failure-and-retry',installerExits:[failed.code,repeated.code],helperExits:[failed.helperExit,repeated.helperExit],phase:stranded.phase});
  const fixed=await run(patched,p,old.target,'legacy-patched',{extra:{ELECTRON_RUN_AS_NODE:'fixture-previous-value'}});assert.equal(fixed.code,0,fixed.message);assert.equal(fixed.helperExit,'0');assert.equal(fixed.restoredNodeEnvironment,'fixture-previous-value');
  const prepared=await transaction(p);assert.equal(prepared.phase,'quiesced');assert.equal(prepared.fromVersion,'2.4.0');assert.equal(prepared.toVersion,'3.0.1');assert.match(prepared.checkpointDigest,/^[a-f0-9]{64}$/);
  const retry=await run(patched,p,old.target,'legacy-patched-retry');assert.equal(retry.code,0,retry.message);assert.equal((await transaction(p)).id,prepared.id);
  const beforeStartup=await stateOf(p);assert.deepEqual(beforeStartup.jobs,[]);assert.deepEqual(beforeStartup.routines,[]);assert.deepEqual(beforeStartup.unknownLegacyField,{retained:true});assert.equal(beforeStartup.workerQueue.paused,true);
  const start=await prepareWorkerStartup({dataDir:p.data,registryRoot:path.join(p.local,'FaberProfiles')});assert.equal(start.queuePaused,true);assert.equal((await transaction(p)).phase,'committed');assert.equal((await prepareWorkerStartup({dataDir:p.data,registryRoot:path.join(p.local,'FaberProfiles')})).safeMode,false);
  evidence.steps.push({case:'actual-2.4-patched-prepare-retry-and-startup',installerExits:[fixed.code,retry.code],fromVersion:prepared.fromVersion,toVersion:prepared.toVersion,checkpointPhase:prepared.phase,transactionId:prepared.id,checkpointDigest:prepared.checkpointDigest,sameTransactionOnRetry:true,committedOnce:true,nodeEnvironmentRestored:true});
  const m=await profile('modern-old-hook',modern());assert.equal((await run(patched,m,worker.target,'modern-prepare')).code,0);const checkpoint=await transaction(m);
  const removed=await run(oldUninstall,m,worker.target,'modern-old-uninstall',{args:['--updated']});assert.equal(removed.code,0);assert.equal((await transaction(m)).id,checkpoint.id);assert.equal((await transaction(m)).digest,checkpoint.digest);assert.equal((await stateOf(m)).routines[0].bootGrant,undefined);
  assert.equal((await run(patched,m,worker.target,'modern-post-hook')).code,0);assert.equal((await transaction(m)).id,checkpoint.id);await prepareWorkerStartup({dataDir:m.data,registryRoot:path.join(m.local,'FaberProfiles')});const after=await stateOf(m);assert.equal(after.routines[0].bootGrant,undefined);assert.equal(after.jobs[0].outputs[0].externalId,'sent-once');assert.equal(after.runs[0].toolEvents[0].intent.receipt.externalId,'sent-once');
  evidence.steps.push({case:'published-uninstaller-hook-then-patched-startup',oldVersion:worker.version,installerExit:removed.code,pendingJournalByteIdentical:true,receiptsRetained:true,bootAuthorityRemoved:true,queuePaused:after.workerQueue.paused});
  // For ordinary uninstalls, use a real ASAR containing the current frozen
  // helper, still executed by the real released Electron Node runtime.
  const currentAsar=path.join(root,'current-asar');await fs.mkdir(path.join(currentAsar,'desktop'),{recursive:true});await fs.writeFile(path.join(currentAsar,'package.json'),JSON.stringify({version:'3.0.1'}));for(const name of ['worker-update-cli.cjs','worker-update.cjs','worker-control.cjs','action-ledger.cjs','profile-owner.cjs','profile-path.cjs'])await fs.copyFile(path.join(source,'desktop',name),path.join(currentAsar,'desktop',name));await createPackage(currentAsar,path.join(old.target,'resources','app.asar'));
  const handoff=await profile('live-handoff',modern()),childResult=path.join(root,'guard-child.txt');const handed=await run(patched,handoff,old.target,'handoff-prepare',{extra:{FABER_NSIS_PROBE_CHILD:newUninstall,FABER_NSIS_PROBE_CHILD_RESULT:childResult}});assert.equal(handed.code,0,handed.message);assert.equal((await fs.readFile(childResult,'utf8')).split('|')[0],'0');assert.deepEqual((await stateOf(handoff)).routines[0].bootGrant,{eligible:true});assert.equal((await transaction(handoff)).phase,'quiesced');
  const marker=path.join(root,'matching-live-handoff.txt');await fs.writeFile(marker,old.target);const owner=await acquireProfileOwner(handoff.data);let reopened;try{reopened=await run(newUninstall,handoff,old.target,'reopened-handoff',{args:['--updated'],extra:{FABER_WORKER_PREPARE_HANDOFF:marker}});}finally{await owner.close();}assert.notEqual(reopened.code,0);assert.equal(reopened.helperExit,'22');assert.deepEqual((await stateOf(handoff)).routines[0].bootGrant,{eligible:true});assert.equal((await transaction(handoff)).phase,'quiesced');
  evidence.steps.push({case:'scoped-live-handoff-and-reopened-owner',handoffExit:handed.code,readOnlyHandoffPreservedGrants:true,reopenedInstallerExit:reopened.code,reopenedHelperExit:reopened.helperExit,activeOwnerNotBypassed:true,journalPreserved:true});
  for(const variant of ['ordinary','updated-no-marker','updated-wrong-root']){
    const f=await profile(variant,modern()),marker=path.join(root,variant+'-marker.txt');await fs.writeFile(marker,variant==='updated-wrong-root'?worker.target:old.target);
    const r=await run(newUninstall,f,old.target,variant,{args:variant==='ordinary'?[]:['--updated'],extra:variant==='updated-no-marker'?{}:{FABER_WORKER_PREPARE_HANDOFF:marker}});assert.equal(r.code,0,r.message);assert.equal(r.helperExit,'0','Unverified --updated and ordinary uninstall must still invoke helper');assert.equal((await stateOf(f)).routines[0].bootGrant,undefined);evidence.steps.push({case:variant,installerExit:r.code,shutdownHelperRan:true,bootAuthorityRemoved:true});
  }
  const invalid=await profile('invalid-journal',{...legacy(),jobs:null}),invalidBytes=await fs.readFile(path.join(invalid.data,'state.json'));const rejected=await run(patched,invalid,old.target,'invalid-journal');assert.notEqual(rejected.code,0);assert.equal(rejected.helperExit,'20');assert.match(rejected.message,/invalid worker journal/);assert.equal(hash(await fs.readFile(path.join(invalid.data,'state.json'))),hash(invalidBytes));assert.equal(rejected.message.includes(root),false);
  const mismatch=await profile('changed-checkpoint',modern());assert.equal((await run(patched,mismatch,old.target,'mismatch-prepare')).code,0);const journal=await transaction(mismatch),changed=await stateOf(mismatch);changed.jobs[0].outputs.push({externalId:'newer-receipt'});await fs.writeFile(path.join(mismatch.data,'state.json'),JSON.stringify(changed));const mismatchBytes=await fs.readFile(path.join(mismatch.data,'state.json')),blocked=await run(patched,mismatch,old.target,'mismatch-retry');assert.notEqual(blocked.code,0);assert.equal(blocked.helperExit,'21');assert.match(blocked.message,/recovery review/);assert.equal(hash(await fs.readFile(path.join(mismatch.data,'state.json'))),hash(mismatchBytes));assert.equal((await transaction(mismatch)).digest,journal.digest);
  evidence.steps.push({case:'path-free-failure-classes',invalidJournalExit:rejected.helperExit,changedEvidenceExit:blocked.helperExit,installerExits:[rejected.code,blocked.code],stateAndCheckpointPreserved:true,rawPathsDisplayed:false});
  evidence.ok=true;await fs.writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({evidence:path.join(root,'evidence.json'),...evidence}));
}catch(error){evidence.error=error.message;await fs.writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.error(JSON.stringify({evidence:path.join(root,'evidence.json'),message:error.message}));process.exitCode=1;}
