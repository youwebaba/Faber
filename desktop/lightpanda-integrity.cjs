const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createReadStream}=require('node:fs');
const {createHash}=require('node:crypto');
async function verifyLightpanda(root) {
  const lock=JSON.parse(await fs.readFile(path.join(root,'build/lightpanda-lock.json'),'utf8'));
  const directory=path.join(root,'.runtime/lightpanda');
  if(JSON.stringify(JSON.parse(await fs.readFile(path.join(directory,'runtime-lock.json'),'utf8')))!==JSON.stringify(lock))throw Error('Lightpanda resource lock differs from reviewed lock');
  const expected=new Set(['runtime-lock.json',...lock.files.map(file=>file.name)]);
  for(const entry of await fs.readdir(directory,{withFileTypes:true}))if(!entry.isFile()||!expected.delete(entry.name))throw Error(`Unreviewed Lightpanda resource: ${entry.name}`);
  if(expected.size)throw Error(`Missing Lightpanda resource: ${[...expected].join(', ')}`);
  for(const file of lock.files){
    if(path.basename(file.name)!==file.name)throw Error('Invalid Lightpanda resource name');
    const filename=path.join(directory,file.name),hash=createHash('sha256');
    for await(const bytes of createReadStream(filename))hash.update(bytes);
    if((await fs.stat(filename)).size!==file.bytes||hash.digest('hex')!==file.sha256)throw Error(`Lightpanda resource integrity mismatch: ${file.name}`);
  }
  const {readAddonPackage}=await import(pathToFileURL(path.join(__dirname,'addons.mjs')));
  const catalog=JSON.parse(await fs.readFile(path.join(root,'bundled-addons/catalog.json'),'utf8'));
  for(const item of catalog.addons){if(!/^[a-z][a-z0-9-]{0,63}$/.test(item.id))throw Error('Invalid bundled addon id');const pkg=await readAddonPackage(path.join(root,'bundled-addons',item.id));if(pkg.digest!==item.digest)throw Error(`Bundled addon hash differs: ${item.id}`);}
}
module.exports={verifyLightpanda};
