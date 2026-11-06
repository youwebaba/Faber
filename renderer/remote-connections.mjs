import { lastSeenLabel } from './remote-state.mjs';
import { createRemoteWorkspace } from './remote-workspace.mjs';

export function createRemoteConnections({ request, subscribe, el, field, closeModal, showConnections, suspendLocal = () => {}, onChange = () => {}, document = globalThis.document }) {
  let status, panel, tab = 'host', timer, pending = false, loading, invitation, error = '', pairDraft = '', relayDraft = '', nameDraft = '';
  const hosts = () => (status?.devices || []).filter(device => device.role === 'host');
  const workspace = createRemoteWorkspace({ request, subscribe, el, getDevices: hosts, showConnections, suspendLocal, onChange: () => { schedule(); onChange(); }, document });
  const button = (label, callback, className = 'button') => { const node = el('button', className, label); node.type = 'button'; node.addEventListener('click', async () => { if (pending) return; pending = true; node.disabled = true; try { error = ''; await callback(); } catch (cause) { error = cause.message || String(cause); } finally { pending = false; if (panel?.isConnected) update(); onChange(); } }); return node; };
  const time = value => Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  function accept(value) {
    if (!value || typeof value !== 'object' || !value.config || !Array.isArray(value.devices) || !Array.isArray(value.pending)) throw new Error('Connections status is unavailable.');
    status = { ...value, devices: value.devices.filter(device => device && typeof device.id === 'string' && ['host', 'controller'].includes(device.role)).map(device => ({ ...device, name: typeof device.name === 'string' ? device.name : typeof device.deviceName === 'string' ? device.deviceName : 'Device', online: device.online === true })), pending: value.pending.filter(item => item && typeof item.id === 'string') };
    workspace.updateDevices(); if (panel?.isConnected) update();
  }
  async function load() { if (loading) return loading; loading = request('remote.status', {}).then(accept); try { await loading; } finally { loading = undefined; schedule(); } }
  function schedule() {
    clearTimeout(timer);
    if (!(panel?.isConnected && panel.closest('dialog')?.open) && !workspace.isOpen() && !hosts().length) return;
    timer = setTimeout(async () => { try { await load(); } catch (cause) { error = cause.message || String(cause); if (panel?.isConnected) update(); } schedule(); }, 5000); timer.unref?.();
  }
  async function change(method, params) { const result = await request(`remote.${method}`, params); if (result?.config && Array.isArray(result.devices)) accept(result); else await load(); return result; }
  function row(name, description, controls, className = '') {
    const node = el('div', `remote-device-row ${className}`), text = el('div', 'remote-device-info'); text.append(el('strong', '', name), el('small', '', description)); node.append(text, controls); return node;
  }
  function controls(...children) { const node = el('div', 'remote-device-actions'); node.append(...children); return node; }
  function switchRow(label, description, checked, id, callback) {
    const input = el('input'); input.type = 'checkbox'; input.id = id; input.checked = checked; input.defaultChecked = checked; input.setAttribute('role', 'switch');
    const wrapper = el('label', 'remote-switch-row'); wrapper.htmlFor = id; const text = el('span'); text.append(el('strong', '', label), el('small', '', description)); wrapper.append(text, input);
    input.addEventListener('change', async () => { if (pending) return; pending = true; input.disabled = true; try { error = ''; await callback(input.checked); } catch (cause) { error = cause.message || String(cause); } finally { pending = false; update(); onChange(); } }); return { wrapper, input };
  }
  function build() {
    if (!panel?.isConnected) return;
    panel.replaceChildren(); panel.append(el('h3', 'remote-page-title', 'Connections'), el('p', 'hint', 'Connect your computers and work with Faber wherever you are.'));
    const tabs = el('div', 'remote-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Device connections');
    for (const [id, label] of [['host', 'Control this PC'], ['controller', 'Control other devices']]) {
      const item = el('button', tab === id ? 'selected' : '', label); item.type = 'button'; item.id = `remote-tab-${id}`; item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(tab === id)); item.setAttribute('aria-controls', `remote-panel-${id}`); item.tabIndex = tab === id ? 0 : -1;
      item.addEventListener('click', () => { tab = id; build(); panel.querySelector(`#remote-tab-${id}`)?.focus(); });
      item.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); tab = event.key === 'Home' ? 'host' : event.key === 'End' ? 'controller' : tab === 'host' ? 'controller' : 'host'; build(); panel.querySelector(`#remote-tab-${tab}`)?.focus(); } }); tabs.append(item);
    }
    panel.append(tabs);
    const body = el('section', 'remote-connection-panel'); body.id = `remote-panel-${tab}`; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', `remote-tab-${tab}`); panel.append(body);
    if (tab === 'host') {
      body.append(el('h4', '', 'Your workspace, on this PC'), el('p', 'hint', 'Allow trusted computers to use this PC’s projects, chats, agents and models. New devices need your approval here.'));
      const allow = switchRow('Allow connections', 'Off by default. Turn on to make this PC available to your paired devices.', status?.config?.allowConnections === true, 'remote-allow-connections', value => change('configure', { allowConnections: value }));
      const awake = switchRow('Keep this PC awake while plugged in', 'Optional. Applies while connections are enabled and this PC is on AC power.', status?.config?.keepAwake === true, 'remote-keep-awake', value => change('configure', { keepAwake: value })); body.append(allow.wrapper, awake.wrapper);
      const hostStatus = el('p', 'hint'); hostStatus.id = 'remote-host-status'; body.append(hostStatus);
      const inviteActions = el('div', 'remote-invite-actions'), inviteButton = button('Pair another computer', async () => { invitation = await change('invite', {}); }); inviteButton.id = 'remote-create-invite'; inviteActions.append(inviteButton); body.append(inviteActions);
      const invite = el('div', 'remote-invitation'); invite.id = 'remote-invitation'; body.append(invite);
      const pendingTitle = el('h4', '', 'Approval requests'), pendingList = el('div'); pendingList.id = 'remote-pending-devices'; pendingTitle.id = 'remote-pending-title'; body.append(pendingTitle, pendingList);
      body.append(el('h4', '', 'Allowed devices')); const devices = el('div'); devices.id = 'remote-controller-devices'; body.append(devices);
      const advanced = el('details', 'remote-advanced'); advanced.append(el('summary', '', 'Relay settings'));
      const relay = field('Relay server', relayDraft || status?.config?.relayUrl || '', 'url', 'Use the secure WSS relay supplied by the operator. Pairing invitations carry this address to your other PC.'); relay.input.id = 'remote-relay-url'; relay.input.placeholder = 'wss://relay.example.com'; relay.input.addEventListener('input', () => { relayDraft = relay.input.value; onChange(); });
      const route = el('p', 'hint remote-route'); route.id = 'remote-host-route';
      const deviceName = field('This PC’s name', nameDraft || status?.deviceName || '', 'text'); deviceName.input.id = 'remote-device-name'; deviceName.input.addEventListener('input', () => { nameDraft = deviceName.input.value; onChange(); });
      const save = button('Save relay settings', async () => { await change('configure', { relayUrl: relay.input.value.trim(), deviceName: deviceName.input.value.trim() }); relayDraft = nameDraft = ''; relay.input.defaultValue = relay.input.value; deviceName.input.defaultValue = deviceName.input.value; }); save.id = 'remote-save-relay'; advanced.append(relay.wrapper, deviceName.wrapper, route, save); body.append(advanced);
    } else {
      body.append(el('h4', '', 'Your other computers'), el('p', 'hint', 'Open Faber on the host PC, enable connections and create an invite. Paste it here, then approve this device on the host. Models and files stay on that computer.'));
      const form = el('form', 'remote-pair-form'), invite = field('Pairing invite', pairDraft, 'textarea'); invite.input.id = 'remote-pair-invite'; invite.input.autocomplete = 'off'; invite.input.spellcheck = false; invite.input.rows = 3; invite.input.addEventListener('input', () => { pairDraft = invite.input.value; onChange(); });
      const pair = button('Pair device', async () => { if (!invite.input.value.trim()) throw new Error('Paste an invite from your host PC.'); await change('pair', { invite: invite.input.value.trim() }); invite.input.value = pairDraft = ''; }); pair.id = 'remote-pair-device'; form.append(invite.wrapper, pair); form.addEventListener('submit', event => { event.preventDefault(); pair.click(); }); body.append(form);
      const pairing = el('p', 'hint'); pairing.id = 'remote-pairing-status'; pairing.setAttribute('role', 'status'); body.append(pairing);
      body.append(el('h4', '', 'Paired computers')); const devices = el('div'); devices.id = 'remote-host-devices'; body.append(devices);
    }
    const clearDrafts = button('Clear unsent remote drafts', () => workspace.clearDrafts()); clearDrafts.id = 'remote-clear-drafts'; body.append(clearDrafts);
    const result = el('p', 'remote-connection-error error-text'); result.id = 'remote-connection-error'; result.setAttribute('role', 'status'); body.append(result); update();
  }
  function updateRows(container, signature, callback) { if (!container || container.signature === signature) return; container.signature = signature; container.replaceChildren(); callback(container); }
  function update() {
    if (!panel?.isConnected) return;
    const result = panel.querySelector('#remote-connection-error'); result.textContent = error; result.hidden = !error;
    const clearDrafts = panel.querySelector('#remote-clear-drafts'); clearDrafts.hidden = !workspace.hasDrafts(); clearDrafts.disabled = pending;
    const config = status?.config || {}; for (const [id, key] of [['remote-allow-connections', 'allowConnections'], ['remote-keep-awake', 'keepAwake']]) { const input = panel.querySelector(`#${id}`); if (input) { input.checked = input.defaultChecked = config[key] === true; input.disabled = pending || !status; } }
    const hostStatus = panel.querySelector('#remote-host-status'); if (hostStatus) hostStatus.textContent = !status ? 'Loading connections…' : !config.allowConnections ? 'Connections are off. This PC is unavailable to other devices.' : status.hosting?.state === 'online' ? `This PC is available${status.keepAwake?.active ? ' · Keeping awake on AC power' : ''}.` : status.hosting?.error || `Host ${status.hosting?.state || 'connecting'}…`;
    const inviteButton = panel.querySelector('#remote-create-invite'); if (inviteButton) inviteButton.disabled = pending || !config.allowConnections || status?.hosting?.state !== 'online';
    const invite = panel.querySelector('#remote-invitation'); updateRows(invite, JSON.stringify(invitation), node => {
      if (!invitation?.invite) return; const value = field('Invite for your other computer', invitation.invite, 'textarea'); value.input.id = 'remote-invite-value'; value.input.readOnly = true; value.input.spellcheck = false;
      node.append(value.wrapper, el('p', 'hint', `Expires at ${time(invitation.expiresAt)}. Share only with the device you want to approve.`), button('Copy invite', async () => { await globalThis.navigator.clipboard.writeText(invitation.invite); }));
    });
    const pendingList = panel.querySelector('#remote-pending-devices'); updateRows(pendingList, JSON.stringify([pending, status?.pending]), node => {
      for (const device of status?.pending || []) { const allow = button('Approve device', () => change('approve', { id: device.id, allow: true }), 'button primary'), deny = button('Deny', () => change('approve', { id: device.id, allow: false })); allow.disabled = deny.disabled = pending;
        node.append(row(typeof device.deviceName === 'string' ? device.deviceName : device.name || 'New device', `Wants access to this PC${device.expiresAt ? ` · Expires at ${time(device.expiresAt)}` : ''}`, controls(allow, deny), 'remote-pending')); }
    });
    const pendingTitle = panel.querySelector('#remote-pending-title'); if (pendingTitle) pendingTitle.hidden = !status?.pending?.length;
    const controllerList = panel.querySelector('#remote-controller-devices'), controllers = (status?.devices || []).filter(device => device.role === 'controller');
    updateRows(controllerList, JSON.stringify([pending, controllers]), node => { if (!controllers.length) node.append(el('p', 'remote-empty', 'No devices have access to this PC.')); for (const device of controllers) { const revoke = button('Revoke', () => change('revoke', { id: device.id }), 'button danger'); revoke.disabled = pending; node.append(row(device.name, `${device.online ? 'Connected' : 'Offline'} · ${lastSeenLabel(device.lastSeen ?? device.lastSeenAt)}`, controls(revoke))); } });
    const hostList = panel.querySelector('#remote-host-devices'); updateRows(hostList, JSON.stringify([pending, hosts()]), node => { if (!hosts().length) node.append(el('p', 'remote-empty', 'Paired computers will appear here.')); for (const device of hosts()) {
      const open = button('Open workspace', () => { closeModal(); workspace.open(device.id); }); open.disabled = pending;
      const forget = button('Forget', () => change('forget', { id: device.id })); forget.disabled = pending; node.append(row(device.name, `${device.online ? 'Online' : 'Offline'} · ${lastSeenLabel(device.lastSeen ?? device.lastSeenAt)}`, controls(open, forget)));
    } });
    const pairing = panel.querySelector('#remote-pairing-status'); if (pairing) { pairing.textContent = typeof status?.pairingError === 'string' ? status.pairingError : status?.pairing ? `Waiting for approval on ${typeof status.pairing.hostName === 'string' ? status.pairing.hostName : 'the host PC'}${status.pairing.expiresAt ? ` · Expires at ${time(status.pairing.expiresAt)}` : ''}.` : ''; pairing.classList.toggle('error-text', Boolean(status?.pairingError)); }
    const route = panel.querySelector('#remote-host-route'); if (route) route.textContent = status?.hostRouteId ? `Public host route: ${status.hostRouteId}` : '';
    for (const id of ['remote-pair-device', 'remote-save-relay']) { const control = panel.querySelector(`#${id}`); if (control) control.disabled = pending || !status; }
  }
  function mount(container) { panel = el('div', 'remote-connections'); container.append(panel); build(); void load().catch(cause => { error = cause.message || String(cause); update(); }); schedule(); }
  subscribe?.(event => { if (event.type === 'remote') { try { accept(event.state); } catch (cause) { error = cause.message || String(cause); if (panel?.isConnected) update(); } } });
  return { mount, workspace, load, hasDrafts: () => workspace.hasDrafts() || Boolean(pairDraft || relayDraft || nameDraft), refreshReason: () => workspace.refreshReason() || (pairDraft || relayDraft || nameDraft ? 'Save or clear the open device connection form before refreshing.' : '') };
}
