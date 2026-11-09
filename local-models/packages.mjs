import path from 'node:path';
import { createHash } from 'node:crypto';
import { packageCatalog, musicComponent, musicRoles } from '../model-hub/packages.mjs';
import { quantizationCatalog } from '../model-hub/quantizations.mjs';

export function localPackages({ root, entries, documents, downloads }) {
  let catalog = packageCatalog(entries, documents, quantizationCatalog(entries, () => null));
  for (const name of Object.keys(documents).filter(name => name.endsWith('/modular_model_index.json'))) {
    const prefix = name.slice(0, -'modular_model_index.json'.length);
    const scoped = entries.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file.path.slice(prefix.length) }));
    const data = Object.fromEntries(Object.entries(documents).filter(([name]) => name.startsWith(prefix)).map(([name, value]) => [name.slice(prefix.length), value]));
    const native = packageCatalog(scoped, data).find(item => item.pipeline === 'minimax-music3-native');
    if (!native) continue;
    native.files = native.files.map(file => prefix + file); native.weightFiles = native.weightFiles.map(file => prefix + file); native.id = createHash('sha256').update(`${prefix}:${native.id}`).digest('hex'); native.label = prefix + native.label;
    const covered = new Set(native.weightFiles);
    catalog = catalog.filter(item => !item.weightFiles?.some(file => covered.has(file))); catalog.push(native);
  }
  const byPath = new Map(entries.map(file => [file.path, file]));
  const make = (item, files, supportFiles = [], components, reason) => {
    const all = [...files, ...supportFiles].map(name => byPath.get(name)).filter(Boolean);
    reason ||= all.find(file => file.reason)?.reason;
    const complete = item.complete && !reason;
    const identity = [root, item.id, all.map(file => [file.path, file.size, file.mtimeMs])];
    const sizeBytes = all.reduce((sum, file) => sum + file.size, 0);
    return { id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), label: item.label, packageId: item.id,
      relativePath: files[0] || supportFiles[0], format: item.type, runtime: item.runtime, files, supportFiles,
      sizeBytes: Number.isSafeInteger(sizeBytes) ? sizeBytes : null, mtimeMs: all.length ? Math.max(...all.map(file => file.mtimeMs)) : 0,
      complete, available: item.type === 'minimax-music3' && complete, ...(components ? { components } : {}),
      reason: reason || item.reason || (item.type === 'safetensors' ? 'Safetensors package requires a compatible runtime; it cannot be started here' : undefined),
    };
  };
  const models = [];
  for (const item of catalog) {
    if (item.type === 'safetensors') {
      const weights = item.weightFiles.filter(name => byPath.has(name));
      if (!weights.length) continue;
      models.push(make(item, weights, item.files.filter(name => !weights.includes(name) && byPath.has(name))));
      continue;
    }
    const directory = musicComponent(item.components.flatMap(component => component.variants)[0]?.files[0] || '')?.directory;
    const choices = [];
    for (const job of downloads) {
      if (job.packageType !== 'minimax-music3' || !job.components || typeof job.directory !== 'string') continue;
      const components = {};
      for (const role of musicRoles) {
        if (typeof job.components[role] !== 'string') continue;
        const relative = path.relative(root, path.resolve(job.directory, ...job.components[role].split('/'))).split(path.sep).join('/');
        const candidate = item.components.find(component => component.role === role)?.variants.find(variant => variant.files[0] === relative);
        if (candidate?.complete) components[role] = relative;
      }
      if (musicRoles.every(role => components[role]) && !choices.some(choice => JSON.stringify(choice) === JSON.stringify(components))) choices.push(components);
    }
    if (!choices.length) {
      const components = {};
      for (const component of item.components) if (component.variants.length === 1 && component.variants[0].complete) components[component.role] = component.variants[0].files[0];
      if (musicRoles.every(role => components[role])) choices.push(components);
    }
    if (choices.length) for (const components of choices) models.push(make(item, musicRoles.map(role => components[role]), [], components));
    else {
      const files = entries.filter(file => musicComponent(file.path)?.directory === directory).map(file => file.path).sort();
      models.push(make(item, files, [], undefined, item.reason || 'Multiple Music3 component quantizations need an explicit complete package selection; choose one variant per role in Browse'));
    }
  }
  return models;
}
