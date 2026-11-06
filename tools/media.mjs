import fs from 'node:fs/promises';
import path from 'node:path';
import { containedPath } from './files.mjs';

export function mediaTools() {
  return [{
    name: 'media_show', permission: 'read',
    description: 'Display saved audio or video from the current project in chat. Supports WAV, MP3, M4A, Ogg audio, MP4, and WebM up to 512 MiB; playback depends on the file codecs. Path must be project-relative. Copies a durable chat attachment; does not generate or transcode media or send its bytes to the model.',
    parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['path'], additionalProperties: false },
    async execute(args, ctx) {
      ctx.signal?.throwIfAborted();
      const target = await containedPath(ctx.project.path,args.path);
      await ctx.authorizePath?.(target);
      ctx.signal?.throwIfAborted();
      if (await containedPath(ctx.project.path,args.path) !== target) throw new Error('Media path changed while waiting for project approval. Try again.');
      if (!ctx.runtime?.publishMedia) throw new Error('Chat media publishing is unavailable in this session');
      const file = await fs.open(target,'r');
      try {
        const opened = await file.stat(), current = await fs.stat(target);
        if (await containedPath(ctx.project.path,args.path) !== target || opened.ino !== current.ino || opened.dev !== current.dev) throw new Error('Media path changed while opening. Try again.');
        await ctx.authorizePath?.(target); ctx.signal?.throwIfAborted();
        return { media: await ctx.runtime.publishMedia({ chatId: ctx.chat.id, file, name: path.basename(target), signal: ctx.signal }) };
      } finally { await file.close(); }
    },
  }];
}
