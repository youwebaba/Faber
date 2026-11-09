import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {inspectScene} from './scene-data.mjs';

const mount=document.getElementById('scene'),status=document.getElementById('status');
let cleanup=()=>{},actions={},epoch=0,token;
function send(type,extra={}){parent.postMessage({type,token,...extra},'faber://app');}
async function start(input){
  cleanup();const version=++epoch,resources=new Map(),urls=[],owned=[];
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(42,1,0.01,10000);
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.setClearColor(0x242630);
  mount.replaceChildren(renderer.domElement);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;
  const redraw=()=>{if(version===epoch){renderer.render(scene,camera);send('scene-view',{position:camera.position.toArray()});}};
  const resize=new ResizeObserver(()=>{const w=Math.max(1,mount.clientWidth),h=Math.max(1,mount.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();redraw();});resize.observe(mount);
  function dispose(model){model?.traverse(part=>{part.geometry?.dispose();for(const m of [].concat(part.material||[])){for(const v of Object.values(m))if(v?.isTexture){v.source?.data?.close?.();v.dispose();}m.dispose();}});}
  cleanup=()=>{epoch++;controls.dispose();resize.disconnect();for(const model of owned)dispose(model);for(const url of urls)URL.revokeObjectURL(url);renderer.dispose();renderer.forceContextLoss();mount.replaceChildren();actions={};};
  try{
    const bytes=new Uint8Array(input.bytes),assets=new Map(input.assets.map(a=>[a.uri,new Uint8Array(a.bytes)]));
    const checked=inspectScene(input.name,bytes,assets);
    let model;
    if(checked.format==='stl'){
      const geometry=new STLLoader().parse(bytes.buffer);geometry.computeVertexNormals();
      model=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:geometry.hasColors?0xffffff:0xd3d9e7,vertexColors:!!geometry.hasColors,side:THREE.DoubleSide,roughness:.72}));
    }else{
      const doc=checked.doc;
      function resource(data,mime,key){const url=URL.createObjectURL(new Blob([data],{type:mime}));urls.push(url);resources.set(key,url);return key;}
      doc.buffers?.forEach((buffer,i)=>{buffer.uri=resource(checked.buffers[i],'application/octet-stream','buffer-'+i+'.bin');});
      doc.images?.forEach((image,i)=>{delete image.bufferView;image.uri=resource(checked.images[i].data,checked.images[i].mime,'texture-'+i);});
      const manager=new THREE.LoadingManager();manager.setURLModifier(key=>{if(!resources.has(key))throw Error('The scene requested an unapproved resource.');return resources.get(key);});
      const gltf=await new GLTFLoader(manager).parseAsync(JSON.stringify(doc),'');model=gltf.scene;
    }
    if(version!==epoch){dispose(model);return;}
    owned.push(model);scene.add(model);
    const box=new THREE.Box3().setFromObject(model),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),extent=Math.max(size.x,size.y,size.z);
    if(!Number.isFinite(extent)||extent<=0||extent>1e12)throw Error('Geometry has invalid view bounds.');
    scene.add(new THREE.HemisphereLight(0xffffff,0x788098,2));
    const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(2,4,5);scene.add(light);
    const reset=()=>{camera.up.set(0,1,0);camera.position.copy(center).add(new THREE.Vector3(.95,.63,1.5).multiplyScalar(extent));camera.near=extent/1000;camera.far=extent*200;camera.updateProjectionMatrix();controls.target.copy(center);controls.minDistance=extent/100;controls.maxDistance=extent*30;controls.update();redraw();};
    const zoom=scale=>{camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);controls.update();redraw();};
    const rotate=angle=>{camera.position.sub(controls.target).applyAxisAngle(camera.up,angle).add(controls.target);controls.update();redraw();};
    const pan=amount=>{const delta=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0).multiplyScalar(extent*amount);camera.position.add(delta);controls.target.add(delta);controls.update();redraw();};
    controls.addEventListener('change',redraw);actions={reset,zoomIn:()=>zoom(.8),zoomOut:()=>zoom(1.25),left:()=>rotate(-.25),right:()=>rotate(.25),panLeft:()=>pan(-.12),panRight:()=>pan(.12)};
    reset();status.textContent=checked.faces.toLocaleString()+' triangles';send('scene-ready',{faces:checked.faces});
  }catch(error){if(version===epoch){cleanup();status.textContent=error.message;send('scene-error',{message:error.message});}}
}
for(const b of document.querySelectorAll('[data-action]'))b.addEventListener('click',()=>actions[b.dataset.action]?.());
window.addEventListener('message',event=>{
  if(event.source!==parent||event.origin!=='faber://app')return;
  const value=event.data;if(value?.type==='scene-open'&&!token&&typeof value.token==='string'&&value.bytes instanceof ArrayBuffer&&Array.isArray(value.assets)){token=value.token;start(value).catch(e=>{status.textContent=e.message;send('scene-error',{message:e.message});});}
  else if(value?.type==='scene-stop'&&value.token===token){cleanup();token=undefined;status.textContent='Preview stopped.';}
});
window.addEventListener('pagehide',()=>cleanup(),{once:true});
