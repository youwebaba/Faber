import { PERMISSIONS, isActive, latestRun, safeImage, displayText, parseArguments, statusLabel, extensionActions, streamText, reconcileStreams, sameMessage, chatApprovals } from './ui-helpers.mjs';
import { createModelsBrowser } from './models.mjs';
import { createBrowserPanel } from './browser.mjs';
import { createConnections } from './connections.mjs';
import { createRemoteConnections } from './remote-connections.mjs';
import { createAddonManager } from './addons.mjs';
import { callUsage } from './chat-media.mjs';
import { createAttachmentDrafts, attachmentMessage, FILE_ACCEPT } from './file-attachments.mjs';
import { composeUISnapshot, validateUISnapshot, refreshBlocker, mergeRuntimeStreams, interfaceError } from './ui-refresh.mjs';
import { createNavigationMenu, deletionWarning, orderedChatFamilies } from './chat-navigation.mjs';
import { createChatControls } from './chat-controls.mjs';
import { createRunActivity, modelProgress } from './run-activity.mjs';
import { transcriptTimeline, reconcileTranscript, preserveTranscriptViewport } from './transcript-timeline.mjs';
import { modelDisplayName } from './model-names.mjs';
import { createPreferences } from './preferences.mjs';
import { createChatGPTControls } from './chatgpt.mjs';
import { renderRichContent, renderOutputImages } from './rich-content.mjs';
import { createContentMenu, createMediaOutputs, resultMedia } from './content-media.mjs';
import { createWorkspaceControls, pendingUserMessages, hasUnsentDrafts, projectApprovalTitle } from './workspace-controls.mjs';
import { releaseLabel } from './release.mjs';
import { correctionLabel, correctionRequest } from './prompt-progress.mjs';

