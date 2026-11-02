import test from 'node:test';
import assert from 'node:assert/strict';
import { createUIReload, validateUISnapshot } from '../desktop/ui-reload.mjs';
import { validateRequestPayload } from '../desktop/request-payload.mjs';
const snapshot = () => ({ version: 1, selectedChatId: 'chat', selectedProjectId: 'project', drafts: [{ key: 'chat', text: 'Unsent private draft', attachments: [{ kind: 'text', name: 'note.txt', content: 'Unsent file' }] }], view: { sidebarHidden: false, sidebarOpen: false, activityHidden: false, activityOpen: false, transcriptScroll: 12, activityScroll: 5, projectScroll: 0, promptSelectionStart: 1, promptSelectionEnd: 4, promptFocused: true } });
test('UI handoff is cloned, retained across reads, and cleared only by matching acknowledgement', async () => {
  let task, reloads = 0;
  const host = createUIReload({ activationStatus: async () => ({ restartRequired: false }), reload: () => reloads++, schedule: callback => { task = callback; } });
  const state = snapshot(), accepted = await host.request('app.reloadUI', { state });
  state.drafts[0].text = 'later edit'; assert.equal(reloads, 0); assert.equal(host.pending, true);
  const first = await host.request('app.uiState'); assert.equal(first.state.drafts[0].text, 'Unsent private draft'); first.state.drafts[0].text = 'external mutation';
  assert.equal((await host.request('app.uiState')).state.drafts[0].text, 'Unsent private draft');
  await assert.rejects(host.request('app.uiStateAck', { id: 'wrong' }), /does not match/);
  await assert.rejects(host.request('app.reloadUI', { state: snapshot() }), /already pending/);
  await task(); assert.equal(reloads, 1);
  await host.request('app.uiStateAck', { id: accepted.id }); assert.equal(host.pending, false); assert.equal(await host.request('app.uiState'), null);
});
test('backend or voice rejection leaves old page intact; post-acceptance rejection retains recoverable draft', async () => {
  let blocked = true, voice = false, task, reloads = 0; const events = [];
  const host = createUIReload({ activationStatus: async () => ({ restartRequired: blocked }), assertAllowed: () => { if (voice) throw new Error('Stop voice'); }, reload: () => reloads++, emit: event => events.push(event), schedule: callback => { task = callback; } });
  await assert.rejects(host.request('app.reloadUI', { state: snapshot() }), /Backend changes/); assert.equal(await host.request('app.uiState'), null);
  blocked = false; voice = true; await assert.rejects(host.request('app.reloadUI', { state: snapshot() }), /Stop voice/);
  voice = false; const accepted = await host.request('app.reloadUI', { state: snapshot() }); blocked = true; await task();
  assert.equal(reloads, 0); assert.equal(events[0].type, 'uiReloadFailed'); assert.equal(events[0].id, accepted.id); assert.ok((await host.request('app.uiState')).state.drafts.length);
  await host.request('app.uiStateAck', { id: accepted.id });
});
test('UI snapshot accepts only intended draft/view data and enforces content limits', () => {
  validateUISnapshot(snapshot());
  for (const mutate of [s => { s.secrets = 'not allowed'; }, s => { s.drafts.push(s.drafts[0]); }, s => { s.view.projectScroll = NaN; }, s => { s.drafts[0].attachments = [{ kind: 'image', name: 'bad', image: 'data:text/html;base64,YQ==' }]; }, s => { s.drafts[0].attachments[0].content = 'a'.repeat(1024 * 1024 + 1); }]) { const state = snapshot(); mutate(state); assert.throws(() => validateUISnapshot(state)); }
  const large = snapshot(); large.drafts[0].text = 'a'.repeat(5 * 1024 * 1024); validateRequestPayload('app.reloadUI', { state: large });
  assert.throws(() => validateRequestPayload('settings.update', { state: large }), /Invalid bridge/);
  large.drafts[0].text = 'a'.repeat(64 * 1024 * 1024); assert.throws(() => validateUISnapshot(large), /64 MiB/);
});
