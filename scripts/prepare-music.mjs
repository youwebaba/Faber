import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {musicDigest,verifyMusicRuntime} from '../local-music/integrity.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const option=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
const source=option('--source'),build=option('--build'),redist=option('--redist'),record=process.argv.includes('--record');
if(!source||!build||!redist)throw new Error('Usage: node scripts/prepare-music.mjs --source <pinned minimaxmusic.cpp checkout> --build <Windows build output> --redist <MSVC x64 redist folder> [--record]');
const upstream='35ba334b4d23b5a8e631e3c2d97f074a185e41d4',ggml='210138933b22221ced02943b7b6e4308610ab530';
const run=promisify(execFile);
for(const [directory,expected] of [[source,upstream],[path.join(source,'ggml'),ggml]]){
  const {stdout}=await run('git',['-C',directory,'rev-parse','HEAD'],{windowsHide:true});
  if(stdout.trim()!==expected)throw new Error('Unreviewed Music3 source revision');
  const clean=await run('git',['-C',directory,'status','--porcelain','--untracked-files=no'],{windowsHide:true});
  if(clean.stdout.trim())throw new Error('Music3 source checkout has tracked modifications');
}
const target=path.join(root,'.runtime','music-runtime'),lockFile=path.join(root,'build','music-runtime-lock.json'),files=[];
await fs.mkdir(target,{recursive:true});
const copies=(await fs.readdir(build)).filter(name=>name==='mm-synth.exe'||/^ggml.*\.dll$/i.test(name)).map(name=>[path.join(build,name),name]);
if(!copies.some(([,name])=>name==='mm-synth.exe'))throw new Error('Build mm-synth.exe before provisioning');
for(const [folder,names] of [['Microsoft.VC145.CRT',['msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll']],['Microsoft.VC145.OpenMP',['vcomp140.dll']]])for(const name of names)copies.push([path.join(redist,folder,name),name]);
for(const [from,name] of [['LICENSE','MINIMAXMUSIC-LICENSE.txt'],['ggml/LICENSE','GGML-LICENSE.txt']])copies.push([path.join(source,from),`licenses/${name}`]);
for(const [from,name] of [['vendor/yyjson/yyjson.h','YYJSON-LICENSE.txt'],['vendor/minimp3/minimp3.h','MINIMP3-LICENSE.txt']]){
  const text=await fs.readFile(path.join(source,from),'utf8'),notice=text.match(/\/\*[\s\S]*?\*\//)?.[0];
  if(!notice)throw new Error('Upstream component license notice is missing');
  await fs.writeFile(path.join(root,'build','licenses',name),notice+'\n');
  copies.push([path.join(root,'build','licenses',name),`licenses/${name}`]);
}
copies.push([path.join(root,'build','licenses','THIRD-PARTY-NOTICES.txt'),'licenses/THIRD-PARTY-NOTICES.txt']);
copies.push([path.join(root,'build','licenses','MICROSOFT-VS18-REDIST.txt'),'licenses/MICROSOFT-VS18-REDIST.txt']);
for(const [from,name] of copies){const stat=await fs.lstat(from);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid music runtime source file');const to=path.join(target,name);await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to);files.push({path:name,size:stat.size,sha256:await musicDigest(to)});}
const manifest={schemaVersion:1,executable:'mm-synth.exe',source:'https://github.com/ServeurpersoCom/minimaxmusic.cpp',commit:upstream,ggmlCommit:ggml,platform:'windows-x64',backends:['cpu'],build:'MSVC 19.51; Release; GGML_BACKEND_DL=ON; GGML_NATIVE=OFF; GGML_CPU_ALL_VARIANTS=ON',license:'MIT; yyjson MIT; minimp3 CC0; Microsoft Visual C++ redistributable terms',files:files.sort((a,b)=>a.path.localeCompare(b.path))};
if(record)await fs.writeFile(lockFile,JSON.stringify(manifest,null,2)+'\n');
else if(JSON.stringify(JSON.parse(await fs.readFile(lockFile,'utf8')))!==JSON.stringify(manifest))throw new Error('Music runtime differs from reviewed lock; review source/build before recording a new lock');
await fs.writeFile(path.join(target,'runtime-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await verifyMusicRuntime(target,manifest);
let help;try{await run(path.join(target,'mm-synth.exe'),[],{windowsHide:true,timeout:15000});}catch(error){help=String(error.stderr);if(error.code!==1||!help.includes('--request')||!help.includes(upstream.slice(0,7)))throw error;}
console.log(JSON.stringify({files:files.length,bytes:files.reduce((sum,file)=>sum+file.size,0),backends:manifest.backends,commit:upstream}));
