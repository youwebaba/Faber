import fs from 'node:fs/promises';
import path from 'node:path';
import { containedPath } from './files.mjs';
import {createHash} from 'node:crypto';
import {inspectScene,sceneUri,sceneLimits} from '../renderer/preview/scene-data.mjs';
import {inspectWave,inspectMidi} from '../renderer/preview/timed.mjs';
import {artifactFormat,artifactLimits,assetMimeFor,validAssetName,mediaGraphRevision} from '../core/media-artifacts.mjs';
import {parseInteractiveData} from '../renderer/preview/interactive-data.mjs';
import {validateMediaRef} from '../core/media.mjs';

export function mediaTools() {
  return [{
    name: 'media_show', permission: 'read',
    description: 'Display saved project media in chat: audio/video, documents, SVG, GIF/APNG, MIDI, .chart.json (bar/line/scatter series), .geojson maps, .diagram.json (nodes/edges), small HTML/JS demos, or static GLB/glTF/STL. HTML may declare assets:[{path,name?}] with safe virtual relative names (32 assets/16 MiB total). A 3D model must declare every external BIN/PNG/JPEG as assets:[{path,name}], where name is its canonical model-relative URI. Each file is independently authorized and snapshotted. Interactive HTML runs only after the user chooses Run, without external network, devices, files or Faber privileges. Optional tracks:[{path,label?}] groups supplied PCM WAV stems, and captions:[{path,label?}] attaches SRT/VTT. Paths are project-relative. Never generates, separates, transcribes or sends media bytes to the model.',
    parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 4096 },assets:{type:'array',maxItems:32,items:{type:'object',properties:{path:{type:'string',minLength:1,maxLength:4096},name:{type:'string',minLength:1,maxLength:250}},required:['path'],additionalProperties:false}},title:{type:'string',minLength:1,maxLength:100},tracks:{type:'array',minItems:2,maxItems:8,items:{type:'object',properties:{path:{type:'string',minLength:1,maxLength:4096},label:{type:'string',minLength:1,maxLength:100}},required:['path'],additionalProperties:false}},captions:{type:'array',minItems:1,maxItems:4,items:{type:'object',properties:{path:{type:'string',minLength:1,maxLength:4096},label:{type:'string',minLength:1,maxLength:100}},required:['path'],additionalProperties:false}} }, additionalProperties: false },
    async execute(args, ctx) {
      if(Boolean(args.path)===Boolean(args.tracks))throw new Error('Choose one media path or a group of PCM WAV stems');
      const scene=Boolean(args.path&&['.glb','.gltf','.stl'].includes(path.extname(args.path).toLowerCase()));
      if(!scene&&args.assets?.some(row=>!validAssetName(row.name||path.basename(row.path))))throw new Error('Use safe relative virtual asset names without dot segments or reserved entry names');
      if(args.assets&&new Set(args.assets.map(row=>row.name||path.basename(row.path))).size!==args.assets.length)throw new Error('Asset virtual names must be unique');
      let decodedSamples=0,total=0,assetTotal=0;const grouped=Boolean(args.tracks||args.captions||args.title);
      async function publish(input,role){
      ctx.signal?.throwIfAborted();
      const target = await containedPath(ctx.project.path,input.path);
      await ctx.authorizePath?.(target);
      ctx.signal?.throwIfAborted();
      if (await containedPath(ctx.project.path,input.path) !== target) throw new Error('Media path changed while waiting for project approval. Try again.');
      if (!ctx.runtime?.publishMedia) throw new Error('Chat media publishing is unavailable in this session');
      const file = await fs.open(target,'r');
      try {
        const opened = await file.stat(), current = await fs.stat(target);
        if (await containedPath(ctx.project.path,input.path) !== target || opened.ino !== current.ino || opened.dev !== current.dev) throw new Error('Media path changed while opening. Try again.');
        await ctx.authorizePath?.(target); ctx.signal?.throwIfAborted();
        const extension=path.extname(target).toLowerCase();
        let sceneBytes;
        if(role==='sceneAsset'||role==='scene'){
          if(opened.size<1||opened.size>sceneLimits.root)throw new Error('3D file exceeds its bounded size');
          if(role==='sceneAsset'&&!assetMimeFor(target,'scene'))throw new Error('3D assets must be BIN, PNG or JPEG');
          sceneBytes=Buffer.alloc(opened.size);for(let offset=0;offset<sceneBytes.length;){ctx.signal?.throwIfAborted();const {bytesRead}=await file.read(sceneBytes,offset,sceneBytes.length-offset,offset);if(!bytesRead)throw new Error('3D file changed while reading');offset+=bytesRead;}
        }
        const format=artifactFormat(path.basename(target));
        if(role==='asset'){if(!assetMimeFor(target)||opened.size>artifactLimits.asset)throw new Error('Unsupported or oversized interactive asset');assetTotal+=opened.size;if(assetTotal>16*1024*1024)throw new Error('Interactive asset graph exceeds 16 MiB');}
        else if(format&&!sceneBytes){if(opened.size>artifactLimits[format[0]])throw new Error('Interactive artifact exceeds its file limit');assetTotal=opened.size;const bytes=Buffer.alloc(opened.size);for(let offset=0;offset<bytes.length;){ctx.signal?.throwIfAborted();const result=await file.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)throw new Error('Interactive source changed while reading');offset+=result.bytesRead;}if(format[0]!=='html')parseInteractiveData(bytes.buffer,format[0]);else new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
        if(role==='stem'){if(extension!=='.wav'||opened.size>32*1024*1024)throw new Error('Grouped stems require PCM WAV files up to 32 MiB');const header=Buffer.alloc(Math.min(65536,opened.size));await file.read(header,0,header.length,0);const info=inspectWave(header.buffer,opened.size);decodedSamples+=info.samples;total+=opened.size;if(decodedSamples>32_000_000||total>64*1024*1024)throw new Error('Stem group exceeds its transfer or decoded memory limit');}
        if(role==='caption'&&!['.srt','.vtt'].includes(extension))throw new Error('Caption tracks must be SRT or VTT');
        if(['.mid','.midi'].includes(extension)){if(opened.size>4*1024*1024)throw new Error('MIDI file exceeds 4 MiB');const bytes=Buffer.alloc(opened.size);await file.read(bytes,0,bytes.length,0);inspectMidi(bytes.buffer);}
        const media=await ctx.runtime.publishMedia({ chatId: ctx.chat.id, file, name: path.basename(target), signal: ctx.signal,revisioned:grouped,...(role==='asset'?{asset:true,storage:'interactive'}:role==='sceneAsset'?{asset:true,storage:'scene'}:sceneBytes?{storage:'scene'}:{}) });
        if(sceneBytes){if(media.revision!==createHash('sha256').update(sceneBytes).digest('hex'))throw new Error('3D revision changed during publication');return {media,bytes:sceneBytes};}return media;
      } finally { await file.close(); }
      }
      const tracks=[];let media;
      if(scene){
        if(args.captions||args.tracks)throw new Error('3D files cannot contain audio groups');
        const root=await publish({path:args.path},'scene'),assets=[],bytes=new Map();let total=root.bytes.length;
        for(const input of args.assets||[]){const name=sceneUri(input.name);if(name!==input.name||bytes.has(name))throw new Error('3D dependency names must be canonical and unique');const child=await publish(input,'sceneAsset');total+=child.bytes.length;if(total>sceneLimits.total)throw new Error('3D artifact exceeds 96 MiB');assets.push({name,media:child.media});bytes.set(name,child.bytes);}
        inspectScene(root.media.name,root.bytes,bytes);ctx.signal?.throwIfAborted();
        media={...root.media,assets,...(args.title?{title:args.title}:{})};media.graphRevision=mediaGraphRevision(media);validateMediaRef(media);return {media};
      }
      if(args.tracks){for(const input of args.tracks){const ref=await publish(input,'stem');tracks.push({label:input.label||ref.name,media:ref});}media={...tracks[0].media,tracks};}
      else media=await publish({path:args.path},'main');
      if(media.kind==='caption')throw new Error('Associate subtitle files with audio/video using captions');
      if(args.captions){if(!['audio','video','midi'].includes(media.kind))throw new Error('Captions require audio, video, MIDI or stems');const captions=[];for(const input of args.captions){const ref=await publish(input,'caption');captions.push({label:input.label||ref.name,media:ref});}media={...media,captions};}
      if(args.title)media.title=args.title;
      if(args.assets||media.kind==='html'){if(media.kind!=='html')throw new Error('Declare assets only for an HTML demo');const assets=[];for(const input of args.assets||[]){const ref=await publish(input,'asset');assets.push({name:input.name||path.basename(input.path),media:ref});}media={...media,assets};media.graphRevision=mediaGraphRevision(media);}
      validateMediaRef(media);return{media};
    },
  }];
}
