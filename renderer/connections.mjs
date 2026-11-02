import { requestGate } from './model-helpers.mjs';
import { LOCAL_FILES, isLocalOllama, createLocalPicker } from './local-picker.mjs';

export const CONNECTION_PRESETS = [
  { value: 'openai-responses', label: 'OpenAI Responses API', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { value: 'openai', label: 'OpenAI-compatible Chat Completions', name: 'Compatible API', baseUrl: 'http://127.0.0.1:1234/v1' },
  { value: 'ollama', label: 'Ollama server', name: 'Local Ollama', baseUrl: 'http://127.0.0.1:11434' },
];
export const SUGGESTED_OPENAI_MODELS = ['gpt-6-astra', 'gpt-6.1-sol'];
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function providerKindLabel(kind) { return CONNECTION_PRESETS.find(preset => preset.value === kind)?.label || kind; }
export function connectionPayload(values) {
  if (values.clearKey && values.apiKey) throw new Error('Either enter a replacement API key or remove the saved key.');
  return { ...(values.id ? { id: values.id } : {}), name: values.name.trim(), kind: values.kind, baseUrl: values.baseUrl.trim(), model: values.model.trim(),
    ...(values.kind === 'openai-responses' ? { reasoningEffort: values.reasoningEffort || '' } : {}),
    ...(values.clearKey ? { apiKey: '' } : values.apiKey ? { apiKey: values.apiKey } : {}) };
}

export function createConnections({ request, refresh, getState, getChat, newChat, modal, closeModal, el, button, field, selectField, checkedRow, actions, showSettings, subscribe = globalThis.window?.faber?.subscribe }) {
  let disposePicker = () => {};
  const notice = provider => provider?.kind === 'ollama'
    ? 'Uses your Ollama server with the same Faber tools, approvals, and upgrade controls.'
    : 'Conversation text and tool results are sent to this API endpoint. Cloud API usage is billed by the provider. Faber’s tools, approvals, and upgrade controls remain available.';
  function suggestions(model, kind) {
    const root = el('div', 'connection-suggestions');
    root.append(el('p', 'hint', 'Suggested OpenAI model IDs. Availability depends on your API account; you can also list models or enter an exact ID.'));
    const choices = el('div', 'connection-models');
    for (const id of SUGGESTED_OPENAI_MODELS) choices.append(button(id, () => { model.input.value = id; }));
    root.append(choices); root.hidden = kind !== 'openai-responses'; return root;
  }
  function showForm(provider, presetKind = 'openai-responses', returnToPicker = false) {
    disposePicker();
    const preset = CONNECTION_PRESETS.find(item => item.value === (provider?.kind || presetKind)) || CONNECTION_PRESETS[0];
    const body = modal(provider ? 'Edit model connection' : 'Add model connection'); const form = el('div', 'form-grid');
    body.append(el('p', 'hint', 'Saving a connection leaves your current chat unchanged. Choose it with “Use in this chat” when you are ready.'));
    const name = field('Connection name', provider?.name || preset.name); name.input.id = 'connection-name';
    const kind = selectField('Connection type', CONNECTION_PRESETS, preset.value); kind.input.id = 'connection-kind';
    const url = field('Base URL', provider?.baseUrl || preset.baseUrl, 'url'); url.input.id = 'connection-url';
    const model = field('Default model', provider?.model || '', 'text', 'Enter the exact API model ID, or choose a listed model below.'); model.input.id = 'connection-model';
    const recommended = suggestions(model, kind.input.value);
    const effort = selectField('Reasoning effort', [{ value: '', label: 'API default' }, ...REASONING_EFFORTS.map(value => ({ value, label: value }))], provider?.reasoningEffort || ''); effort.input.id = 'connection-reasoning';
    effort.wrapper.append(el('small', '', 'Applies to this Responses connection. Higher effort can increase response time and usage.'));
    const key = field('API key', '', 'password', provider?.hasKey ? 'A key is saved. Leave blank to keep it. Changing the endpoint origin requires a replacement key or removing the saved key.' : 'Stored encrypted on this computer. Most local servers do not require a key.'); key.input.id = 'connection-key'; key.input.autocomplete = 'new-password';
    const clearKey = checkedRow('Remove saved API key', false); clearKey.input.id = 'connection-clear-key'; clearKey.wrapper.hidden = !provider?.hasKey;
    const disclosure = el('p', 'hint connection-disclosure'); disclosure.id = 'connection-disclosure';
    form.append(name.wrapper, kind.wrapper, url.wrapper, model.wrapper, recommended, effort.wrapper, key.wrapper, clearKey.wrapper); body.append(form, disclosure);
    const result = el('div', 'inline-result'); result.id = 'connection-result'; result.hidden = true; result.setAttribute('role', 'status'); body.append(result);
    const nextList = requestGate();
    for (const event of ['input', 'change']) form.addEventListener(event, () => { nextList(); result.hidden = true; });
    let savedId = provider?.id; let previousPreset = preset;
    function updateType() { recommended.hidden = kind.input.value !== 'openai-responses'; effort.wrapper.hidden = kind.input.value !== 'openai-responses'; disclosure.textContent = notice({ kind: kind.input.value }); }
    kind.input.addEventListener('change', () => {
      const next = CONNECTION_PRESETS.find(item => item.value === kind.input.value);
      if (!provider) { if (name.input.value === previousPreset.name) name.input.value = next.name; if (url.input.value === previousPreset.baseUrl) url.input.value = next.baseUrl; }
      previousPreset = next; updateType();
    }); updateType();
    let pendingSave;
    const save = async () => {
      if (pendingSave) return pendingSave;
      if (!name.input.value.trim() || !url.input.value.trim()) throw new Error('Enter a connection name and base URL.');
      const submittedKey = key.input.value;
      const submittedClear = clearKey.input.checked;
      const payload = connectionPayload({ id: savedId, name: name.input.value, kind: kind.input.value, baseUrl: url.input.value, model: model.input.value, reasoningEffort: effort.input.value, apiKey: submittedKey, clearKey: clearKey.input.checked });
      pendingSave = (async () => {
        const saved = await request('provider.save', payload); savedId = saved.id;
        if (key.input.value === submittedKey) key.input.value = '';
        if (clearKey.input.checked === submittedClear) clearKey.input.checked = false;
        clearKey.wrapper.hidden = !saved.hasKey;
        await refresh(); return saved;
      })();
      try { return await pendingSave; } finally { pendingSave = undefined; }
    };
    const fail = error => { result.hidden = false; result.textContent = error.message || String(error); result.classList.add('error'); };
    body.append(actions(button('Back', () => returnToPicker ? showPicker() : showSettings()), button('Save & list models', async () => {
      const current = nextList();
      result.hidden = false; result.textContent = 'Saving and testing model-list access…'; result.classList.remove('error');
      try {
        const saved = await save(); if (!current()) return;
        const test = await request('provider.test', { id: saved.id }); if (!current()) return;
        result.textContent = test.ok ? 'Connection responded. No inference request was sent.' : test.error || 'Connection failed.'; result.classList.toggle('error', !test.ok);
        if (test.models?.length) {
          const choices = selectField('Available models', test.models.map(item => ({ value: typeof item === 'string' ? item : item.id || item.name, label: typeof item === 'string' ? item : item.id || item.name })), model.input.value);
          choices.input.selectedIndex = Math.max(0, choices.input.selectedIndex);
          result.append(choices.wrapper, button('Set default model', () => { model.input.value = choices.input.value; result.textContent = `Selected ${choices.input.value}. Save the connection to keep this default.`; }));
        }
      } catch (error) { if (current()) fail(error); }
    }), button('Save connection', async () => { try { const saved = await save(); returnToPicker ? showPicker(saved.id) : showSettings(); } catch (error) { fail(error); } }, 'button primary')));
  }
  function showPicker(preferredProviderId) {
    disposePicker();
    const state = getState(); const chat = getChat();
    const selected = state.providers.find(provider => provider.id === (preferredProviderId || chat?.providerId)) || state.providers[0];
    const body = modal('Model for this chat');
    const connect = button('Add cloud/API connection', () => showForm(undefined, 'openai-responses', true)); connect.id = 'add-cloud-connection';
    body.append(el('p', 'hint', 'Choose a local model or API connection. “Use in this chat” applies to the next run; an active run keeps its current connection.'), connect);
    const provider = selectField('Connection', [{ value: LOCAL_FILES, label: 'Downloaded models (local)' }, ...state.providers.map(item => ({ value: item.id, label: `${item.name} — ${providerKindLabel(item.kind)}` }))], selected?.id || LOCAL_FILES); provider.input.id = 'chat-connection';
    const model = field('Model', !preferredProviderId && chat?.model || selected?.model || ''); model.input.id = 'chat-model';
    const recommended = suggestions(model, selected?.kind);
    const detail = el('p', 'hint connection-disclosure'); detail.id = 'chat-connection-note';
    const form = el('div', 'form-grid connection-picker-form'); form.append(provider.wrapper, model.wrapper, recommended, detail); body.append(form);
    const result = el('div', 'inline-result'); result.id = 'chat-model-list'; result.hidden = true; result.setAttribute('role', 'status'); body.append(result);
    const nextList = requestGate();
    function selectedProvider() { return getState().providers.find(item => item.id === provider.input.value); }
    const isLocal = () => provider.input.value === LOCAL_FILES || isLocalOllama(selectedProvider());
    let useButton, applying = false;
    const local = createLocalPicker({ request, subscribe, el, getContextTokens: () => getChat()?.contextTokens ?? null, onChange: () => { if (useButton) useButton.disabled = applying || isLocal() && !local.selection().canUse; }, onManagedProvider: id => {
      if (id && provider.input.value === id) { provider.input.value = LOCAL_FILES; updateDetail(); }
      if (id) [...provider.input.options].find(option => option.value === id)?.remove();
    } });
    form.insertBefore(local.root, recommended);
    const dialog = body.closest('dialog');
    const cleanup = () => { local.dispose(); dialog?.removeEventListener('close', cleanup); };
    disposePicker = cleanup; dialog?.addEventListener('close', cleanup, { once: true });
    function updateDetail() {
      const current = selectedProvider(); const active = isLocal();
      model.wrapper.hidden = active; recommended.hidden = active || current?.kind !== 'openai-responses'; listButton.hidden = active;
      detail.textContent = provider.input.value === LOCAL_FILES ? 'Runs downloaded GGUF files locally with the bundled model server. Faber’s tools, approvals, and upgrade controls remain available.' : `${current?.baseUrl || ''}${current?.reasoningEffort ? ` · Reasoning: ${current.reasoningEffort}` : ''}\n${notice(current)}`;
      local.configure(current, model.input.value, active); useButton.disabled = applying || active && !local.selection().canUse;
    }
    provider.input.addEventListener('change', () => { nextList(); model.input.value = selectedProvider()?.model || ''; result.replaceChildren(); result.hidden = true; updateDetail(); });
    const listButton = button('List models', async () => {
      const current = nextList(); const id = provider.input.value; result.hidden = false; result.textContent = 'Listing models…'; result.classList.remove('error');
      try {
        const test = await request('provider.test', { id }); if (!current()) return;
        if (!test.ok) throw new Error(test.error || 'Connection failed.');
        result.replaceChildren();
        if (!test.models?.length) result.textContent = 'The server returned no models. Enter an exact model ID above.';
        for (const item of test.models || []) { const id = typeof item === 'string' ? item : item.id || item.name; result.append(button(id, () => { model.input.value = id; }, 'nav-button')); }
      } catch (error) { if (current()) { result.textContent = error.message || String(error); result.classList.add('error'); } }
    });
    useButton = el('button', 'button primary', 'Use in this chat'); useButton.type = 'button'; useButton.id = 'chat-use-model';
    useButton.addEventListener('click', async () => {
      if (applying) return; applying = true; useButton.disabled = true;
      try {
        const localChoice = isLocal() ? local.selection() : null;
        if (localChoice && !localChoice.canUse) throw new Error('Start the downloaded model and wait until it is ready.');
        const chosenProvider = localChoice ? localChoice.providerId : provider.input.value;
        const chosenModel = localChoice ? localChoice.model : model.input.value.trim();
        if (!chosenModel) throw new Error('Enter a model ID.');
        const target = getChat() || await newChat(); if (!target) return;
        await request('chat.update', { id: target.id, providerId: chosenProvider, model: chosenModel }); await refresh(); closeModal();
      } catch (error) { result.hidden = false; result.textContent = error.message || String(error); result.classList.add('error'); }
      finally { applying = false; useButton.disabled = isLocal() && !local.selection().canUse; }
    });
    body.append(actions(button('Connections', () => { cleanup(); showSettings(); }), listButton, useButton));
    updateDetail(); if (!isLocal()) local.discover();
  }
  return { showForm, showPicker };
}
