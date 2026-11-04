export function pendingUserMessages(chat) {
  const seen = new Set((chat?.messages || []).map(message => message.id));
  return (chat?.inbox || []).filter(item => item.source === 'user' && !seen.has(item.id) && seen.add(item.id)).map(item => ({ id: item.id, role: 'user', content: item.text, createdAt: item.createdAt, runId: item.runId, images: item.images, status: 'pending', steering: true }));
}
export function externalProviders(providers) {
  return (providers || []).filter(provider => !provider.authKind && !provider.id.startsWith('chatgpt:') && ['ollama', 'openai', 'openai-responses'].includes(provider.kind));
}
export function hasUnsentDrafts({ text = '', drafts = [], attachments = [], pending = false, fields = [] } = {}) {
  return pending || text.length > 0 || [...drafts].some(value => value.length > 0) || attachments.some(entry => entry.attachments?.length) || [...fields].some(input => {
    if (input.disabled || input.readOnly || ['button', 'submit', 'range'].includes(input.type)) return false;
    if (input.type === 'file') return input.files?.length > 0;
    if (['checkbox', 'radio'].includes(input.type)) return input.checked !== input.defaultChecked;
    if (input.tagName === 'SELECT') return [...input.options].some(option => option.selected !== option.defaultSelected);
    return input.value !== input.defaultValue;
  });
}
export function projectApprovalTitle(approval) {
  return approval.permission === 'project' || approval.kind === 'project' ? `Allow access to ${approval.projectName || 'the target project'}?` : `Allow ${approval.permission} access?`;
}

