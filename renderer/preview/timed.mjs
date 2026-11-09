export function inspectWave(buffer,totalBytes=buffer.byteLength){
  const bytes=new Uint8Array(buffer),view=new DataView(buffer),tag=(at,text)=>text.split('').every((ch,i)=>bytes[at+i]===ch.charCodeAt(0));
  if(bytes.length<44||!tag(0,'RIFF')||!tag(8,'WAVE'))throw new Error('Grouped stems require PCM WAV files');
  let format,dataBytes;
  for(let offset=12;offset+8<=bytes.length;){const size=view.getUint32(offset+4,true),start=offset+8;if(start+size>totalBytes)throw new Error('WAV chunk exceeds the file');if(tag(offset,'fmt ')){if(size<16||start+16>bytes.length)throw new Error('Malformed WAV format');format={encoding:view.getUint16(start,true),channels:view.getUint16(start+2,true),sampleRate:view.getUint32(start+4,true),byteRate:view.getUint32(start+8,true),blockAlign:view.getUint16(start+12,true),bits:view.getUint16(start+14,true)};}if(tag(offset,'data')){dataBytes=size;break;}offset=start+size+(size%2);}
  if(!format||!dataBytes)throw new Error('WAV header is missing or exceeds 64 KiB');
  const {encoding,channels,sampleRate,byteRate,blockAlign,bits}=format;
  if(![1,3].includes(encoding)||![8,16,24,32].includes(bits)||encoding===3&&bits!==32||channels<1||channels>8||sampleRate<8000||sampleRate>192000||blockAlign!==channels*bits/8||byteRate!==sampleRate*blockAlign||dataBytes%blockAlign)throw new Error('Unsupported or inconsistent PCM WAV format');
  const duration=dataBytes/byteRate,samples=Math.ceil(duration*48000)*channels;
  if(duration>3600||samples>32_000_000)throw new Error('Stem exceeds the duration or decoded memory limit');
  return{channels,sampleRate,bits,duration,samples};
}

export function inspectMidi(buffer){
  const bytes=new Uint8Array(buffer),view=new DataView(buffer),tag=(at,text)=>text.split('').every((ch,i)=>bytes[at+i]===ch.charCodeAt(0));
  if(bytes.length<14||bytes.length>4*1024*1024||!tag(0,'MThd')||view.getUint32(4)!==6)throw new Error('Malformed or oversized standard MIDI file');
  const format=view.getUint16(8),tracks=view.getUint16(10),division=view.getUint16(12);
  if(format>1||!tracks||tracks>128||format===0&&tracks!==1||!division||division&0x8000)throw new Error('MIDI supports formats 0/1 with metrical timing and up to 128 tracks');
  let offset=14,events=0;
  for(let track=0;track<tracks;track++){
    if(offset+8>bytes.length||!tag(offset,'MTrk'))throw new Error('Missing MIDI track');const end=offset+8+view.getUint32(offset+4);offset+=8;if(end>bytes.length)throw new Error('Truncated MIDI track');let running=0,ended=false;
    const variable=()=>{let value=0;for(let i=0;i<4;i++){if(offset>=end)throw new Error('Truncated MIDI event');const next=bytes[offset++];value=value*128+(next&127);if(!(next&128))return value;}throw new Error('MIDI variable integer exceeds four bytes');};
    while(offset<end){variable();if(++events>100000)throw new Error('MIDI event limit exceeded');let status=bytes[offset];if(status&128){offset++;if(status<240)running=status;else running=0;}else{status=running;if(!status)throw new Error('Invalid MIDI running status');}
      if(status===255){if(offset>=end)throw new Error('Truncated MIDI metadata');const type=bytes[offset++],length=variable();if(offset+length>end)throw new Error('Truncated MIDI metadata');if(type===81&&(length!==3||!bytes.subarray(offset,offset+length).some(Boolean)))throw new Error('Invalid MIDI tempo');if(type===47){if(length)throw new Error('Invalid MIDI end marker');ended=true;offset=end;break;}offset+=length;}
      else if(status===240||status===247){const length=variable();if(offset+length>end)throw new Error('Truncated MIDI system message');offset+=length;}
      else if(status>=128&&status<240){const length=[192,208].includes(status&240)?1:2;if(offset+length>end||bytes.subarray(offset,offset+length).some(value=>value&128))throw new Error('Invalid MIDI channel message');offset+=length;}
      else throw new Error('Unsupported MIDI system event');
    }
    if(!ended)throw new Error('MIDI track has no end marker');
  }
  if(offset!==bytes.length)throw new Error('Unexpected data after MIDI tracks');return{format,tracks,division,events};
}

export function parseCaptions(buffer,mimeType){
  if(buffer.byteLength>1024*1024)throw new Error('Subtitle file exceeds 1 MiB');let text=new TextDecoder('utf-8',{fatal:true}).decode(buffer).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  if(mimeType==='text/vtt'){if(!/^WEBVTT(?:[ \t\n]|$)/.test(text))throw new Error('Missing WEBVTT header');const boundary=/\n[ \t]*\n/.exec(text);if(!boundary)throw new Error('WebVTT header must be followed by timed segments');text=text.slice(boundary.index+boundary[0].length);}
  const timestamp=value=>{const match=/^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);if(!match||Number(match[2])>59||Number(match[3])>59)throw new Error('Invalid subtitle timestamp');return Number(match[1]||0)*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;};
  const cues=[];
  for(const block of text.split(/\n[ \t]*\n/)){const lines=block.trim().split('\n');if(!lines[0]||/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0]))continue;const index=lines.findIndex(line=>line.includes('-->'));if(index<0)throw new Error('Subtitle segment is missing timing');const timing=/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index]);if(!timing)throw new Error('Invalid subtitle timing');const start=timestamp(timing[1]),end=timestamp(timing[2]),content=lines.slice(index+1).join('\n');if(!content||content.length>8000||end<=start||end>24*3600||cues.length&&start<cues.at(-1).start)throw new Error('Subtitle timing or text is invalid; use ordered nonempty timed segments');cues.push({start,end,text:content});if(cues.length>10000)throw new Error('Subtitle segment limit exceeded');}
  if(!cues.length)throw new Error('No timed subtitle segments found');return cues;
}
