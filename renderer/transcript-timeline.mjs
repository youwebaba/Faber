import { displayText, isActive } from './ui-helpers.mjs';
import { updateStreamContent } from './rich-content.mjs';

const callName = call => call.name || call.function?.name;
const callArgs = call => { const value = call.args ?? call.function?.arguments ?? {}; if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };
const time = value => { const stamp = Date.parse(value); return Number.isFinite(stamp) ? stamp : null; };

// Saved message order is authoritative. Run and call IDs anchor new records;
// ordered tool requests and timestamps keep older histories readable as well.
export function transcriptTimeline(state, chatId, streams = new Map(), live = indexLiveTranscript(state, chatId)) {
  const messages = (state.chats.find(chat => chat.id === chatId)?.messages || []).filter(message => message.role !== 'system');
  const runs = state.runs.filter(run => run.chatId === chatId), slots = new Map(), representedCalls = new Set(), representedMessages = new Set();
  const runsById = new Map(runs.map(run => [run.id, run]));
  const messageIndex = new Map(messages.map((message, index) => [message.id, index]));
  const toolMessages = new Map(), results = new Map(), childrenByParent = new Map();
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool' && !results.has(message.toolCallId)) results.set(message.toolCallId, message);
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    const run = message.runId ? runsById.get(message.runId) : runs.findLast(item => time(message.createdAt) !== null && time(item.startedAt) !== null && time(message.createdAt) >= time(item.startedAt));
    if (run) { if (!toolMessages.has(run.id)) toolMessages.set(run.id, []); toolMessages.get(run.id).push([index, message]); }
  }
  for (const child of state.runs) if (child.parentRunId) {
    if (!childrenByParent.has(child.parentRunId)) childrenByParent.set(child.parentRunId, []);
    childrenByParent.get(child.parentRunId).push(child);
  }
  const slotAt = stamp => { const at = time(stamp); if (at === null) return messages.length; let slot = 0; for (let i = 0; i < messages.length; i++) if (time(messages[i].createdAt) !== null && time(messages[i].createdAt) <= at) slot = i + 1; return slot; };
  const add = (slot, activity) => { if (!slots.has(slot)) slots.set(slot, []); slots.get(slot).push({ kind: 'activity', key: activity.id, activity }); };
  for (const run of runs) {
    const used = new Set(), batches = [];
    for (const [index, message] of toolMessages.get(run.id) || []) {
      const events = message.toolCalls.map(call => {
        representedCalls.add(call.id);
        let event = (run.toolEvents || []).find(item => !used.has(item.id) && item.toolCallId === call.id);
        if (!event) event = (run.toolEvents || []).find(item => !used.has(item.id) && !item.toolCallId && item.name === callName(call));
        if (event) { used.add(event.id); return event; }
        const result = results.get(call.id);
        let output = result?.content; try { output = JSON.parse(output); } catch { /* Ordinary text result. */ }
        return { id: `call:${call.id}`, toolCallId: call.id, name: callName(call), args: callArgs(call), status: result ? output?.error ? 'failed' : result.status || 'completed' : isActive(run) ? 'queued' : 'interrupted', ...(result ? { result: output, image: result.image, imageRefs: result.imageRefs, mediaRefs: result.mediaRefs } : {}) };
      });
      representedMessages.add(message.id);
      batches.push({ id: `${run.id}:step:${batches.length}`, run, events, slot: index + 1, at: message.createdAt, childRuns: [] });
    }
    for (const event of run.toolEvents || []) if (!used.has(event.id)) batches.push({ id: `${run.id}:event:${event.id}`, run, events: [event], slot: slotAt(event.startedAt || run.startedAt), at: event.startedAt || run.startedAt, childRuns: [] });
    const children = childrenByParent.get(run.id) || [];
    if (!batches.length && (isActive(run) || children.length)) batches.push({ id: `${run.id}:step:0`, run, events: [], slot: messageIndex.has(run.requestMessageId) ? messageIndex.get(run.requestMessageId) + 1 : slotAt(run.startedAt), at: run.startedAt, childRuns: [] });
    for (const child of children) {
      const batch = batches.find(item => item.events.some(event => event.result?.runId === child.id)) || batches.findLast(item => time(item.at) !== null && time(child.startedAt) !== null && time(item.at) <= time(child.startedAt)) || batches[0];
      if (batch) {
        const ids = new Set([child.id]);
        for (const id of ids) for (const nested of childrenByParent.get(id) || []) ids.add(nested.id);
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
    const start = messageIndex.get(usage.requestMessageId);
    if (start === undefined || usage.status === 'pending' || isActive(run) && usage === run.promptUsage.at(-1)) continue;
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
  for (const run of live.runs) { const text = live.text(run, streams); if (text) rows.push({ kind: 'stream', key: run.id, run, text }); }
  return rows;
}

// Rebuilt with durable history. Provider deltas consult only the active runs.
export function indexLiveTranscript(state, chatId) {
  const runs = state.runs.filter(run => run.chatId === chatId && isActive(run));
  const replies = new Map(runs.map(run => [run.id, new Set()]));
  const messages = state.chats.find(chat => chat.id === chatId)?.messages || [];
  if (runs.length) for (const message of messages) {
    if (message.role !== 'assistant' || !message.content) continue;
    for (const run of runs) if (message.createdAt >= run.startedAt) replies.get(run.id).add(displayText(message.content));
  }
  return { runs, text(run, streams) {
    const stream = streams.get(run.id);
    return stream?.phase !== 'compacting' && stream?.text && !replies.get(run.id).has(stream.text) ? stream.text : '';
  } };
}

export function pruneStreamNodes(nodes, rows) {
  const visible = new Set(rows.filter(row => row.kind === 'stream').map(row => row.key));
  for (const key of nodes.keys()) if (!visible.has(key)) nodes.delete(key);
}

export function createLiveTranscript({el,bindContent,onOpenLink}) {
  const nodes = new Map(); let index, activeCards;
  function row(run,text) {
    let article=nodes.get(run.id);
    if (!article) { article=el('article','message assistant streaming'); article.dataset.runId=run.id; article.append(el('div','message-heading','Faber'),el('div','message-content')); nodes.set(run.id,article); }
    if (article.lastChild.streamContent?.text !== text) {
      updateStreamContent(article.lastChild,text,{onOpenLink});
      bindContent(article,{chatId:run.chatId,text});
    }
    return article;
  }
  return {
    row, reset() { nodes.clear(); index=activeCards=undefined; },
    timeline(state,chatId,streams) {
      index=indexLiveTranscript(state,chatId);
      const rows=transcriptTimeline(state,chatId,streams,index);
      activeCards=rows.filter(item=>item.kind==='activity' && item.activity.active).map(item=>item.activity);
      pruneStreamNodes(nodes,rows);
      return rows;
    },
    update(parent,streams,updateActivity) {
      if (!index) return false;
      const active=index.runs.map(run=>({run,text:index.text(run,streams)}));
      if (active.some(({run,text})=>Boolean(text)!==nodes.has(run.id))) return false;
      preserveTranscriptViewport(parent,()=>{
        for (const {run,text} of active) if (text) row(run,text);
        for (const card of activeCards) updateActivity(card);
      },true);
      return true;
    }
  };
}

export function reconcileTranscript(parent, nodes) {
  const allowed = new Set(nodes);
  for (const node of [...parent.children]) if (!allowed.has(node)) node.remove();
  let cursor = parent.firstChild;
  for (const node of nodes) { if (node !== cursor) { if (node.parentNode === parent && parent.moveBefore) parent.moveBefore(node, cursor); else parent.insertBefore(node, cursor); } cursor = node.nextSibling; }
}

export function preserveTranscriptViewport(parent, update, live = false) {
  const previousScroll = parent.scrollTop, following = parent.scrollHeight - previousScroll - parent.clientHeight <= 8;
  if (following) { update(); parent.scrollTop=parent.scrollHeight; return; }
  const bounds = parent.getBoundingClientRect();
  let anchor;
  if (live) {
    const point = parent.ownerDocument.elementFromPoint(bounds.left + bounds.width/2, Math.max(0,bounds.top)+1);
    if (point && point!==parent && parent.contains(point)) { anchor=point; while (anchor.parentNode!==parent) anchor=anchor.parentNode; }
  } else anchor=[...parent.children].find(node => node.getBoundingClientRect().bottom > bounds.top);
  const offset = anchor?.getBoundingClientRect().top;
  update();
  parent.scrollTop = previousScroll + (anchor?.isConnected ? anchor.getBoundingClientRect().top - offset : 0);
}
