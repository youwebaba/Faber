import { displayText, isActive, statusLabel } from './ui-helpers.mjs';

export function relatedRuns(state, runId) {
  const ids = new Set([runId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const run of state.runs) if (ids.has(run.parentRunId) && !ids.has(run.id)) { ids.add(run.id); changed = true; }
  }
  return state.runs.filter(run => ids.has(run.id));
}
export function toolActivityLabel(event) {
  const args = event.args || {}, detail = args.command ?? args.cmd ?? args.path ?? args.url ?? args.task;
  return { name: event.name || 'Tool', detail: typeof detail === 'string' ? detail : '', status: statusLabel(event.status) };
}
export function createRunActivity({ el, button, appendResult, selectChat, resolveApproval }) {
  const cards = new Map(), tools = new Map(), expanded = new Set();
  function disclosure(key, className) {
    const node = el('details', className); node.open = expanded.has(key);
    node.addEventListener('toggle', () => { node.open ? expanded.add(key) : expanded.delete(key); }); return node;
  }
  function toolNode(event, runId) {
    const key = `${runId}:${event.toolCallId || event.id}`, signature = JSON.stringify(event); let cached = tools.get(key);
    if (!cached) { cached = { node: disclosure(`tool:${key}`, 'run-activity-tool') }; tools.set(key, cached); }
    cached.node.dataset.eventId = event.id;
    if (cached.signature !== signature) {
      cached.signature = signature; const tool = cached.node, label = toolActivityLabel(event);
      const title = el('summary'); title.append(el('strong', '', label.name), el('span', 'activity-tool-status', label.status)); if (label.detail) title.append(el('span', 'activity-tool-detail', label.detail));
      tool.replaceChildren(title, el('div', 'activity-detail-label', 'Input'), el('pre', 'result-content', displayText(event.args)));
      if (event.result !== undefined) { tool.append(el('div', 'activity-detail-label', 'Output')); appendResult(tool, event.result, event.image); }
      if (event.error) tool.append(el('p', 'error-text', event.error));
    }
    return cached.node;
  }
  return {
    get(state, activity) {
      let cached = cards.get(activity.id);
      if (cached?.state === state) return cached.node;
      const { run, events, childRuns, active, approvals } = activity;
      const branches = [{ run, events, primary: true }, ...childRuns.map(run => ({ run, events: run.toolEvents || [], title: state.chats.find(chat => chat.id === run.chatId)?.title || 'Child agent' }))];
      const signature = JSON.stringify([active, activity.last, approvals, branches.map(item => [item.run.id, item.run.status, item.run.error, item.run.modelCalls?.at(-1)?.status, item.events, item.title])]);
      if (!cached) {
        const node = disclosure(`activity:${activity.id}`, 'run-activity'); node.dataset.runId = run.id; node.dataset.activityId = activity.id;
        const summary = el('summary'); summary.append(el('span', 'run-activity-label'), el('span', 'run-activity-count')); node.append(summary, el('div', 'run-activity-tree'));
        cached = { node }; cards.set(activity.id, cached);
      }
      cached.state = state;
      if (cached.signature === signature) return cached.node;
      cached.signature = signature;
      const node = cached.node, focus = node.contains(document.activeElement) ? document.activeElement : null;
      const status = events.some(event => event.status === 'failed') ? 'failed' : events.some(event => event.status === 'canceled') ? 'canceled' : activity.last && !isActive(run) ? run.status : 'completed';
      node.firstChild.classList.toggle('working', active);
      node.querySelector('.run-activity-label').textContent = active ? approvals.length ? 'Waiting for approval…' : 'Working…' : `Activity · ${statusLabel(status)}`;
      const count = branches.reduce((total, item) => total + item.events.length, 0);
      node.querySelector('.run-activity-count').textContent = `${count} tool call${count === 1 ? '' : 's'}`;
      const tree = el('div', 'run-activity-tree');
      for (const item of branches) {
        const branch = el('section', `run-activity-branch${item.primary ? '' : ' child'}`); branch.dataset.agentRunId = item.run.id;
        if (!item.primary) branch.append(button(item.title, () => selectChat(item.run.chatId), 'text-button'), el('span', 'hint', statusLabel(item.run.status)));
        if (isActive(item.run) && (!item.primary || activity.last)) branch.append(el('p', 'hint', item.run.status === 'waiting_approval' ? 'Waiting for your approval.' : item.run.modelCalls?.at(-1)?.status === 'running' ? 'Receiving the model response…' : 'Preparing the next step…'));
        for (const event of item.events) branch.append(toolNode(event, item.run.id));
        if (item.run.error && (!item.primary || activity.last)) branch.append(el('p', 'error-text', item.run.error));
        for (const approval of approvals.filter(approval => approval.runId === item.run.id)) {
          const pending = el('div', 'activity-pending-approval'); pending.append(el('strong', '', `Allow ${approval.permission} access?`), el('p', '', approval.summary));
          pending.append(button('Allow this run', () => resolveApproval(approval.id, true)), button('Deny', () => resolveApproval(approval.id, false))); branch.append(pending);
        }
        tree.append(branch);
      }
      node.lastChild.replaceWith(tree);
      if (focus?.isConnected) focus.focus({ preventScroll: true });
      return node;
    },
    reset() { for (const [key, entry] of cards) { if (entry.node.open) expanded.add(`activity:${key}`); } for (const [key, entry] of tools) if (entry.node.open) expanded.add(`tool:${key}`); cards.clear(); tools.clear(); },
  };
}