export function createWorkspaceControls({ request, subscribe, getState, modal, closeModal, el, button, field, selectField, actions, notify, hasDrafts, addonManager }) {
  let profiles, recovery, gatewayView;
  const profileButton = document.querySelector('#profile-switcher'), banner = document.querySelector('#safe-mode-status');
  const switchDialog = el('dialog', 'profile-switch-dialog'); switchDialog.id = 'profile-switch-dialog'; switchDialog.setAttribute('aria-labelledby', 'profile-switch-title'); document.body.append(switchDialog);
  for (const event of ['close', 'faber-modal-replace']) document.querySelector('#modal').addEventListener(event, () => gatewayView?.clearToken());
  profileButton.addEventListener('click', () => showSwitcher().catch(error => notify(error.message, true)));
  document.querySelector('#safe-manage-addons').addEventListener('click', () => addonManager.show());
  document.querySelector('#safe-restart-normal').addEventListener('click', () => request('app.restartNormal').catch(error => notify(error.message, true)));
  subscribe?.(event => { if (event.type === 'gateway' && gatewayView?.root.isConnected) gatewayView.update(event.state); else if (gatewayView && !gatewayView.root.isConnected) gatewayView = undefined; });
  async function loadProfiles() {
    profiles = await request('profiles.list');
    const current = profiles.profiles.find(profile => profile.id === profiles.currentId);
    profileButton.textContent = `Profile: ${current?.name || 'Unknown'}`; profileButton.title = 'Switch Faber profile'; profileButton.disabled = false;
    return profiles;
  }
  function setRecovery(value) {
    recovery = value; banner.hidden = !recovery.safeMode;
    document.querySelector('#safe-mode-reason').textContent = recovery.reason || 'All addons were suppressed at startup.';
  }
  function showRecovery() {
    const body = modal('Currently in SAFEMODE'); body.classList.add('safe-mode-popup');
    body.append(el('p', 'safe-mode-heading', 'Currently in SAFEMODE'), el('p', '', recovery.reason || 'Faber started with addon loading suppressed.'), el('p', 'hint', 'All addons are suppressed each Safe Mode startup. You can manage addons here; enabling an addon still requires its normal approval.'), actions(button('Manage addons', () => addonManager.show()), button('Restart normally', () => request('app.restartNormal')), button('Continue in Safe Mode', closeModal, 'button primary')));
  }
  async function showSwitcher(targetId) {
    await loadProfiles();
    switchDialog.replaceChildren();
    const title = el('h2', '', 'Switch profile'); title.id = 'profile-switch-title';
    const choice = selectField('Profile', profiles.profiles.map(profile => ({ value: profile.id, label: `${profile.name}${profile.current ? ' · current' : ''}` })), targetId || profiles.currentId); choice.input.id = 'switch-profile-choice';
    const status = el('p', 'hint'); status.setAttribute('role', 'status');
    const switchButton = button('Switch profile', async () => {
      const target = profiles.profiles.find(profile => profile.id === choice.input.value); if (!target || target.id === profiles.currentId) return;
      const perform = async () => {
        status.textContent = 'Requesting profile switch…';
        try {
          const result = await request('profiles.switch', { id: target.id, draftsCleared: true });
          status.textContent = result.restarting ? `Restarting in ${target.name}…` : 'This profile is already active.';
        } catch (error) { status.textContent = error.message; status.classList.add('error-text'); }
      };
      if (!hasDrafts()) { await perform(); return; }
      if (switchDialog.querySelector('#profile-discard-confirmation')) return;
      const confirmation = el('section', 'profile-discard-confirmation'); confirmation.id = 'profile-discard-confirmation';
      confirmation.append(el('h3', '', 'Discard unsent drafts and switch?'), el('p', '', 'Unsent text, images, attached files and form edits in every chat will be lost when Faber restarts. Saved chats remain in their current profile.'));
      const discard = button('Discard drafts and switch', async () => { discard.disabled = true; await perform(); if (!status.textContent.startsWith('Restarting')) { confirmation.remove(); switchButton.disabled = choice.input.value === profiles.currentId; } }, 'button danger'); discard.id = 'confirm-profile-switch';
      confirmation.append(actions(button('Keep drafts', () => { confirmation.remove(); switchButton.disabled = choice.input.value === profiles.currentId; }), discard)); switchDialog.append(confirmation); discard.focus();
    }, 'button primary'); switchButton.id = 'switch-profile-submit';
    const update = () => { switchButton.disabled = choice.input.value === profiles.currentId; switchDialog.querySelector('#profile-discard-confirmation')?.remove(); status.textContent = ''; }; choice.input.addEventListener('change', update); update();
    switchDialog.append(title, el('p', 'hint', 'Switching restarts Faber. Stop runs, downloads, voice, updates and external requests first. Each profile keeps separate credentials, chats and browser state.'), choice.wrapper, status, actions(button('Cancel', () => switchDialog.close()), switchButton));
    if (!switchDialog.open) switchDialog.showModal();
  }
  async function mountProfiles(root) {
    root.append(el('h3', '', 'Faber profiles'), el('p', 'hint', 'Default keeps your existing workspace. New profiles keep separate credentials, chats and browser state. Switching restarts Faber; profiles cannot be deleted here.'));
    const list = el('div'), name = field('New profile name'); name.input.id = 'new-profile-name'; name.input.maxLength = 80;
    root.append(list, name.wrapper, button('Create profile', async () => { await request('profiles.create', { name: name.input.value }); name.input.value = ''; name.input.defaultValue = ''; await renderList(); }, 'button primary'));
    async function renderList() {
      await loadProfiles(); if (!root.isConnected) return; list.replaceChildren();
      for (const profile of profiles.profiles) {
        const row = el('section', 'profile-settings-row'), rename = field('Profile name', profile.name); rename.input.setAttribute('aria-label', `Name for ${profile.name}`); rename.input.maxLength = 80;
        row.append(el('strong', '', `${profile.name}${profile.current ? ' · current profile' : ''}`), rename.wrapper, actions(button('Rename', async () => { await request('profiles.rename', { id: profile.id, name: rename.input.value }); await renderList(); }), button(profile.current ? 'Current profile' : 'Switch to this profile', () => showSwitcher(profile.id))));
        row.lastChild.lastChild.disabled = profile.current; list.append(row);
      }
    }
    await renderList();
  }
  async function mountGateway(root) {
    root.append(el('h3', '', 'External access'), el('p', 'hint', 'Off by default. Serve an explicitly selected local or API model and project tools to authenticated clients. ChatGPT account subscriptions cannot be relayed.'), el('p', 'gateway-network-note', 'LAN access uses unencrypted HTTP. Anyone with the token can send requests to this model and request project tool actions. Use a trusted network; this is not an OS sandbox.'));
    const loading = el('p', 'hint', 'Reading external access status…'); root.append(loading);
    const initial = await request('gateway.status'); if (!root.isConnected) return; loading.remove();
    let status = initial, token = '';
    const pendingControls = new Set();
    // Serving state owns disabled controls after an asynchronous action settles.
    function control(text, callback, className = 'button') {
      const node = el('button', className, text); node.type = 'button';
      node.addEventListener('click', async () => {
        pendingControls.add(node); update(status);
        try { await callback(); } catch (error) { notify(error.message, true); }
        finally { pendingControls.delete(node); update(status); }
      }); return node;
    }
    const summary = el('p', 'gateway-status'); summary.id = 'gateway-status'; summary.setAttribute('role', 'status');
    const address = field('Literal local or LAN IP address', status.config.bindAddress, 'text', 'Choose one interface, for example 127.0.0.1 or 192.168.1.20. Wildcard addresses are unavailable.'); address.input.id = 'gateway-address';
    const port = field('Port', status.config.port, 'number'); port.input.id = 'gateway-port'; port.input.min = 0; port.input.max = 65535; port.input.step = 1;
    const remote = field('Allow remote / LAN access', '', 'checkbox'); remote.input.id = 'gateway-remote'; remote.input.checked = remote.input.defaultChecked = status.config.allowRemote;
    const project = selectField('Target project', [{ value: '', label: 'Choose a project…' }, ...getState().projects.filter(item => !item.archived).map(item => ({ value: item.id, label: item.name }))], status.config.projectId); project.input.id = 'gateway-project';
    const providers = externalProviders(getState().providers), provider = selectField('Saved local or API connection', [{ value: '', label: 'Choose a connection…' }, ...providers.map(item => ({ value: item.id, label: item.name }))], status.config.providerId); provider.input.id = 'gateway-provider';
    const model = field('Exact model ID', status.config.model); model.input.id = 'gateway-model';
    const catalog = el('div', 'gateway-model-catalog');
    const listModels = control('List models', async () => {
      const id = provider.input.value; if (!id) throw new Error('Choose a saved connection first.'); catalog.replaceChildren(el('p', 'hint', 'Listing models; no inference request is sent.'));
      const result = await request('provider.test', { id }); if (!root.isConnected || provider.input.value !== id) return;
      if (!result.ok) throw new Error(result.error || 'The connection did not respond.');
      catalog.replaceChildren(el('p', 'hint', result.models?.length ? 'Choose a returned model, or enter its exact ID.' : 'No models were returned. Enter an exact model ID.'));
      for (const entry of result.models || []) { const id = typeof entry === 'string' ? entry : entry.id || entry.name; if (id) catalog.append(button(id, () => { model.input.value = id; model.input.dispatchEvent(new Event('input', { bubbles: true })); }, 'nav-button')); }
    }); listModels.id = 'gateway-list-models';
    provider.input.addEventListener('change', () => { model.input.value = ''; catalog.replaceChildren(); });
    const route = el('p', 'hint'); route.id = 'gateway-route';
    const urls = el('div', 'gateway-urls'); urls.id = 'gateway-urls';
    const tokenNote = el('p', 'hint'), secret = field('New token · shown only until this panel closes', '', 'password'); secret.input.id = 'gateway-token'; secret.input.readOnly = true; secret.wrapper.hidden = true;
    const copy = control('Copy token', async () => { await navigator.clipboard.writeText(token); notify('External access token copied.'); }); copy.id = 'gateway-copy-token'; copy.disabled = true;
    const rotate = control(status.hasToken ? 'Rotate token and stop access' : 'Generate token', async () => {
      const result = await request('gateway.rotateToken'); if (!root.isConnected || !document.querySelector('#modal').open || gatewayView?.root !== root) return; token = result.token; secret.input.value = token; secret.wrapper.hidden = false; copy.disabled = false; update(result);
      tokenNote.textContent = 'Copy this token now. It is not shown again after closing this panel. Previous tokens and sessions are revoked. Access stays stopped until you start it.';
    }); rotate.id = 'gateway-rotate-token';
    async function configure() {
      if (!port.input.checkValidity()) { port.input.reportValidity(); throw new Error('Choose a valid port from 0 to 65535.'); }
      const result = await request('gateway.configure', { bindAddress: address.input.value.trim(), port: Number(port.input.value), allowRemote: remote.input.checked, projectId: project.input.value, providerId: provider.input.value, model: model.input.value.trim() });
      for (const input of [address.input, port.input, model.input]) input.defaultValue = input.value;
      remote.input.defaultChecked = remote.input.checked; for (const input of [project.input, provider.input]) for (const option of input.options) option.defaultSelected = option.selected;
      root.closest('#modal-body')?.setAttribute('data-settings-clean', 'true'); update(result);
    }
    const save = control('Save configuration', configure); save.id = 'gateway-save';
    const start = control('Start external access', async () => { await configure(); update(await request('gateway.start')); }, 'button primary'); start.id = 'gateway-start';
    const stop = control('Stop external access', async () => update(await request('gateway.stop')), 'button danger'); stop.id = 'gateway-stop';
    const inputs = [address.input, port.input, remote.input, project.input, provider.input, model.input];
    function update(next) {
      status = next;
      summary.textContent = `${status.running ? 'Running' : 'Stopped'} · ${status.activeRequests} active request(s) · ${status.activeSessions} session(s)`;
      const busy = pendingControls.size > 0;
      for (const input of inputs) input.disabled = status.running || busy;
      save.disabled = status.running || busy; start.disabled = status.running || !status.hasToken || busy; stop.disabled = !status.running || busy; listModels.disabled = status.running || busy;
      rotate.disabled = busy; copy.disabled = !token || busy; for (const node of catalog.querySelectorAll('button')) node.disabled = status.running || busy;
      rotate.textContent = status.hasToken ? 'Rotate token and stop access' : 'Generate token';
      route.textContent = `Saved route: ${getState().projects.find(item => item.id === status.config.projectId)?.name || 'No project selected'} / ${providers.find(item => item.id === status.config.providerId)?.name || 'No connection selected'} / ${status.config.model || 'No model selected'}`;
      urls.replaceChildren(); if (status.baseUrl) urls.append(el('p', '', 'OpenAI-compatible base URL'), el('code', '', status.baseUrl)); if (status.mcpUrl) urls.append(el('p', '', 'MCP URL'), el('code', '', status.mcpUrl));
    }
    root.append(summary, address.wrapper, port.wrapper, remote.wrapper, project.wrapper, provider.wrapper, model.wrapper, listModels, catalog, route, actions(save, start, stop), urls, el('h3', '', 'Access token'), el('p', 'hint', 'Token creation and rotation stop serving and revoke every existing session. Copy only when you are ready to configure a client.'), actions(rotate, copy), secret.wrapper, tokenNote);
    gatewayView = { root, update, clearToken: () => { token = ''; secret.input.value = ''; secret.wrapper.hidden = true; copy.disabled = true; tokenNote.textContent = ''; } }; update(status);
  }
  return { loadProfiles, setRecovery, showRecovery, mountProfiles, mountGateway };
}
