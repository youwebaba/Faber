const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const crypto = require('node:crypto');
async function verifyRuntime(root) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'build', 'runtime-lock.json'), 'utf8'));
  const directory=path.join(root,'.runtime','local-runtime'),expected=new Set([...manifest.files.map(file=>file.path),'runtime-manifest.json']);
  async function visit(relative='') {
    for(const entry of await fs.readdir(path.join(directory,relative),{withFileTypes:true})) {
      const name=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())throw new Error(`Bundled runtime link rejected: ${name}`);
      if(entry.isDirectory())await visit(name);else if(!entry.isFile()||!expected.delete(name))throw new Error(`Unreviewed bundled runtime file: ${name}`);
    }
  }
  await visit();if(expected.size)throw new Error(`Missing bundled runtime files: ${[...expected].join(', ')}`);
  if(JSON.stringify(JSON.parse(await fs.readFile(path.join(directory,'runtime-manifest.json'),'utf8')))!==JSON.stringify(manifest))throw new Error('Bundled runtime manifest differs from reviewed lock');
  for (const file of manifest.files) {
    const target = path.join(directory,file.path), stat = await fs.stat(target), hash = crypto.createHash('sha256');
    for await (const bytes of createReadStream(target)) hash.update(bytes);
    if (stat.size !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`Bundled runtime integrity mismatch: ${file.path}`);
  }
}
module.exports = context => verifyRuntime(context.packager.projectDir);
module.exports.verifyRuntime=verifyRuntime;
