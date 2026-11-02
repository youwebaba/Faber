import { formatBytes, requestGate } from './model-helpers.mjs';

export function hardwarePayload(values, hardware) {
  const mode = values.mode;
  if (!['auto', 'cpu', 'custom'].includes(mode)) throw new Error('Choose Auto, CPU, or Custom hardware.');
  const gpuIds = mode === 'custom' ? [...new Set(values.gpuIds)] : [];
  const cpuIds = mode === 'auto' ? [] : [...new Set(values.cpuIds)];
  const threads = mode === 'auto' ? 0 : Number(values.threads);
  if (mode !== 'auto' && values.automaticCpus === false && !cpuIds.length) throw new Error('Select at least one logical CPU, or enable automatic CPU selection.');
  if (mode === 'custom' && !gpuIds.length) throw new Error('Select a supported GPU for Custom mode, or choose CPU.');
  if (gpuIds.some(id => !hardware.gpus.some(gpu => gpu.id === id))) throw new Error('A selected GPU is no longer available. Refresh hardware.');
  if (cpuIds.some(id => !hardware.cpus.some(cpu => cpu.id === id))) throw new Error('A selected CPU is no longer available. Refresh hardware.');
  if (!Number.isSafeInteger(threads) || threads < 0 || threads > (cpuIds.length || hardware.cpus.length)) throw new Error('Choose a thread count from 0 (automatic) to the number of selected logical CPUs.');
  return { mode, gpuIds, cpuIds, threads, memoryMap: Boolean(values.memoryMap) };
}

