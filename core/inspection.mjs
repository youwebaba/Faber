const inspections = new Set(['chat_read', 'agent_read', 'agent_wait']);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const marker = { inspectionVersion: 1 };

export function inspectionCalls(chat) {
  return new Map(chat.messages.flatMap(message => message.toolCalls || []).filter(call => inspections.has(call.name)).map(call => [call.id, call]));
}

function reference(chat, message, call) {
  return { ...marker, reference: { chatId: chat.id, messageId: message.id, tool: call.name, arguments: call.args }, note: 'Inspection snapshot is represented by reference to avoid embedding another transcript. Use chat_read messageIds or agent_read toolEventIds to retrieve original non-inspection content.' };
}

// Only recognized inspection tool results are projected. Ordinary text, actual
// assistant protocol items and the durable transcript are never rewritten.
export function inspectionContent(chat, message, calls, selecting = false) {
  const call = calls.get(message.toolCallId);
  if (message.role !== 'tool' || !call || call.name !== message.toolName) return message.content;
  try {
    const value = JSON.parse(message.content);
    if (value?.error || (!selecting && value?.inspectionVersion === 1)) return message.content;
  } catch { return message.content; }
  return JSON.stringify(reference(chat, message, call));
}

function messageView(chat, message, calls, selected) {
  const view = { ...pick(message, ['id', 'role', 'createdAt', 'toolName', 'toolCallId', 'status', 'runId']), contentChars: message.content?.length || 0, imageCount: (message.images?.length || 0) + (message.image ? 1 : 0) };
  if (selected) {
    view.content = inspectionContent(chat, message, calls, true);
    if (message.toolCalls) view.toolCalls = structuredClone(message.toolCalls);
  }
  return view;
}

export function chatInspection(chat, messageIds, requesterChatId, finalRunId) {
  const calls = inspectionCalls(chat), selected = messageIds ? new Set(messageIds) : null;
  if (selected) for (const id of selected) if (!chat.messages.some(message => message.id === id)) throw new Error(`Unknown message: ${id}`);
  const final = chat.messages.findLast(message => message.role === 'assistant' && !message.toolCalls?.length && message.status === 'completed' && (!finalRunId || message.runId === finalRunId));
  return {
    ...marker, chat: pick(chat, ['id', 'projectId', 'title', 'providerId', 'model', 'archived', 'parentChatId']),
    messages: chat.messages.filter(message => !selected || selected.has(message.id)).map(message => messageView(chat, message, calls, !!selected)),
    ...(final ? { finalReply: messageView(chat, final, calls, requesterChatId !== chat.id && !selected?.has(final.id)) } : {}),
    read: 'Pass messageIds to chat_read for full selected text. Inspection results remain references; provider protocol data and image bytes are not transcript text.',
  };
}

function resultView(result, runId, toolEventId) {
  const view = structuredClone(result);
  if (typeof view?.image === 'string' && /^data:image\//.test(view.image)) {
    view.image = '[Stored image; not embedded as transcript text]';
    view.imageReference = { runId, toolEventId };
  }
  return view;
}

export function agentInspection(run, chat, toolEventIds, requesterChatId) {
  const selected = toolEventIds ? new Set(toolEventIds) : null;
  if (selected) for (const id of selected) if (!run.toolEvents.some(event => event.id === id)) throw new Error(`Unknown tool event: ${id}`);
  return {
    ...chatInspection(chat, undefined, requesterChatId, run.id), run: pick(run, ['id', 'chatId', 'providerId', 'model', 'parentRunId', 'status', 'startedAt', 'endedAt', 'error']),
    toolEvents: run.toolEvents.filter(event => !selected || selected.has(event.id)).map(event => ({
      ...pick(event, ['id', 'name', 'status', 'startedAt', 'endedAt', 'error']),
      ...(selected ? inspections.has(event.name)
        ? { reference: { runId: run.id, toolEventId: event.id, tool: event.name, arguments: event.args }, note: 'Nested inspection; retrieve original messages or non-inspection tool results.' }
        : { args: structuredClone(event.args), ...(event.result !== undefined ? { result: resultView(event.result, run.id, event.id) } : {}) } : {}),
    })),
    read: 'Use chat_read with chatId/messageIds for text or agent_read with runId/toolEventIds for selected tool results. Results are never duplicated inside run metadata.',
  };
}
