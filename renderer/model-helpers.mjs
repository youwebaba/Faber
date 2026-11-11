const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function formatBytes(value) {
  if (!validNumber(value)) return 'Unknown';
  if (value === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))));
  return `${Number((value / 1024 ** index).toFixed(index ? 2 : 0))} ${units[index]}`;
}

export function formatParameters(value) {
  if (!validNumber(value) || value === 0) return 'Unknown';
  const scale = value >= 1e12 ? [1e12, 'T'] : value >= 1e9 ? [1e9, 'B'] : value >= 1e6 ? [1e6, 'M'] : value >= 1e3 ? [1e3, 'K'] : [1, ''];
  return `${Number((value / scale[0]).toFixed(2))}${scale[1]}`;
}

export function formatVram(vram) {
  return vram && validNumber(vram.bytes) && vram.bytes > 0 ? `~${formatBytes(vram.bytes)}` : 'Unknown';
}

export function selectedFiles(files, selected) {
  const chosen = files.filter(file => selected.has(file.path));
  const unknownCount = chosen.filter(file => !validNumber(file.size)).length;
  const knownBytes = chosen.reduce((sum, file) => sum + (validNumber(file.size) ? file.size : 0), 0);
  return { paths: chosen.map(file => file.path), count: chosen.length, knownBytes, unknownCount,
    sizeLabel: unknownCount ? `${formatBytes(knownBytes)} known + ${unknownCount} unknown size${unknownCount === 1 ? '' : 's'}` : formatBytes(knownBytes) };
}

export function quantizationGroups(variants = []) {
  const groups = new Map();
  for (const variant of variants) {
    if (!groups.has(variant.bits)) groups.set(variant.bits, []);
    groups.get(variant.bits).push(variant);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([bits, variants]) => ({ bits, variants }));
}

export function availableVisionCompanions(model, modelFiles = []) {
  return (model.visionCompanions || []).filter(file => !modelFiles.length || modelFiles.some(path => file.modelFiles.includes(path))).sort((a, b) => {
    const rank = file => /[_.-]Q8_0\.gguf$/i.test(file.path) ? 0 : /[_.-](?:BF16|F16)\.gguf$/i.test(file.path) ? 1 : 2;
    return rank(a) - rank(b) || (a.size ?? Infinity) - (b.size ?? Infinity) || a.path.localeCompare(b.path);
  });
}

export function modelDownloadRequest(model, files, quantization, selectedPackage, projector) {
  if (selectedPackage) {
    if (!selectedPackage.complete) throw new Error(selectedPackage.reason || 'Select all five Music3 components.');
    return { repoId: model.id, revision: model.revision, packageId: selectedPackage.id, ...(selectedPackage.type === 'minimax-music3' ? { components: selectedPackage.choices } : {}) };
  }
  if (quantization && !quantization.complete) throw new Error(quantization.reason || 'This quantization is incomplete.');
  return { repoId: model.id, revision: model.revision, ...(quantization ? { quantizationId: quantization.id, ...(projector ? { projector } : {}) } : { files }) };
}

export function downloadProgress(job) {
  const progress = job.status === 'completed' ? 1 : validNumber(job.progress) ? Math.min(1, job.progress) : null;
  return { progress, percent: progress === null ? 'Size unknown' : `${Math.floor(progress * 100)}%`,
    bytes: `${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`,
    speed: job.status === 'downloading' && validNumber(job.speedBytesPerSecond) ? `${formatBytes(job.speedBytesPerSecond)}/s` : '—',
    active: ['queued', 'downloading'].includes(job.status) };
}

// Only the newest request may replace the panel after searches or selections race.
export function requestGate() {
  let sequence = 0;
  return () => { const current = ++sequence; return () => current === sequence; };
}
