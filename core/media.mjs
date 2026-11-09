import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validate } from './registry.mjs';
import {artifactLimits,artifactKinds,artifactFormat,assetMimeFor,validateArtifactRef} from './media-artifacts.mjs';

export const mediaBytesLimit = 512 * 1024 * 1024;
export const mediaChunkLimit = 256 * 1024;
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const mediaIdSchema = { type: 'string', pattern: uuid, minLength: 36, maxLength: 36 };
export const mediaFormats = Object.freeze({
  '.wav': ['audio', 'audio/wav'], '.mp3': ['audio', 'audio/mpeg'], '.m4a': ['audio', 'audio/mp4'],
  '.ogg': ['audio', 'audio/ogg'], '.mp4': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'],
  '.pdf': ['document', 'application/pdf'], '.docx': ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.svg': ['vector', 'image/svg+xml'], '.gif': ['animation', 'image/gif'], '.apng': ['animation', 'image/apng'], '.png': ['animation', 'image/png'],
  '.mid': ['midi','audio/midi'], '.midi': ['midi','audio/midi'], '.srt': ['caption','application/x-subrip'], '.vtt': ['caption','text/vtt'],
});
export const previewLimits = Object.freeze({ document: 64 * 1024 * 1024, vector: 4 * 1024 * 1024, animation: 16 * 1024 * 1024 });
export const timedMediaLimits = Object.freeze({midi:4*1024*1024,caption:1024*1024});
const notesOwner = { chatId: { type: 'string', minLength: 1, maxLength: 256 }, mediaId: mediaIdSchema, revision: { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 } };
export const mediaNotesSchemas = {
  read: { type: 'object', properties: notesOwner, required: Object.keys(notesOwner), additionalProperties: false },
  save: { type: 'object', properties: { ...notesOwner, noteId: mediaIdSchema, page: { type: 'integer', minimum: 1, maximum: 2000 }, kind: { enum: ['highlight', 'note'] }, quote: { type: 'string', maxLength: 4000 }, text: { type: 'string', maxLength: 2000 }, anchorStart: { type: 'integer', minimum: 0, maximum: 2_000_000 } }, required: [...Object.keys(notesOwner), 'noteId', 'page', 'kind', 'quote', 'text'], additionalProperties: false },
  delete: { type: 'object', properties: { ...notesOwner, noteId: mediaIdSchema }, required: [...Object.keys(notesOwner), 'noteId'], additionalProperties: false },
};
const refProperties = {
  id: mediaIdSchema, kind: { enum: ['audio','video','document','vector','animation','midi','caption',...artifactKinds] }, mimeType: { type: 'string', maxLength: 100 }, revision: { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 },storage:{enum:['interactive']},
  bytes: { type: 'integer', minimum: 1, maximum: mediaBytesLimit }, name: { type: 'string', minLength: 1, maxLength: 180 },
};
const baseRefSchema={type:'object',additionalProperties:false,required:['id','kind','mimeType','bytes','name'],properties:refProperties};
const memberSchema={type:'object',additionalProperties:false,properties:{label:{type:'string',minLength:1,maxLength:100},media:baseRefSchema},required:['label','media']};
const refSchema = {...baseRefSchema,properties:{...refProperties,title:{type:'string',minLength:1,maxLength:100},tracks:{type:'array',minItems:2,maxItems:8,items:memberSchema},captions:{type:'array',minItems:1,maxItems:4,items:memberSchema},assets:{type:'array',maxItems:32,items:{type:'object',properties:{name:{type:'string',minLength:1,maxLength:240},media:baseRefSchema},required:['name','media'],additionalProperties:false}},graphRevision:{type:'string',pattern:'^[a-f0-9]{64}$',minLength:64,maxLength:64}}};
export function validateMediaRef(value) {
  validate(value, refSchema);
  const format = value.kind==='asset'?['asset',assetMimeFor(value.name)]:artifactFormat(value.name)||mediaFormats[path.extname(value.name).toLowerCase()];
  if (/[\\/:\x00-\x1f\x7f]/.test(value.name) || !format || format[0] !== value.kind || format[1] !== value.mimeType) throw new Error('Invalid chat media reference');
  if (previewLimits[value.kind] && (value.bytes > previewLimits[value.kind] || !value.revision)) throw new Error('Invalid preview revision or size');
  if(timedMediaLimits[value.kind]&&(value.bytes>timedMediaLimits[value.kind]||!value.revision))throw new Error('Invalid timed-media revision or size');
  validateArtifactRef(value);for(const row of value.assets||[])validateMediaRef(row.media);
  if(value.tracks||value.captions){if(!['audio','video','midi'].includes(value.kind)||!value.revision||value.tracks&&(value.kind!=='audio'||value.mimeType!=='audio/wav'))throw new Error('Invalid media group');const members=[...(value.tracks||[]),...(value.captions||[])],ids=new Set();for(const member of members){validateMediaRef(member.media);if(!member.media.revision||ids.has(member.media.id))throw new Error('Invalid duplicate media member');ids.add(member.media.id);}if(value.tracks&&(value.tracks[0].media.id!==value.id||value.tracks.some(row=>row.media.mimeType!=='audio/wav'||row.media.bytes>32*1024*1024)||value.tracks.reduce((sum,row)=>sum+row.media.bytes,0)>64*1024*1024))throw new Error('Stems require bounded PCM WAV tracks');if(value.captions?.some(row=>row.media.kind!=='caption'))throw new Error('Invalid caption member');}
  return value;
}
export function sourceMediaRefs(source) {
  const candidates = [...(Array.isArray(source?.mediaRefs) ? source.mediaRefs.slice(0,8) : []), source?.result?.media];
  return candidates.filter(value => { try { validateMediaRef(value); return true; } catch { return false; } }).filter((value,index,all) => all.findIndex(ref => ref.id === value.id) === index);
}
export function mediaReferenceTree(source){return sourceMediaRefs(source).flatMap(ref=>[ref,...(ref.tracks||[]).map(row=>row.media),...(ref.captions||[]).map(row=>row.media),...(ref.assets||[]).map(row=>row.media)]).filter((ref,index,all)=>all.findIndex(row=>row.id===ref.id)===index);}
function checkSignature(bytes, ext,kind) {
  if(artifactKinds.includes(kind)){if(!bytes.length)throw new Error('Empty interactive artifact');return;}
  const text = (start, end) => bytes.toString('ascii', start, end);
  const valid = ext === '.wav' ? bytes.length >= 44 && text(0,4) === 'RIFF' && text(8,12) === 'WAVE'
    : ext === '.mp3' ? text(0,3) === 'ID3' || bytes.length > 3 && bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2
    : ext === '.ogg' ? bytes.length >= 27 && text(0,4) === 'OggS' && bytes[4] === 0
    : ext === '.webm' ? bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) && bytes.includes(Buffer.from('webm'))
    : ext === '.pdf' ? text(0,5) === '%PDF-'
    : ext === '.docx' ? text(0,4) === 'PK\x03\x04'
    : ['.mid','.midi'].includes(ext) ? bytes.length>=14&&text(0,4)==='MThd'&&bytes.readUInt32BE(4)===6
    : ext === '.vtt' ? /^\uFEFF?WEBVTT(?:[ \t\r\n]|$)/.test(bytes.toString('utf8'))
    : ext === '.srt' ? /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(bytes.toString('utf8'))
    : ext === '.svg' ? /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(bytes.toString('utf8').replace(/^\uFEFF/, ''))
    : ext === '.gif' ? ['GIF87a', 'GIF89a'].includes(text(0,6)) && bytes.length >= 13 && bytes.readUInt16LE(6) * bytes.readUInt16LE(8) <= 8_000_000
    : ['.apng','.png'].includes(ext) ? bytes.length>=24 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.includes(Buffer.from('acTL')) && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) <= 8_000_000
    : bytes.length >= 16 && text(4,8) === 'ftyp' && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length;
  if (!valid) throw new Error('Media contents do not match the supported file format');
}

