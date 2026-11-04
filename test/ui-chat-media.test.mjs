import test from 'node:test';
import assert from 'node:assert/strict';
import { encodedImageSize, MAX_IMAGE_BYTES, callUsage } from '../renderer/chat-media.mjs';
import { createAttachmentDrafts } from '../renderer/file-attachments.mjs';
import { sameMessage } from '../renderer/ui-helpers.mjs';

const png = 'data:image/png;base64,YQ==';
const file = { type: 'image/png', size: 1, name: 'paste.png' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('concurrent clipboard reads reserve attachment count before completion', async () => {
  const read = deferred(); const drafts = createAttachmentDrafts({ readImage: () => read.promise });
  const pending = drafts.add('chat-a', Array(8).fill(file));
  assert.equal(drafts.get('chat-a').filter(item => item.pending).length, 8);
  await assert.rejects(drafts.add('chat-a', [file]), /8 images/);
  read.resolve(png); await pending;
  assert.equal(drafts.get('chat-a').length, 8); assert.ok(drafts.get('chat-a').every(item => item.image === png && !item.pending));
});

test('limits and failed reads retain previous attachments and other chat drafts', async () => {
  const drafts = createAttachmentDrafts({ readImage: async input => { if (input.fail) throw new Error('read failed'); return png; } });
  await drafts.add('chat-a', [file]); await drafts.add('chat-b', [file]);
  assert.equal(encodedImageSize(file), png.length);
  await assert.rejects(drafts.add('chat-a', [{ ...file, size: MAX_IMAGE_BYTES }]), /8 MiB/);
  await assert.rejects(drafts.add('chat-a', [{ ...file, name: 'binary.bin', type: 'application/octet-stream' }]), /not supported/);
  await assert.rejects(drafts.add('chat-a', [{ ...file, fail: true }]), /read failed/);
  assert.equal(drafts.get('chat-a').length, 1); assert.equal(drafts.get('chat-b').length, 1);
});

test('late paste completion stays in original chat and removal prevents resurrection', async () => {
  const read = deferred(); const drafts = createAttachmentDrafts({ readImage: () => read.promise });
  const pending = drafts.add('original', [file]); const id = drafts.get('original')[0].id;
  drafts.remove('original', [id]); read.resolve(png); await pending;
  assert.deepEqual(drafts.get('original'), []); assert.deepEqual(drafts.get('other'), []);
});

test('successful send consumes only its snapshot, retaining images pasted while sending', async () => {
  const drafts = createAttachmentDrafts({ readImage: async () => png });
  await drafts.add('chat', [file]); const sent = drafts.get('chat').map(item => item.id);
  await drafts.add('chat', [file]); const newer = drafts.get('chat')[1];
  drafts.remove('chat', sent); assert.deepEqual(drafts.get('chat'), [newer]);
});

test('actual usage keeps reported zero and unknown distinct without adding subset tokens', () => {
  assert.deepEqual(callUsage({ usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, reasoningTokens: 12 } }), { input: '100', output: '20', cached: '80', reasoning: '12' });
  assert.deepEqual(callUsage({ usage: { inputTokens: 0, outputTokens: null, cachedInputTokens: -1 } }), { input: '0', output: 'Not reported', cached: 'Not reported', reasoning: 'Not reported' });
  assert.equal(callUsage({ status: 'failed' }).input, 'Not reported');
});

test('image history reuses unchanged message nodes and invalidates changed attachments', () => {
  const message = { id: 'user', role: 'user', content: '', images: [png] };
  assert.equal(sameMessage(message, structuredClone(message)), true);
  assert.equal(sameMessage(message, { ...message, images: [] }), false);
});
