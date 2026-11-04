import test from 'node:test';
import assert from 'node:assert/strict';
import { runTimeoutChoice } from '../renderer/preferences.mjs';
import { pendingUserMessages, externalProviders, hasUnsentDrafts, projectApprovalTitle } from '../renderer/workspace-controls.mjs';

test('durable user follow-ups preserve identity and never duplicate a delivered message or inbox entry', () => {
  const entry = { id: 'followup', source: 'user', text: 'New direction', createdAt: '2026-11-04T10:00:00Z', runId: 'run', images: ['data:image/png;base64,AA=='] };
  const chat = { messages: [], inbox: [entry, { ...entry }, { ...entry, id: 'agent', source: 'agent' }] };
  assert.deepEqual(pendingUserMessages(chat), [{ id: entry.id, role: 'user', content: entry.text, createdAt: entry.createdAt, runId: entry.runId, images: entry.images, status: 'pending', steering: true }]);
  assert.deepEqual(pendingUserMessages(JSON.parse(JSON.stringify(chat))), pendingUserMessages(chat), 'Reload does not invent queue identities or delivery');
  chat.messages.push({ id: entry.id, role: 'user', content: entry.text, steering: true });
  assert.deepEqual(pendingUserMessages(chat), []);
  assert.deepEqual(pendingUserMessages(), []);
});
test('external access picker excludes subscription accounts and unsupported providers', () => {
  const provider = (id, kind, extra = {}) => ({ id, kind, ...extra });
  const allowed = [provider('local', 'ollama'), provider('responses', 'openai-responses'), provider('compatible', 'openai')];
  assert.deepEqual(externalProviders([...allowed, provider('chatgpt:account', 'openai-responses'), provider('account', 'openai-responses', { authKind: 'chatgpt' }), provider('other', 'unknown')]), allowed);
});
test('profile switching detects drafts across chats, pending files and changed forms without counting saved values or readonly tokens', () => {
  assert.equal(hasUnsentDrafts(), false);
  for (const drafts of [{ text: ' ' }, { drafts: ['stored chat draft'] }, { pending: true }, { attachments: [{ key: 'other-chat', attachments: [{ kind: 'text' }] }] }]) assert.equal(hasUnsentDrafts(drafts), true);
  const field = { value: 'saved', defaultValue: 'saved', type: 'text' };
  assert.equal(hasUnsentDrafts({ fields: [field, { value: 'secret', defaultValue: '', readOnly: true }] }), false);
  assert.equal(hasUnsentDrafts({ fields: [{ ...field, value: 'edited' }] }), true);
  assert.equal(hasUnsentDrafts({ fields: [{ type: 'file', files: [{}] }] }), true);
  assert.equal(hasUnsentDrafts({ fields: [{ type: 'checkbox', checked: true, defaultChecked: false }] }), true);
  assert.equal(hasUnsentDrafts({ fields: [{ tagName: 'SELECT', options: [{ selected: false, defaultSelected: true }] }] }), true);
});
test('project approval names the exact target without changing ordinary permission wording', () => {
  assert.equal(projectApprovalTitle({ permission: 'project', projectName: 'Client B' }), 'Allow access to Client B?');
  assert.equal(projectApprovalTitle({ kind: 'project', projectName: '<literal>' }), 'Allow access to <literal>?');
  assert.equal(projectApprovalTitle({ permission: 'shell' }), 'Allow shell access?');
});

test('overall timeout UI only returns Off explicitly and validates minute input before submission', () => {
  assert.equal(runTimeoutChoice('off', ''), 0); assert.equal(runTimeoutChoice('enabled', '10'), 600000); assert.equal(runTimeoutChoice('enabled', '0.5'), 30000);
  assert.equal(runTimeoutChoice('enabled', String(1 / 60)), 1000);
  for (const value of ['', ' ', 'invalid', '0', '-1', '0.001', 'Infinity', '35792']) assert.throws(() => runTimeoutChoice('enabled', value));
  assert.throws(() => runTimeoutChoice('invented', '10'));
});
