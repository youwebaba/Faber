import path from 'node:path';
import {createHash} from 'node:crypto';

export const artifactLimits=Object.freeze({chart:2*1024*1024,map:4*1024*1024,diagram:1024*1024,html:2*1024*1024,asset:8*1024*1024});
export const artifactKinds=Object.keys(artifactLimits);
const formats=[['.chart.json','chart','application/vnd.faber.chart+json'],['.diagram.json','diagram','application/vnd.faber.diagram+json'],['.geojson','map','application/geo+json'],['.html','html','text/html'],['.htm','html','text/html']];
const assetTypes={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.bin':'application/octet-stream','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};
export function artifactFormat(name){const entry=formats.find(([suffix])=>name.toLowerCase().endsWith(suffix));return entry?[entry[1],entry[2]]:null;}
export function assetMimeFor(name){return assetTypes[path.extname(name).toLowerCase()]||null;}
export function validAssetName(name){return typeof name==='string'&&name.length>0&&name.length<=240&&name.split('/').every(part=>/^[A-Za-z0-9_.-]+$/.test(part)&&part!=='.'&&part!=='..')&&name!=='index.html'&&name!=='wrapper.html';}
export function mediaGraphRevision(media){return createHash('sha256').update(JSON.stringify([media.revision,(media.assets||[]).map(({name,media:child})=>[name,child.revision,child.mimeType,child.bytes]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)])).digest('hex');}
export function validateArtifactRef(media){
  if(artifactKinds.includes(media.kind)){
    const format=media.kind==='asset'?['asset',assetMimeFor(media.name)]:artifactFormat(media.name);
    if(!format||format[0]!==media.kind||format[1]!==media.mimeType||media.storage!=='interactive'||!media.revision||media.bytes>artifactLimits[media.kind])throw new Error('Invalid interactive artifact type, revision or size');
  }else if(media.storage!==undefined)throw new Error('Unexpected artifact storage marker');
  if(media.assets!==undefined){
    if(media.kind!=='html'||media.assets.length>32||media.assets.reduce((size,row)=>size+row.media.bytes,media.bytes)>16*1024*1024)throw new Error('Interactive asset graph exceeds its type or size limit');
    const names=new Set(),ids=new Set([media.id]);for(const row of media.assets){if(!validAssetName(row.name)||row.media.kind!=='asset'||names.has(row.name)||ids.has(row.media.id))throw new Error('Invalid or duplicate interactive asset');names.add(row.name);ids.add(row.media.id);}
    if(media.graphRevision!==mediaGraphRevision(media))throw new Error('Interactive asset graph revision did not match');
  }
  return media;
}
