import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectScene,sceneUri} from '../renderer/preview/scene-data.mjs';
import {scenes} from './fixtures/scenes.mjs';
import {sceneAsset,verifySceneAssets} from '../desktop/scene-assets.mjs';
test('GLB, glTF and STL preview admission validates dependency bytes and finite geometry',()=>{
  const f=scenes();assert.equal(inspectScene('triangle.glb',f.glb).faces,1);
  const gltf=inspectScene('triangle.gltf',f.gltf,f.assets);assert.equal(gltf.faces,1);assert.equal(gltf.images[0].mime,'image/png');
  assert.equal(inspectScene('triangle.stl',f.stl).faces,1);
  assert.throws(()=>inspectScene('triangle.gltf',f.gltf,new Map()),/Missing authorized/);
  assert.throws(()=>inspectScene('triangle.gltf',f.gltf,new Map([...f.assets,['extra.bin',new Uint8Array(1)]])),/not referenced/);
  f.stl.writeFloatLE(Infinity,96);assert.throws(()=>inspectScene('a.stl',f.stl),/Non-finite/);
  for(const invalid of ['../secret','%2e%2e/secret','https://external.invalid/a','C:\\private','//host/file','a%00','%252e%252e/secret'])assert.throws(()=>sceneUri(invalid));
  const invalid=(mutate)=>{const d=structuredClone(f.doc);mutate(d);return ()=>inspectScene('a.gltf',Buffer.from(JSON.stringify(d)),f.assets);};
  assert.throws(invalid(d=>d.accessors[0].count=200000000),/accessor/);
  assert.throws(invalid(d=>d.nodes[0].children=[0]),/cyclic/i);
  assert.throws(invalid(d=>d.extensionsRequired=['EXT_unreviewed']),/Unsupported glTF extension/);
  assert.throws(invalid(d=>d.scenes[0].nodes=[0,0]),/scene roots/);
  const invalidGeometry=new Map(f.assets),geometry=Buffer.from(invalidGeometry.get('geometry/mesh.bin'));geometry.writeFloatLE(NaN,0);invalidGeometry.set('geometry/mesh.bin',geometry);assert.throws(()=>inspectScene('a.gltf',f.gltf,invalidGeometry),/Non-finite glTF/);
  const bomb=new Map(f.assets);const png=Buffer.from(bomb.get('maps/pixel.png'));png.writeUInt32BE(60000,16);bomb.set('maps/pixel.png',png);
  assert.throws(()=>inspectScene('a.gltf',f.gltf,bomb),/texture/);
});
test('the isolated viewer serves only its three pinned browser assets and allows no external network',async()=>{
  await verifySceneAssets(process.cwd());
  const response=await sceneAsset(new Request('faber-preview://viewer/scene.html'),process.cwd());assert.equal(response.status,200);
  assert.match(response.headers.get('Content-Security-Policy'),/connect-src blob:;/);
  for(const url of ['faber-preview://viewer/scene-driver.mjs','faber-preview://viewer:80/scene.html','faber-preview://viewer/scene.html?path=other','https://other.invalid/scene.html'])assert.equal(await sceneAsset(new Request(url),process.cwd()),null);
});
