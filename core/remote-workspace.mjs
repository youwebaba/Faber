import { createHash, randomUUID } from 'node:crypto';
import { validate } from './registry.mjs';
import { imageBytesLimit, validateChatImages } from './images.mjs';
import { mediaChunkLimit, mediaIdSchema, sourceMediaRefs, mediaNotesSchemas } from './media.mjs';

const id = { type: 'string', minLength: 1, maxLength: 256 };
const bounded = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const chatRef = object({ chatId: id });
const imageMode = { type: 'string', enum: ['references'] }, capabilities = { imageReferences: true, mediaReferences: true, steering: true, liveCapture:true };
const transcriptBytesLimit = 10 * 1024 * 1024;
const methods = new Map(Object.entries({
  ...Object.fromEntries(Object.entries(mediaNotesSchemas).map(([action,schema])=>['chat.mediaNotes.'+action,schema])),
  'workspace.ping': object({}), 'workspace.models': object({}),
  'chat.selectModel': object({ chatId:id, providerId:id, model:{type:'string',minLength:1,maxLength:300} }),
  'workspace.list': object({ since: id, offset: bounded(0, 10000000), limit: bounded(1, 500) }, []),
  'chat.read': object({ chatId: id, since: id, before: id, limit: bounded(1, 100), waitMs: bounded(0, 15000), imageMode, mediaMode: imageMode }, ['chatId']),
  'chat.image': object({ chatId: id, imageId: { type: 'string', minLength: 1, maxLength: 2048 } }),
  'chat.media': object({ chatId: id, mediaId: mediaIdSchema, offset: bounded(0, 536870912), length: bounded(0, mediaChunkLimit) }),
  'chat.send': object({ chatId: id, text: { type: 'string', maxLength: 200000 }, images: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: imageBytesLimit } } }, ['chatId','text']),
  'chat.steer': object({ chatId: id, runId: id, correctionId: id, text: { type: 'string', maxLength: 200000 }, images: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: imageBytesLimit } } }, ['chatId','runId','text']),
  'chat.create': object({ projectId: id, title: { type: 'string', maxLength: 200 } }, ['projectId']),
  'chat.stop': chatRef, 'chat.forceStop': chatRef, 'chat.compact': chatRef,
  'approval.resolve': object({ chatId: id, id, allow: { type: 'boolean' } }),
}));
const pick = (item, fields) => Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
const chatFields = ['id','providerId','title','projectId','parentChatId','archived','createdAt','updatedAt','model'];
function chatRow(chat, providers, displayName) {
  const provider = providers.find(row => row.id === chat.providerId);
  const model = chat.model || provider?.model || '';
  return { ...pick(chat, chatFields), model, modelName: provider && model ? displayName?.(provider.id, model) || provider.models?.find(m=>m.id===model)?.name || model : '', providerName: provider?.name || '',
    lastAssistantAt: chat.messages.findLast(row => row.role === 'assistant' && row.content)?.createdAt ?? null,
    readOnly: !!chat.externalSessionId || !!chat.archived };
}
function hostModels(providers, displayName) {
  return providers.filter(p => p.connected !== false).map(p => {
    const catalog = new Map();
    if (p.model) catalog.set(p.model,{id:p.model,name:displayName?.(p.id,p.model) || p.modelName || p.model});
    for (const m of p.models || []) {
      const modelId = typeof m === 'string' ? m : m?.id;
      if (modelId) catalog.set(modelId,{id:modelId,name:m.name || modelId});
    }
    return {id:p.id,name:p.name,model:p.model || '',models:[...catalog.values()]};
  });
}
function chatFamily(chats, chatId) {
  const children = new Map(), family = new Set([chatId]);
  for (const chat of chats) if (chat.parentChatId) {
    if (!children.has(chat.parentChatId)) children.set(chat.parentChatId,[]);
    children.get(chat.parentChatId).push(chat.id);
  }
  for (const parent of family) for (const child of children.get(parent) || []) family.add(child);
  return family;
}
const inlineImage = /!\[[^\]\r\n]*\]\(\s*<?(data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2})>?(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)/g;
function resultImages(result) {
  try { const value = typeof result === 'string' ? JSON.parse(result) : result; return [value?.image, ...(Array.isArray(value?.images) ? value.images.slice(0,8) : [])]; }
  catch { return []; }
}
function sourceImages(source, kind, includeInline = true) {
  const inline = includeInline && kind === 'm' && source.role === 'assistant' && typeof source.content === 'string' && source.content.length <= 200000
    ? [...source.content.matchAll(inlineImage)].map(match => match[1]) : [];
  const candidates = kind === 'e' ? [source.image, ...resultImages(source.result)]
    : [...(Array.isArray(source.images) ? source.images.slice(0,8) : []), source.image, ...(source.role === 'tool' && !source.image ? resultImages(source.content) : []), ...inline];
  const images = []; let bytes = 0;
  for (const image of candidates) {
    if (!image || images.includes(image) || images.length === 8 || typeof image !== 'string' || bytes + image.length > imageBytesLimit) continue;
    try { validateChatImages([image]); } catch { continue; }
    images.push(image); bytes += image.length;
  }
  return images;
}
function imageId(chatId, kind, sourceId, index, image) {
  const digest = createHash('sha256').update(JSON.stringify([chatId,kind,sourceId,index,image])).digest('hex');
  return `${kind}.${Buffer.from(sourceId).toString('base64url')}.${index}.${digest}`;
}
function imageRefs(chatId, kind, source, images) {
  return images.map((image,index) => ({ id: imageId(chatId,kind,source.id,index,image), mimeType: image.slice(5,image.indexOf(';')),
    bytes: (image.length - image.indexOf(',') - 1) / 4 * 3 - (image.endsWith('==') ? 2 : image.endsWith('=') ? 1 : 0) }));
}
function visibleMessage(message, chatId, references, mediaReferences) {
  const images = sourceImages(message,'m',references);
  const mediaRefs = mediaReferences ? sourceMediaRefs(message) : [];
  if ((!['assistant','user'].includes(message.role) && !(message.role === 'tool' && (images.length || mediaRefs.length))) || (!message.content && !images.length && !mediaRefs.length && !message.toolCalls?.length)) return null;
  let text = message.role === 'tool' ? '' : String(message.content ?? '');
  if (references && message.role === 'assistant' && text.length <= 200000) text = text.replace(inlineImage, (raw,image) => images.includes(image) ? '[Image output below]' : raw);
  const row = { ...pick(message, ['id','role','createdAt','status','runId','sourceMessageId','modelCallId','toolName','toolCallId','fromChatId','steering']),
    content: text.length > 500000 ? text.slice(0,500000) + '\n[Open on the host to read the rest of this message.]' : text };
  if (message.toolCalls?.length) row.toolCalls = message.toolCalls.slice(0,64).map(call=>pick(call,['id','name']));
  if (images.length) Object.assign(row,references ? {imageRefs:imageRefs(chatId,'m',message,images)} : {images});
  if (mediaRefs.length) row.mediaRefs = mediaRefs;
  return row;
}
function runRow(run, references, budget, mediaReferences) {
  return { ...pick(run, ['id','chatId','status','startedAt','endedAt','requestMessageId','parentRunId','contextOverflow']), error: String(run.error ?? '').slice(0,2000),
    promptUsage: structuredClone(run.promptUsage || []),
    steering: (run.steering || []).slice(-64).map(item=>pick(item,['id','messageId','runId','status','mode','createdAt','acceptedAt','appliedAt','waitingFor','error'])),
    modelCalls: (run.modelCalls || []).slice(-64).map(call=>pick(call,['id','status','phase','progressSummary','requestMessageId','promptRunId','purpose','usage','metrics'])),
    toolEvents: run.toolEvents.slice(-64).map(event => {
      const row = { ...pick(event, ['id','name','status','startedAt','endedAt','toolCallId','sourceMessageId','modelCallId']),
        summary: String(event.args?.command ?? event.args?.path ?? event.args?.url ?? event.error ?? '').slice(0,1000) };
      const images = sourceImages(event,'e');
      const mediaRefs = mediaReferences ? sourceMediaRefs(event) : [];
      if (mediaRefs.length) row.mediaRefs = mediaRefs;
      if (images.length && references) row.imageRefs = imageRefs(run.chatId,'e',event,images);
      else if (images[0]?.length <= budget.remaining) { row.image = images[0]; budget.remaining -= images[0].length; }
      return row;
    }) };
}

