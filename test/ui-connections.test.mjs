import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionPayload, CONNECTION_PRESETS, SUGGESTED_OPENAI_MODELS, REASONING_EFFORTS } from '../renderer/connections.mjs';

test('connection presets distinguish Responses from Chat Completions without changing model IDs', () => {
  assert.equal(CONNECTION_PRESETS.find(item => item.value === 'openai-responses').baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(CONNECTION_PRESETS.map(item => item.value), ['openai-responses', 'openai', 'ollama']);
  assert.deepEqual(SUGGESTED_OPENAI_MODELS, ['gpt-6-astra', 'gpt-6.1-sol']);
  assert.deepEqual(REASONING_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('saving preserves omitted credentials and only explicitly replaces or clears them', () => {
  const values = { id: 'cloud', name: ' OpenAI ', kind: 'openai-responses', baseUrl: ' https://api.openai.com/v1 ', model: ' gpt-6-astra ', reasoningEffort: 'high', apiKey: '' };
  const saved = connectionPayload(values);
  assert.equal(Object.hasOwn(saved, 'apiKey'), false);
  assert.equal(saved.reasoningEffort, 'high'); assert.equal(saved.model, 'gpt-6-astra'); assert.equal(saved.name, 'OpenAI');
  assert.equal(connectionPayload({ ...values, apiKey: 'test-only-key' }).apiKey, 'test-only-key');
  assert.equal(connectionPayload({ ...values, clearKey: true }).apiKey, '');
  assert.throws(() => connectionPayload({ ...values, clearKey: true, apiKey: 'test-only-key' }), /Either enter/);
  assert.equal(connectionPayload({ ...values, reasoningEffort: '' }).reasoningEffort, '');
  assert.equal(Object.hasOwn(connectionPayload({ ...values, kind: 'ollama' }), 'reasoningEffort'), false);
  assert.equal(Object.hasOwn(saved, 'chatId'), false);
  assert.equal(Object.hasOwn(saved, 'providerId'), false);
});
