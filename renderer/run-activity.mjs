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
  const expanded = new Set();
  function disclosure(key, className) {
    const node = el('details', className); node.open = expanded.has(key);
    node.addEventListener('toggle', () => { node.open ? expanded.add(key) : expanded.delete(key); }); return node;
  }
  return {
    render(state, chatId) {
      const root = el('div', 'run-activities');
      for (const run of state.runs.filter(item => item.chatId === chatId)) {
        const group = relatedRuns(state, run.id), active = group.some(isActive), entries = group.flatMap(item => item.toolEvents || []);
        const detail = disclosure(`run:${run.id}`, 'run-activity'); detail.dataset.runId = run.id;
        const summary = el('summary'); summary.append(el('span', 'run-activity-label', active ? run.status === 'waiting_approval' ? 'Waiting for approval…' : 'Working…' : `Activity · ${statusLabel(run.status)}`), el('span', 'run-activity-count', `${entries.length} tool call${entries.length === 1 ? '' : 's'}`));
        if (active) summary.classList.add('working'); detail.append(summary);
        const tree = el('div', 'run-activity-tree');
        for (const item of group) {
          const branch = el('section', `run-activity-branch${item.id === run.id ? '' : ' child'}`); branch.dataset.agentRunId = item.id;
          if (item.id !== run.id) {
            const title = state.chats.find(chat => chat.id === item.chatId)?.title || 'Child agent';
            branch.append(button(title, () => selectChat(item.chatId), 'text-button'), el('span', 'hint', statusLabel(item.status)));
          }
          const call = item.modelCalls?.at(-1);
          if (isActive(item)) branch.append(el('p', 'hint', item.status === 'waiting_approval' ? 'Waiting for your approval.' : call?.status === 'running' ? 'Receiving the model response…' : 'Preparing the next step…'));
          if (!item.toolEvents?.length && !isActive(item)) branch.append(el('p', 'hint', 'No tool calls recorded for this run.'));
          for (const event of item.toolEvents || []) {
            const tool = disclosure(`tool:${event.id}`, 'run-activity-tool'); tool.dataset.eventId = event.id; const label = toolActivityLabel(event);
            const title = el('summary'); title.append(el('strong', '', label.name), el('span', 'activity-tool-status', label.status)); if (label.detail) title.append(el('span', 'activity-tool-detail', label.detail)); tool.append(title);
            tool.append(el('div', 'activity-detail-label', 'Input'), el('pre', 'result-content', displayText(event.args)));
            if (event.result !== undefined) { tool.append(el('div', 'activity-detail-label', 'Output')); appendResult(tool, event.result); }
            if (event.error) tool.append(el('p', 'error-text', event.error)); branch.append(tool);
          }
          if (item.error) branch.append(el('p', 'error-text', item.error));
          for (const approval of state.approvals.filter(approval => approval.runId === item.id)) {
            const pending = el('div', 'activity-pending-approval'); pending.append(el('strong', '', `Allow ${approval.permission} access?`), el('p', '', approval.summary));
            pending.append(button('Allow this run', () => resolveApproval(approval.id, true)), button('Deny', () => resolveApproval(approval.id, false))); branch.append(pending);
          }
          tree.append(branch);
        }
        detail.append(tree); root.append(detail);
      }
      return root;
    },
  };
}
