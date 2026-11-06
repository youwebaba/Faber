export const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting', 'awaiting_approval', 'waiting_approval', 'stopping']);
export const PERMISSIONS = ['files', 'shell', 'computer', 'network', 'upgrade'];
export function isActive(run) { return Boolean(run && ACTIVE_STATUSES.has(run.status)); }
export function latestRun(state, chatId) { return (state.runs || []).findLast(run => run.chatId === chatId); }
export function chatApprovals(state, chatId) {
  const runs = new Set(state.runs.filter(run => run.chatId === chatId).map(run => run.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const run of state.runs) if (runs.has(run.parentRunId) && !runs.has(run.id)) { runs.add(run.id); changed = true; }
  }
  return state.approvals.filter(approval => approval.chatId === chatId || runs.has(approval.runId));
}
export function safeImage(value) { return typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value) ? value : null; }
export function displayText(value) { return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2); }
export function sameMessage(a, b) {
  return Boolean(a && b && ['id', 'role', 'content', 'createdAt', 'status', 'toolName', 'image', 'fromChatId'].every(key => a[key] === b[key]) && JSON.stringify(a.toolCalls) === JSON.stringify(b.toolCalls) && JSON.stringify(a.images) === JSON.stringify(b.images) && JSON.stringify(a.mediaRefs) === JSON.stringify(b.mediaRefs));
}
export function parseArguments(value) {
  const parsed = JSON.parse(value || '{}');
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Tool arguments must be a JSON object.');
  return parsed;
}
export function statusLabel(status) { return String(status || 'idle').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()); }
export function streamText(stream, run, messages) {
  if (!stream || !isActive(run)) return '';
  // A committed assistant message replaces its streamed copy, including during tool execution.
  const committed = messages.filter(message => message.role === 'assistant' && message.createdAt >= run.startedAt).map(message => displayText(message.content));
  return committed.some(text => text && text === stream) ? '' : stream;
}
export function reconcileStreams(streams, state) {
  for (const [runId, stream] of streams) {
    const run = state.runs.find(item => item.id === runId);
    const chat = state.chats.find(item => item.id === run?.chatId);
    const lastAssistant = chat?.messages.findLast(item => item.role === 'assistant');
    if (!isActive(run) || (lastAssistant && lastAssistant.id !== stream.lastAssistantId)) streams.delete(runId);
  }
}
export function extensionActions(extensions) {
  return (extensions || []).flatMap(extension => (extension.uiActions || extension.actions || []).filter(action => action && typeof action.label === 'string' && typeof (action.tool || action.toolName) === 'string').map(action => ({ ...action, tool: action.tool || action.toolName, extensionName: extension.name || extension.id })));
}
