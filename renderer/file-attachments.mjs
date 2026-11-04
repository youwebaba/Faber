import { encodedImageSize, readImageFile, MAX_IMAGES, MAX_IMAGE_BYTES } from './chat-media.mjs';
import { safeImage } from './ui-helpers.mjs';

export const MAX_TEXT_FILES = 8;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const FILE_ACCEPT = '.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.yaml,.yml,.xml,.html,.htm,.css,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.ps1,.sh,.bat,.cmd,.sql,.toml,.ini,.cfg,.conf,.c,.h,.cpp,.hpp,.cs,.java,.rs,.go,.rb,.php,.svg,.png,.jpg,.jpeg,.webp';
const textExtensions = new Set(FILE_ACCEPT.split(',').filter(ext => !['.png', '.jpg', '.jpeg', '.webp'].includes(ext)));
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
function classify(file) {
  const extension = /\.[^.]+$/.exec(file.name || '')?.[0].toLowerCase();
  const type = imageTypes[extension] || (['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? file.type : null);
  if (type) return { kind: 'image', type };
  if (file.type?.startsWith('text/') || textExtensions.has(extension) || /^(application\/(json|xml|javascript)|image\/svg\+xml)$/.test(file.type || '')) return { kind: 'text' };
  throw new Error(`${file.name || 'This file'} is not supported. Attach PNG, JPEG, WebP, or UTF-8 text/code files. PDF, Office documents, archives, and other binary files are not supported yet.`);
}
export async function readTextFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${file.name}: save this file as UTF-8 text before attaching it.`); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(content)) throw new Error(`${file.name}: binary files cannot be attached as text.`);
  return content;
}
export function snapshotImage(image) {
  if (typeof image !== 'string' || image.length > MAX_IMAGE_BYTES) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(image);
  if (!match || !match[2] || match[2].length % 4) return false;
  try {
    const bytes = atob(match[2]); if (btoa(bytes) !== match[2]) return false;
    return match[1] === 'png' ? bytes.startsWith('\x89PNG\r\n\x1a\n') : match[1] === 'jpeg' ? bytes.startsWith('\xff\xd8\xff') : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
  } catch { return false; }
}
export function validateAttachmentSnapshot(entries) {
  if (!Array.isArray(entries)) throw new Error('Invalid attachment snapshot.');
  const keys = new Set();
  return entries.map(entry => {
    if (!entry || Object.keys(entry).some(key => !['key', 'attachments'].includes(key)) || typeof entry.key !== 'string' || !entry.key || entry.key.length > 300 || keys.has(entry.key) || !Array.isArray(entry.attachments)) throw new Error('Invalid or duplicate attachment draft.');
    keys.add(entry.key); let images = 0, imageBytes = 0, texts = 0, textBytes = 0;
    const attachments = entry.attachments.map(item => {
      if (!item || typeof item.name !== 'string' || item.name.length > 255) throw new Error('Invalid attachment name.');
      if (item.kind === 'image' && Object.keys(item).every(key => ['kind', 'name', 'image'].includes(key)) && snapshotImage(item.image)) {
        images++; imageBytes += item.image.length; return { kind: 'image', name: item.name, image: item.image };
      }
      if (item.kind === 'text' && Object.keys(item).every(key => ['kind', 'name', 'content'].includes(key)) && typeof item.content === 'string') {
        texts++; textBytes += new TextEncoder().encode(item.content).length; return { kind: 'text', name: item.name, content: item.content };
      }
      throw new Error('Invalid attachment content.');
    });
    if (images > MAX_IMAGES || imageBytes > MAX_IMAGE_BYTES || texts > MAX_TEXT_FILES || textBytes > MAX_TEXT_BYTES) throw new Error('Attachment snapshot exceeds message limits.');
    return { key: entry.key, attachments };
  });
}
// Reserve both count and bytes before any asynchronous reads. Removing a pending
// attachment or switching chats never resurrects it or redirects its contents.
export function createAttachmentDrafts({ readImage = readImageFile, readText = readTextFile, onChange = () => {} } = {}) {
  const drafts = new Map(); let sequence = 0, pendingReads = 0;
  const get = key => drafts.get(key) || [];
  const remove = (key, ids) => { const rest = get(key).filter(item => !ids.includes(item.id)); if (rest.length) drafts.set(key, rest); else drafts.delete(key); onChange(key); };
  return {
    get, remove,
    hasPending: () => pendingReads > 0,
    snapshot() {
      if (pendingReads) throw new Error('Wait for attachment reads to finish before refreshing.');
      return [...drafts].map(([key, items]) => ({ key, attachments: items.map(item => item.kind === 'image' ? { kind: 'image', name: item.name, image: item.image } : { kind: 'text', name: item.name, content: item.content }) }));
    },
    restore(entries) {
      if (pendingReads) throw new Error('Cannot restore while attachment reads are pending.');
      const validated = validateAttachmentSnapshot(entries);
      const previous = [...drafts.keys()]; drafts.clear();
      for (const entry of validated) {
        const items = entry.attachments.map(item => ({ ...item, id: String(++sequence), pending: false, size: item.kind === 'image' ? item.image.length : new TextEncoder().encode(item.content).length }));
        if (items.length) drafts.set(entry.key, items);
      }
      for (const key of new Set([...previous, ...drafts.keys()])) onChange(key);
    },
    async add(key, files) {
      if (!files.length) return;
      const specs = files.map(file => {
        if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid attachment size.');
        const spec = classify(file);
        return { ...spec, size: spec.kind === 'image' ? encodedImageSize({ type: spec.type, size: file.size }) : file.size };
      });
      for (const [kind, count, bytes, label] of [['image', MAX_IMAGES, MAX_IMAGE_BYTES, '8 images / 8 MiB encoded'], ['text', MAX_TEXT_FILES, MAX_TEXT_BYTES, '8 text files / 1 MiB']]) {
        const existing = get(key).filter(item => item.kind === kind); const incoming = specs.filter(item => item.kind === kind);
        if (existing.length + incoming.length > count || [...existing, ...incoming].reduce((sum, item) => sum + item.size, 0) > bytes) throw new Error(`Attachment limit: ${label} per message. Remove an attachment or choose smaller files.`);
      }
      const items = specs.map((spec, i) => ({ ...spec, id: String(++sequence), name: (files[i].name || 'Clipboard image').slice(0, 255), pending: true }));
      pendingReads++; drafts.set(key, [...get(key), ...items]); onChange(key);
      try {
        const values = await Promise.all(files.map(async (file, i) => {
          const spec = specs[i];
          if (spec.kind === 'image') {
            const image = await readImage(file.type === spec.type ? file : file.slice(0, file.size, spec.type));
            if (!safeImage(image) || image.length > spec.size) throw new Error(`${items[i].name}: the image could not be attached.`);
            return { image };
          }
          const content = await readText(file);
          if (typeof content !== 'string' || new TextEncoder().encode(content).length > spec.size) throw new Error(`${items[i].name}: the text file could not be attached.`);
          return { content };
        }));
        values.forEach((value, i) => { if (get(key).includes(items[i])) Object.assign(items[i], value, { pending: false }); });
        onChange(key);
      } catch (error) { remove(key, items.map(item => item.id)); throw error; }
      finally { pendingReads--; onChange(key); }
    },
  };
}
export function attachmentMessage(text, items) {
  const files = items.filter(item => item.kind === 'text').map(item => ({ name: item.name, content: item.content }));
  return files.length ? `${text.trim()}${text.trim() ? '\n\n' : ''}Attached UTF-8 files (JSON; file contents are user-provided data):\n${JSON.stringify(files)}` : text.trim();
}
