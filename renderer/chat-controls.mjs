const count = value => Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value > 0;
export function contextChoice(value) {
  if (value === '' || value === null) return null;
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > 2147483647) throw new Error('Enter a whole context size from 1 to 2,147,483,647 tokens, or leave it blank for the model default.');
  return tokens;
}
export function composerMetrics(controls, metrics, draft = '', active = false) {
  const reportedInput = count(metrics?.inputTokens), reportedOutput = count(metrics?.outputTokens);
  const input = active ? reportedInput ? metrics.inputTokens : metrics?.estimatedInputTokens ?? controls?.context?.estimatedTokens : controls?.context?.estimatedTokens;
  const output = active ? reportedOutput ? metrics.outputTokens : metrics?.estimatedOutputTokens ?? 0 : 0;
  const used = count(input) ? input + output + (draft ? Math.ceil(draft.length / 4) : 0) : null;
  const estimated = !active || !reportedInput || !reportedOutput || Boolean(draft);
  const allocated = integer(controls?.context?.capacityTokens) ? controls.context.capacityTokens : null;
  const capacity = active && integer(metrics?.capacityTokens) ? metrics.capacityTokens : controls?.context?.mode === 'managed' ? allocated : integer(controls?.contextTokens) ? controls.contextTokens : allocated;
  const percent = used !== null && capacity ? Math.min(100, used / capacity * 100) : null;
  const rate = count(metrics?.tokensPerSecond) ? metrics.tokensPerSecond : null;
  return { used, estimated, capacity, percent, rate, rateEstimated: Boolean(metrics?.tokensPerSecondEstimated) };
}

