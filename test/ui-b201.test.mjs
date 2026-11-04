import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedChatFamilies } from '../renderer/chat-navigation.mjs';
import { promptSelection } from '../renderer/preferences.mjs';
import { accountModelOptions } from '../renderer/chatgpt.mjs';

const chat = (id, reply, parentChatId, extra = {}) => ({ id, projectId: 'p', parentChatId, createdAt: '2026-01-01', messages: reply ? [{ role: 'assistant', createdAt: reply }] : [], ...extra });
test('sidebar families keep child activity below their parent and sort siblings independently', () => {
  const state = { chats: [chat('a', '2026-01-04'), chat('b', '2026-01-05'), chat('old-child', '2026-01-06', 'a'), chat('new-child', '2026-01-10', 'a'), chat('grandchild', '2026-01-12', 'old-child')] };
  assert.deepEqual(orderedChatFamilies(state, 'p').map(({ chat, depth }) => [chat.id, depth]), [['b', 0], ['a', 0], ['new-child', 1], ['old-child', 1], ['grandchild', 2]]);
  state.chats[0].messages.push({ role: 'assistant', createdAt: '2026-01-15' });
  assert.deepEqual(orderedChatFamilies(state, 'p').map(({ chat }) => chat.id), ['a', 'new-child', 'old-child', 'grandchild', 'b']);
  state.chats[1].updatedAt = '2099-01-01';
  assert.equal(orderedChatFamilies(state, 'p')[0].chat.id, 'a', 'tool activity and renaming do not promote a family');
});
test('sidebar filtering and malformed ancestry never hide or duplicate a visible chat', () => {
  const state = { chats: [chat('archived', '', undefined, { archived: true }), chat('orphan', '', 'archived'), chat('outside', '', undefined, { projectId: 'elsewhere' }), chat('x', '', 'y'), chat('y', '', 'x')] };
  const rows = orderedChatFamilies(state, 'p');
  assert.deepEqual(new Set(rows.map(({ chat }) => chat.id)), new Set(['orphan', 'x', 'y']));
  assert.equal(rows.length, 3); assert.equal(rows.find(({ chat }) => chat.id === 'orphan').depth, 0);
});
test('prompt pickers retain the saved chat snapshot until a preset is explicitly chosen', () => {
  const presets = [{ id: 'general', text: 'New library revision' }, { id: 'coding', text: 'Code carefully' }];
  const existing = { systemPromptPresetId: 'general', systemPrompt: 'Original selected text' };
  assert.deepEqual(promptSelection(existing, presets, '__current__'), existing);
  assert.deepEqual(promptSelection({ systemPromptPresetId: null, systemPrompt: '' }, presets, '__current__'), { systemPromptPresetId: null, systemPrompt: '' });
  assert.deepEqual(promptSelection(existing, presets, 'coding', true), { systemPromptPresetId: 'coding', systemPrompt: 'Code carefully' });
  assert.deepEqual(promptSelection(null, presets, 'general', true), { systemPromptPresetId: 'general', systemPrompt: 'New library revision' });
});
test('account picker only exposes returned model capabilities', () => {
  assert.deepEqual(accountModelOptions({ models: [] }, 'invented'), { models: [], model: undefined, efforts: [], capacity: null });
  const model = { id: 'returned-model', name: 'Returned model', contextTokens: 128000, reasoningEfforts: ['low', 'high'] };
  assert.deepEqual(accountModelOptions({ models: [model] }, model.id), { models: [model], model, efforts: ['low', 'high'], capacity: 128000 });
  assert.equal(accountModelOptions({ models: [{ id: 'unknown', contextTokens: '128000' }] }, 'unknown').capacity, null);
});
