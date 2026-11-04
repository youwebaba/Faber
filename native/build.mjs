import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {runProcess} from '../tools/process.mjs';
import {atomicWrite} from '../desktop/recovery.mjs';
import {nativeSourceHash, nativeExecutableSuffix, verifyNativeRuntime} from './integrity.mjs';

export async function buildNative({sourceDir, outputDir = path.join(sourceDir, 'native'), signal, runner = runProcess}) {
  signal?.throwIfAborted();
  const sourceHash = await nativeSourceHash(sourceDir);
  const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const userCargo = path.join(os.homedir(), '.cargo', 'bin', cargoName);
  let cargo = cargoName;
  try { if ((await fs.stat(userCargo)).isFile()) cargo = userCargo; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-native-build-'));
  const env = {...process.env};
  // Keep the pinned toolchain and bundled CRT flags consistent with the source manifest.
  for (const name of ['RUSTUP_TOOLCHAIN', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS']) delete env[name];
  let stdout = '', stderr = '';
  try {
    for (const command of ['test', 'build']) {
      let result;
      try {
        result = await runner(cargo, [command, '--locked', '--offline', '--release', '--target-dir', target], {
          cwd: path.join(sourceDir, 'native'), signal, timeout: 180000, maxOutput: 2 * 1024 * 1024, env,
        });
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('Rust compiler unavailable. Install the pinned Rust toolchain and Windows C++ build tools to verify Rust changes; existing Faber features remain usable.');
        throw error;
      }
      stdout += result.stdout; stderr += result.stderr;
      if (result.code !== 0) throw new Error(`Rust ${command} failed. No upgrade was activated.\n${result.stderr}\n${result.stdout}`);
    }
    signal?.throwIfAborted();
    if (await nativeSourceHash(sourceDir) !== sourceHash) throw new Error('Native source changed during compilation');
    const bytes = await fs.readFile(path.join(target, 'release', `faber-native${nativeExecutableSuffix}`));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = {schemaVersion: 1, protocol: 1, sourceHash, binary: `bin/${sha256}${nativeExecutableSuffix}`, sha256};
    const binaryPath = path.join(outputDir, manifest.binary);
    await fs.mkdir(path.dirname(binaryPath), {recursive: true});
    try { await fs.copyFile(path.join(target, 'release', `faber-native${nativeExecutableSuffix}`), binaryPath, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== 'EEXIST' || createHash('sha256').update(await fs.readFile(binaryPath)).digest('hex') !== sha256) throw error;
    }
    await atomicWrite(path.join(outputDir, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
    await verifyNativeRuntime(sourceDir, {runtimeDir: outputDir});
    return {manifest, stdout, stderr, code: 0};
  } finally {
    // Only the uniquely created compiler output directory is removed.
    await fs.rm(target, {recursive: true, force: true});
  }
}
