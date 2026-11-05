import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const genericUser=/^(?:<[^>]+>|\[[^\]]+\]|\{[^}]+\}|\$[^/]+|%[^%]+%|user(?:name)?|your[-_ ]?user(?:name)?|example(?:[-_]user)?|test(?:er|[-_]user)?|demo|public|default)$/i;
const placeholder=/^(?:fake|test|example|dummy|mock|fixture|placeholder|redacted|your[-_]|<|\$|%|\[)/i;
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const normalize=value=>value.replace(/\\(?:u002[fF]|u005[cC]|x2[fF]|x5[cC])/g,'/').replace(/\\+/g,'/');

export function localIdentity(env=process.env){
  let configured=[];
  if(env.FABER_PRIVACY_TERMS){
    try{configured=JSON.parse(env.FABER_PRIVACY_TERMS);}catch{throw new Error('Invalid privacy identity configuration');}
    if(!Array.isArray(configured)||configured.some(term=>typeof term!=='string'||term.trim().length<3)) throw new Error('Invalid privacy identity configuration');
    configured=configured.map(term=>term.trim());
  }
  const username=os.userInfo().username;
  return {terms:[...new Set([...configured,username].filter(term=>term.length>=3))],configured:configured.length>0||(env.FABER_PRIVACY_USE_OS_IDENTITY==='1'&&username.length>=3)};
}

// Only legal attribution is exempt from identity terms; paths and secrets are always checked.
const legalAttribution=file=>/(?:^|\/)(?:licenses?|copying|notice)(?:[./-]|$)|(?:^|\/)third[-_]party[-_]notices/i.test(file);

export function scanText(text,{file='',terms=[]}={}){
  const findings=[];
  const add=(category,index)=>findings.push({line:text.slice(0,index).split('\n').length,category});
  if(!legalAttribution(file)) for(const term of terms){
    const pattern=new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(term)}(?![\\p{L}\\p{N}_])`,'giu');
    for(const match of text.matchAll(pattern)) add('personal-name',match.index);
  }
  // Normalization covers literal, JSON-escaped and URI-encoded home paths.
  let offset=0;
  for(const line of text.split('\n')){
    let decoded=line;
    try{decoded=decodeURIComponent(line);}catch{}
    const normalized=normalize(decoded);
    for(const match of normalized.matchAll(/(?:[a-z]:\/+Users\/+|\/(?:Users|home)\/+)([^/\s"'`;,]+)/gi)){
      // This fixed service home is created in the app-owned WSL distro, not a developer home.
      const serviceHome=file.replaceAll('\\','/')==='bundled-addons/lightpanda/runtime.mjs'&&match[0].startsWith('/home/')&&match[1]==='lightpanda'&&/[\s"'`]/.test(normalized[match.index+match[0].length]??'');
      if(!serviceHome&&!genericUser.test(match[1])) add('user-path',offset);
    }
    for(const match of normalized.matchAll(/[a-z]:\/+[^\s"'`\r\n]*OneDrive[^\s"'`\r\n]*/gi)){
      if(!/^[a-z]:\/+Users\//i.test(match[0])&&!/[<$%\[]/.test(match[0])) add('user-path',offset);
    }
    if(/(?:^|[\s"'`=])\/root\//.test(normalized)) add('user-path',offset);
    offset+=line.length+1;
  }
  for(const match of text.matchAll(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g)) add('private-key',match.index);
  for(const match of text.matchAll(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g)){
    const value=match[0].replace(/^(?:sk-(?:proj-|ant-)?|hf_|gh[pousr]_|github_pat_|xox[baprs]-)/,'');
    if(!placeholder.test(value)) add('credential',match.index);
  }
  for(const match of text.matchAll(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)["']?\s*[:=]\s*(["'])([^\r\n]*?)\1/gi)){
    const value=match[2].replace(/^Bearer\s+/i,'');
    if(value.length>=12&&!placeholder.test(value)&&!/[${}<>]|\\[wsdb]|^https?:\/\//i.test(value)) add('credential',match.index);
  }
  return [...new Map(findings.map(item=>[`${item.line}:${item.category}`,item])).values()];
}

function textContent(buffer){
  if(buffer[0]===0xff&&buffer[1]===0xfe) return buffer.subarray(2).toString('utf16le');
  if(buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

const ownedBinary=file=>file.replaceAll('\\','/').startsWith('native/bin/');
const binaryExtension=/\.(?:exe|dll|node|so|dylib|bin|pdb|png|jpe?g|ico|gif|webp|zip|gz|xz|zst|7z|pdf|woff2?|ttf|otf)$/i;

export function scanNativeBinary(buffer,{terms=[]}={}){
  const findings=[];
  // ASCII and both UTF-16 alignments cover embedded PE metadata.
  for(const text of [buffer.toString('latin1'),buffer.toString('utf16le'),buffer.subarray(1).toString('utf16le')]){
    for(const finding of scanText(text,{terms})) findings.push({line:1,category:`binary-${finding.category}`});
  }
  return [...new Map(findings.map(item=>[item.category,item])).values()];
}

function prefix(filename,size=8192,position=0){
  const fd=fs.openSync(filename,'r');
  try{
    const buffer=Buffer.alloc(size);
    return buffer.subarray(0,fs.readSync(fd,buffer,0,size,position));
  }finally{fs.closeSync(fd);}
}

function sourceFiles(root){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const files=new Set();
  // Git catches tracked files outside the shipped manifest, including accidental additions.
  if(fs.existsSync(path.join(root,'.git'))){
    const gitRoot=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    const canonical=value=>{const resolved=fs.realpathSync(value);return process.platform==='win32'?resolved.toLowerCase():resolved;};
    if(canonical(gitRoot)!==canonical(root)) throw new Error('Invalid checkout root');
    const tracked=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    for(const file of tracked.split('\0').filter(Boolean)) files.add(file);
  }
  const patterns=manifest.build.files.filter(item=>typeof item==='string');
  const exclude=['**/node_modules/**',...patterns.filter(item=>item.startsWith('!')).map(item=>item.slice(1))];
  for(const pattern of patterns.filter(item=>!item.startsWith('!'))){
    for(const file of fs.globSync(pattern,{cwd:root,exclude})) files.add(file);
  }
  for(const mapping of [...manifest.build.files.filter(item=>typeof item==='object'),...(manifest.build.extraResources??[])]){
    const base=path.join(root,mapping.from);
    if(!fs.existsSync(base)) continue;
    for(const file of fs.globSync(mapping.filter??['**/*'],{cwd:base,exclude:['**/node_modules/**']})) files.add(path.relative(root,path.join(base,file)));
  }
  return [...new Set([...files].map(file=>file.replaceAll('\\','/')))].sort();
}

function safeLocation(file,terms){
  return scanText(file,{terms}).length?'[redacted-path]':file.replaceAll('\\','/');
}

export function checkPrivacy({root=path.resolve(here,'..'),archive,strict=false,identity=localIdentity(),report=console.error}={}){
  if(strict&&!identity.configured) throw new Error('Release privacy check requires local identity configuration');
  let checked=0;
  let binaries=0;
  let expectedNative;
  const violations=[];
  const inspect=(file,header,read=()=>header)=>{
    for(const finding of scanText(file,{file,terms:identity.terms})) violations.push({file:safeLocation(file,identity.terms),...finding});
    if(ownedBinary(file)){
      if(file.replaceAll('\\','/')!==expectedNative) violations.push({file:safeLocation(file,identity.terms),line:1,category:'unexpected-native-binary'});
      binaries++;
      for(const finding of scanNativeBinary(read(),{terms:identity.terms})) violations.push({file:safeLocation(file,identity.terms),...finding});
      return;
    }
    // Read only a bounded prefix of unrelated binaries, rather than gigabytes of runtime data.
    if(binaryExtension.test(file)||textContent(header)===null) return;
    const text=textContent(read());
    if(text===null) return;
    checked++;
    for(const finding of scanText(text,{file,terms:identity.terms})) violations.push({file:safeLocation(file,identity.terms),...finding});
  };
  try{if(archive){
    // electron-builder already installs this archive reader; no extra dependency is added.
    const asar=createRequire(import.meta.url)('@electron/asar');
    const entries=asar.listPackage(archive).map(entry=>entry.replace(/^[\\/]+/,'').replaceAll('\\','/'));
    if(entries.includes('native/runtime.json')) expectedNative=`native/${JSON.parse(asar.extractFile(archive,path.normalize('native/runtime.json')).toString('utf8')).binary}`;
    const {headerSize}=asar.getRawHeader(archive);
    for(const file of entries){
      if(file.split(/[\\/]/).includes('..')) throw new Error('Invalid archive entry');
      const info=asar.statFile(archive,path.normalize(file),false);
      if(info.files) continue;
      if(info.link){inspect(file,Buffer.from(info.link));continue;}
      const header=info.unpacked?prefix(path.join(`${archive}.unpacked`,file),Math.min(8192,info.size)):prefix(archive,Math.min(8192,info.size),8+headerSize+Number(info.offset));
      inspect(file,header,()=>asar.extractFile(archive,path.normalize(file)));
    }
  }else{
    const manifest=path.join(root,'native','runtime.json');
    if(fs.existsSync(manifest)) expectedNative=`native/${JSON.parse(fs.readFileSync(manifest,'utf8')).binary}`;
    for(const file of sourceFiles(root)){
    const absolute=path.resolve(root,file);
    if(!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid privacy scan entry');
    const stat=fs.lstatSync(absolute);
    if(stat.isSymbolicLink()) inspect(file,Buffer.from(fs.readlinkSync(absolute)));
    else if(stat.isFile()) inspect(file,prefix(absolute),()=>fs.readFileSync(absolute));
  }}}catch{throw new Error('Privacy scan could not complete; verify Git, files and build dependencies');}
  for(const finding of violations) report(`${finding.file}:${finding.line}: ${finding.category}`);
  if(violations.length) throw new Error('Privacy check failed; remove the reported private content');
  return {checked,binaries};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    const index=args.indexOf('--archive');
    if(index>=0&&!args[index+1]) throw new Error('Missing archive');
    const result=checkPrivacy({strict:args.includes('--release'),archive:index>=0?path.resolve(args[index+1]):undefined});
    console.log(`Privacy check passed (${result.checked} text files, ${result.binaries} owned binaries).`);
  }catch{
    // Errors from Git, fs and archive readers can contain private absolute paths.
    console.error('Privacy check failed. Check reported locations and local identity configuration.');
    process.exitCode=1;
  }
}
