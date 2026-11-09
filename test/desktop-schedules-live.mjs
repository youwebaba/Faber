// Supply existing authorized CPU model/runner through FABER_REPORT_MODEL_ROOT/FABER_REPORT_RUNNER.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

if(process.platform!=='win32')throw new Error('Real schedule lifecycle acceptance requires Windows');
if(!process.env.FABER_REPORT_MODEL_ROOT||!process.env.FABER_REPORT_RUNNER)throw new Error('Select the authorized existing model and runner through environment inputs');
const sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),electron=createRequire(import.meta.url)('electron'),root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'Faber-schedule-acceptance-')));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function killTree(child){if(child.exitCode!==null)return;await new Promise(resolve=>{const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('close',resolve);killer.once('error',resolve);});}
async function launch(profile,args=[],crash=false){
  await fs.mkdir(profile,{recursive:true});const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[sourceDir,'--smoke-schedules','--smoke-profile',profile,...args],{cwd:sourceDir,windowsHide:true,stdio:['ignore','pipe','pipe'],env});let log='',code,ended=false;const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',value=>{code=value;ended=true;resolve();});});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log=(log+bytes.toString()).slice(-1000000));
  const start=Date.now();try{while(!ended){if(Date.now()-start>180000)throw new Error('Schedule smoke timed out: '+log.slice(-10000));if(crash){try{await fs.stat(path.join(profile,'schedule-crash-ready.json'));await killTree(child);await done;break;}catch(error){if(error.code!=='ENOENT')throw error;}}await pause(100);}await done;if(!crash)assert.equal(code,0,log.slice(-12000));else assert.notEqual(code,0,'Process-tree termination must be a real unclean exit');}finally{await killTree(child);await fs.writeFile(path.join(profile,crash?'crash-launch.log':args.length?'recovery-launch.log':'normal-launch.log'),log);}return profile;
}
const normal=path.join(root,'normal');await launch(normal);const report=JSON.parse(await fs.readFile(path.join(normal,'schedule-smoke-report.json'),'utf8'));assert.equal(report.ok,true);
const recovery=path.join(root,'interrupted');await launch(recovery,['--schedule-crash-probe'],true);await launch(recovery,['--schedule-recovery']);const recovered=JSON.parse(await fs.readFile(path.join(recovery,'schedule-recovery-report.json'),'utf8'));assert.equal(recovered.ok,true);
const evidence={ok:true,realWindows:true,realQwen:true,cpuOnly:true,normal:report,recovery:recovered,limits:['One Windows PC; no paid API or physical second machine.','Windows sign-in registration stays disabled.','The unreadable input is an invalid UTF-8 fixture; its exception is explicit.','This short acceptance run does not represent seven elapsed days.']};await fs.writeFile(path.join(root,'schedule-acceptance-report.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({evidence:path.join(root,'schedule-acceptance-report.json'),...evidence}));
