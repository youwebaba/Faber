// Opt-in real daily trial. Source is copied and hashed so later development cannot change the running trial.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

if(process.platform!=='win32'||!process.env.FABER_REPORT_MODEL_ROOT||!process.env.FABER_REPORT_RUNNER)throw new Error('This opt-in Windows trial needs the authorized existing model and runner inputs');
const original=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'Faber-daily-trial-'))),source=path.join(root,'source'),profile=path.join(root,'profile');await fs.mkdir(source);await fs.mkdir(profile);
for(const name of ['core','desktop','renderer','tools','extensions','model-hub','local-models','local-music','native','native-safetensors','build','bundled-addons','scripts','samples','test','package.json','package-lock.json']){
  const from=path.join(original,name);try{await fs.cp(from,path.join(source,name),{recursive:true,filter:target=>!target.split(path.sep).includes('target')&&!/\.(?:log|key|pem|gguf|safetensors|onnx|partial)$/i.test(target)});}catch(error){if(error.code!=='ENOENT')throw error;}
}
await fs.symlink(await fs.realpath(path.join(original,'node_modules')),path.join(source,'node_modules'),'junction');
const files=[];async function inspect(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(entry.name==='node_modules')continue;const target=path.join(directory,entry.name);if(entry.isSymbolicLink())throw new Error('Unexpected source snapshot link');if(entry.isDirectory())await inspect(target);else files.push({path:path.relative(source,target).split(path.sep).join('/'),sha256:createHash('sha256').update(await fs.readFile(target)).digest('hex')});}}await inspect(source);files.sort((a,b)=>a.path.localeCompare(b.path));const sourceDigest=createHash('sha256').update(JSON.stringify(files)).digest('hex');await fs.writeFile(path.join(root,'snapshot-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),sourceDigest,files},null,2));
const electron=createRequire(import.meta.url)('electron'),log=await fs.open(path.join(root,'trial-host.log'),'a'),env={...process.env,FABER_TRIAL_SOURCE_DIGEST:sourceDigest};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[source,'--smoke-schedules','--smoke-profile',profile,'--schedule-trial'],{cwd:source,windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd],env});let failed;child.on('error',error=>failed=error);child.on('exit',code=>failed=new Error(`Owned trial exited before readiness (${code}); inspect the isolated host log`));child.unref();await log.close();
let ready=false;for(let i=0;i<1800;i++){if(failed)throw failed;try{const trial=JSON.parse(await fs.readFile(path.join(profile,'schedule-trial.json'),'utf8'));if(trial.sourceDigest!==sourceDigest)throw new Error('Trial source digest differs');console.log(JSON.stringify({root,profile,pid:child.pid,sourceDigest,startedAt:trial.startedAt,eligibleAfter:trial.eligibleAfter,firstOccurrence:trial.firstOccurrence,completedSevenDays:false,observedReports:trial.observedReports}));ready=true;break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,100));}
if(!ready){await new Promise(resolve=>{const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('close',resolve);killer.once('error',resolve);});throw new Error('Trial did not become eligible; owned process tree stopped. Inspect its isolated log.');}
