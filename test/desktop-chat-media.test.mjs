import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash,randomUUID } from 'node:crypto';
import { createChatMedia, mediaRange } from '../desktop/chat-media.mjs';
import { mediaChunkLimit } from '../core/media.mjs';
import { validateRequestPayload } from '../desktop/request-payload.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
const request=(url,range,method='GET')=>new Request(url,{method,headers:range?{Range:range}:{}});
async function fixture(t,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'faber-media-host-test-'));
  t.after(async()=>{assert.ok(path.basename(directory).startsWith('faber-media-host-test-'));await fs.rm(directory,{recursive:true,force:true});});
  const bytes=Buffer.alloc(mediaChunkLimit*2+17,97), media={id:randomUUID(),kind:'audio',mimeType:'audio/wav',bytes:bytes.length,name:'tone.wav'},reads=[];
  let selected=path.join(directory,'saved.wav'),text,image;
  const readMedia=async params=>{reads.push(params);assert.equal(params.chatId,'chat');assert.equal(params.mediaId,media.id);assert.ok(params.length<=mediaChunkLimit);return {media,offset:params.offset,data:bytes.subarray(params.offset,params.offset+params.length).toString('base64')};};
  const manager=createChatMedia({readMedia,remoteRequest:async(deviceId,method,params,signal)=>{assert.equal(deviceId,'device');signal.throwIfAborted();if(method==='chat.image')return {imageId:params.imageId,image:png};return readMedia(params);},readImage:async params=>({imageId:params.imageId,image:png}),
    chooseSave:async()=>selected,copyText:value=>{text=value;},copyImage:value=>{image=value;},...options});t.after(()=>manager.close());
  return {directory,bytes,media,reads,manager,url:`faber://app/media/chat/${media.id}`,select(value){selected=value;},get text(){return text;},get image(){return image;}};
}

test('chat media protocol honors full/open/suffix byte ranges, HEAD and exact headers',async t=>{
  const f=await fixture(t);
  for(const [range,start,end,status] of [[null,0,f.bytes.length-1,200],['bytes=7-20',7,20,206],['bytes=262144-',262144,f.bytes.length-1,206],['bytes=-17',f.bytes.length-17,f.bytes.length-1,206],['bytes=0-9999999',0,f.bytes.length-1,206]]) {
    const result=await f.manager.protocol(request(f.url,range));assert.equal(result.status,status);assert.equal(result.headers.get('content-type'),'audio/wav');assert.equal(Number(result.headers.get('content-length')),end-start+1);assert.equal(result.headers.get('accept-ranges'),'bytes');
    assert.equal(result.headers.get('content-range'),status===206?`bytes ${start}-${end}/${f.bytes.length}`:null);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()),f.bytes.subarray(start,end+1));
  }
  f.reads.length=0;const head=await f.manager.protocol(request(f.url,'bytes=2-10','HEAD'));assert.equal(head.status,206);assert.equal(head.body,null);assert.deepEqual(f.reads.map(row=>row.length),[0]);
  for(const range of ['bytes=5-3','bytes=-0','bytes=9999999-','bytes=1-2,4-5','bytes=0-NaN','bytes=9007199254740992-','nonsense']) {
    const result=await f.manager.protocol(request(f.url,range));assert.equal(result.status,416);assert.equal(result.headers.get('content-range'),`bytes */${f.bytes.length}`);
  }
  assert.deepEqual(mediaRange('bytes=-999',10),{start:0,end:9,status:206});
});

