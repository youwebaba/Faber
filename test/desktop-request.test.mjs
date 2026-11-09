import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequestPayload } from '../desktop/request-payload.mjs';

test('chat send and steer receive an image-sized IPC envelope; other methods retain their limit', () => {
  const imageSized = { images: ['data:image/png;base64,' + 'a'.repeat(8 * 1024 * 1024 - 21)], text: '', chatId: 'fixture' };
  assert.doesNotThrow(() => validateRequestPayload('chat.send', imageSized));
  assert.doesNotThrow(() => validateRequestPayload('chat.steer', { ...imageSized, runId: 'intended-run', correctionId: 'once' }));
  assert.doesNotThrow(() => validateRequestPayload('remote.request', { method: 'chat.steer', params: { ...imageSized, runId: 'intended-run' } }));
  for (const method of ['tool.run', 'settings.update', 'provider.save', 'models.download']) assert.throws(() => validateRequestPayload(method, imageSized), /Invalid bridge/);
  assert.throws(() => validateRequestPayload('chat.send', { images: ['a'.repeat(12 * 1024 * 1024)] }), /Invalid bridge/);
  assert.doesNotThrow(() => validateRequestPayload('tool.run', { text: 'a'.repeat(4 * 1024 * 1024 - 11) }));
  assert.throws(() => validateRequestPayload('tool.run', { text: 'a'.repeat(4 * 1024 * 1024 - 10) }), /Invalid bridge/);
  // Limits count UTF-8 bytes rather than JavaScript code units.
  assert.throws(() => validateRequestPayload('tool.run', { text: 'é'.repeat(3 * 1024 * 1024) }), /Invalid bridge/);
  for (const malformed of [null, [], 'text', 1]) assert.throws(() => validateRequestPayload('chat.send', malformed), /Invalid bridge/);
});
