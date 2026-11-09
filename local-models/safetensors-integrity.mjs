import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { noLinks, outputPath } from '../model-hub/paths.mjs';

export async function safetensorsDigest(filename) { const hash=createHash('sha256');for await(const bytes of createReadStream(filename))hash.update(bytes);return hash.digest('hex'); }
export async function safetensorsSourceHash(root) {
  const hash=createHash('sha256');for(const name of ['Cargo.toml','Cargo.lock','src/main.rs'])hash.update(`${name}\n${(await fs.readFile(path.join(root,'native-safetensors',name),'utf8')).replaceAll('\r\n','\n')}\n`);return hash.digest('hex');
}
export async function verifySafetensorsRuntime(directory,manifest) {
  if(manifest?.schemaVersion!==1||manifest.protocol!==2||manifest.executable!=='faber-safetensors.exe'||manifest.engineCommit!=='465191d0b0a7e2432d327b0de06204ab3f94d3a2'||!Array.isArray(manifest.files)||!manifest.files.length)throw new Error('Invalid pinned native Safetensors manifest');
  const seen=new Set();let executable=false;
  for(const file of manifest.files){
    if(typeof file.path!=='string'||seen.has(file.path.toLowerCase())||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid native Safetensors file record');seen.add(file.path.toLowerCase());
    const target=await outputPath(directory,file.path);await noLinks(target);const stat=await fs.lstat(target);
    if(!stat.isFile()||stat.size!==file.size||await safetensorsDigest(target)!==file.sha256)throw new Error(`Native Safetensors integrity mismatch: ${file.path}`);
    if(file.path===manifest.executable)executable=true;
  }
  if(!executable)throw new Error('Native Safetensors executable is not pinned');
  async function inspect(folder,prefix=''){
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      const relative=prefix+entry.name,target=path.join(folder,entry.name);await noLinks(target);
      if(entry.isDirectory()){
        if(!manifest.files.some(file=>file.path.startsWith(relative+'/')))throw new Error(`Unexpected native Safetensors directory: ${relative}`);
        await inspect(target,relative+'/');
      }else if(!entry.isFile()||relative!=='runtime-manifest.json'&&!manifest.files.some(file=>file.path===relative))throw new Error(`Unexpected native Safetensors artifact: ${relative}`);
    }
  }
  await inspect(directory);return true;
}
