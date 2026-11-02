import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentDrafts, readTextFile, attachmentMessage, MAX_TEXT_BYTES } from '../renderer/file-attachments.mjs';
const png = 'data:image/png;base64,YQ==';
const image = { name: 'photo.png', type: 'image/png', size: 1 };
const text = (content = 'hello', name = 'notes.txt', type = 'text/plain') => { const bytes = new TextEncoder().encode(content); return { name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer }; };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('picker images and UTF-8 source files share a removable draft and complete message', async () => {
  const drafts = createAttachmentDrafts({ readImage: async () => png });
  await drafts.add('chat', [image, text('const x = "你好";', 'source.js', '')]);
  assert.equal(drafts.get('chat')[0].image, png);
  const message = attachmentMessage('Review this', drafts.get('chat'));
  assert.match(message, /^Review this\n\nAttached UTF-8 files/);
  assert.deepEqual(JSON.parse(message.split('\n').at(-1)), [{ name: 'source.js', content: 'const x = "你好";' }]);
  assert.match(attachmentMessage('', drafts.get('chat')), /^Attached UTF-8 files/);
  const sent = drafts.get('chat').map(item => item.id);
  await drafts.add('chat', [text('new')]); drafts.remove('chat', sent);
  assert.equal(drafts.get('chat').length, 1); assert.equal(drafts.get('chat')[0].content, 'new');
});

test('unsupported binary, invalid UTF-8, oversized and count-limited batches leave earlier drafts intact', async () => {
  const drafts = createAttachmentDrafts(); await drafts.add('chat', [text()]);
  await assert.rejects(drafts.add('chat', [text('binary', 'doc.pdf', 'application/pdf')]), /not supported/);
  await assert.rejects(drafts.add('chat', [{ ...text(), size: MAX_TEXT_BYTES }]), /1 MiB/);
  await assert.rejects(drafts.add('chat', Array(8).fill(text())), /8 text files/);
  await assert.rejects(drafts.add('chat', [text('a\0b')]), /binary/);
  await assert.rejects(readTextFile({ name: 'bad.txt', arrayBuffer: async () => Uint8Array.of(255).buffer }), /UTF-8/);
  assert.equal(drafts.get('chat').length, 1);
});

test('concurrent picker reads reserve limits; pending removal and chat changes do not redirect or resurrect', async () => {
  const read = deferred(); const drafts = createAttachmentDrafts({ readText: () => read.promise });
  const pending = drafts.add('original', Array(8).fill(text()));
  await assert.rejects(drafts.add('original', [text()]), /8 text files/);
  drafts.remove('original', [drafts.get('original')[0].id]); read.resolve('hello'); await pending;
  assert.equal(drafts.get('original').length, 7); assert.ok(drafts.get('original').every(item => !item.pending)); assert.deepEqual(drafts.get('other'), []);
});

test('a mixed batch read failure rolls back only that batch, retaining newer edits', async () => {
  const read = deferred(); const drafts = createAttachmentDrafts({ readImage: () => read.promise });
  const pending = drafts.add('chat', [image, text('batch')]);
  await drafts.add('chat', [text('newer')]); read.resolve('bad-image');
  await assert.rejects(pending, /could not be attached/);
  assert.equal(drafts.get('chat').length, 1); assert.equal(drafts.get('chat')[0].content, 'newer');
});

test('maximum text escaping plus maximum images fit the existing IPC envelope', async () => {
  const { validateRequestPayload } = await import('../desktop/request-payload.mjs');
  const content = '\t'.repeat(MAX_TEXT_BYTES);
  const text = attachmentMessage('', [{ kind: 'text', name: 'escaped.txt', content }]);
  assert.doesNotThrow(() => validateRequestPayload('chat.send', { chatId: 'fixture', text, images: ['a'.repeat(8 * 1024 * 1024)] }));
});
