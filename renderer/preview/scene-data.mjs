export const sceneLimits={root:64*1024*1024,json:4*1024*1024,total:96*1024*1024,assets:32,vertices:1500000,texturePixels:8000000};
const decoder=new TextDecoder('utf-8',{fatal:true});
const fail=message=>{throw new Error(message);};
const integer=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
export function sceneUri(value){
  if(typeof value!=='string'||!value||value.length>250||/[\\:#?\x00-\x1f]/.test(value))fail('A 3D dependency must be a relative file name.');
  let decoded;try{decoded=decodeURIComponent(value);}catch{fail('Invalid dependency URI.');}
  if(/[\\:#?%\x00-\x1f]/.test(decoded)||decoded.split('/').some(p=>!p||p==='.'||p==='..'))fail('A 3D dependency escapes the artifact folder.');
  return decoded;
}
const view=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
function imagePixels(bytes,mime){
  const d=view(bytes);let width,height;
  if(mime==='image/png'&&bytes.length>=24&&d.getUint32(0)===0x89504e47&&d.getUint32(4)===0x0d0a1a0a&&d.getUint32(12)===0x49484452){width=d.getUint32(16);height=d.getUint32(20);}
  else if(mime==='image/jpeg'&&bytes.length>=12&&d.getUint16(0)===0xffd8){
    for(let p=2;p+9<bytes.length;){if(bytes[p++]!==255)break;while(bytes[p]===255)p++;const marker=bytes[p++],length=d.getUint16(p);if(length<2||p+length>bytes.length||marker===0xda)break;
      if([0xc0,0xc1,0xc2].includes(marker)&&length>=8){height=d.getUint16(p+3);width=d.getUint16(p+5);break;}p+=length;}
  }
  if(!width||!height||width>8192||height>8192||width*height>sceneLimits.texturePixels)fail('Invalid, unsupported or oversized 3D texture. Use bounded PNG or JPEG.');
  return width*height;
}
function readGltf(name,bytes){
  if(bytes.length>sceneLimits.root)fail('3D model exceeds 64 MiB.');
  let json=bytes,bin;
  if(name.toLowerCase().endsWith('.glb')){
    const d=view(bytes);if(bytes.length<20||d.getUint32(0,true)!==0x46546c67||d.getUint32(4,true)!==2||d.getUint32(8,true)!==bytes.length)fail('Invalid glTF binary header.');
    let cursor=12;json=null;
    while(cursor<bytes.length){
      if(cursor+8>bytes.length)fail('Truncated GLB chunk.');const size=d.getUint32(cursor,true),type=d.getUint32(cursor+4,true);cursor+=8;
      if(size%4||cursor+size>bytes.length)fail('Invalid GLB chunk size.');
      if(type===0x4e4f534a&&!json&&!bin)json=bytes.subarray(cursor,cursor+size);
      else if(type===0x004e4942&&json&&!bin)bin=bytes.subarray(cursor,cursor+size);
      else fail('Unsupported GLB chunk layout.');cursor+=size;
    }
  }
  if(!json||!json.length||json.length>sceneLimits.json)fail('glTF JSON is missing or exceeds 4 MiB.');
  const doc=JSON.parse(decoder.decode(json));
  const queue=[[doc,0]];let properties=0;
  while(queue.length){
    const [value,depth]=queue.pop();
    if(++properties>180000||depth>48)fail('glTF metadata is too complex.');
    if(typeof value==='number'&&!Number.isFinite(value))fail('Invalid glTF number.');
    if(value&&typeof value==='object')for(const key of Object.keys(value)){
      if(['__proto__','constructor','prototype'].includes(key))fail('Invalid glTF property.');
      queue.push([value[key],depth+1]);
    }
  }
  if(doc?.asset?.version!=='2.0'||doc.asset.minVersion&&doc.asset.minVersion!=='2.0')fail('This viewer supports glTF 2.0.');
  return {doc,bin};
}
const list=(doc,key,limit)=>{const value=doc[key]??[];if(!Array.isArray(value)||value.length>limit)fail('Invalid or oversized glTF '+key+' collection.');return value;};
export function inspectScene(name,bytes,assets=new Map()){
  if(!(bytes instanceof Uint8Array)||bytes.length>sceneLimits.root)fail('Invalid or oversized model file.');
  if(name.toLowerCase().endsWith('.stl')){
    if(assets.size)fail('An STL has no external dependencies.');
    const d=view(bytes);let faces;
    if(bytes.length>=84&&bytes.length===84+d.getUint32(80,true)*50){faces=d.getUint32(80,true);if(faces*3>sceneLimits.vertices)fail('STL exceeds the triangle budget.');for(let face=0;face<faces;face++)for(let n=0;n<12;n++)if(!Number.isFinite(d.getFloat32(84+face*50+n*4,true)))fail('Non-finite STL coordinate.');}
    else{
      if(bytes.length>16*1024*1024)fail('ASCII STL exceeds 16 MiB.');
      const text=decoder.decode(bytes);if(!/^\s*solid\b/i.test(text)||!/\bendsolid\b/i.test(text))fail('Invalid STL file.');
      const vertices=[...text.matchAll(/^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)\s*$/gmi)];faces=vertices.length/3;
      if(vertices.some(m=>m.slice(1,4).some(x=>!Number.isFinite(Number(x)))))fail('Non-finite STL coordinate.');
    }
    if(!faces||!Number.isInteger(faces)||faces*3>sceneLimits.vertices)fail('Invalid or oversized STL geometry.');
    return {format:'stl',faces};
  }
  const {doc,bin}=readGltf(name,bytes),used=new Set();
  const allowed=new Set(['KHR_materials_unlit','KHR_texture_transform','KHR_mesh_quantization']);
  for(const extension of [...list(doc,'extensionsUsed',32),...list(doc,'extensionsRequired',32)])if(!allowed.has(extension))fail('Unsupported glTF extension: '+extension);
  if(doc.animations?.length||doc.skins?.length)fail('This viewer supports static meshes. Animation and skinning are unsupported.');
  const sum=[...assets.values()].reduce((n,b)=>n+b.byteLength,bytes.length);
  if(assets.size>sceneLimits.assets||sum>sceneLimits.total)fail('The 3D artifact exceeds its file or byte limit.');
  function dependency(uri){
    if(typeof uri==='string'&&uri.startsWith('data:')){
      const parsed=/^data:(application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
      if(!parsed||parsed[2].length>sceneLimits.json)fail('Unsupported embedded glTF data URI.');
      return Uint8Array.from(atob(parsed[2]),c=>c.charCodeAt(0));
    }
    const key=sceneUri(uri),found=assets.get(key);if(!found)fail('Missing authorized 3D dependency: '+key);
    used.add(key);return found;
  }
  const buffers=list(doc,'buffers',32).map((b,i)=>{
    if(!integer(b.byteLength,sceneLimits.root))fail('Invalid glTF buffer size.');
    const data=b.uri!==undefined?dependency(b.uri):i===0?bin:null;
    if(!data||data.length<b.byteLength||data.length>b.byteLength+3)fail('glTF buffer length does not match its declaration.');
    return data.subarray(0,b.byteLength);
  });
  const bufferViews=list(doc,'bufferViews',8192).map(b=>{
    const data=buffers[b.buffer],offset=b.byteOffset??0;
    if(!data||!integer(offset,data.byteLength)||!integer(b.byteLength,data.byteLength-offset)||b.byteStride!==undefined&&(!integer(b.byteStride,252)||b.byteStride<4||b.byteStride%4))fail('Invalid glTF buffer view.');
    return {bytes:data.subarray(offset,offset+b.byteLength),stride:b.byteStride};
  });
  const counts={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16},widths={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};let work=0;
  const accessors=list(doc,'accessors',8192).map(a=>{
    const v=bufferViews[a.bufferView],width=widths[a.componentType],count=counts[a.type],offset=a.byteOffset??0;
    if(a.sparse||!v||!width||!count||!a.count||!integer(a.count,sceneLimits.vertices)||!integer(offset,v.bytes.length)||offset%width)fail('Invalid or unsupported sparse glTF accessor.');
    const stride=v.stride||width*count;
    if(stride<width*count||offset+(a.count-1)*stride+width*count>v.bytes.length)fail('Accessor extends beyond its authorized buffer.');
    work+=a.count*count;if(work>16000000)fail('Decoded geometry exceeds the component budget.');
    if(a.componentType===5126){const data=view(v.bytes);for(let i=0;i<a.count;i++)for(let n=0;n<count;n++)if(!Number.isFinite(data.getFloat32(offset+i*stride+n*width,true)))fail('Non-finite glTF geometry component.');}
    return a;
  });
  let pixels=0;const images=list(doc,'images',64).map(image=>{
    const data=image.uri!==undefined?dependency(image.uri):bufferViews[image.bufferView]?.bytes;
    if(!data)fail('glTF texture bytes are missing.');
    const mime=image.mimeType||(data[0]===137?'image/png':'image/jpeg');pixels+=imagePixels(data,mime);if(pixels>32000000)fail('Total texture pixels exceed the scene budget.');
    return {data,mime};
  });
  const textures=list(doc,'textures',64);for(const texture of textures)if(!images[texture.source])fail('Invalid glTF texture reference.');
  list(doc,'materials',256);
  let primitiveWork=0;
  const meshes=list(doc,'meshes',512).map(mesh=>{
    if(!Array.isArray(mesh.primitives)||!mesh.primitives.length||mesh.primitives.length>128)fail('Invalid mesh primitive count.');
    return mesh.primitives.reduce((n,p)=>{
      const a=accessors[p.attributes?.POSITION];if(!a||a.type!=='VEC3'||(p.mode??4)!==4||p.targets?.length)fail('Only static triangle meshes with positions are supported.');
      const elements=p.indices===undefined?a:accessors[p.indices];if(!elements||elements.count%3)fail('Invalid triangle indices.');
      primitiveWork+=elements.count;if(primitiveWork>sceneLimits.vertices*2)fail('Mesh primitives exceed the scene budget.');
      if(p.indices!==undefined){
        if(elements.type!=='SCALAR'||![5121,5123,5125].includes(elements.componentType))fail('Triangle indices must be unsigned integers.');
        const ref=bufferViews[elements.bufferView],d=view(ref.bytes),width=widths[elements.componentType],stride=ref.stride||width;
        for(let i=0;i<elements.count;i++){const offset=(elements.byteOffset||0)+i*stride,index=width===1?d.getUint8(offset):width===2?d.getUint16(offset,true):d.getUint32(offset,true);if(index>=a.count)fail('Triangle index exceeds the vertex count.');}
      }
      return n+elements.count;
    },0);
  });
  const nodes=list(doc,'nodes',2048),parents=new Set();let drawn=0;
  for(const node of nodes){if(node.mesh!==undefined){if(!integer(node.mesh,meshes.length-1))fail('Invalid node mesh reference.');drawn+=meshes[node.mesh];}
    for(const child of node.children||[]){if(!integer(child,nodes.length-1)||parents.has(child))fail('Invalid or duplicated scene node.');parents.add(child);}}
  const seen=new Set();function visit(i,depth){if(depth>64||seen.has(i))fail('Cyclic or overly deep glTF node tree.');seen.add(i);for(const child of nodes[i].children||[])visit(child,depth+1);}
  for(let i=0;i<nodes.length;i++)if(!parents.has(i))visit(i,0);
  if(seen.size!==nodes.length||!drawn||drawn>sceneLimits.vertices)fail('Empty, cyclic or oversized scene.');
  const scenes=list(doc,'scenes',64);if(!scenes.length||!integer(doc.scene??0,scenes.length-1))fail('Missing or invalid default scene.');
  for(const scene of scenes)if(!Array.isArray(scene.nodes)||scene.nodes.length>nodes.length||new Set(scene.nodes).size!==scene.nodes.length||scene.nodes.some(i=>!integer(i,nodes.length-1)||parents.has(i)))fail('Invalid scene roots.');
  if(used.size!==assets.size)fail('A supplied asset is not referenced by this scene.');
  return {format:'gltf',doc,buffers,images,faces:drawn/3};
}
