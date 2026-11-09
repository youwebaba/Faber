import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRuntime} from '../core/runtime.mjs';
import {mediaTools} from '../tools/media.mjs';
import {validateMediaRef,sourceMediaRefs,mediaReferenceTree,graphRevision} from '../core/media.mjs';
import {mediaReferences} from '../renderer/content-media.mjs';
import {verifySceneGraph} from '../renderer/scene-preview.mjs';
import {scenes} from './fixtures/scenes.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-scene-media-')),source=path.join(root,'source'),dataDir=path.join(root,'data');await fs.mkdir(source);const runtime=await createRuntime({sourceDir:source,dataDir});runtime.registerTools(mediaTools());const project=await runtime.request('project.create',{name:'Scenes',path:source}),chat=await runtime.request('chat.create',{projectId:project.id}),f=scenes(),files=new Map([['triangle.glb',f.glb],['triangle.gltf',f.gltf],['triangle.stl',f.stl],...f.assets]);for(const [name,bytes]of files){await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),bytes);}t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});return{runtime,root,source,dataDir,chat,files,args:{path:'triangle.gltf',assets:[...f.assets.keys()].map(name=>({name,path:name}))},publish(args){return runtime.request('tool.run',{chatId:chat.id,name:'media_show',args});}};}

test('GLB/glTF/STL snapshots retain one graph, immutable authorized assets, remote opt-in and original bytes',async t=>{
  const f=await fixture(t);for(const args of [{path:'triangle.glb'},f.args,{path:'triangle.stl'}]){const {media}=await f.publish(args);validateMediaRef(media);await verifySceneGraph(media);assert.equal(mediaReferences([media])[0].graphRevision,media.graphRevision);assert.equal(sourceMediaRefs({result:{media}}).length,1);const tree=mediaReferenceTree({result:{media}});assert.equal(tree.length,args.assets?3:1);for(const ref of tree){assert.equal(ref.storage,'scene');const bytes=Buffer.from((await f.runtime.readMedia({chatId:f.chat.id,mediaId:ref.id,length:ref.bytes})).data,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.revision);}const old=await f.runtime.remoteRequest('chat.read',{chatId:f.chat.id,mediaMode:'references'});assert.ok(old.runs.every(run=>run.toolEvents.every(event=>!event.mediaRefs?.some(ref=>ref.kind==='scene'))));const current=await f.runtime.remoteRequest('chat.read',{chatId:f.chat.id,mediaMode:'references',sceneMode:'references'});assert.deepEqual(current.runs.at(-1).toolEvents[0].mediaRefs,[media]);}
  const owners=await fs.readdir(path.join(f.dataDir,'chat-media'),{recursive:true});assert.equal(owners.filter(n=>n.endsWith('.scene.bin')).length,5);assert.ok(owners.filter(n=>n.endsWith('.scene.bin')).every(n=>!/^([0-9a-f-]{36})(?:\.(?:preview|music))?\.bin$/.test(path.basename(n))),'previous releases do not prune new storage');
});

test('scene groups reject missing, extra, unsafe and unowned assets and clean partial snapshots',async t=>{
  const f=await fixture(t);for(const args of [{path:'triangle.gltf'},{...f.args,assets:[...f.args.assets,{name:'extra.bin',path:'geometry/mesh.bin'}]},{...f.args,assets:[{name:'../x',path:'geometry/mesh.bin'}]},{...f.args,assets:[{name:'geometry/mesh.bin',path:'../outside.bin'}]},{path:'triangle.stl',assets:f.args.assets},{path:'triangle.gltf',captions:[{path:'x.vtt'}]}])await assert.rejects(f.publish(args));const owners=await fs.readdir(path.join(f.dataDir,'chat-media'),{recursive:true});assert.ok(!owners.some(n=>n.endsWith('.bin')));
  const {media}=await f.publish(f.args),other=await f.runtime.request('chat.create',{projectId:(await f.runtime.request('state.get')).projects[0].id});await assert.rejects(f.runtime.readMedia({chatId:other.id,mediaId:media.assets[0].media.id,length:1}));const changed=structuredClone(media);changed.assets[0].media.revision='0'.repeat(64);assert.throws(()=>validateMediaRef(changed),/revision/);await assert.rejects(verifySceneGraph(changed),/revision/);changed.graphRevision=graphRevision(changed);validateMediaRef(changed);changed.assets[1].name=changed.assets[0].name;changed.graphRevision=graphRevision(changed);assert.throws(()=>validateMediaRef(changed),/duplicate/);
  for(const [name]of f.files)await fs.rm(path.join(f.source,name));for(const ref of mediaReferenceTree({result:{media}}))assert.ok((await f.runtime.readMedia({chatId:f.chat.id,mediaId:ref.id,length:ref.bytes})).data);
  await f.runtime.request('chat.delete',{chatId:f.chat.id});assert.ok(!(await fs.readdir(path.join(f.dataDir,'chat-media'),{recursive:true})).some(n=>n.endsWith('.bin')));
});
