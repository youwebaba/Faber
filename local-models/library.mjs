import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inside, noLinks, validFilePath } from '../model-hub/paths.mjs';
import { auxiliaryGGUF } from '../model-hub/quantizations.mjs';

const folded = value => process.platform === 'win32' ? value.toLowerCase() : value;
const relativeName = (root, file) => path.relative(root, file).split(path.sep).join('/');
const hidden = name => name.startsWith('.') || /\.partial(?:\.|$)/i.test(name);

function trackedFiles(root, downloads) {
  const tracked = new Map();
  // Jobs are appended chronologically. A completed retry supersedes an older
  // failure at the same path; a newer active/failed job blocks that path.
  for (const job of downloads) {
    if (typeof job?.directory !== 'string' || !path.isAbsolute(job.directory) || !Array.isArray(job.files)) continue;
    for (const file of job.files) {
      try { validFilePath(file.path); } catch { continue; }
      const target = path.resolve(job.directory, ...file.path.split('/'));
      if (inside(root, target)) tracked.set(folded(target), { jobStatus: job.status, fileStatus: file.status, size: file.size });
    }
  }
  return tracked;
}

async function checkedPath(root, target) {
  if (!inside(root, target)) throw new Error('Model path escapes the configured directory');
  await noLinks(target);
  const real = await fs.realpath(target);
  if (!inside(root, real)) throw new Error('Model path resolves outside the configured directory');
  return real;
}

async function ggufHeader(root, target, expected) {
  await checkedPath(root, target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    await checkedPath(root, target);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs) throw new Error('File changed during scan; refresh the model list');
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 24 || !header.subarray(0, 4).equals(Buffer.from('GGUF'))) return 'Not a complete GGUF header';
    if (![2, 3].includes(header.readUInt32LE(4))) return 'Unsupported GGUF version; expected version 2 or 3';
    return undefined;
  } finally { await handle.close(); }
}

function describe(root, group) {
  const { format, stem, split, entries } = group;
  entries.sort((a, b) => (a.index || 0) - (b.index || 0) || a.relativePath.localeCompare(b.relativePath));
  let reason = entries.find(file => file.reason)?.reason;
  if (!reason && split) {
    const total = entries[0].total;
    if (entries.some(file => !file.valid || file.total !== total || file.index < 1 || file.index > total) || total < 1) reason = 'Invalid or inconsistent original shard numbering';
    else if (new Set(entries.map(file => file.index)).size !== entries.length || entries.length !== total) reason = `Incomplete or duplicate shard set: found ${entries.length} of ${total}`;
  } else if (!reason && entries.length !== 1) reason = 'Duplicate case-colliding model filenames';
  if (!reason && format !== 'gguf') reason = 'Safetensors requires a compatible runtime or conversion to GGUF; it cannot be started here';
  const sizeBytes = entries.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (!Number.isSafeInteger(sizeBytes)) reason = 'Model file sizes exceed the supported numeric range';
  const identity = [folded(root), entries.map(file => [folded(file.relativePath), file.sizeBytes, file.mtimeMs])];
  return {
    id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    label: split ? `${stem} (${entries.length}/${entries[0].total} shards)` : entries[0].relativePath,
    relativePath: entries[0].relativePath, format, files: entries.map(file => file.relativePath),
    sizeBytes: Number.isSafeInteger(sizeBytes) ? sizeBytes : null, mtimeMs: Math.max(...entries.map(file => file.mtimeMs)),
    available: !reason, ...(reason ? { reason } : {}),
  };
}

// Metadata discovery only: no weight hashing, JSON/model code execution or load.
// Callers must rescan/revalidate the selected ID immediately before launching.
export async function scanLocalModels({ directory, downloads = [] }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') || /^(?:\\\\|\/\/)/.test(directory) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(directory))) throw new Error('Model directory must be an absolute local path; UNC/device paths are unsupported');
  if (!Array.isArray(downloads)) throw new Error('Download records must be an array');
  let root = await noLinks(directory);
  if (root === path.parse(root).root) throw new Error('Choose a model folder, not a drive root');
  const warnings = [], groups = new Map();
  try {
    root = await fs.realpath(root);
    await noLinks(root);
    if (!(await fs.lstat(root)).isDirectory()) throw new Error('Model directory is not a directory');
  } catch (error) {
    if (error.code === 'ENOENT') return { directory: root, models: [], warnings: [{ path: '.', reason: 'Model directory does not exist yet' }] };
    throw error;
  }
  const tracked = trackedFiles(root, downloads), pending = [root];
  while (pending.length) {
    const current = pending.pop();
    try { await checkedPath(root, current); } catch (error) { warnings.push({ path: relativeName(root, current), reason: error.message }); continue; }
    let children;
    try { children = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) { warnings.push({ path: relativeName(root, current) || '.', reason: `Unable to scan directory: ${error.code || error.message}` }); continue; }
    for (const child of children) {
      if (hidden(child.name)) continue;
      const target = path.join(current, child.name), relativePath = relativeName(root, target);
      if (child.isSymbolicLink()) { warnings.push({ path: relativePath, reason: 'Symlinks and junctions are not followed' }); continue; }
      try { validFilePath(relativePath); await checkedPath(root, target); }
      catch (error) { warnings.push({ path: relativePath, reason: error.message }); continue; }
      if (child.isDirectory()) { pending.push(target); continue; }
      if (!child.isFile() || auxiliaryGGUF(relativePath)) continue;
      const extension = /\.(gguf|safetensors)$/i.exec(child.name);
      if (!extension) continue;
      const format = extension[1].toLowerCase(), bare = relativePath.slice(0, -extension[0].length);
      const shard = /-(\d+)-of-(\d+)$/i.exec(bare), stem = shard ? bare.slice(0, shard.index) : bare;
      const key = `${format}:${shard ? 'shards' : 'single'}:${stem.toLowerCase()}`;
      let group = groups.get(key);
      if (!group) { group = { format, stem, split: !!shard, entries: [] }; groups.set(key, group); }
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('File changed during scan; refresh the model list');
        const track = tracked.get(folded(target));
        let reason;
        if (track && (track.jobStatus !== 'completed' || track.fileStatus !== 'completed')) reason = `Tracked download is not complete (${track.jobStatus || 'unknown'}/${track.fileStatus || 'unknown'})`;
        else if (track && Number.isSafeInteger(track.size) && track.size !== stat.size) reason = 'File size differs from its completed download record';
        if (!reason && format === 'gguf') reason = await ggufHeader(root, target, stat);
        group.entries.push({ relativePath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, reason,
          index: shard ? Number(shard[1]) : null, total: shard ? Number(shard[2]) : null,
          valid: !shard || (shard[1].length === 5 && shard[2].length === 5),
        });
      } catch (error) { warnings.push({ path: relativePath, reason: error.message }); }
    }
  }
  const models = [...groups.values()].filter(group => group.entries.length).map(group => describe(root, group)).sort((a, b) => a.label.localeCompare(b.label));
  return { directory: root, models, warnings };
}
