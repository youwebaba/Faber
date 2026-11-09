import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {noLinks,validFilePath} from '../model-hub/paths.mjs';

export async function musicDigest(file) {
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(file))hash.update(bytes);
  return hash.digest('hex');
}

export async function verifyMusicRuntime(directory,manifest,signal) {
  if(manifest?.schemaVersion!==1||manifest.executable!=='mm-synth.exe'||!Array.isArray(manifest.files)||!manifest.files.length)throw new Error('Invalid Music3 runtime lock');
  const expected=new Set(['runtime-manifest.json']);
  for(const item of manifest.files){validFilePath(item.path);if(expected.has(item.path)||!Number.isSafeInteger(item.size)||item.size<1||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error('Invalid Music3 runtime file lock');expected.add(item.path);}
  async function visit(relative=''){
    await noLinks(path.join(directory,relative));
    for(const entry of await fs.readdir(path.join(directory,relative),{withFileTypes:true})){
      const name=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())throw new Error('Music3 runtime links are not allowed');
      if(entry.isDirectory())await visit(name);else if(!entry.isFile()||!expected.delete(name))throw new Error(`Unreviewed Music3 runtime file: ${name}`);
    }
  }
  await visit();if(expected.size)throw new Error('Music3 runtime is incomplete; reinstall Faber');
  if(JSON.stringify(JSON.parse(await fs.readFile(path.join(directory,'runtime-manifest.json'),'utf8')))!==JSON.stringify(manifest))throw new Error('Music3 runtime manifest differs from its pinned lock');
  for(const item of manifest.files){signal?.throwIfAborted();const target=path.join(directory,item.path);if((await fs.stat(target)).size!==item.size||await musicDigest(target)!==item.sha256)throw new Error(`Music3 runtime integrity mismatch: ${item.path}`);}
  return path.join(directory,manifest.executable);
}
