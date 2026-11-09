import {waveFixture} from './media.mjs';
export function midiFixture(){const events=Buffer.from([0,255,81,3,7,161,32,0,192,0,0,144,60,100,143,0,128,60,0,0,144,64,100,143,0,128,64,0,0,144,67,100,143,0,128,67,0,0,255,47,0]),header=Buffer.alloc(22);header.write('MThd');header.writeUInt32BE(6,4);header.writeUInt16BE(0,8);header.writeUInt16BE(1,10);header.writeUInt16BE(480,12);header.write('MTrk',14);header.writeUInt32BE(events.length,18);return Buffer.concat([header,events]);}
export const srtFixture=Buffer.from('1\n00:00:00,000 --> 00:00:01,800\nFirst supplied segment\n\n2\n00:00:02,000 --> 00:00:03,800\nSecond supplied segment\n');
export const vttFixture=Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.800\nFirst VTT segment <img src="https://preview.invalid/caption">\n\n00:02.000 --> 00:03.800\nSecond VTT segment\n');
export const invalidTimingFixture=Buffer.from('1\n00:00:03,000 --> 00:00:02,000\nInvalid timing must be visible\n');
export function stemFixture(frequency=440){const bytes=waveFixture(4),rate=16000;for(let i=0;i<rate*4;i++)bytes.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*frequency/rate)*2048),44+i*2);return bytes;}
