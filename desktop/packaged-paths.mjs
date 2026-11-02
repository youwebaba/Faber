import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// One cosmetic same-version repair, limited to exact original b1.1 bytes (Git LF and shipped CRLF where applicable).
const originalBranding = {
  'renderer/assets/faber-symbol.svg': [],
  'renderer/assets/faber-wordmark.svg': [],
  'renderer/assets/faber-symbol.png': ['c7ac6d95b5509ec1dfaa05ea563f490caa91e8f74f3cf9bc6bfd19bfe24d1298'],
  'renderer/assets/faber-wordmark.png': ['d47cef450ce2e2faffae9f0688ab5c6e2316cd67f5df146e460c419a22c62f97'],
  'renderer/faber.css': ['e0841789696e05878454c91fb6f62c43dc8521b22e84a722c529ddf380b35eef'],
  'renderer/app.mjs': ['18a8dbc1faebb5cec4311c806adce6cab9b0475a99d7d60bcf53736268ac479b', '82688b2d1722ab6ebb99d8f8ba913c89595f23fe2f44dbe9715ab1d3c4ff8774'],
  'renderer/index.html': ['3f80fe73a6871ff49254e316d9c4b83b0afbfeadf2e09aa1e630f640518be533', '6108017ab6e0d9262340c9eed0402fbde17026f6d5973feb278f25159fc3f263'],
  'build/faber.ico': ['f5669d51a0a664a8e86041d77d237c426880fffef68a7e06050e7abc56eb957e'],
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function noBrandingLinks(filename) {
  for (let current = path.resolve(filename);;) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Path contains a link or junction'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
async function brandingBytes(filename) {
  await noBrandingLinks(filename);
  try { return await fs.readFile(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function replaceBranding(filename, bytes, expected) {
  await noBrandingLinks(filename); await fs.mkdir(path.dirname(filename), { recursive: true }); await noBrandingLinks(filename);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    const current = await brandingBytes(filename);
    if ((current === null ? null : digest(current)) !== expected) throw new Error('File changed during branding refresh; preserved');
    if (expected === null) await fs.link(temporary, filename); // No-replace publication protects a concurrently created custom SVG.
    else await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function refreshB11Branding(bundledSource, sourceDir) {
  const backupRoot = path.join(sourceDir, '.faber-branding-backup'), files = [];
  for (const [relative, allowed] of Object.entries(originalBranding)) {
    const record = { path: relative };
    try {
      const incoming = await brandingBytes(path.join(bundledSource, relative));
      if (incoming === null) continue;
      record.incomingHash = digest(incoming);
      const filename = path.join(sourceDir, relative), current = await brandingBytes(filename), currentHash = current === null ? null : digest(current);
      if (currentHash === record.incomingHash) { files.push({ ...record, status: 'current' }); continue; }
      if (allowed.length ? !allowed.includes(currentHash) : current !== null) throw new Error('Custom or missing existing file preserved');
      if (relative === 'renderer/app.mjs' || relative === 'renderer/index.html') {
        for (const name of ['faber-symbol.svg', 'faber-wordmark.svg']) if (await brandingBytes(path.join(sourceDir, 'renderer/assets', name)) === null) throw new Error('Required SVG asset unavailable; existing markup preserved');
      }
      if (current !== null) {
        const backup = path.join(backupRoot, relative), saved = await brandingBytes(backup);
        if (saved !== null && digest(saved) !== currentHash) throw new Error('Existing backup differs; backup and current file preserved');
        if (saved === null) {
          await fs.mkdir(path.dirname(backup), { recursive: true }); await noBrandingLinks(backup);
          await fs.writeFile(backup, current, { flag: 'wx' });
        }
      }
      await replaceBranding(filename, incoming, currentHash);
      files.push({ ...record, status: 'current' });
    } catch (error) { files.push({ ...record, status: 'preserved', reason: error.message }); }
  }
  if (!files.length) return;
  const reportPath = path.join(sourceDir, '.faber-branding-refresh.json');
  const report = Buffer.from(JSON.stringify({ version: '1.1.0-beta.1', backupDirectory: '.faber-branding-backup', files }, null, 2));
  try { const prior = await brandingBytes(reportPath); if (!prior?.equals(report)) await replaceBranding(reportPath, report, prior === null ? null : digest(prior)); }
  catch (error) { console.warn(`Branding refresh report could not be written: ${error.message}`); }
}

export const sourceFolders = ['core', 'desktop', 'renderer', 'tools', 'extensions', 'model-hub', 'local-models', 'test', 'build', 'scripts', 'bundled-addons'];
export async function prepareWorkbench({ bundledSource, workbenchRoot, version }) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid packaged source version');
  const sourceDir = path.join(workbenchRoot, version), marker = path.join(sourceDir, '.faber-workbench.json');
  try { const saved = JSON.parse(await fs.readFile(marker, 'utf8')); if (saved.version !== version || saved.schemaVersion !== 1) throw new Error('Invalid workbench metadata'); if (version === '1.1.0-beta.1') await refreshB11Branding(bundledSource, sourceDir); return sourceDir; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await fs.lstat(sourceDir); throw new Error('Incomplete workbench already exists; preserve it and use a different profile or recovery.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(workbenchRoot, { recursive: true });
  const temporary = path.join(workbenchRoot, `.prepare-${randomUUID()}`); await fs.mkdir(temporary);
  try {
    for (const folder of sourceFolders) {
      try { await fs.cp(path.join(bundledSource, folder), path.join(temporary, folder), { recursive: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const entry of await fs.readdir(bundledSource, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.md') || ['package.json', 'package-lock.json'].includes(entry.name))) await fs.copyFile(path.join(bundledSource, entry.name), path.join(temporary, entry.name));
    }
    await fs.writeFile(path.join(temporary, '.faber-workbench.json'), JSON.stringify({ schemaVersion: 1, version, createdAt: new Date().toISOString(), authority: 'User-approved source changes run with your account permissions.' }, null, 2));
    await fs.rename(temporary, sourceDir);
    return sourceDir;
  } catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
}

export function packagedRuntime(resourcesPath) {
  const directory = path.join(resourcesPath, 'local-runtime');
  return { executable: path.join(directory, 'llama-server.exe'), backendDirectories: [path.join(directory, 'cuda_v13'), path.join(directory, 'vulkan')] };
}