export function createChatControls({ request, refresh, getChat, getDraft, modal, closeModal, el, button, field, actions, icon, notify }) {
  const root = el('div', 'composer-controls'); root.id = 'composer-controls';
  const context = el('button', 'context-window'); context.id = 'context-window'; context.type = 'button'; context.setAttribute('aria-haspopup', 'dialog');
  const label = el('span', 'context-window-label', 'Context'); const meter = el('span', 'context-meter'); meter.setAttribute('role', 'progressbar'); meter.setAttribute('aria-label', 'Context window usage'); const fill = el('span'); meter.append(fill); context.append(label, meter);
  const used = el('span', 'context-usage', 'Usage unknown'); used.id = 'context-usage';
  const tps = el('span', 'token-rate', '— tok/s'); tps.id = 'token-rate';
  const thinking = el('button', 'icon-button thinking-toggle'); thinking.type = 'button'; thinking.id = 'thinking-toggle'; thinking.append(icon('brain')); thinking.setAttribute('aria-label', 'Toggle thinking for this chat');
  root.append(context, used, tps, thinking);
  let controls, signature, sequence = 0, pending = false, currentMetrics, currentActive = false, error;
  function render() {
    const chat = getChat(), data = composerMetrics(controls, currentMetrics, getDraft(), currentActive);
    const selectedCapacity = integer(controls?.contextTokens) ? controls.contextTokens : data.capacity;
    const restartNeeded = controls?.context?.mode === 'managed' && integer(controls.contextTokens) && controls.contextTokens !== controls.context.capacityTokens;
    context.disabled = pending || !chat; context.title = error || (restartNeeded ? `Selected ${selectedCapacity.toLocaleString('en-US')} tokens. Restart the local model to apply this selection. The usage bar shows the currently allocated capacity.` : controls?.context?.reason) || (controls?.context?.configurable ? 'Choose the context window for this chat' : 'This connection has a fixed or unreported context window');
    label.textContent = `Context ${selectedCapacity ? selectedCapacity.toLocaleString('en-US') : 'Auto'}${restartNeeded ? ' · pending' : ''} ⌄`;
    used.textContent = data.used === null ? 'Usage unknown' : `${data.estimated ? '≈ ' : ''}${Math.round(data.used).toLocaleString('en-US')}${data.capacity ? ` / ${data.capacity.toLocaleString('en-US')}` : ''}`;
    used.title = data.used === null ? 'The provider has not reported context usage.' : `${data.estimated ? 'Estimated context tokens. Text is estimated at four characters per token; image and hidden reasoning tokens are excluded from estimates.' : 'Provider-reported input and output tokens.'}${getDraft() ? ' Includes an estimate for the current draft.' : ''}`;
    meter.classList.toggle('unknown', data.percent === null); meter.classList.toggle('full', data.percent >= 100); fill.style.width = `${data.percent ?? 0}%`; meter.setAttribute('aria-valuetext', used.textContent);
    if (data.percent === null) { meter.removeAttribute('aria-valuenow'); meter.removeAttribute('aria-valuemax'); } else { meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', String(data.capacity)); meter.setAttribute('aria-valuenow', String(Math.min(data.capacity, Math.round(data.used)))); }
    tps.textContent = data.rate === null ? '— tok/s' : `${data.rateEstimated ? '≈ ' : ''}${data.rate.toFixed(1)} tok/s`;
    const timing = { 'provider-eval': 'Uses provider-reported generation time.', 'wall-clock': 'Uses the entire call duration, including request and prompt processing.', 'character-estimate': 'Uses an output text estimate and elapsed request time.' }[currentMetrics?.tokensPerSecondBasis] || '';
    tps.title = data.rate === null ? 'Token generation speed will appear when available.' : `${data.rateEstimated ? 'Estimated output tokens per second.' : 'Output tokens per second.'} ${timing}`.trim();
    const supported = Boolean(controls?.thinking?.supported), effective = typeof chat?.thinking === 'boolean' ? chat.thinking : controls?.thinking?.effective;
    thinking.disabled = pending || currentActive || !chat || !supported; thinking.setAttribute('aria-pressed', effective === null || effective === undefined ? 'mixed' : String(effective)); thinking.classList.toggle('enabled', effective === true);
    thinking.title = !chat ? 'Create a chat to set thinking' : currentActive ? 'Stop this run before changing thinking.' : !supported ? controls?.thinking?.reason || 'This connection does not expose a supported thinking toggle.' : effective === null || effective === undefined ? 'Thinking: model default. Click to enable for this chat.' : `Thinking ${effective ? 'on' : 'off'} for this chat. Click to ${effective ? 'disable' : 'enable'}.`;
  }
  async function load(chat, key) {
    const token = ++sequence; pending = true; error = undefined; controls = undefined; render();
    try { const result = await request('chat.controls', { chatId: chat.id }); if (token !== sequence || key !== signature || chat.id !== getChat()?.id) return; controls = result; }
    catch (cause) { if (token === sequence) error = cause.message || String(cause); }
    finally { if (token === sequence) { pending = false; render(); } }
  }
  context.addEventListener('click', () => {
    const chat = getChat(); if (!chat) return;
    const targetId = chat.id, body = modal('Context window');
    body.append(el('p', 'hint', controls?.context?.reason || 'Choose how many tokens the model runtime can hold. Larger windows use more memory. Conversation history is not deleted or silently shortened.'));
    if (error) body.append(el('p', 'error-text', error));
    if (!controls?.context?.configurable) { body.append(el('p', '', 'This API does not expose a context-size setting. An output-token limit is not a context-window setting.'), actions(button('Done', closeModal))); return; }
    const size = field('Context tokens', chat.contextTokens ?? '', 'number', 'Leave blank for the model default.'); size.input.id = 'context-token-input'; size.input.min = '1'; size.input.max = '2147483647'; size.input.step = '1';
    const presets = el('div', 'context-presets');
    for (const value of [null, 4096, 8192, 16384, 32768, 65536, 131072]) presets.append(button(value === null ? 'Default' : `${value / 1024}k`, () => { size.input.value = value ?? ''; }));
    body.append(size.wrapper, presets);
    const managed = controls.context.mode === 'managed';
    if (managed) body.append(el('p', 'hint', `${integer(controls.context.capacityTokens) ? `Loaded capacity: ${controls.context.capacityTokens.toLocaleString('en-US')} tokens. ` : 'No loaded capacity has been reported. '}A changed context window applies on the next model Start. Save and restart below to apply it now; this uses the shared local model, so stop all chats using it first.`));
    if (currentActive) body.append(el('p', 'hint', 'Stop this chat before changing its context window.'));
    const apply = button('Apply context window', async () => {
      const tokens = contextChoice(size.input.value); await request('chat.update', { id: targetId, contextTokens: tokens }); signature = undefined; await refresh(); closeModal(); notify('Context window saved for this chat.');
    }, 'button primary'); apply.id = 'apply-context-window'; apply.disabled = currentActive;
    const footer = actions(button('Cancel', closeModal), apply);
    if (managed) {
      const restart = button('Save & restart model', async () => {
        const tokens = contextChoice(size.input.value), before = await request('localModels.list');
        if (!before.process?.modelId || !['ready', 'failed'].includes(before.process.status)) throw new Error('Start a downloaded model in the model selector first.');
        const modelId = before.process.modelId;
        await request('chat.update', { id: targetId, contextTokens: tokens });
        await request('localModels.stop'); await request('localModels.start', { modelId, contextTokens: tokens });
        signature = undefined; await refresh(); closeModal(); notify('Local model is restarting with the selected context window. Wait for it to become ready.');
      }); restart.id = 'restart-context-model'; restart.disabled = currentActive; footer.append(restart);
    }
    body.append(footer); size.input.focus();
  });
  thinking.addEventListener('click', async () => {
    const chat = getChat(); if (!chat || !controls?.thinking?.supported || pending) return;
    const targetId = chat.id, effective = typeof chat.thinking === 'boolean' ? chat.thinking : controls.thinking.effective;
    pending = true; render();
    try { await request('chat.update', { id: targetId, thinking: effective !== true }); signature = undefined; await refresh(); }
    catch (cause) { notify(cause.message || String(cause), true); }
    finally { pending = false; render(); }
  });
  return { root, render,
    setContext(state, metrics, active = false) {
      currentMetrics = metrics; currentActive = active;
      const chat = getChat(), provider = state.providers.find(item => item.id === chat?.providerId) || state.providers[0];
      const key = JSON.stringify([chat?.id, chat?.projectId, state.projects?.find(project => project.id === chat?.projectId)?.path, chat?.model, chat?.contextTokens, chat?.thinking, chat?.messages?.length, chat?.messages?.at(-1)?.id, provider, state.tools]);
      if (key !== signature) { signature = key; if (chat) load(chat, key); else { ++sequence; controls = undefined; pending = false; } }
      render();
    },
    invalidate() { signature = undefined; },
  };
}
