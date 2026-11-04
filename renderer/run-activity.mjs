import { displayText, isActive, statusLabel } from './ui-helpers.mjs';

export function toolActivityLabel(event) {
  const args = event.args || {}, detail = args.command ?? args.cmd ?? args.path ?? args.url ?? args.task;
  return { name: event.name || 'Tool', detail: typeof detail === 'string' ? detail : '', status: statusLabel(event.status) };
}
export function modelProgress(run, stream) {
  if (!isActive(run)) return { label: statusLabel(run?.status), title: '', pulse: false };
  if (['waiting_approval', 'awaiting_approval'].includes(run.status)) return { label: 'Waiting for approval…', title: 'Waiting for your approval.', pulse: false };
  const call = run.modelCalls?.at(-1);
  if (stream?.modelCallId && call?.id && stream.modelCallId !== call.id) stream = undefined;
  const phase = stream?.phase || (call?.status === 'running' ? call.phase : undefined);
  const summary = stream?.progressSummary ?? (call?.status === 'running' ? call.progressSummary : undefined);
  const detail = typeof summary === 'string' ? summary.trim() : '';
  if (phase === 'compacting') return { label: detail || 'Condensing earlier context…', title: 'Preparing a context summary. The visible conversation is preserved.', pulse: true };
  if (phase === 'preparing_tools') return { label: detail || 'Preparing tools…', title: 'The provider is preparing a tool request.', pulse: false };
  if (phase === 'responding' || stream?.text?.trim()) return { label: detail || 'Responding…', title: 'Receiving visible model output.', pulse: false };
  if (phase === 'connecting' || phase === 'thinking' || call?.status === 'running') return { label: detail || 'Thinking…', title: detail ? 'Model-reported progress.' : 'Awaiting the model response.', pulse: true };
  return run.toolEvents?.some(isActive) ? { label: 'Running tools…', title: '', pulse: false } : { label: 'Thinking…', title: 'Awaiting the model response.', pulse: true };
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
    get(state, activity, streams = new Map()) {
      let cached = cards.get(activity.id);
      const { run, events, childRuns, active, approvals } = activity;
      const branches = [{ run, events, primary: true }, ...childRuns.map(run => ({ run, events: run.toolEvents || [], title: state.chats.find(chat => chat.id === run.chatId)?.title || 'Child agent' }))];
      const progress = modelProgress(isActive(run) ? run : childRuns.find(isActive), streams.get(isActive(run) ? run.id : childRuns.find(isActive)?.id));
      const signature = JSON.stringify([active, activity.last, approvals, progress, branches.map(item => [item.run.id, item.run.status, item.run.error, modelProgress(item.run, streams.get(item.run.id)), item.events, item.title])]);
      if (!cached) {
        const node = disclosure(`activity:${activity.id}`, 'run-activity'); node.dataset.runId = run.id; node.dataset.activityId = activity.id;
        const summary = el('summary'), label = el('span', 'run-activity-label'); label.setAttribute('role', 'status'); summary.append(label, el('span', 'run-activity-count')); node.append(summary, el('div', 'run-activity-tree'));
        cached = { node }; cards.set(activity.id, cached);
      }
      if (cached.signature === signature) return cached.node;
      cached.signature = signature;
      const node = cached.node, focus = node.contains(document.activeElement) ? document.activeElement : null;
      const status = events.some(event => event.status === 'failed') ? 'failed' : events.some(event => event.status === 'canceled') ? 'canceled' : activity.last && !isActive(run) ? run.status : 'completed';
      node.firstChild.classList.toggle('working', active);
      const label = node.querySelector('.run-activity-label'); label.textContent = active ? approvals.length ? 'Waiting for approval…' : progress.label : `Activity · ${statusLabel(status)}`;
      label.classList.toggle('thinking-pulse', active && !approvals.length && progress.pulse); label.title = active ? progress.title : '';
      const count = branches.reduce((total, item) => total + item.events.length, 0);
      node.querySelector('.run-activity-count').textContent = `${count} tool call${count === 1 ? '' : 's'}`;
      const tree = el('div', 'run-activity-tree');
      for (const item of branches) {
        const branch = el('section', `run-activity-branch${item.primary ? '' : ' child'}`); branch.dataset.agentRunId = item.run.id;
        if (!item.primary) branch.append(button(item.title, () => selectChat(item.run.chatId), 'text-button'), el('span', 'hint', statusLabel(item.run.status)));
        if (isActive(item.run) && (!item.primary || activity.last)) { const progress = modelProgress(item.run, streams.get(item.run.id)), status = el('p', `hint model-progress${progress.pulse ? ' thinking-pulse' : ''}`, progress.label); status.title = progress.title; branch.append(status); }
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
