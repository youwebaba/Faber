import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const root=path.resolve(import.meta.dirname,'..'),vendor=path.join(root,'renderer/vendor/spessasynth'),runtime=path.join(root,'.runtime/media-runtime');
const packages=[
  ['spessasynth_lib','4.4.7','fZOoU3pV4o/OPfIZYOnj5En+fmejwWViaGgQ+l0p8q6j9t55APVoLojEuEENvdcpojoe+v6VQKj7E04Ke/dpag==',{'dist/index.js':'spessasynth_lib.js','dist/spessasynth_processor.min.js':'spessasynth_processor.min.js',LICENSE:'LICENSE-spessasynth_lib'}],
  ['spessasynth_core','4.4.9','XukwmKvjQziCvjDdL0XAye1wg6FygDl3rdOGEO3WIwFQownVJybgbjZiH42ryG0fZSKWLVK3RHmD7SSNpn9WyA==',{'dist/index.js':'spessasynth_core.js',LICENSE:'LICENSE-spessasynth_core'}],
  ['fflate','0.8.3','tbZNuJrLwGUp3zshBtdy4W+ORxZuIh8a5ilyIEQDC5rY1f3U20JMry0Ll3WBzU58EZKsEuJFXhb5gwv8CsPvgA==',{'esm/browser.js':'fflate.js',LICENSE:'LICENSE-fflate'}],
  ['stb-vorbis','0.0.7','OsD8Vm9EcStsiYGUBSqJ88gBPwDYR1Uv57bV/KZhu6Li1kzjm0fO+iiTkm79bZ1L2I/z6IrA1wkWHu3xQYY7Hw==',{'dist/index.js':'stb-vorbis.js',LICENSE:'LICENSE-stb-vorbis'}],
];
async function download(url,limit){const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)});if(!response.ok||Number(response.headers.get('content-length'))>limit)throw new Error('Timed-media asset unavailable or oversized');const reader=response.body.getReader(),parts=[];let size=0;try{while(true){const row=await reader.read();if(row.done)break;size+=row.value.length;if(size>limit)throw new Error('Timed-media asset exceeded its size bound');parts.push(row.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}return Buffer.concat(parts);}
const files={},sources=[];
await fs.mkdir(vendor,{recursive:true});await fs.mkdir(runtime,{recursive:true});
async function write(name,bytes){await fs.writeFile(path.join(vendor,name),bytes);files[name]={sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};}
for(const [name,version,integrity,selected]of packages){
  const url=`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,archive=await download(url,8*1024*1024);
  if(createHash('sha512').update(archive).digest('base64')!==integrity)throw new Error(name+' integrity mismatch');
  const tar=gunzipSync(archive,{maxOutputLength:12*1024*1024}),found=new Set();
  for(let offset=0;offset+512<=tar.length;){const header=tar.subarray(offset,offset+512),entry=header.toString('utf8',0,100).split('\0')[0].replace(/^package\//,''),size=parseInt(header.toString('ascii',124,136).replace(/\0/g,'').trim()||'0',8);if(!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length)throw new Error('Malformed asset archive');if(Object.hasOwn(selected,entry)&&[0,48].includes(header[156])){let bytes=tar.subarray(offset+512,offset+512+size);if(entry.endsWith('.js')){let text=bytes.toString();for(const module of ['spessasynth_core','fflate','stb-vorbis'])text=text.replaceAll('from "'+module+'"','from "./'+module+'.js"');text=text.replace(/^\/\/# sourceMappingURL=.*$/gm,'');bytes=Buffer.from('// Faber packaging: local import paths only; upstream synthesis code unchanged.\n'+text);}await write(selected[entry],bytes);found.add(entry);}offset+=512+Math.ceil(size/512)*512;}
  if(found.size!==Object.keys(selected).length)throw new Error(name+' archive incomplete');sources.push({name,version,url,integrity:'sha512-'+integrity});
}
const bankUrl='https://raw.githubusercontent.com/musescore/MuseScore/v2.3.2/share/sound/FluidR3Mono_GM.sf3',bank=await download(bankUrl,16*1024*1024);
if(bank.length!==14563174||createHash('sha256').update(bank).digest('hex')!=='cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2')throw new Error('Pinned sound bank did not match');
await fs.writeFile(path.join(runtime,'FluidR3Mono_GM.sf3'),bank);
const license=await download(bankUrl.replace('FluidR3Mono_GM.sf3','FluidR3Mono_License.md'),32768);
if(createHash('sha1').update(Buffer.from('blob '+license.length+'\0')).update(license).digest('hex')!=='c23a3f3f6fe9307338eba8ee096f3823699eedb7')throw new Error('Sound bank license did not match');
await write('LICENSE-FluidR3Mono.md',Buffer.from(license.toString('latin1')));
const manifest={schemaVersion:1,synthesizer:'SpessaSynth',sources,files,bank:{file:'FluidR3Mono_GM.sf3',name:'FluidR3Mono GM',version:'2.312',license:'MIT',url:bankUrl,bytes:bank.length,sha256:createHash('sha256').update(bank).digest('hex')}};
await fs.writeFile(path.join(vendor,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({assets:Object.keys(files).length,bank:manifest.bank}));
