import { requestGate } from './model-helpers.mjs';

export function addonStatus(addon) {
  return ({ enabled: 'Enabled · trusted local code', disabled: 'Disabled', untrusted: 'Needs trust approval', incompatible: 'Incompatible', error: 'Could not load' })[addon.status] || 'Status unknown';
}
export function addonResetState(addon) {
  return { disabled: Boolean(addon.enabled) || !addon.hasData, title: addon.enabled ? 'Disable before Reset' : addon.hasData ? 'Remove only this addon’s saved data' : 'No saved addon data to reset' };
}
export function addonNotices(state) {
  return [...(state.restartRequired ? ['Restart Faber to finish stopping addon code. Already-loaded code may remain until restart. Use Settings → Restart app when ready.'] : []), ...(state.warnings || []).filter(value => typeof value === 'string')];
}
export function createAddonManager({ request, subscribe, modal, el, button, actions, notify }) {
  let currentBody, currentRefresh, latest = requestGate();
  subscribe?.(event => { if (event.type === 'addons' && currentBody?.querySelector('#addons-list')) currentRefresh?.(); });
  async function show() {
    const body = modal('Local addons'); currentBody = body;
    const intro = el('p', 'hint', 'Install addons from files on this computer. Enabled addons run trusted local code with your user permissions; this is not a sandbox.');
    const status = el('p', 'hint'); status.id = 'addons-status'; status.setAttribute('role', 'status');
    const notices = el('div', 'addon-notices'); notices.id = 'addons-notices'; notices.setAttribute('role', 'status');
    const list = el('div', 'addons-list'); list.id = 'addons-list';
    const controls = el('div', 'addon-imports');
    const change = async (method, params = {}) => { const result = await request(method, params); if (currentBody === body && body.querySelector('#addons-list') === list) await refresh(); return result; };
    const file = button('Import package', () => change('addons.import', { kind: 'file' })); file.id = 'addons-import-file';
    const folder = button('Import folder', () => change('addons.import', { kind: 'folder' })); folder.id = 'addons-import-folder';
    const open = button('Open addons folder', () => request('addons.openDirectory')); open.id = 'addons-open-directory';
    controls.append(file, folder, open); body.append(intro, controls, status, notices, list);
    async function refresh() {
      const valid = latest(); status.textContent = 'Reading installed addons…';
      try {
        const state = await request('addons.list'); if (!valid() || body.querySelector('#addons-list') !== list) return;
        status.textContent = state.directory || 'Local addon folder'; status.classList.remove('error-text'); list.replaceChildren(); notices.replaceChildren();
        for (const message of addonNotices(state)) notices.append(el('p', 'hint', message));
        if (!state.addons.length) list.append(el('p', 'addon-empty hint', 'No addons installed. Import a local folder or .faber-addon.json package to add one.'));
        for (const addon of state.addons) {
          const row = el('section', 'addon-item'); row.dataset.addonId = addon.id;
          const title = el('div', 'addon-title'); title.append(el('h3', '', addon.name || addon.id), el('span', 'hint', addon.version || 'Version unknown'));
          const stateText = el('p', 'addon-status', addonStatus(addon)); row.append(title, stateText, el('p', 'hint', addon.description || 'No description provided.'));
          const details = el('details', 'addon-details'); details.append(el('summary', '', 'Details & data'));
          details.append(el('p', 'hint', `ID: ${addon.id}`), el('p', 'hint', `Declared permissions: ${addon.permissions?.join(', ') || 'None listed'}. Trusted code still has host access.`), el('p', 'hint', 'Uninstall removes the addon but keeps its private data. Reset data removes only this addon’s saved data.'));
          const resetState = addonResetState(addon);
          const reset = button('Reset data', () => change('addons.reset', { id: addon.id }), 'button danger'); reset.dataset.action = 'reset'; reset.disabled = resetState.disabled; reset.title = resetState.title;
          details.append(actions(button('Open addon folder', () => request('addons.openDirectory', { id: addon.id })), reset)); row.append(details);
          if (addon.error) row.append(el('p', 'error-text hint', addon.error));
          const toggle = button(addon.enabled ? 'Disable' : 'Enable', () => change(addon.enabled ? 'addons.disable' : 'addons.enable', { id: addon.id })); toggle.dataset.action = addon.enabled ? 'disable' : 'enable'; toggle.disabled = addon.status === 'incompatible';
          const uninstall = button('Uninstall', () => change('addons.uninstall', { id: addon.id }), 'button danger'); uninstall.dataset.action = 'uninstall';
          const rowActions = actions(toggle, uninstall);
          if (addon.canRollback) { const rollback = button('Restore previous version', () => change('addons.rollback', { id: addon.id })); rollback.dataset.action = 'rollback'; rowActions.prepend(rollback); }
          row.append(rowActions); list.append(row);
        }
      } catch (error) { if (valid()) { status.textContent = error.message || String(error); status.classList.add('error-text'); } }
    }
    const refreshButton = button('Refresh addons', refresh); refreshButton.id = 'addons-refresh'; controls.append(refreshButton);
    currentRefresh = refresh;
    await refresh();
  }
  return { show };
}
