import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validate } from '../core/registry.mjs';
import { mediaChunkLimit, mediaIdSchema, validateMediaRef, mediaNotesSchemas } from '../core/media.mjs';
import { imageBytesLimit, validateChatImages } from '../core/images.mjs';

const id = { type:'string', minLength:1, maxLength:256 }, imageId = { type:'string', minLength:1, maxLength:2048 };
const image = { type:'string', maxLength:imageBytesLimit }, text = { type:'string', maxLength:2000000 };
const object = (properties,required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const owner = {chatId:id,deviceId:id};
const schemas = {
  ...Object.fromEntries(Object.entries(mediaNotesSchemas).map(([action, schema]) => ['media.notes.' + action, { ...schema, properties: { ...schema.properties, deviceId: id } }])),
  'media.save':object({...owner,mediaId:mediaIdSchema,imageId,image},['chatId']),
  'media.release':object(owner,['chatId']),
  'clipboard.copyImage':object({...owner,imageId,image},[]),
  'clipboard.copyText':object({text}),
};
export const mediaMethods = Object.keys(schemas);

export function mediaRange(value, size) {
  if (!value) return {start:0,end:size-1,status:200};
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) throw new Error('Invalid media range');
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last)) throw new Error('Invalid media range');
  const start = first === null ? Math.max(0,size-last) : first;
  const end = first === null || last === null ? size-1 : Math.min(last,size-1);
  if (start >= size || end < start || first === null && last === 0) throw new Error('Invalid media range');
  return {start,end,status:206};
}

