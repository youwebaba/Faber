import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [metadataFile, treeFile, output] = process.argv.slice(2);
if (!metadataFile || !treeFile || !output) throw new Error('Usage: node scripts/collect-safetensors-notices.mjs <cargo metadata JSON> <Windows worker cargo tree> <output directory>');
const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8')), tree = await fs.readFile(treeFile, 'utf8');
const ids = new Set(tree.split(/\r?\n/).map(line => /^([\w-]+) v([^ |]+)/.exec(line)).filter(Boolean).map(match => `${match[1]}@${match[2]}`));
const packages = metadata.packages.filter(item => item.name!=='faber-safetensors'&&ids.has(`${item.name}@${item.version}`)).sort((a,b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
assert.ok(packages.some(item => item.name === 'mistralrs' && item.version === '0.9.5' && item.source?.includes('465191d0')), 'The tree must describe the pinned native library');
const textByHash = new Map(), standard = new Map(), inventory = [];
async function addText(name, text) {
  const normalized = text.replaceAll('\r\n', '\n').trim() + '\n', hash = createHash('sha256').update(normalized).digest('hex');
  if (!textByHash.has(hash)) textByHash.set(hash, { name, text: normalized }); return hash;
}
async function standardText(id, exception = false) {
  if (!standard.has(id)) {
    const response = await fetch(`https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/json/${exception?'exceptions':'details'}/${id}.json`);
    if (!response.ok) throw new Error(`Cannot retrieve standard license ${id}: HTTP ${response.status}`);
    const data = await response.json(); assert.equal(exception?data.licenseExceptionId:data.licenseId,id); standard.set(id,await addText(`SPDX ${id} (license-list-data v3.27.0)`,exception?data.licenseExceptionText:data.licenseText));
  }
  return standard.get(id);
}
for (const item of packages) {
  assert.ok(item.license, `Missing license declaration for ${item.name}`);
  const root = path.dirname(item.manifest_path), candidates = [];
  const legalName=/^(?:LICENSE|LICENCE|COPYING|NOTICE|UNLICENSE|COPYRIGHT)(?:[-_.].*)?$/i;
  async function collect(directory,recursive){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory()&&recursive&&!['.git','target','node_modules'].includes(entry.name))await collect(path.join(directory,entry.name),true);
    else if(entry.isFile()&&legalName.test(entry.name))candidates.push(path.join(directory,entry.name));
  }}
  await collect(root,true); // Include vendored C/assembly notices, including AWS-LC.
  if(!item.source||item.source.startsWith('git+'))await collect(path.dirname(root),false);
  if (item.license_file) candidates.push(path.resolve(root,item.license_file));
  const hashes = [];
  for (const filename of new Set(candidates)) {
    const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) continue;
    assert.ok(stat.size < 2*1024*1024,'Notice exceeds the inspection limit'); hashes.push(await addText(path.basename(filename),await fs.readFile(filename,'utf8')));
  }
  const fallback = !hashes.length;
  for (const id of [...new Set(item.license.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) || [])].filter(id=>!['AND','OR','WITH'].includes(id))) hashes.push(await standardText(id,id.endsWith('-exception')));
  assert.ok(hashes.length, `No license text for ${item.name}`);
  let checksum = null;
  try { checksum = JSON.parse(await fs.readFile(path.join(root,'.cargo-checksum.json'),'utf8')).package; } catch {}
  const source = item.source?.startsWith('registry+') ? `https://crates.io/api/v1/crates/${encodeURIComponent(item.name)}/${encodeURIComponent(item.version)}/download` : item.name.startsWith('candle-') ? 'https://github.com/huggingface/candle/tree/66a8cf184a5a519671454066b1b9efd446ec9f5c' : 'https://github.com/EricLBuehler/mistral.rs/tree/465191d0b0a7e2432d327b0de06204ab3f94d3a2';
  inventory.push({ name:item.name,version:item.version,license:item.license,authors:item.authors,repository:item.repository,source,checksum,notices:[...new Set(hashes)],...(fallback?{standardLicenseFallback:true}:{}) });
}
const sections = ['Native Safetensors runtime third-party notices\n\nMistral.rs 0.9.5 Windows CPU, source commit 465191d0b0a7e2432d327b0de06204ab3f94d3a2.\nThis inventory includes normal and build dependencies for the private-stdio worker.\nUnmodified source is available at each package source URL below, including MPL-2.0-covered files.\nMicrosoft runtime terms are supplied separately.\n'];
for (const item of inventory) sections.push(`${item.name} ${item.version}\nLicense: ${item.license}\nPackage authors: ${item.authors.join('; ')}\nSource: ${item.source}\nNotices: ${item.notices.join(', ')}\n`);
for (const [hash,item] of textByHash) sections.push(`===== ${hash} · ${item.name} =====\n${item.text}`);
await fs.mkdir(output,{recursive:true});
await fs.writeFile(path.join(output,'SAFETENSORS-THIRD-PARTY-NOTICES.txt'),sections.join('\n'));
await fs.writeFile(path.join(output,'safetensors-dependencies.json'),JSON.stringify({schemaVersion:1,sourceCommit:'465191d0b0a7e2432d327b0de06204ab3f94d3a2',platform:'x86_64-pc-windows-msvc',packages:inventory},null,2)+'\n');
console.log(JSON.stringify({packages:inventory.length,noticeTexts:textByHash.size,standardFallbacks:inventory.filter(item=>item.standardLicenseFallback).map(item=>item.name)}));
