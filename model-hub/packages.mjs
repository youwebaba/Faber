import { createHash } from 'node:crypto';
import path from 'node:path';
import { validFilePath } from './paths.mjs';

export const musicRoles = ['language_model', 'rvq_depth_decoder', 'condition_encoder', 'transformer', 'vocoder'];
export const musicLabels = { language_model: 'Language model', rvq_depth_decoder: 'RVQ depth decoder', condition_encoder: 'Condition encoder', transformer: 'DiT transformer', vocoder: 'Vocoder' };
const musicEncodings = { language_model: ['Q8_0', 'Q6_K', 'Q5_K_M', 'BF16'], rvq_depth_decoder: ['Q8_0', 'BF16'], condition_encoder: ['F32'], transformer: ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'F32'], vocoder: ['F32'] };
export function musicComponent(file) {
  const match = /(?:^|\/)MiniMax-Music3-(language_model|rvq_depth_decoder|condition_encoder|transformer|vocoder)-([^/]+)\.gguf$/i.exec(file);
  return match ? { role: match[1].toLowerCase(), encoding: match[2].toUpperCase(), directory: path.posix.dirname(file) } : null;
}
const identity = value => createHash('sha256').update(value).digest('hex');
export const supportFile = file => /\.(?:json|txt|model|spm|tiktoken|jinja|jinja2|vocab|merges|npz|npy)$/i.test(file) || /(?:^|\/)(?:LICENSE|NOTICE)(?:\.[^/]*)?$/i.test(file);
const under = (file, directory) => directory === '.' || file.startsWith(`${directory}/`);
const total = files => files.every(file => Number.isSafeInteger(file?.size)) && Number.isSafeInteger(files.reduce((sum, file) => sum + file.size, 0)) ? files.reduce((sum, file) => sum + file.size, 0) : null;

