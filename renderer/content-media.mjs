import { safeOutputImage } from './rich-content.mjs';
import { createDocumentPreview } from './document-preview.mjs';

const formats = { 'audio/wav': ['audio', '.wav'], 'audio/mpeg': ['audio', '.mp3'], 'audio/mp4': ['audio', '.m4a'], 'audio/ogg': ['audio', '.ogg'], 'video/mp4': ['video', '.mp4'], 'video/webm': ['video', '.webm'] };
Object.assign(formats,{'application/pdf':['document','.pdf'],'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['document','.docx'],'image/svg+xml':['vector','.svg'],'image/gif':['animation','.gif'],'image/apng':['animation','.apng'],'image/png':['animation','.png']});
export function mediaReferences(value) {
  return (Array.isArray(value) ? value : []).filter(ref => {
    const format = Object.hasOwn(formats, ref?.mimeType) ? formats[ref.mimeType] : null;
    return format && ref.kind === format[0] && typeof ref.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(ref.id) && Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= 512 * 1024 * 1024 && typeof ref.name === 'string' && ref.name.length > 0 && ref.name.length <= 180 && !/[\\/:\u0000-\u001f\u007f]/.test(ref.name) && ref.name.toLowerCase().endsWith(format[1]);
  }).filter(ref=>!['document','vector','animation'].includes(ref.kind)||typeof ref.revision==='string'&&/^[a-f0-9]{64}$/.test(ref.revision)&&ref.bytes<=({document:64*1024*1024,vector:4*1024*1024,animation:16*1024*1024}[ref.kind])).slice(0, 1).map(({ id, kind, mimeType, bytes, name, revision }) => ({ id, kind, mimeType, bytes, name,...(revision?{revision}:{}) }));
}
export function resultMedia(value) {
  try { return mediaReferences([(typeof value === 'string' ? JSON.parse(value) : value)?.media]); } catch { return []; }
}
export function mediaSource(chatId, mediaId, deviceId) {
  return `faber://app/media/${encodeURIComponent(chatId)}/${encodeURIComponent(mediaId)}${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`;
}

export function createMediaOutputs({ request, contentMenu, document = globalThis.document }) {
  const entries = new Map(), owners = new Map();
  let available = true;
  const track = context => { if (context?.chatId) owners.set(JSON.stringify([context.deviceId, context.chatId]), { chatId: context.chatId, ...(context.deviceId ? { deviceId: context.deviceId } : {}) }); };
  const stop = entry => { if(entry.preview){entry.stop();return;}entry.player.pause(); entry.player.removeAttribute('src'); entry.player.load(); if (document.fullscreenElement === entry.node) void document.exitFullscreen().catch(() => {}); };
  return {
    track,
    get(refs, context) {
      track(context);
      return mediaReferences(refs).map(ref => {
        const key = JSON.stringify([context.deviceId, context.chatId, ref.id]); let entry = entries.get(key);
        if (entry) return entry.node;
        if(!['audio','video'].includes(ref.kind)){entry=createDocumentPreview({ref,context,request,document,available,source:mediaSource(context.chatId,ref.id,context.deviceId)});contentMenu?.bind(entry.node,{...context,mediaId:ref.id,text:ref.name});entries.set(key,entry);return entry.node;}
        const node = document.createElement('figure'); node.className = 'message-media'; node.dataset.mediaId = ref.id;
        const caption = document.createElement('figcaption'); caption.textContent = ref.name;
        const player = document.createElement(ref.kind), source = mediaSource(context.chatId, ref.id, context.deviceId); player.controls = true; player.preload = 'metadata'; player.setAttribute('aria-label', ref.name); if (available) player.src = source;
        const status = document.createElement('p'); status.className = 'media-status hint'; status.setAttribute('role', 'status'); status.hidden = available; if (!available) status.textContent = 'Connect to the host to play this media.';
        player.addEventListener('error', () => { status.textContent = `This ${ref.kind} is unavailable or its format is unsupported. You can try Save As… to open it in another player.`; status.hidden = false; });
        node.append(caption, player);
        if (ref.kind === 'video') {
          const fullscreen = document.createElement('button'); fullscreen.type = 'button'; fullscreen.className = 'button media-fullscreen'; fullscreen.textContent = 'Full screen'; fullscreen.setAttribute('aria-label', `Full screen: ${ref.name}`);
          fullscreen.addEventListener('click', async () => { try { if (document.fullscreenElement === node) await document.exitFullscreen(); else await node.requestFullscreen(); } catch (error) { status.textContent = error.message || 'Full screen is unavailable.'; status.hidden = false; } });
          node.addEventListener('fullscreenchange', () => { const active = document.fullscreenElement === node; fullscreen.textContent = active ? 'Exit full screen' : 'Full screen'; fullscreen.setAttribute('aria-label', `${active ? 'Exit full screen' : 'Full screen'}: ${ref.name}`); });
          node.append(fullscreen);
        }
        node.append(status); contentMenu?.bind(node, { ...context, mediaId: ref.id, text: ref.name });
        entry = { node, player, source, status }; entries.set(key, entry); return node;
      });
    },
    setAvailable(value) { if (available === value) return; available = value; for (const entry of entries.values()) { if(entry.preview){entry.setAvailable(value);continue;}if (value) { entry.status.hidden = true; entry.player.src = entry.source; } else { stop(entry); entry.status.textContent = 'Connect to the host to play this media.'; entry.status.hidden = false; } } },
    prune() { for (const [key, entry] of entries) if (!entry.node.isConnected) { entry.preview?entry.destroy():stop(entry); entries.delete(key); } },
    clear(context) {
      track(context); if (entries.size || owners.size) contentMenu?.close(); for (const entry of entries.values()) entry.preview?entry.destroy():stop(entry); entries.clear();
      for (const owner of owners.values()) void request('media.release', owner).catch(() => {});
      owners.clear();
    },
  };
}

export function contentActions(context, { text, image } = {}) {
  const owner = { ...(context.chatId ? { chatId: context.chatId } : {}), ...(context.deviceId ? { deviceId: context.deviceId } : {}) };
  const payload = context.mediaId ? { ...owner, mediaId: context.mediaId } : context.imageId ? { ...owner, imageId: context.imageId } : safeOutputImage(image) ? { ...owner, image } : null;
  return [
    ...(text ? [{ id: 'copyText', label: 'Copy text', method: 'clipboard.copyText', params: { text } }] : []),
    ...(payload && !context.mediaId ? [{ id: 'copyImage', label: 'Copy image', method: 'clipboard.copyImage', params: payload }] : []),
    ...(payload ? [{ id: 'save', label: 'Save As…', method: 'media.save', params: payload }] : []),
  ];
}

export function createContentMenu({ request, onError = () => {}, onNotice = () => {}, onOpen = () => {}, document = globalThis.document, window = globalThis.window }) {
  const menu = document.createElement('div'); menu.className = 'chat-context-menu'; menu.id = 'content-context-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Chat content options'); menu.hidden = true; document.body.append(menu);
  const bindings = new WeakMap(); let returnFocus;
  function close(focus = false) { menu.hidden = true; if (menu.parentElement !== document.body) document.body.append(menu); if (focus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); }
  function open(event, origin) {
    const context = bindings.get(origin), selection = document.getSelection?.();
    const selected = selection && (origin.contains(selection.anchorNode) || origin.contains(selection.focusNode)) ? selection.toString() : '';
    const target = event.target?.closest?.('img'), image = target && origin.contains(target) ? target.getAttribute('src') : undefined;
    const items = contentActions(context, { text: selected || context.text, image }); if (!items.length) return;
    event.preventDefault(); event.stopPropagation(); onOpen(); close(); const menuParent = document.fullscreenElement || document.body; if (menu.parentElement !== menuParent) menuParent.append(menu); returnFocus = event.target?.closest?.('img,audio,video,button,[tabindex]') || origin; menu.replaceChildren();
    for (const item of items) {
      const action = document.createElement('button'); action.type = 'button'; action.textContent = item.label; action.setAttribute('role', 'menuitem'); action.dataset.action = item.id;
      action.addEventListener('click', async () => { close(true); try { const result = await request(item.method, item.params); if (item.id !== 'save') onNotice(item.id === 'copyImage' ? 'Copied image.' : 'Copied text.'); else if (result?.saved) onNotice('Saved file.'); } catch (error) { onError(error); } }); menu.append(action);
    }
    menu.hidden = false;
    const bounds = origin.getBoundingClientRect(), keyboard = event.type === 'keydown' || (!event.clientX && !event.clientY);
    menu.style.left = `${Math.max(8, Math.min(keyboard ? bounds.left + 16 : event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(keyboard ? bounds.bottom : event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button')?.focus();
  }
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const entries = [...menu.querySelectorAll('button')], index = entries.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length; entries[next]?.focus(); }
    if (event.key === 'Tab') close();
  });
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target)) close(); }); window.addEventListener('resize', () => close());
  return { close, bind(node, context) {
    if (!bindings.has(node)) { node.tabIndex = node.tabIndex >= 0 ? node.tabIndex : 0; node.setAttribute('aria-haspopup', 'menu'); node.addEventListener('contextmenu', event => open(event, node)); node.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) open(event, node); }); }
    bindings.set(node, context); for (const image of node.querySelectorAll('img')) { image.tabIndex = 0; image.setAttribute('aria-haspopup', 'menu'); }
  } };
}
