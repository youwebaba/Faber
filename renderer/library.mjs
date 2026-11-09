import { formatBytes, formatParameters, formatVram, downloadProgress, requestGate } from './model-helpers.mjs';

const pathKey = (root, file) => `${root}/${file}`.replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase();
export function libraryMetadata(entry, details) {
  const cached = entry.job?.modelMetadata;
  const source = details || (cached ? { ...cached, metadataSource: 'cached-huggingface', quantization: entry.job.quantizationLabel } : {});
  return { parameters: source.parameters ?? null, architecture: source.architecture || null, quantization: source.quantization || (!details ? entry.job?.quantizationLabel : null) || null,
    vram: source.vram || null, parameterSource: source.parameterSource || null, metadataSource: source.metadataSource || 'unknown', warnings: source.warnings || [] };
}
export function libraryEntries(local, downloads) {
  const active = downloads.filter(job => ['queued', 'downloading'].includes(job.status));
  const reserved = new Set(active.flatMap(job => job.files.map(file => pathKey(job.directory, file.path))));
  const rows = active.map(job => ({ kind: 'transfer', id: `job:${job.id}`, label: job.packageLabel || job.quantizationLabel || (job.files.length === 1 ? job.files[0].path : `${job.repoId} · ${job.files.length} selected files`), job }));
  for (const model of local.models || []) {
    const paths = model.files.map(file => pathKey(local.directory, file)); const downloading = paths.some(path => reserved.has(path));
    if (downloading && paths.every(path => reserved.has(path))) continue;
    const running = local.process?.modelId === model.id && ['loading', 'ready', 'stopping'].includes(local.process.status);
    const job = downloads.findLast(job => paths.every(target => job.files.some(file => pathKey(job.directory, file.path) === target)));
    rows.push({ kind: 'disk', id: `disk:${model.id}`, label: model.packageId ? (job?.packageLabel || model.label).split('/').at(-1) : model.label, model, job, canDelete: !running && !downloading,
      deleteReason: running ? 'Stop this model before moving its files.' : downloading ? 'Cancel the active download first.' : '',
      status: running ? `Runtime ${local.process.status}` : model.available ? 'On disk' : 'On disk · unavailable for this runtime' });
  }
  return rows;
}

