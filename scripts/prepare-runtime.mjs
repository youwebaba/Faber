import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.FABER_RUNTIME_SOURCE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'lib', 'ollama');
const target = path.join(root, '.runtime', 'local-runtime'), lockFile = path.join(root, 'build', 'runtime-lock.json');
const record = process.argv.includes('--record');
const digest = async file => { const hash = crypto.createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); };
const names = (await fs.readdir(source)).filter(name => /\.dll$/i.test(name) || name === 'llama-server.exe' || /LICENSE/.test(name));
for (const directory of ['cuda_v13', 'vulkan']) for (const name of await fs.readdir(path.join(source, directory))) if (/\.dll$/i.test(name)) names.push(`${directory}/${name}`);
const licenses = {
  'CUDA-13.0-EULA.html': 'https://docs.nvidia.com/cuda/archive/13.0.0/eula/index.html',
  'LLVM-18.1.8-LICENSE.txt': 'https://releases.llvm.org/18.1.8/LICENSE.TXT',
  'LIBCXX-18.1.8-LICENSE.txt': 'https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-18.1.8/libcxx/LICENSE.TXT',
  'LIBUNWIND-18.1.8-LICENSE.txt': 'https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-18.1.8/libunwind/LICENSE.TXT',
  'OPENMP-18.1.8-LICENSE.txt': 'https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-18.1.8/openmp/LICENSE.TXT',
  'WINPTHREADS-LICENSE.txt': 'https://raw.githubusercontent.com/mingw-w64/mingw-w64/v12.0.0/mingw-w64-libraries/winpthreads/COPYING',
};
await fs.mkdir(path.join(root, 'build', 'licenses'), { recursive: true });
for (const [name, url] of Object.entries(licenses)) {
  const file = path.join(root, 'build', 'licenses', name);
  try { await fs.access(file); } catch {
    if (!record) throw new Error(`Missing pinned notice ${name}; maintainer must prepare --record explicitly`);
    const response = await fetch(url); if (!response.ok) throw new Error(`License request failed ${response.status}: ${url}`); await fs.writeFile(file, await response.text());
  }
}
const files = [];
for (const name of names.sort()) {
  const from = path.join(source, name), to = path.join(target, name), stat = await fs.lstat(from);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid runtime file: ${name}`);
  const sha256 = await digest(from); files.push({ path: name, size: stat.size, sha256 });
  await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to);
}
for (const name of [...Object.keys(licenses), 'THIRD-PARTY-NOTICES.txt']) {
  const from = path.join(root, 'build', 'licenses', name), to = path.join(target, 'licenses', name), stat = await fs.stat(from);
  files.push({ path: `licenses/${name}`, size: stat.size, sha256: await digest(from) }); await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to);
}
const output = await promisify(execFile)(path.join(target, 'llama-server.exe'), ['--version'], { windowsHide: true, timeout: 15000 });
const version = `${output.stdout}${output.stderr}`.trim();
if (!version.includes('commit a37cc4610')) throw new Error('Unexpected llama-server build; review and repin before bundling');
const manifest = { schemaVersion: 1, source: 'Installed Ollama 0.40.10 Windows x64 runtime snapshot', version, cuda: '13.0 (cudart file version 6.14.11.13000)', cpu: true, backends: ['cuda_v13', 'vulkan'], licenseSources: licenses, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
if (record) await fs.writeFile(lockFile, JSON.stringify(manifest, null, 2));
else if (JSON.stringify(JSON.parse(await fs.readFile(lockFile, 'utf8'))) !== JSON.stringify(manifest)) throw new Error('Runtime differs from reviewed lock; do not build until reviewed');
await fs.writeFile(path.join(target, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directory: target, files: files.length, bytes: files.reduce((sum, item) => sum + item.size, 0), version, lockFile }));
