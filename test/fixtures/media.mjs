// Original synthetic media, generated in the disposable smoke workspace.
export function waveFixture(seconds = 4) {
  const rate = 16000, samples = rate * seconds, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 2048), 44 + i * 2);
  return bytes;
}

export async function webmFixture(window) {
  const base64 = await window.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'), stream = canvas.captureStream(12), parts = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 100000 });
    recorder.ondataavailable = event => parts.push(event.data);
    const stopped = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = reject; });
    let frame = 0; const draw = () => { context.fillStyle = frame++ % 2 ? '#206050' : '#302060'; context.fillRect(0, 0, 320, 180); context.fillStyle = '#fff'; context.font = '20px sans-serif'; context.fillText('Faber media fixture ' + frame, 20, 90); };
    draw(); const timer = setInterval(draw, 80); recorder.start();
    await new Promise(resolve => setTimeout(resolve, 4000)); recorder.stop(); await stopped;
    clearInterval(timer); stream.getTracks().forEach(track => track.stop());
    const data = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
    return btoa(String.fromCharCode(...data));
  })()`);
  return Buffer.from(base64, 'base64');
}