export function createDiskLibrary({ request, el, button, actions, notify, inspect }) {
  const root = el('section', 'disk-library'); root.id = 'disk-library';
  const heading = el('div', 'model-library-heading'); const status = el('p', 'hint'); status.id = 'disk-library-status'; status.setAttribute('role', 'status');
  const refreshButton = button('Refresh disk library', () => refresh()); refreshButton.id = 'disk-library-refresh'; heading.append(status, refreshButton);
  const grid = el('div', 'model-card-grid'); grid.id = 'disk-library-grid';
  const detail = el('section', 'disk-model-detail'); detail.id = 'disk-model-detail'; detail.hidden = true; root.append(heading, grid, detail);
  let local = { models: [] }, hub = { downloads: [] }, selectedId, deleting, scanError, detailSignature, readingMetadata;
  const metadata = new Map(), metadataErrors = new Map(), nextMetadata = requestGate();
  const nextScan = requestGate(); const nodes = new Map();
  function render() {
    const entries = libraryEntries(local, hub.downloads); const keys = new Set(entries.map(entry => entry.id));
    for (const [id, row] of nodes) if (!keys.has(id)) { row.root.remove(); nodes.delete(id); }
    grid.querySelector('.library-empty')?.remove();
    status.textContent = scanError || (local.directory ? `Disk library: ${local.directory}` : 'Reading your model folder…'); status.classList.toggle('error-text', Boolean(scanError));
    if (!entries.length) grid.append(el('p', 'library-empty hint', 'No model files found in the configured folder. Browse models to download a variant, or change the model folder in Settings.'));
    for (const entry of entries) {
      let row = nodes.get(entry.id);
      if (!row) {
        const card = el('article', 'library-model-card'); card.dataset.libraryId = entry.id;
        const choose = el('button', 'model-card-main'); choose.type = 'button'; const title = el('strong', 'model-repo'); const subtitle = el('span', 'model-tags model-job-status'); const size = el('span', 'model-card-size'); choose.append(title, subtitle, size); choose.addEventListener('click', () => { nextMetadata(); readingMetadata = undefined; selectedId = entry.id; render(); detail.scrollIntoView({ block: 'nearest' }); const current = libraryEntries(local, hub.downloads).find(item => item.id === entry.id); if (current?.model && !metadata.has(current.model.id)) readMetadata(current.model.id, entry.id); });
        const progress = el('progress', 'model-job-progress'); progress.max = 1; const numbers = el('div', 'model-job-numbers model-card-transfer'); const bytes = el('span', 'model-job-bytes'); const speed = el('span', 'model-job-speed'); const percent = el('span'); numbers.append(bytes, speed, percent);
        const transferring = entry.kind === 'transfer';
        const action = transferring
          ? button('Cancel download', async () => { await request('models.cancel', {id:entry.job.id}); await refresh(); })
          : button('Move to Recycle Bin', () => recycle(entry.id), 'button danger');
        action.dataset.action = transferring ? 'cancel-download' : 'recycle-model';
        const explanation = el('p', 'hint model-card-reason'); card.append(choose, progress, numbers, explanation, actions(action));
        row = { root: card, choose, title, subtitle, size, progress, numbers, bytes, speed, percent, action, explanation }; nodes.set(entry.id, row); grid.append(card);
      }
      row.title.textContent = entry.label; row.choose.setAttribute('aria-pressed', String(entry.id === selectedId)); row.root.dataset.modelId = entry.model?.id || ''; row.root.dataset.jobId = entry.kind === 'transfer' ? entry.job.id : '';
      row.root.classList.toggle('model-job', entry.kind === 'transfer'); row.root.dataset.id = entry.kind === 'transfer' ? entry.job.id : '';
      row.progress.hidden = row.numbers.hidden = entry.kind !== 'transfer';
      if (entry.kind === 'transfer') {
        const info = downloadProgress(entry.job); row.subtitle.textContent = `${entry.job.status === 'queued' ? 'Queued' : 'Downloading'} · ${entry.job.repoId}`; row.size.textContent = `Download size ${formatBytes(entry.job.totalBytes)}`;
        if (info.progress === null) row.progress.removeAttribute('value'); else row.progress.value = info.progress;
        row.progress.setAttribute('aria-label', `Downloading ${entry.label}`); row.bytes.textContent = info.bytes; row.speed.textContent = info.speed; row.percent.textContent = info.percent; row.explanation.textContent = '';
      } else {
        row.subtitle.textContent = `${entry.model.format.toUpperCase()} · ${entry.status}`; row.size.textContent = `File size ${formatBytes(entry.model.sizeBytes)}`;
        row.action.disabled = Boolean(deleting) || !entry.canDelete; row.action.title = entry.deleteReason || 'Move this exact model file set to the Windows Recycle Bin'; row.explanation.textContent = entry.deleteReason || entry.model.reason || '';
      }
    }
    renderDetail();
  }
  function renderDetail() {
    const entry = libraryEntries(local, hub.downloads).find(item => item.id === selectedId); detail.hidden = !entry;
    if (!entry) { detailSignature = undefined; return; }
    const info = libraryMetadata(entry, metadata.get(entry.model?.id));
    const signature = JSON.stringify([entry.id, entry.model, info, metadataErrors.get(entry.model?.id), readingMetadata, entry.job?.repoId, entry.job?.files.map(file => [file.path, file.size])]);
    if (signature === detailSignature) return; detailSignature = signature;
    detail.replaceChildren(); const heading = el('div', 'model-library-heading'); heading.append(el('h2', 'model-repo', entry.label), button('Close details', () => { nextMetadata(); readingMetadata = undefined; selectedId = undefined; detail.hidden = true; render(); })); detail.append(heading);
    const model = entry.model; const job = entry.job; const metrics = el('div', 'model-metrics');
    for (const [label, value, key] of [['File size', formatBytes(model?.sizeBytes ?? job?.totalBytes), 'size'], ['Parameters', formatParameters(info.parameters), 'parameters'], ['VRAM estimate', formatVram(info.vram), 'vram'], ['Architecture', info.architecture || 'Unknown', 'architecture'], ['Quantization', info.quantization || 'Unknown', 'quantization']]) { const cell = el('div'); const valueNode = el('strong', '', value); valueNode.dataset.metric = key; cell.append(el('span', '', label), valueNode); metrics.append(cell); }
    detail.append(metrics);
    const metadataStatus = el('p', 'hint'); metadataStatus.id = 'disk-metadata-status'; metadataStatus.setAttribute('role', 'status');
    metadataStatus.textContent = readingMetadata === model?.id ? 'Reading local model metadata…' : metadataErrors.get(model?.id) || ({ gguf: 'Source: local GGUF metadata.', 'cached-huggingface': 'Source: saved publisher metadata from the download.', unknown: 'Metadata not available. A filename is not proof of architecture or runtime fit.' }[info.metadataSource] || 'Source not reported.'); detail.append(metadataStatus);
    if (info.parameterSource) detail.append(el('p', 'hint', `Parameter count: ${info.parameterSource}.`));
    if (info.vram) detail.append(el('p', 'hint', `${info.vram.basis || 'Estimated memory'}. Actual use depends on context, runtime, and offload; this is not a fit guarantee.`));
    for (const warning of info.warnings) detail.append(el('p', 'hint', warning));
    if (model && metadataErrors.has(model.id)) detail.append(button('Retry local metadata', () => readMetadata(model.id, entry.id)));
    if (model?.components) detail.append(el('p', 'hint', 'MiniMax-Music3: complete five-component music pipeline. Use Music to generate audio; this pipeline is separate from chat inference. Whole-pipeline memory includes all five components and runtime buffers.'));
    detail.append(el('pre', 'result-content', model ? [...model.files, ...(model.supportFiles || [])].join('\n') : job.files.map(file => `${file.path} · ${formatBytes(file.size)}`).join('\n')));
    if (model?.supportFiles?.length) detail.append(el('p', 'hint', 'Configuration, tokenizer and index support files are retained when recycling weights because other packages may share them.'));
    if (model?.reason) detail.append(el('p', 'hint error-text', model.reason));
    if (job?.repoId) detail.append(button('Inspect publisher quantizations', () => inspect(job.repoId)));
    detail.append(el('p', 'hint', 'Use the model selector in chat to choose hardware, start a compatible local model, and apply it to a chat.'));
  }
  async function readMetadata(modelId, entryId) {
    const valid = nextMetadata(); readingMetadata = modelId; metadataErrors.delete(modelId); renderDetail();
    try { const result = await request('localModels.details', { modelId }); if (valid() && selectedId === entryId && result.modelId === modelId) metadata.set(modelId, result); }
    catch (error) { if (valid() && selectedId === entryId) metadataErrors.set(modelId, error.message || String(error)); }
    finally { if (valid()) { readingMetadata = undefined; renderDetail(); } }
  }
  async function recycle(id) {
    const entry = libraryEntries(local, hub.downloads).find(item => item.id === id); if (!entry?.canDelete || deleting) return;
    deleting = id; render();
    try { const result = await request('localModels.delete', { modelId: entry.model.id }); if (!result.deleted) throw new Error(result.error || 'Some files could not be moved. Refresh the library to review what remains.'); notify('Model files moved to the Recycle Bin.'); }
    catch (error) { notify(error.message || String(error), true); }
    finally { deleting = undefined; await refresh(); }
  }
  async function refresh() {
    const current = nextScan(); refreshButton.disabled = true;
    try { const result = await request('localModels.list'); if (current()) { local = result; scanError = undefined; render(); } }
    catch (error) { if (current()) { scanError = error.message || String(error); render(); } }
    finally { if (current()) refreshButton.disabled = false; }
  }
  return { root, refresh, update(value) { hub = value; render(); } };
}
