// Explicit opt-in: real local inference with downloaded weights; no API provider requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRuntime} from '../core/runtime.mjs';
import {createLocalMusic} from '../local-music/index.mjs';
import {scanLocalModels} from '../local-models/library.mjs';

const [directory,outputDirectory]=process.argv.slice(2);
if(!path.isAbsolute(directory||'')||!path.isAbsolute(outputDirectory||''))throw new Error('Usage: node test/music-live-smoke.mjs <absolute model directory> <absolute private evidence directory>');
const sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await fs.mkdir(outputDirectory,{recursive:true});
const dataDir=await fs.realpath(await fs.mkdtemp(path.join(outputDirectory,'profile-'))),projectPath=path.join(dataDir,'project');await fs.mkdir(projectPath);
let providerCalls=0;
const runtime=await createRuntime({sourceDir,dataDir,provider:async()=>{providerCalls++;throw new Error('Live music verification must not call a chat/API model');}});
const music=createLocalMusic({sourceDir,dataDir,getHubState:async()=>({downloadDirectory:directory,downloads:[]}),withModelFiles:async(_directory,_files,operation)=>operation()});
try{
  runtime.registerTools(music.tools());
  const project=await runtime.request('project.create',{name:'Local music verification',path:projectPath});
  const chat=await runtime.request('chat.create',{projectId:project.id,title:'Generated local music'});await runtime.request('chat.update',{id:chat.id,grants:['files']});
  const model=(await scanLocalModels({directory})).models.find(value=>value.format==='minimax-music3'&&value.available);assert.ok(model,'Complete Music3 package');
  const started=Date.now();console.log(JSON.stringify({phase:'generating',model:model.label,components:model.components}));
  const result=await runtime.request('tool.run',{chatId:chat.id,name:'music_generate',args:{modelId:model.id,caption:'A warm, gentle solo piano instrumental in C major, 80 BPM, simple expressive melody and soft sustained notes.',lyrics:'[instrumental]\n[verse]\n[gentle piano melody]\n[outro]',duration:4,steps:2,seed:42}});
  const chunks=[];for(let offset=0;offset<result.media.bytes;offset+=262144){const row=await runtime.remoteRequest('chat.media',{chatId:chat.id,mediaId:result.media.id,offset,length:Math.min(262144,result.media.bytes-offset)});chunks.push(Buffer.from(row.data,'base64'));}
  const bytes=Buffer.concat(chunks);assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');
  let format,samples;for(let offset=12;offset+8<=bytes.length;){const id=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4);if(id==='fmt ')format={encoding:bytes.readUInt16LE(offset+8),channels:bytes.readUInt16LE(offset+10),sampleRate:bytes.readUInt32LE(offset+12),bits:bytes.readUInt16LE(offset+22)};if(id==='data')samples=bytes.subarray(offset+8,offset+8+length);offset+=8+length+(length%2);}
  assert.deepEqual(format,{encoding:1,channels:2,sampleRate:44100,bits:16});assert.ok(samples?.length>44100*4);
  let sum=0,peak=0;for(let offset=0;offset<samples.length;offset+=2){const value=samples.readInt16LE(offset)/32768;sum+=value*value;peak=Math.max(peak,Math.abs(value));}
  const rms=Math.sqrt(sum/(samples.length/2));assert.ok(rms>.00001,'Generated audio must contain a non-silent signal');assert.equal(providerCalls,0);
  await fs.writeFile(path.join(outputDirectory,'generated-music.wav'),bytes);
  const report={ok:true,realLocalGeneration:true,providerCalls,elapsedMs:Date.now()-started,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),format,durationSeconds:samples.length/(format.sampleRate*format.channels*2),rms,peak,modelId:model.id,components:model.components,chatId:chat.id,limits:['Four-second, two-step CPU smoke establishes generation and durable media delivery, not musical quality or normal-duration performance.','Browser playback is verified separately.']};
  await fs.writeFile(path.join(outputDirectory,'music-live-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await music.close();await runtime.close();}
