import { formatBytes, formatParameters, formatVram, selectedFiles, downloadProgress, requestGate, quantizationGroups, modelDownloadRequest, availableVisionCompanions } from './model-helpers.mjs';
import { createDiskLibrary } from './library.mjs';
import { createPackageChoices } from './model-packages.mjs';

export function createModelsBrowser({ request, subscribe, el, button, field, actions, notify, showSettings }) {
  let hub = { downloadDirectory: '', hasToken: false, downloads: [] };
  let loaded = false;
  let eventVersion = 0;
  let inspected;
  let searchResults = [];
  let settingsView;
  let activeTab = 'browse';
  const selected = new Set();
  const nextSearch = requestGate();
  const nextInspect = requestGate();
  const jobNodes = new Map();
  const panel = el('section', 'models-panel'); panel.id = 'models-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Hugging Face models');
  const heading = el('div', 'models-heading'); const headingText = el('div'); headingText.append(el('h1', '', 'Models'), el('p', 'hint', 'Browse Hugging Face and download model files for a compatible local runtime.'));
  const headingActions = el('div', 'models-heading-actions'); headingActions.append(button('Back to chat', close), button('Download settings', showSettings));
  heading.append(headingText, headingActions); panel.append(heading);
  const tabs = el('div', 'tab-row models-tabs');
  const browseTab = button('Browse', () => showTab('browse'), 'selected'); browseTab.id = 'model-browse-tab';
  const downloadsTab = button('Downloads & library', () => showTab('downloads')); downloadsTab.id = 'model-downloads-tab';
  tabs.append(browseTab, downloadsTab); panel.append(tabs);
  const browse = el('div', 'models-browse');
  const form = el('form', 'model-search'); form.id = 'model-search-form';
  const query = el('input'); query.id = 'model-search-query'; query.type = 'search'; query.placeholder = 'Search models or publisher…'; query.setAttribute('aria-label', 'Search Hugging Face models');
  const format = el('select'); format.id = 'model-search-format'; format.setAttribute('aria-label', 'Model file format');
  for (const [value, label] of [['all', 'All formats'], ['gguf', 'GGUF'], ['safetensors', 'Safetensors']]) { const option = el('option', '', label); option.value = value; format.append(option); }
  const searchButton = el('button', 'button primary', 'Search'); searchButton.type = 'submit';
  form.append(query, format, searchButton); browse.append(form);
  const catalogStatus = el('div', 'model-catalog-status hint'); catalogStatus.setAttribute('role', 'status'); browse.append(catalogStatus);
  const columns = el('div', 'model-columns'); const results = el('div', 'model-results'); results.id = 'model-results'; results.setAttribute('aria-label', 'Search results');
  const detail = el('section', 'model-detail'); detail.id = 'model-detail'; detail.setAttribute('aria-label', 'Model details');
  detail.append(el('div', 'model-detail-empty', 'Select a model to inspect its files, sizes, and available estimates.'));
  detail.hidden = true; results.tabIndex = -1; columns.append(results, detail); browse.append(columns); panel.append(browse);
  const downloads = el('section', 'model-downloads'); downloads.id = 'model-downloads'; downloads.hidden = true;
  const libraryHeading = el('div', 'model-library-heading'); const directory = el('p', 'hint');
  const openRoot = button('Open download folder', () => request('models.openDirectory'));
  libraryHeading.append(directory, openRoot); downloads.append(libraryHeading);
  const libraryNote = el('p', 'hint', 'Files found on disk and active downloads. Stop a model before deleting it. Recycle Bin storage is freed when you empty the bin.'); downloads.append(libraryNote);
  const diskLibrary = createDiskLibrary({ request, el, button, actions, notify, inspect: async (repoId, revision, modelFiles) => { showTab('browse'); await inspect(repoId, revision, modelFiles); } }); downloads.append(diskLibrary.root);
  const history = el('details', 'model-transfer-history'); history.append(el('summary', '', 'Past transfer records'), el('p', 'hint', 'Records do not prove files are still on disk. Use the disk library above for current model files.'));
  const jobs = el('div', 'model-jobs'); history.append(jobs); downloads.append(history); panel.append(downloads);
  const footer = el('div', 'model-footer'); const transferStatus = el('span', 'hint'); const viewTransfers = button('View downloads', () => showTab('downloads'), 'text-button');
  footer.append(transferStatus, viewTransfers); panel.append(footer);
  document.querySelector('.workspace').append(panel);
  form.addEventListener('submit', event => { event.preventDefault(); void search(); });
  format.addEventListener('change', () => void search());

  function errorText(error) { return error?.message || String(error); }
  async function refresh() {
    const version = eventVersion;
    const value = await request('models.state');
    if (version === eventVersion) accept(value);
  }
  function accept(value) {
    hub = value;
    diskLibrary.update(hub);
    renderDownloads();
    if (settingsView?.root.isConnected) settingsView.updateStatus();
  }
  let terminalJobs = '';
  subscribe?.(event => {
    if (event.type === 'models') { eventVersion++; accept(event.state); const terminal = event.state.downloads.filter(job => ['completed', 'failed', 'canceled', 'interrupted'].includes(job.status)).map(job => `${job.id}:${job.status}`).join('|'); if (terminal !== terminalJobs) { terminalJobs = terminal; if (!panel.hidden) diskLibrary.refresh(); } }
    if (event.type === 'localModels' && !panel.hidden) diskLibrary.refresh();
  });
  function showTab(tab) {
    activeTab = tab;
    browse.hidden = tab !== 'browse'; downloads.hidden = tab !== 'downloads';
    browseTab.classList.toggle('selected', tab === 'browse'); downloadsTab.classList.toggle('selected', tab === 'downloads');
    browseTab.setAttribute('aria-pressed', String(tab === 'browse')); downloadsTab.setAttribute('aria-pressed', String(tab === 'downloads'));
    if (tab === 'downloads') diskLibrary.refresh();
  }
  function close() {
    const wasOpen = !panel.hidden;
    panel.hidden = true; document.body.classList.remove('models-open');
    document.querySelector('#open-models').classList.remove('selected');
    if (wasOpen) document.querySelector('#prompt').focus();
  }
  async function open() {
    panel.hidden = false; document.body.classList.add('models-open'); document.body.classList.remove('sidebar-open');
    document.querySelector('#open-models').classList.add('selected');
    try { await refresh(); await diskLibrary.refresh(); } catch (error) { notify(errorText(error), true); }
    if (!loaded) { loaded = true; await search(); }
    if (activeTab === 'browse') query.focus();
  }
  async function search() {
    const current = nextSearch();
    searchButton.disabled = true; catalogStatus.classList.remove('error-text'); catalogStatus.textContent = 'Searching Hugging Face…';
    try {
      const result = await request('models.search', { query: query.value.trim(), format: format.value, limit: 30 });
      if (!current()) return;
      searchResults = result.models;
      results.replaceChildren();
      catalogStatus.textContent = searchResults.length ? `${searchResults.length} model${searchResults.length === 1 ? '' : 's'}. Sizes may cover multiple variants; choose files before downloading.` : 'No matching models. Try another name or format.';
      for (const model of searchResults) {
        const row = button('', () => inspect(model.id), 'model-result'); row.dataset.repoId = model.id;
        row.append(el('strong', 'model-repo', model.id));
        const tags = el('span', 'model-tags', [...(model.formats || []), ...(model.gated ? ['Restricted access'] : [])].join(' · ') || 'Format not listed'); row.append(tags);
        const metrics = el('div', 'model-metrics'); metrics.append(metric('Parameters', formatParameters(model.parameters)), metric('Reported size', formatBytes(model.sizeBytes)), metric('VRAM estimate', formatVram(model.vram))); row.append(metrics);
        if (model.sizeLabel) row.append(el('span', 'model-size-note', model.sizeLabel));
        row.title = model.vram?.note || 'Inspect model files'; row.setAttribute('aria-pressed', String(inspected?.id === model.id)); results.append(row);
      }
    } catch (error) { if (current()) { catalogStatus.classList.add('error-text'); catalogStatus.textContent = errorText(error); } }
    finally { if (current()) searchButton.disabled = false; }
  }
  function metric(label, value) { const node = el('div'); node.append(el('span', '', label), el('strong', '', value)); return node; }
  function pageLink(repoId, label = 'Open on Hugging Face') {
    const link = el('a', 'model-page-link', label); link.href = `https://huggingface.co/${repoId.split('/').map(encodeURIComponent).join('/')}`;
    link.addEventListener('click', event => { event.preventDefault(); request('models.openPage', { repoId }).catch(error => notify(errorText(error), true)); }); return link;
  }
  async function inspect(repoId, revision, modelFiles) {
    detail.hidden = false; columns.classList.add('has-detail');
    const current = nextInspect(); inspected = undefined; selected.clear();
    for (const row of results.children) row.setAttribute('aria-pressed', String(row.dataset.repoId === repoId));
    detail.replaceChildren(el('p', 'hint', 'Loading file metadata…')); detail.scrollTop = 0;
    try {
      const model = await request('models.inspect', { repoId, ...(revision ? { revision } : {}) }); if (!current()) return;
      inspected = model; renderDetail(model, modelFiles);
    } catch (error) {
      if (!current()) return;
      detail.replaceChildren(el('h2', 'model-repo', repoId), el('p', 'error-text', errorText(error)), el('p', 'hint', 'For restricted models, request access on Hugging Face and save a token with permission to read the repository in Settings.'), pageLink(repoId), button('Download settings', showSettings), button('Try again', () => inspect(repoId, revision, modelFiles)));
    }
  }
  function renderDetail(model, existingModelFiles = []) {
    detail.replaceChildren();
    let quantization;
    const variantButtons = [];
    const header = el('div', 'model-detail-heading'); header.append(button('Back to model grid', () => { detail.hidden = true; columns.classList.remove('has-detail'); results.focus(); }, 'text-button'), el('h2', 'model-repo', model.id), pageLink(model.id)); detail.append(header);
    if (model.gated) detail.append(el('p', 'hint', 'This repository restricts access. Accept its terms on Hugging Face and add an authorized token in Settings before downloading.'));
    const packages = createPackageChoices({ model, el, onSelect(files) { quantization = undefined; selected.clear(); files.forEach(file => selected.add(file)); checkboxes.forEach(check => { check.checked = selected.has(check.value); }); updateSelection(); } });
    detail.append(packages.root);
    const information = model.quantizations?.length ? el('details', 'model-information') : detail;
    if (information !== detail) information.append(el('summary', '', 'Model information and estimates'));
    const metrics = el('div', 'model-metrics model-detail-metrics'); metrics.append(metric('Parameters', formatParameters(model.parameters)), metric(model.totalBytes === null || model.totalBytes === undefined ? model.sizeLabel || 'Size' : 'All repository files', formatBytes(model.totalBytes ?? model.sizeBytes)), metric('VRAM estimate', formatVram(model.vram))); information.append(metrics);
    const variants = el('section', 'model-quantizations'); variants.id = 'model-quantizations';
    const variantSummary = el('p', 'hint'); variantSummary.id = 'model-quantization-summary';
    if (model.quantizations?.length) {
      variants.append(el('h3', '', 'Choose a quantization'), el('p', 'hint', 'Nominal bit-depth groups. Each choice includes its complete split-shard set.'));
      for (const group of quantizationGroups(model.quantizations)) {
        const row = el('div', 'quantization-row'); row.append(el('span', 'quantization-bits', `${group.bits}-bit`)); const choices = el('div', 'quantization-choices');
        for (const variant of group.variants) {
          const choice = el('button', 'quantization-pill'); choice.type = 'button'; choice.dataset.quantizationId = variant.id; choice.setAttribute('aria-pressed', 'false'); choice.disabled = !variant.complete;
          choice.append(el('strong', '', variant.encoding), el('span', 'quantization-size', formatBytes(variant.sizeBytes)), el('span', 'quantization-identity', variant.label), el('span', 'quantization-vram', variant.complete ? `VRAM estimate ${formatVram(variant.vram)}` : variant.reason || 'Incomplete shard set'));
          choice.title = `${variant.label}${variant.vram?.note ? `\n${variant.vram.note}` : ''}${variant.reason ? `\n${variant.reason}` : ''}`;
          choice.addEventListener('click', () => {
            packages.clear(); quantization = variant; selected.clear(); variant.files.forEach(path => selected.add(path));
            checkboxes.forEach(check => { check.checked = selected.has(check.value); }); updateSelection();
          });
          variantButtons.push({ choice, variant }); choices.append(choice);
        }
        row.append(choices); variants.append(row);
      }
      variants.append(variantSummary, el('p', 'hint', 'Auxiliary projector and adapter files are not standalone models.')); detail.append(variants);
    }
    if (information !== detail) detail.append(information);
    const metadata = el('p', 'hint', model.parameterSource ? `Parameter source: ${model.parameterSource}.` : 'The publisher has not provided a parameter count.'); information.append(metadata);
    const fileEstimate = model.files?.find(file => file.vram)?.vram || model.quantizations?.find(variant => variant.vram)?.vram;
    information.append(el('p', 'hint', model.vram ? `${model.vram.basis || 'Estimated weights and reserve'}. ${model.vram.note || 'Actual use depends on context, KV cache, batching, offload, and runtime support.'}` : fileEstimate ? `Repository VRAM is unknown. File-level estimates: ${fileEstimate.note}` : 'No reliable VRAM estimate is available for this repository. Inspect variant sizes below.'));
    information.append(el('p', 'hint', 'Choose a complete compatible variant; split models need all shards. Downloads do not automatically load or switch your current runtime.'));
    const revision = el('p', 'model-revision hint', `Pinned revision: ${model.revision || 'Unavailable'}`); information.append(revision);
    const files = el('div', 'model-files'); files.setAttribute('aria-label', 'Repository files');
    const checkboxes = [];
    for (const file of model.files || []) {
      const row = el('label', 'model-file'); const check = el('input'); check.type = 'checkbox'; check.value = file.path; check.dataset.path = file.path;
      const text = el('span', 'model-file-name'); text.append(el('strong', '', file.path), el('small', '', `${file.role === 'vision-projector' ? 'Vision companion · not a standalone model' : file.format || (file.weight ? 'Weights' : 'Supporting file')}${file.sha256 ? ' · SHA-256 available' : ''}${file.vram ? ` · VRAM estimate ${formatVram(file.vram)}` : ''}`));
      if (file.vram?.note) text.title = file.vram.note;
      row.append(check, text, el('span', 'model-file-size', formatBytes(file.size))); files.append(row); checkboxes.push(check);
      check.addEventListener('change', () => { packages.clear(); quantization = undefined; check.checked ? selected.add(file.path) : selected.delete(file.path); updateSelection(); });
    }
    if (!model.files?.length) files.append(el('p', 'hint', 'No files were listed for this revision.'));
    const manual = el('details', 'model-manual-files'); manual.id = 'model-manual-files'; manual.open = !model.quantizations?.length;
    manual.open = !model.quantizations?.length && !model.packages?.length;
    manual.append(el('summary', '', 'Advanced: select individual files'), el('p', 'hint', 'Manual selection may omit required weights or support data. Original repository subfolders are preserved.'), files); detail.append(manual);
    const vision = el('section', 'model-vision-companion'); vision.id = 'model-vision-companion';
    const projector = el('select'); projector.id = 'model-vision-projector'; projector.setAttribute('aria-label', 'Vision companion');
    const visionNote = el('p', 'hint'); visionNote.setAttribute('role', 'status');
    const companionOnly = button('Download vision companion only', async () => {
      if (!projector.value || downloading) return;
      downloading = true; updateSelection();
      try { await request('models.download', { repoId: model.id, revision: model.revision, files: [projector.value] }); notify('Vision companion queued. Existing model weights will not be downloaded again.'); await refresh(); showTab('downloads'); }
      catch (error) { notify(errorText(error), true); }
      finally { downloading = false; updateSelection(); }
    }); companionOnly.id = 'model-download-projector';
    vision.append(el('h3', '', 'Vision companion'), el('p', 'hint', 'A matching projector enables image input for a compatible GGUF runtime. Q8_0 is selected when offered. To add vision to an existing download, download only its companion at the same pinned revision.'), projector, visionNote, companionOnly); detail.append(vision);
    let companionSignature;
    projector.addEventListener('change', updateSelection);
    const selection = el('div', 'model-selection'); const summary = el('span', 'hint'); summary.id = 'model-selection-summary';
    let downloading = false;
    const download = el('button', 'button primary', 'Download selected files'); download.type = 'button'; download.id = 'model-download-selected';
    download.addEventListener('click', async () => {
      const chosen = selectedFiles(model.files, selected);
      if (downloading || !chosen.count || !model.revision) return;
      downloading = true; updateSelection();
      try {
        const job = await request('models.download', modelDownloadRequest(model, chosen.paths, quantization, packages.selected(), quantization ? projector.value || 'none' : undefined));
        notify(`Download queued for ${job.repoId}. Track progress in Downloads & library.`); await refresh(); showTab('downloads');
      } catch (error) { notify(errorText(error), true); }
      finally { downloading = false; updateSelection(); }
    });
    const clear = button('Clear selection', () => { packages.clear(); quantization = undefined; selected.clear(); checkboxes.forEach(check => { check.checked = false; }); updateSelection(); }, 'text-button');
    selection.append(summary, clear, download); detail.append(selection);
    function updateSelection() {
      const companions = availableVisionCompanions(model, quantization?.files || existingModelFiles).filter(file => file.modelFiles.length);
      const signature = JSON.stringify([quantization?.id, companions.map(file => file.path)]);
      if (signature !== companionSignature) {
        companionSignature = signature; projector.replaceChildren();
        for (const file of companions) { const option = el('option', '', `${file.path} · ${formatBytes(file.size)}`); option.value = file.path; projector.append(option); }
        const none = el('option', '', 'Text only — no companion'); none.value = ''; projector.append(none); projector.value = companions[0]?.path || '';
      }
      vision.hidden = !companions.length; companionOnly.disabled = downloading || !projector.value;
      visionNote.textContent = projector.value ? `${quantization ? 'Included with the selected quantization. ' : ''}Companion-only download: ${formatBytes(companions.find(file => file.path === projector.value)?.size)}. This file is not independently startable.` : 'No vision companion selected. The model can still be used for text.';
      if (quantization) { for (const file of model.visionCompanions || []) selected.delete(file.path); if (projector.value) selected.add(projector.value); checkboxes.forEach(check => { check.checked = selected.has(check.value); }); }
      const chosen = selectedFiles(model.files || [], selected);
      for (const { choice, variant } of variantButtons) choice.setAttribute('aria-pressed', String(quantization?.id === variant.id));
      variantSummary.textContent = quantization ? `${quantization.label}. ${quantization.files.length} file${quantization.files.length === 1 ? '' : 's'}; VRAM estimate ${formatVram(quantization.vram)}.` : chosen.count ? 'Custom file selection. Review that every required shard is included.' : 'Select one variant to see its exact download size.';
      const selectedPackage = packages.selected();
      summary.textContent = `${selectedPackage ? `${selectedPackage.label}: ` : quantization ? `${quantization.encoding}: ` : ''}${chosen.count} file${chosen.count === 1 ? '' : 's'} selected. Download size: ${chosen.sizeLabel}${selectedPackage && !selectedPackage.complete ? '. Choose all five components to continue.' : ''}`;
      download.textContent = selectedPackage ? 'Download complete package' : quantization ? `Download ${quantization.encoding}` : 'Download selected files'; download.disabled = downloading || !chosen.count || !model.revision || Boolean(selectedPackage && !selectedPackage.complete);
    }
    updateSelection();
  }
  function renderDownloads() {
    directory.textContent = hub.downloadDirectory ? `Future downloads: ${hub.downloadDirectory}` : 'Download folder is not configured.';
    openRoot.disabled = !hub.downloadDirectory;
    const active = hub.downloads.filter(job => downloadProgress(job).active);
    downloadsTab.textContent = `Downloads & library${hub.downloads.length ? ` (${hub.downloads.length})` : ''}`;
    transferStatus.textContent = active.length ? `${active.length} active download${active.length === 1 ? '' : 's'} · ${formatBytes(active.reduce((sum, job) => sum + (Number.isFinite(job.speedBytesPerSecond) ? job.speedBytesPerSecond : 0), 0))}/s` : hub.downloads.length ? 'No transfers running' : 'No model files downloaded through Faber yet';
    viewTransfers.hidden = !hub.downloads.length;
    const past = hub.downloads.filter(job => !downloadProgress(job).active);
    const ids = new Set(past.map(job => job.id));
    for (const [id, row] of jobNodes) if (!ids.has(id)) { row.node.remove(); jobNodes.delete(id); }
    jobs.querySelector('.model-library-empty')?.remove();
    if (!past.length) jobs.append(el('p', 'model-library-empty hint', 'No completed or interrupted transfer records.'));
    for (const job of past) {
      let row = jobNodes.get(job.id);
      if (!row) {
        const node = el('article', 'model-job'); node.dataset.id = job.id;
        const heading = el('div', 'model-job-heading'); const title = el('strong', 'model-repo', job.repoId); const status = el('span', 'model-job-status'); heading.append(title, status); node.append(heading);
        const progress = el('progress', 'model-job-progress'); progress.max = 1; progress.setAttribute('aria-label', `Download progress for ${job.repoId}`); node.append(progress);
        const numbers = el('div', 'model-job-numbers'); const bytes = el('span'); bytes.className = 'model-job-bytes'; const speed = el('span', 'model-job-speed'); const percent = el('span'); numbers.append(bytes, speed, percent); node.append(numbers);
        const error = el('p', 'model-job-error error-text'); error.setAttribute('role', 'status'); node.append(error);
        const path = el('p', 'model-job-directory hint', job.directory); node.append(path);
        const files = el('details', 'tool-message'); files.append(el('summary', '', `${job.files.length} selected file${job.files.length === 1 ? '' : 's'}`)); const fileText = el('pre', 'result-content'); files.append(fileText); node.append(files);
        const retry = button('Inspect files again', async () => { showTab('browse'); await inspect(job.repoId); });
        node.append(actions(pageLink(job.repoId), button('Open folder', () => request('models.openDirectory', { id: job.id })), retry));
        row = { node, status, progress, bytes, speed, percent, error, fileText, retry }; jobNodes.set(job.id, row); jobs.prepend(node);
      }
      const info = downloadProgress(job);
      row.status.textContent = job.status === 'completed' ? 'Files downloaded' : String(job.status).replace(/^./, letter => letter.toUpperCase());
      if (info.progress === null) row.progress.removeAttribute('value'); else row.progress.value = info.progress;
      row.bytes.textContent = info.bytes; row.speed.textContent = info.speed; row.percent.textContent = info.percent;
      row.retry.hidden = !['failed', 'canceled', 'interrupted'].includes(job.status);
      row.error.hidden = !job.error; row.error.textContent = job.error || '';
      row.fileText.textContent = job.files.map(file => `${file.path}\n${file.status || job.status} · ${formatBytes(file.downloadedBytes ?? file.bytes)} / ${formatBytes(file.size)}`).join('\n\n');
    }
  }
  function mountSettings(parent) {
    const root = el('section', 'modal-section model-settings'); root.id = 'model-download-settings'; root.append(el('h3', '', 'Model downloads'));
    const message = el('p', 'hint'); message.id = 'model-settings-message'; message.setAttribute('role', 'status');
    const path = field('Download folder', hub.downloadDirectory, 'text', 'Changing this folder affects future downloads. Existing files and active downloads stay in their original location.'); path.input.id = 'model-download-directory';
    const savedPath = el('p', 'hint'); const choose = button('Choose folder…', async () => { try { const result = await request('models.chooseDirectory'); if (result.path) path.input.value = result.path; } catch (error) { message.textContent = errorText(error); message.classList.add('error-text'); } }); choose.id = 'model-choose-directory';
    root.append(path.wrapper, actions(choose), savedPath);
    const token = field('Hugging Face token (optional)', '', 'password', 'For restricted repositories, first accept the model’s terms on Hugging Face. The token is saved in encrypted host storage. Leave blank to keep a saved token.'); token.input.id = 'model-hf-token'; token.input.autocomplete = 'new-password';
    const tokenStatus = el('p', 'hint'); root.append(token.wrapper, tokenStatus);
    const clear = button('Remove saved token', async () => { try { await request('models.settings.save', { clearToken: true }); await refresh(); message.textContent = 'Hugging Face token removed.'; message.classList.remove('error-text'); } catch (error) { message.textContent = errorText(error); message.classList.add('error-text'); } }); clear.id = 'model-clear-token';
    const save = button('Save download settings', async () => {
      try {
        if (!path.input.value.trim()) throw new Error('Choose a download folder.');
        const submittedToken = token.input.value;
        await request('models.settings.save', { downloadDirectory: path.input.value.trim(), ...(submittedToken.trim() ? { token: submittedToken.trim() } : {}) });
        if (token.input.value === submittedToken) token.input.value = '';
        await refresh(); message.textContent = 'Saved. New downloads will use this folder.'; message.classList.remove('error-text');
      } catch (error) { message.textContent = errorText(error); message.classList.add('error-text'); }
    }, 'button primary'); save.id = 'model-save-settings'; root.append(actions(clear, save), message); parent.append(root);
    let initialValue = path.input.value;
    const view = { root, updateStatus() { savedPath.textContent = hub.downloadDirectory ? `Saved location: ${hub.downloadDirectory}` : 'Loading download settings…'; tokenStatus.textContent = hub.hasToken ? 'A token is saved. Its value is never shown.' : 'No token saved. Public models usually do not need one.'; clear.hidden = !hub.hasToken; } };
    settingsView = view; view.updateStatus();
    void refresh().then(() => { if (settingsView === view && path.input.value === initialValue) { path.input.value = hub.downloadDirectory; initialValue = path.input.value; } }).catch(error => notify(errorText(error), true));
  }
  showTab('browse');
  return { open, close, mountSettings };
}
