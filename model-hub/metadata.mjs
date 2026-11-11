import { repoId, revision, validFilePath } from './paths.mjs';
import { quantizationCatalog, auxiliaryGGUF } from './quantizations.mjs';
import { packageCatalog, musicComponent } from './packages.mjs';
import { fetchFile } from './transfer.mjs';
import { visionCompanions, visionProjector } from './vision.mjs';

const GiB = 1024 ** 3;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const dtypeBytes = { F64: 8, F32: 4, F16: 2, BF16: 2, F8_E4M3: 1, F8_E5M2: 1, I64: 8, I32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1 };
export function estimateVram(bytes, basis) {
  if (count(bytes) === null || bytes === 0) return null;
  return { bytes: Math.ceil(bytes * 1.2 + GiB), basis, estimated: true, note: 'Weight bytes + 20% overhead + 1 GiB reserve. This is a heuristic, not a fit guarantee; KV cache, context, batching, runtime support and CPU offload change actual VRAM use.' };
}
function format(file) {
  const extension = file.split('.').at(-1).toLowerCase();
  return ['gguf', 'safetensors', 'bin', 'pt', 'pth', 'ckpt', 'onnx', 'h5', 'msgpack'].includes(extension) ? extension : 'other';
}
export function modelSummary(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid model metadata');
  const id = repoId(raw.id || raw.modelId);
  const safeTotal = count(raw.safetensors?.total), ggufTotal = count(raw.gguf?.total);
  const parameters = safeTotal ?? ggufTotal;
  const formats = new Set();
  if (raw.safetensors || raw.tags?.includes('safetensors')) formats.add('safetensors');
  if (raw.gguf || raw.tags?.includes('gguf')) formats.add('gguf');
  for (const file of Array.isArray(raw.siblings) ? raw.siblings : []) if (typeof file.rfilename === 'string') { const kind = format(file.rfilename); if (kind !== 'other') formats.add(kind); }
  let weightBytes = 0;
  const dtypes = raw.safetensors?.parameters;
  if (dtypes && typeof dtypes === 'object' && !Array.isArray(dtypes) && Object.keys(dtypes).length) {
    for (const [dtype, amount] of Object.entries(dtypes)) {
      if (!Object.hasOwn(dtypeBytes, dtype) || count(amount) === null) { weightBytes = 0; break; }
      weightBytes += amount * dtypeBytes[dtype];
    }
  }
  if (!Number.isSafeInteger(weightBytes)) weightBytes = 0;
  const ggufSize = count(raw.gguf?.totalFileSize);
  return {
    id, ...(typeof raw.sha === 'string' && /^[a-f0-9]{40}$/i.test(raw.sha) ? { revision: raw.sha.toLowerCase() } : {}),
    parameters, ...(parameters !== null ? { parameterSource: safeTotal !== null ? 'Hub safetensors.total' : 'Hub gguf.total' } : {}),
    sizeBytes: ggufSize ?? (weightBytes || null), sizeLabel: ggufSize !== null ? 'HF-reported GGUF variant; other variants may differ' : weightBytes ? 'Estimated safetensors weight bytes from explicit dtype counts; excludes file headers' : 'Repository size unavailable in search',
    formats: [...formats], vram: estimateVram(weightBytes, 'Explicit Hub safetensors dtype counts'),
    ...(count(raw.downloads) !== null ? { downloads: raw.downloads } : {}), ...(count(raw.likes) !== null ? { likes: raw.likes } : {}),
    gated: raw.gated === true || raw.gated === 'auto' || raw.gated === 'manual',
    ...(typeof raw.pipeline_tag === 'string' && raw.pipeline_tag.length < 100 ? { pipelineTag: raw.pipeline_tag } : {}),
  };
}
export function modelDetails(raw, requestedRepo, requestedRevision) {
  const summary = modelSummary(raw);
  if (summary.id !== requestedRepo) throw new Error('Hub returned a different repository; inspect its canonical ID');
  const pinned = revision(raw.sha);
  if (requestedRevision && /^[a-f0-9]{40}$/i.test(requestedRevision) && pinned !== requestedRevision.toLowerCase()) throw new Error('Hub returned a different commit revision');
  if (!Array.isArray(raw.siblings) || raw.siblings.length > 20000) throw new Error('Invalid or excessive repository file listing');
  const seen = new Set();
  const files = raw.siblings.map(item => {
    const file = validFilePath(item.rfilename);
    if (seen.has(file)) throw new Error('Duplicate repository file'); seen.add(file);
    const size = count(item.lfs?.size) ?? count(item.size);
    const hash = item.lfs?.sha256;
    if (hash !== undefined && !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Invalid advertised SHA-256');
    const kind = format(file), weight = kind !== 'other';
    const auxiliary = auxiliaryGGUF(file);
    const shard = /-\d+-of-\d+/i.test(file);
    return { path: file, size, sha256: hash?.toLowerCase() || null, weight, format: kind, ...(visionProjector(file) ? { role: 'vision-projector' } : {}),
      ...(kind === 'gguf' && !shard && !auxiliary ? { vram: estimateVram(size, 'This selected GGUF weight file') } : {}) };
  });
  const totalBytes = files.every(file => file.size !== null) ? files.reduce((sum, file) => sum + file.size, 0) : null;
  if (totalBytes !== null && !Number.isSafeInteger(totalBytes)) throw new Error('Repository size exceeds supported integer range');
  const variants = quantizationCatalog(files, estimateVram);
  return { ...summary, revision: pinned, files, visionCompanions: visionCompanions(files), quantizations: variants.filter(variant => !musicComponent(variant.files[0])), packages: packageCatalog(files, {}, variants, estimateVram), totalBytes, sizeBytes: totalBytes, sizeLabel: 'All files in this pinned revision; may include multiple variants' };
}

export function httpError(status) {
  if (status === 401 || status === 403) return new Error(`Hugging Face HTTP ${status}: sign in on the model page, accept any gated-model terms, and save an authorized read token in Settings`);
  if (status === 429) return new Error('Hugging Face rate limit reached (HTTP 429); wait before retrying');
  if (status === 404) return new Error('Hugging Face model, revision or file not found (HTTP 404); private repositories may require a token');
  return new Error(`Hugging Face request failed (HTTP ${status})`);
}
export function createMetadata({ fetchImpl, token }) {
  async function json(url, signal, limit = 16 * 1024 * 1024, file = false) {
    const credential = await token();
    const boundedSignal = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
    const response = file ? await fetchFile(url, { fetchImpl, token: credential, signal: boundedSignal }) : await fetchImpl(url, { redirect: 'error', signal: boundedSignal, headers: { Accept: 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) } });
    if (!response.ok) throw httpError(response.status);
    if (!response.body) throw new Error('Hub returned an empty metadata response');
    const chunks = []; let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Hub metadata response too large');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const text = Buffer.concat(chunks, size).toString('utf8');
    try { return JSON.parse(text); } catch { throw new Error('Hub returned malformed JSON'); }
  }
  return {
    async search({ query = '', limit = 20, format = 'all' }, signal) {
      const url = new URL('https://huggingface.co/api/models');
      for (const [key, value] of Object.entries({ search: query, limit, sort: 'downloads', direction: '-1' })) url.searchParams.set(key, String(value));
      if (format !== 'all') url.searchParams.set('filter', format);
      for (const field of ['sha', 'safetensors', 'gguf', 'downloads', 'likes', 'gated', 'pipeline_tag', 'tags']) url.searchParams.append('expand[]', field);
      const result = await json(url.href, signal);
      if (!Array.isArray(result)) throw new Error('Hub returned an invalid model listing');
      return { models: result.slice(0, limit).map(modelSummary) };
    },
    async inspect({ repoId: id, revision: ref }, signal) {
      repoId(id);
      if (ref !== undefined && (typeof ref !== 'string' || !ref || ref.length > 200 || /[\x00-\x1f]/.test(ref))) throw new Error('Invalid model revision');
      const url = `https://huggingface.co/api/models/${id}${ref ? `/revision/${encodeURIComponent(ref)}` : ''}?blobs=true`;
      const model = modelDetails(await json(url, signal), id, ref), documents = {};
      const indexes = model.files.filter(file => /\.safetensors\.index\.json$/i.test(file.path) || file.path === 'modular_model_index.json');
      if (indexes.length > 64) throw new Error('Too many Safetensors indexes to inspect safely; use a narrower repository');
      for (const file of indexes) {
        if (file.size !== null && file.size > 2 * 1024 * 1024) continue;
        const fileUrl = `https://huggingface.co/${id}/resolve/${model.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
        documents[file.path] = await json(fileUrl, signal, 2 * 1024 * 1024, true);
      }
      model.packages = packageCatalog(model.files, documents, quantizationCatalog(model.files, estimateVram), estimateVram);
      return model;
    },
  };
}
