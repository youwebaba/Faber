export function scenes(){
  const bin=new Uint8Array(60),v=new DataView(bin.buffer),positions=[-1,-1,0,1,-1,0,0,1,0],uv=[0,0,1,0,.5,1];
  [...positions,...uv].forEach((n,i)=>v.setFloat32(i*4,n,true));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');
  const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],
    buffers:[{byteLength:bin.length,uri:'geometry/mesh.bin'}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:24}],
    accessors:[{bufferView:0,componentType:5126,type:'VEC3',count:3,min:[-1,-1,0],max:[1,1,0]},{bufferView:1,componentType:5126,type:'VEC2',count:3}],
    images:[{uri:'maps/pixel.png'}],textures:[{source:0}],materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}},doubleSided:true}]};
  const plain=structuredClone(doc);delete plain.buffers[0].uri;delete plain.images;delete plain.textures;plain.materials=[{pbrMetallicRoughness:{baseColorFactor:[1,.3,.25,1]},doubleSided:true}];
  const encoded=Buffer.from(JSON.stringify(plain)),json=Buffer.alloc(Math.ceil(encoded.length/4)*4,32);encoded.copy(json);
  const glb=Buffer.alloc(28+json.length+bin.length);glb.write('glTF');glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(json.length,12);glb.write('JSON',16);json.copy(glb,20);glb.writeUInt32LE(bin.length,20+json.length);glb.write('BIN\0',24+json.length);glb.set(bin,28+json.length);
  const stl=Buffer.alloc(134);stl.writeUInt32LE(1,80);[0,0,1,...positions].forEach((n,i)=>stl.writeFloatLE(n,84+i*4));
  return {doc,gltf:Buffer.from(JSON.stringify(doc)),assets:new Map([['geometry/mesh.bin',bin],['maps/pixel.png',png]]),glb,stl};
}
