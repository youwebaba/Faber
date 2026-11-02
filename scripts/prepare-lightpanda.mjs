import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root=process.cwd(),directory=path.join(root,'.runtime','lightpanda'),lockFile=path.join(root,'build','lightpanda-lock.json');
const sourceCommit='c5f7bb29b127040c899d4e181b5709f76fc71a6f';
const definitions=[
 {name:'lightpanda',url:'https://github.com/lightpanda-io/browser/releases/download/1.0.2/lightpanda-x86_64-linux',sha256:'ae7d01d261efb9e480e18ce3424533332883863bcf70b12a4321b5733f37e19e'},
 {name:'ubuntu-base.tar.gz',url:'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-amd64.tar.gz',sha256:'e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86'},
 {name:'lightpanda-source.tar.gz',url:`https://codeload.github.com/lightpanda-io/browser/tar.gz/${sourceCommit}`},
 {name:'cacert.pem',url:'https://curl.se/ca/cacert-2026-10-20.pem',sha256:'796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe'},
 {name:'LICENSE-AGPL-3.0.txt',url:`https://raw.githubusercontent.com/lightpanda-io/browser/${sourceCommit}/LICENSE`},
 {name:'LICENSE-MPL-2.0.html',url:'https://www.mozilla.org/en-US/MPL/2.0/'},
 {name:'ubuntu-SHA256SUMS',url:'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/SHA256SUMS'},
];
const hash=async file=>{const h=crypto.createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');};
await fs.mkdir(directory,{recursive:true});const record=process.argv.includes('--record');let prior;
if(!record)prior=JSON.parse(await fs.readFile(lockFile,'utf8'));
const files=[];
for(const definition of definitions){const target=path.join(directory,definition.name);try{await fs.access(target);}catch{const response=await fetch(definition.url);if(!response.ok)throw Error(`Download ${definition.name}: ${response.status}`);await pipeline(response.body,createWriteStream(target,{flags:'wx'}));}const sha256=await hash(target),expected=definition.sha256||prior?.files.find(f=>f.name===definition.name)?.sha256;if(expected&&sha256!==expected)throw Error(`Integrity mismatch: ${definition.name}`);files.push({...definition,sha256,bytes:(await fs.stat(target)).size});}
const lock={schemaVersion:1,version:'1.0.2',sourceCommit,platform:'Linux x86_64 through dedicated WSL2',rootfs:'Ubuntu Base24.04.5 amd64',files};
if(record)await fs.writeFile(lockFile,JSON.stringify(lock,null,2));else if(JSON.stringify(prior)!==JSON.stringify(lock))throw Error('Runtime differs from pinned lock');
await fs.writeFile(path.join(directory,'runtime-lock.json'),JSON.stringify(lock,null,2));console.log(JSON.stringify({directory,files:files.map(f=>({name:f.name,bytes:f.bytes,sha256:f.sha256}))}));
