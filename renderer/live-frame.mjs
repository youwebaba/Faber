export const liveFrameBytes=96*1024;
export function validateLiveFrame(source){
  if(typeof source!=='string'||source.length>liveFrameBytes*4/3+23||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(source))throw Error('Invalid live image.');
  const bytes=Uint8Array.from(atob(source.slice(23)),c=>c.charCodeAt(0));
  const word=offset=>bytes[offset]*256+bytes[offset+1];
  if(bytes.length<12||bytes.length>liveFrameBytes||word(0)!==0xffd8||word(bytes.length-2)!==0xffd9)throw Error('Invalid live JPEG.');
  for(let p=2;p+9<bytes.length;){
    if(bytes[p++]!==0xff)break;
    while(p<bytes.length&&bytes[p]===0xff)p++;
    const marker=bytes[p++],length=p+1<bytes.length?word(p):0;
    if(length<2||p+length>bytes.length||marker===0xda)break;
    if([0xc0,0xc1,0xc2].includes(marker)){
      if(length<8)break;
      const h=word(p+3),w=word(p+5);
      if(w>0&&h>0&&w<=1280&&h<=720)return source;
      break;
    }p+=length;
  }
  throw Error('Live JPEG dimensions exceed the sharing limit.');
}
