import fs from 'node:fs/promises';
import path from 'node:path';

const reserved = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i;
export function validFilePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:\x00-\x1f<>"|?*]/.test(value)) throw new Error('Invalid repository file path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part) || reserved.test(part) || part.length > 255)) throw new Error('Unsafe repository file path');
  return value;
}
export function repoId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)) throw new Error('Use a Hugging Face owner/model repository ID');
  validFilePath(value); return value;
}
export function revision(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw new Error('Downloads require a pinned 40-character commit revision');
  return value.toLowerCase();
}
export const inside = (root, target) => { const relative = path.relative(root, target); return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };

export async function noLinks(target) {
  const absolute = path.resolve(target);
  let probe = absolute;
  while (true) {
    try { if ((await fs.lstat(probe)).isSymbolicLink()) throw new Error('Symlinks and junctions are not allowed in download paths'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(probe); if (parent === probe) break; probe = parent;
  }
  return absolute;
}

export async function downloadDirectory(value, { dataDir, sourceDir }) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || /^(?:\\\\|\/\/)/.test(value)) throw new Error('Choose an absolute local download directory; UNC and device paths are not supported');
  const target = await noLinks(value);
  if (target === path.parse(target).root) throw new Error('Choose a folder, not a drive root');
  for (const segment of target.slice(path.parse(target).root.length).split(path.sep)) validFilePath(segment);
  const segments = target.toLowerCase().split(/[\\/]/);
  if (segments.some(part => /^onedrive(?:\s|$)/.test(part) || ['.git', '.codex', '.ssh', 'windows', 'program files', 'program files (x86)', 'projectmemory'].includes(part))) throw new Error('Download directory is protected or synchronized; choose a private models folder');
  if (inside(sourceDir, target) || inside(target, sourceDir)) throw new Error('Download directory must be separate from application source');
  const defaultRoot = path.join(dataDir, 'models');
  if ((inside(dataDir, target) && !inside(defaultRoot, target)) || inside(target, dataDir)) throw new Error('Download directory overlaps private application state');
  let probe = target;
  while (true) {
    try { await fs.stat(path.join(probe, '.git')); throw new Error('Download directory cannot be inside a Git checkout'); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    const parent = path.dirname(probe); if (parent === probe) break; probe = parent;
  }
  try { if (!(await fs.stat(target)).isDirectory()) throw new Error('Download destination is not a directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

export async function outputPath(root, relative) {
  validFilePath(relative);
  const target = path.resolve(root, ...relative.split('/'));
  if (!inside(root, target)) throw new Error('Download path escapes destination');
  await noLinks(target); return target;
}
