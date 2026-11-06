import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { clipboard, dialog, nativeImage } from 'electron';
import { createRemoteHost, createRemoteController } from '../desktop/remote-transport.mjs';
import { createRelayHostAdapter, connectRelayController, generateRouteSecret, deriveRouteId } from '../desktop/remote-relay.mjs';
import { createRelayServer } from '../relay/server.mjs';
import { waveFixture, webmFixture } from './fixtures/media.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const vault = () => { const values = new Map(); return { getSecret: async key => values.get(key) || '', setSecret: async (key, value) => { values.set(key, value); } }; };

// Runs through the production preload, protocol, CSP and media host in a disposable profile.
export async function runMediaSmoke({ window, runtime, chat, dataDir, remote }) {
  const checks = [], requests = [], screenshots = {}, js = code => window.webContents.executeJavaScript(code, true);
  const bridge = (method, params) => js(`window.faber.request(${JSON.stringify(method)},${JSON.stringify(params)})`);
  const capture = async name => { const file = path.join(dataDir, name + '.png'); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots[name] = file; };
  async function until(check, label, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await check(); if (value) return value; await pause(40); }
    throw new Error(`Media smoke timeout: ${label}`);
  }
  const state = await runtime.request('state.get'), project = state.projects.find(row => row.id === chat.projectId);
  const originals = new Map([['tone.wav', waveFixture()], ['motion.webm', await webmFixture(window)]]);
  assert.equal(originals.get('tone.wav').toString('ascii', 0, 4), 'RIFF');
  assert.equal(originals.get('motion.webm').readUInt32BE(), 0x1a45dfa3);
  const refs = [];
  for (const [name, bytes] of originals) {
    await fs.writeFile(path.join(project.path, name), bytes);
    refs.push((await bridge('tool.run', { chatId: chat.id, name: 'media_show', args: { path: name } })).media);
  }
  const png = nativeImage.createFromBitmap(Buffer.from([0x40, 0x80, 0xc0, 0xff]), { width: 1, height: 1 }).toDataURL();
  await fs.writeFile(path.join(project.path, 'pixel.png'), Buffer.from(png.split(',')[1], 'base64'));
  await bridge('tool.run', { chatId: chat.id, name: 'images_show', args: { path: 'pixel.png' } });
  await until(() => js(`!!document.querySelector('#local-projects [data-chat-id="${chat.id}"]')`), 'fixture navigation');
  await js(`document.querySelector('#local-projects [data-chat-id="${chat.id}"]').click()`);

  async function playback(selector, label) {
    await until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), label + ' player');
    await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});window.mediaSmokeCanplay=0;window.mediaSmokeSeeked=0;e.addEventListener('canplay',()=>window.mediaSmokeCanplay++);e.addEventListener('seeked',()=>window.mediaSmokeSeeked++);e.muted=true;e.preload='auto';e.load();})()`);
    await until(() => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return window.mediaSmokeCanplay>0&&e.readyState>=3&&!e.error})()`), label + ' canplay');
    await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});window.mediaSmokePlayer=e;window.mediaSmokeUpdates=0;e.addEventListener('timeupdate',()=>window.mediaSmokeUpdates++);return e.play();})()`);
    await until(() => js(`window.mediaSmokePlayer.currentTime>.2&&window.mediaSmokeUpdates>0`), label + ' timeupdate');
    const position = await js(`window.mediaSmokePlayer.currentTime`);
    runtime.emit({ type: 'state', state: await runtime.request('state.get') });
    await pause(250);
    assert.equal(await js(`window.mediaSmokePlayer===document.querySelector(${JSON.stringify(selector)})`), true, label + ' retains node');
    assert.ok(await js(`window.mediaSmokePlayer.currentTime`)>position, label + ' continues playing across state');
    await js(`window.mediaSmokePlayer.pause();window.mediaSmokePlayer.currentTime=2`);
    await until(() => js(`window.mediaSmokeSeeked>0&&!window.mediaSmokePlayer.seeking&&Math.abs(window.mediaSmokePlayer.currentTime-2)<.25`), label + ' seek');
    checks.push(label + ': canplay, play/timeupdate, seek and state-update node continuity');
  }
  async function showMedia() {
    await js(`document.querySelectorAll('#transcript details,#remote-transcript details').forEach(e=>e.open=true)`);
  }
  await showMedia();
  for (const ref of refs) await playback(`#transcript [data-media-id="${ref.id}"] ${ref.kind}`, 'local ' + ref.kind);
  await js(`window.mediaSmokeLocalPlayer=window.mediaSmokePlayer`); await capture('media-local-players');
  const video = refs.find(ref => ref.kind === 'video');
  await js(`document.querySelector('#transcript [data-media-id="${video.id}"] .media-fullscreen').click()`);
  await until(() => js(`document.fullscreenElement?.dataset.mediaId===${JSON.stringify(video.id)}`), 'real fullscreen');
  await js(`document.exitFullscreen()`); await until(() => js(`!document.fullscreenElement`), 'fullscreen exit');
  checks.push('real app permission handlers allow the explicit video fullscreen action');

  const originalSave = dialog.showSaveDialog, originalRemote = remote.request, originalCopyImage = clipboard.writeImage, originalCopyText = clipboard.writeText;
  let receiver, controller, relay, adapter, chosen, copiedImage, copiedText;
  dialog.showSaveDialog = async () => chosen ? { canceled: false, filePath: chosen } : { canceled: true };
  clipboard.writeImage = image => { copiedImage = image; };
  clipboard.writeText = text => { copiedText = text; };
  async function save(params, expected, name) {
    chosen = path.join(project.path, name); await bridge('media.save', params);
    assert.deepEqual(await fs.readFile(chosen), expected, name + ' byte-identical');
  }
  try {
    for (const ref of refs) await save({ chatId: chat.id, mediaId: ref.id }, originals.get(ref.name), 'local-' + ref.name);
    await save({ chatId: chat.id, image: png }, Buffer.from(png.split(',')[1], 'base64'), 'local-pixel.png');
    await bridge('clipboard.copyImage', { chatId: chat.id, image: png });
    assert.deepEqual(copiedImage.getSize(), { width: 1, height: 1 });
    const localBitmap = Buffer.from(copiedImage.toBitmap());
    await bridge('clipboard.copyText', { text: 'Synthetic media clipboard fixture' });
    assert.equal(copiedText, 'Synthetic media clipboard fixture');
    chosen = null; assert.equal((await bridge('media.save', { chatId: chat.id, mediaId: video.id })).canceled, true);
    checks.push('local image/audio/video Save As retains exact bytes and cancellation makes no write');
    const figure = `#transcript [data-media-id="${video.id}"]`;
    await js(`(()=>{const e=document.querySelector(${JSON.stringify(figure)});e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));})()`);
    assert.equal(await js(`document.querySelector('#content-context-menu').hidden`), false);
    await js(`document.querySelector('#content-context-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))`);
    assert.equal(await js(`document.activeElement.dataset.action`), 'save');
    await capture('media-context-menu');
    await js(`document.querySelector('#content-context-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(figure)})`), true);
    chosen = path.join(project.path, 'menu-motion.webm');
    await js(`(()=>{const e=document.querySelector(${JSON.stringify(figure)});e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}));document.querySelector('#content-context-menu [data-action="save"]').click();})()`);
    await until(async () => { try { return (await fs.readFile(chosen)).equals(originals.get(video.name)); } catch { return false; } }, 'context menu Save As bytes');
    checks.push('keyboard context menu End/Escape restores focus and right-click Save As writes exact video bytes');
    copiedImage = null;
    await js(`(()=>{const image=document.querySelector('#transcript .message-images img');if(!image)throw Error('Missing local image');image.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));document.querySelector('#content-context-menu [data-action="copyImage"]').click();})()`);
    await until(() => Promise.resolve(copiedImage?.getSize().width === 1), 'local Copy image menu');

    receiver = await createRemoteHost({ host: vault(), allowLocalRelay: true, dispatch: (method, params, authority) => runtime.remoteRequest(method, params, authority) });
    const { port } = await receiver.start();
    const secret = generateRouteSecret(), routeId = deriveRouteId(secret);
    relay = createRelayServer({ allowedRouteIds: [routeId] }); const relayAddress = await relay.start();
    const route = { relayUrl: `ws://127.0.0.1:${relayAddress.port}`, routeId };
    adapter = await createRelayHostAdapter({ ...route, registrationSecret: secret, targetPort: port, allowLocalRelay: true });
    controller = await createRemoteController({ host: vault(), allowLocalRelay: true, dial: (route, { signal } = {}) => connectRelayController(route, { signal, allowLocalRelay: true }) });
    const invitation = await receiver.createInvitation({ ...route, hostName: 'Media fixture host' });
    const pending = await controller.pair({ ...invitation, deviceName: 'Media fixture controller' }); await receiver.acceptPairing(pending.id);
    const { connection } = await controller.completePairing();
    remote.request = async (method, params = {}) => {
      if (method === 'remote.status') { const value = await originalRemote.call(remote, method, params); return { ...value, devices: [...value.devices, { id: connection.id, name: 'Media fixture host', role: 'host', online: true }] }; }
      if (method === 'remote.request' && params.deviceId === connection.id) { requests.push({ method: params.method, ...params.params }); return controller.request(connection.id, params.method, params.params); }
      return originalRemote.call(remote, method, params);
    };
    const remoteState = await originalRemote.call(remote, 'remote.status');
    runtime.emit({ type: 'remote', state: { ...remoteState, devices: [...remoteState.devices, { id: connection.id, name: 'Media fixture host', role: 'host', online: true }] } });
    await until(() => js(`!!document.querySelector('#remote-projects [data-remote-device-id="${connection.id}"][data-remote-chat-id="${chat.id}"]')`), 'paired host navigation');
    await js(`document.querySelector('#remote-projects [data-remote-device-id="${connection.id}"][data-remote-chat-id="${chat.id}"]').click()`);
    await until(() => js(`window.mediaSmokeLocalPlayer.paused&&!window.mediaSmokeLocalPlayer.hasAttribute('src')`), 'local media released on remote route');
    await until(() => js(`!!document.querySelector('#remote-transcript [data-media-id="${video.id}"]')`), 'remote media refs'); await showMedia();
    for (const ref of refs) await playback(`#remote-transcript [data-media-id="${ref.id}"] ${ref.kind}`, 'paired TLS ' + ref.kind);
    await capture('media-remote-players');
    for (const ref of refs) await save({ chatId: chat.id, mediaId: ref.id, deviceId: connection.id }, originals.get(ref.name), 'remote-' + ref.name);
    const transcript = await controller.request(connection.id, 'chat.read', { chatId: chat.id, imageMode: 'references', mediaMode: 'references' });
    const imageId = transcript.runs.flatMap(run => run.toolEvents || []).flatMap(event => event.imageRefs || []).at(-1)?.id;
    assert.ok(imageId, 'remote image reference');
    await save({ chatId: chat.id, imageId, deviceId: connection.id }, Buffer.from(png.split(',')[1], 'base64'), 'remote-pixel.png');
    copiedImage = null;
    await bridge('clipboard.copyImage', { chatId: chat.id, imageId, deviceId: connection.id });
    assert.deepEqual(copiedImage.toBitmap(), localBitmap, 'remote Copy image decoded pixels');
    checks.push('local/remote Copy image uses Electron nativeImage with identical pixels and Copy text forwards exact text; clipboard writers intercepted');
    checks.push('paired TLS remote image/audio/video Save As retains exact bytes');
    assert.ok(requests.some(request => request.method === 'chat.media' && request.length > 0));
    assert.ok(requests.filter(request => request.method === 'chat.media').every(request => request.length <= 262144));
    const remoteFigure = `#remote-transcript [data-media-id="${video.id}"]`;
    await js(`(()=>{const node=document.querySelector(${JSON.stringify(remoteFigure)});window.mediaSmokeRemotePlayer=node.querySelector('video');window.mediaSmokeRemotePlayer.currentTime=.5;node.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true,cancelable:true}));return window.mediaSmokeRemotePlayer.play();})()`);
    const remotePosition = await js(`window.mediaSmokeRemotePlayer.currentTime`);
    runtime.emit({ type: 'state', state: await runtime.request('state.get') }); await pause(300);
    assert.equal(await js(`document.querySelector('#content-context-menu').hidden`), false);
    assert.equal(await js(`window.mediaSmokeRemotePlayer===document.querySelector(${JSON.stringify(remoteFigure + ' video')})`), true);
    assert.ok(await js(`window.mediaSmokeRemotePlayer.currentTime`) > remotePosition);
    await capture('media-remote-context-menu');
    runtime.emit({ type: 'remote', state: { ...remoteState, devices: [{ id: connection.id, name: 'Media fixture host', role: 'host', online: false }] } });
    await until(() => js(`window.mediaSmokeRemotePlayer.paused&&!window.mediaSmokeRemotePlayer.hasAttribute('src')&&document.querySelector('#content-context-menu').hidden`), 'offline release and menu closure');
    checks.push('remote player and open menu survive local state refresh; offline clears sources and closes its menu');
    await receiver.revokeDevice(pending.id);
    await assert.rejects(bridge('media.save', { chatId: chat.id, mediaId: video.id, deviceId: connection.id }));
    checks.push('host revocation blocks subsequent remote media access');
  } finally {
    dialog.showSaveDialog = originalSave; remote.request = originalRemote; clipboard.writeImage = originalCopyImage; clipboard.writeText = originalCopyText;
    await controller?.dispose(); await adapter?.close(); await receiver?.dispose(); await relay?.close();
  }
  assert.ok((await runtime.request('state.get')).runs.every(run => !run.modelCalls?.length), 'no model calls in the isolated media fixture');
  const report = { ok: true, synthetic: true, providerCalls: 0, checks, mediaRequests: requests.filter(request => request.method === 'chat.media').length, screenshotNames: Object.keys(screenshots), limits: ['Native Save As chooser and clipboard writers were intercepted; user clipboard was untouched.', 'Paired TLS used the real WebSocket relay on loopback; physical two-PC/WAN testing and additional codecs remain pending.'] };
  await fs.writeFile(path.join(dataDir, 'media-smoke-report.json'), JSON.stringify(report, null, 2));
  return report;
}
