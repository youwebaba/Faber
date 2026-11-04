import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {noNativeLinks, parseNativeManifest} from './integrity.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
// Pin the binary for this backend lifetime; source upgrades activate after restart.
let pinned, startupError;
try { pinned = parseNativeManifest(JSON.parse(readFileSync(path.join(directory, 'runtime.json'), 'utf8'))); }
catch (error) { startupError = new Error(`Native model reader is unavailable. Run npm run prepare:native or reinstall Faber. ${error.message}`); }

export async function readNativeGGUF(fd, {remaining, deadline, signal}) {
  signal?.throwIfAborted();
  if (startupError) throw startupError;
  if (!Number.isInteger(fd) || fd < 0 || !Number.isSafeInteger(remaining) || remaining < 0 || !Number.isSafeInteger(deadline)) {
    throw new Error('Invalid native metadata inspection parameters');
  }
  const executable = path.join(directory, pinned.binary);
  await noNativeLinks(executable);
  if (createHash('sha256').update(await fs.readFile(executable)).digest('hex') !== pinned.sha256) throw new Error('Native worker integrity mismatch');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['gguf-metadata', String(remaining), String(deadline)], {
      windowsHide: true, stdio: [fd, 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', size = 0, failure, settled = false;
    const stop = error => { failure ||= error; child.kill(); };
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('Native metadata inspection canceled'));
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error('Native metadata inspection timed out')), 30000);
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8').on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 64 * 1024 * 1024) { stop(new Error('Native metadata response exceeds the transport limit')); return; }
        if (name === 'stdout') stdout += chunk; else stderr += chunk;
      });
    }
    child.once('error', error => { if (!settled) { settled = true; clean(); reject(error); } });
    child.once('close', code => {
      if (settled) return;
      settled = true; clean();
      if (failure) { reject(failure); return; }
      try {
        if (code !== 0) throw new Error(`Native metadata reader failed (${code}): ${stderr.slice(0, 2000)}`);
        const reply = JSON.parse(stdout);
        if (reply.protocol !== 1 || typeof reply.ok !== 'boolean') throw new Error('Invalid native metadata response');
        if (!reply.ok) throw new Error(reply.error?.message || 'Native metadata inspection failed');
        const value = reply.result;
        if (!value || !Number.isSafeInteger(value.remaining) || value.remaining < 0 || value.remaining > remaining ||
            typeof value.metadata?.complete !== 'boolean' || !Array.isArray(value.metadata.tensors) || !Array.isArray(value.metadata.warnings)) {
          throw new Error('Invalid native metadata result');
        }
        resolve(value);
      } catch (error) { reject(error); }
    });
  });
}
