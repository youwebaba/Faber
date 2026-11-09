import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const sources=process.argv.slice(2);if(sources.length!==2||sources.some(source=>!path.isAbsolute(source)))throw Error('Supply absolute a2.4 and current source roots');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-resource-comparison-')),here=path.dirname(fileURLToPath(import.meta.url)),electron=createRequire(import.meta.url)('electron'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
async function launch(exe,args){return new Promise((resolve,reject)=>{const child=spawn(exe,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log=(log+bytes).slice(-100000);});const timer=setTimeout(()=>{child.kill();reject(Error('Owned resource fixture timed out'));},120000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(code)reject(Error(log));else resolve(log);});});}
for(const [index,label]of ['a2.4','a3.0'].entries())for(const kind of ['renderer','upgrades']){const output=path.join(root,label+'-'+kind+'.json');await launch(kind==='renderer'?electron:process.execPath,[path.join(here,`qa-resource-${kind}-live.${kind==='renderer'?'cjs':'mjs'}`),sources[index],output,label]);console.log(label+' '+kind+' measured');}
const reports={};for(const label of ['a2.4','a3.0']){reports[label]={};for(const kind of ['renderer','upgrades'])reports[label][kind]=JSON.parse(await fs.readFile(path.join(root,label+'-'+kind+'.json')));}
await fs.writeFile(path.join(root,'comparison.json'),JSON.stringify({schemaVersion:1,measuredAt:new Date().toISOString(),reports},null,2));console.log(JSON.stringify({report:path.join(root,'comparison.json'),reports}));
