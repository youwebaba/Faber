import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRuntime} from '../core/runtime.mjs';
import {mediaTools} from '../tools/media.mjs';
import {mediaReferenceTree,validateMediaRef,sourceMediaRefs,graphRevision,createMediaStore} from '../core/media.mjs';
import {mediaReferences} from '../renderer/content-media.mjs';
import {scenes} from './fixtures/scenes.mjs';
import {validAssetName,mediaGraphRevision} from '../core/media-artifacts.mjs';
import {parseInteractiveData,validateInteractiveData,diagramPositions} from '../renderer/preview/interactive-data.mjs';
import {chartFixture,mapFixture,diagramFixture,htmlFixture,scriptFixture,cssFixture,pixelFixture} from './fixtures/interactive-media.mjs';
const bytes=value=>Buffer.from(JSON.stringify(value)),input=value=>{const data=bytes(value);return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-interactive-')),options={dataDir:path.join(root,'data'),sourceDir:path.join(root,'source')},runtime=await createRuntime(options);runtime.registerTools(mediaTools());const workspace=path.join(root,'workspace');await fs.mkdir(workspace);const project=await runtime.request('project.create',{path:workspace,name:'Interactive fixtures'}),chat=await runtime.request('chat.create',{projectId:project.id});for(const [name,content]of Object.entries({'output.chart.json':bytes(chartFixture),'world.geojson':bytes(mapFixture),'flow.diagram.json':bytes(diagramFixture),'demo.html':htmlFixture,'demo.js':scriptFixture,'demo.css':cssFixture,'pixel.png':pixelFixture}))await fs.writeFile(path.join(workspace,name),content);t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});return{runtime,root,workspace,options,chat,project};}
const publish=(f,args)=>f.runtime.request('tool.run',{chatId:f.chat.id,name:'media_show',args});
test('chart and GeoJSON admission bounds numeric data and rejects undeclared network/configuration fields',()=>{
  assert.equal(parseInteractiveData(input(chartFixture),'chart').series.length,2);assert.equal(parseInteractiveData(input(mapFixture),'map').features.length,2);
  for(const value of [{...chartFixture,dataUrl:'https://preview.invalid'}, {...chartFixture,series:[{name:'Bad',points:[{x:'x',y:Infinity}]}]}])assert.throws(()=>validateInteractiveData(value,'chart'));
  const bad=structuredClone(mapFixture);bad.features[0].geometry.coordinates=[181,0];assert.throws(()=>validateInteractiveData(bad,'map'),/longitude/);bad.features[0].geometry.coordinates=[0,0];bad.features[1].geometry.coordinates[0].pop();assert.throws(()=>validateInteractiveData(bad,'map'),/closed/);assert.throws(()=>validateInteractiveData({...mapFixture,tiles:'https://preview.invalid'},'map'));
});
test('diagram descriptions have stable bounded layouts and reject missing/duplicate identifiers and partial positions',()=>{
  const positions=diagramPositions(validateInteractiveData(structuredClone(diagramFixture),'diagram'));assert.ok(positions[0].x<positions[1].x&&positions[1].x<positions[2].x);
  const cycle=structuredClone(diagramFixture);cycle.edges.push({from:'save',to:'start'});assert.deepEqual(diagramPositions(cycle),diagramPositions(cycle));
  for(const mutate of [d=>d.nodes.push(d.nodes[0]),d=>d.edges.push({from:'missing',to:'start'}),d=>d.nodes[0].x=1,d=>d.nodes[0].link='file:///secret']){const bad=structuredClone(diagramFixture);mutate(bad);assert.throws(()=>validateInteractiveData(bad,'diagram'));}
});
test('interactive sources and every declared asset are immutable owner-scoped snapshots with one canonical graph revision',async t=>{
  const f=await fixture(t),{media}=await publish(f,{path:'demo.html',assets:[{path:'demo.js'},{path:'demo.css'},{path:'pixel.png'}]});assert.equal(media.storage,'interactive');assert.equal(media.assets.length,3);assert.equal(media.graphRevision,mediaGraphRevision({...media,assets:[...media.assets].reverse()}));assert.notEqual(media.graphRevision,mediaGraphRevision({...media,assets:media.assets.map((row,index)=>index?row:{...row,media:{...row.media,revision:'a'.repeat(64)}})}));
  assert.equal(mediaReferenceTree({result:{media}}).length,4);const child=media.assets[0].media;await fs.writeFile(path.join(f.workspace,'demo.js'),'changed');assert.deepEqual(Buffer.from((await f.runtime.readMedia({chatId:f.chat.id,mediaId:child.id,length:child.bytes})).data,'base64'),scriptFixture);
  const other=await f.runtime.request('chat.create',{projectId:f.project.id});await assert.rejects(f.runtime.readMedia({chatId:other.id,mediaId:child.id,length:1}));await f.runtime.close();const restored=await createRuntime(f.options);try{assert.equal((await restored.readMedia({chatId:f.chat.id,mediaId:media.id,length:0})).media.graphRevision,media.graphRevision);}finally{await restored.close();}
});
test('interactive file suffixes survive a27 pruning, and invalid asset graphs reject with no unpublished residue',async t=>{
  const f=await fixture(t);for(const name of ['../escape.js','a/../b.js','/absolute.js','https://remote.js','a%2fb.js','index.html','wrapper.html'])assert.equal(validAssetName(name),false);assert.equal(validAssetName('assets/script.mjs'),true);
  await assert.rejects(publish(f,{path:'demo.html',assets:[{path:'demo.js',name:'../escape.js'}]}));await assert.rejects(publish(f,{path:'demo.html',assets:[{path:'demo.js',name:'same.js'},{path:'demo.css',name:'same.js'}]}));
  const {media}=await publish(f,{path:'demo.html',assets:[{path:'demo.js'}]}),folder=path.join(f.options.dataDir,'chat-media',createHash('sha256').update(f.chat.id).digest('hex')),files=await fs.readdir(folder),a27=/^([0-9a-f-]{36})(?:\.(?:preview|music))?\.bin(\.tmp|\.notes\.json(?:\.[0-9a-f-]{36}\.tmp)?)?$/;assert.equal(files.length,2);assert.ok(files.every(name=>name.endsWith('.interactive.bin')&&!a27.test(name)));assert.throws(()=>validateMediaRef({...media,graphRevision:'a'.repeat(64)}),/graph revision/);
});

test('unified HTML and scene manifests reject mixed storage, executable scene assets and wrong-family byte lookup',async t=>{
  const f=await fixture(t),scene=scenes();for(const [name,content]of [['triangle.gltf',scene.gltf],...scene.assets]){await fs.mkdir(path.dirname(path.join(f.workspace,name)),{recursive:true});await fs.writeFile(path.join(f.workspace,name),content);}
  const html=(await publish(f,{path:'demo.html',assets:[{path:'demo.js'},{path:'pixel.png'}]})).media,model=(await publish(f,{path:'triangle.gltf',assets:[...scene.assets.keys()].map(name=>({name,path:name}))})).media;
  assert.equal(graphRevision(html),mediaGraphRevision(html));assert.equal(graphRevision(model),mediaGraphRevision(model));assert.equal(mediaReferences([model])[0].storage,'scene');
  for(const [root,child]of [[html,model.assets.find(row=>row.media.mimeType==='image/png').media],[model,html.assets.find(row=>row.media.mimeType==='image/png').media]]){const mixed=structuredClone(root);mixed.assets[0].media=child;mixed.graphRevision=mediaGraphRevision(mixed);assert.throws(()=>validateMediaRef(mixed),/mixed-storage/);assert.deepEqual(sourceMediaRefs({result:{media:mixed}}),[]);assert.deepEqual(mediaReferences([mixed]),[]);}
  const scriptScene=structuredClone(model);scriptScene.assets[0].media={...html.assets[0].media,storage:'scene'};scriptScene.graphRevision=mediaGraphRevision(scriptScene);assert.throws(()=>validateMediaRef(scriptScene),/reference|storage/);assert.deepEqual(mediaReferences([scriptScene]),[]);
  for(const root of [html,model])assert.throws(()=>validateMediaRef({...root,storage:root.storage==='scene'?'interactive':'scene'}),/storage/);
  const sceneImage=model.assets.find(row=>row.media.mimeType==='image/png').media,wrongFamily={...sceneImage,storage:'interactive'},store=createMediaStore({dataDir:f.options.dataDir,findReference:()=>wrongFamily});await assert.rejects(store.read({chatId:f.chat.id,mediaId:sceneImage.id,length:1}),/ENOENT/);
  const old=await f.runtime.remoteRequest('chat.read',{chatId:f.chat.id,mediaMode:'references'}),modern=await f.runtime.remoteRequest('chat.read',{chatId:f.chat.id,mediaMode:'references',sceneMode:'references'}),refs=value=>value.runs.flatMap(run=>run.toolEvents||[]).flatMap(event=>event.mediaRefs||[]);assert.ok(refs(old).some(ref=>ref.kind==='html'));assert.ok(!refs(old).some(ref=>ref.kind==='scene'));assert.ok(refs(modern).some(ref=>ref.kind==='scene'));
  await f.runtime.close();const restored=await createRuntime(f.options);try{for(const root of [html,model])for(const ref of mediaReferenceTree({result:{media:root}})){const result=await restored.readMedia({chatId:f.chat.id,mediaId:ref.id,length:1});assert.equal(result.media.storage,root.storage);assert.equal(Buffer.from(result.data,'base64').length,1);}}finally{await restored.close();}
});
