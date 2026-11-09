import { formatBytes, requestGate } from './model-helpers.mjs';
import { createHardwareControls } from './hardware.mjs';
import { modelDisplayName } from './model-names.mjs';
import {createPrecisionControls} from './precision.mjs';

export const LOCAL_FILES = '__local_files__';
export function isLocalOllama(provider) {
  if (provider?.kind !== 'ollama') return false;
  try { return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(new URL(provider.baseUrl).hostname); } catch { return false; }
}
export function localModelLabel(item) {
  const label = String(item.label || item.relativePath || item.id || 'Local model').replace(/\s+\(\d+\/\d+ shards\)$/, '').split(/[\\/]/).at(-1).replace(/\.(?:gguf|safetensors)$/i, '').replace(/-\d{5}-of-\d{5}$/i, '');
  return label.length > 48 ? `${label.slice(0, 28)}…${label.slice(-19)}` : label;
}
export function localChoices(state, provider, configuredModel = '') {
  const choices = (state?.models || []).filter(item => item.format !== 'minimax-music3').map(item => ({ ...item, value: `download:${item.id}`, source: 'download', group: 'Downloads', disabled: !item.available, label: `${localModelLabel(item)}${Number.isFinite(item.sizeBytes) ? ` · ${formatBytes(item.sizeBytes)}` : ''}${!item.available ? ' — Unavailable' : ''}` }));
  const process = state?.process;
  if (process?.modelId && ['loading', 'ready', 'stopping'].includes(process.status)) {
    const running = choices.find(item => item.id === process.modelId);
    if (!running || running.disabled) {
      const retained = running || { id: process.modelId, value: `download:${process.modelId}`, source: 'download', group: 'Running local model', label: localModelLabel({ label: modelDisplayName(process.providerId, process.model, state.modelLabels, 'Current local model') }) };
      Object.assign(retained, { disabled: false, stopOnly: true, label: `${retained.label} — Stop only`, reason: 'The running model files are no longer available in this folder. Stop this process before choosing another model.' });
      if (!running) choices.push(retained);
    }
  }
  if (isLocalOllama(provider)) {
    for (const item of state?.installed || []) choices.push({ ...item, value: `installed:${item.id}`, source: 'installed', group: 'Installed in Ollama', label: localModelLabel(item) });
    if (configuredModel && !choices.some(item => item.source === 'installed' && item.id === configuredModel)) choices.push({ id: configuredModel, value: `configured:${configuredModel}`, source: 'installed', group: 'Configured model', label: `${localModelLabel({ id: configuredModel })} — ${state?.ollama?.online ? 'not installed' : 'not checked'}`, disabled: state?.ollama?.online === true, reason: state?.ollama?.online ? 'This model is not installed in the selected Ollama server. No download will be started automatically.' : 'Ollama is offline or could not be checked. Start verifies that this model is already installed; it does not download it.' });
  }
  return choices;
}
export function localSelection(state, choice, provider) {
  if (!choice || choice.disabled) return { canStart: false, canStop: false, canUse: false, note: choice?.reason || 'Choose a local model.' };
  const process = state?.process || {};
  if (choice.source === 'download') {
    const matches = process.modelId === choice.id;
    const busy = matches && ['loading', 'stopping'].includes(process.status);
    if (choice.stopOnly) return { canStart: false, canStop: matches && ['loading', 'ready'].includes(process.status), canUse: false, busy, note: choice.reason };
    const ready = matches && process.status === 'ready' && process.providerId && process.model;
    const otherActive = !matches && ['loading', 'ready', 'stopping'].includes(process.status);
    return { canStart: Boolean(choice.format==='safetensors'?state?.runtime?.safetensors?.available:state?.runtime?.available) && !['loading', 'ready', 'stopping'].includes(process.status), canStop: matches && ['loading', 'ready'].includes(process.status), canUse: Boolean(ready), busy,
      ...(ready ? { providerId: process.providerId, model: process.model } : {}),
      note: matches ? process.error || process.stage || ({ ready: 'Loaded and ready.', loading: 'Loading model…', stopping: 'Stopping model…', stopped: 'Model stopped.', failed: 'Model failed to load.' }[process.status]) || 'Not loaded.' : otherActive ? `Another local model is ${process.status === 'ready' ? 'loaded' : process.status}: ${state.models?.find(item => item.id === process.modelId)?.label || process.modelId || 'local runtime'}. Select it and stop it before starting this model.` : choice.format==='safetensors'?'Native CPU Safetensors · Default context. Loading as float32 can use more RAM than the download size.':'Not loaded.',
    };
  }
  const loaded = (state?.loaded || []).includes(choice.id);
  return { canStart: !loaded, canStop: loaded, canUse: true, providerId: provider?.id, model: choice.id, note: loaded ? 'Loaded in Ollama.' : choice.reason || 'Installed in Ollama; not currently loaded.' };
}
export function preferredLocalChoice(state, choices, provider, configuredModel, previous) {
  const configured = state.modelLabels?.find(item => item.model === configuredModel && item.providerId === (provider?.id || state.managedProviderId));
  const explicit = choices.find(item => item.value === previous) || choices.find(item => item.source === 'installed' && item.id === configuredModel);
  if (explicit) return explicit;
  if (configured?.modelId) return choices.find(item => item.source === 'download' && item.id === configured.modelId);
  return choices.find(item => item.source === 'download' && item.id === state.process?.modelId);
}

