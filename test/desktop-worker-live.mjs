// Opt-in real Windows lifecycle/crash test. All profiles and effects are disposable.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

if(process.platform!=='win32')throw new Error('Windows worker acceptance requires Windows');
const sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),electron=createRequire(import.meta.url)('electron');
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'Faber-worker-acceptance-')));
async function launch(profile,args=[],expected=0){
  await fs.mkdir(profile,{recursive:true});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[sourceDir,'--smoke-worker','--smoke-profile',profile,...args],{cwd:sourceDir,windowsHide:true,stdio:['ignore','pipe','pipe'],env});
  let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log=(log+bytes.toString('utf8')).slice(-1000000);});
  let timer;const code=await new Promise((resolve,reject)=>{timer=setTimeout(()=>{child.kill();reject(new Error('Worker acceptance timed out: '+log.slice(-8000)));},60000);child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
  await fs.writeFile(path.join(profile,`launch-${args.find(arg=>arg.startsWith('--worker-'))||'normal'}.log`),log);
  assert.equal(code,expected,log.slice(-10000));return log;
}
const profile=path.join(root,'lifecycle');await launch(profile);const lifecycle=JSON.parse(await fs.readFile(path.join(profile,'worker-smoke-report.json'),'utf8'));assert.equal(lifecycle.ok,true);
await launch(profile,['--background-worker','--worker-profile','default','--worker-hidden-probe']);const hidden=JSON.parse(await fs.readFile(path.join(profile,'worker-hidden-report.json'),'utf8'));assert.equal(hidden.normalLaunchVisible,true);
const recovery=[];
for(const [scenario,exit] of [['before',86],['after',87],['external',88]]){
  const directory=path.join(root,'crash-'+scenario);await launch(directory,['--worker-crash-'+scenario],exit);
  const crashed=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));assert.equal(crashed.jobs.length,1);assert.equal(crashed.runs[0].toolEvents[0].intent.phase,'dispatching');
  await launch(directory,['--worker-recovery-probe','--worker-expect',scenario]);const report=JSON.parse(await fs.readFile(path.join(directory,'worker-recovery-report.json'),'utf8'));recovery.push(report);
}
const report={ok:true,platform:'Windows x64',syntheticProvider:true,providerNetworkCalls:0,lifecycle,hidden,recovery,limits:['Uses actual Electron main/renderer processes, Windows named-pipe ownership and real isolated filesystem effects.','Sign-in API arguments are covered separately with a fake registration adapter; no real login entry was enabled.','The external-effect fixture is a local append, not a mail send or paid API action.']};
await fs.writeFile(path.join(root,'worker-acceptance-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.join(root,'worker-acceptance-report.json'),...report}));
