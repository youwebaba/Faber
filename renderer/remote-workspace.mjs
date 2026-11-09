import { remoteWorkspace, remoteChat, remoteLive, remoteChatFamilies, remoteEvent } from './remote-state.mjs';
import { isActive, latestRun, sameMessage, safeImage, displayText, chatApprovals, statusLabel } from './ui-helpers.mjs';
import { createAttachmentDrafts, attachmentMessage } from './file-attachments.mjs';
import { mergeRuntimeStreams } from './ui-refresh.mjs';
import { renderRichContent, renderOutputImages } from './rich-content.mjs';
import { createRunActivity } from './run-activity.mjs';
import { createLiveTranscript, reconcileTranscript, preserveTranscriptViewport } from './transcript-timeline.mjs';
import { pendingUserMessages, projectApprovalTitle } from './workspace-controls.mjs';
import { createMediaOutputs, resultMedia } from './content-media.mjs';
import { correctionLabel, correctionRequest } from './prompt-progress.mjs';

export function createRemoteWorkspace({ request, subscribe, el, getDevices, showConnections, contentMenu, suspendLocal = () => {}, onChange = () => {}, document = globalThis.document }) {
  const button = (label, callback, className = 'button') => { const node = el('button', className, label); node.type = 'button'; node.addEventListener('click', async () => { node.disabled = true; try { await callback(); } catch (error) { setError(error); } finally { node.disabled = false; renderStatus(); renderApprovals(); } }); return node; };
  const root = el('section', 'remote-workspace'); root.id = 'remote-workspace'; root.hidden = true; root.setAttribute('aria-label', 'Remote workspace');
  const header = el('header', 'remote-header'), hostLabel = el('strong'), hostSelect = el('select'); hostSelect.id = 'remote-host'; hostSelect.setAttribute('aria-label', 'Workspace device');
  const connections = button('Connections', () => { close(); showConnections(); });
  const showSidebar = button('☰', () => { document.body.classList.remove('sidebar-hidden'); document.body.classList.add('sidebar-open'); }, 'icon-button remote-show-sidebar'); showSidebar.setAttribute('aria-label', 'Show sidebar');
  header.append(showSidebar, hostLabel, hostSelect, connections); root.append(header);
  const layout = el('div', 'remote-layout');
  const newChat = button('＋ New chat', () => createChat()); newChat.id = 'remote-new-chat';
  const archive = el('label', 'remote-archive'), archiveInput = el('input'); archiveInput.type = 'checkbox'; archiveInput.id = 'remote-show-archived'; archive.append(archiveInput, document.createTextNode('Show archived'));
  const navigation = el('div'); navigation.id = 'remote-projects'; navigation.setAttribute('aria-label', 'Paired device projects and chats'); header.append(newChat);
  (document.querySelector('#project-list') || document.body).append(navigation);
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
  const clearDraft = button('Clear draft', () => { const draft = key(); drafts.delete(draft); attachments.remove(draft, attachments.get(draft).map(item => item.id)); prompt.value = ''; renderStatus(); onChange(); }, 'text-button'); clearDraft.id = 'remote-clear-draft';
  const stop = button('■ Stop', () => mutate('chat.stop', { chatId: selectedChatId }), 'button remote-stop'); stop.id = 'remote-stop';
  const forceStop = button('Force stop', () => mutate('chat.forceStop', { chatId: selectedChatId }), 'text-button'); forceStop.id = 'remote-force-stop';
  const attach = button('Attach images', () => { pickerKey = key(); picker.click(); }); attach.id = 'remote-attach-images';
  const picker = el('input'); picker.type = 'file'; picker.id = 'remote-image-picker'; picker.accept = 'image/png,image/jpeg,image/webp'; picker.multiple = true; picker.hidden = true; picker.setAttribute('aria-label', 'Choose images for the host');
  const imageDrafts = el('div', 'image-drafts'); imageDrafts.id = 'remote-image-drafts'; imageDrafts.hidden = true; imageDrafts.setAttribute('aria-label', 'Images attached to this host chat');
  const steer = button('Steer now', () => submit(true)); steer.id = 'remote-steer'; steer.hidden = true;
  const send = el('button', 'button primary', 'Send'); send.type = 'submit'; send.id = 'remote-send'; toolbar.append(attach, compact, clearDraft, el('span', 'composer-spacer'), forceStop, stop, steer, send);
  composer.append(imageDrafts, picker, prompt, toolbar); composerWrap.append(approvalList, composer, caption); conversation.append(titlebar, modelPanel, notice, retry, older, transcript, composerWrap); layout.append(conversation); root.append(layout); (document.querySelector('.workspace') || document.body).append(root);
  const drafts = new Map(), selections = new Map(), streams = new Map(), messageNodes = new Map(), directories = new Map(), directoryLoads = new Map(), details = new Map(), imageCache = new Map(), imageNodes = new Map();
  const liveTranscript=createLiveTranscript({el,bindContent,onOpenLink:url=>request('app.openLink',{url}).catch(setError)});
  const attachments = createAttachmentDrafts({ onChange: draft => { if (draft === key()) { renderAttachments(); renderStatus(); } onChange(); } });
  const pendingCorrections = new Map();
  const imageQueue = [], imageObserver = typeof globalThis.IntersectionObserver === 'function' ? new globalThis.IntersectionObserver(records => { for (const record of records) { const entry = imageNodes.get(record.target.dataset.imageKey); if (!entry) continue; entry.visible = record.isIntersecting; if (entry.visible) queueImage(entry); else unloadImage(entry); } }, { root: transcript, rootMargin: '200px' }) : null;
  let deviceId, selectedChatId, selectedProjectId, state = { projects: [], chats: [], runs: [], approvals: [] }, selectedDetail, online = false, connecting = false, pending = false, session = 0, chatGeneration = 0, streamVersion = -1, timer, chatTimer, directoryTimer, polling, listVersion = '', transcriptIdentity, readSequence = 0, lastError = '', returnFocus, chatRevision, olderToken, loadingOlder = false, hostProviders = [], disposed = false, pickerKey, attachmentSignature, imageReads = 0;
  const identity = (device, chat, project) => JSON.stringify([device, chat || null, chat ? null : project || null]);
  const key = () => identity(deviceId, selectedChatId, selectedProjectId);
  const currentChat = () => state.chats.find(chat => chat.id === selectedChatId);
  const currentProject = () => state.projects.find(project => project.id === (currentChat()?.projectId || selectedProjectId));
  const currentDevice = () => getDevices().find(device => device.id === deviceId);
  const saveDraft = () => { if (deviceId) drafts.set(key(), prompt.value); };
  const rememberDetail = () => { details.delete(key()); details.set(key(), selectedDetail); while (details.size > 8) details.delete(details.keys().next().value); };
  const hasDrafts = () => [...drafts.values()].some(value => value.length > 0) || prompt.value.length > 0 || Boolean(pickerKey) || attachments.hasPending() || attachments.snapshot().some(entry => entry.attachments.length);
  const mediaOutputs = createMediaOutputs({ request, contentMenu, document });
  function bindContent(node, context) { const owner = { ...context, deviceId }; mediaOutputs.track(owner); contentMenu?.bind(node, owner); }
  const appendResult = (parent, value, image) => { parent.append(el('pre', 'result-content', displayText(value))); const images = renderOutputImages([image, value?.image], { document }); if (images.childNodes.length) parent.append(images); };
  const activity = createRunActivity({ el, button, appendResult, bindContent, selectChat: id => selectChat(id), resolveApproval });
  function resolveApproval(id, allow) { const approval = state.approvals.find(item => item.id === id); if (!approval) throw new Error('This host approval is no longer pending.'); return mutate('approval.resolve', { id, chatId: approval.chatId, allow }); }

  async function rpc(method, params = {}, target = deviceId) {
    const read = ['workspace.list', 'workspace.models', 'chat.read', 'chat.image'].includes(method);
    if (!target || target !== deviceId || !online && !(connecting && read)) throw new Error('This host is offline. Reconnect before sending an action.');
    return request('remote.request', { deviceId: target, method, params, ...(!read ? { requestId: globalThis.crypto.randomUUID() } : {}) });
  }
  function setError(error) { lastError = error?.message || String(error); notice.textContent = lastError; notice.classList.add('error-text'); }
  function renderAttachments() {
    const draft = key(), files = attachments.get(draft), signature = JSON.stringify([draft, files.map(item => [item.id, item.pending])]); if (signature === attachmentSignature) return; attachmentSignature = signature;
    imageDrafts.hidden = !files.length; imageDrafts.replaceChildren();
    for (const [index, file] of files.entries()) {
      const preview = el('div', 'image-draft'); preview.title = file.name;
      if (file.image) { const image = el('img'); image.src = file.image; image.alt = `Host attachment ${index + 1}: ${file.name}`; preview.append(image); } else preview.append(el('span', '', file.pending ? 'Reading…' : file.name));
      const remove = button('×', () => attachments.remove(draft, [file.id])); remove.setAttribute('aria-label', `Remove host attachment ${index + 1}: ${file.name}`); preview.append(remove); imageDrafts.append(preview);
    }
  }
  function unloadImage(entry) { if (!entry.node.querySelector('img')) return; const height = entry.node.getBoundingClientRect().height; if (height > 0) entry.node.style.minHeight = `${height}px`; entry.node.textContent = 'Host image'; }
  function showImage(entry, image) { entry.node.replaceChildren(renderOutputImages([image], { document })); bindContent(entry.node, { chatId: entry.chatId, imageId: entry.ref.id }); const node = entry.node.querySelector('img'); if (node?.complete) entry.node.style.minHeight = ''; else node?.addEventListener('load', () => { entry.node.style.minHeight = ''; }); }
  function referencedImages(refs, chatId = selectedChatId) {
    const group = el('div', 'message-images');
    for (const ref of refs || []) {
      const cacheKey = JSON.stringify([deviceId, chatId, ref.id]); let entry = imageNodes.get(cacheKey);
      if (!entry) { entry = { node: el('div', 'remote-image-output'), ref, chatId, deviceId, cacheKey, visible: !imageObserver }; entry.node.dataset.imageId = ref.id; entry.node.dataset.imageKey = cacheKey; imageNodes.set(cacheKey, entry); entry.node.textContent = online ? 'Host image' : 'Connect to the host to load this image.'; if (imageCache.get(cacheKey)?.error || imageCache.get(cacheKey)?.evicted) entry.node.append(button('Load host image', () => { imageCache.delete(cacheKey); queueImage(entry); }, 'text-button')); imageObserver?.observe(entry.node); }
      bindContent(entry.node, { chatId, imageId: ref.id });
      if (entry.visible && !imageCache.has(cacheKey)) queueImage(entry);
      else if (entry.visible && imageCache.get(cacheKey)?.image && !entry.node.querySelector('img')) showImage(entry, imageCache.get(cacheKey).image);
      group.append(entry.node);
    }
    return group;
  }
  function queueImage(entry) {
    const cached = imageCache.get(entry.cacheKey);
    if (cached?.image) { if (!entry.node.querySelector('img')) showImage(entry, cached.image); return; }
    if (!online || root.hidden || entry.deviceId !== deviceId || cached?.loading || cached?.queued || cached?.error || cached?.evicted) return;
    imageCache.set(entry.cacheKey, { queued: true }); imageQueue.push({ entry, token: session, generation: chatGeneration }); drainImages();
  }
  function drainImages() {
    while (imageReads < 2 && imageQueue.length) {
      const job = imageQueue.shift(); if (job.token !== session || job.generation !== chatGeneration || root.hidden || !online || !job.entry.visible) { imageCache.delete(job.entry.cacheKey); continue; }
      imageReads++; void fetchImage(job).finally(() => { imageReads--; drainImages(); });
    }
  }
  function resetMedia() { mediaOutputs.clear(selectedChatId && deviceId ? { chatId: selectedChatId, deviceId } : undefined); transcriptIdentity = undefined; }
  function resetImages() { resetMedia(); imageObserver?.disconnect(); imageNodes.clear(); imageQueue.length = 0; for (const [key, value] of imageCache) if (value.loading || value.queued) imageCache.delete(key); }
  async function fetchImage({ entry, token, generation }) {
    const cacheKey = entry.cacheKey;
    imageCache.set(cacheKey, { loading: true }); entry.node.textContent = 'Loading host image…';
    try {
      const value = await rpc('chat.image', { chatId: entry.chatId, imageId: entry.ref.id }, entry.deviceId);
      if (token !== session || generation !== chatGeneration || root.hidden || !currentDevice()) return;
      if (value?.imageId !== entry.ref.id || !safeImage(value.image) || value.image.length > 8 * 1024 * 1024 || !value.image.startsWith(`data:${entry.ref.mimeType};base64,`)) throw new Error('The host returned an invalid image.');
      imageCache.delete(cacheKey); imageCache.set(cacheKey, { image: value.image }); if (entry.visible) showImage(entry, value.image);
      while ([...imageCache.values()].filter(value => value.image).length > 8) { const oldest = [...imageCache].find(([, value]) => value.image)[0]; imageCache.set(oldest, { evicted: true }); const old = imageNodes.get(oldest); if (old) { unloadImage(old); old.node.replaceChildren(button('Load host image', () => { imageCache.delete(oldest); queueImage(old); }, 'text-button')); } }
    } catch (error) { if (token === session && generation === chatGeneration && !root.hidden) { imageCache.set(cacheKey, { error: true }); entry.node.replaceChildren(el('span', 'hint', `Host image unavailable. ${error.message || String(error)}`), button('Retry image', () => { imageCache.delete(cacheKey); queueImage(entry); }, 'text-button')); } }
  }
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
    const files = attachments.get(key());
    attach.disabled = !online || pending || !project || readOnly;
    send.disabled = !online || pending || !project || readOnly || files.some(item => item.pending) || (!prompt.value.trim() && !files.length); send.textContent = isActive(run) ? 'Queue follow-up' : 'Send';
    steer.hidden = !isActive(run) || !directories.get(deviceId)?.capabilities?.steering; steer.disabled = send.disabled;
    newChat.disabled = !online || pending || !project || project.archived;
    stop.hidden = forceStop.hidden = !isActive(run); stop.disabled = forceStop.disabled = !online || pending || readOnly;
    compact.hidden = !run?.contextOverflow; compact.disabled = !online || pending || readOnly || isActive(run);
    older.hidden = !olderToken; older.disabled = !online || loadingOlder;
    clearDraft.hidden = !prompt.value.length && !files.length; clearDraft.disabled = pending;
    caption.textContent = readOnly ? archived ? 'Archived history is available to read.' : 'Manage this external session on the host.' : `Actions ask for approval on ${name}. Enter to send · Shift Enter for a new line`;
  }
  function renderNavigation() {
    const signature = JSON.stringify([root.hidden, deviceId, selectedChatId, selectedProjectId, archiveInput.checked, getDevices(), [...directories], state.projects, state.chats.map(chat => [chat.id, chat.projectId, chat.parentChatId, chat.archived, chat.title, chat.status, chat.createdAt, chat.lastAssistantAt]), state.runs.map(run => [run.chatId, run.status])]);
    if (signature === listVersion) return; listVersion = signature;
    const focused = navigation.contains(document.activeElement) ? document.activeElement?.dataset?.remoteKey : null;
    navigation.replaceChildren();
    navigation.hidden = !getDevices().length; if (navigation.hidden) return;
    navigation.append(archive);
    let tooltip = 0;
    for (const device of getDevices()) {
      const cached = directories.get(device.id), active = !root.hidden && device.id === deviceId, workspace = active ? state : cached, name = device.name || device.deviceName || 'Host', disconnected = !device.online || Boolean(cached?.error);
      const host = el('section', 'remote-nav-host'), hostButton = button(`${name}${disconnected ? ' · offline' : ''}`, () => open(device.id), 'remote-host-button'); hostButton.dataset.remoteDeviceId = device.id; hostButton.dataset.remoteKey = identity(device.id); host.append(hostButton);
      for (const project of (workspace?.projects || []).filter(project => archiveInput.checked || !project.archived)) {
        const group = el('div', 'project-group'), heading = button(`${project.name}${project.archived ? ' · archived' : ''}`, () => open(device.id, null, project.id), 'project-button');
        heading.dataset.remoteProjectId = project.id; heading.dataset.remoteDeviceId = device.id; heading.dataset.remoteKey = identity(device.id, null, project.id); heading.title = `${project.name} · ${name}`; if (active && project.id === selectedProjectId && !selectedChatId) heading.setAttribute('aria-current', 'page'); group.append(heading);
        for (const { chat, depth } of remoteChatFamilies(workspace, project.id, archiveInput.checked)) {
          const selected = active && chat.id === selectedChatId, item = button('', () => open(device.id, chat.id, project.id), `chat-nav remote-chat-nav${selected ? ' selected' : ''}`); item.dataset.remoteChatId = chat.id; item.dataset.remoteDeviceId = device.id; item.dataset.remoteKey = identity(device.id, chat.id); item.style.paddingLeft = `${32 + Math.min(depth, 8) * 15}px`;
          const globe = el('span', 'remote-globe', '🌐'); globe.setAttribute('aria-hidden', 'true');
          const description = `${chat.title} · Project: ${project.name} · Device: ${name}${disconnected ? ' · Offline — saved chat' : ' · Remote chat'}`, tip = el('span', 'remote-chat-tooltip', description); tip.id = `remote-chat-tooltip-${++tooltip}`; tip.setAttribute('role', 'tooltip'); item.setAttribute('aria-describedby', tip.id); item.title = description;
          item.append(globe, el('span', 'chat-name', `${depth ? '↳ ' : ''}${chat.title}${chat.archived ? ' · archived' : ''}`), tip); if (selected) item.setAttribute('aria-current', 'page');
          if (isActive(latestRun(workspace, chat.id) || { status: chat.status })) { const dot = el('span', 'status-dot'); dot.setAttribute('aria-label', 'Running'); item.append(dot); } group.append(item);
        }
        host.append(group);
      }
      if (!workspace?.projects?.length) host.append(el('p', 'subtle-empty', cached?.error || (device.online ? 'Loading projects…' : 'Offline · connect to load projects.')));
      navigation.append(host);
    }
    if (focused) [...navigation.querySelectorAll('button')].find(node => node.dataset.remoteKey === focused)?.focus({ preventScroll: true });
  }
  function messageNode(message) {
    const correction = correctionLabel(state.runs.find(run => run.id === message.runId)?.steering?.find(item => item.messageId === message.id));
    let cached = messageNodes.get(message.id); if (sameMessage(cached?.message, message) && cached.correction === correction && JSON.stringify(cached.message.imageRefs) === JSON.stringify(message.imageRefs)) return cached.node;
    const node = el('article', `message ${message.role === 'user' ? 'user' : 'assistant'}${message.status === 'pending' ? ' pending-followup' : ''}`); node.dataset.messageId = message.id;
    node.append(el('div', 'message-heading', correction ? `You · ${correction}` : message.status === 'pending' ? 'You · queued follow-up' : message.role === 'user' ? 'You' : message.role === 'tool' ? message.toolName || 'Tool' : 'Faber'));
    const content = el('div', 'message-content'); content.append(renderRichContent(message.content, { document, onOpenLink: url => request('app.openLink', { url }).catch(setError) })); node.append(content);
    const images = renderOutputImages([message.image, ...(message.images || [])], { document }); if (images.childNodes.length) node.append(images);
    if (message.imageRefs?.length) node.append(referencedImages(message.imageRefs));
    node.append(...mediaOutputs.get(message.mediaRefs?.length ? message.mediaRefs : message.role === 'tool' ? resultMedia(message.content) : [], { chatId: selectedChatId, deviceId }));
    bindContent(node, { chatId: selectedChatId, text: displayText(message.content) });
    cached = { message, node, correction }; messageNodes.set(message.id, cached); return node;
  }
  function renderTranscript() {
    mediaOutputs.setAvailable(online);
    for (const [cacheKey, entry] of imageNodes) if (online && entry.visible && entry.deviceId === deviceId && !imageCache.has(cacheKey)) queueImage(entry);
    const identity = `${deviceId}:${selectedChatId || ''}`;
    if (transcriptIdentity !== identity) { mediaOutputs.clear(); transcriptIdentity = identity; transcript.replaceChildren(); messageNodes.clear(); liveTranscript.reset(); activity.reset(); }
    preserveTranscriptViewport(transcript, () => {
      const nodes = [];
      if (selectedDetail?.id === selectedChatId) {
        const timeline = liveTranscript.timeline({ ...state, approvals: [] }, selectedChatId, streams);
        for (const row of timeline) {
          if (row.kind === 'usage') { nodes.push(activity.promptUsage(row.key, row.usage)); continue; }
          if (row.kind === 'activity') {
            nodes.push(activity.get(state, { ...row.activity, approvals: [] }, streams));
            for (const branch of [{ run: row.activity.run, events: row.activity.events }, ...row.activity.childRuns.map(run => ({ run, events: run.toolEvents || [] }))]) for (const event of branch.events) {
              if (event.imageRefs?.length) nodes.push(referencedImages(event.imageRefs, branch.run.chatId));
              nodes.push(...mediaOutputs.get(event.mediaRefs?.length ? event.mediaRefs : resultMedia(event.result), { chatId: branch.run.chatId, deviceId }));
            }
            continue;
          }
          if (row.kind === 'message') { nodes.push(messageNode(row.message)); continue; }
          nodes.push(liveTranscript.row(row.run,row.text));
        }
        for (const message of pendingUserMessages(selectedDetail)) nodes.push(messageNode({ ...message, imageRefs: selectedDetail.inbox?.find(item => item.id === message.id)?.imageRefs }));
        const run = latestRun(state, selectedChatId); if (run && !isActive(run) && ['failed', 'interrupted', 'canceled'].includes(run.status)) nodes.push(el('p', 'run-note', run.error || `Run ${statusLabel(run.status).toLowerCase()}.`));
      }
      if (!nodes.length) { const welcome = el('div', 'welcome'); welcome.append(el('h1', '', selectedChatId ? selectedDetail ? 'Start a conversation.' : 'Loading chat…' : 'Your host workspace'), el('p', '', selectedChatId ? 'Messages and tool activity appear here.' : 'Choose a project and chat, or start a new chat on this host.')); nodes.push(welcome); }
      reconcileTranscript(transcript, nodes);
      mediaOutputs.prune();
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
  function renderLive() {
    if (!liveTranscript.update(transcript,streams,card=>activity.get(state,card,streams))) renderTranscript();
  }
  function render() { const following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 8; renderStatus(); renderAttachments(); renderNavigation(); renderApprovals(); renderTranscript(); if (following) transcript.scrollTop = transcript.scrollHeight; }
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
  function referenceModes() { const capabilities = directories.get(deviceId)?.capabilities; return { ...(capabilities?.imageReferences ? { imageMode: 'references' } : {}), ...(capabilities?.mediaReferences ? { mediaMode: 'references' } : {}) }; }
  function disconnect(error) { online = connecting = false; resetMedia(); mediaOutputs.setAvailable(false); setError(error); renderStatus(); renderTranscript(); }
  async function readChat(token = session, wait = false) {
    const chatId = selectedChatId, sequence = ++readSequence; if (!chatId || !online) return;
    const response = await rpc('chat.read', { chatId, limit: 30, ...referenceModes(), ...(wait && chatRevision ? { since: chatRevision, waitMs: 12000 } : {}) });
    if (token !== session || chatId !== selectedChatId || sequence !== readSequence) return;
    if (response?.unchanged === true) return;
    if (response?.liveOnly === true) { if (selectedDetail?.id !== chatId) throw new Error('Reload this host chat before accepting live updates.'); const live = remoteLive(response, chatId); chatRevision = live.revision; acceptStreams(live); renderLive(); return; }
    const value = remoteChat(response, chatId); chatRevision = value.revision;
    if (selectedDetail?.id === chatId) { const ids = new Set(value.chat.messages.map(message => message.id)); value.chat.messages = [...selectedDetail.messages.filter(message => !ids.has(message.id)), ...value.chat.messages]; }
    else olderToken = value.before;
    selectedDetail = value.chat; rememberDetail(); state = { ...state, chats: state.chats.map(chat => chat.id === chatId ? { ...chat, ...value.chat } : chat), runs: value.runs, approvals: value.approvals };
    acceptStreams(value); render();
  }
  async function loadOlder() {
    if (!olderToken || loadingOlder || !online) return;
    const token = session, chatId = selectedChatId, before = olderToken; loadingOlder = true; renderStatus();
    try {
      const value = remoteChat(await rpc('chat.read', { chatId, before, limit: 50, ...referenceModes() }), chatId);
      if (token !== session || chatId !== selectedChatId || before !== olderToken) return;
      const ids = new Set(selectedDetail.messages.map(message => message.id)); selectedDetail = { ...selectedDetail, messages: [...value.chat.messages.filter(message => !ids.has(message.id)), ...selectedDetail.messages] };
      olderToken = value.before; rememberDetail(); state.chats = state.chats.map(chat => chat.id === chatId ? { ...chat, messages: selectedDetail.messages } : chat); renderTranscript();
    } finally { if (token === session) { loadingOlder = false; renderStatus(); } }
  }
  async function loadDirectory(id, force = false) {
    if (directoryLoads.has(id)) return directoryLoads.get(id);
    if (!getDevices().some(device => device.id === id && (device.online || force))) return directories.get(id);
    const task = (async () => {
      const cached = directories.get(id), response = await request('remote.request', { deviceId: id, method: 'workspace.list', params: { limit: 200, ...(cached?.revision ? { since: cached.revision } : {}) } });
      if (response?.unchanged === true) { if (!cached) throw new Error('The host returned no saved directory.'); const value = { ...cached, ...(response.capabilities ? { capabilities: { imageReferences: response.capabilities.imageReferences === true, mediaReferences: response.capabilities.mediaReferences === true, steering: response.capabilities.steering === true } } : {}), error: '' }; directories.set(id, value); return value; }
      const value = remoteWorkspace(response), projects = new Map(value.projects.map(project => [project.id, project])), chats = new Map(value.chats.map(chat => [chat.id, chat])); let offset = value.nextOffset;
      const offsets = new Set();
      while (offset !== null && offset !== undefined) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offsets.has(offset)) throw new Error('The host returned invalid workspace pagination.'); offsets.add(offset);
        const page = remoteWorkspace(await request('remote.request', { deviceId: id, method: 'workspace.list', params: { offset, limit: 200 } }));
        if (value.revision && page.revision !== value.revision) throw new Error('The host directory changed while loading. Retry to load its current chats.');
        for (const project of page.projects) projects.set(project.id, project); for (const chat of page.chats) chats.set(chat.id, chat); offset = page.nextOffset;
      }
      const directory = { ...value, projects: [...projects.values()], chats: [...chats.values()], error: '' }; if (getDevices().some(device => device.id === id)) directories.set(id, directory); return directory;
    })();
    directoryLoads.set(id, task);
    try { return await task; }
    catch (error) { if (getDevices().some(device => device.id === id)) directories.set(id, { ...directories.get(id), error: error.message || String(error) }); throw error; }
    finally { if (directoryLoads.get(id) === task) directoryLoads.delete(id); renderNavigation(); }
  }
  async function syncDirectories() {
    clearTimeout(directoryTimer); if (disposed) return;
    const paired = new Set(getDevices().map(device => device.id)); for (const id of directories.keys()) if (!paired.has(id)) directories.delete(id);
    for (const cache of [details, imageCache]) for (const key of cache.keys()) if (!paired.has(JSON.parse(key)[0])) cache.delete(key);
    await Promise.allSettled(getDevices().filter(device => device.online).map(device => loadDirectory(device.id)));
    if (disposed) return; renderNavigation();
    if (getDevices().length) { directoryTimer = setTimeout(syncDirectories, 8000); directoryTimer.unref?.(); }
  }
  async function reload(token = session, read = true) {
    if (!online && !connecting || root.hidden) return;
    const value = await loadDirectory(deviceId, true); if (token !== session || !value?.projects) return;
    online = true; connecting = false;
    state = { ...state, projects: value.projects, chats: value.chats.map(chat => chat.id === selectedDetail?.id ? { ...chat, messages: selectedDetail.messages, inbox: selectedDetail.inbox } : chat) };
    if (selectedChatId && !state.chats.some(chat => chat.id === selectedChatId)) { saveDraft(); selectedChatId = null; selectedDetail = undefined; prompt.value = drafts.get(key()) || ''; }
    if (!state.projects.some(project => project.id === selectedProjectId)) selectedProjectId = state.projects.find(project => !project.archived)?.id || state.projects[0]?.id;
    render(); if (read) await readChat(token);
  }
  async function poll() {
    if (root.hidden || polling) return;
    const token = session;
    const task = reload(token, false); polling = task;
    try { await task; if (token === session) { lastError = ''; renderStatus(); } } catch (error) { if (token === session) disconnect(error); }
    finally { if (polling === task) polling = undefined; if (!root.hidden && token === session) timer = setTimeout(poll, 8000); }
  }
  async function pollChat(token = session, generation = chatGeneration) {
    if (root.hidden || token !== session || generation !== chatGeneration || !online || !selectedChatId) return;
    try { await readChat(token, true); }
    catch (error) { if (token === session && generation === chatGeneration) disconnect(error); }
    finally { if (!root.hidden && token === session && generation === chatGeneration && online) chatTimer = setTimeout(() => pollChat(token, generation), 300); }
  }
  async function selectChat(chatId, projectId = selectedProjectId) {
    saveDraft(); clearTimeout(chatTimer); ++chatGeneration; resetImages(); selectedChatId = chatId; olderToken = chatRevision = undefined; modelPanel.hidden = true; selectedProjectId = currentChat()?.projectId || projectId; selectedDetail = details.get(key()); ++readSequence;
    if (selectedDetail) state.chats = state.chats.map(chat => chat.id === chatId ? { ...chat, ...selectedDetail } : chat);
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
  async function submit(steerNow = false) {
    const submitted = prompt.value, draft = key(), files = [...attachments.get(draft)], token = session, target = deviceId, projectId = selectedProjectId;
    if ((!submitted.trim() && !files.length) || files.some(item => item.pending) || pending || !online || prompt.disabled) return;
    const run = steerNow ? latestRun(state, selectedChatId) : undefined;
    if (steerNow && (!isActive(run) || !directories.get(target)?.capabilities?.steering)) { setError('The host has no active task available to steer. Your draft is kept.'); return; }
    pending = true; renderStatus();
    try {
      let chatId = selectedChatId;
      if (!chatId) { const chat = await rpc('chat.create', { projectId }, target); if (token !== session) return; if (!chat || typeof chat.id !== 'string') throw new Error('The host returned an invalid new chat.'); chatId = chat.id; }
      const images = files.filter(item => item.image).map(item => item.image);
      const params = { chatId, text: attachmentMessage(submitted, files), ...(images.length ? { images } : {}) };
      if (steerNow) {
        const correction = correctionRequest(pendingCorrections.get(draft), run.id, params.text, files);
        pendingCorrections.set(draft, correction);
        await rpc('chat.steer', { ...params, runId: run.id, correctionId: correction.correctionId }, target);
      } else await rpc('chat.send', params, target);
      pendingCorrections.delete(draft);
      if (drafts.get(draft) === submitted) drafts.delete(draft); attachments.remove(draft, files.map(item => item.id));
      if (token === session) { if (key() === draft && prompt.value === submitted) prompt.value = ''; lastError = ''; await reload(token); if (key() === draft && !selectedChatId) await selectChat(chatId, projectId); }
    } catch (error) { if (token === session) setError(error); }
    finally { if (token === session) { pending = false; render(); prompt.focus(); } onChange(); }
  }
  function open(id, chatId, projectId) {
    if (!getDevices().some(device => device.id === id)) return;
    suspendLocal(); document.body.classList.remove('sidebar-open');
    if (!root.hidden && id === deviceId) { if (chatId !== undefined) return selectChat(chatId, projectId); return; }
    saveDraft(); clearTimeout(timer); clearTimeout(chatTimer); ++session; ++chatGeneration; resetImages(); polling = undefined; deviceId = id; online = currentDevice()?.online === true; connecting = online; pending = false; lastError = ''; modelPanel.hidden = true; chatRevision = olderToken = undefined; streamVersion = -1; streams.clear(); state = { projects: [], chats: [], runs: [], approvals: [], ...directories.get(id) };
    ({ selectedChatId, selectedProjectId } = selections.get(id) || {}); if (chatId !== undefined) { selectedChatId = chatId; selectedProjectId = projectId; } selectedProjectId = state.chats.find(chat => chat.id === selectedChatId)?.projectId || selectedProjectId || state.projects.find(project => !project.archived)?.id;
    selectedDetail = details.get(key()); if (selectedDetail) state.chats = state.chats.map(chat => chat.id === selectedChatId ? { ...chat, ...selectedDetail } : chat);
    prompt.value = drafts.get(key()) || ''; returnFocus ||= document.activeElement; root.hidden = false; document.body.classList.add('remote-open'); render(); prompt.focus(); const token = session; void poll().then(() => { if (token === session) void pollChat(token); }); onChange();
  }
  function reconnect() { clearTimeout(timer); clearTimeout(chatTimer); ++session; ++chatGeneration; polling = undefined; connecting = true; online = false; pending = false; lastError = ''; renderStatus(); const token = session; return poll().then(() => { if (token === session) void pollChat(token); }); }
  function close() { if (root.hidden) return; saveDraft(); clearTimeout(timer); clearTimeout(chatTimer); ++session; ++chatGeneration; ++readSequence; resetImages(); liveTranscript.reset(); transcriptIdentity=undefined; transcript.replaceChildren(); messageNodes.clear(); activity.reset(); pending = false; selections.set(deviceId, { selectedChatId, selectedProjectId }); root.hidden = true; document.body.classList.remove('remote-open'); renderNavigation(); returnFocus?.focus(); returnFocus = undefined; onChange(); }
  function updateDevices() {
    void syncDirectories(); renderNavigation(); if (root.hidden) return; if (!currentDevice()) { close(); return; } if (connecting) return;
    const wasOnline = online; online = currentDevice()?.online === true; if (wasOnline && !online) { clearTimeout(timer); clearTimeout(chatTimer); ++session; ++chatGeneration; pending = false; resetMedia(); renderTranscript(); } renderStatus(); renderApprovals(); if (!wasOnline && online) { clearTimeout(timer); clearTimeout(chatTimer); void poll(); void pollChat(); }
  }
  subscribe?.(envelope => {
    const event = remoteEvent(envelope, deviceId); if (!event || root.hidden || !online) return;
    if (['delta', 'progress'].includes(event.type) && Number.isSafeInteger(event.streamSequence) && Number.isSafeInteger(event.sequence) && typeof event.runId === 'string' && (event.type !== 'delta' || typeof event.text === 'string')) { acceptStreams(event); renderLive(); }
    else if (['state', 'approval'].includes(event.type)) { clearTimeout(timer); void poll(); }
  });
  archiveInput.addEventListener('change', () => { renderNavigation(); if (!archiveInput.checked && (currentChat()?.archived || currentProject()?.archived)) void selectChat(null, state.projects.find(project => !project.archived)?.id); });
  hostSelect.addEventListener('change', () => hostSelect.value ? open(hostSelect.value) : close());
  picker.addEventListener('cancel', () => { pickerKey = undefined; onChange(); });
  picker.addEventListener('change', event => { const draft = pickerKey || key(), files = [...(event.target.files || [])]; pickerKey = undefined; event.target.value = ''; void attachments.add(draft, files).catch(error => { if (draft === key()) setError(error); }); });
  prompt.addEventListener('paste', event => { const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean); if (!files.length) return; if (!event.clipboardData.getData('text/plain')) event.preventDefault(); const draft = key(); void attachments.add(draft, files).catch(error => { if (draft === key()) setError(error); }); });
  prompt.addEventListener('input', () => { saveDraft(); renderStatus(); onChange(); }); composer.addEventListener('submit', event => { event.preventDefault(); void submit(); });
  prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); } });
  root.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); event.stopPropagation(); void createChat(); } });
  return { open, close, updateDevices, newChat: createChat, dispose: () => { disposed = true; close(); clearTimeout(directoryTimer); }, isOpen: () => !root.hidden, hasDrafts, clearDrafts: () => { drafts.clear(); attachments.restore([]); prompt.value = ''; renderStatus(); onChange(); }, refreshReason: () => !root.hidden || hasDrafts() || pickerKey ? 'Return to this PC and send or clear remote drafts before refreshing the interface.' : '' };
}
