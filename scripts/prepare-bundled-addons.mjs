import fs from 'node:fs/promises';import path from 'node:path';import {readAddonPackage} from '../desktop/addons.mjs';
const root=path.resolve('bundled-addons'),addons=[];
for(const item of await fs.readdir(root,{withFileTypes:true})){if(!item.isDirectory())continue;const pkg=await readAddonPackage(path.join(root,item.name));addons.push({id:pkg.manifest.id,digest:pkg.digest});}
await fs.writeFile(path.join(root,'catalog.json'),JSON.stringify({schemaVersion:1,addons},null,2));console.log(JSON.stringify(addons));
