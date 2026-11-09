import { orderedChatFamilies } from './chat-navigation.mjs';
import { mediaReferences } from './content-media.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);
const list = value => Array.isArray(value) ? value.filter(record) : [];
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const imageRefs = value => list(value).filter(item => typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(item.id) && ['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= 8 * 1024 * 1024).map(item => pick(item, ['id', 'mimeType', 'bytes']));
const runs = value => list(value).filter(item => id(item.id) && id(item.chatId)).map(item => ({
  ...pick(item, ['id', 'chatId', 'startedAt', 'requestMessageId', 'sourceMessageId', 'modelCallId', 'contextOverflow']), parentRunId: id(item.parentRunId) ? item.parentRunId : null, status: text(item.status), error: text(item.error),
  promptUsage: list(item.promptUsage).filter(row => id(row.requestMessageId)).map(row => pick(row, ['requestMessageId','status','allocation','sharedWithMessageId','calls','reportedCalls','unknownCalls','partialCalls','estimatedInputTokens','estimatedOutputTokens','inputTokens','outputTokens','cachedInputTokens','reasoningTokens'])),
  steering: list(item.steering).filter(row => id(row.messageId)).map(row => pick(row,['messageId','status','waitingFor'])),
  modelCalls: list(item.modelCalls).map(call => ({ ...pick(call, ['id', 'modelCallId', 'sourceMessageId', 'requestMessageId', 'metrics', 'usage']), status: text(call.status), phase: text(call.phase), progressSummary: text(call.progressSummary) })),
  toolEvents: list(item.toolEvents).filter(event => id(event.id)).map(event => ({ ...pick(event, ['id', 'toolCallId', 'modelCallId', 'sourceMessageId', 'startedAt', 'args', 'result', 'image']), imageRefs: imageRefs(event.imageRefs), mediaRefs: mediaReferences(event.mediaRefs), name: text(event.name, 'Tool'), status: text(event.status), summary: text(event.summary), error: text(event.error) })),
}));
const approvals = value => list(value).filter(item => id(item.id) && id(item.chatId) && id(item.runId)).map(item => ({
  ...pick(item, ['id', 'chatId', 'runId']), permission: text(item.permission, 'tool'), summary: text(item.summary), projectName: text(item.projectName), rememberable: false,
}));
const streams = value => list(value).filter(item => id(item.runId) && typeof item.text === 'string').map(item => ({
  ...pick(item, ['runId', 'chatId', 'text', 'sequence', 'lastAssistantId', 'modelCallId', 'metrics']), phase: text(item.phase), progressSummary: text(item.progressSummary),
}));

// Remote metadata never becomes a local path, extension action, or provider setting.
export function remoteCapabilities(value) {
  return Object.fromEntries(['imageReferences','mediaReferences','sceneReferences','steering','workInbox','liveCapture'].map(name=>[name,value?.[name]===true]));
}
export function remoteWorkspace(value) {
  if (!record(value) || !Array.isArray(value.projects) || !Array.isArray(value.chats)) throw new Error('The host returned an invalid workspace.');
  const projects = list(value.projects).filter(item => id(item.id)).map(item => ({ id: item.id, name: text(item.name, 'Project'), archived: item.archived === true }));
  const chats = list(value.chats).filter(item => id(item.id) && id(item.projectId)).map(item => ({
    ...pick(item, ['createdAt', 'lastAssistantAt']), id: item.id, projectId: item.projectId, title: text(item.title, 'Chat'),
    model: text(item.model), providerId: text(item.providerId), providerName: text(item.providerName), status: text(item.status),
    parentChatId: id(item.parentChatId) ? item.parentChatId : null, archived: item.archived === true, readOnly: item.readOnly === true,
  }));
  return { projects, chats, runs: runs(value.runs), approvals: approvals(value.approvals), streams: streams(value.streams),
    capabilities: remoteCapabilities(value.capabilities),
    ...pick(value, ['streamSequence', 'stateRevision', 'revision', 'nextOffset']) };
}

export function remoteChat(value, chatId) {
  if (!record(value) || !record(value.chat) || value.chat.id !== chatId || !Array.isArray(value.chat.messages)) throw new Error('The host returned an invalid chat.');
  const source = value.chat;
  const messages = list(source.messages).filter(item => id(item.id) && ['user', 'assistant', 'tool', 'system'].includes(item.role)).map(item => ({
    ...pick(item, ['id', 'role', 'createdAt', 'runId', 'sourceMessageId', 'modelCallId', 'status', 'toolName', 'toolCallId', 'image', 'fromChatId', 'steering']),
    imageRefs: imageRefs(item.imageRefs), mediaRefs: mediaReferences(item.mediaRefs),
    images: Array.isArray(item.images) ? item.images.filter(image => typeof image === 'string') : [], toolCalls: list(item.toolCalls).map(call => ({ ...pick(call, ['id', 'name', 'args']), ...(record(call.function) ? { function: pick(call.function, ['name', 'arguments']) } : {}) })),
    content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? ''),
  }));
  return { chat: { id: chatId, projectId: source.projectId, title: text(source.title, 'Chat'), parentChatId: id(source.parentChatId) ? source.parentChatId : null,
    archived: source.archived === true, readOnly: source.readOnly === true, messages, inbox: list(source.inbox).filter(item => id(item.id) && item.source === 'user' && typeof item.text === 'string').map(item => ({ ...pick(item, ['id', 'source', 'text', 'createdAt', 'runId']), imageRefs: imageRefs(item.imageRefs), images: Array.isArray(item.images) ? item.images.filter(image => typeof image === 'string') : [] })),
    model: text(source.model), modelName: text(source.modelName), providerId: text(source.providerId), providerName: text(source.providerName), status: text(source.status), ...pick(source, ['createdAt']) },
    runs: runs(value.runs), approvals: approvals(value.approvals), streams: streams(value.streams), ...pick(value, ['streamSequence', 'stateRevision', 'revision', 'before']) };
}

export function remoteLive(value, chatId) {
  if (!record(value) || value.liveOnly !== true || value.chatId !== chatId || !Array.isArray(value.streams) || !id(value.revision)) throw new Error('The host returned an invalid live chat update.');
  return { streams: streams(value.streams), revision: value.revision };
}

export function remoteChatFamilies(workspace, projectId, includeArchived) {
  return orderedChatFamilies({ chats: workspace.chats.filter(chat => includeArchived || !chat.archived).map(chat => ({ ...chat, archived: false })) }, projectId);
}

export function lastSeenLabel(value, now = Date.now()) {
  const stamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(stamp)) return 'Never connected';
  const minutes = Math.max(0, Math.floor((now - stamp) / 60000));
  if (minutes < 1) return 'Last seen just now';
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  if (minutes < 1440) return `Last seen ${Math.floor(minutes / 60)} hr ago`;
  return `Last seen ${Math.floor(minutes / 1440)} days ago`;
}

export function remoteEvent(event, deviceId) {
  return event?.type === 'remoteWorkspace' && event.deviceId === deviceId && record(event.event) ? event.event : null;
}
