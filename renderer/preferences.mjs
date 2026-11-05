import { providerKindLabel } from './connections.mjs';

// A chat owns a snapshot. Merely reopening a picker must never replace it with
// a newer library revision (including an intentionally empty custom prompt).
export function promptSelection(chat, presets, selectedId, changed = false) {
  if (chat && !changed) return { systemPromptPresetId: chat.systemPromptPresetId ?? null, ...(typeof chat.systemPrompt === 'string' ? { systemPrompt: chat.systemPrompt } : {}) };
  const preset = presets.find(item => item.id === selectedId) || (!chat ? presets.find(item => item.id === 'general') : undefined);
  return preset ? { systemPromptPresetId: preset.id, systemPrompt: preset.text } : { systemPromptPresetId: null, systemPrompt: chat?.systemPrompt ?? '' };
}

export function runTimeoutChoice(mode, minutes) {
  if (mode === 'off') return 0;
  if (mode !== 'enabled' || String(minutes).trim() === '') throw new Error('Enter an overall run duration in minutes.');
  const milliseconds = Math.round(Number(minutes) * 60000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1000 || milliseconds > 2147483647) throw new Error('Choose an overall run duration from 1 second to 35,791 minutes, or turn the limit off.');
  return milliseconds;
}

export function createPreferences({ workspaceControls, request, refresh, getState, getChat, modal, closeModal, el, button, field, selectField, actions, notify, wordmark, connections, modelsBrowser, addonManager, showVoice, showTools, refreshInterface, getErrors, showOpenAI }) {
  const categories = [['ui', 'UI'], ['prompts', 'System prompts'], ['connections', 'Connections'], ['models', 'Models & hardware'], ['voice', 'Voice'], ['addons', 'Addons'], ['profiles', 'Profiles'], ['external', 'External access'], ['about', 'About & support']];
  function createPromptChoice() {
    const chat = getChat(), presets = getState().promptPresets || [];
    const choice = selectField('System prompt for this chat', [...(chat ? [{ value: '__current__', label: `Keep current · ${presets.find(item => item.id === chat.systemPromptPresetId)?.name || 'Custom'}` }] : []), ...presets.map(item => ({ value: item.id, label: item.name }))], chat ? '__current__' : 'general');
    choice.input.id = 'chat-prompt-preset';
    choice.wrapper.append(el('small', '', 'Changes apply to the next run. Edit prompt text in Settings → System prompts.'));
    return { root: choice.wrapper, value: () => promptSelection(chat, presets, choice.input.value, choice.input.value !== '__current__') };
  }
  function show(category = 'ui', presetId) {
    if (!categories.some(([id]) => id === category)) category = 'ui';
    const body = modal('Settings'), layout = el('div', 'settings-layout'), nav = el('nav', 'settings-categories'), pane = el('section', 'settings-pane');
    nav.setAttribute('aria-label', 'Settings categories'); body.dataset.settingsCategory = category;
    for (const [id, name] of categories) { const item = button(name, () => show(id), `nav-button${category === id ? ' selected' : ''}`); item.dataset.settingsCategory = id; if (category === id) item.setAttribute('aria-current', 'page'); nav.append(item); }
    layout.append(nav, pane); body.append(layout);
    const settings = getState().settings || {};
    if (category === 'ui') {
      pane.append(el('h3', '', 'Interface'));
      const theme = selectField('Theme', ['system', 'dark', 'light'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })), settings.theme || 'system'); theme.input.id = 'settings-theme';
      theme.input.addEventListener('change', () => save({ theme: theme.input.value }));
      const scale = field('Interface scale', '', 'range'); scale.input.id = 'settings-ui-scale'; scale.input.min = '.75'; scale.input.max = '1.5'; scale.input.step = '.05'; scale.input.value = settings.uiScale ?? 1;
      const percentage = el('output', 'scale-value'); percentage.htmlFor = scale.input.id;
      const update = () => { percentage.value = `${Math.round(Number(scale.input.value) * 100)}%`; scale.input.setAttribute('aria-valuetext', percentage.value); }; update(); scale.input.addEventListener('input', update);
      scale.input.addEventListener('change', () => save({ uiScale: Number(scale.input.value) })); scale.wrapper.append(percentage);
      pane.append(theme.wrapper, scale.wrapper, button('Reset scale to 100%', async () => { await save({ uiScale: 1 }); scale.input.value = '1'; update(); }), el('p', 'hint', 'Scales the entire interface, including text, buttons, and dialogs.'), button('Open quick start', showQuickStart));
      const runControls = el('section', 'modal-section'); runControls.append(el('h3', '', 'Overall run time limit'));
      const timeoutMode = selectField('Run time limit', [{ value: 'enabled', label: 'Enabled · custom duration' }, { value: 'off', label: 'Off · no overall time limit' }], settings.runTimeoutMs === 0 ? 'off' : 'enabled'); timeoutMode.input.id = 'settings-run-timeout-mode';
      const timeoutMinutes = field('Duration in minutes', settings.runTimeoutMs > 0 ? settings.runTimeoutMs / 60000 : 10, 'number'); timeoutMinutes.input.id = 'settings-run-timeout-minutes'; timeoutMinutes.input.min = String(1 / 60); timeoutMinutes.input.max = String(2147483647 / 60000); timeoutMinutes.input.step = 'any';
      const updateTimeout = () => { timeoutMinutes.input.disabled = timeoutMode.input.value === 'off'; }; timeoutMode.input.addEventListener('change', updateTimeout); updateTimeout();
      const saveTimeout = button('Save run time limit', async () => {
        const runTimeoutMs = runTimeoutChoice(timeoutMode.input.value, timeoutMinutes.input.value);
        timeoutMode.input.disabled = timeoutMinutes.input.disabled = true;
        try {
          await request('settings.update', { runTimeoutMs }); await refresh();
          timeoutMinutes.input.defaultValue = timeoutMinutes.input.value; for (const option of timeoutMode.input.options) option.defaultSelected = option.selected; body.dataset.settingsClean = 'true';
          notify(runTimeoutMs === 0 ? 'Overall run time limit is off. Stop remains available.' : 'Overall run time limit saved.');
        } finally { timeoutMode.input.disabled = false; updateTimeout(); }
      }, 'button primary'); saveTimeout.id = 'settings-save-run-timeout';
      runControls.append(timeoutMode.wrapper, timeoutMinutes.wrapper, el('p', 'hint', 'Applies to running and future tasks. Duration is measured from each task’s original start. A shorter limit can stop work that has already exceeded it. Stop and Force stop remain available. Individual tool and network timeouts are separate.'), saveTimeout); pane.append(runControls);
    } else if (category === 'prompts') renderPrompts(pane, presetId);
    else if (category === 'connections') {
      pane.append(el('h3', '', 'Model connections'), el('p', 'hint', 'Choose a saved connection in the model selector to use it for a chat.'), button('OpenAI / ChatGPT accounts', showOpenAI));
      for (const provider of getState().providers.filter(item => item.authKind !== 'chatgpt')) { const row = button('', () => connections.showForm(provider), 'provider-row'), text = el('span'); text.append(el('strong', '', provider.name), el('small', '', `${providerKindLabel(provider.kind)} · ${provider.baseUrl}`)); row.append(text, el('span', '', 'Edit')); pane.append(row); }
      pane.append(actions(button('Add local connection', () => connections.showForm(undefined, 'ollama')), button('Add cloud/API connection', () => connections.showForm())));
    } else if (category === 'models') {
      pane.append(el('h3', '', 'Local hardware'), el('p', 'hint', 'Before starting a local model, select the CPU and GPUs you want it to use. Check disk offloading in its hardware settings if you want to allow memory-mapped model files.'), button('Choose hardware & local model', showHardware)); modelsBrowser.mountSettings(pane);
    } else if (category === 'voice') {
      pane.append(el('h3', '', 'Voice'), el('p', 'hint', 'Activation phrases and spoken replies are set per chat. Use Dictate to add speech to your draft, or Start assistant to listen for the chat’s activation phrase.'), button('Voice controls for this chat', showVoice));
    } else if (category === 'addons') {
      pane.append(el('h3', '', 'Local addons'), el('p', 'hint', 'Enable, disable, or remove addons installed on this computer.'), button('Manage addons', () => addonManager.show()));
    } else if (category === 'profiles' || category === 'external') {
      const mount = category === 'profiles' ? workspaceControls.mountProfiles : workspaceControls.mountGateway;
      void mount(pane).catch(error => { if (pane.isConnected) pane.append(el('p', 'error-text', error.message)); });
    } else {
      pane.append(wordmark('about-wordmark'), el('h3', '', 'Faber a2.1'), el('p', 'hint', 'Your workspace. Your assistant.'), button('Report a bug', showBugReport), button('Open quick start', showQuickStart), button('Tools & extensions', () => showTools('extensions')), button('Restart app', () => request('app.restart')));
    }
    const reload = button('Refresh interface', () => refreshInterface(true)); reload.id = 'reload-ui';
    body.append(el('p', 'hint settings-footer-note', 'Refresh interface keeps loaded models and composer drafts. Backend changes require Restart app.'), actions(reload, button('Done', closeModal)));
    body.dataset.settingsClean = 'true';
    body.oninput = () => { body.dataset.settingsClean = 'false'; };
    async function save(values) { try { await request('settings.update', values); await refresh(); if (values.theme) for (const option of pane.querySelector('#settings-theme').options) option.defaultSelected = option.selected; body.dataset.settingsClean = 'true'; } catch (error) { notify(error.message, true); } }
  }
  function showHardware() { connections.showHardware(); }
  function renderPrompts(pane, presetId) {
    const presets = getState().promptPresets || [], selected = presets.find(item => item.id === presetId) || presets[0];
    pane.append(el('h3', '', 'System prompts'), el('p', 'hint', 'Library edits affect future selections. Existing chats keep their saved text until you apply a prompt to that chat. Changes apply to the next run.'));
    if (!selected) { pane.append(el('p', 'hint', 'No prompt presets are available.')); return; }
    const picker = selectField('Preset', presets.map(item => ({ value: item.id, label: `${item.name}${item.builtin ? ' · built in' : ''}` })), selected.id); picker.input.id = 'prompt-library-preset';
    picker.input.addEventListener('change', () => show('prompts', picker.input.value));
    const name = field('Name', selected.name), text = field('Instructions', selected.text, 'textarea', 'These instructions guide the model. They do not change tool permissions.'); name.input.id = 'prompt-preset-name'; text.input.id = 'prompt-preset-text'; text.input.rows = 12;
    const savePreset = async () => { const value = await request('promptPresets.save', { id: selected.id, name: name.input.value, text: text.input.value }); await refresh(); return value; };
    const controls = actions(button('New preset', async () => { const value = await request('promptPresets.save', { name: 'Custom prompt', text: '' }); await refresh(); show('prompts', value.id); }), button('Save preset', async () => { await savePreset(); show('prompts', selected.id); notify('Prompt preset saved. Existing chats keep their instructions.'); }, 'button primary'));
    if (selected.builtin) controls.append(button('Restore default', async () => { await request('promptPresets.reset', { id: selected.id }); await refresh(); show('prompts', selected.id); }));
    if (!selected.builtin) controls.append(button('Delete preset', async () => { await request('promptPresets.delete', { id: selected.id }); await refresh(); show('prompts'); }, 'button danger'));
    const chat = getChat(); if (chat) controls.append(button('Apply to this chat', async () => { await savePreset(); await request('chat.update', { id: chat.id, systemPromptPresetId: selected.id, systemPrompt: text.input.value }); await refresh(); show('prompts', selected.id); notify('Prompt applied to this chat’s next run.'); }));
    pane.append(picker.wrapper, name.wrapper, text.wrapper, controls);
  }
  function showQuickStart() {
    const body = modal('Welcome to Faber'); body.classList.add('quick-start');
    if (!getState().settings?.onboardingComplete) void request('settings.update', { onboardingComplete: true }).then(refresh).catch(error => notify(error.message, true));
    body.append(wordmark('about-wordmark'), el('h3', '', 'Choose how you want to work'), el('p', 'hint', 'Connect an account or use a local model. You can return to this setup from Settings.'));
    const choices = el('div', 'quick-start-choices');
    const chatgpt = button('Continue with ChatGPT', showOpenAI, 'button chatgpt-signin'); chatgpt.id = 'quickstart-chatgpt'; const logo = el('img'); logo.src = 'assets/chatgpt-logo-white.svg'; logo.alt = ''; chatgpt.prepend(logo);
    const claude = el('button', 'button claude-coming-soon'); claude.type = 'button'; claude.title = 'Coming Soon'; claude.setAttribute('aria-disabled', 'true'); claude.setAttribute('aria-label', 'Claude — Coming Soon'); const claudeLogo = el('img'); claudeLogo.src = 'assets/claude-logo.svg'; claudeLogo.alt = ''; claude.append(claudeLogo, el('span', '', 'Claude'), el('span', 'coming-soon-label', 'Coming Soon')); choices.append(chatgpt, claude);
    body.append(choices, el('h3', '', 'Running a model on this PC?'), el('p', 'hardware-guidance', 'Select the CPU and GPUs you want to use before starting a local model. Hardware choices control where the model runs.'), button('Choose local hardware & model', showHardware), button('Connect another API', () => connections.showForm()));
    const done = button('Done for now', async () => { await request('settings.update', { onboardingComplete: true }); await refresh(); closeModal(); }, 'button primary'); done.id = 'quickstart-done'; body.append(actions(done));
  }
  async function showBugReport() {
    const body = modal('Report a bug'); body.append(el('p', 'hint', 'Review and edit this draft before opening GitHub. Faber removes common credentials and local paths; check it for anything else you want to keep private. Nothing is submitted automatically.'));
    const result = el('p', 'hint', 'Preparing a report from recent errors…'); body.append(result);
    try {
      const draft = await request('app.bugReportDraft', { errors: getErrors() }); if (!result.isConnected) return;
      result.remove(); const title = field('Issue title', draft.title), report = field('Report · add what happened and steps to reproduce', draft.body, 'textarea'); title.input.id = 'bug-report-title'; report.input.id = 'bug-report-body'; report.input.rows = 16;
      body.append(title.wrapper, report.wrapper, actions(button('Cancel', closeModal), button('Review on GitHub', async () => { await request('app.reportIssue', { title: title.input.value, body: report.input.value }); closeModal(); }, 'button primary')));
    } catch (error) { if (result.isConnected) { result.textContent = error.message; result.classList.add('error-text'); } }
  }
  return { show, showQuickStart, showBugReport, createPromptChoice };
}
