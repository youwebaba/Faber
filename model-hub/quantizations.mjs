import { createHash } from 'node:crypto';

// Names from ggml-org/llama.cpp/tools/quantize/quantize.cpp and ggml/docs/gguf.md.
const encodingSuffixes = 'Q1_0 Q2_0 Q2_K Q2_K_S Q3_K Q3_K_S Q3_K_M Q3_K_L Q4_0 Q4_1 Q4_K Q4_K_S Q4_K_M Q5_0 Q5_1 Q5_K Q5_K_S Q5_K_M Q6_K Q8_0 Q8_1 Q8_K IQ1_S IQ1_M IQ2_XXS IQ2_XS IQ2_S IQ2_M IQ3_XXS IQ3_XS IQ3_S IQ3_M IQ4_NL IQ4_XS TQ1_0 TQ2_0 MXFP4 MXFP4_MOE F16 BF16 F32'.split(' ').sort((a, b) => b.length - a.length);
export const auxiliaryGGUF = file => /(?:^|[\/_.-])(mmproj|mtp|adapter|projector|lora|vocab)(?:[\/_.-]|$)/i.test(file);

export function quantizationCatalog(files, estimateVram) {
  const groups = new Map();
  for (const file of files) {
    if (file.format !== 'gguf' || auxiliaryGGUF(file.path)) continue;
    const bare = file.path.replace(/\.gguf$/i, '');
    const split = /-(\d+)-of-(\d+)$/i.exec(bare);
    const stem = split ? bare.slice(0, split.index) : bare;
    const basename = stem.split('/').at(-1).toUpperCase();
    // shortcut: only terminal, documented encodings are catalogued; unusual names remain manual files until explicitly supported.
    const encoding = encodingSuffixes.find(value => basename === value || basename.endsWith(`-${value}`) || basename.endsWith(`.${value}`));
    if (!encoding) continue;
    let group = groups.get(stem);
    if (!group) { group = { stem, encoding, entries: [] }; groups.set(stem, group); }
    group.entries.push({ file, index: split ? Number(split[1]) : null, total: split ? Number(split[2]) : null, valid: !split || (split[1].length === 5 && split[2].length === 5) });
  }
  const foldedPaths = new Map();
  for (const file of files) { const folded = file.path.toLowerCase(); foldedPaths.set(folded, (foldedPaths.get(folded) || 0) + 1); }
  return [...groups.values()].map(({ stem, encoding, entries }) => {
    const split = entries.some(entry => entry.index !== null), totals = new Set(entries.map(entry => entry.total));
    const total = entries[0].total;
    let reason;
    if (entries.some(entry => !entry.valid || foldedPaths.get(entry.file.path.toLowerCase()) > 1)) reason = 'Invalid or duplicate shard names';
    else if (split && (totals.size !== 1 || total < 1 || entries.some(entry => entry.index < 1 || entry.index > total))) reason = 'Inconsistent shard numbering';
    else if (split && (new Set(entries.map(entry => entry.index)).size !== entries.length || entries.length !== total)) reason = 'Incomplete or duplicate shard set';
    else if (!split && entries.length !== 1) reason = 'Duplicate variant';
    else if (entries.length > 256) reason = 'Variant exceeds the 256-file download limit';
    const complete = !reason;
    entries.sort((a, b) => (a.index || 0) - (b.index || 0));
    const sum = entries.every(entry => entry.file.size !== null) ? entries.reduce((value, entry) => value + entry.file.size, 0) : null;
    const sizeBytes = complete && Number.isSafeInteger(sum) ? sum : null;
    const bits = encoding === 'BF16' ? 16 : Number(/\d+/.exec(encoding)[0]);
    return { id: createHash('sha256').update(stem).digest('hex'), label: stem, encoding, bits,
      files: entries.map(entry => entry.file.path), sizeBytes, vram: estimateVram(sizeBytes, 'All files in this GGUF variant; encoding inferred from filenames'), complete, ...(reason ? { reason } : {}) };
  }).sort((a, b) => a.bits - b.bits || a.encoding.localeCompare(b.encoding) || a.label.localeCompare(b.label));
}
