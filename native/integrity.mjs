import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
export const nativeExecutableSuffix = process.platform === 'win32' ? '.exe' : '';

export async function noNativeLinks(filename) {
  for (let current = path.resolve(filename);;) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Native runtime paths cannot contain symlinks or junctions');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function parseNativeManifest(value) {
  if (!value || value.schemaVersion !== 1 || value.protocol !== 1 ||
      !digestPattern.test(value.sha256) || !digestPattern.test(value.sourceHash) ||
      value.binary !== `bin/${value.sha256}${nativeExecutableSuffix}`) {
    throw new Error('Invalid native runtime manifest');
  }
  return value;
}

export async function nativeSourceHash(sourceDir) {
  const root = path.join(sourceDir, 'native');
  const files = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo/config.toml'];
  async function visit(relative) {
    const filename = path.join(root, relative);
    await noNativeLinks(filename);
    const stat = await fs.lstat(filename);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(filename)).sort()) await visit(`${relative}/${name}`);
    } else if (stat.isFile()) files.push(relative);
    else throw new Error('Native source must contain ordinary files');
  }
  await visit('src');
  const hash = createHash('sha256');
  for (const relative of files.sort()) {
    const filename = path.join(root, relative);
    await noNativeLinks(filename);
    hash.update(relative).update('\0').update(await fs.readFile(filename)).update('\0');
  }
  return hash.digest('hex');
}

export async function verifyNativeRuntime(sourceDir, {runtimeDir = path.join(sourceDir, 'native'), verifySource = true} = {}) {
  const manifestPath = path.join(runtimeDir, 'runtime.json');
  await noNativeLinks(manifestPath);
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = parseNativeManifest(JSON.parse(manifestBytes));
  const binaryPath = path.join(runtimeDir, manifest.binary);
  await noNativeLinks(binaryPath);
  if (!(await fs.stat(binaryPath)).isFile()) throw new Error('Native worker is not an ordinary file');
  const binaryBytes = await fs.readFile(binaryPath);
  if (sha256(binaryBytes) !== manifest.sha256) throw new Error('Native worker integrity mismatch');
  if (verifySource && await nativeSourceHash(sourceDir) !== manifest.sourceHash) {
    throw new Error('Native worker does not match its source; run npm run prepare:native or verify a staged Rust upgrade');
  }
  return {manifest, binaryPath, manifestBytes, binaryBytes};
}
