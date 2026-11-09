import path from 'node:path';
import {createHash} from 'node:crypto';
import {sceneUri,sceneLimits} from '../renderer/preview/scene-data.mjs';

export const artifactLimits=Object.freeze({chart:2*1024*1024,map:4*1024*1024,diagram:1024*1024,html:2*1024*1024,asset:8*1024*1024,scene:sceneLimits.root});
export const artifactKinds=Object.keys(artifactLimits);
const formats=[['.chart.json','chart','application/vnd.faber.chart+json'],['.diagram.json','diagram','application/vnd.faber.diagram+json'],['.geojson','map','application/geo+json'],['.html','html','text/html'],['.htm','html','text/html'],['.glb','scene','model/gltf-binary'],['.gltf','scene','model/gltf+json'],['.stl','scene','model/stl']];
const assetTypes={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.bin':'application/octet-stream','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};
export function artifactFormat(name){const entry=formats.find(([suffix])=>name.toLowerCase().endsWith(suffix));return entry?[entry[1],entry[2]]:null;}
const sceneAssetTypes={'.bin':'application/octet-stream','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
export function assetMimeFor(name,storage='interactive'){return (storage==='scene'?sceneAssetTypes:storage==='interactive'?assetTypes:{})[path.extname(name).toLowerCase()]||null;}
export function validAssetName(name){return typeof name==='string'&&name.length>0&&name.length<=240&&name.split('/').every(part=>/^[A-Za-z0-9_.-]+$/.test(part)&&part!=='.'&&part!=='..')&&name!=='index.html'&&name!=='wrapper.html';}
export function mediaGraphRevision(media){return createHash('sha256').update(JSON.stringify([media.revision,(media.assets||[]).map(({name,media:child})=>[name,child.revision,child.mimeType,child.bytes]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)])).digest('hex');}
export function validateArtifactRef(media){
  if(artifactKinds.includes(media.kind)){
    const storage=media.kind==='scene'?'scene':media.kind==='asset'?media.storage:'interactive',format=media.kind==='asset'?['asset',assetMimeFor(media.name,storage)]:artifactFormat(media.name),limit=storage==='scene'?sceneLimits.root:artifactLimits[media.kind];
    if(!format||!format[1]||format[0]!==media.kind||format[1]!==media.mimeType||!['scene','interactive'].includes(storage)||media.storage!==storage||!media.revision||media.bytes>limit)throw new Error('Invalid artifact storage, type, revision or size');
  }else if(media.storage!==undefined)throw new Error('Unexpected artifact storage marker');
  if(media.assets!==undefined||media.graphRevision!==undefined){
    const scene=media.kind==='scene',storage=scene?'scene':'interactive',limit=scene?sceneLimits.total:16*1024*1024;
    if(!['scene','html'].includes(media.kind)||!Array.isArray(media.assets)||media.assets.length>32||media.assets.reduce((size,row)=>size+row.media.bytes,media.bytes)>limit)throw new Error('Artifact asset graph exceeds its type or size limit');
    const names=new Set(),ids=new Set([media.id]);for(const row of media.assets){if(!(scene?sceneUri(row.name)===row.name:validAssetName(row.name))||row.media.kind!=='asset'||row.media.storage!==storage||names.has(row.name)||ids.has(row.media.id))throw new Error('Invalid, mixed-storage or duplicate artifact asset');names.add(row.name);ids.add(row.media.id);}
    if(media.graphRevision!==mediaGraphRevision(media))throw new Error('Artifact graph revision did not match');
  }
  return media;
}
