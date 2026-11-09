import fs from 'node:fs/promises';
import path from 'node:path';
import { localIdentity, scanNativeBinary, scanText } from './privacy-check.mjs';
import { verifySafetensorsRuntime } from '../local-models/safetensors-integrity.mjs';

// Scan the actual immutable payload, including extraResources outside app.asar.
export async function verifySafetensorsPrivacy(directory, manifest, { identity = localIdentity() } = {}) {
  await verifySafetensorsRuntime(directory, manifest);
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(directory, file.path));
    const findings = /\.(?:exe|dll)$/i.test(file.path)
      ? scanNativeBinary(bytes, { terms: identity.terms })
      : scanText(bytes.toString('utf8'), { file: file.path, terms: identity.terms });
    if (findings.length) throw new Error(`Native Safetensors payload privacy check failed: ${file.path}; ${[...new Set(findings.map(item => item.category))].join(', ')}`);
  }
  const runtimeManifest=await fs.readFile(path.join(directory,'runtime-manifest.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  if(scanText(runtimeManifest,{terms:identity.terms}).length)throw new Error('Native Safetensors payload manifest privacy check failed');
}