// JSON documents are data only. Never import publisher code or follow a URL in a config.
export function packageCatalog(files, documents = {}, quantizations = [], estimateVram = () => null) {
  const byPath = new Map(files.map(file => [file.path, file])), packages = [], claimed = new Set();
  const addSafe = (key, weights, directory, index, reason) => {
    const parent = path.posix.dirname(directory), shared = parent === '.' ? '' : `${parent}/`;
    const supportFiles = files.filter(file => (under(file.path, directory) || !file.path.includes('/') || path.posix.dirname(file.path) === parent || ['tokenizer/', 'scheduler/', 'processor/'].some(folder => file.path.startsWith(`${shared}${folder}`))) && supportFile(file.path) && !/\.safetensors\.index\.json$/i.test(file.path));
    const config = directory === '.' ? 'config.json' : `${directory}/config.json`;
    if (!byPath.has(config)) reason ||= `Missing configuration: ${config}`;
    const selected = [...new Set([...weights, ...(index ? [index] : []), ...supportFiles.map(file => file.path)])].sort();
    for (const name of weights) { claimed.add(name); if (!byPath.has(name)) reason ||= `Missing indexed shard: ${name}`; }
    if (selected.length > 256) reason ||= 'Package exceeds the 256-file download limit';
    const caseNames = selected.map(name => name.toLowerCase());
    if (new Set(caseNames).size !== caseNames.length) reason ||= 'Case-colliding package filenames';
    const sizeBytes = reason ? null : total(selected.map(name => byPath.get(name)));
    const weightBytes = reason ? null : total(weights.map(name => byPath.get(name)));
    const configData = documents[config];
    const encoding = typeof configData?.quantization_config?.quant_method === 'string' ? configData.quantization_config.quant_method.slice(0, 80) : 'Published dtype';
    packages.push({ id: identity(`safetensors:${key}`), type: 'safetensors', label: key, encoding, files: selected, weightFiles: weights,
      sizeBytes, vram: estimateVram(weightBytes, 'All Safetensors package weights; support files excluded'), complete: !reason,
      runtime: 'Requires a compatible Safetensors runtime; download does not enable chat inference', ...(reason ? { reason } : {}) });
  };
  for (const file of files.filter(file => /\.safetensors\.index\.json$/i.test(file.path))) {
    let reason, weights = [], directory = path.posix.dirname(file.path);
    const index = documents[file.path];
    try {
      if (!index?.weight_map || typeof index.weight_map !== 'object' || Array.isArray(index.weight_map) || !Object.keys(index.weight_map).length) throw new Error('Missing or invalid weight_map');
      weights = [...new Set(Object.values(index.weight_map).map(value => {
        if (typeof value !== 'string') throw new Error('Invalid shard reference');
        validFilePath(value);
        if (!/\.safetensors$/i.test(value)) throw new Error('Index references a non-Safetensors file');
        return directory === '.' ? value : `${directory}/${value}`;
      }))].sort();
      if (weights.length > 256) throw new Error('Too many indexed shards');
    } catch (error) { reason = `Invalid Safetensors index ${file.path}: ${error.message}`; }
    addSafe(file.path, weights, directory, file.path, reason);
  }
  for (const file of files.filter(file => file.format === 'safetensors' && !claimed.has(file.path))) {
    const shard = /-\d+-of-\d+\.safetensors$/i.test(file.path);
    addSafe(file.path, [file.path], path.posix.dirname(file.path), null, shard ? 'Shard has no authoritative Safetensors index; use advanced selection only after checking publisher requirements' : undefined);
  }
  if (documents['modular_model_index.json']?._class_name === 'MiniMaxMusic3ModularPipeline') {
    const components = musicRoles.map(role => ({ role, packages: packages.filter(item => item.weightFiles?.length && item.weightFiles.every(file => file.startsWith(`${role}/`))) }));
    let reason;
    for (const component of components) if (component.packages.length !== 1 || !component.packages[0].complete) reason ||= `Missing, ambiguous or incomplete native Music3 component: ${musicLabels[component.role]}`;
    if (!byPath.has('tokenizer/tokenizer.json') || !byPath.has('scheduler/scheduler_config.json')) reason ||= 'Missing native Music3 tokenizer or scheduler support data';
    const weightFiles = components.flatMap(component => component.packages.flatMap(item => item.weightFiles));
    const selected = [...new Set([...components.flatMap(component => component.packages.flatMap(item => item.files)), 'modular_model_index.json'])].sort();
    if (selected.length > 256) reason ||= 'Package exceeds the 256-file download limit';
    const componentIds = new Set(components.flatMap(component => component.packages.map(item => item.id)));
    for (let index = packages.length - 1; index >= 0; index--) if (componentIds.has(packages[index].id)) packages.splice(index, 1);
    packages.unshift({ id: identity('safetensors:minimax-music3-native'), type: 'safetensors', pipeline: 'minimax-music3-native', label: 'MiniMax-Music3 native Safetensors pipeline', encoding: 'Native publisher weights',
      weightFiles, files: selected, sizeBytes: reason ? null : total(selected.map(name => byPath.get(name))), vram: reason ? null : estimateVram(total(weightFiles.map(name => byPath.get(name))), 'All five native Music3 component weights'), complete: !reason,
      runtime: 'Requires a compatible Diffusers Music3 runtime; the bundled music runtime uses GGUF components', ...(reason ? { reason } : {}) });
  }
  const directories = new Set(files.map(file => musicComponent(file.path)?.directory).filter(value => value !== undefined));
  for (const directory of directories) {
    const components = musicRoles.map(role => ({ role, label: musicLabels[role], variants: quantizations.filter(variant => {
      const component = musicComponent(variant.files[0]); return component?.directory === directory && component.role === role;
    }).map(variant => musicEncodings[role].includes(variant.encoding) && variant.files.length === 1 ? variant : { ...variant, complete: false, reason: 'Unsupported encoding or shard layout for the pinned minimaxmusic.cpp runtime' }) }));
    const missing = components.filter(component => !component.variants.some(variant => variant.complete)).map(component => component.label);
    packages.push({ id: identity(`minimax-music3:${directory}`), type: 'minimax-music3', label: `${directory === '.' ? '' : `${directory}/`}MiniMax-Music3 pipeline`, runtime: 'minimaxmusic.cpp',
      components, files: files.filter(file => path.posix.dirname(file.path) === directory && /(?:^|\/)(?:LICENSE|NOTICE)(?:\.[^/]*)?$/i.test(file.path)).map(file => file.path),
      complete: !missing.length, ...(missing.length ? { reason: `Missing compatible components: ${missing.join(', ')}` } : {}),
      memoryNote: 'Choose one quantization for each of five components. Whole-pipeline memory includes every component, runtime buffers and generated audio; per-component estimates do not establish GPU fit. Quantization compatibility is specific to minimaxmusic.cpp.' });
  }
  return packages;
}

export function selectPackage(packages, packageId, choices) {
  const item = packages.find(item => item.id === packageId);
  if (!item) throw new Error('Unknown package in this pinned revision');
  if (!item.complete) throw new Error(`Package is unavailable: ${item.reason}`);
  if (item.type !== 'minimax-music3') {
    if (choices !== undefined) throw new Error('Component choices apply only to a Music3 pipeline');
    return { item, files: item.files };
  }
  if (!choices || Object.keys(choices).length !== musicRoles.length || musicRoles.some(role => typeof choices[role] !== 'string')) throw new Error('Select exactly one variant for each of the five Music3 components');
  const components = {}, files = [...item.files];
  for (const component of item.components) {
    const variant = component.variants.find(variant => variant.id === choices[component.role]);
    if (!variant?.complete || variant.files.length !== 1) throw new Error(`Unavailable or incompatible Music3 component: ${component.label}`);
    components[component.role] = variant.files[0]; files.push(...variant.files);
  }
  return { item, files: [...new Set(files)], components };
}
