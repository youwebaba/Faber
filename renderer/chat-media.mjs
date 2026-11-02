import { safeImage } from './ui-helpers.mjs';

export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export function encodedImageSize(file) { return `data:${file.type};base64,`.length + 4 * Math.ceil(file.size / 3); }
export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The clipboard image could not be read. Paste it again.'));
    reader.onabort = () => reject(new Error('Reading the clipboard image was canceled.'));
    reader.readAsDataURL(file);
  });
}
// Reserve count and encoded size before reading so concurrent pastes share the limit.
export function createImageDrafts({ readFile = readImageFile, onChange = () => {} } = {}) {
  const drafts = new Map(); let sequence = 0;
  const get = key => drafts.get(key) || [];
  const remove = (key, ids) => { const remaining = get(key).filter(item => !ids.includes(item.id)); if (remaining.length) drafts.set(key, remaining); else drafts.delete(key); onChange(key); };
  return {
    get, remove,
    async add(key, files) {
      if (!files.length) return;
      if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) throw new Error('Paste a PNG, JPEG, or WebP image.');
      if (get(key).length + files.length > MAX_IMAGES) throw new Error('A message can contain up to 8 images. Remove an image before pasting more.');
      const sizes = files.map(encodedImageSize);
      if (get(key).reduce((sum, item) => sum + item.size, 0) + sizes.reduce((sum, size) => sum + size, 0) > MAX_IMAGE_BYTES) throw new Error('Images exceed the 8 MiB encoded message limit. Paste a smaller image or remove an attachment.');
      const items = files.map((file, i) => ({ id: String(++sequence), name: file.name || 'Clipboard image', size: sizes[i], pending: true }));
      drafts.set(key, [...get(key), ...items]); onChange(key);
      try {
        const images = await Promise.all(files.map(readFile));
        if (images.some((image, i) => !safeImage(image) || image.length > sizes[i])) throw new Error('The clipboard image could not be attached. Paste a PNG, JPEG, or WebP image again.');
        images.forEach((image, i) => { if (get(key).includes(items[i])) Object.assign(items[i], { image, pending: false, size: image.length }); });
        onChange(key);
      } catch (error) { remove(key, items.map(item => item.id)); throw error; }
    },
  };
}

export function tokenCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'Not reported'; }
export function callUsage(call) {
  const usage = call.usage || {};
  return { input: tokenCount(usage.inputTokens), output: tokenCount(usage.outputTokens), cached: tokenCount(usage.cachedInputTokens), reasoning: tokenCount(usage.reasoningTokens) };
}