export function createChatMedia({ readMedia, readImage, mediaNotes, remoteRequest, chooseSave, copyImage, copyText, protectedPaths = [] }) {
  const operations = new Set(); let closed = false;
  function operation(owner,signal) {
    if (closed) throw new Error('Chat media is closed');
    const row = {...owner,controller:new AbortController()}; operations.add(row);
    row.signal = signal ? AbortSignal.any([signal,row.controller.signal]) : row.controller.signal;
    row.done = () => operations.delete(row);
    return row;
  }
  async function chunk(owner, mediaId, offset, length, signal, expected) {
    signal.throwIfAborted();
    const params = {chatId:owner.chatId,mediaId,offset,length};
    const result = owner.deviceId ? await remoteRequest(owner.deviceId,'chat.media',params,signal) : await readMedia(params,signal);
    signal.throwIfAborted(); validateMediaRef(result?.media);
    if (result.media.id !== mediaId || result.offset !== offset || expected && JSON.stringify(result.media) !== JSON.stringify(expected) || typeof result.data !== 'string' || result.data.length > Math.ceil(mediaChunkLimit/3)*4) throw new Error('Invalid media response');
    const bytes = Buffer.from(result.data,'base64');
    if (bytes.toString('base64') !== result.data || bytes.length !== Math.min(length,result.media.bytes-offset) || offset > result.media.bytes) throw new Error('Invalid media response');
    return {media:result.media,bytes};
  }
  async function imageBytes(params,signal) {
    let data = params.image;
    if (params.imageId) {
      if (!params.chatId) throw new Error('An image reference requires its owning chat');
      const result = params.deviceId ? await remoteRequest(params.deviceId,'chat.image',{chatId:params.chatId,imageId:params.imageId},signal) : await readImage({chatId:params.chatId,imageId:params.imageId},signal);
      signal.throwIfAborted();
      if (result?.imageId !== params.imageId) throw new Error('Invalid image response');
      data = result.image;
    }
    validateChatImages([data]);
    const mimeType = data.slice(5,data.indexOf(';')), ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
    return {data,bytes:Buffer.from(data.slice(data.indexOf(',')+1),'base64'),name:'image'+ext,mimeType};
  }
  async function save(owner, media, read, signal) {
    const selected = await chooseSave({name:media.name,mimeType:media.mimeType});
    signal.throwIfAborted(); if (!selected) return {canceled:true};
    if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.includes('\0') || /[:\\/]/.test(path.basename(selected)) || path.extname(selected).toLowerCase() !== path.extname(media.name).toLowerCase()) throw new Error('Choose a destination with the media file extension');
    const parent = await fs.realpath(path.dirname(selected)), destination = path.join(parent,path.basename(selected));
    for (const root of protectedPaths) {
      let base; try { base = await fs.realpath(root); } catch(error) { if (error.code === 'ENOENT') base = path.resolve(root); else throw error; }
      const relative = path.relative(base,destination);
      if (!relative || relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative)) throw new Error('Faber profile storage is protected');
    }
    const inspect = async () => { try { const stat = await fs.lstat(destination); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Choose a regular destination file'); return [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join('/'); } catch(error) { if(error.code === 'ENOENT') return null; throw error; } };
    const before = await inspect(), temporary = path.join(parent,'.'+path.basename(destination)+'.'+randomUUID()+'.tmp');
    let file;
    try {
      file = await fs.open(temporary,'wx',0o600);
      for (let offset = 0; offset < media.bytes;) {
        signal.throwIfAborted(); const bytes = await read(offset,Math.min(mediaChunkLimit,media.bytes-offset));
        signal.throwIfAborted(); if (!bytes.length) throw new Error('Media ended before saving completed');
        await file.writeFile(bytes); offset += bytes.length;
      }
      await file.sync(); await file.close(); file = null; signal.throwIfAborted();
      if (await fs.realpath(path.dirname(selected)) !== parent || await inspect() !== before) throw new Error('Destination changed while saving; original file preserved');
      signal.throwIfAborted(); await fs.rename(temporary,destination); return {saved:true};
    } finally { await file?.close(); await fs.rm(temporary,{force:true}); }
  }
  return {
    async request(method,params={}) {
      if (!schemas[method]) throw new Error('Unknown chat media action'); validate(params,schemas[method]);
      if (closed) throw new Error('Chat media is closed');
      if (method === 'media.release') { for (const row of operations) if (row.chatId === params.chatId && row.deviceId === params.deviceId) row.controller.abort(); return {released:true}; }
      if (method === 'clipboard.copyText') { copyText(params.text); return {copied:true}; }
      if (['mediaId','imageId','image'].filter(key=>params[key]!==undefined).length !== 1) throw new Error('Choose exactly one displayed media reference');
      if (params.deviceId && params.image) throw new Error('Remote images require a chat-owned image reference');
      const row = operation(params);
      try {
        if (method.startsWith('media.notes.')) {
          const {deviceId,...args} = params, action = method.split('.').at(-1);
          if (deviceId) return await remoteRequest(deviceId,'chat.mediaNotes.'+action,args,row.signal);
          if (!mediaNotes) throw new Error('Document annotations unavailable');
          return await mediaNotes(action,args,row.signal);
        }
        if (params.mediaId) {
          const {media} = await chunk(params,params.mediaId,0,0,row.signal);
          return await save(params,media,async(offset,length)=>(await chunk(params,params.mediaId,offset,length,row.signal,media)).bytes,row.signal);
        }
        const value = await imageBytes(params,row.signal); row.signal.throwIfAborted();
        if (method === 'clipboard.copyImage') { copyImage(value.data); return {copied:true}; }
        return await save(params,{...value,bytes:value.bytes.length},async(offset,length)=>value.bytes.subarray(offset,offset+length),row.signal);
      } finally { row.done(); }
    },
    async protocol(request) {
      let row;
      try {
        const url = new URL(request.url), parts = url.pathname.split('/');
        if (url.protocol !== 'faber:' || url.hostname !== 'app' || url.username || url.password || url.hash || !['GET','HEAD'].includes(request.method) || parts.length !== 4 || parts[1] !== 'media' || [...url.searchParams.keys()].some(key=>key!=='deviceId') || url.searchParams.getAll('deviceId').length > 1) return new Response('Forbidden',{status:403});
        const owner = {chatId:decodeURIComponent(parts[2]),...(url.searchParams.has('deviceId')?{deviceId:url.searchParams.get('deviceId')}:{})}, mediaId = decodeURIComponent(parts[3]);
        validate(owner,object({chatId:id,deviceId:id},['chatId'])); validate(mediaId,mediaIdSchema);
        row = operation(owner,request.signal);
        const {media} = await chunk(owner,mediaId,0,0,row.signal);
        let range; try { range = mediaRange(request.headers.get('range'),media.bytes); } catch { row.done(); return new Response(null,{status:416,headers:{'Content-Range':`bytes */${media.bytes}`,'Accept-Ranges':'bytes'}}); }
        const headers = {'Content-Type':media.mimeType,'Content-Length':String(range.end-range.start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
        if (!['audio','video'].includes(media.kind)) headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
        if (range.status === 206) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${media.bytes}`;
        if (request.method === 'HEAD') { row.done(); return new Response(null,{status:range.status,headers}); }
        let offset = range.start;
        const body = new ReadableStream({
          async pull(controller) {
            try {
              row.signal.throwIfAborted();
              if (offset > range.end) { row.done(); controller.close(); return; }
              const {bytes} = await chunk(owner,mediaId,offset,Math.min(mediaChunkLimit,range.end-offset+1),row.signal,media);
              offset += bytes.length; controller.enqueue(bytes);
              if (offset > range.end) { row.done(); controller.close(); }
            } catch(error) { row.done(); controller.error(error); }
          },
          cancel() { row.controller.abort(); row.done(); },
        },{highWaterMark:0});
        return new Response(body,{status:range.status,headers});
      } catch { row?.done(); return new Response('Chat media is unavailable',{status:404,headers:{'Cache-Control':'no-store'}}); }
    },
    cancel() { for (const row of operations) row.controller.abort(); operations.clear(); },
    close() { closed = true; for (const row of operations) row.controller.abort(); operations.clear(); },
  };
}
