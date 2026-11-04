import fs from 'node:fs/promises';
import path from 'node:path';
import { containedPath } from './files.mjs';
import { imageBytesLimit, validateChatImages } from '../core/images.mjs';

const fileLimit = Math.floor((imageBytesLimit - 32) / 4) * 3;
const formats = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };

export function imageTools() {
  return [{
    name: 'images_show',
    description: 'Display a saved PNG, JPEG, or WebP image from the current project in the chat and provide it to the model. Use for screenshots or image files you created. Path must be project-relative; encoded image must fit within 8 MiB. This does not generate an image.',
    permission: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['path'], additionalProperties: false },
    async execute(args, ctx) {
      ctx.signal?.throwIfAborted();
      const target = await containedPath(ctx.project.path, args.path);
      await ctx.authorizePath?.(target);
      ctx.signal?.throwIfAborted();
      if (await containedPath(ctx.project.path, args.path) !== target) throw new Error('Image path changed while waiting for project approval. Try again.');
      const format = formats[path.extname(target).toLowerCase()];
      if (!format) throw new Error('Choose a PNG, JPEG, or WebP image. SVG and other formats are not supported.');
      const file = await fs.open(target, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > fileLimit) throw new Error('Image must be a file smaller than 6 MiB (8 MiB encoded).');
        const bytes = Buffer.alloc(stat.size); let offset = 0;
        while (offset < bytes.length) {
          ctx.signal?.throwIfAborted();
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error('Image changed while it was being read. Try again.');
          offset += bytesRead;
        }
        const after = await file.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Image changed while it was being read. Try again.');
        const image = `data:image/${format};base64,${bytes.toString('base64')}`;
        validateChatImages([image]);
        ctx.signal?.throwIfAborted();
        return { path: args.path, mimeType: `image/${format}`, bytes: bytes.length, image };
      } finally { await file.close(); }
    },
  }];
}