export function createHardwareControls({ request, el, onChange }) {
  const root = el('details', 'hardware-controls'); root.id = 'local-hardware'; root.append(el('summary', '', 'Hardware & memory'));
  const note = el('p', 'hint', 'Managed GGUF models only. Saved settings apply to the next Start; stop the current local model before changing them.');
  const form = el('fieldset', 'hardware-form'); const modeLabel = el('label', 'form-row'); modeLabel.append(el('span', '', 'Hardware mode'));
  const mode = el('select'); mode.id = 'hardware-mode'; for (const [value, text] of [['auto', 'Auto'], ['cpu', 'CPU only'], ['custom', 'Custom']]) { const option = el('option', '', text); option.value = value; mode.append(option); } modeLabel.append(mode);
  const gpus = el('div', 'hardware-devices'); gpus.id = 'hardware-gpus';
  const cpuSection = el('details', 'hardware-cpus'); cpuSection.append(el('summary', '', 'CPU selection'));
  const autoCpu = el('input'); autoCpu.type = 'checkbox'; autoCpu.id = 'hardware-auto-cpu'; autoCpu.checked = true;
  const autoLabel = el('label', 'hardware-check'); autoLabel.append(autoCpu, document.createTextNode('Use all permitted logical CPUs'));
  const cpus = el('div', 'hardware-cpu-grid'); cpus.id = 'hardware-cpus'; cpuSection.append(autoLabel, cpus);
  const threadLabel = el('label', 'form-row'); threadLabel.append(el('span', '', 'CPU threads'));
  const threads = el('input'); threads.type = 'number'; threads.min = '0'; threads.step = '1'; threads.value = '0'; threads.id = 'hardware-threads'; threadLabel.append(threads, el('small', '', '0 lets the runtime choose. CPU orchestration is still required when using a GPU.'));
  const memory = el('input'); memory.type = 'checkbox'; memory.checked = true; memory.id = 'hardware-memory-map';
  const memoryLabel = el('label', 'hardware-check'); memoryLabel.append(memory, document.createTextNode('Allow disk-backed memory'));
  form.append(modeLabel, gpus, cpuSection, threadLabel, memoryLabel, el('p', 'hint', 'Maps model weights from disk and lets the operating system page them as needed. This can be slower; it does not turn storage into GPU VRAM or guarantee that a model fits.'));
  const status = el('p', 'hint'); status.id = 'hardware-status'; status.setAttribute('role', 'status');
  const observed = el('div', 'hardware-observed'); observed.id = 'hardware-observed';
  const controls = el('div', 'local-model-actions'); const save = el('button', 'button', 'Save hardware settings'); save.type = 'button'; save.id = 'hardware-save';
  const refresh = el('button', 'button', 'Refresh hardware'); refresh.type = 'button'; refresh.id = 'hardware-refresh'; controls.append(refresh, save);
  root.append(note, form, controls, status, observed);
  let hardware, dirty = false, busy = false, process = {}, loaded = false;
  const nextRead = requestGate();
  const inputs = container => [...container.querySelectorAll('input')];
  const values = () => ({ mode: mode.value, gpuIds: inputs(gpus).filter(input => input.checked).map(input => input.value), cpuIds: autoCpu.checked ? [] : inputs(cpus).filter(input => input.checked).map(input => Number(input.value)), automaticCpus: autoCpu.checked, threads: threads.value, memoryMap: memory.checked });
  function update() {
    const active = ['loading', 'ready', 'stopping'].includes(process.status); form.disabled = active || busy || !hardware;
    for (const input of inputs(gpus)) input.disabled = mode.value !== 'custom' || hardware?.capabilities?.gpuSelection === false;
    autoCpu.disabled = mode.value === 'auto' || hardware?.capabilities?.cpuAffinity === false;
    for (const input of inputs(cpus)) input.disabled = mode.value === 'auto' || autoCpu.checked || hardware?.capabilities?.cpuAffinity === false;
    threads.disabled = mode.value === 'auto' || hardware?.capabilities?.threads === false;
    memory.disabled = hardware?.capabilities?.memoryMap === false;
    save.disabled = !dirty || busy || active || !hardware; refresh.disabled = busy;
    onChange();
  }
  function setValues(config) {
    mode.value = config.mode; autoCpu.checked = !config.cpuIds?.length; threads.value = String(config.threads ?? 0); memory.checked = config.memoryMap !== false;
    for (const input of inputs(gpus)) input.checked = config.gpuIds?.includes(input.value) || false;
    for (const input of inputs(cpus)) input.checked = !config.cpuIds?.length || config.cpuIds.includes(Number(input.value));
  }
  function renderDevices() {
    gpus.replaceChildren(el('h4', '', 'Supported GPUs')); cpus.replaceChildren();
    if (!hardware.gpus.length) gpus.append(el('p', 'hint', 'No supported GPU reported by this runtime. Auto or CPU mode remains available.'));
    for (const gpu of hardware.gpus) { const label = el('label', 'hardware-check'); const input = el('input'); input.type = 'checkbox'; input.value = gpu.id; input.dataset.gpuId = gpu.id; label.append(input, el('span', '', `${gpu.name} (${gpu.id}) · ${formatBytes(gpu.totalBytes)} VRAM${Number.isFinite(gpu.freeBytes) ? `, ${formatBytes(gpu.freeBytes)} free` : ''}`)); gpus.append(label); }
    for (const cpu of hardware.cpus) { const label = el('label', 'hardware-check'); const input = el('input'); input.type = 'checkbox'; input.value = String(cpu.id); input.dataset.cpuId = String(cpu.id); label.title = cpu.model || cpu.name; label.append(input, document.createTextNode(cpu.name || `CPU ${cpu.id}`)); cpus.append(label); }
    threads.max = String(hardware.cpus.length);
  }
  async function load() {
    const current = nextRead(); const draft = dirty ? values() : null; busy = true; update(); status.textContent = 'Detecting runtime devices…';
    try {
      const result = await request('localModels.hardware'); if (!current() || !root.isConnected) return;
      hardware = result; loaded = true; renderDevices(); setValues(draft || result.configuration);
      status.textContent = `${formatBytes(result.memory?.totalBytes)} system RAM. ${result.warnings?.join(' ') || ''}${draft ? ' Your unsaved choices were kept.' : ''}`;
    } catch (error) { if (current()) status.textContent = error.message || String(error); }
    finally { if (current()) { busy = false; update(); } }
  }
  form.addEventListener('input', () => { dirty = true; update(); }); form.addEventListener('change', () => { dirty = true; update(); });
  root.addEventListener('toggle', () => { if (root.open && !loaded) load(); }); refresh.addEventListener('click', load);
  save.addEventListener('click', async () => {
    try { const configuration = hardwarePayload(values(), hardware); busy = true; update(); const result = await request('localModels.configure', configuration); hardware = result; dirty = false; setValues(result.configuration); status.textContent = 'Hardware settings saved. They apply to the next model Start.'; }
    catch (error) { status.textContent = error.message || String(error); }
    finally { busy = false; update(); }
  });
  return { root, isDirty: () => dirty || busy,
    setContext(next, visible) {
      root.hidden = !visible; process = next.process || {};
      observed.replaceChildren(el('strong', '', 'Requested / observed'));
      const requested = process.requested || next.configuration;
      observed.append(el('p', 'hint', requested ? `${process.requested ? 'Last start requested' : 'Next start defaults'}: ${requested.mode}; GPUs ${requested.gpuIds?.join(', ') || 'automatic / none'}; CPUs ${requested.cpuIds?.join(', ') || 'automatic'}; threads ${requested.threads || 'automatic'}; disk-backed memory ${requested.memoryMap ? 'allowed' : 'disabled'}.` : 'Requested: defaults not reported.'));
      const actual = process.observed;
      observed.append(el('p', 'hint', actual ? `Observed: ${actual.verified ? actual.backend === 'gpu' ? 'GPU offload' : actual.backend === 'cpu' ? 'CPU execution' : 'Device unknown' : 'Not verified'}${actual.devices?.length ? ` on ${actual.devices.join(', ')}` : ''}. ${Number.isFinite(actual.gpuLayers) ? `${actual.gpuLayers} of ${actual.totalLayers ?? 'unknown'} layers offloaded.` : 'Layer offload not reported.'}` : 'Observed runtime devices: not reported. A saved request is not proof of actual offload.'));
      if (hardware) { const active = ['loading', 'ready', 'stopping'].includes(process.status); form.disabled = active || busy; save.disabled = !dirty || active || busy; }
    },
  };
}