const $ = selector => document.querySelector(selector);
document.title = `Faber ${releaseLabel}`;
$('.build-label').textContent = releaseLabel;
const bridge = window.faber;
let state = { projects: [], chats: [], runs: [], providers: [], tools: [], extensions: [], approvals: [], settings: {} };
let selectedChatId = readLocal('faber.chat');
let selectedProjectId = readLocal('faber.project'), navigationVersion = 0;
let voice = { status: 'off' };
let sending = false;
let initialState = true;
let bootstrapping = true, uiHandoff = false, pendingRequests = 0, pendingPicker = false, composing = false, pendingUpdateId, acceptedReloadId, retryTimer, streamVersion = -1, stateVersion = -1;
let downloadDirectory;
let modelLabels = [], modelLabelRequest = 0;
const startupEvents = [], handoffVoiceEvents = [];
const streams = new Map();
const drafts = new Map();
const pendingCorrections = new Map();
const imageDrafts = createAttachmentDrafts({ onChange: key => { if (key === draftKey()) renderImageDrafts(); scheduleUIRefresh(); } });
let imageDraftRenderKey;
const messageNodes = new Map();
const streamNodes = new Map();
const outputImageNodes = new Map(), recentErrors = [];
const contentMenu = createContentMenu({ request, onError: error => notify(error.message || String(error), true), onNotice: notify, onOpen: () => navigationMenu.close() });
const mediaOutputs = createMediaOutputs({ request, contentMenu });
function bindContent(node, context) { if (document.body.classList.contains('remote-open')) return; mediaOutputs.track(context); contentMenu.bind(node, context); }
let transcriptChatId;
let modalReturnFocus;
const icons = {
  panel: ['M8 3v18', 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z'],
  compose: ['m14 4 6 6', 'm5 13 10-10 6 6-10 10-7 1Z', 'M3 6v15h15'],
  tools: ['m14 6 4-3 3 3-3 4', 'M14 6a6 6 0 0 0-7 7l-4 4a2.8 2.8 0 0 0 4 4l4-4a6 6 0 0 0 7-7'],
  models: ['m12 3 9 5-9 5-9-5Z', 'm3 12 9 5 9-5', 'm3 16 9 5 9-5'],
  addons: ['M4 4h6v5a2 2 0 1 0 4 0V4h6v6h-5a2 2 0 1 0 0 4h5v6h-6v-5a2 2 0 1 0-4 0v5H4v-6h5a2 2 0 1 0 0-4H4Z'],
  connections: ['M3 4h12v10H3Z', 'M7 14v3m-3 0h6', 'M17 10h4v11h-7v-4'],
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
function updateSendButton() { const images = imageDrafts.get(draftKey()); $('#steer-message').disabled = $('#send-message').disabled = sending || images.some(item => item.pending) || (!$('#prompt').value.trim() && !images.length); }
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
function rememberError(message) { recentErrors.push(String(message).slice(0, 24000)); if (recentErrors.length > 20) recentErrors.shift(); }
function notify(message, error = false) { if (error) rememberError(message); $('#notice-text').textContent = message; $('#notice').classList.toggle('error', error); $('#notice').hidden = false; $('#report-notice').hidden = !error; $('#live-status').textContent = message; }
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
  const providersChanged = JSON.stringify(state.providers) !== JSON.stringify(next.providers);
  const removed = [...state.chats.filter(chat => !next.chats.some(item => item.id === chat.id)).map(chat => chat.id), ...state.projects.filter(project => !next.projects.some(item => item.id === project.id)).map(project => `new:${project.id}`)];
  for (const key of removed) { drafts.delete(key); pendingCorrections.delete(key); imageDrafts.remove(key, imageDrafts.get(key).map(item => item.id)); }
  state = next;
  if (providersChanged) { modelLabels = []; ++modelLabelRequest; if (!bootstrapping) void refreshModelLabels(); }
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
  navigationVersion++;
  remoteConnections.workspace.close();
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
  browserPanel.setContext();
  renderModelLabel();
  $('#stop-run').hidden = !isActive(run);
  $('#steer-message').hidden = !isActive(run);
  $('#send-message').hidden = false; $('#send-message').title = isActive(run) ? 'Queue follow-up at the next safe point (Enter)' : 'Send message';
  $('#send-message').setAttribute('aria-label', isActive(run) ? 'Queue follow-up' : 'Send message');
  $('#send-message span').hidden = !isActive(run);
  renderImageDrafts();
  $('#permission-caption').textContent = chat?.grants?.length ? `${chat.grants.length} chat permission${chat.grants.length === 1 ? '' : 's'} enabled` : 'Actions ask for approval';
  renderNavigation(); renderTranscript(); renderActivity(); renderApprovals(); renderVoice(); renderComposerControls();
}
function renderModelLabel() {
  const provider = currentProvider(), model = currentChat()?.model || provider?.model;
  const name = modelDisplayName(provider?.id, model, modelLabels);
  $('#provider-label').textContent = provider?.name || 'No connection'; $('#model-label').textContent = name;
  $('#model-picker').title = `${provider?.name || 'Add a connection'} / ${name}`;
  chatgptControls.renderPlan();
}
async function refreshModelLabels() {
  const sequence = ++modelLabelRequest;
  try { const result = await request('localModels.list'); if (sequence === modelLabelRequest) { modelLabels = result.modelLabels || []; renderModelLabel(); } }
  catch { /* A friendly name is optional; keep the exact selected API identity. */ }
}
function renderComposerControls() {
  const run = latestRun(state, currentChat()?.id), metrics = streams.get(run?.id)?.metrics || run?.modelCalls?.at(-1)?.metrics;
  chatControls.setContext(state, metrics, isActive(run));
}
function renderNavigation() {
  const nav = $('#local-projects'), remoteOpen = remoteConnections.workspace.isOpen();
  const focused = nav.contains(document.activeElement) ? { chat: document.activeElement.dataset.chatId, project: document.activeElement.dataset.projectId } : null;
  nav.replaceChildren();
  if (!state.projects.some(project => !project.archived)) nav.append(el('p', 'subtle-empty', 'Add a folder to start your first project.'));
  for (const project of state.projects.filter(project => !project.archived)) {
    const group = el('div', 'project-group');
    const heading = button('', () => selectChat(null, project.id), 'project-button');
    heading.append(icon('folder'), el('span', '', project.name)); heading.title = project.path; group.append(heading);
    navigationMenu.bind(heading, 'project', project.id);
    const chats = orderedChatFamilies(state, project.id);
    for (const { chat, depth } of chats) {
      const link = button('', () => selectChat(chat.id), `chat-nav${!remoteOpen && chat.id === selectedChatId ? ' selected' : ''}${depth ? ' child' : ''}`);
      link.style.paddingLeft = `${48 + Math.min(depth, 8) * 15}px`;
      link.append(el('span', 'chat-name', `${depth ? '↳ ' : ''}${chat.title}`)); link.title = chat.title;
      navigationMenu.bind(link, 'chat', chat.id);
      if (!remoteOpen && chat.id === selectedChatId) link.setAttribute('aria-current', 'page');
      if (isActive(latestRun(state, chat.id))) { const dot = el('span', 'status-dot'); dot.setAttribute('aria-label', 'Running'); link.append(dot); }
      group.append(link);
    }
    if (!chats.length) group.append(button('Start a chat', async () => { selectChat(null, project.id); await newChat(); }, 'chat-nav'));
    nav.append(group);
  }
  if (focused) [...nav.querySelectorAll('button')].find(node => focused.chat ? node.dataset.chatId === focused.chat : node.dataset.projectId === focused.project)?.focus({ preventScroll: true });
}
function renderTranscript() {
  const transcript = $('#transcript');
  if (remoteConnections.workspace.isOpen()) { mediaOutputs.clear(); transcriptChatId = undefined; return; }
  preserveTranscriptViewport(transcript, () => {
  const chat = currentChat(), pending = pendingUserMessages(chat); const messages = [...(chat?.messages || []).filter(message => message.role !== 'system'), ...pending];
  const identity = chat?.id || `new:${currentProject()?.id || ''}`;
  if (identity !== transcriptChatId) { mediaOutputs.clear(); transcript.replaceChildren(); messageNodes.clear(); streamNodes.clear(); outputImageNodes.clear(); runActivity.reset(); transcriptChatId = identity; }
  const rows = [...transcriptTimeline(state, chat?.id, streams), ...pending.map(message => ({ kind: 'message', key: message.id, message }))], nodes = [];
  const corrections = new Map(state.runs.filter(run => run.chatId === chat?.id).flatMap(run => (run.steering || []).map(item => [item.messageId, item])));
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
  if (!rows.length && transcript.querySelector('.welcome')) nodes.push(transcript.querySelector('.welcome'));
  const ids = new Set(messages.map(message => message.id));
  for (const [id, entry] of messageNodes) if (!ids.has(id)) { entry.node.remove(); messageNodes.delete(id); }
  for (const row of rows) {
    if (row.kind === 'usage') { nodes.push(runActivity.promptUsage(row.key, row.usage)); continue; }
    if (row.kind === 'activity') {
      nodes.push(runActivity.get(state, row.activity, streams));
      for (const branch of [{ run: row.activity.run, events: row.activity.events }, ...row.activity.childRuns.map(run => ({ run, events: run.toolEvents || [] }))]) {
        const context = { chatId: branch.run.chatId }, images = branch.events.map(event => event.image || resultImage(event.result)).filter(Boolean), key = `${row.activity.id}:${branch.run.id}`, signature = JSON.stringify(images);
        if (images.length) { let cached = outputImageNodes.get(key); if (cached?.signature !== signature) { cached = { signature, node: renderOutputImages(images) }; cached.node.dataset.activityImages = key; bindContent(cached.node, context); outputImageNodes.set(key, cached); } if (cached.node.childNodes.length) nodes.push(cached.node); }
        for (const event of branch.events) nodes.push(...mediaOutputs.get(event.mediaRefs?.length ? event.mediaRefs : resultMedia(event.result), context));
      }
      continue;
    }
    if (row.kind === 'stream') {
      let article = streamNodes.get(row.key);
      if (!article) { article = el('article', 'message assistant streaming'); article.dataset.runId = row.run.id; article.append(el('div', 'message-heading', 'Faber'), el('div', 'message-content')); streamNodes.set(row.key, article); }
      if (article.streamText !== row.text) { article.streamText = row.text; article.lastChild.replaceChildren(richContent(row.text), el('span', 'stream-cursor')); bindContent(article, { chatId: chat.id, text: row.text }); } nodes.push(article); continue;
    }
    const message = row.message;
    let entry = messageNodes.get(message.id);
    const correction = correctionLabel(corrections.get(message.id));
    if (!sameMessage(entry?.message, message) || entry.correction !== correction) {
      const node = createMessageNode(message, correction);
      if (entry?.node.open) node.open = true;
      if (entry?.node.querySelector('details')?.open && node.querySelector('details')) node.querySelector('details').open = true;
      entry = { node, message, correction }; messageNodes.set(message.id, entry);
    }
    nodes.push(entry.node);
  }
  const run = latestRun(state, chat?.id);
  if (run) {
    const note = el('div', 'run-note');
    if (['canceled', 'interrupted', 'failed'].includes(run.status)) {
      note.append(el('span', '', run.error || (run.status === 'interrupted' ? 'This run was interrupted. Review the history before continuing.' : `Run ${run.status}.`)));
      if (run.contextOverflow) { const targetId = chat.id; note.append(button('Compact & continue', async () => { await request('chat.compact', { chatId: targetId }); await refresh(); })); }
      else note.append(button('Continue', () => sendText('Continue from where you stopped. Check the current state before repeating any actions.')));
    }
    if (note.childNodes.length) nodes.push(note);
  }
  reconcileTranscript(transcript, nodes);
  mediaOutputs.prune();
  });
}
function createMessageNode(message, correction = '') {
  if (message.role === 'tool') {
    const article = el('article', 'tool-output'); article.dataset.messageId = message.id;
    const details = el('details', 'tool-message'); details.append(el('summary', '', message.toolName || 'Tool result')); appendResult(details, message.content, message.image, false); article.append(details);
    const images = renderOutputImages(message.image || resultImage(message.content)); if (images.childNodes.length) article.append(images); article.append(...mediaOutputs.get(message.mediaRefs?.length ? message.mediaRefs : resultMedia(message.content), { chatId: currentChat().id })); bindContent(article, { chatId: currentChat().id, text: displayText(message.content) }); return article;
  }
  const article = el('article', `message ${message.fromChatId ? 'agent-message' : message.role}`); article.dataset.messageId = message.id;
  const author = message.fromChatId ? `Agent: ${state.chats.find(chat => chat.id === message.fromChatId)?.title || 'another chat'}` : message.role === 'user' ? 'You' : 'Faber';
  const heading = el('div', 'message-heading', author);
  if (correction) heading.append(el('span', 'followup-label', correction));
  else if (message.status === 'pending') { article.classList.add('pending-followup'); heading.append(el('span', 'pending-followup-label', 'Pending follow-up')); article.title = 'Kept in the queue until a run reaches a safe point between model/tool steps. A running command is not interrupted.'; }
  else if (message.steering) heading.append(el('span', 'followup-label', 'Follow-up'));
  if (message.createdAt) { const time = el('time', '', new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); time.dateTime = message.createdAt; heading.append(time); }
  article.append(heading);
  if (message.content) { const content = el('div', 'message-content'); content.append(message.role === 'user' ? document.createTextNode(displayText(message.content)) : richContent(displayText(message.content))); article.append(content); }
  if (message.images?.length) {
    const attachments = el('div', 'message-images');
    for (const [index, value] of message.images.entries()) { const source = safeImage(value); if (!source) continue; const image = el('img'); image.src = source; image.alt = `Image ${index + 1} attached to this message`; image.loading = 'lazy'; attachments.append(image); }
    if (attachments.childNodes.length) article.append(attachments);
  }
  if (message.toolCalls?.length) article.append(el('div', 'hint', `Using ${message.toolCalls.map(call => call.function?.name || call.name || 'tool').join(', ')}`));
  article.append(...mediaOutputs.get(message.mediaRefs, { chatId: currentChat().id }));
  bindContent(article, { chatId: currentChat().id, text: displayText(message.content) });
  if (message.role === 'assistant' && message.content) {
    const actions = el('div', 'message-actions');
    actions.append(button('Copy', async () => { await navigator.clipboard.writeText(displayText(message.content)); notify('Copied reply.'); }), button('Read aloud', () => request('voice.speak', { text: displayText(message.content) })));
    article.append(actions);
  }
  return article;
}
function renderStream() {
  renderTranscript();
}
function resultImage(result) { try { return (typeof result === 'string' ? JSON.parse(result) : result)?.image; } catch { return undefined; } }
function richContent(text) { return renderRichContent(text, { onOpenLink: url => act(() => request('app.openLink', { url })) }); }
function appendResult(parent, result, messageImage, showImage = true) {
  let parsed = result;
  if (typeof result === 'string') { try { parsed = JSON.parse(result); } catch { /* Ordinary text is rendered verbatim. */ } }
  const image = safeImage(messageImage) || safeImage(parsed?.image);
  if (image && showImage) { const img = el('img', 'tool-image'); img.src = image; img.alt = 'Screenshot returned by the tool'; parent.append(img); }
  const text = image && parsed && typeof parsed === 'object' ? displayText(Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'image'))) : displayText(parsed);
  parent.append(el('pre', 'result-content', text));
}
function renderActivity() {
  const root = $('#activity-content'); const expanded = new Set([...root.querySelectorAll('details[open]')].map(item => item.dataset.eventId));
  const usageOpen = new Map([...root.querySelectorAll('.usage-run')].map(item => [item.dataset.runId, item.open]));
  root.replaceChildren(); const chat = currentChat(); const run = latestRun(state, chat?.id);
  const session = el('section', 'activity-section'); session.append(el('h3', '', 'This chat'));
  const progress = modelProgress(run, streams.get(run?.id)), status = el('p', `activity-empty model-progress${progress.pulse ? ' thinking-pulse' : ''}`, run ? progress.label : 'No run yet. Send a message to get started.'); status.title = progress.title; session.append(status);
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
        row.append(el('strong', '', `${call.purpose === 'compaction' ? 'Context summary' : `Call ${call.sequence}`} · ${statusLabel(call.status)}`), el('p', '', `${state.providers.find(provider => provider.id === call.providerId)?.name || call.providerId || 'Connection not recorded'} / ${item.modelDisplayName || modelDisplayName(call.providerId, call.model, modelLabels, 'Model not recorded')}`));
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
  for (const event of events) { const item = el('details', 'activity-item'); item.dataset.eventId = event.id; item.open = expanded.has(event.id); const summary = el('summary'); summary.append(el('strong', '', event.name), el('span', '', statusLabel(event.status))); item.append(summary, el('pre', '', displayText(event.args))); if (event.result !== undefined) appendResult(item, event.result); if (event.error) item.append(el('p', 'error-text', event.error)); bindContent(item, { chatId: run.chatId, text: displayText(event.result ?? event.args ?? event.error) }); tools.append(item); }
  root.append(tools);
  const actions = extensionActions(state.extensions);
  if (actions.length) { const section = el('section', 'activity-section'); section.append(el('h3', '', 'Extensions')); for (const action of actions) section.append(button(action.label, () => showToolForm(action.tool, action), 'nav-button')); root.append(section); }
  const project = currentProject();
  if (project) { const section = el('section', 'activity-section'); section.append(el('h3', '', 'Project folder'), el('p', 'activity-project', project.path), button('Open folder', () => request('app.openPath', { path: project.path }), 'text-button'), button('Rename project', () => showRename('project', project), 'text-button')); root.append(section); }
}
function renderApprovals() {
  const root = $('#approval-list'); root.replaceChildren();
  for (const approval of chatApprovals(state, selectedChatId)) {
    const item = el('section', 'approval'); item.append(el('h3', '', projectApprovalTitle(approval)), el('p', '', approval.summary));
    if (approval.targetProjectPath) item.append(el('p', 'approval-project-target', `${approval.projectName || 'Target project'} · ${approval.targetProjectPath}`));
    if (approval.chatId !== selectedChatId) item.prepend(button(`Agent: ${state.chats.find(chat => chat.id === approval.chatId)?.title || 'child chat'}`, () => selectChat(approval.chatId), 'text-button'));
    const actions = el('div', 'approval-actions'); const remember = el('input'); remember.type = 'checkbox';
    const label = el('label'); label.append(remember, document.createTextNode(approval.chatId === selectedChatId ? ' Remember for this chat' : ' Remember for this agent chat'));
    for (const [text, allow] of [['Allow for this run', true], ['Deny', false]]) actions.append(button(text, async () => { await request('approval.resolve', { id: approval.id, allow, remember: allow && approval.rememberable !== false && remember.checked }); await refresh(); }, allow ? 'button primary' : 'button'));
    if (approval.rememberable !== false) actions.append(label); item.append(actions); root.append(item);
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
  const version = navigationVersion, chat = await request('chat.create', { projectId: currentProject().id }); await refresh(); if (version === navigationVersion && !remoteConnections.workspace.isOpen()) selectChat(chat.id); return chat;
}
async function sendText(text, withImages = false, steer = false) {
  const sourceDraftKey = draftKey(); const attachments = withImages ? [...imageDrafts.get(sourceDraftKey)] : [];
  if (attachments.some(item => item.pending)) { notify('Wait for the attachments to finish reading.'); return; }
  if ((!text.trim() && !attachments.length) || sending) return;
  if (!currentProject()) { showProjectForm(); return; }
  const run = steer ? latestRun(state, currentChat()?.id) : undefined;
  if (steer && !isActive(run)) { notify('The task has finished. Send the draft as a new message.'); return; }
  sending = true; render();
  drafts.set(sourceDraftKey, $('#prompt').value);
  try {
    const target = currentChat() || await request('chat.create', { projectId: currentProject().id });
    if (!target) return;
    const images = attachments.filter(item => item.image).map(item => item.image);
    const params = { chatId: target.id, text: attachmentMessage(text, attachments), ...(images.length ? { images } : {}) };
    if (steer) {
      const correction = correctionRequest(pendingCorrections.get(sourceDraftKey), run.id, params.text, attachments);
      pendingCorrections.set(sourceDraftKey, correction);
      await request('chat.steer', { ...params, runId: run.id, correctionId: correction.correctionId });
    } else await request('chat.send', params);
    pendingCorrections.delete(sourceDraftKey);
    if (draftKey() === sourceDraftKey && $('#prompt').value === text) $('#prompt').value = '';
    if (drafts.get(sourceDraftKey) === text) drafts.delete(sourceDraftKey);
    imageDrafts.remove(sourceDraftKey, attachments.map(item => item.id));
    // Leave newer edits and in-flight attachments in their original draft. Navigation
    // during the request never redirects or clears the newly selected chat.
    if (!selectedChatId && draftKey() === sourceDraftKey && !$('#prompt').value && !imageDrafts.get(sourceDraftKey).length) { await refresh(); selectChat(target.id); }
    await refresh(); if (selectedChatId === target.id) $('#transcript').scrollTop = $('#transcript').scrollHeight;
  } finally { sending = false; render(); }
}
function modal(title) { browserPanel.suspend(); navigationMenu.close(); modalReturnFocus = undefined; $('#modal').dispatchEvent(new Event('faber-modal-replace')); $('#modal').classList.remove('delete-modal'); $('#modal-title').textContent = title; const body = $('#modal-body'); body.replaceChildren(); body.className = ''; body.oninput = null; delete body.dataset.settingsCategory; delete body.dataset.settingsClean; if (!$('#modal').open) $('#modal').showModal(); return body; }
function closeModal() { $('#modal').close(); }
function field(labelText, value = '', type = 'text', hint = '') {
  const wrapper = el('label', 'form-row'); wrapper.append(el('span', '', labelText)); const input = el(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type; input.value = input.defaultValue = value ?? ''; wrapper.append(input); if (hint) wrapper.append(el('small', '', hint)); return { wrapper, input };
}
function selectField(labelText, options, value) {
  const wrapper = el('label', 'form-row'); wrapper.append(el('span', '', labelText)); const input = el('select');
  for (const option of options) { const item = el('option', '', option.label); item.value = option.value; input.append(item); }
  input.value = value ?? options[0]?.value ?? ''; for (const item of input.options) item.defaultSelected = item.selected; wrapper.append(input); return { wrapper, input };
}
function checkedRow(label, checked, description) {
  const wrapper = el('label', 'option-row'); const text = el('span', '', label); if (description) text.append(el('small', '', description));
  const input = el('input'); input.type = 'checkbox'; input.checked = input.defaultChecked = checked; wrapper.append(text, input); return { wrapper, input };
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
  const details = el('div', 'form-grid'), name = field('New project name'); name.input.id = 'move-project-name'; details.append(name.wrapper, el('p', 'hint', 'Choose the project folder in the Windows folder picker when you move this chat. Existing files will not be moved.'));
  const update = () => { details.hidden = project.input.value !== '__new__'; }; project.input.addEventListener('change', update); update(); body.append(project.wrapper, details);
  const move = button('Move chat', async () => {
    if (!state.chats.some(item => item.id === targetId)) throw new Error('This chat is no longer available.');
    let projectId = project.input.value;
    if (projectId === '__new__') { const created = await chooseProject(name.input.value); if (!created) return; projectId = created.id; }
    await request('chat.move', { chatId: targetId, projectId }); await refresh(); if (selectedChatId === targetId) selectedProjectId = projectId; closeModal(); notify('Chat moved to the selected project.');
  }, 'button primary'); move.id = 'confirm-move-chat'; body.append(actions(button('Cancel', closeModal), move)); project.input.focus();
}
function showProjectForm() {
  const body = modal('Add a project'); body.append(el('p', 'hint', 'Select a folder for this project. Your chat history stays in Faber’s private local data folder.'));
  const name = field('Project name', '', 'text'); body.append(name.wrapper);
  body.append(actions(button('Cancel', closeModal), button('Choose folder & add project', async () => { const project = await chooseProject(name.input.value); if (!project) return; await refresh(); selectChat(null, project.id); closeModal(); await newChat(); }, 'button primary'))); name.input.focus();
}
async function chooseProject(name) {
  pendingPicker = true;
  try { return await request('project.create', { name: name.trim() || 'Untitled project' }); }
  catch (error) { if (/(?:^|: )No project directory selected$/.test(error.message)) return null; throw error; }
  finally { pendingPicker = false; scheduleUIRefresh(); }
}
function showRename(kind, entity) {
  const body = modal(`Rename ${kind}`); const name = field('Name', kind === 'chat' ? entity.title : entity.name); body.append(name.wrapper);
  body.append(actions(button('Cancel', closeModal), button('Save', async () => { const value = name.input.value.trim(); if (!value) throw new Error('Enter a name.'); await request(`${kind}.update`, { id: entity.id, [kind === 'chat' ? 'title' : 'name']: value }); await refresh(); closeModal(); }, 'button primary'))); name.input.focus(); name.input.select();
}
function showSettings(category = 'ui') { remoteConnections.workspace.close(); preferences.show(category); }
function showModelPicker() { connections.showPicker(); }
const permissionDescriptions = {
  files: 'Write files in permitted project folders.', shell: 'Run commands with your Windows user permissions.', computer: 'Take screenshots, control this computer, and use microphone or speech tools.', network: 'Make requests to external services.', upgrade: 'Stage or activate changes to Faber and its extensions.',
};
function showChatSettings() {
  const chat = currentChat(); if (!chat) return;
  const body = modal('Chat settings');
  const title = field('Chat title', chat.title); body.append(title.wrapper);
  const promptChoice = preferences.createPromptChoice(); body.append(promptChoice.root);
  const permissions = el('section', 'modal-section'); permissions.append(el('h3', '', 'Permissions'), el('p', 'hint', 'Read tools can inspect this workspace. Other actions ask each run unless you grant access here. Shell grants and executable addons have full PC authority under your user account; these grants are not an operating-system sandbox.'));
  const checks = PERMISSIONS.map(permission => { const check = checkedRow(statusLabel(permission), chat.grants.includes(permission), permissionDescriptions[permission]); check.wrapper.classList.add('permission-row'); permissions.append(check.wrapper); return { permission, ...check }; }); body.append(permissions);
  const projects = el('section', 'modal-section'); projects.append(el('h3', '', 'Access to other projects'), el('p', 'hint', 'Only you can grant these named project scopes. Files and shell permissions remain separate. Revoking a project stops runs using that scope.'));
  const projectChecks = state.projects.filter(project => !project.archived && project.id !== chat.projectId).map(project => { const check = checkedRow(project.name, (chat.projectGrants || []).includes(project.id), project.path); check.input.dataset.projectGrant = project.id; projects.append(check.wrapper); return { project, ...check }; });
  if (!projectChecks.length) projects.append(el('p', 'hint', 'No other projects are available.')); body.append(projects);
  const speech = el('section', 'modal-section'); speech.append(el('h3', '', 'Voice'));
  const phrase = field('Activation phrase', chat.voice?.phrase || 'Hey Faber', 'text', 'Used only while the voice assistant is listening for this chat.');
  const enabled = checkedRow('Enable activation for this chat', Boolean(chat.voice?.enabled), 'This phrase can select this chat while assistant mode is running.');
  const speak = checkedRow('Read replies aloud', chat.voice?.speakReplies !== false); speech.append(phrase.wrapper, enabled.wrapper, speak.wrapper); body.append(speech);
  body.append(actions(button('Archive chat', async () => { await request('chat.archive', { chatId: chat.id }); await refresh(); closeModal(); }), button('Delete chat', () => showDelete('chat', chat), 'button danger'), button('Save changes', async () => {
    if (!title.input.value.trim() || !phrase.input.value.trim()) throw new Error('Enter a chat title and activation phrase.');
    await request('chat.update', { id: chat.id, title: title.input.value.trim(), ...promptChoice.value(), grants: checks.filter(item => item.input.checked).map(item => item.permission), projectGrants: projectChecks.filter(item => item.input.checked).map(item => item.project.id), voice: { ...chat.voice, enabled: enabled.input.checked, phrase: phrase.input.value.trim(), speakReplies: speak.input.checked } }); await refresh(); closeModal();
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
  return $('#modal-body').dataset.settingsClean === 'true' && !hasUnsentDrafts({ fields: document.querySelectorAll('#modal input, #modal textarea, #modal select') });
}
function refreshReason(manual) {
  if (remoteConnections.refreshReason()) return remoteConnections.refreshReason();
  if (document.querySelector('#profile-switch-dialog').open) return 'Close the profile switcher before refreshing.';
  if (navigationMenu.isOpen()) return 'Close the chat or project menu before refreshing.';
  if (composing) return 'Finish composing text before refreshing.';
  return refreshBlocker({ sending, pendingReads: imageDrafts.hasPending(), pendingPicker, pendingRequests, modalOpen: $('#modal').open, cleanSettings: cleanSettings(), modelsOpen: document.body.classList.contains('models-open'), voiceActive: !['off', 'error', 'transcript'].includes(voice.status), manual });
}
function freezeInterface(frozen) { if (frozen) browserPanel.suspend(); uiHandoff = frozen; document.body.inert = frozen; document.documentElement.dataset.uiRefreshing = String(frozen); }
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
    const recovery = await request('app.recoveryStatus'); workspaceControls.setRecovery(recovery);
    await workspaceControls.loadProfiles();
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
    flushHandoffVoice();
    if (recovery.safeMode && !saved) workspaceControls.showRecovery();
    else if (!saved && !state.settings?.onboardingComplete) preferences.showQuickStart();
    await new Promise(resolve => requestAnimationFrame(resolve));
    await request('app.uiReady');
    document.documentElement.dataset.uiReady = 'true'; scheduleUIRefresh(); void refreshModelLabels();
    void browserPanel.load();
    void chatgptControls.load().catch(error => notify(`ChatGPT connection status: ${error.message}`, true));
    void remoteConnections.load().catch(error => notify(`Remote connections: ${error.message}`, true));
  } catch (error) {
    bootstrapping = false; freezeInterface(false); document.documentElement.dataset.uiReady = 'error';
    notify(`Interface recovery could not finish: ${interfaceError(error)}. Any pending recovery snapshot remains in host memory.`, true);
  }
}

const navigationMenu = createNavigationMenu({ el, getState: () => state, onAction: (...args) => act(() => navigationAction(...args)) });
const runActivity = createRunActivity({ el, button, appendResult: (parent, result, image) => appendResult(parent, result, image, false), bindContent, selectChat, resolveApproval: async (id, allow) => { await request('approval.resolve', { id, allow }); await refresh(); } });
const chatControls = createChatControls({ request, refresh, getChat: currentChat, getDraft: () => $('#prompt').value, getModelName: () => modelDisplayName(currentProvider()?.id, currentChat()?.model || currentProvider()?.model, modelLabels), modal, closeModal, el, button, field, actions, icon, notify });
$('#composer-bottom').prepend(chatControls.root);
const browserPanel = createBrowserPanel({ request, subscribe: bridge?.subscribe, getChat: currentChat, getChats: () => state.chats, el, button });
const modelsBrowser = createModelsBrowser({ request, subscribe: bridge?.subscribe, el, button, field, actions, notify, showSettings: () => showSettings('models') });
const connections = createConnections({ request, refresh, getState: () => state, getChat: currentChat, getModelLabels: () => modelLabels, newChat, modal, closeModal, el, button, field, selectField, checkedRow, actions, showSettings: () => showSettings('connections'), createPromptChoice: () => preferences.createPromptChoice(), mountOpenAI: body => chatgptControls.mount(body) });
const addonManager = createAddonManager({ request, subscribe: bridge?.subscribe, modal, el, button, actions, notify });
const remoteConnections = createRemoteConnections({ request, subscribe: bridge?.subscribe, el, field, closeModal, contentMenu, showConnections: () => showSettings('connections'), suspendLocal: () => { mediaOutputs.clear(); transcriptChatId = undefined; browserPanel.suspend(); modelsBrowser.close(); navigationMenu.close(); }, onChange: () => { renderNavigation(); if (!remoteConnections.workspace.isOpen()) renderTranscript(); scheduleUIRefresh(); } });
const workspaceControls = createWorkspaceControls({ request, subscribe: bridge?.subscribe, getState: () => state, modal, closeModal, el, button, field, selectField, actions, notify, addonManager, hasDrafts: () => remoteConnections.hasDrafts() || hasUnsentDrafts({ text: $('#prompt').value, drafts: drafts.values(), attachments: imageDrafts.hasPending() ? [] : imageDrafts.snapshot(), pending: imageDrafts.hasPending() || pendingPicker, fields: document.querySelectorAll('#modal input, #modal textarea, #modal select, #models-panel input, #models-panel textarea, #models-panel select') }) });
const preferences = createPreferences({ workspaceControls, remoteConnections, request, refresh, getState: () => state, getChat: currentChat, modal, closeModal, el, button, field, selectField, actions, notify, wordmark, connections, modelsBrowser, addonManager, showVoice, showTools, refreshInterface, getErrors: () => recentErrors.slice(), showOpenAI: () => connections.showPicker(undefined, 'openai') });
const chatgptControls = createChatGPTControls({ request, refresh, getChat: currentChat, getState: () => state, newChat, closeModal, el, button, field, selectField, actions, createPromptChoice: () => preferences.createPromptChoice(), notify });
$('#open-addons').addEventListener('click', () => act(() => addonManager.show()));
$('#open-connections').addEventListener('click', () => showSettings('connections'));
$('#open-models').addEventListener('click', () => act(() => modelsBrowser.open()));
$('#new-chat').addEventListener('click', () => act(() => remoteConnections.workspace.isOpen() ? remoteConnections.workspace.newChat() : newChat()));
$('#add-project').addEventListener('click', showProjectForm);
$('#open-settings').addEventListener('click', () => showSettings());
$('#report-notice').addEventListener('click', () => act(preferences.showBugReport));
window.addEventListener('error', event => rememberError(event.message || 'Unknown interface error'));
window.addEventListener('unhandledrejection', event => rememberError(event.reason?.message || String(event.reason)));
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
$('#steer-message').addEventListener('click', () => act(() => sendText($('#prompt').value, true, true)));
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
$('#toggle-activity').addEventListener('click', () => { if (document.body.classList.contains('browser-open')) { browserPanel.show(false); toggleActivity(true); } else toggleActivity(); }); $('#close-activity').addEventListener('click', () => toggleActivity(false));
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !$('#modal').open) { event.preventDefault(); act(() => remoteConnections.workspace.isOpen() ? remoteConnections.workspace.newChat() : newChat()); } if (event.key === 'Escape') document.body.classList.remove('sidebar-open', 'activity-open'); });
function handleBridgeEvent(event) {
    if (event.type === 'openSettings') { showSettings(); return; }
    if (event.type === 'chatgpt') { chatgptControls.accept(event); return; }
    if (event.type === 'localModels') { chatControls.invalidate(); renderComposerControls(); if (event.state?.modelLabels) { ++modelLabelRequest; modelLabels = event.state.modelLabels; renderModelLabel(); } else void refreshModelLabels(); }
    if (event.type === 'models') downloadDirectory = event.state.downloadDirectory;
    if (event.type === 'voice' && uiHandoff) { handoffVoiceEvents.push(event); return; }
    if (event.type === 'state') acceptState(event.state);
    else if (event.type === 'delta' || event.type === 'progress') {
      const previous = streams.get(event.runId);
      if (Number.isSafeInteger(event.streamSequence)) {
        const before = streamVersion; streamVersion = mergeRuntimeStreams(streams, event, streamVersion); if (event.sequence <= before) return;
      } else {
        let stream = previous;
        if (!stream) { const chat = state.chats.find(item => item.id === event.chatId); stream = { text: '', lastAssistantId: chat?.messages.findLast(item => item.role === 'assistant')?.id }; streams.set(event.runId, stream); }
        if (event.type === 'delta') stream.text = event.replace ? event.text : stream.text + event.text;
        if (event.phase && event.phase !== stream.phase) stream.progressSummary = '';
        if (event.phase) stream.phase = event.phase;
        if (typeof event.summary === 'string') stream.progressSummary = event.summary;
        if (event.modelCallId) stream.modelCallId = event.modelCallId;
        if (event.metrics) stream.metrics = event.metrics;
      }
      const stream = streams.get(event.runId), call = state.runs.find(run => run.id === event.runId)?.modelCalls?.find(call => call.id === event.modelCallId);
      if (call && stream) { if (stream.phase) call.phase = stream.phase; call.progressSummary = stream.progressSummary || ''; if (event.metrics) call.metrics = event.metrics; }
      if (event.chatId === selectedChatId) { renderStream(); renderComposerControls(); if (event.type === 'progress' || previous?.phase !== stream?.phase) renderActivity(); }
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
