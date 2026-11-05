import { remoteWorkspace, remoteChat, remoteLive, remoteChatFamilies, remoteEvent } from './remote-state.mjs';
import { isActive, latestRun, sameMessage, displayText, chatApprovals, statusLabel } from './ui-helpers.mjs';
import { mergeRuntimeStreams } from './ui-refresh.mjs';
import { renderRichContent, renderOutputImages } from './rich-content.mjs';
import { createRunActivity } from './run-activity.mjs';
import { transcriptTimeline, reconcileTranscript, preserveTranscriptViewport } from './transcript-timeline.mjs';
import { pendingUserMessages, projectApprovalTitle } from './workspace-controls.mjs';

export function createRemoteWorkspace({ request, subscribe, el, getDevices, showConnections, onChange = () => {}, document = globalThis.document }) {
  const button = (label, callback, className = 'button') => { const node = el('button', className, label); node.type = 'button'; node.addEventListener('click', async () => { node.disabled = true; try { await callback(); } catch (error) { setError(error); } finally { node.disabled = false; renderStatus(); renderApprovals(); } }); return node; };
  const root = el('section', 'remote-workspace'); root.id = 'remote-workspace'; root.hidden = true; root.setAttribute('aria-label', 'Remote workspace');
  const header = el('header', 'remote-header'), hostLabel = el('strong'), hostSelect = el('select'); hostSelect.id = 'remote-host'; hostSelect.setAttribute('aria-label', 'Workspace device');
  const connections = button('Connections', () => { close(); showConnections(); });
  header.append(hostLabel, hostSelect, connections); root.append(header);
  const layout = el('div', 'remote-layout'), sidebar = el('aside', 'remote-sidebar'), sidebarTop = el('div', 'remote-sidebar-top');
  const newChat = button('＋ New chat', () => createChat()); newChat.id = 'remote-new-chat';
  const archive = el('label', 'remote-archive'), archiveInput = el('input'); archiveInput.type = 'checkbox'; archiveInput.id = 'remote-show-archived'; archive.append(archiveInput, document.createTextNode('Show archived'));
  const navigation = el('nav', 'project-list'); navigation.id = 'remote-projects'; navigation.setAttribute('aria-label', 'Host projects and chats'); sidebarTop.append(newChat, archive); sidebar.append(sidebarTop, navigation);
  const conversation = el('section', 'remote-conversation'), titlebar = el('div', 'remote-chat-heading'), title = el('h1'), model = el('span', 'hint');
  const chooseModel = button('Choose host model', () => showModels(), 'text-button'); chooseModel.id = 'remote-choose-model';
  const modelGroup = el('div', 'remote-model-label'); modelGroup.append(model, chooseModel);
  title.id = 'remote-chat-title'; titlebar.append(title, modelGroup);
  const modelPanel = el('div', 'remote-model-picker'); modelPanel.id = 'remote-model-picker'; modelPanel.hidden = true;
  const providerLabel = el('label', 'form-row'), providerSelect = el('select'), modelLabel = el('label', 'form-row'), modelSelect = el('select'); providerSelect.id = 'remote-model-provider'; modelSelect.id = 'remote-model-choice'; providerLabel.append(el('span', '', 'Host connection'), providerSelect); modelLabel.append(el('span', '', 'Host model'), modelSelect);
  const applyModel = button('Use on host', async () => { if (!selectedChatId || !providerSelect.value || !modelSelect.value) return; await mutate('chat.selectModel', { chatId: selectedChatId, providerId: providerSelect.value, model: modelSelect.value }); if (!lastError) modelPanel.hidden = true; }); applyModel.id = 'remote-use-model';
  const modelNotice = el('p', 'hint'); modelPanel.append(providerLabel, modelLabel, applyModel, button('Cancel', () => { modelPanel.hidden = true; }), modelNotice);
  const notice = el('div', 'remote-notice'); notice.id = 'remote-notice'; notice.setAttribute('role', 'status');
  const retry = button('Retry connection', () => reconnect()); retry.id = 'remote-retry'; retry.hidden = true;
  const older = button('Load older messages', () => loadOlder()); older.id = 'remote-load-older'; older.hidden = true;
  const transcript = el('div', 'transcript'); transcript.id = 'remote-transcript'; transcript.tabIndex = 0; transcript.setAttribute('aria-label', 'Host chat messages');
  const composerWrap = el('div', 'composer-wrap'), approvalList = el('div', 'approval-list'); approvalList.id = 'remote-approvals'; approvalList.setAttribute('aria-live', 'polite');
  const composer = el('form', 'composer'), prompt = el('textarea'); composer.id = 'remote-composer'; prompt.id = 'remote-prompt'; prompt.rows = 2; prompt.setAttribute('aria-label', 'Message the host');
  const toolbar = el('div', 'remote-composer-toolbar'), caption = el('p', 'hint remote-composer-caption');
  const compact = button('Compact & continue', () => mutate('chat.compact', { chatId: selectedChatId })); compact.id = 'remote-compact';
  const clearDraft = button('Clear draft', () => { drafts.delete(key()); prompt.value = ''; renderStatus(); onChange(); }, 'text-button'); clearDraft.id = 'remote-clear-draft';
  const stop = button('■ Stop', () => mutate('chat.stop', { chatId: selectedChatId }), 'button remote-stop'); stop.id = 'remote-stop';
  const forceStop = button('Force stop', () => mutate('chat.forceStop', { chatId: selectedChatId }), 'text-button'); forceStop.id = 'remote-force-stop';
  const send = el('button', 'button primary', 'Send'); send.type = 'submit'; send.id = 'remote-send'; toolbar.append(compact, clearDraft, el('span', 'composer-spacer'), forceStop, stop, send);
  composer.append(prompt, toolbar); composerWrap.append(approvalList, composer, caption); conversation.append(titlebar, modelPanel, notice, retry, older, transcript, composerWrap); layout.append(sidebar, conversation); root.append(layout); document.body.append(root);
  const localShell = document.querySelector('.shell'), drafts = new Map(), selections = new Map(), streams = new Map(), messageNodes = new Map(), streamNodes = new Map();
  let deviceId, selectedChatId, selectedProjectId, state = { projects: [], chats: [], runs: [], approvals: [] }, selectedDetail, online = false, connecting = false, pending = false, session = 0, chatGeneration = 0, streamVersion = -1, timer, chatTimer, polling, listVersion = '', transcriptIdentity, readSequence = 0, lastError = '', returnFocus, directoryRevision, chatRevision, olderToken, loadingOlder = false, hostProviders = [];
  const key = () => `${deviceId}:${selectedChatId || `new:${selectedProjectId || ''}`}`;
  const currentChat = () => state.chats.find(chat => chat.id === selectedChatId);
  const currentProject = () => state.projects.find(project => project.id === (currentChat()?.projectId || selectedProjectId));
  const currentDevice = () => getDevices().find(device => device.id === deviceId);
  const saveDraft = () => { if (deviceId) drafts.set(key(), prompt.value); };
  const hasDrafts = () => [...drafts.values()].some(value => value.length > 0) || prompt.value.length > 0;
  const appendResult = (parent, value, image) => { parent.append(el('pre', 'result-content', displayText(value))); const images = renderOutputImages([image, value?.image], { document }); if (images.childNodes.length) parent.append(images); };
  const activity = createRunActivity({ el, button, appendResult, selectChat: id => selectChat(id), resolveApproval });
  function resolveApproval(id, allow) { const approval = state.approvals.find(item => item.id === id); if (!approval) throw new Error('This host approval is no longer pending.'); return mutate('approval.resolve', { id, chatId: approval.chatId, allow }); }

  async function rpc(method, params = {}, target = deviceId) {
    const read = ['workspace.list', 'workspace.models', 'chat.read'].includes(method);
    if (!target || target !== deviceId || !online && !(connecting && read)) throw new Error('This host is offline. Reconnect before sending an action.');
    return request('remote.request', { deviceId: target, method, params, ...(!read ? { requestId: globalThis.crypto.randomUUID() } : {}) });
  }
  function setError(error) { lastError = error?.message || String(error); notice.textContent = lastError; notice.classList.add('error-text'); }
  function renderStatus() {
    const host = currentDevice(), name = host?.name || host?.deviceName || 'Host'; hostLabel.textContent = `Remote · ${name}`;
    const choices = [{ id: '', name: 'This PC · local workspace' }, ...getDevices().map(device => ({ id: device.id, name: `${device.name || device.deviceName || 'Host'}${device.online ? '' : ' · offline'}` }))];
    const signature = JSON.stringify(choices); if (hostSelect.choiceSignature !== signature) { hostSelect.choiceSignature = signature; hostSelect.replaceChildren(...choices.map(device => { const option = el('option', '', device.name); option.value = device.id; return option; })); } hostSelect.value = deviceId || '';
    notice.classList.toggle('error-text', Boolean(lastError) || !online && !connecting); notice.textContent = connecting ? `Connecting to ${name}…` : !online ? `${lastError ? `${lastError} ` : ''}Disconnected from ${name}. Your draft is kept here.` : lastError || `Connected to ${name}. Models, tools and files run on the host.`;
    retry.hidden = online || connecting; retry.disabled = connecting;
    const chat = currentChat(), project = currentProject(), run = latestRun(state, chat?.id), archived = chat?.archived || project?.archived, readOnly = archived || chat?.readOnly;
    title.textContent = chat?.title || project?.name || 'Host workspace';
    model.textContent = selectedDetail?.modelName || selectedDetail?.model || '';
    chooseModel.disabled = !online || pending || !chat || readOnly; applyModel.disabled = !online || pending || !chat || readOnly || !modelSelect.value;
    prompt.disabled = !online || pending || !project || readOnly; prompt.placeholder = readOnly ? archived ? 'Archived chat · read only' : 'Host-managed chat · read only' : `Message ${name}…`;
    send.disabled = !online || pending || !project || readOnly || !prompt.value.trim(); send.textContent = isActive(run) ? 'Send follow-up' : 'Send';
    newChat.disabled = !online || pending || !project || project.archived;
    stop.hidden = forceStop.hidden = !isActive(run); stop.disabled = forceStop.disabled = !online || pending || readOnly;
    compact.hidden = !run?.contextOverflow; compact.disabled = !online || pending || readOnly || isActive(run);
    older.hidden = !olderToken; older.disabled = !online || loadingOlder;
    clearDraft.hidden = !prompt.value.length; clearDraft.disabled = pending;
    caption.textContent = readOnly ? archived ? 'Archived history is available to read.' : 'Manage this external session on the host.' : `Actions ask for approval on ${name}. Enter to send · Shift Enter for a new line`;
  }
  function renderNavigation() {
    const signature = JSON.stringify([selectedChatId, selectedProjectId, archiveInput.checked, state.projects, state.chats.map(chat => [chat.id, chat.projectId, chat.parentChatId, chat.archived, chat.title, chat.status, chat.createdAt, chat.lastAssistantAt, chat.messages?.findLast(message => message.role === 'assistant')?.createdAt]), state.runs.map(run => [run.chatId, run.status])]);
    if (signature === listVersion) return; listVersion = signature;
    const focused = navigation.contains(document.activeElement) ? document.activeElement?.dataset?.remoteChatId || document.activeElement?.dataset?.remoteProjectId : null;
    navigation.replaceChildren();
    for (const project of state.projects.filter(project => archiveInput.checked || !project.archived)) {
      const group = el('div', 'project-group'), heading = button(`${project.name}${project.archived ? ' · archived' : ''}`, () => selectChat(null, project.id), 'project-button');
      heading.dataset.remoteProjectId = project.id; if (project.id === selectedProjectId && !selectedChatId) heading.setAttribute('aria-current', 'page'); group.append(heading);
      for (const { chat, depth } of remoteChatFamilies(state, project.id, archiveInput.checked)) {
        const item = button('', () => selectChat(chat.id), `chat-nav${chat.id === selectedChatId ? ' selected' : ''}`); item.dataset.remoteChatId = chat.id; item.style.paddingLeft = `${12 + Math.min(depth, 8) * 15}px`;
        item.append(el('span', 'chat-name', `${depth ? '↳ ' : ''}${chat.title}${chat.archived ? ' · archived' : ''}`)); if (chat.id === selectedChatId) item.setAttribute('aria-current', 'page');
        if (isActive(latestRun(state, chat.id) || { status: chat.status })) { const dot = el('span', 'status-dot'); dot.setAttribute('aria-label', 'Running'); item.append(dot); } group.append(item);
      }
      navigation.append(group);
    }
    if (!navigation.childNodes.length) navigation.append(el('p', 'subtle-empty', 'No projects are available on this host.'));
    if (focused) [...navigation.querySelectorAll('button')].find(node => node.dataset.remoteChatId === focused || node.dataset.remoteProjectId === focused)?.focus({ preventScroll: true });
  }
  function messageNode(message) {
    let cached = messageNodes.get(message.id); if (sameMessage(cached?.message, message)) return cached.node;
    const node = el('article', `message ${message.role === 'user' ? 'user' : 'assistant'}${message.status === 'pending' ? ' pending-followup' : ''}`); node.dataset.messageId = message.id;
    node.append(el('div', 'message-heading', message.status === 'pending' ? 'You · queued follow-up' : message.role === 'user' ? 'You' : message.role === 'tool' ? message.toolName || 'Tool' : 'Faber'));
    const content = el('div', 'message-content'); content.append(renderRichContent(message.content, { document, onOpenLink: url => request('app.openLink', { url }).catch(setError) })); node.append(content);
    const images = renderOutputImages([message.image, ...(message.images || [])], { document }); if (images.childNodes.length) node.append(images);
    cached = { message, node }; messageNodes.set(message.id, cached); return node;
  }
  function renderTranscript() {
    const identity = `${deviceId}:${selectedChatId || ''}`;
    if (transcriptIdentity !== identity) { transcriptIdentity = identity; transcript.replaceChildren(); messageNodes.clear(); streamNodes.clear(); activity.reset(); }
    preserveTranscriptViewport(transcript, () => {
      const nodes = [];
      if (selectedDetail?.id === selectedChatId) {
        const timeline = transcriptTimeline({ ...state, approvals: [] }, selectedChatId, streams);
        for (const row of timeline) {
          if (row.kind === 'activity') { nodes.push(activity.get(state, { ...row.activity, approvals: [] }, streams)); continue; }
          if (row.kind === 'message') { nodes.push(messageNode(row.message)); continue; }
          let cached = streamNodes.get(row.key);
          if (!cached) { const node = el('article', 'message assistant streaming'); node.dataset.runId = row.run.id; node.append(el('div', 'message-heading', 'Faber'), el('div', 'message-content')); cached = { node }; streamNodes.set(row.key, cached); }
          if (cached.text !== row.text) { cached.text = row.text; cached.node.lastChild.replaceChildren(renderRichContent(row.text, { document, onOpenLink: url => request('app.openLink', { url }).catch(setError) }), el('span', 'stream-cursor')); } nodes.push(cached.node);
        }
        for (const message of pendingUserMessages(selectedDetail)) nodes.push(messageNode(message));
        const run = latestRun(state, selectedChatId); if (run && !isActive(run) && ['failed', 'interrupted', 'canceled'].includes(run.status)) nodes.push(el('p', 'run-note', run.error || `Run ${statusLabel(run.status).toLowerCase()}.`));
      }
      if (!nodes.length) { const welcome = el('div', 'welcome'); welcome.append(el('h1', '', selectedChatId ? selectedDetail ? 'Start a conversation.' : 'Loading chat…' : 'Your host workspace'), el('p', '', selectedChatId ? 'Messages and tool activity appear here.' : 'Choose a project and chat, or start a new chat on this host.')); nodes.push(welcome); }
      reconcileTranscript(transcript, nodes);
    });
  }
  function renderApprovals() {
    const pendingApprovals = selectedChatId ? chatApprovals(state, selectedChatId) : [], readOnly = currentChat()?.readOnly || currentChat()?.archived || currentProject()?.archived, signature = JSON.stringify([online, pending, readOnly, pendingApprovals]);
    if (approvalList.signature === signature) return; approvalList.signature = signature; approvalList.replaceChildren();
    for (const approval of pendingApprovals) {
      const card = el('section', 'approval'); card.dataset.approvalId = approval.id;
      const allow = button('Allow this action', () => resolveApproval(approval.id, true), 'button primary'), deny = button('Deny', () => resolveApproval(approval.id, false)); allow.disabled = deny.disabled = !online || pending || readOnly;
      card.append(el('h3', '', projectApprovalTitle(approval)), el('p', '', approval.summary), el('p', 'hint', `Runs on ${currentDevice()?.name || currentDevice()?.deviceName || 'the host'}. Approval applies to this action.`), allow, deny); approvalList.append(card);
    }
  }
  function render() { const following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 8; renderStatus(); renderNavigation(); renderApprovals(); renderTranscript(); if (following) transcript.scrollTop = transcript.scrollHeight; }
  function renderModelChoices() {
    const provider = hostProviders.find(item => item.id === providerSelect.value); modelSelect.replaceChildren(...(provider?.models || []).map(item => { const option = el('option', '', item.name || item.id); option.value = item.id; return option; }));
    modelSelect.value = provider?.models.some(item => item.id === selectedDetail?.model) ? selectedDetail.model : provider?.model || provider?.models[0]?.id || ''; renderStatus();
  }
  async function showModels() {
    if (!online || !selectedChatId) return; const token = session, chatId = selectedChatId;
    const value = await rpc('workspace.models'); if (token !== session || chatId !== selectedChatId) return;
    if (!Array.isArray(value?.providers)) throw new Error('The host returned invalid model choices.');
    hostProviders = value.providers.filter(item => typeof item?.id === 'string' && Array.isArray(item.models)).map(item => ({ id: item.id, name: typeof item.name === 'string' ? item.name : 'Host connection', model: typeof item.model === 'string' ? item.model : '', models: item.models.filter(model => typeof model?.id === 'string').map(model => ({ id: model.id, name: typeof model.name === 'string' ? model.name : model.id })) }));
    modelNotice.textContent = hostProviders.some(provider => provider.models.length) ? 'Applies to the next run. Active work keeps its current host model.' : 'No models are configured on the host. Choose or start a model in Faber on that PC.';
    providerSelect.replaceChildren(...hostProviders.map(provider => { const option = el('option', '', provider.name); option.value = provider.id; return option; })); providerSelect.value = hostProviders.some(provider => provider.id === selectedDetail?.providerId) ? selectedDetail.providerId : hostProviders[0]?.id || ''; renderModelChoices(); modelPanel.hidden = false; providerSelect.focus();
  }
  providerSelect.addEventListener('change', renderModelChoices); modelSelect.addEventListener('change', renderStatus);
  function acceptStreams(value) { if (Number.isSafeInteger(value.streamSequence)) streamVersion = mergeRuntimeStreams(streams, value, streamVersion); else if (Array.isArray(value.streams)) { streams.clear(); for (const stream of value.streams) streams.set(stream.runId, stream); } }
  async function readChat(token = session, wait = false) {
    const chatId = selectedChatId, sequence = ++readSequence; if (!chatId || !online) return;
    const response = await rpc('chat.read', { chatId, limit: 30, ...(wait && chatRevision ? { since: chatRevision, waitMs: 12000 } : {}) });
    if (token !== session || chatId !== selectedChatId || sequence !== readSequence) return;
    if (response?.unchanged === true) return;
    if (response?.liveOnly === true) { if (selectedDetail?.id !== chatId) throw new Error('Reload this host chat before accepting live updates.'); const live = remoteLive(response, chatId); chatRevision = live.revision; acceptStreams(live); renderTranscript(); return; }
    const value = remoteChat(response, chatId); chatRevision = value.revision;
    if (selectedDetail?.id === chatId) { const ids = new Set(value.chat.messages.map(message => message.id)); value.chat.messages = [...selectedDetail.messages.filter(message => !ids.has(message.id)), ...value.chat.messages]; }
    else olderToken = value.before;
    selectedDetail = value.chat; state = { ...state, chats: state.chats.map(chat => chat.id === chatId ? { ...chat, ...value.chat } : chat), runs: value.runs, approvals: value.approvals };
    acceptStreams(value); render();
  }
  async function loadOlder() {
    if (!olderToken || loadingOlder || !online) return;
    const token = session, chatId = selectedChatId, before = olderToken; loadingOlder = true; renderStatus();
    try {
      const value = remoteChat(await rpc('chat.read', { chatId, before, limit: 50 }), chatId);
      if (token !== session || chatId !== selectedChatId || before !== olderToken) return;
      const ids = new Set(selectedDetail.messages.map(message => message.id)); selectedDetail = { ...selectedDetail, messages: [...value.chat.messages.filter(message => !ids.has(message.id)), ...selectedDetail.messages] };
      olderToken = value.before; state.chats = state.chats.map(chat => chat.id === chatId ? { ...chat, messages: selectedDetail.messages } : chat); renderTranscript();
    } finally { if (token === session) { loadingOlder = false; renderStatus(); } }
  }
  async function reload(token = session, read = true) {
    if (!online && !connecting || root.hidden) return;
    const response = await rpc('workspace.list', { limit: 200, ...(directoryRevision ? { since: directoryRevision } : {}) });
    if (token !== session) return;
    online = true; connecting = false;
    if (response?.unchanged !== true) {
      const value = remoteWorkspace(response), projects = new Map(value.projects.map(project => [project.id, project])), chats = new Map(value.chats.map(chat => [chat.id, chat])); let offset = value.nextOffset;
      const offsets = new Set();
      while (offset !== null && offset !== undefined) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offsets.has(offset)) throw new Error('The host returned invalid workspace pagination.'); offsets.add(offset);
        const page = remoteWorkspace(await rpc('workspace.list', { offset, limit: 200 })); if (token !== session) return;
        for (const project of page.projects) projects.set(project.id, project); for (const chat of page.chats) chats.set(chat.id, chat); offset = page.nextOffset;
      }
      directoryRevision = value.revision;
      state = { ...state, projects: [...projects.values()], chats: [...chats.values()].map(chat => chat.id === selectedDetail?.id ? { ...chat, messages: selectedDetail.messages, inbox: selectedDetail.inbox } : chat) };
    }
    if (selectedChatId && !state.chats.some(chat => chat.id === selectedChatId)) { saveDraft(); selectedChatId = null; selectedDetail = undefined; prompt.value = drafts.get(key()) || ''; }
    if (!state.projects.some(project => project.id === selectedProjectId)) selectedProjectId = state.projects.find(project => !project.archived)?.id || state.projects[0]?.id;
    render(); if (read) await readChat(token);
  }
  async function poll() {
    if (root.hidden || polling) return;
    const token = session;
    const task = reload(token, false); polling = task;
    try { await task; if (token === session) { lastError = ''; renderStatus(); } } catch (error) { if (token === session) { online = connecting = false; setError(error); renderStatus(); } }
    finally { if (polling === task) polling = undefined; if (!root.hidden && token === session) timer = setTimeout(poll, 8000); }
  }
  async function pollChat(token = session, generation = chatGeneration) {
    if (root.hidden || token !== session || generation !== chatGeneration || !online || !selectedChatId) return;
    try { await readChat(token, true); }
    catch (error) { if (token === session && generation === chatGeneration) { online = connecting = false; setError(error); renderStatus(); } }
    finally { if (!root.hidden && token === session && generation === chatGeneration && online) chatTimer = setTimeout(() => pollChat(token, generation), 300); }
  }
  async function selectChat(chatId, projectId = selectedProjectId) {
    saveDraft(); clearTimeout(chatTimer); ++chatGeneration; selectedChatId = chatId; selectedDetail = undefined; olderToken = chatRevision = undefined; modelPanel.hidden = true; selectedProjectId = currentChat()?.projectId || projectId; ++readSequence;
    selections.set(deviceId, { selectedChatId, selectedProjectId }); prompt.value = drafts.get(key()) || ''; render();
    if (chatId) { const token = session, generation = chatGeneration; try { await readChat(token); } catch (error) { if (token === session && generation === chatGeneration) setError(error); } if (token === session && generation === chatGeneration) void pollChat(token, generation); } prompt.focus(); onChange();
  }
  async function mutate(method, params) {
    if (pending) return; const token = session, target = deviceId;
    pending = true; renderStatus();
    try { await rpc(method, params, target); if (token === session) { lastError = ''; await reload(token); } }
    catch (error) { if (token === session) setError(error); }
    finally { if (token === session) { pending = false; render(); } onChange(); }
  }
  async function createChat() {
    if (pending || !online || !currentProject() || currentProject().archived) return;
    const token = session, projectId = selectedProjectId; pending = true; renderStatus();
    try { const chat = await rpc('chat.create', { projectId }); if (token !== session) return; if (!chat || typeof chat.id !== 'string') throw new Error('The host returned an invalid new chat.'); await reload(token); await selectChat(chat.id, projectId); }
    catch (error) { if (token === session) setError(error); }
    finally { if (token === session) { pending = false; renderStatus(); } onChange(); }
  }
  async function submit() {
    const submitted = prompt.value, draft = key(), token = session; if (!submitted.trim() || pending || !online || prompt.disabled) return;
    pending = true; renderStatus();
    try {
      let chatId = selectedChatId;
      if (!chatId) { const chat = await rpc('chat.create', { projectId: selectedProjectId }); if (token !== session) return; if (!chat || typeof chat.id !== 'string') throw new Error('The host returned an invalid new chat.'); chatId = chat.id; await reload(token); await selectChat(chatId); drafts.set(key(), submitted); prompt.value = submitted; }
      await rpc('chat.send', { chatId, text: submitted });
      if (token === session) { drafts.delete(draft); if (prompt.value === submitted) { prompt.value = ''; drafts.delete(key()); } lastError = ''; await reload(token); }
    } catch (error) { if (token === session) setError(error); }
    finally { if (token === session) { pending = false; render(); prompt.focus(); } onChange(); }
  }
  function open(id) {
    saveDraft(); clearTimeout(timer); clearTimeout(chatTimer); ++session; ++chatGeneration; polling = undefined; deviceId = id; online = false; connecting = true; selectedDetail = undefined; pending = false; lastError = ''; modelPanel.hidden = true; directoryRevision = chatRevision = olderToken = undefined; streamVersion = -1; streams.clear(); state = { projects: [], chats: [], runs: [], approvals: [] };
    ({ selectedChatId, selectedProjectId } = selections.get(id) || {}); prompt.value = drafts.get(key()) || ''; returnFocus ||= document.activeElement; root.hidden = false; localShell.inert = true; localShell.hidden = true; document.body.classList.add('remote-open'); render(); hostSelect.focus(); const token = session; void poll().then(() => { if (token === session) void pollChat(token); }); onChange();
  }
  function reconnect() { clearTimeout(timer); clearTimeout(chatTimer); ++session; ++chatGeneration; polling = undefined; connecting = true; online = false; pending = false; lastError = ''; renderStatus(); const token = session; return poll().then(() => { if (token === session) void pollChat(token); }); }
  function close() { if (root.hidden) return; saveDraft(); clearTimeout(timer); clearTimeout(chatTimer); ++session; ++chatGeneration; ++readSequence; pending = false; selections.set(deviceId, { selectedChatId, selectedProjectId }); root.hidden = true; localShell.inert = false; localShell.hidden = false; document.body.classList.remove('remote-open'); returnFocus?.focus(); returnFocus = undefined; onChange(); }
  function updateDevices() { if (root.hidden || connecting) return; const wasOnline = online; online = currentDevice()?.online === true; if (wasOnline && !online) { clearTimeout(timer); clearTimeout(chatTimer); ++session; ++chatGeneration; pending = false; } renderStatus(); renderApprovals(); if (!wasOnline && online) { clearTimeout(timer); clearTimeout(chatTimer); void poll(); void pollChat(); } }
  subscribe?.(envelope => {
    const event = remoteEvent(envelope, deviceId); if (!event || root.hidden || !online) return;
    if (['delta', 'progress'].includes(event.type) && Number.isSafeInteger(event.streamSequence) && Number.isSafeInteger(event.sequence) && typeof event.runId === 'string' && (event.type !== 'delta' || typeof event.text === 'string')) { acceptStreams(event); renderTranscript(); }
    else if (['state', 'approval'].includes(event.type)) { clearTimeout(timer); void poll(); }
  });
  archiveInput.addEventListener('change', () => { renderNavigation(); if (!archiveInput.checked && (currentChat()?.archived || currentProject()?.archived)) void selectChat(null, state.projects.find(project => !project.archived)?.id); });
  hostSelect.addEventListener('change', () => hostSelect.value ? open(hostSelect.value) : close());
  prompt.addEventListener('input', () => { saveDraft(); renderStatus(); onChange(); }); composer.addEventListener('submit', event => { event.preventDefault(); void submit(); });
  prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); } });
  root.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); event.stopPropagation(); void createChat(); } });
  return { open, close, updateDevices, isOpen: () => !root.hidden, hasDrafts, clearDrafts: () => { drafts.clear(); prompt.value = ''; renderStatus(); onChange(); }, refreshReason: () => !root.hidden || hasDrafts() ? 'Return to this PC and send or clear remote drafts before refreshing the interface.' : '' };
}