export function createLocalPicker({ request, subscribe, el, onChange, onManagedProvider, getContextTokens = () => null }) {
  const root = el('section', 'local-model-picker'); root.hidden = true;
  const label = el('label', 'form-row'); label.append(el('span', '', 'Local model'));
  const select = el('select'); select.id = 'chat-local-model'; label.append(select);
  const directory = el('p', 'hint local-model-directory'); directory.id = 'local-model-directory';
  const detail = el('p', 'hint'); detail.id = 'local-model-detail';
  const status = el('p', 'local-model-status'); status.id = 'local-model-status'; status.setAttribute('role', 'status');
  const progress = el('progress'); progress.id = 'local-model-progress'; progress.setAttribute('aria-label', 'Local model operation'); progress.hidden = true;
  const error = el('p', 'error-text hint'); error.id = 'local-model-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const controls = el('div', 'local-model-actions');
  const precision=createPrecisionControls({request,el,onChange:()=>{showError('');render();}});
  const hardware = createHardwareControls({ request, el, onChange: () => render() });
  root.append(label, directory, detail,precision.root, status, progress, error, controls, el('p', 'hint', 'Start loads the model without changing this chat. Stop unloads the model; it does not stop a chat run. Use in this chat applies your selection to the next run.'));
  root.append(hardware.root);
  let state = {}, provider, configuredModel = '', choices = [], enabled = false, disposed = false, loadingList = false, operation, connectionEpoch = 0, optionsSignature;
  const nextList = requestGate();
  const selected = () => choices.find(item => item.value === select.value);
  const selection = () => localSelection(state, selected(), provider);
  const showError = value => { error.hidden = !value; error.textContent = value || ''; };
  function render() {
    if (disposed) return;
    const previous = select.value; choices = localChoices(state, provider, configuredModel);
    const placeholder = loadingList && !choices.length ? 'Reading local models…' : 'Choose a local model';
    const signature = JSON.stringify([placeholder, choices.map(item => [item.value, item.label, item.group, Boolean(item.disabled)])]);
    if (signature !== optionsSignature) {
      optionsSignature = signature; select.replaceChildren();
      const empty = el('option', '', placeholder); empty.value = ''; select.append(empty);
      const groups = new Map();
      for (const choice of choices) {
        if (!groups.has(choice.group)) { const group = el('optgroup'); group.label = choice.group; groups.set(choice.group, group); select.append(group); }
        const option = el('option', '', choice.label); option.value = choice.value; option.title = choice.relativePath || choice.id; option.disabled = Boolean(choice.disabled); groups.get(choice.group).append(option);
      }
    }
    const current = preferredLocalChoice(state, choices, provider, configuredModel, previous);
    select.value = current?.value || ''; select.disabled = loadingList && !choices.length;
    directory.textContent = state.directory ? `Download folder: ${state.directory}` : 'Download folder is being checked…';
    const choice = selected(); const info = selection();
    const native=choice?.format==='safetensors';precision.setContext(state,choice);
    detail.textContent = choice ? `${choice.source === 'download' ? choice.relativePath || choice.label : choice.id}${choice.files?.length ? ` · ${choice.files.length} file${choice.files.length === 1 ? '' : 's'}` : ''}` : '';
    const ownOperation = operation && operation.value === select.value;
    status.textContent = ownOperation ? operation.label : !loadingList && !choices.length ? 'No local model files were found. Download a GGUF in Models, then refresh this folder.' : info.note;
    if(native&&state.process?.modelId===choice.id&&state.process.quantization)status.textContent+=` Requested load: ${state.process.quantization.mode==='none'?'original float32':state.process.quantization.mode.toUpperCase()}.${state.process.observed?.quantization?.accepted?' Native loader accepted this profile; individual layers may use different precision.':''}`;
    if ((!choice || choice.source === 'download') && state.runtime?.available === false&&choice?.format!=='safetensors') status.textContent += ` ${state.runtime.reason || 'The local model runtime is unavailable.'}`;
    if (isLocalOllama(provider) && state.ollama?.error) status.textContent += ` Ollama: ${state.ollama.error}`;
    progress.hidden = !(ownOperation || info.busy);
    hardware.setContext(state, !provider || choice?.source === 'download');
    start.disabled = Boolean(operation) || !info.canStart || choice?.source === 'download' && hardware.isDirty()||native&&!precision.ready();
    stop.disabled = operation?.type === 'stop' || !(info.canStop || ownOperation && operation.type === 'start');
    refreshButton.disabled = loadingList;
    onChange();
  }
  async function refreshList({ quiet = false } = {}) {
    const current = nextList(); const requestProvider = provider?.id; loadingList = true;
    if (!quiet) showError(''); render();
    try {
      const result = await request('localModels.list', isLocalOllama(provider) ? { providerId: requestProvider } : {});
      if (!current() || disposed) return;
      state = result; onManagedProvider(result.managedProviderId); loadingList = false; render();
    } catch (failure) { if (current() && !disposed) { loadingList = false; showError(failure.message || String(failure)); render(); } }
  }
  async function operate(type) {
    const choice = selected(); if (!choice) return;
    if (type === 'start' && choice.source === 'download' && hardware.isDirty()) { showError('Save hardware settings before starting this model.'); return; }
    const requestProvider = provider; const value = select.value; const epoch = connectionEpoch;
    const params = choice.source === 'download' ? type === 'start' ? { modelId: choice.id, contextTokens: getContextTokens(),...(choice.format==='safetensors'?{quantization:precision.profile()}:{}) } : {} : { providerId: requestProvider.id, model: choice.id };
    const token = { value, type, label: type === 'start' ? 'Starting model…' : 'Stopping model…' }; operation = token; showError(''); render();
    try {
      const result = await request(`localModels.${type}`, params);
      if (!disposed && epoch === connectionEpoch && operation === token && select.value === value && choice.source === 'installed' && result?.model) {
        // Ollama may resolve a configured alias to its installed :latest name.
        configuredModel = result.model; select.value = `installed:${result.model}`;
      }
    }
    catch (failure) { if (!disposed && epoch === connectionEpoch && operation === token) showError(failure.message || String(failure)); }
    finally { if (operation === token) operation = undefined; if (!disposed && epoch === connectionEpoch) await refreshList({ quiet: true }); }
  }
  const control = (text, callback) => { const node = el('button', 'button', text); node.type = 'button'; node.addEventListener('click', callback); return node; };
  const refreshButton = control('Refresh folder', () => refreshList()); refreshButton.id = 'local-model-refresh';
  const start = control('▶', () => operate('start')); start.id = 'local-model-start'; start.classList.add('model-start'); start.title = 'Start model'; start.setAttribute('aria-label', 'Start model');
  const stop = control('■', () => operate('stop')); stop.id = 'local-model-stop'; stop.classList.add('model-stop'); stop.title = 'Stop model'; stop.setAttribute('aria-label', 'Stop model');
  controls.append(refreshButton, start, stop);
  select.addEventListener('change', () => { showError(''); render(); });
  let unsubscribe;
  const dispose = () => { disposed = true; nextList();precision.dispose(); unsubscribe?.(); };
  unsubscribe = subscribe?.(event => {
    // A different modal can replace this panel without closing the dialog.
    if (!root.isConnected) { dispose(); return; }
    if (event.type === 'localModels' && enabled && !disposed) refreshList({ quiet: true });
  });
  return {
    root, selection,
    configure(nextProvider, model = '', active = true) {
      nextList(); connectionEpoch++; provider = nextProvider; configuredModel = model; enabled = active; root.hidden = !active; state = {}; select.value = ''; loadingList = false; operation = undefined;
      if (active) refreshList();
    },
    async discover() { try { const result = await request('localModels.list'); if (!disposed && root.isConnected) onManagedProvider(result.managedProviderId); } catch { /* Local controls show actionable errors when opened. */ } },
    dispose,
  };
}