// Bytes live outside state.json and provider history; only published chat references can read them.
export function createMediaStore({ dataDir, findReference, assertAnnotations = () => {} }) {
  const directory = path.join(dataDir, 'chat-media');
  const unpublished = new Map();
  const noteWrites = new Map();
  const ownerKey = chatId => createHash('sha256').update(chatId).digest('hex');
  async function filePath(chatId,id,kind,revision,storage) {
    if (typeof chatId !== 'string' || !chatId.length || chatId.length > 256) throw new Error('Invalid media owner');
    validate(id, mediaIdSchema);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (await fs.realpath(directory) !== path.resolve(directory)) throw new Error('Invalid chat media storage');
    const owner = path.join(directory,ownerKey(chatId));
    await fs.mkdir(owner,{recursive:true,mode:0o700});
    if (await fs.realpath(owner) !== owner) throw new Error('Invalid chat media storage');
    // Earlier releases ignore this suffix, preserving new attachments across rollback.
    return path.join(owner, id + (storage==='interactive'?'.interactive.bin':previewLimits[kind]?'.preview.bin':timedMediaLimits[kind]||revision?'.music.bin':'.bin'));
  }
  return {
    async notes(action, params, signal) {
      if (!Object.hasOwn(mediaNotesSchemas, action)) throw new Error('Unknown document annotation action');
      validate(params, mediaNotesSchemas[action]); signal?.throwIfAborted();
      const check = () => { signal?.throwIfAborted(); if(action!=='read')assertAnnotations(params.chatId);const ref = validateMediaRef(findReference(params.chatId, params.mediaId)); if (ref.kind !== 'document' || ref.revision !== params.revision) throw new Error('Document revision is no longer available'); };
      check();
      const file = (await filePath(params.chatId, params.mediaId,'document')) + '.notes.json';
      const operation = async () => {
        check(); let notes = [];
        try {
          if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Invalid annotation storage');
          const input=await fs.open(file,'r');
          try{
            const before=await input.stat();
            if(!before.isFile()||before.size>256*1024||await fs.realpath(file)!==file)throw new Error('Annotation storage exceeds its type, path or size limit');
            const bytes=Buffer.alloc(before.size);
            for(let offset=0;offset<bytes.length;){check();const {bytesRead}=await input.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('Annotation storage changed while reading');offset+=bytesRead;}
            const after=await input.stat(),current=await fs.lstat(file);
            if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||current.ino!==before.ino||current.dev!==before.dev||current.isSymbolicLink())throw new Error('Annotation storage changed while reading');
            notes=JSON.parse(bytes);
          }finally{await input.close();}
          if (!Array.isArray(notes) || notes.length > 100) throw new Error('Invalid annotation storage');
        }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        for(const note of notes)validate({...params,noteId:note.id,page:note.page,kind:note.kind,quote:note.quote,text:note.text,...(note.anchorStart!==undefined?{anchorStart:note.anchorStart}:{})},mediaNotesSchemas.save);
        check();
        if (action !== 'read') {
          notes = notes.filter(note => note.id !== params.noteId);
          if (action === 'save') notes.push({ id: params.noteId, page: params.page, kind: params.kind, quote: params.quote, text: params.text, ...(params.anchorStart!==undefined?{anchorStart:params.anchorStart}:{}) });
          if (notes.length > 100) throw new Error('Document annotation limit reached');
          const json = JSON.stringify(notes); if (Buffer.byteLength(json) > 256 * 1024) throw new Error('Document annotation storage limit reached');
          const temporary = file + '.' + randomUUID() + '.tmp';
          try { await fs.writeFile(temporary, json, { flag: 'wx', mode: 0o600, flush: true }); check(); await fs.rename(temporary, file); check(); }
          finally { await fs.rm(temporary, { force: true }); }
        }
        return { revision: params.revision, notes };
      };
      const result = (noteWrites.get(file) || Promise.resolve()).catch(() => {}).then(operation); noteWrites.set(file, result);
      try { return await result; } finally { if (noteWrites.get(file) === result) noteWrites.delete(file); }
    },
    async publish({ chatId, file, name, signal, revisioned = false,asset=false,storage }) {
      signal?.throwIfAborted();
      const ext = path.extname(name).toLowerCase(), format = asset?['asset',assetMimeFor(name)]:artifactFormat(name)||mediaFormats[ext];
      if (!format||!format[1]) throw new Error('Choose a supported media or interactive artifact format');
      if(storage!==undefined&&storage!=='interactive'||storage&& !artifactKinds.includes(format[0]))throw new Error('Invalid artifact publication storage');
      if(artifactKinds.includes(format[0]))storage='interactive';
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > mediaBytesLimit) throw new Error('Media must be a nonempty file up to 512 MiB');
      if (stat.size > (previewLimits[format[0]] || mediaBytesLimit)) throw new Error('Preview exceeds its bounded file size');
      if(stat.size>(timedMediaLimits[format[0]]||mediaBytesLimit))throw new Error('Timed media exceeds its bounded file size');
      if(stat.size>(artifactLimits[format[0]]||mediaBytesLimit))throw new Error('Interactive artifact exceeds its bounded file size');
      const head = Buffer.alloc(Math.min(65536, stat.size));
      const { bytesRead } = await file.read(head, 0, head.length, 0);
      checkSignature(head.subarray(0,bytesRead), ext,format[0]);
      name = path.basename(name).replace(/[\\/:\x00-\x1f\x7f]/g, '_');
      if (name.length > 180) name = name.slice(0,180-ext.length) + ext;
      const media = { id: randomUUID(), kind: format[0], mimeType: format[1], bytes: stat.size, name,...(storage?{storage}:{}) }, digest = previewLimits[format[0]]||timedMediaLimits[format[0]]||artifactLimits[format[0]]||revisioned ? createHash('sha256') : null;
      const target = await filePath(chatId,media.id,media.kind,revisioned,storage), temporary = target + '.tmp';
      let output, complete = false, renamed = false;
      try {
        output = await fs.open(temporary,'wx',0o600);
        const buffer = Buffer.alloc(Math.min(mediaChunkLimit,stat.size));
        for (let offset = 0; offset < stat.size;) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);
          if (!bytesRead) throw new Error('Media changed while being saved. Try again.');
          const bytes = buffer.subarray(0,bytesRead); digest?.update(bytes); await output.writeFile(bytes); offset += bytesRead;
        }
        const after = await file.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Media changed while being saved. Try again.');
        signal?.throwIfAborted();
        if (digest) media.revision = digest.digest('hex'); validateMediaRef(media);
        await output.sync(); await output.close(); output = null;
        await fs.rename(temporary,target); renamed = true;
        signal?.throwIfAborted();
        if (!unpublished.has(chatId)) unpublished.set(chatId,new Set());
        unpublished.get(chatId).add(media.id); complete = true;
        return media;
      } finally { await output?.close(); await fs.rm(temporary,{force:true}); if (renamed && !complete) await fs.rm(target,{force:true}); }
    },
    async read({ chatId, mediaId, offset = 0, length = 0 }, signal) {
      signal?.throwIfAborted();
      validate(mediaId, mediaIdSchema);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > mediaChunkLimit) throw new Error('Invalid media chunk range');
      const media = structuredClone(validateMediaRef(findReference(chatId,mediaId)));
      if (offset > media.bytes) throw new Error('Invalid media chunk range');
      const target = await filePath(chatId,mediaId,media.kind,media.revision,media.storage);
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Invalid chat media storage');
      const file = await fs.open(target,'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== media.bytes) throw new Error('Chat media is no longer available');
        const bytes = Buffer.alloc(Math.min(length,media.bytes-offset));
        for (let position = 0; position < bytes.length;) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(bytes,position,bytes.length-position,offset+position);
          if (!bytesRead) throw new Error('Chat media changed while reading');
          position += bytesRead;
        }
        signal?.throwIfAborted();
        if (JSON.stringify(findReference(chatId,mediaId)) !== JSON.stringify(media)) throw new Error('Chat media is no longer available');
        return { media: structuredClone(media), offset, data: bytes.toString('base64') };
      } finally { await file.close(); }
    },
    async settle(chatId) {
      const ids = unpublished.get(chatId); if (!ids) return;
      unpublished.delete(chatId);
      for (const id of ids) {
        let published = false; try { published = !!findReference(chatId,id); } catch { /* A canceled tool did not publish its snapshot. */ }
        if (!published) { await fs.rm(await filePath(chatId,id),{force:true});await fs.rm(await filePath(chatId,id,'document'),{force:true});await fs.rm(await filePath(chatId,id,'midi'),{force:true});await fs.rm(await filePath(chatId,id,'asset',true,'interactive'),{force:true}); }
      }
    },
    async prune(chatIds, remove = false) {
      let owners; try { owners = await fs.readdir(directory); } catch(error) { if(error.code==='ENOENT') return; throw error; }
      if (await fs.realpath(directory) !== path.resolve(directory)) throw new Error('Invalid chat media storage');
      const known = new Map(chatIds.map(id=>[ownerKey(id),id]));
      for (const owner of owners) {
        if (!/^[a-f0-9]{64}$/.test(owner) || remove && !known.has(owner)) continue;
        const folder = path.join(directory,owner);
        if ((await fs.lstat(folder)).isSymbolicLink() || !(await fs.stat(folder)).isDirectory() || await fs.realpath(folder) !== folder) throw new Error('Invalid chat media storage');
        for (const name of await fs.readdir(folder)) {
          const match = /^([0-9a-f-]{36})(?:\.(?:preview|music|interactive))?\.bin(\.tmp|\.notes\.json(?:\.[0-9a-f-]{36}\.tmp)?)?$/.exec(name);
          if (!match || !new RegExp(uuid).test(match[1])) continue;
          let keep = false;
          if (!remove && (!match[2] || match[2] === '.notes.json') && known.has(owner)) { try { keep = !!findReference(known.get(owner),match[1]); } catch { /* Interrupted or deleted chat output. */ } }
          if (!keep) await fs.rm(path.join(folder,name),{force:true});
        }
        try { await fs.rmdir(folder); } catch(error) { if(error.code!=='ENOTEMPTY' && error.code!=='EEXIST') throw error; }
      }
    },
  };
}
