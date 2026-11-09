import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRuntime} from '../core/runtime.mjs';
import {mediaTools} from '../tools/media.mjs';
import {sourceMediaRefs,mediaReferenceTree,validateMediaRef} from '../core/media.mjs';
import {inspectMidi,inspectWave,parseCaptions} from '../renderer/preview/timed.mjs';
import {mediaReferences} from '../renderer/content-media.mjs';
import {fetchTimedMedia} from '../renderer/timed-media.mjs';
import {previewProtocol,verifyTimedMediaAssets} from '../desktop/media-preview.mjs';
import {createChatMedia} from '../desktop/chat-media.mjs';
import {midiFixture,srtFixture,vttFixture,stemFixture,invalidTimingFixture} from './fixtures/timed-media.mjs';
const input=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-timed-media-')),options={dataDir:path.join(root,'data'),sourceDir:path.join(root,'source')},runtime=await createRuntime(options);runtime.registerTools(mediaTools());const workspace=path.join(root,'workspace');await fs.mkdir(workspace);const project=await runtime.request('project.create',{path:workspace,name:'Timed media'}),chat=await runtime.request('chat.create',{projectId:project.id});t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});for(const [name,bytes]of Object.entries({'song.mid':midiFixture(),'vocals.wav':stemFixture(),'drums.wav':stemFixture(880),'captions.srt':srtFixture,'captions.vtt':vttFixture}))await fs.writeFile(path.join(workspace,name),bytes);return{root,options,runtime,workspace,project,chat};}
const publish=(f,args)=>f.runtime.request('tool.run',{chatId:f.chat.id,name:'media_show',args});

