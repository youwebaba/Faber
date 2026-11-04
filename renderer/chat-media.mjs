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
export function tokenCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'Not reported'; }
export function callUsage(call) {
  const usage = call.usage || {};
  return { input: tokenCount(usage.inputTokens), output: tokenCount(usage.outputTokens), cached: tokenCount(usage.cachedInputTokens), reasoning: tokenCount(usage.reasoningTokens) };
}
