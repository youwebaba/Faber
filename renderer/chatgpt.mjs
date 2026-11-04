export function accountModelOptions(account, selectedModel) {
  const models = account?.models || [], model = models.find(item => item.id === selectedModel);
  return { models, model, efforts: model?.reasoningEfforts || [], capacity: Number.isSafeInteger(model?.contextTokens) && model.contextTokens > 0 ? model.contextTokens : null };
}

export function createChatGPTControls({ request, refresh, getChat, getState, newChat, closeModal, el, button, field, selectField, actions, createPromptChoice, notify }) {
  let status = { accounts: [], signIn: { status: 'idle' } }, renderPanel, completedAccount;
  const acknowledgedPlans = new Set();
  function accept(next) { if (next.signIn?.status === 'complete' && (status.signIn?.status !== 'complete' || status.signIn.accountId !== next.signIn.accountId)) completedAccount = next.signIn.accountId; status = next; renderPanel?.(); renderPlan(); }
  async function load() { accept(await request('chatgpt.status')); return status; }
  function renderPlan() {
    const banner = document.querySelector('#chatgpt-connected-notice'), unacknowledged = status.accounts?.find(item => item.connected && item.planEnabled && !acknowledged(item.id));
    if (banner) {
      banner.hidden = Boolean(renderPanel) || !unacknowledged; banner.replaceChildren();
      if (!banner.hidden) banner.append(el('strong', '', 'You’re using your ChatGPT plan'), el('span', '', 'Your ChatGPT connection is ready in the OpenAI model selector.'), button('Got it', () => acknowledge(unacknowledged.id)));
    }
    const root = document.querySelector('#chatgpt-plan-status'); if (!root) return;
    const provider = getState().providers.find(item => item.id === getChat()?.providerId), account = status.accounts?.find(item => item.providerId === provider?.id);
    root.hidden = provider?.authKind !== 'chatgpt'; root.replaceChildren(); if (root.hidden) return;
    root.append(el('span', '', account?.connected && account.planEnabled ? 'Using ChatGPT plan' : account?.connected ? 'ChatGPT connected' : 'ChatGPT — reconnect to continue'), button('Manage usage', () => request('chatgpt.usage'), 'text-button'));
  }
  function mount(parent) {
    const panel = el('section', 'chatgpt-panel'); panel.id = 'chatgpt-panel'; parent.append(panel);
    const prompt = createPromptChoice(); let disposed = false, selectedAccount, selectedModel, selectedEffort, busy = false, error = '';
    const refreshPanel = () => { if (!disposed && panel.isConnected) render(); }; renderPanel = refreshPanel;
    async function perform(callback) {
      if (busy) return; busy = true; error = ''; render();
      try { await callback(); } catch (reason) { error = reason.message || String(reason); } finally { busy = false; refreshPanel(); }
    }
    function render() {
      panel.replaceChildren();
      const accounts = status.accounts || [], chat = getChat();
      if (completedAccount && accounts.some(item => item.id === completedAccount)) { selectedAccount = completedAccount; selectedModel = undefined; selectedEffort = undefined; completedAccount = undefined; }
      selectedAccount = accounts.some(item => item.id === selectedAccount) ? selectedAccount : accounts.find(item => item.providerId === chat?.providerId)?.id || status.activeAccountId || accounts[0]?.id;
      const account = accounts.find(item => item.id === selectedAccount), pending = ['pending', 'exchanging'].includes(status.signIn?.status);
      panel.append(el('p', 'hint', 'Connect your ChatGPT account, then choose one of the models made available to Faber. Available models and controls come from your account.'));
      if (accounts.length) {
        const choice = selectField('ChatGPT account', accounts.map(item => ({ value: item.id, label: `${item.label || 'ChatGPT account'}${item.email ? ` · ${item.email}` : ''}${item.connected ? '' : ' · disconnected'}` })), account?.id); choice.input.id = 'chatgpt-account'; choice.input.disabled = busy || pending;
        choice.input.addEventListener('change', () => perform(async () => { selectedAccount = choice.input.value; selectedModel = undefined; selectedEffort = undefined; accept(await request('chatgpt.select', { accountId: selectedAccount })); })); panel.append(choice.wrapper);
      }
      const signIn = button('Continue with ChatGPT', () => perform(async () => accept(await request('chatgpt.signIn', account ? { accountId: account.id } : {}))), 'button chatgpt-signin'); signIn.id = 'chatgpt-sign-in'; signIn.disabled = busy || pending; const logo = el('img'); logo.src = 'assets/chatgpt-logo-white.svg'; logo.alt = ''; signIn.prepend(logo);
      panel.append(signIn);
      if (account) { const add = button('Add another account', () => perform(async () => accept(await request('chatgpt.signIn', {})))); add.disabled = busy || pending; panel.append(add); }
      if (pending) { panel.append(el('p', 'hint', status.signIn.status === 'exchanging' ? 'Completing sign in…' : 'Finish signing in in your browser.'), button('Cancel sign in', () => perform(async () => accept(await request('chatgpt.cancel'))))); }
      if (error || status.signIn?.error || account?.error) { const failure = el('p', 'error-text', error || status.signIn?.error || account?.error); failure.setAttribute('role', 'alert'); panel.append(failure); }
      if (!account?.connected) { panel.append(el('p', 'hint', 'Your API keys and local model connections remain available in Local & APIs.')); return; }
      if (account.planEnabled && !acknowledged(account.id)) {
        const notice = el('aside', 'chatgpt-plan-notice'); notice.append(el('strong', '', 'You’re using your ChatGPT plan'), el('p', 'hint', 'This connection uses your ChatGPT plan. You can review its usage at any time.'), button('Got it', () => acknowledge(account.id))); panel.append(notice);
      }
      panel.append(el('p', 'hint', account.planEnabled ? 'Using ChatGPT plan' : 'ChatGPT plan usage is not enabled for this connection. Continue with ChatGPT again to enable it.'), actions(button('Manage usage', () => request('chatgpt.usage')), button('Refresh available models', () => perform(async () => { const result = await request('chatgpt.models', { accountId: account.id, refresh: true }); account.models = result.models; await load(); })), button('Sign out of this account', () => perform(async () => { const next = await request('chatgpt.signOut', { accountId: account.id }); accept(next); if (next.warning) notify(next.warning); await refresh(); }))));
      const models = account.models || [];
      if (!models.some(item => item.id === selectedModel)) { selectedModel = models.find(item => item.id === chat?.model && chat?.providerId === account.providerId)?.id || models[0]?.id; selectedEffort = chat?.providerId === account.providerId && selectedModel === chat?.model ? chat.reasoningEffort ?? '' : ''; }
      if (!models.length) { panel.append(el('p', 'hint', 'No models are available to this connection yet. Refresh the catalog or check your account access.')); return; }
      const modelChoice = selectField('OpenAI model', models.map(item => ({ value: item.id, label: item.name || item.id })), selectedModel); modelChoice.input.id = 'chatgpt-model'; modelChoice.input.disabled = busy;
      modelChoice.input.addEventListener('change', () => { selectedModel = modelChoice.input.value; selectedEffort = ''; render(); }); panel.append(modelChoice.wrapper);
      const { efforts, capacity } = accountModelOptions(account, selectedModel);
      panel.append(el('p', 'hint model-capacity', capacity ? `Context capacity: ${capacity.toLocaleString()} tokens · fixed by the model` : 'Context capacity: not supplied by this account.'));
      if (!efforts.includes(selectedEffort)) selectedEffort = '';
      const effort = selectField('Reasoning effort', [{ value: '', label: 'Model default' }, ...efforts.map(value => ({ value, label: value }))], selectedEffort); effort.input.id = 'chatgpt-reasoning'; effort.input.disabled = !efforts.length || busy;
      effort.input.addEventListener('change', () => { selectedEffort = effort.input.value; });
      if (!efforts.length) effort.wrapper.append(el('small', '', 'This account has not supplied adjustable reasoning controls for this model.')); panel.append(effort.wrapper, prompt.root);
      const use = button('Use in this chat', () => perform(async () => {
        const target = getChat() || await newChat(); if (!target) return;
        await request('chat.update', { id: target.id, providerId: account.providerId, model: selectedModel, contextTokens: null, thinking: null, reasoningEffort: selectedEffort || null, ...prompt.value() }); await refresh(); closeModal();
      }), 'button primary'); use.id = 'chatgpt-use-model'; use.disabled = busy || !account.planEnabled; panel.append(actions(use));
    }
    render(); void load().catch(reason => { error = reason.message; refreshPanel(); });
    return () => { disposed = true; if (renderPanel === refreshPanel) renderPanel = undefined; renderPlan(); };
  }
  function acknowledged(id) { if (acknowledgedPlans.has(id)) return true; try { return localStorage.getItem(`faber.chatgpt.planAcknowledged.${id}`) === 'true'; } catch { return false; } }
  function acknowledge(id) { acknowledgedPlans.add(id); try { localStorage.setItem(`faber.chatgpt.planAcknowledged.${id}`, 'true'); } catch {} renderPanel?.(); renderPlan(); }
  return { mount, load, accept, renderPlan };
}
