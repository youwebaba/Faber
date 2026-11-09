export function validateRequestPayload(method, params) {
  // Per-message images and the ephemeral multi-chat UI handoff have separate bounds.
  const limit = (method === 'app.reloadUI' ? 64 : (['chat.send','chat.steer','media.save','clipboard.copyImage'].includes(method) || method === 'remote.request' && ['chat.send','chat.steer'].includes(params?.method)) ? 12 : 4) * 1024 * 1024;
  if (!params || typeof params !== 'object' || Array.isArray(params) || Buffer.byteLength(JSON.stringify(params)) > limit) throw new Error('Invalid bridge request');
}
