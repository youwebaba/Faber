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
  return { used, estimated, capacity, percent, rate, rateEstimated: Boolean(metrics?.tokensPerSecondEstimated), firstTokenMs: count(metrics?.firstTokenMs) ? metrics.firstTokenMs : null };
}

const effortLabels = { none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export function thinkingChoices(controls, chat = {}) {
  const options = [{ label: 'Default', thinking: null, reasoningEffort: null }];
  const efforts = controls?.reasoning?.supported ? [...new Set(controls.reasoning.efforts)] : [];
  if (efforts.length) {
    const order = Object.keys(effortLabels);
    efforts.sort((a, b) => (order.includes(a) ? order.indexOf(a) : order.length) - (order.includes(b) ? order.indexOf(b) : order.length));
    options.push(...efforts.map(reasoningEffort => ({ label: effortLabels[reasoningEffort] || reasoningEffort, thinking: null, reasoningEffort })));
    let selected = chat.reasoningEffort;
    if (chat.thinking === false) selected = 'none';
    if (chat.thinking === true && (!selected || selected === 'none')) selected = controls.reasoning.default && controls.reasoning.default !== 'none' ? controls.reasoning.default : efforts.find(effort => effort !== 'none');
    return { options, index: Math.max(0, options.findIndex(option => option.reasoningEffort === selected)) };
  }
  if (controls?.thinking?.supported) options.push({ label: 'Off', thinking: false, reasoningEffort: null }, { label: 'On', thinking: true, reasoningEffort: null });
  return { options, index: Math.max(0, options.findIndex(option => option.thinking === chat.thinking)) };
}

export function createChatControls({ request, refresh, getChat, getDraft, getModelName = () => getChat()?.model || 'Choose a model', modal, closeModal, el, button, field, actions, icon, notify }) {
  const root = el('div', 'composer-controls'); root.id = 'composer-controls';
  const context = el('button', 'context-window'); context.id = 'context-window'; context.type = 'button'; context.setAttribute('aria-haspopup', 'dialog');
  const label = el('span', 'context-window-label', 'Context'); const meter = el('span', 'context-meter'); meter.setAttribute('role', 'progressbar'); meter.setAttribute('aria-label', 'Context window usage'); const fill = el('span'); meter.append(fill); context.append(label, meter);
  const used = el('span', 'context-usage', 'Usage unknown'); used.id = 'context-usage';
  const tps = el('span', 'token-rate', '— tok/s'); tps.id = 'token-rate';
  const thinking = el('button', 'icon-button thinking-control'); thinking.type = 'button'; thinking.id = 'thinking-control'; thinking.append(icon('brain')); thinking.setAttribute('aria-haspopup', 'dialog'); thinking.setAttribute('aria-controls', 'thinking-popover'); thinking.setAttribute('aria-expanded', 'false');
  const picker = el('div', 'thinking-popover'); picker.id = 'thinking-popover'; picker.popover = 'auto'; picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-label', 'Thinking level');
  const heading = el('div', 'thinking-heading'); heading.append(icon('brain'));
  const levelLabel = el('span', 'thinking-level-label'); levelLabel.id = 'thinking-level-label';
  const reset = el('button', 'icon-button thinking-reset', '↶'); reset.id = 'thinking-reset'; reset.type = 'button'; reset.title = 'Reset to model default'; reset.setAttribute('aria-label', reset.title);
  heading.append(levelLabel, reset);
  const model = el('div', 'thinking-model'); model.id = 'thinking-model';
  const track = el('div', 'thinking-track'), ticks = el('div', 'thinking-ticks'); ticks.setAttribute('aria-hidden', 'true');
  const level = el('input', 'thinking-level'); level.id = 'thinking-level'; level.type = 'range'; level.min = '0'; level.step = '1'; level.setAttribute('aria-label', 'Thinking level');
  const hint = el('p', 'thinking-hint'); hint.id = 'thinking-hint'; level.setAttribute('aria-describedby', hint.id);
  track.append(level, ticks); picker.append(heading, model, track, hint);
  root.append(context, used, tps, thinking, picker);
  let controls, controlsFor, signature, sequence = 0, pending = false, saving = false, currentMetrics, currentActive = false, error, openedFor, focusAfterSave, preview = null, options = [];
  const identity = chat => JSON.stringify([chat?.id, chat?.providerId, chat?.model]);
  function closeThinking() { if (picker.matches(':popover-open')) picker.hidePopover(); }
  function showLevel(index) {
    const selected = options[index]; if (!selected) return;
    level.value = String(index); level.setAttribute('aria-valuetext', selected.label); levelLabel.textContent = selected.label;
    track.style.setProperty('--thinking-fill', `${index / Math.max(1, options.length - 1) * 100}%`);
  }
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
    const average = ['wall-clock', 'character-estimate'].includes(currentMetrics?.tokensPerSecondBasis);
    tps.textContent = data.rate === null ? '— tok/s' : `${data.rateEstimated ? '≈ ' : ''}${data.rate.toFixed(1)} tok/s${average ? ' avg' : ''}`;
    const timing = { 'provider-eval': 'Provider-reported output tokens over generation time; includes reasoning tokens when reported.', 'wall-clock': 'Total output average over the entire call, including request and prompt processing; includes reasoning tokens when reported.', 'character-estimate': 'Estimated visible output average over the entire call, using four characters per token.' }[currentMetrics?.tokensPerSecondBasis] || 'Output tokens per second.';
    tps.title = `${data.rate === null ? 'Token speed will appear when available.' : timing}${data.firstTokenMs === null ? '' : ` First visible token: ${data.firstTokenMs < 1000 ? `${Math.round(data.firstTokenMs)} ms` : `${(data.firstTokenMs / 1000).toFixed(1)} s`}.`}`;
    const choices = thinkingChoices(controls, chat || {}); options = choices.options;
    const supported = options.length > 1, disabled = pending || saving || currentActive || !chat || !supported;
    thinking.disabled = disabled; level.disabled = disabled; reset.disabled = disabled || (chat?.thinking == null && chat?.reasoningEffort == null);
    thinking.classList.toggle('enabled', choices.index > 0 && options[choices.index].label !== 'Off');
    thinking.title = !chat ? 'Create a chat to set thinking' : currentActive ? 'Stop this run before changing thinking.' : error || (!supported ? controls?.thinking?.reason || 'This model does not advertise adjustable thinking.' : `Thinking: ${options[choices.index].label}. Choose a level for this chat.`);
    thinking.setAttribute('aria-label', thinking.title);
    level.max = String(options.length - 1);
    if (ticks.childElementCount !== options.length) ticks.replaceChildren(...options.map(() => el('span')));
    showLevel(preview !== null && preview < options.length ? preview : choices.index);
    model.textContent = getModelName(); model.title = model.textContent;
    const defaultEffort = controls?.reasoning?.default, defaultThinking = controls?.thinking?.effective;
    hint.textContent = !supported ? 'Thinking levels are not available for this model.' : controls?.reasoning?.supported ? 'Reasoning levels supplied by this model.' : 'This model supports thinking off or on.';
    if (Number(level.value) === 0) hint.textContent = defaultEffort ? `Model default: ${effortLabels[defaultEffort] || defaultEffort}.` : typeof defaultThinking === 'boolean' && chat?.thinking == null ? `Connection default: ${defaultThinking ? 'On' : 'Off'}.` : 'Use the model’s default thinking setting.';
    if (picker.matches(':popover-open') && (openedFor !== identity(chat) || currentActive || !supported)) closeThinking();
    if (focusAfterSave && !pending && !saving) {
      if (!disabled && focusAfterSave === identity(chat) && picker.matches(':popover-open') && document.activeElement === document.body) level.focus();
      focusAfterSave = undefined;
    }
  }
  async function load(chat, key) {
    const token = ++sequence; pending = true; error = undefined;
    if (controlsFor !== identity(chat)) { controls = undefined; preview = null; }
    controlsFor = identity(chat); render();
    try { const result = await request('chat.controls', { chatId: chat.id }); if (token !== sequence || key !== signature || chat.id !== getChat()?.id) return; controls = result; }
    catch (cause) { if (token === sequence) { error = cause.message || String(cause); controls = undefined; } }
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
  thinking.addEventListener('click', () => {
    if (thinking.disabled) return;
    if (picker.matches(':popover-open')) { closeThinking(); return; }
    openedFor = identity(getChat()); preview = null; render(); picker.showPopover();
    const bounds = thinking.getBoundingClientRect();
    picker.style.left = `${Math.max(8, Math.min(bounds.left + bounds.width / 2 - picker.offsetWidth / 2, innerWidth - picker.offsetWidth - 8))}px`;
    picker.style.top = `${Math.max(8, bounds.top - picker.offsetHeight - 8)}px`;
    level.focus();
  });
  picker.addEventListener('beforetoggle', event => { const open = event.newState === 'open'; thinking.setAttribute('aria-expanded', String(open)); if (!open) { openedFor = undefined; preview = null; } });
  window.addEventListener('resize', closeThinking);
  level.addEventListener('input', () => { if (!level.disabled) { preview = Number(level.value); render(); } });
  async function saveThinking(index) {
    const chat = getChat(), selected = options[index];
    if (!chat || !selected || pending || saving || currentActive || openedFor !== identity(chat) || !picker.matches(':popover-open') || options.length < 2) return;
    if ([level, reset].includes(document.activeElement)) focusAfterSave = identity(chat);
    saving = true; render();
    try { await request('chat.update', { id: chat.id, thinking: selected.thinking, reasoningEffort: selected.reasoningEffort }); signature = undefined; await refresh(); }
    catch (cause) { notify(cause.message || String(cause), true); }
    finally { saving = false; preview = null; render(); }
  }
  level.addEventListener('change', () => { void saveThinking(Number(level.value)); });
  reset.addEventListener('click', () => { preview = 0; void saveThinking(0); });
  return { root, render,
    setContext(state, metrics, active = false) {
      currentMetrics = metrics; currentActive = active;
      const chat = getChat(), provider = state.providers.find(item => item.id === chat?.providerId) || state.providers[0];
      const key = JSON.stringify([chat?.id, chat?.projectId, state.projects?.find(project => project.id === chat?.projectId)?.path, chat?.model, chat?.contextTokens, chat?.thinking, chat?.reasoningEffort, chat?.messages?.length, chat?.messages?.at(-1)?.id, chat?.contextCheckpoint?.throughMessageId, chat?.contextCheckpoint?.createdAt, provider, state.tools]);
      if (key !== signature) { signature = key; if (chat) load(chat, key); else { ++sequence; controls = undefined; pending = false; } }
      render();
    },
    invalidate() { signature = undefined; },
  };
}
