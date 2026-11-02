import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const sourceFolders = ['core', 'desktop', 'renderer', 'tools', 'extensions', 'model-hub', 'local-models', 'test', 'build', 'scripts'];
export async function prepareWorkbench({ bundledSource, workbenchRoot, version }) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid packaged source version');
  const sourceDir = path.join(workbenchRoot, version), marker = path.join(sourceDir, '.faber-workbench.json');
  try { const saved = JSON.parse(await fs.readFile(marker, 'utf8')); if (saved.version !== version || saved.schemaVersion !== 1) throw new Error('Invalid workbench metadata'); return sourceDir; }
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