test('MIDI boundary validates standard timing, event count and structural limits before synthesizer admission',()=>{
  assert.deepEqual(inspectMidi(input(midiFixture())),{format:0,tracks:1,division:480,events:9});
  for(const mutate of [b=>b.writeUInt16BE(2,8),b=>b.writeUInt16BE(0x8000,12),b=>b.writeUInt32BE(9999,18),b=>b.fill(0,26,29)]){const bad=midiFixture();mutate(bad);assert.throws(()=>inspectMidi(input(bad)));}
  assert.throws(()=>inspectMidi(input(midiFixture().subarray(0,-4))),/Truncated/);
});
test('SRT/VTT cues retain inert text, reject missing/reversed/invalid timing and enforce ordered segments',()=>{
  assert.equal(parseCaptions(input(srtFixture),'application/x-subrip')[1].start,2);assert.equal(parseCaptions(input(vttFixture),'text/vtt')[1].text,'Second VTT segment');
  assert.equal(parseCaptions(input(Buffer.from('WEBVTT - supplied\nKind: captions\nLanguage: en\n\n00:00.000 --> 00:01.000\nHeader metadata is supported')),'text/vtt')[0].text,'Header metadata is supported');
  for(const bytes of[invalidTimingFixture,Buffer.from('Text with no timing'),Buffer.from('1\n00:61:00,000 --> 00:62:00,000\nNo')])assert.throws(()=>parseCaptions(input(bytes),'application/x-subrip'),/tim/);
  const markup=Buffer.from('1\n00:00:00,000 --> 00:00:01,000\n<script src="https://preview.invalid">x</script>');assert.match(parseCaptions(input(markup),'application/x-subrip')[0].text,/<script/);
});
test('PCM WAV admission bounds resampled memory before decoding, rejects malformed or compressed audio',()=>{
  assert.equal(inspectWave(input(stemFixture())).samples,192000);const bad=stemFixture();bad.writeUInt16LE(7,20);assert.throws(()=>inspectWave(input(bad)),/Unsupported/);bad.writeUInt16LE(1,20);bad.writeUInt32LE(8,28);assert.throws(()=>inspectWave(input(bad)),/inconsistent/);
  const large=stemFixture();large.writeUInt32LE(6_000_000*2,40);large.writeUInt32LE(8000,24);large.writeUInt32LE(16000,28);assert.throws(()=>inspectWave(input(large.subarray(0,44)),12_000_044),/memory/);
});
test('one grouped root projects all independently owned stem/caption bytes, survives restart and original edits',async t=>{
  const f=await fixture(t),{media}=await publish(f,{title:'Supplied stems',tracks:[{path:'vocals.wav',label:'Vocals'},{path:'drums.wav',label:'Drums'}],captions:[{path:'captions.srt',label:'English'}]});
  assert.equal(sourceMediaRefs({result:{media}}).length,1);assert.equal(mediaReferenceTree({result:{media}}).length,3);assert.equal(mediaReferences([media])[0].tracks.length,2);
  const tree=mediaReferenceTree({result:{media}});for(const ref of tree){const result=await f.runtime.remoteRequest('chat.media',{chatId:f.chat.id,mediaId:ref.id,offset:0,length:ref.bytes});assert.equal(createHash('sha256').update(Buffer.from(result.data,'base64')).digest('hex'),ref.revision);}
  const remote=await f.runtime.remoteRequest('chat.read',{chatId:f.chat.id,mediaMode:'references'});assert.equal(remote.runs[0].toolEvents[0].mediaRefs[0].captions[0].media.id,media.captions[0].media.id);
  await fs.writeFile(path.join(f.workspace,'drums.wav'),'changed');await f.runtime.close();const restored=await createRuntime(f.options);try{assert.deepEqual(Buffer.from((await restored.readMedia({chatId:f.chat.id,mediaId:media.tracks[1].media.id,length:media.tracks[1].media.bytes})).data,'base64'),stemFixture(880));}finally{await restored.close();}
});
test('group members cannot escape chat/project ownership and failed publications leave no orphan snapshots',async t=>{
  const f=await fixture(t);await assert.rejects(publish(f,{path:'song.mid',tracks:[{path:'vocals.wav'},{path:'drums.wav'}]}),/Choose one/);await assert.rejects(publish(f,{tracks:[{path:'vocals.wav'},{path:'missing.wav'}]}));
  const ownerFolder=path.join(f.options.dataDir,'chat-media',createHash('sha256').update(f.chat.id).digest('hex'));assert.deepEqual(await fs.readdir(ownerFolder),[]);
  const {media}=await publish(f,{path:'song.mid',captions:[{path:'captions.vtt'}]}),other=await f.runtime.request('chat.create',{projectId:f.project.id});await assert.rejects(f.runtime.readMedia({chatId:other.id,mediaId:media.captions[0].media.id,length:1}));assert.equal(mediaReferences([{...media,name:'song.midi'}]).length,1);
  const files=await fs.readdir(ownerFolder);assert.ok(files.every(name=>name.endsWith('.music.bin')));const previous=/^([0-9a-f-]{36})(?:\.preview)?\.bin(\.tmp|\.notes\.json(?:\.[0-9a-f-]{36}\.tmp)?)?$/;assert.ok(files.every(name=>!previous.test(name)));
});
test('group validation rejects forged member types and duplicate child identities',async t=>{
  const f=await fixture(t),{media}=await publish(f,{tracks:[{path:'vocals.wav'},{path:'drums.wav'}],captions:[{path:'captions.srt'}]});const duplicate=structuredClone(media);duplicate.tracks[1]=duplicate.tracks[0];assert.throws(()=>validateMediaRef(duplicate),/duplicate/);const wrong=structuredClone(media);wrong.captions[0].media=wrong.tracks[0].media;assert.throws(()=>validateMediaRef(wrong));assert.equal(mediaReferences([wrong]).length,0);
});
test('timed transfers reject incorrect bytes, metadata and cancellation before rendering',async t=>{
  const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});const bytes=Buffer.from('caption'),ref={bytes:bytes.length,mimeType:'text/vtt',revision:createHash('sha256').update(bytes).digest('hex')};globalThis.fetch=async()=>new Response(bytes,{headers:{'content-length':String(bytes.length),'content-type':ref.mimeType}});assert.deepEqual(Buffer.from(await fetchTimedMedia(ref,'faber://app/media/c/id',new AbortController().signal)),bytes);await assert.rejects(fetchTimedMedia({...ref,revision:'a'.repeat(64)},'faber://app/media/c/id',new AbortController().signal),/revision/);await assert.rejects(fetchTimedMedia(ref,'faber://app/media/c/id',AbortSignal.abort()),/abort/i);
});
test('pinned synth/bank assets have exact protocol routes and verified package rights/integrity',async()=>{
  const root=path.resolve(import.meta.dirname,'..');assert.equal((await verifyTimedMediaAssets(root)).license,'MIT');for(const relative of['midi.html','midi.mjs','timed.mjs','music/spessasynth_processor.min.js','music/FluidR3Mono_GM.sf3'])assert.equal((await previewProtocol(new Request('faber-preview://viewer/'+relative),root)).status,200);for(const relative of['music/LICENSE-fflate','music/private.sf3','music/../core/runtime.mjs','music/FluidR3Mono_GM.sf3?path=secret'])assert.notEqual((await previewProtocol(new Request('faber-preview://viewer/'+relative),root)).status,200);
});
test('remote media uses one per-device slot and queued cancellation settles without waiting for another chat',async()=>{
  let active=0,peak=0,admitted=0,release;
  const media={id:'11111111-1111-4111-8111-111111111111',kind:'audio',mimeType:'audio/wav',bytes:44,name:'sample.wav'},host=createChatMedia({chooseSave:async()=>null,remoteRequest:async(deviceId,method,params,signal)=>{active++;admitted++;peak=Math.max(peak,active);try{if(params.chatId==='first')await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return{media,offset:0,data:''};}finally{active--;}}});
  const first=host.request('media.save',{chatId:'first',deviceId:'peer',mediaId:media.id}),canceled=host.request('media.save',{chatId:'queued',deviceId:'peer',mediaId:media.id}),last=host.request('media.save',{chatId:'last',deviceId:'peer',mediaId:media.id});
  const rejection=assert.rejects(canceled,/abort|cancel/i);await new Promise(resolve=>setImmediate(resolve));assert.equal(admitted,1);await host.request('media.release',{chatId:'queued',deviceId:'peer'});await rejection;assert.equal(admitted,1);release();assert.deepEqual(await first,{canceled:true});assert.deepEqual(await last,{canceled:true});assert.equal(admitted,2);assert.equal(peak,1);host.close();
});
