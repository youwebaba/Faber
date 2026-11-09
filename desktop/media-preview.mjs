import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const previewScheme = { scheme: 'faber-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } };
export const previewCSP = "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src blob: data:; font-src blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
export async function verifyPreviewAssets(sourceDir){const root=path.join(sourceDir,'renderer/vendor/pdfjs'),manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));if(manifest.version!=='6.5.438'||manifest.license!=='Apache-2.0'||!manifest.files['build/pdf.worker.mjs']||!manifest.files.LICENSE)throw new Error('Pinned PDF.js assets are missing');for(const [file,hash]of Object.entries(manifest.files)){if(!/^(LICENSE|build\/(pdf|pdf\.worker)\.mjs|(?:cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+)$/.test(file)||createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')!==hash)throw new Error('PDF.js asset integrity did not match');}return{version:manifest.version,files:Object.keys(manifest.files).length};}
export async function previewProtocol(request, sourceDir) {
  try {
    const url = new URL(request.url), relative = url.pathname.slice(1);
    if (url.protocol !== 'faber-preview:' || url.hostname !== 'viewer' || url.username || url.password || url.search || request.method !== 'GET' || !(/^(index\.html|frame\.mjs|frame\.css|docx\.mjs)$/.test(relative) || /^pdfjs\/(?:build\/(?:pdf|pdf\.worker)\.mjs|(?:cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+)$/.test(relative))) return new Response('Forbidden',{status:403});
    const target = path.join(sourceDir, 'renderer', relative.startsWith('pdfjs/') ? 'vendor/' + relative : 'preview/' + relative);
    const mime = {'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm'}[path.extname(target)] || 'application/octet-stream';
    return new Response(await fs.readFile(target),{headers:{'Content-Type':mime,'Content-Security-Policy':previewCSP,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
  } catch { return new Response('Preview asset unavailable',{status:404}); }
}
