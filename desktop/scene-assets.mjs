import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const files=['scene-driver.mjs','scene-data.mjs','scene-bundled.mjs','scene.html','scene.css'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifySceneAssets(root){
  const info=JSON.parse(await fs.readFile(path.join(root,'build','scene-assets.json'),'utf8'));
  if(info.three!=='0.187.0'||Object.keys(info.files).length!==files.length)throw Error('Invalid 3D viewer manifest.');
  for(const name of files)if(sha(await fs.readFile(path.join(root,'renderer','preview',name)))!==info.files[name])throw Error('3D viewer file differs from its reviewed hash.');
  if(sha(await fs.readFile(path.join(root,'build','licenses','THREE-LICENSE.txt')))!==info.licenseSha256)throw Error('Missing 3D viewer license.');
}
export async function sceneAsset(request,root){
  const url=new URL(request.url);
  if(url.protocol!=='faber-preview:'||url.host!=='viewer'||url.username||url.password||url.search||request.method!=='GET')return null;
  const mime={'/scene.html':'text/html','/scene.css':'text/css','/scene-bundled.mjs':'text/javascript'}[url.pathname];if(!mime)return null;
  const bytes=await fs.readFile(path.join(root,'renderer','preview',url.pathname.slice(1)));
  return new Response(bytes,{headers:{'Content-Type':mime,'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
