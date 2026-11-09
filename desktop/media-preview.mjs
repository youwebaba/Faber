import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const previewScheme = { scheme: 'faber-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } };
export const previewCSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src blob: data:; font-src blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
export async function verifyPreviewAssets(sourceDir){const root=path.join(sourceDir,'renderer/vendor/pdfjs'),manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));if(manifest.version!=='6.5.438'||manifest.license!=='Apache-2.0'||!manifest.files['build/pdf.worker.mjs']||!manifest.files.LICENSE)throw new Error('Pinned PDF.js assets are missing');for(const [file,hash]of Object.entries(manifest.files)){if(!/^(LICENSE|build\/(pdf|pdf\.worker)\.mjs|(?:cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+)$/.test(file)||createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')!==hash)throw new Error('PDF.js asset integrity did not match');}return{version:manifest.version,files:Object.keys(manifest.files).length};}
export async function verifyTimedMediaAssets(sourceDir,mediaRuntime=path.join(sourceDir,'.runtime/media-runtime')){
  const root=path.join(sourceDir,'renderer/vendor/spessasynth'),manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
  if(manifest.schemaVersion!==1||manifest.sources?.map(row=>row.name+'@'+row.version).join('/')!=='spessasynth_lib@4.4.7/spessasynth_core@4.4.9/fflate@0.8.3/stb-vorbis@0.0.7'||Object.keys(manifest.files||{}).length!==10)throw new Error('Pinned MIDI synthesizer assets are missing');
  for(const [name,expected]of Object.entries(manifest.files)){if(!/^(spessasynth_(lib|core)\.js|spessasynth_processor\.min\.js|fflate\.js|stb-vorbis\.js|LICENSE-(spessasynth_lib|spessasynth_core|fflate|stb-vorbis|FluidR3Mono\.md))$/.test(name))throw new Error('Invalid synthesizer asset');const bytes=await fs.readFile(path.join(root,name));if(bytes.length!==expected.bytes||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw new Error('MIDI synthesizer asset integrity did not match');}
  const bank=await fs.readFile(path.join(mediaRuntime,'FluidR3Mono_GM.sf3'));if(bank.length!==14563174||createHash('sha256').update(bank).digest('hex')!=='cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2')throw new Error('Pinned MIDI sound bank integrity did not match');
  return{files:10,bankBytes:bank.length,synthesizer:'4.4.7',soundBank:'FluidR3Mono GM 2.312',license:'MIT'};
}
export async function previewProtocol(request, sourceDir,mediaRuntime=path.join(sourceDir,'.runtime/media-runtime')) {
  try {
    const url = new URL(request.url), relative = url.pathname.slice(1);
    const music=/^music\/(spessasynth_lib\.js|spessasynth_core\.js|spessasynth_processor\.min\.js|fflate\.js|stb-vorbis\.js|FluidR3Mono_GM\.sf3)$/.exec(relative);
    if (url.protocol !== 'faber-preview:' || url.hostname !== 'viewer' || url.username || url.password || url.search || request.method !== 'GET' || !(/^(index\.html|frame\.mjs|frame\.css|docx\.mjs|timed\.mjs|midi\.html|midi\.mjs|interactive\.html|interactive\.css|interactive\.mjs|interactive-data\.mjs)$/.test(relative) || music || /^pdfjs\/(?:build\/(?:pdf|pdf\.worker)\.mjs|(?:cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+)$/.test(relative))) return new Response('Forbidden',{status:403});
    const target = music ? music[1].endsWith('.sf3')?path.join(mediaRuntime,music[1]):path.join(sourceDir,'renderer/vendor/spessasynth',music[1]) : path.join(sourceDir, 'renderer', relative.startsWith('pdfjs/') ? 'vendor/' + relative : 'preview/' + relative);
    const mime = {'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm'}[path.extname(target)] || 'application/octet-stream',bytes=await fs.readFile(target);
    return new Response(bytes,{headers:{'Content-Type':mime,'Content-Length':String(bytes.length),'Content-Security-Policy':previewCSP,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
  } catch { return new Response('Preview asset unavailable',{status:404}); }
}
