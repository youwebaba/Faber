import { auxiliaryGGUF } from './quantizations.mjs';

const parent = value => value.replace(/\\/g, '/').split('/').slice(0, -1).join('/').toLowerCase();
// Filename matching is conservative: unrelated model stems and folders never pair.
export function visionProjector(file) {
  const parts = file.replace(/\\/g, '/').split('/'), name = parts.pop();
  return /\.gguf$/i.test(name) && (/(?:^|[_.-])(?:mmproj|projector)(?:[_.-]|$)/i.test(name) || parts.some(part => /^(?:mmproj|projectors?)$/i.test(part)));
}

export function visionModelStem(file) {
  const name = file.replace(/\\/g, '/').split('/').at(-1).replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/i, '');
  return name.replace(/(?:^|[_.-])(?:mmproj|projector)(?=[_.-]|$)/ig, '').replace(/[_.-](?:(?:I?Q|TQ|MXFP)\d[\w]*|BF16|F16|F32)$/i, '').replace(/^[_.-]+|[_.-]+$/g, '').toLowerCase();
}

export function matchingProjectors(modelPath, projectorPaths, { modelPaths = [] } = {}) {
  const stem = visionModelStem(modelPath), directory = parent(modelPath);
  const stems = new Set(modelPaths.filter(file => parent(file) === directory).map(visionModelStem));
  return projectorPaths.filter(file => visionProjector(file) && parent(file) === directory && (visionModelStem(file) === stem || !visionModelStem(file) && stems.size === 1 && stems.has(stem))).sort((a, b) => {
    const rank = file => /[_.-]Q8_0(?:-\d{5}-of-\d{5})?\.gguf$/i.test(file) ? 0 : /[_.-](?:BF16|F16)(?:-\d{5}-of-\d{5})?\.gguf$/i.test(file) ? 1 : 2;
    return Number(!visionModelStem(a)) - Number(!visionModelStem(b)) || rank(a) - rank(b) || a.localeCompare(b);
  });
}

export function visionCompanions(files) {
  const main = new Map();
  for (const file of files.filter(file => file.format === 'gguf' && !auxiliaryGGUF(file.path))) {
    const directory = parent(file.path), stem = visionModelStem(file.path);
    if (!main.has(directory)) main.set(directory, new Map());
    const stems = main.get(directory); if (!stems.has(stem)) stems.set(stem, []); stems.get(stem).push(file.path);
  }
  const projectors = files.filter(file => file.format === 'gguf' && visionProjector(file.path) && !/-\d+-of-\d+\.gguf$/i.test(file.path));
  return projectors.map(file => {
    const stems = main.get(parent(file.path)), stem = visionModelStem(file.path);
    const modelFiles = stems?.get(stem) || (!stem && stems?.size === 1 ? [...stems.values()][0] : []);
    return { path: file.path, size: file.size, sha256: file.sha256, role: 'vision-projector', modelFiles };
  });
}
