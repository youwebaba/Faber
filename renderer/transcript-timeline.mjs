import { isActive, streamText } from './ui-helpers.mjs';

const callName = call => call.name || call.function?.name;
const callArgs = call => { const value = call.args ?? call.function?.arguments ?? {}; if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };
const time = value => { const stamp = Date.parse(value); return Number.isFinite(stamp) ? stamp : null; };

// Saved message order is authoritative. Run and call IDs anchor new records;
// ordered tool requests and timestamps keep older histories readable as well.
export function transcriptTimeline(state, chatId, streams = new Map()) {
  const messages = (state.chats.find(chat => chat.id === chatId)?.messages || []).filter(message => message.role !== 'system');
  const runs = state.runs.filter(run => run.chatId === chatId), slots = new Map(), representedCalls = new Set(), representedMessages = new Set();
  const owner = message => runs.find(run => run.id === message.runId) || (message.runId ? undefined : runs.findLast(run => time(message.createdAt) !== null && time(run.startedAt) !== null && time(message.createdAt) >= time(run.startedAt)));
  const slotAt = stamp => { const at = time(stamp); if (at === null) return messages.length; let slot = 0; for (let i = 0; i < messages.length; i++) if (time(messages[i].createdAt) !== null && time(messages[i].createdAt) <= at) slot = i + 1; return slot; };
  const add = (slot, activity) => { if (!slots.has(slot)) slots.set(slot, []); slots.get(slot).push({ kind: 'activity', key: activity.id, activity }); };
  for (const run of runs) {
    const used = new Set(), batches = [];
    for (const [index, message] of messages.entries()) {
      if (message.role !== 'assistant' || !message.toolCalls?.length || owner(message)?.id !== run.id) continue;
      const events = message.toolCalls.map(call => {
        representedCalls.add(call.id);
        let event = (run.toolEvents || []).find(item => !used.has(item.id) && item.toolCallId === call.id);
        if (!event) event = (run.toolEvents || []).find(item => !used.has(item.id) && !item.toolCallId && item.name === callName(call));
        if (event) { used.add(event.id); return event; }
        const result = messages.find(item => item.role === 'tool' && item.toolCallId === call.id);
        let output = result?.content; try { output = JSON.parse(output); } catch { /* Ordinary text result. */ }
        return { id: `call:${call.id}`, toolCallId: call.id, name: callName(call), args: callArgs(call), status: result ? output?.error ? 'failed' : result.status || 'completed' : isActive(run) ? 'queued' : 'interrupted', ...(result ? { result: output, image: result.image, imageRefs: result.imageRefs, mediaRefs: result.mediaRefs } : {}) };
      });
      representedMessages.add(message.id);
      batches.push({ id: `${run.id}:step:${batches.length}`, run, events, slot: index + 1, at: message.createdAt, childRuns: [] });
    }
    for (const event of run.toolEvents || []) if (!used.has(event.id)) batches.push({ id: `${run.id}:event:${event.id}`, run, events: [event], slot: slotAt(event.startedAt || run.startedAt), at: event.startedAt || run.startedAt, childRuns: [] });
    const children = state.runs.filter(child => child.parentRunId === run.id);
    if (!batches.length && (isActive(run) || children.length)) batches.push({ id: `${run.id}:step:0`, run, events: [], slot: run.requestMessageId && messages.some(message => message.id === run.requestMessageId) ? messages.findIndex(message => message.id === run.requestMessageId) + 1 : slotAt(run.startedAt), at: run.startedAt, childRuns: [] });
    for (const child of children) {
      const batch = batches.find(item => item.events.some(event => event.result?.runId === child.id)) || batches.findLast(item => time(item.at) !== null && time(child.startedAt) !== null && time(item.at) <= time(child.startedAt)) || batches[0];
      if (batch) {
        const ids = new Set([child.id]);
        for (let changed = true; changed;) { changed = false; for (const nested of state.runs) if (ids.has(nested.parentRunId) && !ids.has(nested.id)) { ids.add(nested.id); changed = true; } }
        batch.childRuns.push(...state.runs.filter(item => ids.has(item.id)));
      }
    }
    for (const [index, batch] of batches.entries()) {
      batch.active = index === batches.length - 1 && isActive(run) || batch.childRuns.some(isActive);
      batch.last = index === batches.length - 1;
      batch.approvals = state.approvals.filter(item => item.runId === run.id && index === batches.length - 1 || batch.childRuns.some(child => child.id === item.runId));
      add(batch.slot, batch);
    }
  }
  const promptIds = new Set(runs.flatMap(run => (run.promptUsage || []).map(row => row.requestMessageId)));
  for (const run of runs) for (const usage of run.promptUsage || []) {
    const start = messages.findIndex(message => message.id === usage.requestMessageId);
    if (start < 0 || usage.status === 'pending' || isActive(run) && usage === run.promptUsage.at(-1)) continue;
    const next = messages.findIndex((message, index) => index > start && message.role === 'user' && (!message.steering || promptIds.has(message.id)));
    const slot = next < 0 ? messages.length : next;
    if (!slots.has(slot)) slots.set(slot, []);
    slots.get(slot).push({ kind: 'usage', key: `usage:${run.id}:${usage.requestMessageId}`, usage });
  }
  const rows = [];
  for (let index = 0; index <= messages.length; index++) {
    rows.push(...slots.get(index) || []);
    const message = messages[index]; if (!message) continue;
    if (message.role === 'tool' && representedCalls.has(message.toolCallId)) continue;
    if (representedMessages.has(message.id) && !message.content && !message.images?.length && !message.mediaRefs?.length) continue;
    rows.push({ kind: 'message', key: message.id, message });
  }
  for (const run of runs.filter(isActive)) {
    const stream = streams.get(run.id), text = stream?.phase === 'compacting' ? '' : streamText(stream?.text, run, messages);
    if (text) rows.push({ kind: 'stream', key: run.id, run, text });
  }
  return rows;
}

export function reconcileTranscript(parent, nodes) {
  const allowed = new Set(nodes);
  for (const node of [...parent.children]) if (!allowed.has(node)) node.remove();
  let cursor = parent.firstChild;
  for (const node of nodes) { if (node !== cursor) { if (node.parentNode === parent && parent.moveBefore) parent.moveBefore(node, cursor); else parent.insertBefore(node, cursor); } cursor = node.nextSibling; }
}

export function preserveTranscriptViewport(parent, update) {
  const previousScroll = parent.scrollTop, following = parent.scrollHeight - previousScroll - parent.clientHeight <= 8;
  const top = parent.getBoundingClientRect().top;
  const anchor = [...parent.children].find(node => node.getBoundingClientRect().bottom > top);
  const offset = anchor?.getBoundingClientRect().top;
  update();
  if (following) parent.scrollTop = parent.scrollHeight;
  else parent.scrollTop = previousScroll + (anchor?.isConnected ? anchor.getBoundingClientRect().top - offset : 0);
}
