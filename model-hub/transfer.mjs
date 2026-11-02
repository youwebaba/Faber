import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { outputPath, noLinks } from './paths.mjs';
import { httpError } from './metadata.mjs';

export function waitFor(promise, signal, milliseconds = 60000) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Download canceled'));
    const timer = setTimeout(() => reject(new Error('Download stalled; no response for 60 seconds')), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
  });
}

function allowedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !(url.hostname === 'huggingface.co' || url.hostname.endsWith('.huggingface.co') || url.hostname === 'hf.co' || url.hostname.endsWith('.hf.co'))) throw new Error('Download redirect left the allowed HTTPS Hugging Face/CDN hosts');
  return url;
}
export async function fetchFile(url, { fetchImpl, token, signal }) {
  let current = allowedUrl(url);
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Download connection timed out')), 30000);
    let response;
    try {
      response = await fetchImpl(current.href, { redirect: 'manual', signal: AbortSignal.any([signal, controller.signal]), headers: { 'Accept-Encoding': 'identity', ...(current.origin === 'https://huggingface.co' && token ? { Authorization: `Bearer ${token}` } : {}) } });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirect === 5) throw new Error('Missing or excessive model download redirects');
      current = allowedUrl(new URL(location, current).href); continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); throw httpError(response.status); }
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') { await response.body?.cancel(); throw new Error('Unexpected compressed transfer; cannot verify advertised file size'); }
    return response;
  }
}

async function digestFile(filename, signal) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) { signal.throwIfAborted(); bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}

// shortcut: safe publication requires hard-link support; add a platform no-replace move adapter before supporting exFAT/FAT.
async function checkPublication(directory, signal) {
  const probe = path.join(directory, `.hf-publication-${randomUUID()}`);
  try {
    await noLinks(directory); signal.throwIfAborted();
    await fs.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
    signal.throwIfAborted();
    try { await fs.link(probe, `${probe}.link`); }
    catch (error) { throw new Error(`This destination cannot safely publish files without overwrite (${error.code || 'link failed'}). Choose a filesystem supporting hard links, such as NTFS.`); }
  } finally { await fs.rm(`${probe}.link`, { force: true }); await fs.rm(probe, { force: true }); }
}

export async function transferFile({ job, file, fetchImpl, token, signal, progress }) {
  const target = await outputPath(job.directory, file.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await outputPath(job.directory, file.path); signal.throwIfAborted();
  try {
    const existing = await fs.lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink() || !file.sha256) throw new Error('Existing destination cannot be verified; it will not be overwritten');
    const actual = await digestFile(target, signal);
    if ((file.size !== null && actual.bytes !== file.size) || actual.sha256 !== file.sha256) throw new Error('Existing destination differs from the selected Hub file; it will not be overwritten');
    file.bytes = actual.bytes; file.size ??= actual.bytes; file.status = 'completed'; file.reused = true; file.verifiedSha256 = actual.sha256; progress(); return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await checkPublication(path.dirname(target), signal);
  const url = `https://huggingface.co/${job.repoId}/resolve/${job.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetchFile(url, { fetchImpl, token, signal });
  const header = response.headers.get('content-length');
  const length = header !== null && /^\d+$/.test(header) && Number.isSafeInteger(Number(header)) ? Number(header) : null;
  if (file.size !== null && length !== null && file.size !== length) { await response.body?.cancel(); throw new Error('Transfer length differs from pinned file metadata'); }
  file.size ??= length;
  if (file.size === null && !file.sha256) { await response.body?.cancel(); throw new Error('File has no advertised size or SHA-256; cannot verify download'); }
  if (!response.body) throw new Error('Download returned an empty response body');
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.partial`);
  let handle, reader;
  try {
    await noLinks(path.dirname(target)); signal.throwIfAborted();
    handle = await fs.open(temporary, 'wx', 0o600);
    reader = response.body.getReader();
    const hash = createHash('sha256');
    file.status = 'downloading'; progress();
    while (true) {
      const { done, value } = await waitFor(reader.read(), signal);
      if (done) break;
      signal.throwIfAborted();
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (file.size !== null && file.bytes + chunk.length > file.size) throw new Error('Downloaded bytes exceed the advertised file size');
      let offset = 0;
      while (offset < chunk.length) { signal.throwIfAborted(); const written = await handle.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) throw new Error('Unable to write downloaded file'); offset += written.bytesWritten; }
      hash.update(chunk); file.bytes += chunk.length; progress();
    }
    if (file.size !== null && file.bytes !== file.size) throw new Error('Downloaded file size does not match pinned metadata');
    const actual = hash.digest('hex');
    if (file.sha256 && actual !== file.sha256) throw new Error('Downloaded file SHA-256 does not match pinned metadata');
    file.size ??= file.bytes;
    await handle.sync(); await handle.close(); handle = null;
    await outputPath(job.directory, file.path); signal.throwIfAborted();
    // Hard-link publication fails if a target appeared meanwhile; rename would overwrite it.
    await fs.link(temporary, target);
    file.verifiedSha256 = actual; file.status = 'completed'; progress();
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response.body.cancel().catch(() => {});
    await handle?.close(); await fs.rm(temporary, { force: true });
  }
}
