import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildNative} from '../native/build.mjs';

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await buildNative({sourceDir});
console.log(result.stdout);
console.log(`Rust worker ready: ${result.manifest.binary}`);
