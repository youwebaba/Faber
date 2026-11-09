import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),modules=path.resolve(process.argv[2]||path.join(root,'node_modules'));
const require=createRequire(path.join(modules,'faber-scene-build.cjs')),three=path.join(modules,'three');
const esbuild=require('esbuild'),version=JSON.parse(await fs.readFile(path.join(three,'package.json'),'utf8')).version;
assert.equal(version,'0.187.0');assert.equal(esbuild.version,'0.28.2');
const directory=path.join(root,'renderer','preview'),out=path.join(directory,'scene-bundled.mjs');
await esbuild.build({absWorkingDir:root,entryPoints:[path.join(directory,'scene-driver.mjs')],outfile:out,bundle:true,format:'esm',platform:'browser',target:'chrome140',minify:true,legalComments:'inline',plugins:[{name:'pinned-three',setup(build){
  build.onResolve({filter:/^three(?:\/|$)/},({path:specifier})=>{
    if(specifier==='three')return {path:path.join(three,'build','three.module.js')};
    if(!specifier.startsWith('three/addons/'))throw Error('Unexpected Three.js build import');
    return {path:path.join(three,'examples','jsm',specifier.slice(12))};
  });
}}]});
const license=await fs.readFile(path.join(three,'LICENSE'));await fs.writeFile(path.join(root,'build/licenses/THREE-LICENSE.txt'),license);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),names=['scene-driver.mjs','scene-data.mjs','scene-bundled.mjs','scene.html','scene.css'],files={};
for(const name of names)files[name]=sha(await fs.readFile(path.join(directory,name)));
await fs.writeFile(path.join(root,'build','scene-assets.json'),JSON.stringify({three:version,esbuild:esbuild.version,files,licenseSha256:sha(license)},null,2)+'\n');
console.log('Verified and bundled Three.js '+version);
