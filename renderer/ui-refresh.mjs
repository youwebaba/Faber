import { validateAttachmentSnapshot } from './file-attachments.mjs';

export const MAX_UI_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export function interfaceError(error) { return String(error?.message || error).replace(/^Error invoking remote method ['"]faber:request['"]:\s*(?:Error:\s*)?/, ''); }
const fields = ['version', 'selectedChatId', 'selectedProjectId', 'drafts', 'view'];
const flags = ['sidebarHidden', 'sidebarOpen', 'activityHidden', 'activityOpen', 'promptFocused'];
const positions = ['transcriptScroll', 'activityScroll', 'projectScroll', 'promptSelectionStart', 'promptSelectionEnd'];
const objectWith = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function validateUISnapshot(snapshot) {
  if (!objectWith(snapshot, fields) || snapshot.version !== 1 || ![snapshot.selectedChatId, snapshot.selectedProjectId].every(id => id === null || typeof id === 'string' && id.length > 0 && id.length <= 300)) throw new Error('Unsupported interface snapshot.');
  if (new TextEncoder().encode(JSON.stringify({ state: snapshot })).length > MAX_UI_SNAPSHOT_BYTES) throw new Error('Composer drafts exceed the 64 MiB interface refresh limit. Send or remove some attachments before refreshing.');
  if (!Array.isArray(snapshot.drafts)) throw new Error('Invalid composer drafts.');
  for (const draft of snapshot.drafts) if (!objectWith(draft, ['key', 'text', 'attachments']) || typeof draft.text !== 'string') throw new Error('Invalid composer draft.');
  const attachments = validateAttachmentSnapshot(snapshot.drafts.map(({ key, attachments }) => ({ key, attachments })));
  if (!objectWith(snapshot.view, [...flags, ...positions]) || flags.some(key => typeof snapshot.view[key] !== 'boolean') || positions.some(key => !Number.isFinite(snapshot.view[key]) || snapshot.view[key] < 0) || ['promptSelectionStart', 'promptSelectionEnd'].some(key => !Number.isSafeInteger(snapshot.view[key])) || snapshot.view.promptSelectionStart > snapshot.view.promptSelectionEnd) throw new Error('Invalid interface view state.');
  return { version: 1, selectedChatId: snapshot.selectedChatId, selectedProjectId: snapshot.selectedProjectId, drafts: snapshot.drafts.map((draft, i) => ({ key: draft.key, text: draft.text, attachments: attachments[i].attachments })), view: { ...snapshot.view } };
}
export function composeUISnapshot({ selectedChatId, selectedProjectId, drafts, attachments, view }) {
  const entries = new Map([...drafts].map(([key, text]) => [key, { key, text, attachments: [] }]));
  for (const entry of attachments) { if (!entries.has(entry.key)) entries.set(entry.key, { key: entry.key, text: '', attachments: [] }); entries.get(entry.key).attachments = entry.attachments; }
  return validateUISnapshot({ version: 1, selectedChatId: selectedChatId || null, selectedProjectId: selectedProjectId || null, drafts: [...entries.values()], view });
}
export function refreshBlocker({ sending, pendingReads, pendingPicker, pendingRequests, modalOpen, cleanSettings, modelsOpen, voiceActive, manual }) {
  if (sending || pendingRequests) return 'Wait for the current interface action to finish.';
  if (pendingReads || pendingPicker) return 'Finish choosing or reading attachments first.';
  if (voiceActive) return 'Stop voice input or speech before refreshing.';
  if (modelsOpen) return 'Close Models before refreshing so its current search and selections are not discarded.';
  if (modalOpen && !(manual && cleanSettings)) return 'Save or close the open form before refreshing.';
  return '';
}
// A cumulative snapshot plus versioned chunks covers the page-reload gap without
// retransmitting the entire answer for every token.
export function mergeRuntimeStreams(streams, value, version = -1) {
  if (!Number.isSafeInteger(value.streamSequence) || value.streamSequence < version) return version;
  if (Array.isArray(value.streams)) { streams.clear(); for (const stream of value.streams) streams.set(stream.runId, { ...stream }); }
  else if (['delta', 'progress'].includes(value.type) && Number.isSafeInteger(value.sequence) && value.sequence > version) {
    const previous = streams.get(value.runId);
    const sameCall = previous?.lastAssistantId === value.lastAssistantId && (!previous?.modelCallId || !value.modelCallId || previous.modelCallId === value.modelCallId);
    const stream = sameCall ? { ...previous } : { text: '' };
    if (value.type === 'delta') stream.text = value.replace ? value.text : (stream.text || '') + value.text;
    if (value.phase && value.phase !== stream.phase) stream.progressSummary = '';
    if (value.phase) stream.phase = value.phase;
    if (typeof value.summary === 'string') stream.progressSummary = value.summary;
    if (typeof value.progressSummary === 'string') stream.progressSummary = value.progressSummary;
    streams.set(value.runId, { ...stream, runId: value.runId, chatId: value.chatId, lastAssistantId: value.lastAssistantId, sequence: value.sequence, ...(value.modelCallId ? { modelCallId: value.modelCallId } : {}), ...(value.metrics ? { metrics: value.metrics } : {}) });
  }
  return value.streamSequence;
}
