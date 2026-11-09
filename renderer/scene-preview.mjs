import {fetchTimedMedia} from './timed-media.mjs';
import {inspectScene,sceneUri,sceneLimits} from './preview/scene-data.mjs';

export function sceneReferences(ref){
  if(ref?.kind!=='scene'||!['model/gltf-binary','model/gltf+json','model/stl'].includes(ref.mimeType)||!['.glb','.gltf','.stl'].some(ext=>ref.name?.toLowerCase().endsWith(ext))||ref.bytes>sceneLimits.root||ref.storage!=='scene'||!/^[a-f0-9]{64}$/.test(ref.graphRevision||'')||!Array.isArray(ref.assets)||ref.assets.length>32)return false;
  try{const names=new Set(),ids=new Set([ref.id]);let total=ref.bytes;for(const row of ref.assets){const child=row.media,format={'.bin':'application/octet-stream','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'},ext=/\.[a-z]+$/.exec(child.name?.toLowerCase())?.[0];if(sceneUri(row.name)!==row.name||names.has(row.name)||ids.has(child.id)||child.kind!=='asset'||child.storage!=='scene'||!format[ext]||format[ext]!==child.mimeType||typeof child.name!=='string'||child.name.length>180||/[\\/:\x00-\x1f\x7f]/.test(child.name)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(child.id)||!/^[a-f0-9]{64}$/.test(child.revision)||!Number.isSafeInteger(child.bytes)||child.bytes<1||child.bytes>sceneLimits.root||child.assets||child.tracks||child.captions) return false;names.add(row.name);ids.add(child.id);total+=child.bytes;}return total<=sceneLimits.total;}catch{return false;}
}
export async function verifySceneGraph(ref){
  const input=JSON.stringify([ref.revision,ref.assets.map(row=>[row.name,row.media.revision,row.media.mimeType,row.media.bytes]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)]);
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input)))].map(n=>n.toString(16).padStart(2,'0')).join('');if(digest!==ref.graphRevision)throw new Error('3D artifact revision does not match its dependencies');
}
export function createScenePreview({ref,context,source,request,document=globalThis.document,window=globalThis.window,available=true}){
  const node=document.createElement('figure');node.className='message-media document-preview scene-preview';node.dataset.mediaId=ref.id;
  const caption=document.createElement('figcaption');caption.textContent=ref.title||ref.name;
  const controls=document.createElement('div');controls.className='document-actions';
  const frame=document.createElement('iframe');frame.title=ref.name;frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.setAttribute('referrerpolicy','no-referrer');
  const status=document.createElement('p');status.className='media-status hint';status.setAttribute('role','status');
  const owner={chatId:context.chatId,...(context.deviceId?{deviceId:context.deviceId}:{})};let controller,token,disposed=false;
  const button=(label,fn)=>{const b=document.createElement('button');b.type='button';b.className='button';b.textContent=label;b.addEventListener('click',()=>Promise.resolve(fn()).catch(e=>{status.textContent=e.message;}));controls.append(b);};
  const post=(type,extra={})=>frame.contentWindow?.postMessage({type,token,...extra},'faber-preview://viewer');
  function stop(){controller?.abort();post('scene-stop');frame.src='about:blank';delete node.dataset.previewLoaded;}
  async function load(active){try{await verifySceneGraph(ref);const bytes=await fetchTimedMedia(ref,source(ref),active.signal),assets=[];for(const row of ref.assets)assets.push({uri:row.name,bytes:await fetchTimedMedia(row.media,source(row.media),active.signal)});inspectScene(ref.name,new Uint8Array(bytes),new Map(assets.map(a=>[a.uri,new Uint8Array(a.bytes)])));active.signal.throwIfAborted();if(controller!==active||disposed)return;post('scene-open',{name:ref.name,bytes,assets});status.textContent='Opening 3D preview…';}catch(e){if(!active.signal.aborted)status.textContent=e.message;}}
  function start(){stop();if(!available||disposed)return;controller=new AbortController();token=crypto.randomUUID();status.textContent='Loading 3D attachment…';const active=controller;frame.onload=()=>{if(frame.src.startsWith('faber-preview:')&&controller===active)void load(active);};frame.src='faber-preview://viewer/scene.html#'+token;}
  const receive=event=>{const v=event.data;if(event.source!==frame.contentWindow||event.origin!=='faber-preview://viewer'||v?.token!==token||disposed)return;if(v.type==='scene-ready'){node.dataset.previewLoaded='true';status.textContent=Number(v.faces).toLocaleString()+' triangles';}if(v.type==='scene-error')status.textContent=String(v.message).slice(0,500);if(v.type==='scene-view'&&Array.isArray(v.position)&&v.position.length===3&&v.position.every(Number.isFinite))node.dataset.scenePosition=JSON.stringify(v.position);};window.addEventListener('message',receive);
  button('Open 3D',start);button('Stop preview',()=>{stop();status.textContent='3D preview stopped.';});button('Save original…',()=>request('media.save',{...owner,mediaId:ref.id}));for(const row of ref.assets)button('Save '+row.name+'…',()=>request('media.save',{...owner,mediaId:row.media.id}));
  node.append(caption,controls,frame,status);status.textContent=available?'Open the model to orbit, pan and zoom.':'Connect to the host to open this model.';
  return {node,preview:true,stop,setAvailable(value){available=value;if(!value){stop();status.textContent='Connect to the host to open this model.';}},destroy(){stop();disposed=true;window.removeEventListener('message',receive);}};
}
