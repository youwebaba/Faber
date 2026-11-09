import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { safetensorsDigest, safetensorsSourceHash, verifySafetensorsRuntime } from '../local-models/safetensors-integrity.mjs';
import { verifySafetensorsPrivacy } from './safetensors-privacy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const option=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
const build=option('--build'),redist=option('--redist'),record=process.argv.includes('--record');
if(!build||!redist)throw new Error('Usage: node scripts/prepare-safetensors.mjs --build <reviewed private worker build directory> --redist <MSVC x64 CRT folder> [--record]');
function imports(bytes){
  assert.equal(bytes.toString('ascii',0,2),'MZ');const pe=bytes.readUInt32LE(60);assert.equal(bytes.toString('ascii',pe,pe+4),'PE\0\0');
  const count=bytes.readUInt16LE(pe+6),optional=pe+24,section=optional+bytes.readUInt16LE(pe+20),magic=bytes.readUInt16LE(optional);assert.ok(count>0&&count<100);assert.ok([0x20b,0x10b].includes(magic));
  const offset=rva=>{for(let i=0;i<count;i++){const entry=section+i*40,start=bytes.readUInt32LE(entry+12),size=Math.max(bytes.readUInt32LE(entry+8),bytes.readUInt32LE(entry+16));if(rva>=start&&rva<start+size)return bytes.readUInt32LE(entry+20)+rva-start;}throw new Error('Invalid native PE import address');};
  const table=offset(bytes.readUInt32LE(optional+(magic===0x20b?120:104))),names=[];
  for(let i=0;i<256;i++){const descriptor=table+i*20;if(bytes.subarray(descriptor,descriptor+20).every(value=>value===0))return [...new Set(names)];const name=offset(bytes.readUInt32LE(descriptor+12)),end=bytes.indexOf(0,name);assert.ok(end>name&&end-name<260);const dll=bytes.toString('ascii',name,end).toLowerCase();assert.match(dll,/^[a-z0-9_.-]+\.dll$/);names.push(dll);}
  throw new Error('Excessive native import table');
}
const executable=path.join(build,'faber-safetensors.exe'),dlls=imports(await fs.readFile(executable));assert.ok(dlls.includes('kernel32.dll'),'Inspect a real Windows native worker');
const target=path.join(root,'.runtime','safetensors-runtime'),lockFile=path.join(root,'build','safetensors-runtime-lock.json'),copies=[[executable,'faber-safetensors.exe']];
for(const dll of dlls.filter(name=>/^(?:vcruntime|msvcp|concrt)\d/i.test(name)))copies.push([path.join(redist,dll),dll]);
for(const name of ['MISTRALRS-LICENSE.txt','MICROSOFT-VS18-REDIST.txt','SAFETENSORS-THIRD-PARTY-NOTICES.txt','safetensors-dependencies.json'])copies.push([path.join(root,'build','licenses',name),`licenses/${name}`]);
await fs.mkdir(target,{recursive:true});
for(const name of await fs.readdir(target))if(name!=='licenses'&&name!=='runtime-manifest.json'&&!copies.some(([,to])=>to===name))throw new Error(`Unneeded native runtime artifact present: ${name}; inspect and remove it before packaging`);
const files=[];
for(const [from,name]of copies){const stat=await fs.lstat(from);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Native build assets must be ordinary files');const to=path.join(target,name);await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to);files.push({path:name,size:stat.size,sha256:await safetensorsDigest(to)});}
const manifest={schemaVersion:1,protocol:1,executable:'faber-safetensors.exe',engine:'mistralrs',engineVersion:'0.9.5',engineCommit:'465191d0b0a7e2432d327b0de06204ab3f94d3a2',sourceHash:await safetensorsSourceHash(root),platform:'windows-x64',backends:['cpu'],transport:'inherited-stdio-only',files:files.sort((a,b)=>a.path.localeCompare(b.path))};
await verifySafetensorsPrivacy(target,manifest);
if(record)await fs.writeFile(lockFile,JSON.stringify(manifest,null,2)+'\n');else if(JSON.stringify(JSON.parse(await fs.readFile(lockFile,'utf8')))!==JSON.stringify(manifest))throw new Error('Native worker differs from the reviewed lock; review and explicitly record before packaging');
await fs.writeFile(path.join(target,'runtime-manifest.json'),JSON.stringify(manifest,null,2)+'\n');await verifySafetensorsRuntime(target,manifest);
console.log(JSON.stringify({files:files.length,bytes:files.reduce((sum,file)=>sum+file.size,0),transport:manifest.transport,sourceHash:manifest.sourceHash}));
