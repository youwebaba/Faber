import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

// Mozilla's published npm artifact; no package lifecycle scripts or runtime downloads.
const version = '6.5.438', integrity = 'vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA==';
const response = await fetch(`https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${version}.tgz`, { redirect: 'error', signal: AbortSignal.timeout(60000) });
if (!response.ok || Number(response.headers.get('content-length')) > 32 * 1024 * 1024) throw new Error('PDF.js download was unavailable or too large');
const reader=response.body.getReader(),chunks=[];let downloaded=0;
try{while(true){const item=await reader.read();if(item.done)break;downloaded+=item.value.length;if(downloaded>32*1024*1024)throw new Error('PDF.js download exceeded limit');chunks.push(item.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
const archive = Buffer.concat(chunks);
if (archive.length > 32 * 1024 * 1024 || createHash('sha512').update(archive).digest('base64') !== integrity) throw new Error('PDF.js artifact integrity did not match');
const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }), directory = path.resolve(import.meta.dirname, '../renderer/vendor/pdfjs'), files = {};
await fs.mkdir(directory, { recursive: true });
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512), name = header.toString('utf8', 0, 100).split('\0')[0], size = parseInt(header.toString('ascii', 124, 136).replace(/\0/g, '').trim() || '0', 8);
  if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid PDF.js package archive');
  const relative = name.replace(/^package\//, '');
  if ((['build/pdf.mjs', 'build/pdf.worker.mjs', 'LICENSE'].includes(relative) || /^(cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+$/.test(relative)) && [0, 48].includes(header[156])) {
    const bytes = tar.subarray(offset + 512, offset + 512 + size), file = path.join(directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
    files[relative] = createHash('sha256').update(bytes).digest('hex');
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (!files['build/pdf.mjs'] || !files['build/pdf.worker.mjs'] || !files.LICENSE) throw new Error('PDF.js package was incomplete');
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version, license: 'Apache-2.0', source: 'https://github.com/mozilla/pdf.js', integrity: `sha512-${integrity}`, files }, null, 2));
console.log(`Prepared PDF.js ${version}: ${Object.keys(files).length} verified files`);
