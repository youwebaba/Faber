import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validate } from './registry.mjs';

export const mediaBytesLimit = 512 * 1024 * 1024;
export const mediaChunkLimit = 256 * 1024;
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const mediaIdSchema = { type: 'string', pattern: uuid, minLength: 36, maxLength: 36 };
export const mediaFormats = Object.freeze({
  '.wav': ['audio', 'audio/wav'], '.mp3': ['audio', 'audio/mpeg'], '.m4a': ['audio', 'audio/mp4'],
  '.ogg': ['audio', 'audio/ogg'], '.mp4': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'],
});
const refSchema = { type: 'object', additionalProperties: false, required: ['id','kind','mimeType','bytes','name'], properties: {
  id: mediaIdSchema, kind: { enum: ['audio','video'] }, mimeType: { type: 'string', maxLength: 32 },
  bytes: { type: 'integer', minimum: 1, maximum: mediaBytesLimit }, name: { type: 'string', minLength: 1, maxLength: 180 },
} };
export function validateMediaRef(value) {
  validate(value, refSchema);
  const format = mediaFormats[path.extname(value.name).toLowerCase()];
  if (/[\\/:\x00-\x1f\x7f]/.test(value.name) || !format || format[0] !== value.kind || format[1] !== value.mimeType) throw new Error('Invalid chat media reference');
  return value;
}
export function sourceMediaRefs(source) {
  const candidates = [...(Array.isArray(source?.mediaRefs) ? source.mediaRefs.slice(0,8) : []), source?.result?.media];
  return candidates.filter(value => { try { validateMediaRef(value); return true; } catch { return false; } }).filter((value,index,all) => all.findIndex(ref => ref.id === value.id) === index);
}
function checkSignature(bytes, ext) {
  const text = (start, end) => bytes.toString('ascii', start, end);
  const valid = ext === '.wav' ? bytes.length >= 44 && text(0,4) === 'RIFF' && text(8,12) === 'WAVE'
    : ext === '.mp3' ? text(0,3) === 'ID3' || bytes.length > 3 && bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2
    : ext === '.ogg' ? bytes.length >= 27 && text(0,4) === 'OggS' && bytes[4] === 0
    : ext === '.webm' ? bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) && bytes.includes(Buffer.from('webm'))
    : bytes.length >= 16 && text(4,8) === 'ftyp' && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length;
  if (!valid) throw new Error('Media contents do not match the supported file format');
}

// Bytes live outside state.json and provider history; only published chat references can read them.
export function createMediaStore({ dataDir, findReference }) {
  const directory = path.join(dataDir, 'chat-media');
  const unpublished = new Map();
  const ownerKey = chatId => createHash('sha256').update(chatId).digest('hex');
  async function filePath(chatId,id) {
    if (typeof chatId !== 'string' || !chatId.length || chatId.length > 256) throw new Error('Invalid media owner');
    validate(id, mediaIdSchema);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (await fs.realpath(directory) !== path.resolve(directory)) throw new Error('Invalid chat media storage');
    const owner = path.join(directory,ownerKey(chatId));
    await fs.mkdir(owner,{recursive:true,mode:0o700});
    if (await fs.realpath(owner) !== owner) throw new Error('Invalid chat media storage');
    return path.join(owner, id + '.bin');
  }
  return {
    async publish({ chatId, file, name, signal }) {
      signal?.throwIfAborted();
      const ext = path.extname(name).toLowerCase(), format = mediaFormats[ext];
      if (!format) throw new Error('Choose a WAV, MP3, M4A, Ogg audio, MP4, or WebM file');
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > mediaBytesLimit) throw new Error('Media must be a nonempty file up to 512 MiB');
      const head = Buffer.alloc(Math.min(65536, stat.size));
      const { bytesRead } = await file.read(head, 0, head.length, 0);
      checkSignature(head.subarray(0,bytesRead), ext);
      name = path.basename(name).replace(/[\\/:\x00-\x1f\x7f]/g, '_');
      if (name.length > 180) name = name.slice(0,180-ext.length) + ext;
      const media = validateMediaRef({ id: randomUUID(), kind: format[0], mimeType: format[1], bytes: stat.size, name });
      const target = await filePath(chatId,media.id), temporary = target + '.tmp';
      let output, complete = false, renamed = false;
      try {
        output = await fs.open(temporary,'wx',0o600);
        const buffer = Buffer.alloc(Math.min(mediaChunkLimit,stat.size));
        for (let offset = 0; offset < stat.size;) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);
          if (!bytesRead) throw new Error('Media changed while being saved. Try again.');
          await output.writeFile(buffer.subarray(0,bytesRead)); offset += bytesRead;
        }
        const after = await file.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Media changed while being saved. Try again.');
        signal?.throwIfAborted();
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
      const target = await filePath(chatId,mediaId);
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
        if (!published) await fs.rm(await filePath(chatId,id),{force:true});
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
          const match = /^([0-9a-f-]{36})\.bin(\.tmp)?$/.exec(name);
          if (!match || !new RegExp(uuid).test(match[1])) continue;
          let keep = false;
          if (!remove && !match[2] && known.has(owner)) { try { keep = !!findReference(known.get(owner),match[1]); } catch { /* Interrupted or deleted chat output. */ } }
          if (!keep) await fs.rm(path.join(folder,name),{force:true});
        }
        try { await fs.rmdir(folder); } catch(error) { if(error.code!=='ENOTEMPTY' && error.code!=='EEXIST') throw error; }
      }
    },
  };
}
