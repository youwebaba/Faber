import { randomUUID } from 'node:crypto';
import { validateChatImages } from '../core/images.mjs';

export const UI_STATE_LIMIT = 64 * 1024 * 1024;
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const string = (value, max = Infinity) => typeof value === 'string' && value.length <= max;
const identifier = value => value === null || string(value, 300) && value.length > 0;
export function validateUISnapshot(state) {
  if (!object(state, ['version', 'selectedChatId', 'selectedProjectId', 'drafts', 'view']) || state.version !== 1 || !identifier(state.selectedChatId) || !identifier(state.selectedProjectId) || !Array.isArray(state.drafts)) throw new Error('Invalid UI handoff state');
  const keys = new Set();
  for (const draft of state.drafts) {
    if (!object(draft, ['key', 'text', 'attachments']) || !string(draft.key, 300) || !draft.key || keys.has(draft.key) || !string(draft.text) || !Array.isArray(draft.attachments)) throw new Error('Invalid UI draft');
    keys.add(draft.key); const images = []; let count = 0, bytes = 0;
    for (const attachment of draft.attachments) {
      if (!attachment || !string(attachment.name, 255)) throw new Error('Invalid UI attachment');
      if (attachment.kind === 'image' && object(attachment, ['kind', 'name', 'image'])) images.push(attachment.image);
      else if (attachment.kind === 'text' && object(attachment, ['kind', 'name', 'content']) && string(attachment.content)) { count++; bytes += Buffer.byteLength(attachment.content); }
      else throw new Error('Invalid UI attachment');
    }
    validateChatImages(images);
    if (count > 8 || bytes > 1024 * 1024) throw new Error('UI text attachment limit exceeded');
  }
  const flags = ['sidebarHidden', 'sidebarOpen', 'activityHidden', 'activityOpen', 'promptFocused'];
  const scroll = ['transcriptScroll', 'activityScroll', 'projectScroll'];
  const selection = ['promptSelectionStart', 'promptSelectionEnd'];
  if (!object(state.view, [...flags, ...scroll, ...selection]) || flags.some(key => typeof state.view[key] !== 'boolean') || [...scroll, ...selection].some(key => !Number.isFinite(state.view[key]) || state.view[key] < 0) || selection.some(key => !Number.isSafeInteger(state.view[key])) || state.view.promptSelectionStart > state.view.promptSelectionEnd) throw new Error('Invalid UI view state');
  if (Buffer.byteLength(JSON.stringify({ state })) > UI_STATE_LIMIT) throw new Error('UI drafts exceed the 64 MiB reload handoff limit. Keep this page open and reduce drafts before reloading.');
}

export function createUIReload({ activationStatus, reload, assertAllowed = () => {}, emit = () => {}, schedule = task => setTimeout(task, 50) }) {
  let pending = null, preparing = false;
  async function checkActivation() {
    assertAllowed();
    const status = await activationStatus();
    assertAllowed();
    if (status.busy) throw new Error('An update is being applied. Wait until it finishes, then reload the UI.');
    if (status.restartRequired) throw new Error('Backend changes are pending. Restart the app to activate them; this page and its drafts remain open.');
  }
  return {
    get pending() { return preparing || pending !== null; },
    async request(method, params = {}) {
      if (method === 'app.uiState') { if (!object(params, [])) throw new Error('Invalid UI state request'); return structuredClone(pending); }
      if (method === 'app.uiStateAck') {
        if (!object(params, ['id']) || !string(params.id, 100)) throw new Error('Invalid UI acknowledgement');
        if (!pending || pending.id !== params.id) throw new Error('UI handoff acknowledgement does not match');
        pending = null; return { acknowledged: true };
      }
      if (method !== 'app.reloadUI' || !object(params, ['state'])) throw new Error('Invalid UI reload request');
      validateUISnapshot(params.state);
      if (preparing || pending) throw new Error('A UI handoff is already pending');
      preparing = true;
      try {
        await checkActivation();
        pending = { id: randomUUID(), state: structuredClone(params.state) };
        const id = pending.id;
        schedule(async () => {
          try { await checkActivation(); if (pending?.id === id) reload(); }
          catch (error) { emit({ type: 'uiReloadFailed', id, error: error.message }); }
        });
        return { id, reloading: true };
      } finally { preparing = false; }
    },
  };
}
