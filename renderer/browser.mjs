import { safeImage } from './ui-helpers.mjs';

export function browserAddress(value) {
  const text = String(value).trim();
  if (!text) throw new Error('Enter an address or search.');
  let address;
  if (/^https?:\/\//i.test(text)) address = text;
  else if (!/\s/.test(text) && /^(?:localhost|[\w-]+(?:\.[\w-]+)+|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(text)) address = `https://${text}`;
  else if (/^[a-z][\w+.-]*:/i.test(text)) throw new Error('Only HTTP and HTTPS websites can be opened.');
  else return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  const url = new URL(address);
  if (url.username || url.password) throw new Error('Website addresses cannot contain embedded credentials.');
  return url.href;
}

export function browserPaneWidth(available, preferred) {
  const space = Math.max(0, Number.isFinite(available) ? available : 0);
  const min = Math.min(320, space / 2), max = Math.max(min, space - Math.min(360, space / 2));
  return { min: Math.round(min), max: Math.round(max), width: Math.round(Math.max(min, Math.min(max, Number.isFinite(preferred) && preferred > 0 ? preferred : space / 3))) };
}

export function browserViewBounds(rect, viewport, clips = []) {
  if (!rect || ![rect.left, rect.top, rect.width, rect.height, viewport?.width, viewport?.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) return null;
  const right = rect.left + rect.width, bottom = rect.top + rect.height;
  if ([{ left: 0, top: 0, width: viewport.width, height: viewport.height }, ...clips].some(clip => rect.left < clip.left - .5 || rect.top < clip.top - .5 || right > clip.left + clip.width + .5 || bottom > clip.top + clip.height + .5)) return null;
  const x = Math.ceil(rect.left), y = Math.ceil(rect.top);
  return { x, y, width: Math.floor(right) - x, height: Math.floor(bottom) - y };
}

export function createBrowserPanel({ request, subscribe, getChat, getChats, el, button, document = globalThis.document, window = globalThis.window, storage }) {
  let browser = { sessions: [], bookmarks: [], history: [], downloads: [] }, selected = '', frame, visible = false, dirtyURL = false, urlRevision = 0, eventVersion = 0, generation = 0, optionsKey = '', tabKey = '', openingChatId, openingOperation, drawerName = '', resizing, preferredWidth, viewKey = '', lastView, scheduled = false, surfaceError = '', lastOutsideFocus = document.activeElement, returnFocus, focusRevision = 0, chromeKey = '';
  try { preferredWidth = Number((storage || window.localStorage).getItem('faber.browserWidth')) || undefined; } catch { /* Browser width is optional local UI state. */ }
  const toggle = document.querySelector('#toggle-browser'), shell = document.querySelector('.shell');
  const divider = el('div', 'browser-divider'); divider.id = 'browser-divider'; divider.hidden = true; divider.tabIndex = 0; divider.setAttribute('role', 'separator'); divider.setAttribute('aria-orientation', 'vertical'); divider.setAttribute('aria-label', 'Resize browser pane');
  const panel = el('aside', 'browser-panel'); panel.id = 'browser-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Chromium browser');
  const tabbar = el('div', 'browser-tabbar');
  const selector = el('select', 'browser-session'); selector.id = 'browser-session'; selector.setAttribute('aria-label', 'Browser chat');
  const tabNodes = new Map();
  const tabs = el('div', 'browser-tabs'); tabs.id = 'browser-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Browser tabs');
  const newTab = control('+', 'New tab', () => invoke('browser.newTab'), 'browser-new-tab');
  const hide = control('×', 'Hide browser', () => show(false), 'browser-hide');
  tabbar.append(selector, tabs, newTab, hide); panel.append(tabbar);
  const form = el('form', 'browser-navigation'); form.id = 'browser-navigation';
  const back = control('←', 'Back', () => invoke('browser.back'), 'browser-back'), forward = control('→', 'Forward', () => invoke('browser.forward'), 'browser-forward');
  const reload = control('↻', 'Reload page', () => invoke('browser.reload'), 'browser-reload'), stop = control('×', 'Stop loading', () => invoke('browser.stop'), 'browser-stop');
  const address = el('div', 'browser-address'); const security = el('span', 'browser-security'); security.id = 'browser-security';
  const url = el('input'); url.id = 'browser-url'; url.type = 'text'; url.inputMode = 'url'; url.placeholder = 'Search Google or enter address'; url.autocomplete = 'off'; url.spellcheck = false; url.setAttribute('aria-label', 'Search Google or enter website address');
  const go = el('button', 'browser-go', '↵'); go.id = 'browser-go'; go.type = 'submit'; go.setAttribute('aria-label', 'Open address or search'); address.append(security, url, go);
  const bookmark = control('☆', 'Bookmark this page', toggleBookmark, 'browser-bookmark');
  const takeover = control('Take over', 'Take control of this browser and pause agents', () => invoke('browser.takeover'), 'browser-takeover', 'browser-ownership');
  const resume = control('Resume browsing', 'Allow agents to read and control this browser again', () => invoke('browser.resume'), 'browser-resume', 'browser-ownership');
  const menu = control('⋯', 'Browser history, bookmarks and downloads', () => showDrawer(drawerName === 'menu' ? '' : 'menu'), 'browser-menu'); menu.setAttribute('aria-expanded', 'false');
  form.append(back, forward, reload, stop, address, bookmark, takeover, resume, menu); panel.append(form);
  const statusbar = el('div', 'browser-statusbar'), title = el('span', 'browser-title'); title.id = 'browser-title';
  const status = el('span', 'browser-status'); status.id = 'browser-status'; status.setAttribute('role', 'status'); statusbar.append(title, status); panel.append(statusbar);
  const error = el('p', 'browser-error'); error.id = 'browser-error'; error.hidden = true; error.setAttribute('role', 'alert'); panel.append(error);
  const page = el('div', 'browser-page-slot'); page.id = 'browser-page-slot'; page.setAttribute('aria-label', 'Browser page');
  const image = el('img', 'browser-frame'); image.id = 'browser-frame'; image.hidden = true; image.draggable = false; image.alt = 'Live agent browser preview. Choose Take over for direct page interaction.';
  const empty = el('div', 'browser-empty'); page.append(image, empty); panel.append(page);
  const findbar = el('form', 'browser-find'); findbar.id = 'browser-find'; findbar.hidden = true;
  const findText = el('input'); findText.id = 'browser-find-text'; findText.maxLength = 300; findText.setAttribute('aria-label', 'Find in page'); findText.placeholder = 'Find in page';
  const findResult = el('span', 'browser-find-result'); findResult.id = 'browser-find-result'; findResult.setAttribute('role', 'status');
  const findPrevious = control('↑', 'Previous match', () => findPage(false, true), 'browser-find-previous'), findNext = control('↓', 'Next match', () => findPage(true, true), 'browser-find-next');
  const closeFind = control('×', 'Close find in page', () => { findbar.hidden = true; hideSurface(); void invoke('browser.stopFind'); scheduleSurface(); }, 'browser-find-close');
  findbar.append(findText, findResult, findPrevious, findNext, closeFind); panel.insertBefore(findbar, page);
  const drawer = el('section', 'browser-drawer'); drawer.id = 'browser-library'; drawer.hidden = true; drawer.setAttribute('data-browser-occludes', ''); drawer.setAttribute('aria-label', 'Browser library'); panel.append(drawer);
  const drawerHeading = el('div', 'browser-drawer-heading'), drawerTitle = el('h2'); drawerHeading.append(drawerTitle, control('×', 'Close browser panel', () => showDrawer(''), '', 'browser-icon'));
  const libraryTabs = el('nav', 'browser-library-tabs');
  for (const name of ['history', 'bookmarks', 'downloads']) { const item = button(name[0].toUpperCase() + name.slice(1), () => showDrawer(name), 'browser-library-tab'); item.id = `browser-${name}`; libraryTabs.append(item); }
  const libraryInfo = el('p', 'hint', 'Tabs, website sign-ins, history and bookmarks are kept on this PC.');
  const libraryList = el('div', 'browser-library-list'), libraryRows = new Map();
  const clearHistory = button('Clear history', () => invoke('browser.clearHistory'), 'button'); clearHistory.id = 'browser-clear-history';
  const tools = el('div', 'browser-menu-tools');
  const findButton = button('Find in page', openFind, 'button'); findButton.id = 'browser-find-open';
  const zoomRow = el('div', 'browser-zoom'); const zoomOut = control('−', 'Zoom out', () => zoomPage(-.1), 'browser-zoom-out'), zoomIn = control('+', 'Zoom in', () => zoomPage(.1), 'browser-zoom-in');
  const zoomLabel = el('span'); zoomLabel.id = 'browser-zoom-label'; const zoomReset = button('Reset', () => invoke('browser.zoom', { factor: 1 }), 'button'); zoomReset.id = 'browser-zoom-reset'; zoomRow.append(zoomOut, zoomLabel, zoomIn, zoomReset); tools.append(findButton, zoomRow);
  drawer.append(drawerHeading, libraryTabs, libraryInfo, tools, libraryList, clearHistory);
  shell.append(divider, panel);
  const session = () => browser.sessions.find(item => item.chatId === selected);
  const active = () => session()?.tabs?.find(item => item.id === session().activeTabId);
  const targetId = () => selected || getChat()?.id;
  function control(text, label, callback, id, className = 'browser-icon') { const item = button(text, callback, className); item.id = id; item.setAttribute('aria-label', label); item.title = label; return item; }
  function fail(cause) { error.textContent = cause?.message || String(cause); error.hidden = false; }
  function clearFrame() { generation++; frame = undefined; image.hidden = true; image.removeAttribute('src'); }
  function show(open) { if (!open) hideSurface(); visible = open; panel.hidden = divider.hidden = !open; document.body.classList.toggle('browser-open', open); toggle.setAttribute('aria-expanded', String(open)); render(); if (open) void loadFrame(); }
  function choose(id, preserveDraft = false) { if (selected !== id) { hideSurface(); clearFrame(); selected = id; if (!preserveDraft) dirtyURL = false; tabKey = ''; } render(); if (visible) void loadFrame(); }
  function widthBounds() { const shellWidth = shell.getBoundingClientRect().width; const sidebar = document.querySelector('#sidebar'); const sidebarWidth = sidebar && window.getComputedStyle(sidebar).display !== 'none' ? sidebar.getBoundingClientRect().width : 0; return browserPaneWidth(shellWidth - sidebarWidth - 6, preferredWidth); }
  function sizePane() { const headerHeight = document.querySelector('.workspace-header')?.getBoundingClientRect().height; if (Number.isFinite(headerHeight) && headerHeight > 0) panel.style.setProperty('--browser-header-height', `${headerHeight}px`); const bounds = widthBounds(); panel.style.width = `${bounds.width}px`; divider.setAttribute('aria-valuemin', String(bounds.min)); divider.setAttribute('aria-valuemax', String(bounds.max)); divider.setAttribute('aria-valuenow', String(bounds.width)); divider.setAttribute('aria-valuetext', `${bounds.width} pixels wide`); }
  function saveWidth() { try { (storage || window.localStorage).setItem('faber.browserWidth', String(preferredWidth)); } catch { /* Keep resizing usable without local storage. */ } }
  function syncChromeFocus(force = false) { const tab = active(), activeChrome = visible && !document.querySelector('#modal')?.open && !document.body.classList.contains('models-open') && !document.body.inert && panel.contains(document.activeElement) && Boolean(targetId()); const params = { active: activeChrome, ...(activeChrome ? { chatId: targetId(), ...(tab ? { tabId: tab.id } : {}) } : {}) }; const key = JSON.stringify(params); if (force || key !== chromeKey) { chromeKey = key; void request('browser.chromeFocus', params).catch(() => { chromeKey = ''; }); } }
  function hideSurface() { const chatId = lastView?.chatId || targetId(); if (chatId) sendView({ chatId, visible: false }); }
  function sendView(next) { const key = JSON.stringify([next, next.visible ? session()?.mode : null]); if (key === viewKey) return; viewKey = key; lastView = next; void request('browser.view', next).then(() => { surfaceError = ''; }).catch(cause => { if (viewKey === key) { viewKey = ''; surfaceError = cause.message || String(cause); empty.textContent = surfaceError; } }); }
  function syncSurface() {
    syncChromeFocus();
    const current = session(), tab = active();
    const blocked = !visible || resizing || drawerName || !current || !tab || tab.loaded === false || document.hidden || document.body.inert || document.documentElement.dataset.uiRefreshing === 'true' || document.querySelector('#modal')?.open || document.body.classList.contains('models-open');
    const rect = page.getBoundingClientRect(), clips = [];
    for (let node = page.parentElement; node && node !== document.body; node = node.parentElement) { const style = window.getComputedStyle(node); if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) clips.push(node.getBoundingClientRect()); }
    const bounds = blocked ? null : browserViewBounds(rect, { width: window.innerWidth, height: window.innerHeight }, clips);
    if (bounds) sendView({ chatId: current.chatId, tabId: tab.id, visible: true, ...bounds }); else hideSurface();
  }
  function scheduleSurface() { if (scheduled) return; scheduled = true; (window.requestAnimationFrame || (callback => setTimeout(callback, 0)))(() => { scheduled = false; sizePane(); syncSurface(); }); }
  function render() {
    const current = session(), tab = active(), chat = getChat();
    const choices = browser.sessions.map(item => [item.chatId, getChats().find(chat => chat.id === item.chatId)?.title || 'Chat browser']);
    const key = JSON.stringify([chat?.id, chat?.title, choices]);
    if (key !== optionsKey) { optionsKey = key; selector.replaceChildren(); if (!browser.sessions.some(item => item.chatId === chat?.id)) { const option = el('option', '', chat?.title || 'Choose chat'); option.value = ''; selector.append(option); } for (const [id, name] of choices) { const option = el('option', '', name); option.value = id; selector.append(option); } }
    selector.value = selected; selector.disabled = false;
    const nextTabKey = `${selected}:${tab?.id || ''}`;
    if (nextTabKey !== tabKey) { tabKey = nextTabKey; clearFrame(); hideSurface(); }
    if (!dirtyURL) url.value = tab?.url && tab.url !== 'about:blank' ? tab.url : '';
    url.disabled = go.disabled = newTab.disabled = !targetId();
    const tabIds = new Set((current?.tabs || []).map(item => `${selected}:${item.id}`));
    for (const [id, entry] of tabNodes) if (!tabIds.has(id)) { entry.row.remove(); tabNodes.delete(id); }
    for (const [index, item] of (current?.tabs || []).entries()) {
      const id = `${selected}:${item.id}`; let entry = tabNodes.get(id);
      if (!entry) {
        const row = el('div', 'browser-tab');
        const select = control('', '', () => invoke('browser.selectTab', { tabId: item.id }), '', 'browser-tab-select'); select.dataset.browserTab = item.id; select.setAttribute('role', 'tab');
        select.addEventListener('keydown', event => { const list = session()?.tabs || [], position = list.findIndex(candidate => candidate.id === item.id); let target; if (event.key === 'ArrowRight') target = list[(position + 1) % list.length]; if (event.key === 'ArrowLeft') target = list[(position - 1 + list.length) % list.length]; if (event.key === 'Home') target = list[0]; if (event.key === 'End') target = list.at(-1); if (target) { event.preventDefault(); void invoke('browser.selectTab', { tabId: target.id }).then(() => { if (document.activeElement === select) tabNodes.get(`${selected}:${target.id}`)?.select.focus(); }); } });
        const close = control('×', '', () => invoke('browser.closeTab', { tabId: item.id }), '', 'browser-tab-close'); close.dataset.browserCloseTab = item.id; row.append(select, close);
        entry = { row, select, close }; tabNodes.set(id, entry);
      }
      entry.row.classList.toggle('selected', item.id === tab?.id);
      const label = item.title || (item.url === 'about:blank' ? 'New tab' : item.url) || 'New tab';
      entry.select.textContent = label; entry.select.title = label; entry.select.setAttribute('aria-label', label); entry.select.setAttribute('aria-selected', String(item.id === tab?.id)); entry.select.tabIndex = item.id === tab?.id ? 0 : -1;
      entry.close.setAttribute('aria-label', `Close ${item.title || 'tab'}`);
      if (tabs.children[index] !== entry.row) tabs.insertBefore(entry.row, tabs.children[index] || null);
    }
    back.disabled = !tab?.canGoBack; forward.disabled = !tab?.canGoForward; reload.hidden = Boolean(tab?.loading); reload.disabled = !tab; stop.hidden = !tab?.loading; stop.disabled = !tab?.loading;
    title.textContent = tab?.title || 'New tab'; title.title = tab?.url || '';
    const human = current?.mode === 'human'; if (!human) findbar.hidden = true;
    takeover.hidden = human && tab?.loaded !== false; takeover.disabled = !tab;
    resume.hidden = !human; resume.disabled = false;
    status.textContent = human ? 'You have control · Agent browsing paused' : tab?.loading ? 'Loading…' : tab ? 'Agents can use this browser' : 'Tabs and sign-ins are remembered';
    try { const parsed = new URL(tab?.url); security.textContent = parsed.protocol === 'https:' ? 'HTTPS' : parsed.protocol === 'http:' ? 'Not secure' : ''; } catch { security.textContent = ''; }
    security.title = tab?.url || ''; bookmark.disabled = !/^https?:\/\//.test(tab?.url || ''); bookmark.textContent = browser.bookmarks.some(item => item.url === tab?.url) ? '★' : '☆';
    if (human) image.hidden = true;
    empty.hidden = !image.hidden && !human;
    empty.textContent = !tab ? 'Open an address or add a tab.' : human ? tab.loaded === false ? 'Your saved tab is paused. Choose Take over to open it, or Resume browsing to return control.' : surfaceError || 'Your page opens here. Agents cannot read or control it until you choose Resume browsing.' : tab.loading ? 'Loading page…' : 'Agent browser preview · Take over to use the page directly.';
    toggle.classList.toggle('selected', visible); toggle.title = `${browser.sessions.reduce((count, item) => count + (item.tabs?.length || 0), 0)} browser tabs`;
    if (tab?.error) fail(tab.error);
    renderDrawer(); sizePane(); scheduleSurface();
  }
  function accept(next) {
    const previous = new Set(browser.sessions.map(item => item.chatId)), old = session(), oldTab = active();
    browser = { sessions: [], bookmarks: [], history: [], downloads: [], ...next };
    const created = browser.sessions.filter(item => !previous.has(item.chatId));
    if (selected && !session()) { hideSurface(); selected = browser.sessions.find(item => item.chatId === getChat()?.id)?.chatId || browser.sessions[0]?.chatId || ''; dirtyURL = false; clearFrame(); }
    if (created.length) { const opened = created.find(item => item.chatId === openingChatId); if (opened || (!openingChatId && !dirtyURL && session()?.mode !== 'human' && !drawerName)) choose(opened?.chatId || created.at(-1).chatId, Boolean(opened)); show(true); }
    else if (!openingChatId && !selected && browser.sessions.length && !dirtyURL) choose(browser.sessions.find(item => item.chatId === getChat()?.id)?.chatId || browser.sessions[0].chatId);
    const tab = active();
    const oldViewport = oldTab?.viewport || old?.viewport, nextViewport = tab?.viewport || session()?.viewport;
    if (old && session() && (oldViewport?.width !== nextViewport?.width || oldViewport?.height !== nextViewport?.height || old.mode !== session().mode || oldTab?.id !== tab?.id || oldTab?.url !== tab?.url || oldTab?.updatedAt !== tab?.updatedAt || (!oldTab?.loading && tab?.loading))) clearFrame();
    render(); if (visible && tab && session().mode !== 'human' && !frame && !tab.loading) void loadFrame();
  }
  function acceptFrame(value) {
    const current = session(), tab = active(), viewport = tab?.viewport || current?.viewport;
    if (!visible || !tab || !viewport || value?.width !== viewport.width || value?.height !== viewport.height || current.mode === 'human' || tab.loading || value?.chatId !== selected || value.tabId !== tab.id || value.url !== tab.url || !safeImage(value.image) || !value.frameId || !Number.isSafeInteger(value.sequence) || value.sequence <= (frame?.sequence ?? -1)) return;
    frame = value; image.src = value.image; image.hidden = false; render();
  }
  async function loadFrame() {
    const current = session(), tab = active(); if (!visible || !tab || current.mode === 'human' || tab.loading || tab.loaded === false) return;
    const id = selected, tabId = tab.id, version = generation;
    try { const value = await request('browser.frame', { chatId: id, tabId }); if (version === generation && id === selected && active()?.id === tabId) acceptFrame(value); } catch { /* A superseded observation is replaced by the next live frame or real tab error. */ }
  }
  async function refresh() { const version = eventVersion; const next = await request('browser.state'); if (version === eventVersion) accept(next); }
  async function invoke(method, args = {}) {
    const global = ['browser.bookmark', 'browser.removeBookmark', 'browser.clearHistory', 'browser.cancelDownload'].includes(method);
    if (!global && !targetId()) return;
    const chatId = args.chatId || targetId(), open = ['browser.open', 'browser.newTab'].includes(method);
    const params = global ? args : { chatId, ...(!['browser.newTab', 'browser.resume'].includes(method) && active() ? { tabId: active().id } : {}), ...args };
    const operation = {}, revision = urlRevision, focusAtStart = focusRevision, restore = method === 'browser.resume' ? { target: returnFocus, revision: focusRevision } : null;
    const navigation = ['browser.open', 'browser.navigate', 'browser.newTab', 'browser.selectTab', 'browser.back', 'browser.forward', 'browser.reload'].includes(method) || (method === 'browser.closeTab' && args.tabId === active()?.id);
    if (method === 'browser.takeover' || (['browser.open', 'browser.navigate', 'browser.newTab', 'browser.selectTab', 'browser.back', 'browser.forward', 'browser.reload', 'browser.closeTab', 'browser.stop'].includes(method) && session()?.mode !== 'human')) returnFocus = lastOutsideFocus;
    if (navigation && !['browser.open', 'browser.navigate'].includes(method)) dirtyURL = false;
    if (navigation || method === 'browser.takeover') showDrawer('');
    if (open) { openingChatId = chatId; openingOperation = operation; } error.hidden = true; hideSurface(); render();
    try { const result = await request(method, params); if (navigation && revision === urlRevision) dirtyURL = false; await refresh(); if (open && openingOperation === operation && browser.sessions.some(item => item.chatId === chatId)) choose(chatId, true); if (method === 'browser.newTab' && focusAtStart === focusRevision && document.hasFocus?.() !== false) { url.focus({ preventScroll: true }); url.select(); } if (restore?.target?.isConnected && restore.revision === focusRevision && document.hasFocus?.() !== false && (document.activeElement === resume || document.activeElement === document.body)) restore.target.focus({ preventScroll: true }); return result || true; }
    catch (cause) { fail(cause); return false; }
    finally { if (open && openingOperation === operation) { openingChatId = undefined; openingOperation = undefined; } render(); }
  }
  function navigate(value) { try { const address = browserAddress(value); showDrawer(''); return invoke(active() ? 'browser.navigate' : 'browser.open', { url: address }); } catch (cause) { fail(cause); } }
  function toggleBookmark() { const tab = active(), existing = browser.bookmarks.find(item => item.url === tab?.url); return existing ? invoke('browser.removeBookmark', { id: existing.id }) : invoke('browser.bookmark', { url: tab.url, title: tab.title }); }
  function showDrawer(name) { hideSurface(); drawerName = name; drawer.hidden = !name; menu.setAttribute('aria-expanded', String(Boolean(name))); renderDrawer(); scheduleSurface(); }
  function renderDrawer() {
    if (!drawerName) return;
    drawerTitle.textContent = drawerName === 'menu' ? 'Browser' : drawerName[0].toUpperCase() + drawerName.slice(1);
    libraryInfo.hidden = tools.hidden = drawerName !== 'menu'; libraryList.hidden = drawerName === 'menu';
    const human = session()?.mode === 'human' && active()?.loaded !== false;
    findButton.disabled = zoomOut.disabled = zoomIn.disabled = zoomReset.disabled = !human; zoomLabel.textContent = `${Math.round((active()?.zoomFactor || 1) * 100)}%`;
    clearHistory.hidden = drawerName !== 'history' || !browser.history.length;
    const items = drawerName === 'menu' ? [] : browser[drawerName];
    const ids = new Set(items.map(item => `${drawerName}:${item.id}`));
    for (const [id, entry] of libraryRows) if (!ids.has(id)) { entry.row.remove(); libraryRows.delete(id); }
    for (const [index, item] of items.entries()) {
      const id = `${drawerName}:${item.id}`; let entry = libraryRows.get(id);
      if (!entry) {
        const row = el('div', 'browser-library-item'), name = el('strong'), detail = el('small'); entry = { row, name, detail, item };
        if (drawerName === 'downloads') {
          const info = el('div'); info.append(name, detail);
          entry.save = button('Save…', () => invoke('browser.download', { chatId: entry.item.chatId, tabId: entry.item.tabId, url: entry.item.url }), 'button'); entry.save.dataset.browserSave = item.id;
          entry.cancel = button('Cancel', () => invoke('browser.cancelDownload', { id: entry.item.id }), 'button'); entry.cancel.dataset.browserCancel = item.id;
          row.append(info, entry.save, entry.cancel);
        } else {
          const link = button('', () => navigate(entry.item.url), 'browser-library-link'); link.append(name, detail); row.append(link);
          if (drawerName === 'bookmarks') { const remove = control('×', 'Remove bookmark', () => invoke('browser.removeBookmark', { id: entry.item.id }), '', 'browser-icon'); remove.dataset.browserRemoveBookmark = item.id; row.append(remove); }
        }
        libraryRows.set(id, entry);
      }
      entry.item = item; entry.name.textContent = item.filename || item.title || item.url || 'Download';
      entry.detail.textContent = drawerName === 'downloads' ? `${item.status} · ${item.receivedBytes || 0}${item.totalBytes ? ` / ${item.totalBytes}` : ''} bytes` : item.url;
      if (entry.save) { entry.save.hidden = item.status !== 'pending'; entry.save.disabled = browser.sessions.find(group => group.chatId === item.chatId)?.mode !== 'human'; entry.save.title = entry.save.disabled ? 'Take over this download’s browser before saving' : 'Choose where to save this file'; entry.cancel.hidden = !['progressing', 'downloading'].includes(item.status); }
      if (libraryList.children[index] !== entry.row) libraryList.insertBefore(entry.row, libraryList.children[index] || null);
    }
  }
  function findPage(forward = true, findNext = false) { if (session()?.mode !== 'human') return; if (findText.value) return invoke('browser.find', { text: findText.value, forward, findNext }); findResult.textContent = ''; return invoke('browser.stopFind'); }
  function openFind() { if (session()?.mode !== 'human' || active()?.loaded === false) return; showDrawer(''); hideSurface(); findbar.hidden = false; findText.focus({ preventScroll: true }); findText.select(); scheduleSurface(); }
  function zoomPage(change) { return invoke('browser.zoom', { factor: Math.max(.25, Math.min(3, Math.round(((active()?.zoomFactor || 1) + change) * 100) / 100)) }); }
  function shortcut(action) {
    if (!visible || document.querySelector('#modal')?.open || document.body.classList.contains('models-open')) return;
    const current = session(), list = current?.tabs || [], position = list.findIndex(item => item.id === active()?.id);
    if (action === 'address') { showDrawer(''); url.focus({ preventScroll: true }); url.select(); }
    else if (action === 'newTab') void invoke('browser.newTab');
    else if (action === 'closeTab' && active()) void invoke('browser.closeTab', { tabId: active().id });
    else if (['nextTab', 'previousTab'].includes(action) && list.length) void invoke('browser.selectTab', { tabId: list[(position + (action === 'nextTab' ? 1 : list.length - 1)) % list.length].id });
    else if (action === 'find') openFind(); else if (action === 'zoomIn') void zoomPage(.1); else if (action === 'zoomOut') void zoomPage(-.1); else if (action === 'zoomReset') void invoke('browser.zoom', { factor: 1 });
  }
  function finishResize(save) { if (!resizing) return; if (!save) preferredWidth = resizing.preferred; resizing = undefined; document.body.classList.remove('browser-resizing'); if (save) saveWidth(); sizePane(); viewKey = ''; scheduleSurface(); }
  divider.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); hideSurface(); resizing = { start: event.clientX, width: widthBounds().width, preferred: preferredWidth }; document.body.classList.add('browser-resizing'); divider.setPointerCapture?.(event.pointerId); });
  divider.addEventListener('pointermove', event => { if (!resizing) return; const bounds = widthBounds(); preferredWidth = Math.max(bounds.min, Math.min(bounds.max, resizing.width + resizing.start - event.clientX)); sizePane(); });
  divider.addEventListener('pointerup', () => finishResize(true)); divider.addEventListener('pointercancel', () => finishResize(false)); divider.addEventListener('lostpointercapture', () => finishResize(true));
  divider.addEventListener('keydown', event => { if (event.key === 'Escape' && resizing) { event.preventDefault(); finishResize(false); return; } const bounds = widthBounds(), step = event.shiftKey ? 50 : 20; const next = { ArrowLeft: bounds.width + step, ArrowRight: bounds.width - step, Home: bounds.min, End: bounds.max }[event.key]; if (next !== undefined) { event.preventDefault(); hideSurface(); preferredWidth = Math.max(bounds.min, Math.min(bounds.max, next)); sizePane(); saveWidth(); viewKey = ''; scheduleSurface(); } });
  toggle.addEventListener('click', () => show(!visible)); selector.addEventListener('change', () => { openingChatId = undefined; openingOperation = undefined; error.hidden = true; choose(selector.value); });
  url.addEventListener('input', () => { dirtyURL = true; urlRevision++; }); form.addEventListener('submit', event => { event.preventDefault(); void navigate(url.value); });
  findText.addEventListener('input', () => { void findPage(); }); findbar.addEventListener('submit', event => { event.preventDefault(); void findPage(!event.shiftKey, true); });
  panel.addEventListener('keydown', event => { if (!(event.ctrlKey || event.metaKey) || document.querySelector('#modal')?.open || !panel.contains(document.activeElement)) return; const key = event.key.toLowerCase(), action = { '+': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut', '0': 'zoomReset', l: 'address', t: 'newTab', w: 'closeTab', f: 'find', tab: event.shiftKey ? 'previousTab' : 'nextTab' }[key]; if (action) { event.preventDefault(); event.stopPropagation(); shortcut(action); } });
  document.addEventListener('focusin', event => { if (event.target !== document.body) focusRevision++; if (event.target !== document.body && !panel.contains(event.target)) lastOutsideFocus = event.target; syncChromeFocus(true); });
  image.addEventListener('error', () => { clearFrame(); fail('The browser preview could not be displayed.'); });
  window.addEventListener('resize', scheduleSurface); window.addEventListener('focus', () => { viewKey = ''; chromeKey = ''; scheduleSurface(); }); document.addEventListener('scroll', scheduleSurface, true); document.addEventListener('visibilitychange', scheduleSurface);
  if (window.ResizeObserver) { const observer = new window.ResizeObserver(scheduleSurface); observer.observe(page); observer.observe(shell); }
  if (window.MutationObserver) { const observer = new window.MutationObserver(scheduleSurface); observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'inert'] }); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-refreshing'] }); const modal = document.querySelector('#modal'); if (modal) observer.observe(modal, { attributes: true, attributeFilter: ['open'] }); }
  subscribe?.(event => { if (event.type === 'browser') { eventVersion++; accept(event.state); } else if (event.type === 'browserFrame') acceptFrame(event); else if (event.type === 'browserViewHidden') { viewKey = ''; scheduleSurface(); } else if (event.type === 'browserShortcut' && event.chatId === targetId() && event.tabId === active()?.id) shortcut(event.action); else if (event.type === 'browserFind' && event.chatId === selected && event.tabId === active()?.id) { const result = event.result || {}; findResult.textContent = `${Number.isFinite(result.activeMatchOrdinal) ? result.activeMatchOrdinal : 0} / ${Number.isFinite(result.matches) ? result.matches : 0}`; } });
  render();
  return { root: panel, load: () => refresh().catch(fail), setContext: render, show, suspend: () => { hideSurface(); chromeKey = ''; void request('browser.chromeFocus', { active: false }).catch(() => {}); }, syncSurface: scheduleSurface };
}
