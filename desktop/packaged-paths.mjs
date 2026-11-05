import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { verifyNativeRuntime, nativeSourceHash, nativeExecutableSuffix } from '../native/integrity.mjs';

// One cosmetic same-version repair, limited to exact original b1.1 bytes (Git LF and shipped CRLF where applicable).
const originalBranding = {
  'renderer/assets/faber-symbol.svg': [],
  'renderer/assets/faber-wordmark.svg': [],
  'renderer/assets/faber-symbol.png': ['c7ac6d95b5509ec1dfaa05ea563f490caa91e8f74f3cf9bc6bfd19bfe24d1298'],
  'renderer/assets/faber-wordmark.png': ['d47cef450ce2e2faffae9f0688ab5c6e2316cd67f5df146e460c419a22c62f97'],
  'renderer/faber.css': ['e0841789696e05878454c91fb6f62c43dc8521b22e84a722c529ddf380b35eef', '94ae9333b30617ac2718c6ce6fe0d9f8b951f0891ff6539e52015bb4a88e0a1a'],
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

// Exact stock Alpha 2.0 fingerprints; no identifying originals or backups are retained.
const originalAlphaPrivacy = {
  "files": {
    "AGENTS.md": [
      "7b63604a55f7e0c8983d5299d575e399395b0c591efd213a1e2c501c3fb6f17a",
      "806b8372650d447f263521966f22db404183f814b6151f0d485e1e78df47d38b"
    ],
    "README.md": [
      "1de2d5e94ea47517a999800e4b4528ece6a8595329e091c646a7e8e6c9029ba5",
      "668cd9efa05b3ec29da5711a095384d2a760d8998d439fd9e49f0061931ce840"
    ],
    "CONTRACT.md": [
      "e2ac0784fe40c365f93d287c92475c9f823f93e95e895996a5aea82628bbe347",
      "f211e1fbde49379e565b7bb033a6ddcdb15497914ff6f8a0d3671dae628ff865"
    ],
    "HUGGINGFACE.md": [
      "16418d06d92be61d7cdb00520dcaddffed243951f8b22df715e640d203219d45",
      "38226a102faf802f90d4a0756c51e4475ffbd6e0ffbfb7e08a6cc0630109368c"
    ],
    "REQUIREMENTS.md": [
      "017115fa4136a578bd49328f4c000578a9823d571bcb5e9d2f6232de951513ba",
      "96612fb3fb4fcb0a23ad50e5fa2c6169dcdd8552d4de3439417bef38929b63cd"
    ],
    "test/desktop-local-models-live.mjs": [
      "69e4ea6ac94fcbc501fe7415d38c46e39c94601e32bb715aca5cadbb38e63af7",
      "b5c5039c1ff7862fb72712b4952f4831c55331c86434673e0ac942bba53e4646"
    ],
    "native/build.mjs": [
      "4c804346a27964745d4689ee348b11da3f5e3ac572bb668b18dc4afffefc37d0",
      "d2a334609840c01e3e9f7dbe9c7abc8dfc9f6c7d40c15d0360df46ba1630952e"
    ],
    "desktop/packaged-paths.mjs": [
      "0139e0950f3d82e9096010b9e8ce8f25f595a652275aa34352bb1945b93569f9",
      "f138b3b278af09bc9be0978567fb1caa426c2715925f1da400e75a6c920bb764"
    ],
    "package.json": [
      "4e1cbe5390cc3d3806bc2721ee8decff835d5c2a6d60b32a0a622d6fef644ec4",
      "7e46eac6ea8511d2b2021996ce23297bc3fc740584c8107dfd6496a2bd790b53"
    ],
    "build/verify-runtime.cjs": [
      "df5c32c817f528e09f1321f52e29c0a508947a8becee0aba92260931f1cc2019",
      "ece96ae2edce4b413c7108369d057b1451c0805ff66a3e1b83b195c60004c517"
    ],
    "test/core-prompts.test.mjs": [
      "6005638ff5caeaeab8ff7bb9bd84d082d12f5c65e56363bf403acd15179c50af",
      "ed8febdf9999166fccf44a678601e5157843dc1883582e9485b38ef186c09c3f"
    ],
    "test/desktop-gateway.test.mjs": [
      "be712c140bd319778d55a9dc200decb5abf92a199858fe7742839dc6b8491b96",
      "d0f54614b1db28c007c5bb7a478838cdd9bbb12141ce9b9a83aed4f9e463ea33"
    ],
    "test/desktop-packaging.test.mjs": [
      "690fbb41ae84426ab39d02d4fdc29864206838dc641c07a3538874cf26d10447",
      "d209ad480e828f520e3d13d244c4add2ea8571d249bbc645a33549361a4916c8"
    ],
    "scripts/privacy-check.mjs": [],
    "scripts/privacy-after-pack.cjs": [],
    "test/privacy-check.test.mjs": [],
    "test/native-build.test.mjs": [],
    "INSTALLING.md": [
      "35775303ac529f80fbdad7ba115a3ee83844231c8315cb4bebd82eec45c42cc3",
      "48fbfa131bd3b39c02a8e5c9da5cd40f778f549951179491e3340ffc1deb58b4"
    ]
  },
  "runtimeHashes": [
    "5c1a160542e5f6d09bf5f787542f42da81813e89c503147179c86305249b0848",
    "17510360900f58e814bd1f7aa27f65e33264294f2c2a8d93d3b1d39ab084b695"
  ],
  "worker": "8193fbd1e650e7be341aca6ef9d383dbcdf97275ae3b219512a4ac8d3627a979",
  "sourceHash": "47ac726e89fa02ea0c905b11377a8444c64d91466b5a4089b7d7a43a171aef6f"
};

export async function refreshAlphaPrivacy(bundledSource, sourceDir, stock = originalAlphaPrivacy) {
  for (const [relative, allowed] of Object.entries(stock.files)) {
    try {
      const filename = path.join(sourceDir, relative);
      const incoming = await brandingBytes(path.join(bundledSource, relative));
      if (incoming === null) continue;
      const current = await brandingBytes(filename), currentHash = current === null ? null : digest(current);
      if (currentHash === digest(incoming)) continue;
      if (currentHash === null ? allowed.length !== 0 : !allowed.includes(currentHash)) continue;
      await replaceBranding(filename, incoming, currentHash);
    } catch { console.warn(`Stock privacy refresh preserved ${relative}`); }
  }
  try {
    const pointer = path.join(sourceDir, 'native/runtime.json'), current = await brandingBytes(pointer);
    if (current === null) return;
    const incoming = await verifyNativeRuntime(bundledSource);
    if (incoming.manifest.sourceHash !== stock.sourceHash || incoming.manifest.sha256 === stock.worker) return;
    const currentHash = digest(current), incomingHash = digest(incoming.manifestBytes);
    if (currentHash !== incomingHash && !stock.runtimeHashes.includes(currentHash)) return;
    // Source and worker verification preserve independently upgraded native code.
    if (await nativeSourceHash(sourceDir) !== stock.sourceHash) return;
    const active = await verifyNativeRuntime(sourceDir);
    if (active.manifest.sourceHash !== stock.sourceHash) return;
    if (currentHash !== incomingHash) {
      if (active.manifest.sha256 !== stock.worker) return;
      const filename = path.join(sourceDir, 'native', incoming.manifest.binary), saved = await brandingBytes(filename);
      if (saved === null) await replaceBranding(filename, incoming.binaryBytes, null);
      else if (digest(saved) !== incoming.manifest.sha256) throw new Error('Existing privacy worker differs; preserved');
      await replaceBranding(pointer, incoming.manifestBytes, currentHash);
    }
    // Remove only the known original worker after the replacement pointer verifies.
    await verifyNativeRuntime(sourceDir);
    if (digest(await brandingBytes(pointer)) !== incomingHash) return;
    const oldWorker = path.join(sourceDir, 'native/bin', `${stock.worker}${nativeExecutableSuffix}`);
    const oldBytes = await brandingBytes(oldWorker);
    if (oldBytes !== null && digest(oldBytes) === stock.worker) await fs.unlink(oldWorker);
  } catch { console.warn('Stock privacy refresh preserved the native runtime'); }
}

export const sourceFolders = ['core', 'desktop', 'renderer', 'tools', 'extensions', 'model-hub', 'local-models', 'native', 'test', 'build', 'scripts', 'bundled-addons'];
export async function prepareWorkbench({ bundledSource, workbenchRoot, version }) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid packaged source version');
  const sourceDir = path.join(workbenchRoot, version), marker = path.join(sourceDir, '.faber-workbench.json');
  try { const saved = JSON.parse(await fs.readFile(marker, 'utf8')); if (saved.version !== version || saved.schemaVersion !== 1) throw new Error('Invalid workbench metadata'); if (version === '1.1.0-beta.1') await refreshB11Branding(bundledSource, sourceDir); if (version === '2.0.2-alpha.1') await refreshAlphaPrivacy(bundledSource, sourceDir); return sourceDir; }
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