test('protocol is demand driven and switching/revocation cancels bounded local and remote reads',async t=>{
  const f=await fixture(t),response=await f.manager.protocol(request(f.url));assert.deepEqual(f.reads.map(row=>row.length),[0]);
  const reader=response.body.getReader();assert.equal((await reader.read()).value.length,mediaChunkLimit);assert.deepEqual(f.reads.map(row=>row.length),[0,mediaChunkLimit]);
  await f.manager.request('media.release',{chatId:'chat'});await assert.rejects(()=>reader.read(),/abort/i);
  let pendingSignal;
  const g=await fixture(t,{remoteRequest:async(_device,_method,_params,signal)=>{pendingSignal=signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Remote retrieval canceled')),{once:true}));}});
  const pending=g.manager.protocol(request(g.url+'?deviceId=device'));
  await new Promise(resolve=>setImmediate(resolve));await g.manager.request('media.release',{chatId:'chat',deviceId:'device'});
  assert.equal((await pending).status,404);assert.equal(pendingSignal.aborted,true);
  const h=await fixture(t),abort=new AbortController(),aborted=h.manager.protocol(new Request(h.url,{signal:abort.signal}));abort.abort();
  assert.equal((await aborted).status,404);
});

test('protocol rejects arbitrary paths, URLs, MIME substitutions and malformed remote payloads',async t=>{
  const f=await fixture(t);
  for(const url of [`faber://elsewhere/media/chat/${f.media.id}`,`faber://app/media/chat/${f.media.id}?path=x`,`faber://app/media/chat/${f.media.id}?deviceId=a&deviceId=b`,`faber://app/media/chat/${f.media.id}#x`,'faber://app/media/chat/file%3A%2F%2Fprivate.wav','faber://app/media/chat/..%2Fstate.json'])assert.ok((await f.manager.protocol(request(url))).status>=400);
  assert.equal((await f.manager.protocol(request(f.url,null,'POST'))).status,403);
  for(const mutate of [result=>({...result,media:{...result.media,mimeType:'text/html'}}),result=>({...result,offset:1}),result=>({...result,data:'not-base64'}),result=>({...result,media:{...result.media,bytes:2**40}})]) {
    const g=await fixture(t,{remoteRequest:async()=>mutate({media:f.media,offset:0,data:''})});
    const url=`faber://app/media/chat/${f.media.id}?deviceId=device`;assert.equal((await g.manager.protocol(request(url))).status,404);
  }
});

test('native save writes exact streamed bytes atomically; cancellation or retrieval failure preserves originals',async t=>{
  const f=await fixture(t),saved=path.join(f.directory,'saved.wav');await fs.writeFile(saved,'old');
  assert.deepEqual(await f.manager.request('media.save',{chatId:'chat',mediaId:f.media.id}),{saved:true});assert.deepEqual(await fs.readFile(saved),f.bytes);
  f.select(null);assert.deepEqual(await f.manager.request('media.save',{chatId:'chat',mediaId:f.media.id}),{canceled:true});
  const g=await fixture(t,{remoteRequest:async(_device,_method,params)=>{if(params.offset>0)throw new Error('Device revoked');return {media:f.media,offset:params.offset,data:f.bytes.subarray(0,params.length).toString('base64')};}}),old=path.join(g.directory,'saved.wav');await fs.writeFile(old,'preserved');
  await assert.rejects(()=>g.manager.request('media.save',{chatId:'chat',mediaId:f.media.id,deviceId:'device'}),/revoked/);assert.equal(await fs.readFile(old,'utf8'),'preserved');
  assert.deepEqual((await fs.readdir(g.directory)).filter(name=>name.endsWith('.tmp')),[]);
  let choose;const h=await fixture(t,{chooseSave:()=>new Promise(resolve=>{choose=resolve;})}),destination=path.join(h.directory,'original.wav');await fs.writeFile(destination,'original');
  const pending=h.manager.request('media.save',{chatId:'chat',mediaId:h.media.id});await new Promise(resolve=>setImmediate(resolve));
  await h.manager.request('media.release',{chatId:'chat'});choose(destination);await assert.rejects(()=>pending,/abort/i);assert.equal(await fs.readFile(destination,'utf8'),'original');
});

test('revisioned Save As verifies streamed content before replacing a destination',async t=>{
  const f=await fixture(t),destination=path.join(f.directory,'saved.wav');f.media.revision=createHash('sha256').update(f.bytes).digest('hex');
  await f.manager.request('media.save',{chatId:'chat',mediaId:f.media.id});assert.deepEqual(await fs.readFile(destination),f.bytes);
  await fs.writeFile(destination,'keep existing');f.bytes[0]^=1;
  await assert.rejects(f.manager.request('media.save',{chatId:'chat',mediaId:f.media.id}),/revision/);
  assert.equal(await fs.readFile(destination,'utf8'),'keep existing');assert.ok(!(await fs.readdir(f.directory)).some(name=>name.endsWith('.tmp')));
});

test('save destination comes only from native picker, rejects protected storage and concurrent replacement',async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.manager.request('media.save',{chatId:'chat',mediaId:f.media.id,path:'silent.wav'}),/unknown property/);
  f.select(path.join(f.directory,'wrong.html'));await assert.rejects(()=>f.manager.request('media.save',{chatId:'chat',mediaId:f.media.id}),/extension/);
  const g=await fixture(t,{protectedPaths:[f.directory],chooseSave:async()=>path.join(f.directory,'private.wav')});await assert.rejects(()=>g.manager.request('media.save',{chatId:'chat',mediaId:g.media.id}),/protected/);
  const destination=path.join(f.directory,'changed.wav');await fs.writeFile(destination,'original');let changed=false;
  const h=await fixture(t,{chooseSave:async()=>destination,readMedia:async params=>{if(params.length&&!changed){changed=true;await fs.writeFile(destination,'replacement');}return {media:f.media,offset:params.offset,data:f.bytes.subarray(params.offset,params.offset+params.length).toString('base64')};}});
  await assert.rejects(()=>h.manager.request('media.save',{chatId:'chat',mediaId:f.media.id}),/Destination changed/);assert.equal(await fs.readFile(destination,'utf8'),'replacement');
});

test('image/text clipboard and Save As accept only bounded displayed data or owning references',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.manager.request('clipboard.copyText',{text:'Selected text'}),{copied:true});assert.equal(f.text,'Selected text');
  await f.manager.request('clipboard.copyImage',{image:png});assert.equal(f.image,png);
  await f.manager.request('clipboard.copyImage',{chatId:'chat',deviceId:'device',imageId:'displayed'});assert.equal(f.image,png);
  f.select(path.join(f.directory,'image.png'));await f.manager.request('media.save',{chatId:'chat',image:png});assert.deepEqual(await fs.readFile(path.join(f.directory,'image.png')),Buffer.from(png.split(',')[1],'base64'));
  for(const params of [{image:'https://example.com/private.png'},{image:'data:image/svg+xml;base64,PHN2Zy8+'},{image:png,imageId:'double'},{imageId:'missing-chat'},{deviceId:'device',image:png},{image:png,path:'private.png'}])await assert.rejects(()=>f.manager.request('clipboard.copyImage',params));
  assert.doesNotThrow(()=>validateRequestPayload('clipboard.copyImage',{image:'x'.repeat(5*1024*1024)}));assert.throws(()=>validateRequestPayload('clipboard.copyImage',{image:'x'.repeat(13*1024*1024)}));
});