// Only the desktop device transport receives this dispatcher. Never expose the general runtime RPC here.
export function createRemoteWorkspace({ current, request, readMedia, mediaNotes, modelDisplayName }) {
  const epoch = randomUUID(), waiters = new Set(), mutations = new Map();
  let closed = false;
  function revision(view, family) {
    let token = epoch + '.' + view.stateRevision;
    if (family) {
      let sequence = 0;
      for (const row of view.streams.values()) if (family.has(row.chatId)) sequence = Math.max(sequence,row.sequence);
      token += '.' + sequence;
    }
    return token;
  }
  function notify(event) {
    if (!['state','delta','progress'].includes(event.type)) return;
    for (const row of waiters) if (event.type === 'state' || row.family.has(event.chatId)) row.wake();
  }
  async function wait(family, ms, signal) {
    signal?.throwIfAborted();
    await new Promise(resolve => {
      const row = { family, wake() { clearTimeout(timer); waiters.delete(row); signal?.removeEventListener('abort',row.wake); resolve(); } };
      const timer = setTimeout(row.wake,ms);
      waiters.add(row); signal?.addEventListener('abort',row.wake,{once:true});
    });
    signal?.throwIfAborted();
    if (closed) throw new Error('Remote workspace closed');
  }
  function directory(view, {offset = 0, limit = 200, since}) {
    const token = revision(view), {projects,chats,providers} = view.state;
    if (since === token && !offset) return { unchanged: true, revision: token, capabilities };
    const end = offset + limit, total = projects.length + chats.length;
    return { projects: projects.slice(offset,end).map(p => pick(p,['id','name','archived','createdAt','updatedAt'])),
      chats: chats.slice(Math.max(0,offset-projects.length),Math.max(0,end-projects.length)).map(c => chatRow(c,providers,modelDisplayName)),
      runs: offset === 0 ? view.state.runs.filter(r=>['running','waiting_approval'].includes(r.status)).slice(-256).map(r=>pick(r,['id','chatId','parentRunId','status','startedAt'])) : [],
      nextOffset: end < total ? end : null, revision: token, capabilities };
  }
  function findChat(state, chatId) {
    const chat = state.chats.find(row => row.id === chatId);
    if (!chat) throw new Error('Chat no longer exists');
    return chat;
  }
  function readImage({chatId,imageId:requestedId}) {
    const {state} = current(), chat = findChat(state,chatId);
    const match = /^([mie])\.([A-Za-z0-9_-]{1,1366})\.([0-7])\.([a-f0-9]{64})$/.exec(requestedId);
    if (!match) throw new Error('Image no longer available for this chat');
    const [,kind,encoded,index] = match, sourceId = Buffer.from(encoded,'base64url').toString();
    if (Buffer.from(sourceId).toString('base64url') !== encoded) throw new Error('Image no longer available for this chat');
    const source = kind === 'e' ? state.runs.filter(run => run.chatId === chatId).flatMap(run => run.toolEvents).find(event => event.id === sourceId)
      : (kind === 'i' ? chat.inbox || [] : chat.messages).find(message => message.id === sourceId);
    const image = source && sourceImages(source,kind)[Number(index)];
    if (!image || imageId(chatId,kind,sourceId,Number(index),image) !== requestedId) throw new Error('Image no longer available for this chat');
    return {imageId:requestedId,image};
  }
  async function transcript(args, signal) {
    const {chatId, since, before, limit = 30, waitMs = 0, imageMode, mediaMode} = args, references = imageMode === 'references', mediaReferences = mediaMode === 'references';
    let view = current(), family = chatFamily(view.state.chats,chatId), token = revision(view,family);
    findChat(view.state,chatId);
    if (!before && since === token && waitMs) { await wait(family,waitMs,signal); view = current(); family = chatFamily(view.state.chats,chatId); token = revision(view,family); }
    if (!before && since === token) return { unchanged: true, revision: token };
    const {state,streams} = view, chat = findChat(state,chatId), source = chat.messages;
    const live = [...streams.values()].filter(row => family.has(row.chatId)).map(row => ({
      ...pick(row,['runId','chatId','phase','progressSummary','sequence','lastAssistantId','modelCallId','metrics']), text: String(row.text ?? '').slice(0,500000) }));
    if (!before && waitMs && since?.startsWith(revision(view) + '.')) return { liveOnly:true, chatId, streams:live, revision:token };
    let cursor = before ? source.findIndex(row => row.id === before) : source.length;
    if (cursor < 0) throw new Error('Chat history changed. Reload this chat.');
    const messages = []; let bytes = 0;
    while (cursor > 0 && messages.length < limit) {
      const message = source[cursor-1];
      const row = visibleMessage(message,chatId,references,mediaReferences);
      if (!row) { cursor--; continue; }
      const size = Buffer.byteLength(JSON.stringify(row));
      if (messages.length && bytes + size > transcriptBytesLimit) break;
      messages.push(row); bytes += size; cursor--;
    }
    messages.reverse();
    const budget = {remaining:Math.max(0,transcriptBytesLimit-bytes)};
    const inbox = (chat.inbox || []).filter(item => item.source === 'user').slice(0,32).map(item => {
      const row = {...pick(item,['id','source','createdAt','runId']),text:String(item.text || '').slice(0,8000)}, images = sourceImages(item,'i');
      if (images.length && references) row.imageRefs = imageRefs(chatId,'i',item,images);
      else if (images.length && images.reduce((sum,image) => sum+image.length,0) <= budget.remaining) { row.images = images; budget.remaining -= images.reduce((sum,image) => sum+image.length,0); }
      return row;
    });
    return { chat: { ...chatRow(chat,state.providers,modelDisplayName), messages, inbox }, before: cursor ? messages[0]?.id ?? null : null, revision: token,
      runs: state.runs.filter(row => family.has(row.chatId)).slice(-50).map(run => runRow(run,references,budget,mediaReferences)),
      streams: live,
      approvals: state.approvals.filter(row => family.has(row.chatId)).map(row => pick(row,['id','kind','chatId','runId','permission','toolName','summary'])) };
  }
  async function mutate(method, params, signal) {
    const {state} = current();
    const chat = params.chatId && findChat(state,params.chatId);
    const project = state.projects.find(row => row.id === (chat?.projectId ?? params.projectId));
    if (!project || project.archived || chat?.archived || chat?.externalSessionId) throw new Error('This remote project or chat is read-only.');
    if (method.startsWith('chat.mediaNotes.')) { if (!mediaNotes) throw new Error('Document annotations unavailable'); return mediaNotes(method.split('.').at(-1),params,signal); }
    if (method === 'chat.selectModel') {
      const provider = hostModels(state.providers,modelDisplayName).find(row => row.id === params.providerId);
      if (!provider?.models.some(m => m.id === params.model)) throw new Error('Choose a configured model on the host.');
      return chatRow(await request('chat.update',{id:chat.id,providerId:provider.id,model:params.model}),state.providers,modelDisplayName);
    }
    if (method === 'chat.create') return chatRow(await request(method,params),state.providers,modelDisplayName);
    if (method === 'approval.resolve') {
      if (!state.approvals.some(a => a.chatId === chat.id && a.id === params.id)) throw new Error('Approval is no longer pending for this chat');
      return request(method,{id:params.id,allow:params.allow});
    }
    return request(method,params);
  }
  async function dispatch(method, params, { device, signal, requestId } = {}) {
    if (closed) throw new Error('Remote workspace closed');
    signal?.throwIfAborted();
    const schema = methods.get(method);
    if (!schema) throw new Error('Unsupported remote workspace action');
    validate(params,schema);
    if (method === 'workspace.ping') return { online: true, capabilities };
    if (method === 'workspace.models') return {providers:hostModels(current().state.providers,modelDisplayName)};
    if (method === 'workspace.list') return directory(current(),params);
    if (method === 'chat.read') return transcript(params,signal);
    if (method === 'chat.image') return readImage(params);
    if (method === 'chat.media') { if (!readMedia) throw new Error('Chat media is unavailable'); return readMedia(params,signal); }
    if (method === 'chat.mediaNotes.read') { if (!mediaNotes) throw new Error('Document annotations unavailable'); return mediaNotes('read',params,signal); }
    if (!device?.id || typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('A device request ID is required');
    const key = device.id + '/' + requestId, hash = createHash('sha256').update(JSON.stringify([method,params])).digest('hex');
    const prior = mutations.get(key);
    if (prior) {
      if (hash !== prior.hash) throw new Error('Conflicting remote request ID');
      return prior.result;
    }
    for (const [k,entry] of mutations) if (entry.expires <= Date.now()) mutations.delete(k);
    if (mutations.size >= 1024) throw new Error('Too many recent remote changes. Try again later.');
    const entry = { hash, expires: Infinity, result: undefined };
    entry.result = Promise.resolve().then(() => { signal?.throwIfAborted(); return mutate(method,params,signal); }).finally(() => { entry.expires = Date.now() + 300000; });
    mutations.set(key,entry);
    return entry.result;
  }
  return { dispatch, notify, close() { closed = true; for (const row of waiters) row.wake(); mutations.clear(); } };
}
