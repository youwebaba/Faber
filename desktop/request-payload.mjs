export function validateRequestPayload(method, params) {
  // Per-message images and the ephemeral multi-chat UI handoff have separate bounds.
  const limit = (method === 'app.reloadUI' ? 64 : (method === 'chat.send' || ['media.save','clipboard.copyImage'].includes(method) || method === 'remote.request' && params?.method === 'chat.send') ? 12 : 4) * 1024 * 1024;
  if (!params || typeof params !== 'object' || Array.isArray(params) || Buffer.byteLength(JSON.stringify(params)) > limit) throw new Error('Invalid bridge request');
}
