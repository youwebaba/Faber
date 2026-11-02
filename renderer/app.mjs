import { PERMISSIONS, isActive, latestRun, visibleChats, safeImage, displayText, parseArguments, statusLabel, extensionActions, streamText, reconcileStreams, sameMessage, chatApprovals } from './ui-helpers.mjs';
import { createModelsBrowser } from './models.mjs';
import { createConnections, providerKindLabel } from './connections.mjs';
import { createAddonManager } from './addons.mjs';
import { callUsage } from './chat-media.mjs';
import { createAttachmentDrafts, attachmentMessage, FILE_ACCEPT } from './file-attachments.mjs';
import { composeUISnapshot, validateUISnapshot, refreshBlocker, mergeRuntimeStreams, interfaceError } from './ui-refresh.mjs';
import { createNavigationMenu, deletionWarning } from './chat-navigation.mjs';
import { createChatControls } from './chat-controls.mjs';
import { createRunActivity } from './run-activity.mjs';

const $ = selector => document.querySelector(selector);
const bridge = window.faber;
let state = { projects: [], chats: [], runs: [], providers: [], tools: [], extensions: [], approvals: [], settings: {} };
let selectedChatId = readLocal('faber.chat');
let selectedProjectId = readLocal('faber.project');
let voice = { status: 'off' };
let sending = false;
let initialState = true;
let bootstrapping = true, uiHandoff = false, pendingRequests = 0, pendingPicker = false, composing = false, pendingUpdateId, acceptedReloadId, retryTimer, streamVersion = -1, stateVersion = -1;
let downloadDirectory;
const startupEvents = [], handoffVoiceEvents = [];
const streams = new Map();
const drafts = new Map();
const imageDrafts = createAttachmentDrafts({ onChange: key => { if (key === draftKey()) renderImageDrafts(); scheduleUIRefresh(); } });
let imageDraftRenderKey;
const messageNodes = new Map();
let transcriptChatId;
let modalReturnFocus;
const icons = {
  panel: ['M8 3v18', 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z'],
  compose: ['m14 4 6 6', 'm5 13 10-10 6 6-10 10-7 1Z', 'M3 6v15h15'],
  tools: ['m14 6 4-3 3 3-3 4', 'M14 6a6 6 0 0 0-7 7l-4 4a2.8 2.8 0 0 0 4 4l4-4a6 6 0 0 0 7-7'],
  models: ['m12 3 9 5-9 5-9-5Z', 'm3 12 9 5 9-5', 'm3 16 9 5 9-5'],
  addons: ['M4 4h6v5a2 2 0 1 0 4 0V4h6v6h-5a2 2 0 1 0 0 4h5v6h-6v-5a2 2 0 1 0-4 0v5H4v-6h5a2 2 0 1 0 0-4H4Z'],
  paperclip: ['m21 11-9 9a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9-9'],
  plus: ['M12 5v14', 'M5 12h14'], close: ['m6 6 12 12', 'M6 18 18 6'],
  settings: ['m9 3-.8 3-3 .8-2 3 2 2-.2 3.2 3 1.8 1 3.2h4l1-3.2 3-1.8-.2-3.2 2-2-2-3-3-.8L13 3Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  sliders: ['M4 7h5m4 0h7M4 17h9m4 0h3', 'M9 4v6m4 4v6'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'], mic: ['M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Z', 'M5 10v2a7 7 0 0 0 14 0v-2', 'M12 19v3m-4 0h8'],
  arrow: ['M12 19V5', 'm6 11 6-6 6 6'], stop: ['M6 6h12v12H6Z'],
  brain: ['M12 4a3 3 0 0 0-5-2 4 4 0 0 0-3 6 4 4 0 0 0 0 8 4 4 0 0 0 5 5 3 3 0 0 0 3-3Z', 'M12 4a3 3 0 0 1 5-2 4 4 0 0 1 3 6 4 4 0 0 1 0 8 4 4 0 0 1-5 5 3 3 0 0 1-3-3Z', 'M7 7c0 2 2 3 3 3M17 7c0 2-2 3-3 3M6 15c1-1 3-1 4 0M18 15c-1-1-3-1-4 0'],
  folder: ['M3 6h7l2 2h9v12H3Z'], chevron: ['m9 5 7 7-7 7'], copy: ['M9 9h11v12H9Z', 'M15 9V3H3v12h6'],
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  for (const d of icons[name] || icons.chevron) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
document.querySelectorAll('[data-icon]').forEach(button => button.prepend(icon(button.dataset.icon)));
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function wordmark(className) { const image = el('img', `faber-wordmark ${className}`); image.src = 'assets/faber-wordmark.svg'; image.alt = 'Faber — Maker of Things'; image.width = 2172; image.height = 724; return image; }
function button(text, callback, className = 'button') { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', async () => { node.disabled = true; try { await act(callback); } finally { node.disabled = false; } }); return node; }
function readLocal(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeLocal(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* Selection persistence is optional. */ } }
function currentChat() { return state.chats.find(chat => chat.id === selectedChatId && !chat.archived && state.projects.some(project => project.id === chat.projectId && !project.archived)); }
function currentProject() { return state.projects.find(project => project.id === (currentChat()?.projectId || selectedProjectId) && !project.archived); }
function currentProvider() { return state.providers.find(provider => provider.id === currentChat()?.providerId) || state.providers[0]; }
function draftKey() { return selectedChatId || `new:${selectedProjectId || ''}`; }
function updateSendButton() { const images = imageDrafts.get(draftKey()); $('#send-message').disabled = sending || images.some(item => item.pending) || (!$('#prompt').value.trim() && !images.length); }
function renderImageDrafts() {
  const key = draftKey(); const items = imageDrafts.get(key); const root = $('#image-drafts');
  const signature = JSON.stringify([key, items.map(item => [item.id, item.pending])]);
  if (signature === imageDraftRenderKey) { updateSendButton(); return; }
  imageDraftRenderKey = signature;
  root.hidden = !items.length; root.replaceChildren();
  for (const [index, item] of items.entries()) {
    const preview = el('div', `image-draft${item.kind === 'text' ? ' file-draft' : ''}`); preview.dataset.attachmentId = item.id; preview.title = item.name;
    if (item.image) { const image = el('img'); image.src = item.image; image.alt = `Attached image ${index + 1}: ${item.name}`; preview.append(image); }
    else if (item.pending) preview.append(el('span', '', 'Reading…'));
    else preview.append(icon('paperclip'), el('span', '', item.name));
    const remove = button('×', () => imageDrafts.remove(key, [item.id])); remove.setAttribute('aria-label', `Remove attachment ${index + 1}: ${item.name}`); preview.append(remove); root.append(preview);
  }
  const status = $('#image-draft-status'); status.hidden = !items.length; status.textContent = items.some(item => item.pending) ? 'Reading attachments…' : `${items.length} file${items.length === 1 ? '' : 's'} attached · Sent to the selected connection with your message`;
  updateSendButton();
}
function notify(message, error = false) { $('#notice-text').textContent = message; $('#notice').classList.toggle('error', error); $('#notice').hidden = false; $('#live-status').textContent = message; }
async function act(callback) { try { return await callback(); } catch (error) { notify(error.message || String(error), true); } }
async function request(method, params = {}) {
  if (!bridge) throw new Error('The desktop bridge is unavailable. Open Faber with its desktop launcher.');
  const tracked = !['app.reloadUI', 'app.uiState', 'app.uiStateAck'].includes(method);
  if (tracked) pendingRequests++;
  try { const value = await bridge.request(method, params); if (method === 'models.state') downloadDirectory = value.downloadDirectory; return value; }
  finally { if (tracked) { pendingRequests--; scheduleUIRefresh(); } }
}
async function refresh() { acceptState(await request('state.get')); }
function acceptState(next) {
  if (Number.isSafeInteger(next.stateRevision)) { if (next.stateRevision < stateVersion) return; stateVersion = next.stateRevision; }
  if (Number.isSafeInteger(next.streamSequence)) streamVersion = mergeRuntimeStreams(streams, next, streamVersion);
  else reconcileStreams(streams, next);
  const previousKey = draftKey();
  const removed = [...state.chats.filter(chat => !next.chats.some(item => item.id === chat.id)).map(chat => chat.id), ...state.projects.filter(project => !next.projects.some(item => item.id === project.id)).map(project => `new:${project.id}`)];
  for (const key of removed) { drafts.delete(key); imageDrafts.remove(key, imageDrafts.get(key).map(item => item.id)); }
  state = next;
  if (!currentChat()) selectedChatId = null;
  const available = state.chats.filter(chat => !chat.archived && state.projects.some(project => project.id === chat.projectId && !project.archived));
  if (initialState && !selectedChatId) selectedChatId = available.find(chat => chat.projectId === selectedProjectId)?.id || available[0]?.id || null;
  initialState = false;
  if (!currentProject()) selectedProjectId = state.projects.find(project => !project.archived)?.id || null;
  if (previousKey !== draftKey()) { if (!removed.includes(previousKey)) drafts.set(previousKey, $('#prompt').value); $('#prompt').value = drafts.get(draftKey()) || ''; }
  writeLocal('faber.chat', selectedChatId); writeLocal('faber.project', currentProject()?.id || selectedProjectId);
  applyTheme(state.settings?.theme || 'system');
  render();
}
function applyTheme(theme) { document.documentElement.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme; }
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(state.settings?.theme || 'system'));
function selectChat(chatId, projectId = selectedProjectId) {
  navigationMenu.close();
  modelsBrowser.close();
  drafts.set(draftKey(), $('#prompt').value);
  selectedChatId = chatId;
  selectedProjectId = currentChat()?.projectId || projectId;
  writeLocal('faber.chat', selectedChatId); writeLocal('faber.project', selectedProjectId);
  $('#prompt').value = drafts.get(draftKey()) || '';
  document.body.classList.remove('sidebar-open');
  render(); $('#transcript').scrollTop = $('#transcript').scrollHeight; $('#prompt').focus();
}
function render() {
  const chat = currentChat(); const project = currentProject(); const run = latestRun(state, chat?.id);
  $('#project-name').textContent = project?.name || 'Workspace';
  $('#chat-title').textContent = chat?.title || 'New chat'; $('#chat-title').disabled = !chat;
  $('#chat-options').disabled = !chat;
  const provider = currentProvider(); $('#provider-label').textContent = provider?.name || 'No connection'; $('#model-label').textContent = chat?.model || provider?.model || 'Choose a model';
  $('#model-picker').title = `${provider?.name || 'Add a connection'} / ${chat?.model || provider?.model || 'Choose a model'}`;
  $('#stop-run').hidden = !isActive(run); $('#send-message').hidden = isActive(run);
  renderImageDrafts();
  $('#permission-caption').textContent = chat?.grants?.length ? `${chat.grants.length} chat permission${chat.grants.length === 1 ? '' : 's'} enabled` : 'Actions ask for approval';
  renderNavigation(); renderTranscript(); renderActivity(); renderApprovals(); renderVoice(); renderComposerControls();
}
function renderComposerControls() {
  const run = latestRun(state, currentChat()?.id), metrics = streams.get(run?.id)?.metrics || run?.modelCalls?.at(-1)?.metrics;
  chatControls.setContext(state, metrics, isActive(run));
}
function renderNavigation() {
  const nav = $('#project-list'); nav.replaceChildren();
  if (!state.projects.some(project => !project.archived)) nav.append(el('p', 'subtle-empty', 'Add a folder to start your first project.'));
  for (const project of state.projects.filter(project => !project.archived)) {
    const group = el('div', 'project-group');
    const heading = button('', () => selectChat(null, project.id), 'project-button');
    heading.append(icon('folder'), el('span', '', project.name)); heading.title = project.path; group.append(heading);
    navigationMenu.bind(heading, 'project', project.id);
    const chats = visibleChats(state, project.id).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const chat of chats) {
      const link = button('', () => selectChat(chat.id), `chat-nav${chat.id === selectedChatId ? ' selected' : ''}${chat.parentChatId ? ' child' : ''}`);
      link.append(el('span', 'chat-name', `${chat.parentChatId ? '↳ ' : ''}${chat.title}`)); link.title = chat.title;
      navigationMenu.bind(link, 'chat', chat.id);
      if (chat.id === selectedChatId) link.setAttribute('aria-current', 'page');
      if (isActive(latestRun(state, chat.id))) { const dot = el('span', 'status-dot'); dot.setAttribute('aria-label', 'Running'); link.append(dot); }
      group.append(link);
    }
    if (!chats.length) group.append(button('Start a chat', async () => { selectChat(null, project.id); await newChat(); }, 'chat-nav'));
    nav.append(group);
  }
}
function renderTranscript() {
  const transcript = $('#transcript'); const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
  const previousScroll = transcript.scrollTop;
  transcript.querySelector('.run-activities')?.remove();
  const chat = currentChat(); const messages = (chat?.messages || []).filter(message => message.role !== 'system');
  const identity = chat?.id || `new:${currentProject()?.id || ''}`;
  if (identity !== transcriptChatId) { transcript.replaceChildren(); messageNodes.clear(); transcriptChatId = identity; }
  if (messages.length) transcript.querySelector('.welcome')?.remove();
  if (!messages.length && !transcript.querySelector('.welcome')) {
    const welcome = el('div', 'welcome'); welcome.append(wordmark('welcome-wordmark'), el('h1', '', currentProject() ? 'What are we working on?' : 'Make room for your next idea.'));
    welcome.append(el('p', '', currentProject() ? `Start a conversation in ${currentProject().name}. Faber can explore files, run tools, and bring in other agents.` : 'Choose a project folder, connect a model, and work with Faber on your own computer.'));
    if (!currentProject()) welcome.append(button('Add a project', showProjectForm, 'button primary'));
    else {
      const hints = el('div', 'welcome-hints');
      for (const [label, prompt] of [['Explore this project', 'Explore this project and explain how it works.'], ['Plan a change', 'Help me plan a change to this project.'], ['Use a tool', null]]) hints.append(button(label, () => { if (!prompt) return showTools(); $('#prompt').value = prompt; $('#prompt').focus(); render(); }));
      welcome.append(hints);
    }
    transcript.append(welcome);
  }
  const ids = new Set(messages.map(message => message.id));
  for (const [id, entry] of messageNodes) if (!ids.has(id)) { entry.node.remove(); messageNodes.delete(id); }
  let cursor = transcript.firstChild;
  for (const message of messages) {
    let entry = messageNodes.get(message.id);
    if (!sameMessage(entry?.message, message)) {
      const node = createMessageNode(message);
      if (entry) { if (entry.node.open) node.open = true; if (cursor === entry.node) cursor = node; entry.node.replaceWith(node); }
      entry = { node, message }; messageNodes.set(message.id, entry);
    }
    if (entry.node !== cursor) transcript.insertBefore(entry.node, cursor);
    cursor = entry.node.nextSibling;
  }
  const run = latestRun(state, chat?.id);
  transcript.querySelector('.run-note')?.remove();
  renderStream();
  if (chat) transcript.append(runActivity.render(state, chat.id));
  if (run) {
    const note = el('div', 'run-note');
    if (['canceled', 'interrupted', 'failed'].includes(run.status)) {
      note.append(el('span', '', run.error || (run.status === 'interrupted' ? 'This run was interrupted. Review the history before continuing.' : `Run ${run.status}.`)));
      note.append(button('Continue', () => sendText('Continue from where you stopped. Check the current state before repeating any actions.')));
    }
    if (note.childNodes.length) transcript.append(note);
  }
  transcript.scrollTop = nearBottom ? transcript.scrollHeight : previousScroll;
}
function createMessageNode(message) {
  if (message.role === 'tool') {
    const details = el('details', 'tool-message'); details.dataset.messageId = message.id; details.append(el('summary', '', message.toolName || 'Tool result')); appendResult(details, message.content, message.image); return details;
  }
  const article = el('article', `message ${message.fromChatId ? 'agent-message' : message.role}`); article.dataset.messageId = message.id;
  const author = message.fromChatId ? `Agent: ${state.chats.find(chat => chat.id === message.fromChatId)?.title || 'another chat'}` : message.role === 'user' ? 'You' : 'Faber';
  const heading = el('div', 'message-heading', author);
  if (message.createdAt) { const time = el('time', '', new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); time.dateTime = message.createdAt; heading.append(time); }
  article.append(heading);
  if (message.content) article.append(el('div', 'message-content', displayText(message.content)));
  if (message.images?.length) {
    const attachments = el('div', 'message-images');
    for (const [index, value] of message.images.entries()) { const source = safeImage(value); if (!source) continue; const image = el('img'); image.src = source; image.alt = `Image ${index + 1} attached to this message`; image.loading = 'lazy'; attachments.append(image); }
    if (attachments.childNodes.length) article.append(attachments);
  }
  if (message.toolCalls?.length) article.append(el('div', 'hint', `Using ${message.toolCalls.map(call => call.function?.name || call.name || 'tool').join(', ')}`));
  if (message.role === 'assistant' && message.content) {
    const actions = el('div', 'message-actions');
    actions.append(button('Copy', async () => { await navigator.clipboard.writeText(displayText(message.content)); notify('Copied reply.'); }), button('Read aloud', () => request('voice.speak', { text: displayText(message.content) })));
    article.append(actions);
  }
  return article;
}
function renderStream() {
  const transcript = $('#transcript'); const chat = currentChat(); const run = latestRun(state, chat?.id);
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
  const text = streamText(streams.get(run?.id)?.text, run, chat?.messages || []);
  let article = transcript.querySelector('.streaming');
  if (!text) { article?.remove(); return; }
  if (!article) { article = el('article', 'message assistant streaming'); article.append(el('div', 'message-heading', 'Faber'), el('div', 'message-content')); transcript.insertBefore(article, transcript.querySelector('.run-note')); }
  article.lastChild.replaceChildren(document.createTextNode(text), el('span', 'stream-cursor'));
  if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
}
function appendResult(parent, result, messageImage) {
  let parsed = result;
  if (typeof result === 'string') { try { parsed = JSON.parse(result); } catch { /* Ordinary text is rendered verbatim. */ } }
  const image = safeImage(messageImage) || safeImage(parsed?.image);
  if (image) { const img = el('img', 'tool-image'); img.src = image; img.alt = 'Screenshot returned by the tool'; parent.append(img); }
  const text = image && parsed && typeof parsed === 'object' ? displayText(Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'image'))) : displayText(parsed);
  parent.append(el('pre', 'result-content', text));
}
function renderActivity() {
  const root = $('#activity-content'); const expanded = new Set([...root.querySelectorAll('details[open]')].map(item => item.dataset.eventId));
  const usageOpen = new Map([...root.querySelectorAll('.usage-run')].map(item => [item.dataset.runId, item.open]));
  root.replaceChildren(); const chat = currentChat(); const run = latestRun(state, chat?.id);
  const session = el('section', 'activity-section'); session.append(el('h3', '', 'This chat'));
  session.append(el('p', 'activity-empty', run ? statusLabel(run.status) : 'No run yet. Send a message to get started.'));
  if (run?.error) session.append(el('p', 'error-text', run.error));
  root.append(session);
  if (chat) {
    const usage = el('section', 'activity-section'); usage.id = 'token-usage'; usage.append(el('h3', '', 'Token usage'));
    const runs = state.runs.filter(item => item.chatId === chat.id);
    if (!runs.length) usage.append(el('p', 'activity-empty', 'Provider call counts appear here after a run starts.'));
    for (const [index, item] of [...runs].reverse().entries()) {
      const details = el('details', 'usage-run'); details.dataset.runId = item.id; details.open = usageOpen.get(item.id) ?? index === 0;
      details.append(el('summary', '', `Run ${runs.length - index} · ${statusLabel(item.status)}${item.startedAt ? ` · ${new Date(item.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}`));
      if (!item.modelCalls?.length) details.append(el('p', 'hint', 'Input / output tokens: Not reported. No provider call records are available for this run.'));
      for (const call of item.modelCalls || []) {
        const row = el('div', 'model-call'); row.dataset.callId = call.id; const counts = callUsage(call);
        row.append(el('strong', '', `Call ${call.sequence} · ${statusLabel(call.status)}`), el('p', '', `${state.providers.find(provider => provider.id === call.providerId)?.name || call.providerId || 'Connection not recorded'} / ${call.model || 'Model not recorded'}`));
        const totals = el('div', 'usage-counts');
        for (const [label, value, cls] of [['Input tokens', counts.input, 'usage-input'], ['Output tokens', counts.output, 'usage-output']]) { const count = el('span', '', label); count.append(el('b', cls, value)); totals.append(count); }
        row.append(totals);
        if (call.usage?.cachedInputTokens !== undefined) row.append(el('p', 'usage-cached', `Cached input: ${counts.cached} (included in input)`));
        if (call.usage?.reasoningTokens !== undefined) row.append(el('p', 'usage-reasoning', `Reasoning: ${counts.reasoning} (included in output)`));
        details.append(row);
      }
      usage.append(details);
    }
    root.append(usage);
  }
  const agents = chat ? state.chats.filter(item => item.parentChatId === chat.id && !item.archived) : [];
  if (agents.length || chat?.parentChatId) {
    const section = el('section', 'activity-section'); section.append(el('h3', '', 'Agents'));
    if (chat?.parentChatId) section.append(button('Back to parent chat', () => selectChat(chat.parentChatId), 'text-button'));
    for (const agent of agents) { const link = button('', () => selectChat(agent.id), 'agent-link'); link.append(el('strong', '', agent.title), el('span', '', statusLabel(latestRun(state, agent.id)?.status))); section.append(link); }
    root.append(section);
  }
  const events = run?.toolEvents || [];
  const tools = el('section', 'activity-section'); tools.append(el('h3', '', 'Tool activity'));
  if (!events.length) tools.append(el('p', 'activity-empty', 'File changes, commands, and other tool calls appear here.'));
  for (const event of events) { const item = el('details', 'activity-item'); item.dataset.eventId = event.id; item.open = expanded.has(event.id); const summary = el('summary'); summary.append(el('strong', '', event.name), el('span', '', statusLabel(event.status))); item.append(summary, el('pre', '', displayText(event.args))); if (event.result !== undefined) appendResult(item, event.result); if (event.error) item.append(el('p', 'error-text', event.error)); tools.append(item); }
  root.append(tools);
  const actions = extensionActions(state.extensions);
  if (actions.length) { const section = el('section', 'activity-section'); section.append(el('h3', '', 'Extensions')); for (const action of actions) section.append(button(action.label, () => showToolForm(action.tool, action), 'nav-button')); root.append(section); }
  const project = currentProject();
  if (project) { const section = el('section', 'activity-section'); section.append(el('h3', '', 'Project folder'), el('p', 'activity-project', project.path), button('Open folder', () => request('app.openPath', { path: project.path }), 'text-button'), button('Rename project', () => showRename('project', project), 'text-button')); root.append(section); }
}
function renderApprovals() {
  const root = $('#approval-list'); root.replaceChildren();
  for (const approval of chatApprovals(state, selectedChatId)) {
    const item = el('section', 'approval'); item.append(el('h3', '', `Allow ${approval.permission} access?`), el('p', '', approval.summary));
    if (approval.chatId !== selectedChatId) item.prepend(button(`Agent: ${state.chats.find(chat => chat.id === approval.chatId)?.title || 'child chat'}`, () => selectChat(approval.chatId), 'text-button'));
    const actions = el('div', 'approval-actions'); const remember = el('input'); remember.type = 'checkbox';
    const label = el('label'); label.append(remember, document.createTextNode(approval.chatId === selectedChatId ? ' Remember for this chat' : ' Remember for this agent chat'));
    for (const [text, allow] of [['Allow for this run', true], ['Deny', false]]) actions.append(button(text, async () => { await request('approval.resolve', { id: approval.id, allow, remember: allow && remember.checked }); await refresh(); }, allow ? 'button primary' : 'button'));
    actions.append(label); item.append(actions); root.append(item);
  }
}
function renderVoice() {
  const current = voice.chatId === selectedChatId && !['off', 'transcript'].includes(voice.status);
  $('#voice-status').hidden = !current;
  $('#voice-status').textContent = voice.error || `${voice.mode === 'assistant' ? 'Voice assistant' : 'Dictation'}: ${statusLabel(voice.status)}`;
  $('#voice-button').setAttribute('aria-pressed', String(current));
}
async function newChat() {
  if (!currentProject()) { showProjectForm(); return; }
  const chat = await request('chat.create', { projectId: currentProject().id }); await refresh(); selectChat(chat.id); return chat;
}
async function sendText(text, withImages = false) {
  const sourceDraftKey = draftKey(); const attachments = withImages ? [...imageDrafts.get(sourceDraftKey)] : [];
  if (attachments.some(item => item.pending)) { notify('Wait for the attachments to finish reading.'); return; }
  if ((!text.trim() && !attachments.length) || sending) return;
  if (!currentProject()) { showProjectForm(); return; }
  if (isActive(latestRun(state, selectedChatId))) throw new Error('Stop the current run before sending another message.');
  sending = true; render();
  drafts.set(sourceDraftKey, $('#prompt').value);
  try {
    const target = currentChat() || await request('chat.create', { projectId: currentProject().id });
    if (!target) return;
    const images = attachments.filter(item => item.image).map(item => item.image);
    await request('chat.send', { chatId: target.id, text: attachmentMessage(text, attachments), ...(images.length ? { images } : {}) });
    if (draftKey() === sourceDraftKey && $('#prompt').value === text) $('#prompt').value = '';
    if (drafts.get(sourceDraftKey) === text) drafts.delete(sourceDraftKey);
    imageDrafts.remove(sourceDraftKey, attachments.map(item => item.id));
    // Leave newer edits and in-flight attachments in their original draft. Navigation
    // during the request never redirects or clears the newly selected chat.
    if (!selectedChatId && draftKey() === sourceDraftKey && !$('#prompt').value && !imageDrafts.get(sourceDraftKey).length) { await refresh(); selectChat(target.id); }
    await refresh(); if (selectedChatId === target.id) $('#transcript').scrollTop = $('#transcript').scrollHeight;
  } finally { sending = false; render(); }
}
function modal(title) { navigationMenu.close(); modalReturnFocus = undefined; $('#modal').classList.remove('delete-modal'); $('#modal-title').textContent = title; const body = $('#modal-body'); body.replaceChildren(); if (!$('#modal').open) $('#modal').showModal(); return body; }
function closeModal() { $('#modal').close(); }
function field(labelText, value = '', type = 'text', hint = '') {
  const wrapper = el('label', 'form-row'); wrapper.append(el('span', '', labelText)); const input = el(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type; input.value = value ?? ''; wrapper.append(input); if (hint) wrapper.append(el('small', '', hint)); return { wrapper, input };
}
function selectField(labelText, options, value) {
  const wrapper = el('label', 'form-row'); wrapper.append(el('span', '', labelText)); const input = el('select');
  for (const option of options) { const item = el('option', '', option.label); item.value = option.value; input.append(item); }
  input.value = value ?? options[0]?.value ?? ''; wrapper.append(input); return { wrapper, input };
}
function checkedRow(label, checked, description) {
  const wrapper = el('label', 'option-row'); const text = el('span', '', label); if (description) text.append(el('small', '', description));
  const input = el('input'); input.type = 'checkbox'; input.checked = checked; wrapper.append(text, input); return { wrapper, input };
}
function actions(...buttons) { const footer = el('div', 'form-actions'); footer.append(...buttons); return footer; }
async function navigationAction(kind, id, action, restoreFocus) {
  const entity = state[kind === 'chat' ? 'chats' : 'projects'].find(item => item.id === id);
  if (!entity) throw new Error('This item is no longer available.');
  if (action === 'delete') { showDelete(kind, entity, restoreFocus); return; }
  if (action === 'move') { showMoveChat(entity, restoreFocus); return; }
  await request(`${kind}.${action}`, { [kind === 'chat' ? 'chatId' : 'projectId']: id }); await refresh(); restoreFocus?.();
}
function showDelete(kind, entity, restoreFocus) {
  const body = modal(`Delete ${kind}`); $('#modal').classList.add('delete-modal'); modalReturnFocus = restoreFocus;
  const warning = el('p', 'delete-warning', deletionWarning(kind)); warning.id = 'delete-warning'; body.append(warning);
  body.append(el('p', 'delete-target', kind === 'chat' ? entity.title : entity.name));
  body.append(el('p', 'hint', kind === 'project' ? 'This removes the project and its chat history from Faber. Files in the project folder remain on disk.' : 'This also removes this chat’s child-agent conversations. Files in the project folder remain on disk.'));
  const cancel = button('Cancel', closeModal); cancel.id = 'cancel-delete';
  const remove = button('Delete', async () => { if (!state[kind === 'chat' ? 'chats' : 'projects'].some(item => item.id === entity.id)) throw new Error('This item is no longer available.'); await request(`${kind}.delete`, { [kind === 'chat' ? 'chatId' : 'projectId']: entity.id }); await refresh(); closeModal(); }, 'button delete-confirm'); remove.id = 'confirm-delete';
  body.append(actions(cancel, remove)); cancel.focus();
}
function showMoveChat(chat, restoreFocus) {
  const targetId = chat.id, body = modal('Move chat to project'); modalReturnFocus = restoreFocus;
  body.append(el('p', 'hint', 'Move this conversation and its child-agent chats together. Stop their active runs first.'));
  const choices = state.projects.filter(project => !project.archived && project.id !== chat.projectId).map(project => ({ value: project.id, label: project.name }));
  choices.push({ value: '__new__', label: 'Create a new project…' });
  const project = selectField('Destination project', choices); project.input.id = 'move-project';
  const details = el('div', 'form-grid'); const name = field('New project name'), path = field('Folder path', '', 'text', 'Leave blank to choose a folder. Existing files will not be moved.'); name.input.id = 'move-project-name'; path.input.id = 'move-project-path'; details.append(name.wrapper, path.wrapper);
  const update = () => { details.hidden = project.input.value !== '__new__'; }; project.input.addEventListener('change', update); update(); body.append(project.wrapper, details);
  const move = button('Move chat', async () => {
    if (!state.chats.some(item => item.id === targetId)) throw new Error('This chat is no longer available.');
    let projectId = project.input.value;
    if (projectId === '__new__') { const created = await request('project.create', { name: name.input.value.trim() || 'Untitled project', ...(path.input.value.trim() ? { path: path.input.value.trim() } : {}) }); if (!created) return; projectId = created.id; }
    await request('chat.move', { chatId: targetId, projectId }); await refresh(); if (selectedChatId === targetId) selectedProjectId = projectId; closeModal(); notify('Chat moved to the selected project.');
  }, 'button primary'); move.id = 'confirm-move-chat'; body.append(actions(button('Cancel', closeModal), move)); project.input.focus();
}
function showProjectForm() {
  const body = modal('Add a project'); body.append(el('p', 'hint', 'Select a folder for this project. Your chat history stays in Faber’s private local data folder.'));
  const name = field('Project name', '', 'text'); const path = field('Folder path', '', 'text', 'Leave blank to choose a folder in the system picker.'); const form = el('div', 'form-grid'); form.append(name.wrapper, path.wrapper); body.append(form);
  body.append(actions(button('Cancel', closeModal), button('Add project', async () => { const project = await request('project.create', { name: name.input.value.trim() || 'Untitled project', ...(path.input.value.trim() ? { path: path.input.value.trim() } : {}) }); if (!project) return; await refresh(); selectChat(null, project.id); closeModal(); await newChat(); }, 'button primary'))); name.input.focus();
}
function showRename(kind, entity) {
  const body = modal(`Rename ${kind}`); const name = field('Name', kind === 'chat' ? entity.title : entity.name); body.append(name.wrapper);
  body.append(actions(button('Cancel', closeModal), button('Save', async () => { const value = name.input.value.trim(); if (!value) throw new Error('Enter a name.'); await request(`${kind}.update`, { id: entity.id, [kind === 'chat' ? 'title' : 'name']: value }); await refresh(); closeModal(); }, 'button primary'))); name.input.focus(); name.input.select();
}
function showSettings() {
  const body = modal('Settings'); const appearance = el('section', 'modal-section'); appearance.append(el('h3', '', 'Appearance'));
  const theme = selectField('Theme', ['system', 'dark', 'light'].map(value => ({ value, label: statusLabel(value) })), state.settings?.theme || 'system');
  theme.input.id = 'settings-theme';
  theme.input.addEventListener('change', () => act(async () => { await request('settings.update', { theme: theme.input.value }); await refresh(); })); appearance.append(theme.wrapper); body.append(appearance);
  const models = el('section', 'modal-section'); models.append(el('h3', '', 'Model connections'), el('p', 'hint', 'Connect OpenAI Responses, another compatible API, or a local Ollama server. Listing models sends no inference request. Save a connection, then explicitly choose it for a chat.'));
  for (const provider of state.providers) { const row = button('', () => showProviderForm(provider), 'provider-row'); const text = el('span'); text.append(el('strong', '', provider.name), el('small', '', `${providerKindLabel(provider.kind)} · ${provider.baseUrl}`)); row.append(text, el('span', '', 'Edit')); models.append(row); }
  models.append(actions(button('Add local connection', () => connections.showForm(undefined, 'ollama')), button('Add cloud/API connection', () => showProviderForm()))); body.append(models);
  modelsBrowser.mountSettings(body);
  const addons = el('section', 'modal-section'); addons.append(el('h3', '', 'Local addons'), el('p', 'hint', 'Manage addons installed from this computer. No account or online catalog is required.'), button('Manage addons', () => addonManager.show())); body.append(addons);
  const about = el('section', 'modal-section'); about.append(wordmark('about-wordmark'), el('h3', '', 'Faber b1.1'), el('p', 'hint', 'A separate workspace for local and connected models. Tools and extensions run on this computer with the permissions you grant.'));
  const reload = button('Refresh interface', () => refreshInterface(true)); reload.id = 'reload-ui';
  about.append(el('p', 'hint', 'Refresh interface keeps chats, downloads, loaded models, and composer drafts running. Backend changes still need Restart app.'), actions(button('Tools & extensions', () => showTools('extensions')), reload, button('Restart app', () => request('app.restart')))); body.append(about);
}
function showProviderForm(provider) { connections.showForm(provider); }
function showModelPicker() { connections.showPicker(); }
const permissionDescriptions = {
  files: 'Write files and authorize access to other project folders.', shell: 'Run commands with your Windows user permissions.', computer: 'Take screenshots, control this computer, and use microphone or speech tools.', network: 'Make requests to external services.', upgrade: 'Stage or activate changes to Faber and its extensions.',
};
function showChatSettings() {
  const chat = currentChat(); if (!chat) return;
  const body = modal('Chat settings');
  const title = field('Chat title', chat.title); body.append(title.wrapper);
  const permissions = el('section', 'modal-section'); permissions.append(el('h3', '', 'Permissions'), el('p', 'hint', 'Read tools can inspect this workspace. Other actions ask each run unless you grant access here. Grants are real host authority, not an operating-system sandbox.'));
  const checks = PERMISSIONS.map(permission => { const check = checkedRow(statusLabel(permission), chat.grants.includes(permission), permissionDescriptions[permission]); check.wrapper.classList.add('permission-row'); permissions.append(check.wrapper); return { permission, ...check }; }); body.append(permissions);
  const speech = el('section', 'modal-section'); speech.append(el('h3', '', 'Voice'));
  const phrase = field('Activation phrase', chat.voice?.phrase || 'Hey Faber', 'text', 'Used only while the voice assistant is listening for this chat.');
  const enabled = checkedRow('Enable activation for this chat', Boolean(chat.voice?.enabled), 'This phrase can select this chat while assistant mode is running.');
  const speak = checkedRow('Read replies aloud', chat.voice?.speakReplies !== false); speech.append(phrase.wrapper, enabled.wrapper, speak.wrapper); body.append(speech);
  body.append(actions(button('Archive chat', async () => { await request('chat.archive', { chatId: chat.id }); await refresh(); closeModal(); }), button('Delete chat', () => showDelete('chat', chat), 'button danger'), button('Save changes', async () => {
    if (!title.input.value.trim() || !phrase.input.value.trim()) throw new Error('Enter a chat title and activation phrase.');
    await request('chat.update', { id: chat.id, title: title.input.value.trim(), grants: checks.filter(item => item.input.checked).map(item => item.permission), voice: { ...chat.voice, enabled: enabled.input.checked, phrase: phrase.input.value.trim(), speakReplies: speak.input.checked } }); await refresh(); closeModal();
  }, 'button primary')));
}
function showVoice() {
  const body = modal('Voice'); const chat = currentChat();
  body.append(el('p', 'hint', 'Dictation adds speech to your draft. Assistant mode listens for this chat’s activation phrase, then sends your request. Windows microphone and speech support must be available.'));
  if (!chat) { body.append(button('Create a chat', async () => { await newChat(); if (currentChat()) showVoice(); }, 'button primary')); return; }
  const phrase = field('Activation phrase', chat.voice?.phrase || 'Hey Faber'); const speak = checkedRow('Read replies aloud', chat.voice?.speakReplies !== false); body.append(phrase.wrapper, speak.wrapper);
  const status = el('p', 'hint', voice.chatId === chat.id ? `Current state: ${statusLabel(voice.status)}` : 'Microphone is off for this chat.'); body.append(status);
  const start = async mode => { if (!phrase.input.value.trim()) throw new Error('Enter an activation phrase.'); await request('chat.update', { id: chat.id, voice: { ...chat.voice, enabled: true, phrase: phrase.input.value.trim(), speakReplies: speak.input.checked } }); await request('voice.start', { chatId: chat.id, mode }); closeModal(); await refresh(); };
  body.append(actions(button('Stop voice', async () => { await request('voice.stop', { chatId: chat.id }); closeModal(); }), button('Dictate', () => start('dictation')), button('Start assistant', () => start('assistant'), 'button primary')));
}
function showTools(tab = 'tools') {
  const body = modal('Tools & extensions'); const tabs = el('div', 'tab-row'); tabs.append(button('Tools', () => showTools('tools'), tab === 'tools' ? 'selected' : ''), button('Extensions', () => showTools('extensions'), tab === 'extensions' ? 'selected' : '')); body.append(tabs);
  if (tab === 'tools') {
    body.append(el('p', 'hint', 'Run a registered tool in the current chat. The same permissions and approvals apply when Faber uses it.'));
    const search = el('input', 'search-input tool-search'); search.placeholder = 'Find a tool…'; search.setAttribute('aria-label', 'Find a tool'); body.append(search); const list = el('div'); body.append(list);
    const update = () => { list.replaceChildren(); const tools = state.tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(search.value.toLowerCase()));
      if (!tools.length) list.append(el('p', 'hint', 'No matching tools are registered.'));
      for (const tool of tools) { const row = button('', () => showToolForm(tool.name), 'tool-row'); const text = el('span'); text.append(el('strong', '', tool.name), el('small', '', tool.description)); row.append(text, el('span', '', tool.permission || 'read')); list.append(row); }
    }; search.addEventListener('input', update); update();
  } else {
    body.append(el('p', 'hint', 'Extensions add tools and actions to this interface. They run trusted local code with your user permissions. Reload after installing an approved extension.'));
    for (const extension of state.extensions) {
      const section = el('section', 'modal-section'); section.append(el('h3', '', `${extension.name || extension.id} ${extension.version || ''}`), el('p', 'hint', extension.description || ''));
      const row = el('div', 'extension-actions'); for (const action of extensionActions([extension])) row.append(button(action.label, () => showToolForm(action.tool, action))); section.append(row); body.append(section);
    }
    if (!state.extensions.length) body.append(el('p', 'hint', 'No extensions are loaded. Use an extension installation tool to add one.'));
    const related = state.tools.filter(tool => /extension|upgrade|rollback/.test(tool.name));
    for (const tool of related) body.append(button(tool.name, () => showToolForm(tool.name), 'nav-button'));
    body.append(actions(button('Reload extensions', async () => { const result = await request('extensions.reload'); await refresh(); showTools('extensions'); notify(result?.errors?.length ? `Reload completed with errors: ${displayText(result.errors)}` : 'Extension registry reloaded.', Boolean(result?.errors?.length)); })));
  }
}
function showToolForm(name, action) {
  const tool = state.tools.find(item => item.name === name); if (!tool) throw new Error(`The tool ${name} is not currently registered. Reload extensions and try again.`);
  const body = modal(action?.label || name); body.append(el('p', 'hint', tool.description || ''), el('p', 'hint', `Permission: ${tool.permission || 'read'}. This runs in ${currentChat()?.title || 'a new chat'}.`));
  const schema = tool.parameters || { type: 'object', properties: {} }; const form = el('div', 'form-grid'); const inputs = [];
  const fields = action?.fields || Object.entries(schema.properties || {}).map(([key, value]) => ({ name: key, label: key, ...value, required: schema.required?.includes(key) }));
  for (const spec of fields) {
    let item;
    if (spec.type === 'boolean') item = checkedRow(spec.label || spec.name, spec.default === true, spec.description);
    else if (spec.enum) item = selectField(spec.label || spec.name, spec.enum.map(value => ({ value: String(value), label: String(value) })), spec.default);
    else item = field(`${spec.label || spec.name}${spec.required ? ' *' : ''}`, spec.default === undefined ? '' : typeof spec.default === 'object' ? JSON.stringify(spec.default, null, 2) : spec.default, ['object', 'array'].includes(spec.type) || /script|content|patch|command|source|text/.test(spec.name) ? 'textarea' : spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text', spec.description || '');
    if (spec.required) item.input.required = true; if (spec.type === 'integer') item.input.step = '1';
    form.append(item.wrapper); inputs.push({ spec, ...item });
  }
  body.append(form);
  const advanced = el('details', 'tool-message'); advanced.append(el('summary', '', 'Use JSON arguments instead'));
  const raw = field('Arguments JSON', '{}', 'textarea', 'When expanded, this replaces the fields above.'); advanced.append(raw.wrapper); body.append(advanced);
  const result = el('div', 'inline-result'); result.hidden = true; body.append(result);
  const run = button('Run tool', async () => {
    const args = advanced.open ? parseArguments(raw.input.value) : {};
    if (!advanced.open) for (const { spec, input } of inputs) {
      if (!input.checkValidity()) { input.reportValidity(); return; }
      if (spec.type === 'boolean') args[spec.name] = input.checked;
      else if (input.value !== '') {
        args[spec.name] = ['object', 'array'].includes(spec.type) ? JSON.parse(input.value) : ['number', 'integer'].includes(spec.type) ? Number(input.value) : input.value;
      }
    }
    const target = currentChat() || await newChat(); if (!target) return;
    run.disabled = true; result.hidden = false; result.textContent = 'Running. If approval is required, review it in the conversation.';
    // Keep approval controls reachable while a manual tool request awaits a decision.
    closeModal();
    try {
      const output = await request('tool.run', { chatId: target.id, name, args }); await refresh();
      const done = modal(`${action?.label || name} result`); appendResult(done, output); done.append(actions(button('Done', closeModal, 'button primary')));
    } finally { run.disabled = false; }
  }, 'button primary');
  body.append(actions(button('Back to tools', showTools), run));
}

function cleanSettings() {
  if ($('#modal-title').textContent !== 'Settings') return false;
  const inputs = [...$('#modal-body').querySelectorAll('input,textarea,select')];
  if (inputs.some(input => !['settings-theme', 'model-download-directory', 'model-hf-token'].includes(input.id))) return false;
  return $('#settings-theme')?.value === (state.settings?.theme || 'system') && !$('#model-hf-token')?.value && typeof downloadDirectory === 'string' && $('#model-download-directory')?.value === downloadDirectory;
}
function refreshReason(manual) {
  if (navigationMenu.isOpen()) return 'Close the chat or project menu before refreshing.';
  if (composing) return 'Finish composing text before refreshing.';
  return refreshBlocker({ sending, pendingReads: imageDrafts.hasPending(), pendingPicker, pendingRequests, modalOpen: $('#modal').open, cleanSettings: cleanSettings(), modelsOpen: document.body.classList.contains('models-open'), voiceActive: !['off', 'error', 'transcript'].includes(voice.status), manual });
}
function freezeInterface(frozen) { uiHandoff = frozen; document.body.inert = frozen; document.documentElement.dataset.uiRefreshing = String(frozen); }
function scheduleUIRefresh() {
  if (!pendingUpdateId || bootstrapping || uiHandoff || retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = undefined; if (pendingUpdateId && !bootstrapping && !uiHandoff) act(() => refreshInterface(false)); }, 150);
}
async function refreshInterface(manual = false) {
  if (bootstrapping || uiHandoff) return;
  const blocked = refreshReason(manual);
  if (blocked) { notify(`${manual ? '' : 'UI update ready. '}${blocked}${manual ? '' : ' Refresh interface is available in Settings.'}`); return; }
  // Freeze synchronously before copying: no keystroke, paste, chooser, or remove
  // action can enter between this snapshot and the host's reload transaction.
  const promptFocused = document.activeElement === $('#prompt');
  freezeInterface(true);
  try {
    drafts.set(draftKey(), $('#prompt').value);
    const snapshot = composeUISnapshot({ selectedChatId, selectedProjectId, drafts, attachments: imageDrafts.snapshot(), view: {
      sidebarHidden: document.body.classList.contains('sidebar-hidden'), sidebarOpen: document.body.classList.contains('sidebar-open'),
      activityHidden: $('#activity-rail').hidden, activityOpen: document.body.classList.contains('activity-open'),
      transcriptScroll: $('#transcript').scrollTop, activityScroll: $('#activity-rail').scrollTop, projectScroll: $('#project-list').scrollTop,
      promptSelectionStart: $('#prompt').selectionStart, promptSelectionEnd: $('#prompt').selectionEnd, promptFocused,
    } });
    notify('Refreshing interface. Your composer drafts are being kept in memory.');
    const result = await request('app.reloadUI', { state: snapshot });
    if (!uiHandoff) return;
    acceptedReloadId = result.id; pendingUpdateId = undefined;
  } catch (error) {
    freezeInterface(false); flushHandoffVoice(); notify(`Interface was not refreshed: ${interfaceError(error)}`, true);
  }
}
function flushHandoffVoice() { for (const event of handoffVoiceEvents.splice(0)) handleBridgeEvent(event); }
async function initializeInterface() {
  freezeInterface(true); document.documentElement.dataset.uiReady = 'false';
  let saved;
  try {
    const envelope = await request('app.uiState');
    saved = envelope ? { id: envelope.id, state: validateUISnapshot(envelope.state) } : null;
    if (saved) {
      selectedChatId = saved.state.selectedChatId; selectedProjectId = saved.state.selectedProjectId; initialState = false;
      drafts.clear(); for (const draft of saved.state.drafts) drafts.set(draft.key, draft.text);
      imageDrafts.restore(saved.state.drafts.map(({ key, attachments }) => ({ key, attachments })));
    }
    acceptState(await request('state.get'));
    $('#prompt').value = drafts.get(draftKey()) || '';
    bootstrapping = false;
    for (const event of startupEvents.splice(0)) handleBridgeEvent(event);
    render();
    if (saved) {
      const view = saved.state.view;
      for (const [flag, value] of [['sidebar-hidden', view.sidebarHidden], ['sidebar-open', view.sidebarOpen], ['activity-open', view.activityOpen]]) document.body.classList.toggle(flag, value);
      $('#activity-rail').hidden = view.activityHidden; $('#toggle-activity').setAttribute('aria-expanded', String(!view.activityHidden));
      $('#prompt').style.height = 'auto'; $('#prompt').style.height = `${Math.min(180, $('#prompt').scrollHeight)}px`;
      await new Promise(resolve => requestAnimationFrame(resolve));
      $('#transcript').scrollTop = view.transcriptScroll; $('#activity-rail').scrollTop = view.activityScroll; $('#project-list').scrollTop = view.projectScroll;
      $('#prompt').setSelectionRange(view.promptSelectionStart, view.promptSelectionEnd);
      await request('app.uiStateAck', { id: saved.id });
      freezeInterface(false); if (view.promptFocused) $('#prompt').focus({ preventScroll: true });
      notify('Interface refreshed. Your composer drafts are restored.');
    } else freezeInterface(false);
    flushHandoffVoice(); document.documentElement.dataset.uiReady = 'true'; scheduleUIRefresh();
  } catch (error) {
    bootstrapping = false; freezeInterface(false); document.documentElement.dataset.uiReady = 'error';
    notify(`Interface recovery could not finish: ${interfaceError(error)}. Any pending recovery snapshot remains in host memory.`, true);
  }
}

const navigationMenu = createNavigationMenu({ el, getState: () => state, onAction: (...args) => act(() => navigationAction(...args)) });
const runActivity = createRunActivity({ el, button, appendResult, selectChat, resolveApproval: async (id, allow) => { await request('approval.resolve', { id, allow }); await refresh(); } });
const chatControls = createChatControls({ request, refresh, getChat: currentChat, getDraft: () => $('#prompt').value, modal, closeModal, el, button, field, actions, icon, notify });
$('#composer-bottom').prepend(chatControls.root);
const modelsBrowser = createModelsBrowser({ request, subscribe: bridge?.subscribe, el, button, field, actions, notify, showSettings });
const connections = createConnections({ request, refresh, getState: () => state, getChat: currentChat, newChat, modal, closeModal, el, button, field, selectField, checkedRow, actions, showSettings });
const addonManager = createAddonManager({ request, subscribe: bridge?.subscribe, modal, el, button, actions, notify });
$('#open-addons').addEventListener('click', () => act(() => addonManager.show()));
$('#open-models').addEventListener('click', () => act(() => modelsBrowser.open()));
$('#new-chat').addEventListener('click', () => act(newChat));
$('#add-project').addEventListener('click', showProjectForm);
$('#open-settings').addEventListener('click', showSettings);
$('#open-tools').addEventListener('click', () => showTools());
$('#composer-tools').addEventListener('click', () => showTools());
let pickerDraftKey;
$('#file-picker').accept = FILE_ACCEPT;
$('#attach-files').addEventListener('click', () => { pickerDraftKey = draftKey(); pendingPicker = true; $('#file-picker').click(); });
$('#file-picker').addEventListener('cancel', () => { pendingPicker = false; pickerDraftKey = undefined; scheduleUIRefresh(); });
$('#file-picker').addEventListener('change', event => {
  pendingPicker = false;
  const files = [...event.target.files]; const key = pickerDraftKey ?? draftKey(); event.target.value = '';
  pickerDraftKey = undefined;
  act(async () => { await imageDrafts.add(key, files); if (files.length && draftKey() !== key) notify('Files attached to the original chat draft.'); });
});
$('#model-picker').addEventListener('click', showModelPicker);
$('#chat-options').addEventListener('click', showChatSettings);
$('#chat-title').addEventListener('click', () => { if (currentChat()) showRename('chat', currentChat()); });
$('#voice-button').addEventListener('click', showVoice);
$('#close-modal').addEventListener('click', closeModal);
$('#modal').addEventListener('close', () => { modalReturnFocus?.(); modalReturnFocus = undefined; scheduleUIRefresh(); });
new MutationObserver(scheduleUIRefresh).observe(document.body, { attributes: true, attributeFilter: ['class'] });
for (const name of ['click', 'keydown', 'beforeinput', 'input', 'paste', 'change', 'drop']) document.addEventListener(name, event => { if (uiHandoff) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
$('#prompt').addEventListener('compositionstart', () => { composing = true; });
$('#prompt').addEventListener('compositionend', () => { composing = false; scheduleUIRefresh(); });
$('#dismiss-notice').addEventListener('click', () => { $('#notice').hidden = true; });
$('#composer').addEventListener('submit', event => { event.preventDefault(); act(() => sendText($('#prompt').value, true)); });
$('#prompt').addEventListener('input', () => { drafts.set(draftKey(), $('#prompt').value); updateSendButton(); chatControls.render(); $('#prompt').style.height = 'auto'; $('#prompt').style.height = `${Math.min(180, $('#prompt').scrollHeight)}px`; });
$('#prompt').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  // Mixed text/image clipboard payloads retain the browser's normal text paste.
  if (!event.clipboardData.getData('text/plain')) event.preventDefault();
  const key = draftKey(); act(async () => { await imageDrafts.add(key, files); if (draftKey() !== key) notify('Images attached to the original chat draft.'); });
});
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); act(() => sendText($('#prompt').value, true)); } });
$('#stop-run').addEventListener('click', () => act(async () => { await request('chat.stop', { chatId: selectedChatId }); await refresh(); }));
$('#collapse-sidebar').addEventListener('click', () => { document.body.classList.add('sidebar-hidden'); document.body.classList.remove('sidebar-open'); });
$('#show-sidebar').addEventListener('click', () => { document.body.classList.remove('sidebar-hidden'); document.body.classList.add('sidebar-open'); });
function toggleActivity(force) { const rail = $('#activity-rail'); const open = force ?? (matchMedia('(max-width: 1000px)').matches ? !document.body.classList.contains('activity-open') : rail.hidden); rail.hidden = !open; document.body.classList.toggle('activity-open', open); $('#toggle-activity').setAttribute('aria-expanded', String(open)); }
$('#toggle-activity').addEventListener('click', () => toggleActivity()); $('#close-activity').addEventListener('click', () => toggleActivity(false));
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !$('#modal').open) { event.preventDefault(); act(newChat); } if (event.key === 'Escape') document.body.classList.remove('sidebar-open', 'activity-open'); });
function handleBridgeEvent(event) {
    if (event.type === 'localModels') { chatControls.invalidate(); renderComposerControls(); }
    if (event.type === 'models') downloadDirectory = event.state.downloadDirectory;
    if (event.type === 'voice' && uiHandoff) { handoffVoiceEvents.push(event); return; }
    if (event.type === 'state') acceptState(event.state);
    else if (event.type === 'delta') {
      if (Number.isSafeInteger(event.streamSequence)) { streamVersion = mergeRuntimeStreams(streams, event, streamVersion); if (event.chatId === selectedChatId) { renderStream(); renderComposerControls(); } return; }
      let stream = streams.get(event.runId);
      if (!stream) { const chat = state.chats.find(item => item.id === event.chatId); stream = { text: '', lastAssistantId: chat?.messages.filter(item => item.role === 'assistant').at(-1)?.id }; streams.set(event.runId, stream); }
      stream.text += event.text; if (event.metrics) stream.metrics = event.metrics; if (event.chatId === selectedChatId) { renderStream(); renderComposerControls(); }
    } else if (event.type === 'approval') act(refresh);
    else if (event.type === 'voice') {
      if (event.status !== 'transcript') voice = event;
      if (event.status === 'transcript' && event.mode === 'dictation' && event.final && event.text) {
        if (event.chatId === selectedChatId) { $('#prompt').value = `${$('#prompt').value}${$('#prompt').value ? ' ' : ''}${event.text}`; $('#prompt').dispatchEvent(new Event('input')); }
        else { const draft = drafts.get(event.chatId) || ''; drafts.set(event.chatId, `${draft}${draft ? ' ' : ''}${event.text}`); notify('Dictation added to its chat draft.'); }
      }
      if (event.error) notify(event.error, true); renderVoice(); scheduleUIRefresh();
    } else if (event.type === 'uiUpdate') { pendingUpdateId = event.id; scheduleUIRefresh();
    } else if (event.type === 'uiReloadFailed') {
      if (!acceptedReloadId || acceptedReloadId === event.id) { freezeInterface(false); acceptedReloadId = undefined; flushHandoffVoice(); notify(`Interface refresh failed: ${interfaceError(event.error)}. Your drafts are still here.`, true); act(() => request('app.uiStateAck', { id: event.id })); }
    } else if (event.type === 'error') notify(event.error?.message || event.error || event.message || 'An operation failed.', true);
}
if (bridge) {
  bridge.subscribe(event => { if (bootstrapping) startupEvents.push(event); else handleBridgeEvent(event); });
  initializeInterface();
} else { bootstrapping = false; render(); notify('Open Faber with its desktop launcher to connect this interface to the runtime.', true); }
