import {sceneReferences,createScenePreview} from './scene-preview.mjs';
import { safeOutputImage } from './rich-content.mjs';
import { createDocumentPreview } from './document-preview.mjs';
import {createStemOutput,attachTimedCaptions} from './timed-media.mjs';
import {createHtmlArtifact} from './html-artifact.mjs';

const formats = { 'model/gltf-binary':['scene','.glb'],'model/gltf+json':['scene','.gltf'],'model/stl':['scene','.stl'], 'audio/wav': ['audio', '.wav'], 'audio/mpeg': ['audio', '.mp3'], 'audio/mp4': ['audio', '.m4a'], 'audio/ogg': ['audio', '.ogg'], 'video/mp4': ['video', '.mp4'], 'video/webm': ['video', '.webm'] };
Object.assign(formats,{'application/pdf':['document','.pdf'],'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['document','.docx'],'image/svg+xml':['vector','.svg'],'image/gif':['animation','.gif'],'image/apng':['animation','.apng'],'image/png':['animation','.png']});
Object.assign(formats,{'audio/midi':['midi','.mid'],'application/x-subrip':['caption','.srt'],'text/vtt':['caption','.vtt']});
Object.assign(formats,{'application/vnd.faber.chart+json':['chart','.chart.json'],'application/vnd.faber.diagram+json':['diagram','.diagram.json'],'application/geo+json':['map','.geojson'],'text/html':['html','.html']});
export function mediaReferences(value) {
  const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value),revision=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const assetTypes={js:'text/javascript',mjs:'text/javascript',css:'text/css',json:'application/json',bin:'application/octet-stream',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',svg:'image/svg+xml',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'};
  const safeName=name=>typeof name==='string'&&name.length>0&&name.length<=180&&!/[\\/:\u0000-\u001f\u007f]/.test(name);
  const assetBase=ref=>ref?.kind==='asset'&&uuid(ref.id)&&safeName(ref.name)&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=8*1024*1024&&revision(ref.revision)&&ref.storage==='interactive'&&assetTypes[ref.name.split('.').at(-1).toLowerCase()]===ref.mimeType&&!ref.assets&&!ref.tracks&&!ref.captions;
  function graph(ref){if(ref.kind==='scene')return sceneReferences(ref);if(ref.kind!=='html')return ref.assets===undefined&&ref.graphRevision===undefined;if(!Array.isArray(ref.assets)||ref.assets.length>32||!revision(ref.graphRevision))return false;const ids=new Set([ref.id]),names=new Set();let bytes=ref.bytes;return ref.assets.every(row=>{if(typeof row?.name!=='string'||!row.name.length||row.name.length>240||!row.name.split('/').every(part=>/^[A-Za-z0-9_.-]+$/.test(part)&&part!=='.'&&part!=='..')||['index.html','wrapper.html'].includes(row.name)||names.has(row.name)||!assetBase(row.media)||ids.has(row.media.id))return false;names.add(row.name);ids.add(row.media.id);bytes+=row.media.bytes;return bytes<=16*1024*1024;});}
  function base(ref){
    const format = Object.hasOwn(formats, ref?.mimeType) ? formats[ref.mimeType] : null;
    const limit={document:64*1024*1024,vector:4*1024*1024,animation:16*1024*1024,midi:4*1024*1024,caption:1024*1024,scene:64*1024*1024,chart:2*1024*1024,map:4*1024*1024,diagram:1024*1024,html:2*1024*1024}[ref?.kind];
    return format && ref.kind === format[0] && uuid(ref.id) && Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= (limit||512*1024*1024) && safeName(ref.name) && (ref.name.toLowerCase().endsWith(format[1])||ref.kind==='midi'&&ref.name.toLowerCase().endsWith('.midi')||ref.kind==='html'&&ref.name.toLowerCase().endsWith('.htm'))&&(!limit||revision(ref.revision))&&(ref.kind==='scene'?ref.storage==='scene':['chart','map','diagram','html'].includes(ref.kind)?ref.storage==='interactive':ref.storage===undefined);
  }
  const pick=({id,kind,mimeType,bytes,name,revision,storage})=>({id,kind,mimeType,bytes,name,...(revision?{revision}:{}),...(storage?{storage}:{})}),members=(rows,kind,max)=>Array.isArray(rows)&&rows.length>0&&rows.length<=max&&rows.every(row=>typeof row?.label==='string'&&row.label.length>0&&row.label.length<=100&&base(row.media)&&row.media.kind===kind&&!row.media.tracks&&!row.media.captions);
  return(Array.isArray(value)?value:[]).filter(ref=>base(ref)&&graph(ref)&&ref.kind!=='caption'&&(!ref.tracks||members(ref.tracks,'audio',8)&&ref.tracks.length>=2&&ref.tracks[0].media.id===ref.id&&ref.tracks.every(row=>row.media.mimeType==='audio/wav'&&row.media.bytes<=32*1024*1024)&&ref.tracks.reduce((sum,row)=>sum+row.media.bytes,0)<=64*1024*1024)&&(!ref.captions||members(ref.captions,'caption',4))).slice(0,1).map(ref=>({...pick(ref),...(typeof ref.title==='string'&&ref.title.length<=100?{title:ref.title}:{}),...(ref.assets?{assets:ref.assets.map(row=>({name:row.name,media:pick(row.media)})),graphRevision:ref.graphRevision}:{}),...(ref.tracks?{tracks:ref.tracks.map(row=>({label:row.label,media:pick(row.media)}))}:{}),...(ref.captions?{captions:ref.captions.map(row=>({label:row.label,media:pick(row.media)}))}:{})}));
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
        const owner={chatId:context.chatId,...(context.deviceId?{deviceId:context.deviceId}:{})},source=media=>mediaSource(context.chatId,media.id,context.deviceId);
        if(ref.kind==='scene'){entry=createScenePreview({ref,context,request,document,available,source});contentMenu?.bind(entry.node,{...context,mediaId:ref.id,text:ref.name});entries.set(key,entry);return entry.node;}
        if(ref.kind==='html'){entry=createHtmlArtifact({ref,context,request,document,available});contentMenu?.bind(entry.node,{...context,mediaId:ref.id,text:ref.name});entries.set(key,entry);return entry.node;}
        if(ref.tracks){entry=createStemOutput({ref,context,request,document,available,source});contentMenu?.bind(entry.node,{...context,mediaId:ref.id,text:ref.title||ref.name});entries.set(key,entry);return entry.node;}
        if(!['audio','video'].includes(ref.kind)){entry=createDocumentPreview({ref,context,request,document,available,source:mediaSource(context.chatId,ref.id,context.deviceId)});if(ref.captions)entry.captions=attachTimedCaptions({ref,node:entry.node,player:entry.transport,request,owner,source,document});contentMenu?.bind(entry.node,{...context,mediaId:ref.id,text:ref.name});entries.set(key,entry);return entry.node;}
        const node = document.createElement('figure'); node.className = 'message-media'; node.dataset.mediaId = ref.id;
        const caption = document.createElement('figcaption'); caption.textContent = ref.name;
        const player = document.createElement(ref.kind), playerSource = mediaSource(context.chatId, ref.id, context.deviceId); player.controls = true; player.preload = 'metadata'; player.setAttribute('aria-label', ref.name); if (available) player.src = playerSource;
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
        entry = { node, player, source:playerSource, status };if(ref.captions)entry.captions=attachTimedCaptions({ref,node,player,request,owner,source,document});entries.set(key, entry); return node;
      });
    },
    setAvailable(value) { if (available === value) return; available = value; for (const entry of entries.values()) { entry.captions?.setAvailable(value);if(entry.preview){entry.setAvailable(value);continue;}if (value) { entry.status.hidden = true; entry.player.src = entry.source; } else { stop(entry); entry.status.textContent = 'Connect to the host to play this media.'; entry.status.hidden = false; } } },
    prune() { for (const [key, entry] of entries) if (!entry.node.isConnected) { entry.captions?.destroy();entry.preview?entry.destroy():stop(entry); entries.delete(key); } },
    clear(context) {
      track(context); if (entries.size || owners.size) contentMenu?.close(); for (const entry of entries.values()){entry.captions?.destroy();entry.preview?entry.destroy():stop(entry);}entries.clear();
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
