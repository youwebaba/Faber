import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { openStore } from './store.mjs';
import { checkTool, toolMetadata, validate, permissions } from './registry.mjs';
import { streamProvider, providerBody, testProvider, validateBaseUrl, validateCredentialTransport } from './provider.mjs';
import { validateChatImages, imageBytesLimit } from './images.mjs';
import { cleanUsage, usageSummary, closeIterator } from './usage.mjs';
import { inspectionCalls, inspectionContent, chatInspection, agentInspection } from './inspection.mjs';
import {contextTokensSchema,thinkingSchema,configuredControls} from './controls.mjs';
import {estimateInputTokens,callMetrics,estimateBasis} from './metrics.mjs';
import {workingMessages,compactContext,isContextOverflow,contextCapacityFromError} from './context.mjs';
import {defaultPromptPresets,generalPrompt,promptTextSchema,promptIdSchema,reasoningEffortSchema} from './prompts.mjs';
import {bugReportDraft,redactReport,reportIssueUrl,externalWebUrl} from './bug-report.mjs';

import { createRemoteWorkspace } from './remote-workspace.mjs';
import { createMediaStore, sourceMediaRefs } from './media.mjs';
import {createRoutines,routineSchemas} from './routines.mjs';

const now = () => new Date().toISOString();
const active = run => ['running', 'waiting_approval'].includes(run.status);
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1, maxLength: 200000 };
const idSchema = { type: 'string', minLength: 1, maxLength: 200 };
const projectGrantsSchema = { type: 'array', maxItems: 1000, items: idSchema };
const grantsSchema = { type: 'array', items: { enum: permissions.filter(permission => permission !== 'read') }, maxItems: 5 };
const defaults = { theme: 'dark', maxDepth: 4, maxAgents: 12, runTimeoutMs: 600000, uiScale: 1, onboardingComplete: false };
const runTimeoutSchema = { anyOf: [{ const: 0 }, { type: 'integer', minimum: 1000, maximum: 2147483647 }] };
const agentSettingsSchema = object({ theme: { enum: ['dark', 'light', 'system'] }, maxDepth: { type: 'integer', minimum: 0, maximum: 8 }, maxAgents: { type: 'integer', minimum: 1, maximum: 32 }, runTimeoutMs: runTimeoutSchema, uiScale: { type: 'number', minimum: 0.75, maximum: 1.5 }, onboardingComplete: { type: 'boolean' } }, []);
const settingsSchema = object({ ...agentSettingsSchema.properties, defaultGrants: grantsSchema }, []);
const presetSchema = object({ id: idSchema, name: { type: 'string', minLength: 1, maxLength: 100 }, text: promptTextSchema, builtin: { type: 'boolean' } }, ['id','name','text']);

function repairInterruptedTools(chat) {
  const messages = [];
  for (let index = 0; index < chat.messages.length; index++) {
    const message = chat.messages[index]; messages.push(message);
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    const answered = new Set();
    while (chat.messages[index + 1]?.role === 'tool') { const result = chat.messages[++index]; messages.push(result); answered.add(result.toolCallId); }
    for (const call of message.toolCalls) if (!answered.has(call.id)) messages.push({
      id: randomUUID(), role: 'tool', content: JSON.stringify({ error: 'Execution interrupted before a result was recorded. Effects may have occurred; do not replay automatically. Inspect evidence or ask the user before repeating.' }),
      createdAt: now(), toolCallId: call.id, toolName: call.name, status: 'interrupted', runId: message.runId, sourceMessageId: message.id, modelCallId: message.modelCallId,
    });
  }
  chat.messages = messages;
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(signal.reason || new Error('Canceled'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function createRuntime({ dataDir, sourceDir, host = {}, provider: injectedProvider }) {
  if (!dataDir || !sourceDir) throw new Error('dataDir and sourceDir are required');
  dataDir = resolve(dataDir); sourceDir = resolve(sourceDir);
  const location = relative(sourceDir, dataDir);
  if (!location || (!location.startsWith('..') && !isAbsolute(location))) throw new Error('Runtime data must be outside the source directory');
  const store = await openStore(dataDir, { version: 1, projects: [], chats: [], runs: [], providers: [{ id: 'local-ollama', name: 'Local Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', hasKey: false }], approvals: [], extensions: [], settings: defaults });
  const state = store.state;
  if (state.version !== 1 || ['projects', 'chats', 'runs', 'providers', 'approvals', 'extensions'].some(key => !Array.isArray(state[key]))) throw new Error('Unsupported or malformed harness state; original file preserved');
  state.settings = { ...structuredClone(defaults), ...state.settings };
  // Retire saved harness context/turn caps, including values from older releases.
  for (const key of ['contextChars', 'contextMessages', 'maxTurns']) delete state.settings[key];
  validate(state.settings, settingsSchema);
  // Keep new defaults outside the strict settings object so older releases can reopen this profile.
  if (!Object.hasOwn(state, 'defaultChatGrants')) state.defaultChatGrants = state.settings.defaultGrants ?? [];
  validate(state.defaultChatGrants, grantsSchema);
  if (new Set(state.defaultChatGrants).size !== state.defaultChatGrants.length) throw new Error('Duplicate default permissions');
  if (state.settings.defaultGrants && JSON.stringify(state.settings.defaultGrants) !== JSON.stringify(state.defaultChatGrants)) throw new Error('Conflicting default permissions; original file preserved');
  delete state.settings.defaultGrants;
  state.promptPresets ??= defaultPromptPresets();
  validate(state.promptPresets, { type: 'array', maxItems: 100, items: presetSchema });
  if (new Set(state.promptPresets.map(preset => preset.id)).size !== state.promptPresets.length) throw new Error('Duplicate prompt preset IDs');
  for (const run of state.runs) if (active(run)) {
    run.status = 'interrupted'; run.endedAt = now(); run.error = 'App restarted; interrupted work was not replayed';
    for (const event of run.toolEvents) if (['running', 'waiting_approval'].includes(event.status)) { event.status = 'interrupted'; event.endedAt = now(); }
  }
  for (const run of state.runs) for (const call of run.modelCalls || []) if (call.status === 'running') { call.status = 'interrupted'; call.endedAt = now(); }
  for (const run of state.runs) for (const correction of run.steering || []) if (correction.mode === 'native' && ['queued', 'accepted'].includes(correction.status)) {
    correction.status = 'unknown'; correction.error = 'App restarted before the provider steering outcome was confirmed. No correction was replayed.';
  }
  for (const chat of state.chats) {
    repairInterruptedTools(chat); chat.contextTokens??=null;
    chat.projectGrants ??= [];
    validate(chat.projectGrants, projectGrantsSchema);
    chat.projectGrants = [...new Set(chat.projectGrants)].filter(id => id !== chat.projectId && state.projects.some(project => project.id === id && !project.archived));
    if (chat.externalSessionId) chat.archived = true;
    if(chat.thinking===undefined)chat.thinking=state.providers.find(provider=>provider.id===chat.providerId)?.kind==='ollama'?false:null;
    chat.systemPrompt ??= generalPrompt; if(chat.systemPromptPresetId===undefined)chat.systemPromptPresetId='general'; chat.reasoningEffort ??= null;
    validate(chat.contextTokens,contextTokensSchema);validate(chat.thinking,thinkingSchema);
    validate(chat.systemPrompt,promptTextSchema);validate(chat.systemPromptPresetId,promptIdSchema);validate(chat.reasoningEffort,reasoningEffortSchema);
  }
  state.approvals = [];
  await store.save(state);
  const registry = new Map(), extensionNames = new Set(), listeners = new Set(), live = new Map(), pending = new Map(), settling=new Set();
  const providerEdits = new Set(), providerTests = new Map();
  const chatLocks=new Set();
  const streams = new Map(); let streamSequence = 0, stateRevision = 0;
  const routines=createRoutines({state,changed,emit,start,createChat,stopChat:chatId=>stopChats(chatTree(chatId),true),registry,host});
  const recentErrors = [];
  let closed = false;
  const mediaStore = createMediaStore({ dataDir, assertAnnotations(chatId) { const chat=state.chats.find(chat=>chat.id===chatId);if(closed||!chat||chat.archived||chat.externalSessionId||state.projects.find(project=>project.id===chat.projectId)?.archived)throw new Error('This chat is read-only'); }, findReference(chatId,mediaId) {
    const chat = state.chats.find(chat => chat.id === chatId);
    const sources = [...(chat?.messages || []), ...state.runs.filter(run => run.chatId === chatId).flatMap(run => run.toolEvents)];
    const media = chat && sources.flatMap(sourceMediaRefs).find(media => media.id === mediaId);
    if (!media) throw new Error('Media is no longer available for this chat');
    return media;
  } });
  const readMedia = (params,signal) => { if (closed) throw new Error('Runtime is closed'); return mediaStore.read(params,signal); };
  const mediaNotes = (action,params,signal) => { if (closed) throw new Error('Runtime is closed'); return mediaStore.notes(action,params,signal); };
  await mediaStore.prune(state.chats.map(chat=>chat.id));
  const remoteWorkspace = createRemoteWorkspace({ current: () => ({ state, streams, stateRevision }), request, readMedia, mediaNotes, modelDisplayName:host.modelDisplayName });
  function emit(event) { remoteWorkspace.notify(event); if(event.type === 'error'){recentErrors.push(redactReport(event.message ?? event.error ?? 'Unknown error'));if(recentErrors.length > 10)recentErrors.shift();}for (const listener of listeners) { try { listener(structuredClone(event)); } catch { /* A detached UI must not break execution. */ } } }
  function settingsSnapshot() { return structuredClone({ ...state.settings, defaultGrants: state.defaultChatGrants }); }
  function refreshUsage() {
    const groups = new Map(), runsById = new Map(state.runs.map(run => [run.id, run]));
    for (const run of state.runs) for (const messageId of run.promptMessageIds || []) groups.set(run.id + '/' + messageId, { owner: run.id, messageId, calls: [] });
    for (const run of state.runs) for (const call of run.modelCalls || []) {
      const owner = call.promptRunId || run.id, messageId = call.requestMessageId || run.requestMessageId;
      if (!messageId) continue;
      const key = owner + '/' + messageId;
      if (!groups.has(key)) groups.set(key, { owner, messageId, calls: [] });
      groups.get(key).calls.push(call);
    }
    const owners = new Map();
    for (const group of groups.values()) {
      if (!owners.has(group.owner)) owners.set(group.owner, []);
      const run = runsById.get(group.owner), sharedWithMessageId = run?.promptShares?.[group.messageId], summary = usageSummary(group.calls);
      if (!group.calls.length && sharedWithMessageId) Object.assign(summary, { status: 'unknown', allocation: 'shared', sharedWithMessageId });
      if (!group.calls.length && run?.steering?.some(item => item.messageId === group.messageId && ['unknown', 'failed'].includes(item.status))) summary.status = 'unknown';
      owners.get(group.owner).push({ requestMessageId: group.messageId, ...summary });
    }
    for (const run of state.runs) run.promptUsage = owners.get(run.id) || [];
  }
  function snapshot() { refreshUsage(); const { defaultChatGrants, ...publicState } = state; return structuredClone({ ...publicState, settings: settingsSnapshot(), tools: [...registry.values()].map(toolMetadata), streams: [...streams.values()], streamSequence, stateRevision }); }
  function clearStream(runId) { if (streams.delete(runId)) streamSequence++; }
  async function changed() { stateRevision++; refreshUsage(); await store.save(state); emit({ type: 'state', state: snapshot() }); }
  function find(collection, id) { const item = state[collection].find(entry => entry.id === id); if (!item) throw new Error(`Unknown ${collection}: ${id}`); return item; }
  function clearRunTimer(execution) { clearTimeout(execution.timer); execution.timer = null; }
  function scheduleRunTimer(run, execution) {
    clearRunTimer(execution);
    if (closed || !active(run) || execution.controller.signal.aborted || live.get(run.id) !== execution || state.settings.runTimeoutMs === 0) return;
    const expire = () => {
      if (live.get(run.id) !== execution || !active(run) || execution.controller.signal.aborted) return;
      stopRun(run.id, 'Run exceeded its configured time limit').catch(error => emit({ type: 'error', message: error.message }));
    };
    const remaining = state.settings.runTimeoutMs - (performance.now() - execution.started);
    if (remaining <= 0) { expire(); return; }
    const timer = setTimeout(() => { if (execution.timer !== timer) return; execution.timer = null; expire(); }, remaining);
    execution.timer = timer;
  }
  function addMessage(chat, role, content, extra = {}) { const message = { id: randomUUID(), role, content, createdAt: now(), ...extra }; chat.messages.push(message); chat.updatedAt = now(); return message; }
  function deliverInbox(chat, runId) {
    const messages = chat.inbox?.splice(0) || [], userIds = messages.filter(message => message.source === 'user').map(message => message.id);
    for (const message of messages) {
      addMessage(chat, 'user', message.text, {
      id: message.id, createdAt: message.createdAt, runId,
      ...(message.fromChatId ? { fromChatId: message.fromChatId } : {}),
      ...(message.source === 'user' ? { steering: true } : {}),
      ...(message.images?.length ? { images: [...message.images] } : {}),
      });
      if (message.source === 'user') {
        if (message.runId !== runId) {
          const previousRun = state.runs.find(run => run.id === message.runId);
          if (previousRun?.promptMessageIds) previousRun.promptMessageIds = previousRun.promptMessageIds.filter(id => id !== message.id);
        }
        const execution = live.get(runId);
        if (execution) { execution.promptRunId = runId; execution.requestMessageId = message.id; }
        const correction = state.runs.flatMap(run => run.steering || []).find(item => item.messageId === message.id);
        if (correction && correction.mode !== 'native') { correction.status = 'applied'; correction.appliedAt = now(); delete correction.waitingFor; }
      }
    }
    const run = state.runs.find(run => run.id === runId);
    if (run && userIds.length) {
      run.promptMessageIds = [...new Set([...(run.promptMessageIds || []), ...userIds])];
      for (const id of userIds.slice(0, -1)) (run.promptShares ||= {})[id] = userIds.at(-1);
    }
    return userIds;
  }
  function projectIds(run) {
    return new Set([find('chats', run.chatId).projectId, ...(run.projectGrants || [])].filter(id => state.projects.some(project => project.id === id && !project.archived)));
  }
  function assertRunAuthority(run) {
    routines.authority(run);
    for (let child = run; child.parentRunId;) {
      const parent = find('runs', child.parentRunId), projectId = find('chats', child.chatId).projectId;
      if (!projectIds(parent).has(projectId)) throw new Error('The parent no longer authorizes this project. Stop or request explicit project access.');
      child = parent;
    }
  }
  async function approveProject(run, projectId, summary) {
    const execution = live.get(run.id), source = find('chats', run.chatId);
    execution.controller.signal.throwIfAborted(); assertRunAuthority(run);
    const target = typeof projectId === 'object' ? projectId : find('projects', projectId), sourceProjectId = source.projectId;
    if(run.jobId&&target.id!==sourceProjectId)throw new Error('Routine project scope cannot expand during execution');
    projectId = target.id;
    if (target.archived) throw new Error('Project is archived');
    if (execution.externalSessionId && projectId !== sourceProjectId) throw new Error('External tool sessions are restricted to their selected project');
    if (projectId && projectIds(run).has(projectId)) return true;
    const approval = { id: randomUUID(), kind: 'project', chatId: run.chatId, runId: run.id, permission: 'project', sourceProjectId, ...(projectId ? { targetProjectId: projectId } : { rememberable: false }), targetProjectPath: target.path, projectName: target.name, summary: String(summary || `Access project ${target.name}: ${target.path}`).slice(0, 12000) };
    const promise = new Promise((resolveApproval, reject) => pending.set(approval.id, { resolve: resolveApproval, reject })); promise.catch(() => {});
    state.approvals.push(approval); run.status = 'waiting_approval';
    try {
      await changed(); emit({ type: 'approval', approval }); await abortable(promise, execution.controller.signal);
      execution.controller.signal.throwIfAborted(); assertRunAuthority(run);
      if (source.projectId !== sourceProjectId || projectId && find('projects', projectId).archived) throw new Error('Project scope changed while waiting for approval; retry the request.');
      if (projectId && !run.projectGrants.includes(projectId)) run.projectGrants.push(projectId);
    } finally {
      pending.delete(approval.id); state.approvals = state.approvals.filter(item => item.id !== approval.id);
      if (!execution.controller.signal.aborted) run.status = 'running'; await changed();
    }
    execution.controller.signal.throwIfAborted(); assertRunAuthority(run);
    return true;
  }
  async function revokeProjects(chat, selected) {
    const ids = chatTree(chat.id), allowed = new Set(selected);
    const removed = new Set([...chat.projectGrants, ...state.runs.filter(run => run.chatId === chat.id).flatMap(run => run.projectGrants || [])].filter(id => !allowed.has(id)));
    const cancel = new Set(state.runs.filter(run => ids.has(run.chatId) && live.has(run.id) && (run.projectGrants || []).some(id => removed.has(id))).map(run => run.id));
    chat.projectGrants = [...allowed];
    for (const candidate of state.chats) if (candidate.id !== chat.id && ids.has(candidate.id)) candidate.projectGrants = candidate.projectGrants.filter(id => !removed.has(id));
    for (const run of state.runs) if (ids.has(run.chatId)) {
      run.projectGrants = (run.projectGrants || []).filter(id => !removed.has(id));
      if (run.chatId === chat.id && active(run)) for (const id of allowed) if (!run.projectGrants.includes(id)) run.projectGrants.push(id);
    }
    for (const approval of state.approvals) if (approval.kind === 'project' && ids.has(approval.chatId) && !allowed.has(approval.targetProjectId)) { cancel.add(approval.runId); pending.get(approval.id)?.reject(new Error('Project access revoked by user')); }
    for (const run of state.runs) if (ids.has(run.chatId) && live.has(run.id)) {
      try { assertRunAuthority(run); } catch { cancel.add(run.id); }
    }
    if (cancel.size) await stopRuns(descendants(cancel), 'Project access revoked by user');
  }
  async function authorizePath(run, file, summary) {
    if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Path authorization requires an absolute path');
    const signal = live.get(run.id).controller.signal; signal.throwIfAborted();
    const canonical = async value => { try { return await realpath(value); } catch (error) { if (error.code !== 'ENOENT') throw error; return resolve(value); } };
    const target = await canonical(file), current = find('chats', run.chatId).projectId;
    await routines.assertPath(run,target);
    const inside = root => { const rel = relative(root, target); return !rel || rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };
    const privatePaths = await Promise.all([dataDir, ...(host.privatePaths || [])].map(canonical));
    if (privatePaths.some(inside)) throw new Error('Private Faber profile data is unavailable to scoped file tools');
    const scopes = state.projects.map(({ id, path, archived }) => ({ id, path, archived }));
    const roots = await Promise.all(state.projects.map(async project => ({ project, path: await canonical(project.path) })));
    const matches = roots.filter(root => inside(root.path));
    matches.sort((a, b) => b.path.length - a.path.length || Number(b.project.id === current) - Number(a.project.id === current));
    if (!matches.length) throw new Error('Path is outside registered projects; select its project and request explicit access first');
    await approveProject(run, matches[0].project.id, summary || `Access ${target} in project ${matches[0].project.name}`);
    signal.throwIfAborted();
    if (JSON.stringify(scopes) !== JSON.stringify(state.projects.map(({ id, path, archived }) => ({ id, path, archived })))) throw new Error('Registered project scope changed while authorizing this path; retry the tool');
    return true;
  }
  function scopedInspection(value, run) {
    const allowed = projectIds(run);
    if (value.chat?.parentChatId && !allowed.has(find('chats', value.chat.parentChatId).projectId)) delete value.chat.parentChatId;
    if (value.run?.parentRunId && !allowed.has(find('chats', find('runs', value.run.parentRunId).chatId).projectId)) delete value.run.parentRunId;
    return value;
  }
  function controls(chat,check=true){const connection=find('providers',chat.providerId),provider={...connection,model:chat.model||connection.model};return configuredControls(provider,chat,host.providerControls?.(provider.id,provider.model),check);}
  function chatTree(chatId){
    const ids=new Set([chatId]);for(let added=true;added;){added=false;for(const chat of state.chats)if(ids.has(chat.parentChatId)&&!ids.has(chat.id)){ids.add(chat.id);added=true;}}return ids;
  }
  function assertMutable(ids){for(const id of ids)if(chatLocks.has(id)||state.runs.some(run=>run.chatId===id&&live.has(run.id)))throw new Error('Stop this chat and its child agents before moving or deleting it.');}
  async function stopChats(ids,wait=false){
    const targets=descendants(state.runs.filter(run=>ids.has(run.chatId)).map(run=>run.id)),done=[];
    for(const id of targets)if(live.has(id))done.push(live.get(id).done);
    const result=await stopRuns(targets);
    if(wait)await Promise.all(done);
    return result;
  }
  function removeChats(ids){
    const runIds=new Set(state.runs.filter(run=>ids.has(run.chatId)).map(run=>run.id));
    state.chats=state.chats.filter(chat=>!ids.has(chat.id));state.runs=state.runs.filter(run=>!runIds.has(run.id));
    state.approvals=state.approvals.filter(approval=>!ids.has(approval.chatId)&&!runIds.has(approval.runId));
    for(const chat of state.chats){if(ids.has(chat.parentChatId))delete chat.parentChatId;chat.inbox=chat.inbox?.filter(message=>!ids.has(message.fromChatId));}
    for(const run of state.runs)if(runIds.has(run.parentRunId))delete run.parentRunId;
    return {deletedChatIds:[...ids],deletedRunIds:[...runIds]};
  }
  function descendants(rootId) {
    const result = new Set(typeof rootId === 'string' ? [rootId] : rootId), children = new Map();
    for (const run of state.runs) if (run.parentRunId) { if (!children.has(run.parentRunId)) children.set(run.parentRunId, []); children.get(run.parentRunId).push(run.id); }
    for (const id of result) for (const child of children.get(id) || []) result.add(child);
    return result;
  }
  function checkSpawn(parentRunId) {
    if (!parentRunId) return;
    let run = find('runs', parentRunId), depth = 1;
    if (!active(run) || live.get(run.id)?.controller.signal.aborted) throw new Error('Parent run is no longer active');
    while (run.parentRunId) { depth++; run = find('runs', run.parentRunId); }
    if (depth > state.settings.maxDepth) throw new Error('Agent depth limit reached');
    if (descendants(run.id).size >= state.settings.maxAgents) throw new Error('Agent tree limit reached');
  }
  async function approve(run, permission, summary,force=false) {
    const execution = live.get(run.id);
    execution.controller.signal.throwIfAborted();
    if (permission === 'read' || !force&&(run.grants.includes(permission) || execution.approved.has(permission))) return true;
    const approval = { id: randomUUID(), chatId: run.chatId, runId: run.id, permission, summary: String(summary).slice(0, 12000), ...(execution.externalSessionId ? { rememberable: false, externalSessionId: execution.externalSessionId } : {}),...(run.jobId?{rememberable:false,routineJobId:run.jobId}:{}) };
    const promise = new Promise((resolveApproval, reject) => pending.set(approval.id, { resolve: resolveApproval, reject }));
    promise.catch(() => {}); // Cancellation can arrive while the approval is still being persisted.
    state.approvals.push(approval); run.status = 'waiting_approval';
    routines.waiting(run);
    try {
      await changed(); emit({ type: 'approval', approval });
      await abortable(promise, execution.controller.signal);
      if(!force)execution.approved.add(permission);
      return true;
    } finally {
      pending.delete(approval.id); state.approvals = state.approvals.filter(item => item.id !== approval.id);
      if (!execution.controller.signal.aborted) run.status = 'running';
      routines.waiting(run);
      await changed();
    }
  }
  async function executeTool(run, name, args, origin = {}) {
    const tool = registry.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    validate(args, tool.parameters);
    const execution = live.get(run.id), signal = execution.controller.signal;
    signal.throwIfAborted(); assertRunAuthority(run);
    if (execution.externalTools && execution.externalTools.get(name) !== tool.execute) throw new Error('Tool is not available to this external session');
    const chat = find('chats', run.chatId), project = find('projects', chat.projectId);
    const event = { id: randomUUID(), name, args: structuredClone(args), status: 'running', startedAt: now(), ...origin };
    run.toolEvents.push(event);
    const operation = { event, stage: 'approval', superseded: false };
    execution.tool = operation;
    await changed();
    try {
      if (operation.superseded) throw new Error('Action superseded by steering before execution');
      const policy=await routines.prepareTool(run,tool,args,event,signal);
      if (!Object.hasOwn(policy,'result')&&(execution.externalSessionId || run.jobId || host.isAutomaticTool?.(tool, tool.permission) !== true)) await approve(run, tool.permission, `${name}\n${JSON.stringify(args)}`,policy.forceApproval);
      signal.throwIfAborted();
      if (operation.superseded) throw new Error('Action superseded by steering before execution');
      if(!Object.hasOwn(policy,'result'))await routines.dispatchTool(run,event);
      try{signal.throwIfAborted();if(operation.superseded)throw new Error('Action superseded by steering before execution');}
      catch(error){if(event.intent?.phase==='dispatching')event.intent.phase='prepared';throw error;}
      operation.stage = 'running';
      const value = Object.hasOwn(policy,'result')?policy.result:await abortable(tool.execute(args, { runtime: execution.externalSessionId ? Object.freeze({}) : runtime, chat: structuredClone(chat), project: structuredClone(project), runId: run.id, signal, dataDir, sourceDir, host, authorizePath: (file, summary) => authorizePath(run, file, summary), authorizeProject: (projectId, summary) => approveProject(run, projectId, summary), approve: (permission, summary) => {
        if (!permissions.includes(permission)) throw new Error('Unknown permission');
        signal.throwIfAborted();
        if (!execution.externalSessionId && !run.jobId&&host.isAutomaticTool?.(tool, permission) === true) return Promise.resolve(true);
        return approve(run, permission, summary,!!run.jobId&&['network','computer','shell','upgrade'].includes(permission));
      } }), signal);
      signal.throwIfAborted(); assertRunAuthority(run);
      const serialized = JSON.stringify(value ?? null);
      if (serialized.length > 16000000) throw new Error('Tool result exceeds 16 MB');
      event.result = JSON.parse(serialized); event.status = 'completed';
      await routines.toolReceipt(run,event,event.result);
      return event.result;
    } catch (error) { event.status = signal.aborted ? 'canceled' : operation.superseded ? 'superseded' : 'failed'; event.error = error.message; await routines.toolReceipt(run,event,undefined,error); throw error; }
    finally { if (execution.tool === operation) delete execution.tool; event.endedAt = now(); try { await changed(); } finally { await mediaStore.settle(chat.id); } }
  }
  function contextMessages(chat, provider, prompt = chat.systemPrompt, full = false) {
    const system = `${prompt ?? generalPrompt}\n\nFaber runtime context: current chat ${chat.id}; project ${find('projects', chat.projectId).path}. Tool access is enforced by the harness, not by the selected prompt.`;
    const responses = provider.kind === 'openai-responses';
    const latestImage = chat.messages.findLastIndex(message => message.image);
    if (latestImage >= 0 && chat.messages[latestImage].image.length > 8 * 1024 * 1024) throw new Error('Latest screenshot exceeds the 8 MiB model image limit');
    const inspections = inspectionCalls(chat);
    const messages = chat.messages.map((message, index) => ({
      ...message,
      providerOutput: responses && message.providerOutput?.providerId === provider.id && message.providerOutput?.baseUrl === provider.baseUrl && message.providerOutput?.model === provider.model ? message.providerOutput : undefined,
      image: index === latestImage ? message.image : undefined,
      content: inspectionContent(chat, message, inspections) + (message.image && index !== latestImage ? '\n[Earlier image omitted; only the latest screenshot is included.]' : ''),
    }));
    const projected = [{ role: 'system', content: system }, ...messages];
    return full ? projected : workingMessages(chat, projected);
  }
  async function modelTurn(run, configuration, messages, tools, purpose = 'response') {
    const chat = find('chats', run.chatId), execution = live.get(run.id), controller = new AbortController();
    const signal = AbortSignal.any([execution.controller.signal, controller.signal]);
    const attempt = { controller, purpose, steerVersion: execution.steerVersion || 0 };
    execution.modelAttempt = attempt;
    const stream = injectedProvider ? (typeof injectedProvider === 'function' ? injectedProvider : injectedProvider.stream.bind(injectedProvider)) : streamProvider;
    let lastAssistantId = chat.messages.findLast(message => message.role === 'assistant')?.id ?? null;
    const callRecord = () => ({ id: randomUUID(), sequence: run.modelCalls.length + 1, providerId: configuration.id, model: configuration.model, purpose, promptRunId: execution.promptRunId || run.id, requestMessageId: execution.requestMessageId || run.requestMessageId, startedAt: now(), status: 'running', phase: purpose === 'compaction' ? 'compacting' : 'thinking' });
    let modelCall = callRecord();
    const inputEstimate = estimateInputTokens(providerBody({ provider: configuration, messages, tools }));
    const callMeasurement = () => ({ started: performance.now(), estimatedInputTokens: inputEstimate, capacityTokens: run.contextCapacityTokens ?? null, characters: 0, usage: {}, timing: {} });
    let measurement = callMeasurement();
    const measure = () => modelCall.metrics = callMetrics(measurement);
    let content = '', providerOutput; const calls = [];
    function progress(phase, summary, force = false) {
      if (purpose === 'compaction') phase = 'compacting';
      const safeSummary = purpose === 'compaction' ? undefined : typeof summary === 'string' ? summary.slice(-4000) : phase === modelCall.phase ? modelCall.progressSummary : undefined;
      if (!['connecting', 'thinking', 'responding', 'preparing_tools', 'compacting'].includes(phase)) return;
      if (!force && modelCall.phase === phase && modelCall.progressSummary === safeSummary && streams.has(run.id)) return;
      modelCall.phase = phase; if (safeSummary === undefined) delete modelCall.progressSummary; else modelCall.progressSummary = safeSummary; measure();
      const partial = { chatId: chat.id, runId: run.id, text: purpose === 'response' ? content : '', sequence: ++streamSequence, lastAssistantId, modelCallId: modelCall.id, phase, progressSummary: safeSummary, metrics: structuredClone(modelCall.metrics) };
      streams.set(run.id, partial);
      emit({ type: 'progress', ...partial, streamSequence, summary: safeSummary });
    }
    measure(); run.modelCalls.push(modelCall);
    let iterator, finished = false;
    try {
      await changed(); signal.throwIfAborted(); progress(modelCall.phase);
      iterator = stream({ provider: configuration, messages, tools, signal, host, onSteer: handler => { attempt.steer = handler; } })[Symbol.asyncIterator]();
      while (true) {
        const next = await abortable(iterator.next(), signal);
        if (next.done) { finished = true; break; }
        const event = next.value;
        if (event.type === 'response_start') {
          if (modelCall.responseId && modelCall.responseId !== event.responseId) {
            modelCall.endedAt = now(); measure();
            if (modelCall.status === 'running') modelCall.status = 'completed';
            modelCall = callRecord(); measurement = callMeasurement(); run.modelCalls.push(modelCall);
            content = ''; calls.length = 0; providerOutput = undefined;
          }
          for (const id of attempt.appliedPromptIds?.slice(0, -1) || []) (run.promptShares ||= {})[id] = attempt.appliedPromptIds.at(-1);
          attempt.appliedPromptIds = [];
          modelCall.responseId = event.responseId;
          await changed(); progress(modelCall.phase, undefined, true);
        }
        if (event.type === 'response_end') { modelCall.status = event.status; modelCall.endedAt = now(); measure(); }
        if (event.type === 'progress') progress(event.phase, event.summary);
        if (event.type === 'delta' || event.type === 'text') {
          if (typeof event.text !== 'string') throw new Error('Provider returned invalid text');
          content = event.type === 'text' ? event.text : content + event.text;
          if (content.length > 1000000) throw new Error('Model response exceeds limit');
          if (purpose === 'response' && content.trim()) measurement.firstToken ??= performance.now();
          measurement.characters = content.length; measure();
          if (purpose === 'response') {
            modelCall.phase = 'responding'; delete modelCall.progressSummary;
            const partial = { chatId: chat.id, runId: run.id, text: content, sequence: ++streamSequence, lastAssistantId, modelCallId: modelCall.id, phase: modelCall.phase, progressSummary: modelCall.progressSummary, metrics: structuredClone(modelCall.metrics) };
            streams.set(run.id, partial);
            emit({ type: 'delta', ...partial, text: event.text, replace: event.type === 'text', streamSequence });
          }
        }
        if (event.type === 'provider_output') providerOutput = event.data;
        if (event.type === 'usage') { const usage = cleanUsage(event.usage); if (Object.keys(usage).length) modelCall.usage = { ...modelCall.usage, ...usage }; measurement.usage = modelCall.usage || {}; measure(); progress(modelCall.phase, undefined, true); }
        if (event.type === 'output_progress' && Number.isSafeInteger(event.characters) && event.characters >= 0) { measurement.toolCharacters = event.characters; measure(); progress('preparing_tools', undefined, true); }
        if (event.type === 'steering') {
          const correction = run.steering?.find(item => item.id === event.id);
          if (correction) {
            correction.status = event.status;
            if (event.status === 'accepted') correction.acceptedAt = now();
            if (event.status === 'applied') {
              (attempt.appliedPromptIds ||= []).push(correction.messageId);
              correction.appliedAt = now(); delete correction.waitingFor;
              if (content.trim()) {
                const partial = addMessage(chat, 'assistant', content, { status: modelCall.status === 'completed' ? 'completed' : 'interrupted', runId: run.id, modelCallId: modelCall.id });
                const correctionIndex = chat.messages.findIndex(message => message.id === correction.messageId);
                if (correctionIndex >= 0) { chat.messages.pop(); chat.messages.splice(correctionIndex, 0, partial); }
                lastAssistantId = partial.id;
              }
              content = ''; calls.length = 0; providerOutput = undefined; clearStream(run.id);
              execution.requestMessageId = correction.messageId; execution.promptRunId = run.id; attempt.steerVersion = execution.steerVersion;
            }
            if (event.error) correction.error = String(event.error).slice(0, 1500);
            await changed();
          }
        }
        if (event.type === 'timing' && Number.isFinite(event.timing?.generationMs) && event.timing.generationMs > 0) { measurement.timing.generationMs = event.timing.generationMs; measure(); }
        if (event.type === 'tool') {
          if (purpose === 'compaction') throw new Error('Context summarization must not request tools');
          if (calls.length >= 32) throw new Error('Too many tool calls in one turn');
          calls.push({ id: event.id || randomUUID(), name: event.name, args: event.args });
          measurement.toolCharacters = Math.max(measurement.toolCharacters || 0, calls.reduce((sum, call) => sum + String(call.name || '').length + (JSON.stringify(call.args)?.length || 0), 0));
          measure(); progress('preparing_tools', undefined, true);
        }
      }
      signal.throwIfAborted();
      if (!calls.length && !content.trim()) throw new Error('The model returned no visible answer. Retry, or try turning thinking off for this chat.');
      modelCall.status = 'completed';
      return { content, providerOutput, calls, modelCall, steerVersion: attempt.steerVersion };
    } catch (error) {
      clearStream(run.id); modelCall.status = execution.controller.signal.aborted ? 'canceled' : controller.signal.aborted ? 'interrupted' : 'failed'; modelCall.error = error.message;
      if (controller.signal.aborted && !execution.controller.signal.aborted) error.steered = true;
      for (const correction of run.steering || []) if (correction.mode === 'native' && ['queued', 'accepted'].includes(correction.status)) {
        correction.status = 'unknown'; correction.error = 'Connection ended before the steering outcome was confirmed. No correction or tool action was replayed.';
      }
      if (purpose === 'response' && content.trim()) addMessage(chat, 'assistant', content, { status: modelCall.status, runId: run.id, modelCallId: modelCall.id });
      if (content.trim() || calls.length) error.partialOutput = true;
      throw error;
    } finally {
      if (!finished) { controller.abort(new Error('Provider stream closed')); closeIterator(iterator); }
      if (execution.modelAttempt === attempt) delete execution.modelAttempt;
      modelCall.endedAt = now(); measure(); await changed();
    }
  }
  async function loop(run) {
    const chat = find('chats', run.chatId), signal = live.get(run.id).controller.signal;
    const configuration = { ...find('providers', run.providerId), model: run.model, chatOptions: run.chatOptions };
    if (!configuration.model) throw new Error('Select a model in provider settings');
    let estimateScale = 1;
    const tools = () => [...registry.values()].filter(tool=>!run.jobId||state.jobs.find(job=>job.id===run.jobId)?.definition.tools.includes(tool.name)).map(toolMetadata);
    const estimate = (messages, withTools = true) => Math.ceil(estimateInputTokens(providerBody({ provider: configuration, messages, tools: withTools ? tools() : [] })) * (withTools ? estimateScale : 1));
    async function compact(force = false) {
      const full = contextMessages(chat, configuration, run.systemPrompt, true);
      const latestUser = full.findLast(message => message.role === 'user' && !message.fromChatId);
      const minimum = estimate([...full.filter(message => message.role === 'system'), ...(latestUser ? [latestUser] : [])]);
      let capacityTokens = run.contextCapacityTokens || Math.max(4096, Math.ceil(minimum * 2), Math.floor(estimate(workingMessages(chat, full)) * 0.8));
      try {
        let checkpoint, summaryCapacityTokens = Math.min(capacityTokens, 16384);
        for (let attempt = 0; ; attempt++) {
          try {
            checkpoint = await compactContext({
              chat, messages: full, capacityTokens, estimate, signal, force, summaryBudgetTokens: run.compactionSummaryTokens, summaryCapacityTokens,
              summarize: async (messages, budgetTokens) => {
                const options = { ...configuration.chatOptions };
                if (['responses', 'llama_cpp', 'ollama'].includes(options.thinkingMode)) options.thinking = false;
                const declared = host.providerControls?.(configuration.id, configuration.model);
                if (declared?.reasoning?.efforts?.includes('low')) options.reasoningEffort = 'low';
                const provider = { ...configuration, chatOptions: options, compactionTokens: Math.max(128, Math.min(Math.floor(summaryCapacityTokens * 0.2), budgetTokens * 2 + 256)) };
                try {
                  const result = await modelTurn(run, provider, messages, [], 'compaction');
                  signal.throwIfAborted(); return result.content;
                } catch (error) {
                  if (isContextOverflow(error) && !error.partialOutput) error.summaryContextOverflow = true;
                  throw error;
                }
              },
            });
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (!error.summaryContextOverflow || attempt >= 2) throw error;
            const reported = contextCapacityFromError(error);
            if (reported) {
              capacityTokens = Math.min(capacityTokens, reported); run.contextCapacityTokens = reported;
              chat.contextCapacityHint = { providerId: configuration.id, baseUrl: configuration.baseUrl, model: configuration.model, capacityTokens: reported };
            }
            summaryCapacityTokens = Math.max(512, Math.floor(Math.min(summaryCapacityTokens, capacityTokens) / 2));
          }
        }
        signal.throwIfAborted();
        const previous = chat.contextCheckpoint;
        chat.contextCheckpoint = { ...checkpoint, createdAt: now() };
        try { await changed(); } catch (error) { chat.contextCheckpoint = previous; throw error; }
        run.compactions = (run.compactions || 0) + 1;
        clearStream(run.id);
      } catch (error) {
        signal.throwIfAborted(); run.contextOverflow = true;
        throw new Error('Context recovery failed: ' + error.message, { cause: error });
      }
    }
    let forceCompact = Boolean(run.compactRequested); delete run.compactRequested;
    responseLoop: while (true) {
      signal.throwIfAborted(); assertRunAuthority(run);
      if (chat.inbox?.length) {
        deliverInbox(chat, run.id);
        await changed();
      }
      const messageCount = chat.messages.length;
      let messages = contextMessages(chat, configuration, run.systemPrompt);
      if (forceCompact || run.contextCapacityTokens && estimate(messages) > run.contextCapacityTokens * 0.8) {
        await compact(forceCompact); forceCompact = false;
        messages = contextMessages(chat, configuration, run.systemPrompt);
      }
      if (chat.inbox?.some(message => message.mode === 'steer')) continue;
      let result, recoveries = 0;
      while (true) {
        try { result = await modelTurn(run, configuration, messages, tools()); break; }
        catch (error) {
          signal.throwIfAborted();
          if (error.steered) continue responseLoop;
          if (!isContextOverflow(error) || error.partialOutput) throw error;
          run.contextOverflow = true;
          const reported = contextCapacityFromError(error);
          if (reported) {
            run.contextCapacityTokens = reported;
            chat.contextCapacityHint = { providerId: configuration.id, baseUrl: configuration.baseUrl, model: configuration.model, capacityTokens: reported };
          }
          if (recoveries++ >= 2) throw new Error('The provider still rejected the condensed context. Shorten the latest message or attachments, reduce the system prompt/tools, or increase the model context.');
          // Retry only a rejected model request; completed tool actions stay in the transcript.
          run.compactionSummaryTokens = Math.max(64, Math.floor((run.compactionSummaryTokens || Math.min(2048, (run.contextCapacityTokens || estimate(messages)) * 0.12)) / (recoveries > 1 ? 2 : 1)));
          await compact(true);
          messages = contextMessages(chat, configuration, run.systemPrompt);
        }
      }
      delete run.contextOverflow; delete run.compactionSummaryTokens;
      const { content, providerOutput, calls, modelCall, steerVersion } = result;
      if (!messages.some(message => message.image || message.images?.length || message.providerOutput?.items?.some(item => item.encrypted_content)) && modelCall.usage?.inputTokens && modelCall.metrics.estimatedInputTokens) estimateScale = Math.max(1, modelCall.usage.inputTokens / modelCall.metrics.estimatedInputTokens);
      signal.throwIfAborted();
      if (new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('Provider returned duplicate tool call IDs');
      if (calls.some(call => chat.messages.some(message => message.toolCalls?.some(previous => previous.id === call.id)))) throw new Error('Provider repeated a previously dispatched tool call ID');
      const assistantMessage = addMessage(chat, 'assistant', content, { ...(calls.length ? { toolCalls: calls } : {}), ...(providerOutput ? { providerOutput } : {}), status: 'completed', runId: run.id, modelCallId: modelCall.id });
      clearStream(run.id); await changed();
      if (!calls.length) {
        const unconsumed = chat.messages.slice(messageCount).some(message => message.role === 'user' && !run.steering?.some(item => item.messageId === message.id && item.mode === 'native' && item.status === 'applied'));
        if (chat.inbox?.length || unconsumed) continue;
        return;
      }
      for (const call of calls) {
        signal.throwIfAborted();
        let result;
        try {
          if ((live.get(run.id).steerVersion || 0) > steerVersion) result = { error: 'Action superseded by steering before execution; no tool was dispatched.' };
          else result = await executeTool(run, call.name, call.args, { toolCallId: call.id, sourceMessageId: assistantMessage.id, modelCallId: modelCall.id });
        }
        catch (error) { signal.throwIfAborted(); result = { error: error.message }; }
        const image = typeof result?.image === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(result.image) ? result.image : undefined;
        const textResult = image ? { ...result, image: '[image supplied to model]' } : result;
        const mediaRefs = sourceMediaRefs({ result });
        addMessage(chat, 'tool', JSON.stringify(textResult), { toolName: call.name, toolCallId: call.id, runId: run.id, sourceMessageId: assistantMessage.id, modelCallId: modelCall.id, ...(image ? { image } : {}), ...(mediaRefs.length ? { mediaRefs } : {}) });
        await changed();
      }
    }
  }
  async function start(chat, text, parentRunId, singleTool, images, compactRequested = false, executionOptions = {}) {
    const projectId=chat.projectId;
    const checkTarget=()=>{
      chat=find('chats',chat.id);
      if(chat.projectId!==projectId)throw new Error('Chat moved while waiting for approval; retry the request.');
      if (closed) throw new Error('Runtime is closed');
      if (chat.archived) throw new Error('Chat is archived');
      if (chat.externalSessionId && chat.externalSessionId !== executionOptions.externalSessionId) throw new Error('This chat belongs to an external tool session');
      if(chat.routineJobId&&chat.routineJobId!==executionOptions.routineJobId)throw new Error('Start or resume this job from Routines; its authority is fixed');
      if(find('projects',chat.projectId).archived)throw new Error('Project is archived');
      if(chatLocks.has(chat.id))throw new Error('Chat is being stopped or changed; wait for the operation to finish.');
      if (state.runs.some(run => run.chatId === chat.id && (active(run) || live.has(run.id)))) throw new Error('Chat already has an active run or is still stopping');
    };
    checkTarget();
    checkSpawn(parentRunId);
    if (parentRunId) {
      const parentRun = find('runs', parentRunId), origin = find('chats', parentRun.chatId);
      await approveProject(parentRun, chat.projectId, `Start an agent in project ${find('projects', chat.projectId).name}: ${find('projects', chat.projectId).path}`);
      live.get(parentRunId).controller.signal.throwIfAborted();
      checkSpawn(parentRunId);
      checkTarget();
    }
    if ([...live.values()].length >= state.settings.maxAgents) throw new Error('Concurrent run limit reached');
    if (providerEdits.has(chat.providerId)) throw new Error('Provider configuration is being saved; retry after it finishes');
    const model = chat.model || find('providers', chat.providerId).model;
    const selected=singleTool?null:controls(chat);
    const chatOptions=selected?{contextTokens:selected.contextTokens,thinking:selected.thinking.selected,thinkingMode:selected.thinking.mode,reasoningEffort:selected.reasoning?.selected??null,defaultReasoningEffort:selected.reasoning?.default!=='none'&&selected.reasoning?.default?selected.reasoning.default:selected.reasoning?.efforts.find(effort=>effort!=='none')}:undefined;
    if (!singleTool) host.assertProviderAvailable?.(chat.providerId, model,{contextTokens:chat.contextTokens??null,thinking:chat.thinking??null,reasoningEffort:chat.reasoningEffort??null});
    const modelDisplayName = host.modelDisplayName?.(chat.providerId, model) || model;
    const parent = parentRunId ? find('runs', parentRunId) : null;
    const sameProject = !parent || find('chats', parent.chatId).projectId === chat.projectId;
    const started = performance.now();
    const run = { id: randomUUID(), chatId: chat.id, providerId: chat.providerId, model, ...(parentRunId ? { parentRunId } : {}), status: 'running', startedAt: now(), toolEvents: [], modelCalls: [], grants: parent ? (sameProject ? chat.grants.filter(permission => parent.grants.includes(permission)) : []) : [...chat.grants], projectGrants: parent ? [...projectIds(parent)].filter(id => id !== chat.projectId) : [...chat.projectGrants] };
    if(executionOptions.routineJobId){run.jobId=executionOptions.routineJobId;run.grants=routines.grants(run.jobId);run.projectGrants=[];}
    if (executionOptions.externalSessionId) { run.grants = []; run.projectGrants = []; run.externalSessionId = executionOptions.externalSessionId; }
    const inboxPromptIds = singleTool ? [] : deliverInbox(chat, run.id);
    const requestMessage = text !== undefined ? addMessage(chat, 'user', text, { runId: run.id, ...(images?.length ? { images: [...images] } : {}) }) : null;
    if (compactRequested) run.compactRequested = true;
    run.modelDisplayName = modelDisplayName;
    run.systemPrompt = chat.systemPrompt ?? generalPrompt;
    if (requestMessage) { run.requestMessageId = requestMessage.id; requestMessage.runId = run.id; }
    run.promptMessageIds = [...inboxPromptIds, ...(!parent && requestMessage ? [requestMessage.id] : [])];
    const currentPrompt = run.promptMessageIds.at(-1);
    if (currentPrompt) for (const id of inboxPromptIds.filter(id => id !== currentPrompt)) (run.promptShares ||= {})[id] = currentPrompt;
    if(selected){run.chatOptions=chatOptions;run.contextCapacityTokens=selected.context.mode==='ollama'?selected.contextTokens:selected.context.capacityTokens;}
    const hint = chat.contextCapacityHint;
    if (!run.contextCapacityTokens && hint?.providerId === run.providerId && hint.baseUrl === find('providers', run.providerId).baseUrl && hint.model === run.model && Number.isSafeInteger(hint.capacityTokens) && hint.capacityTokens > 0) run.contextCapacityTokens = hint.capacityTokens;
    if (compactRequested && !run.requestMessageId) run.requestMessageId = chat.messages.findLast(message => message.role === 'user' && !message.fromChatId)?.id;
    if (compactRequested && run.requestMessageId && !run.promptMessageIds.includes(run.requestMessageId)) run.promptMessageIds.push(run.requestMessageId);
    state.runs.push(run);
    const controller = new AbortController();
    let finish;
    const done = new Promise(resolveDone => { finish = resolveDone; });
    const execution = { controller, approved: new Set(parentRunId && sameProject ? live.get(parentRunId)?.approved || [] : []), done, ...executionOptions, started, timer: null,
      promptRunId: parent ? live.get(parent.id)?.promptRunId || parent.id : run.id,
      requestMessageId: parent ? live.get(parent.id)?.requestMessageId || parent.requestMessageId : run.requestMessageId,
    };
    live.set(run.id, execution);
    settling.add(done);
    try { await changed(); } catch (error) { clearRunTimer(execution); live.delete(run.id); state.runs.splice(state.runs.indexOf(run), 1); finish();settling.delete(done); throw error; }
    scheduleRunTimer(run, execution);
    setImmediate(async () => {
      let result;
      try {
        controller.signal.throwIfAborted();
        result = singleTool ? await executeTool(run, singleTool.name, singleTool.args) : await loop(run);
        controller.signal.throwIfAborted(); run.status = 'completed';
      } catch (error) { run.status = controller.signal.aborted ? 'canceled' : 'failed'; run.error = error.message; if (isContextOverflow(error) || error.contextOverflow) run.contextOverflow = true; }
      finally {
        clearRunTimer(execution); clearStream(run.id); run.endedAt = now();
        if (run.status === 'failed' || run.status === 'canceled') {
          const children = state.runs.filter(item => item.parentRunId === run.id);
          try { if (children.length) await stopRuns(descendants(children.map(child => child.id)), `Parent run ${run.status}`); } catch (error) { emit({ type: 'error', message: error.message }); }
          repairInterruptedTools(chat);
        }
        live.delete(run.id);
        try{await routines.runEnded(run);}catch(error){emit({type:'error',message:'Routine receipt could not be saved: '+error.message});}
        try { await changed(); } catch (error) { emit({ type: 'error', message: `Could not persist run: ${error.message}` }); }
        finish({ runId: run.id, status: run.status, result, ...(run.error ? { error: run.error } : {}) });
        settling.delete(done);
      }
    });
    return { runId: run.id };
  }
  async function stopRuns(ids, reason = 'Stopped by user or parent agent') {
    let stopping = false;
    for (const id of ids) {
      const execution = live.get(id);
      if (execution) {
        stopping = true;
        clearRunTimer(execution); clearStream(id);
        execution.controller.abort(new Error(reason));
        const run = find('runs', id); run.status = 'canceled'; run.endedAt = now();
      }
    }
    for (const approval of state.approvals) if (ids.has(approval.runId)) pending.get(approval.id)?.reject(new Error('Run canceled'));
    state.approvals = state.approvals.filter(item => !ids.has(item.runId));
    if (stopping) await changed(); return { stopped: [...ids] };
  }
  function stopRun(runId, reason) { return stopRuns(descendants(runId), reason); }
  async function createChat(projectId, title = 'New chat', parentChatId, externalSessionId) {
    if(find('projects', projectId).archived)throw new Error('Project is archived');
    const parent = parentChatId ? find('chats', parentChatId) : null;
    if(parent&&chatLocks.has(parent.id))throw new Error('Parent chat is being changed');
    const sameProject = parent?.projectId === projectId;
    const grants = parent ? (sameProject ? [...parent.grants] : []) : externalSessionId ? [] : [...state.defaultChatGrants];
    const chat = { id: randomUUID(), projectId, title, providerId: parent?.providerId || state.providers[0].id, model: parent?.model || '', grants, projectGrants: sameProject ? [...parent.projectGrants] : [], voice: { enabled: false, phrase: 'Hey Faber', speakReplies: true }, messages: [], createdAt: now(), updatedAt: now(), archived: false, ...(parentChatId ? { parentChatId } : {}), ...(externalSessionId ? { externalSessionId } : {}) };
    chat.contextTokens=parent?.contextTokens??null;chat.thinking=parent?(parent.thinking??null):(find('providers',chat.providerId).kind==='ollama'?false:null);
    const preset = state.promptPresets.find(item => item.id === 'general');
    chat.systemPrompt = parent?.systemPrompt ?? preset?.text ?? generalPrompt;
    chat.systemPromptPresetId = parent ? parent.systemPromptPresetId : (preset?.id ?? null);
    chat.reasoningEffort = parent?.reasoningEffort ?? null;
    state.chats.push(chat); await changed(); return chat;
  }
  function install(tools, replace = false) {
    if (!Array.isArray(tools)) throw new Error('Tools must be an array');
    const next = new Map(registry);
    if (replace) for (const name of extensionNames) next.delete(name);
    for (const tool of tools) { checkTool(tool); if (next.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`); next.set(tool.name, { ...tool, parameters: structuredClone(tool.parameters) }); }
    registry.clear(); for (const [name, tool] of next) registry.set(name, tool);
    if (replace) { extensionNames.clear(); tools.forEach(tool => extensionNames.add(tool.name)); }
    stateRevision++;
    emit({ type: 'state', state: snapshot() });
  }
  const schemas = {
    'state.get': object({}), 'project.create': object({ name: string, path: string }, ['name']), 'project.update': object({ id: idSchema, name: string }, ['id']),
    'chat.create': object({ projectId: idSchema, title: string }, ['projectId']),
    'chat.update': object({ id: idSchema, title: string, providerId: idSchema, model: { type: 'string', maxLength: 300 },contextTokens:contextTokensSchema,thinking:thinkingSchema,reasoningEffort:reasoningEffortSchema,systemPrompt:promptTextSchema,systemPromptPresetId:promptIdSchema, projectGrants: projectGrantsSchema, grants: grantsSchema, voice: object({ enabled: { type: 'boolean' }, phrase: string, speakReplies: { type: 'boolean' } }, []) }, ['id']),
    'chat.send': object({ chatId: idSchema, text: { type: 'string', maxLength: 200000 }, images: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: imageBytesLimit } } }, ['chatId', 'text']),
    'chat.steer': object({ chatId: idSchema, runId: idSchema, text: { type: 'string', maxLength: 200000 }, images: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: imageBytesLimit } }, correctionId: idSchema }, ['chatId', 'runId', 'text']),
    'chat.stop': object({ chatId: idSchema }), 'chat.archive': object({ chatId: idSchema }),
    'chat.compact':object({chatId:idSchema}),'chat.controls':object({chatId:idSchema}),'chat.forceStop':object({chatId:idSchema}),'chat.delete':object({chatId:idSchema}),'chat.move':object({chatId:idSchema,projectId:idSchema}),
    'project.archive':object({projectId:idSchema}),'project.delete':object({projectId:idSchema}),
    'provider.save': object({ id: idSchema, name: string, kind: { enum: ['openai', 'ollama', 'openai-responses'] }, baseUrl: string, model: { type: 'string', maxLength: 300 }, apiKey: { type: 'string', maxLength: 10000 }, reasoningEffort: { enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] } }, ['name', 'kind', 'baseUrl', 'model']),
    'provider.test': object({ id: idSchema }), 'approval.resolve': object({ id: idSchema, allow: { type: 'boolean' }, remember: { type: 'boolean' } }, ['id', 'allow']),
    'tool.run': object({ chatId: idSchema, name: string, args: { type: 'object' } }), 'settings.update': settingsSchema,
    'promptPresets.save': object({ id: idSchema, name: presetSchema.properties.name, text: promptTextSchema }, ['name','text']),
    'promptPresets.delete': object({ id: idSchema }), 'promptPresets.reset': object({ id: idSchema }),
    'app.bugReportDraft': object({ description: { type:'string',maxLength:8000 }, steps: { type:'string',maxLength:8000 }, errors: {type:'array',maxItems:20,items:{type:'string',maxLength:24000}} }, []),
    'app.reportIssue': object({ title: {type:'string',minLength:1,maxLength:300}, body: {type:'string',maxLength:24000} }),
    'app.openLink': object({ url: {type:'string',minLength:1,maxLength:8192} }),
    'extensions.reload': object({}), 'voice.start': object({ chatId: idSchema, mode: { enum: ['dictation', 'assistant'] } }), 'voice.stop': object({ chatId: idSchema }, []), 'voice.speak': object({ text: string }), 'app.openPath': object({ path: string }), 'app.restart': object({}),
  };
  async function request(method, params = {}) {
    if (closed) throw new Error('Runtime is closed');
    if(Object.hasOwn(routineSchemas,method))return routines.request(method,params);
    if (!Object.hasOwn(schemas, method)) throw new Error(`Unknown request: ${method}`);
    validate(params, schemas[method]);
    switch (method) {
      case 'state.get': return snapshot();
      case 'promptPresets.save': {
        if (!params.name.trim()) throw new Error('A prompt preset needs a name');
        const existing = params.id ? find('promptPresets', params.id) : null;
        if (!existing && state.promptPresets.length >= 100) throw new Error('Prompt preset library is full');
        const preset = { id: existing?.id ?? randomUUID(), name: params.name.trim(), text: params.text, builtin: existing?.builtin ?? false };
        if (existing) Object.assign(existing, preset); else state.promptPresets.push(preset);
        await changed(); return structuredClone(preset);
      }
      case 'promptPresets.delete': {
        find('promptPresets', params.id);
        if (params.id === 'general') throw new Error('Edit or reset the General preset instead of deleting it');
        state.promptPresets = state.promptPresets.filter(item => item.id !== params.id);
        for (const chat of state.chats) if (chat.systemPromptPresetId === params.id) chat.systemPromptPresetId = null;
        await changed(); return { deleted: true };
      }
      case 'promptPresets.reset': {
        const preset = defaultPromptPresets().find(item => item.id === params.id);
        if (!preset) throw new Error('Only a built-in prompt preset can be reset');
        const existing = state.promptPresets.find(item => item.id === params.id);
        if (existing) Object.assign(existing, preset); else { if(state.promptPresets.length >= 100)throw new Error('Prompt preset library is full');state.promptPresets.push(preset); }
        await changed(); return structuredClone(preset);
      }
      case 'project.create': {
        const selected = params.path || await host.chooseDirectory?.();
        if (!selected) throw new Error('No project directory selected');
        if (!isAbsolute(selected)) throw new Error('Project path must be absolute');
        const project = { id: randomUUID(), name: params.name, path: resolve(selected), createdAt: now() };
        state.projects.push(project); await changed(); return structuredClone(project);
      }
      case 'project.update': { const project = find('projects', params.id); if (params.name !== undefined) project.name = params.name; await changed(); return structuredClone(project); }
      case 'chat.create': return structuredClone(await createChat(params.projectId, params.title));
      case 'chat.update': {
        const chat = find('chats', params.id);
        if (params.providerId) find('providers', params.providerId);
        if(chatLocks.has(chat.id))throw new Error('Chat is being stopped or changed');
        if(chat.routineJobId&&['providerId','model','grants','projectGrants','systemPrompt','systemPromptPresetId'].some(key=>Object.hasOwn(params,key)))throw new Error('Edit the routine definition instead of changing its job chat authority');
        if (chat.externalSessionId && ['providerId','model','grants','projectGrants'].some(key => Object.hasOwn(params, key))) throw new Error('External session authority and provider are fixed when the session is created');
        const { id, voice, projectGrants, ...updates } = params;
        if (projectGrants !== undefined) for (const projectId of projectGrants) if (find('projects', projectId).archived) throw new Error('Project is archived');
        if (params.systemPromptPresetId) {
          const preset = find('promptPresets', params.systemPromptPresetId);
          if (params.systemPrompt === undefined) updates.systemPrompt = preset.text;
        } else if (params.systemPrompt !== undefined && params.systemPromptPresetId === undefined) updates.systemPromptPresetId = null;
        if((params.providerId!==undefined&&params.providerId!==chat.providerId)||(params.model!==undefined&&params.model!==chat.model)){
          if(params.contextTokens===undefined)updates.contextTokens=null;if(params.thinking===undefined)updates.thinking=null;if(params.reasoningEffort===undefined)updates.reasoningEffort=null;
        }
        if(['providerId','model','contextTokens','thinking','reasoningEffort'].some(key=>Object.hasOwn(params,key)))controls({...chat,...updates});
        if (projectGrants !== undefined) await revokeProjects(chat, [...new Set(projectGrants)].filter(projectId => projectId !== chat.projectId));
        Object.assign(chat, updates); if (voice) Object.assign(chat.voice, voice); chat.updatedAt = now();
        await changed(); return structuredClone(chat);
      }
      case 'chat.controls':{
        const chat=find('chats',params.chatId),selected=controls(chat,false),connection=find('providers',chat.providerId),provider={...connection,model:chat.model||connection.model};
        const estimatedTokens=estimateInputTokens(providerBody({provider,messages:contextMessages(chat,provider),tools:[...registry.values()].map(toolMetadata)}));
        return {...selected,context:{...selected.context,estimatedTokens,estimateBasis}};
      }
      case 'chat.compact': {
        const chat = find('chats', params.chatId);
        if (!chat.messages.some(message => message.role === 'user')) throw new Error('This chat has no request to continue');
        return start(chat, undefined, undefined, undefined, undefined, true);
      }
      case 'chat.steer':
      case 'chat.send': {
        validateChatImages(params.images);
        if (!params.text.trim() && !params.images?.length) throw new Error('A message requires text or an image');
        const chat = find('chats', params.chatId), run = state.runs.find(run => run.chatId === chat.id && active(run));
        if (chat.externalSessionId) throw new Error('This chat belongs to an external tool session');
        if (chatLocks.has(chat.id)) throw new Error('Chat is being stopped or changed');
        if (chat.archived || find('projects', chat.projectId).archived) throw new Error('Chat or project is archived');
        if (method === 'chat.steer') {
          const previous = params.correctionId && state.runs.filter(item => item.chatId === chat.id).flatMap(item => item.steering || []).find(item => item.id === params.correctionId);
          if (previous) {
            if (previous.runId !== params.runId || previous.text !== params.text || JSON.stringify(previous.images || []) !== JSON.stringify(params.images || [])) throw new Error('Conflicting steering correction ID');
            return { runId: previous.runId, messageId: previous.messageId, status: previous.status, mode: previous.mode, ...(previous.waitingFor ? { waitingFor: previous.waitingFor } : {}) };
          }
          if (!run || run.id !== params.runId) throw new Error('The intended task has finished or changed; send a new message instead.');
          const execution = live.get(run.id);
          if (!execution || execution.controller.signal.aborted) throw new Error('Chat is stopping; wait for it to settle');
          if ((run.steering || []).filter(item => ['queued', 'accepted'].includes(item.status)).length >= 32) throw new Error('Too many pending corrections');
          const attempt = execution.modelAttempt, native = attempt?.purpose === 'response' && typeof attempt.steer === 'function';
          const correction = { id: params.correctionId || randomUUID(), messageId: randomUUID(), runId: run.id, text: params.text, ...(params.images?.length ? { images: [...params.images] } : {}), status: 'queued', mode: native ? 'native' : 'restart', createdAt: now(), waitingFor: execution.tool ? execution.tool.stage === 'approval' ? 'approval' : 'tool' : 'model' };
          (run.steering ||= []).push(correction); execution.steerVersion = (execution.steerVersion || 0) + 1;
          (run.promptMessageIds ||= []).push(correction.messageId);
          if (native) {
            addMessage(chat, 'user', correction.text, { id: correction.messageId, createdAt: correction.createdAt, runId: run.id, steering: true, ...(correction.images ? { images: correction.images } : {}) });
            try { attempt.steer(correction); }
            catch (error) { correction.status = 'unknown'; correction.error = 'Steering could not be confirmed. No correction was replayed.'; }
          } else {
            (chat.inbox ||= []).push({ id: correction.messageId, text: correction.text, source: 'user', mode: 'steer', runId: run.id, createdAt: correction.createdAt, ...(correction.images ? { images: correction.images } : {}) });
            if (attempt?.purpose === 'response') attempt.controller.abort(new Error('Model attempt interrupted by steering'));
            if (execution.tool?.stage === 'approval') {
              execution.tool.superseded = true;
              for (const approval of state.approvals) if (approval.runId === run.id) pending.get(approval.id)?.reject(new Error('Action superseded by steering before execution'));
            }
          }
          await changed();
          return { runId: run.id, messageId: correction.messageId, status: correction.status, mode: correction.mode, ...(correction.waitingFor ? { waitingFor: correction.waitingFor } : {}) };
        }
        if (run) {
          if (!live.has(run.id) || live.get(run.id).controller.signal.aborted) throw new Error('Chat is stopping; wait for it to settle');
          if (chat.inbox?.length >= 32) throw new Error('Chat followup queue is full');
          const message = { id: randomUUID(), text: params.text, source: 'user', runId: run.id, createdAt: now(), ...(params.images?.length ? { images: [...params.images] } : {}) };
          (run.promptMessageIds ||= []).push(message.id);
          (chat.inbox ||= []).push(message); await changed();
          return { runId: run.id, queued: true, messageId: message.id };
        }
        return start(chat, params.text, undefined, undefined, params.images);
      }
      case 'chat.stop': {
        find('chats', params.chatId); return stopChats(chatTree(params.chatId));
      }
      case 'chat.forceStop':{
        find('chats',params.chatId);const ids=chatTree(params.chatId);
        for(const id of ids)if(chatLocks.has(id))throw new Error('Chat operation already pending');
        ids.forEach(id=>chatLocks.add(id));
        try{return {...await stopChats(ids,true),settled:true};}finally{ids.forEach(id=>chatLocks.delete(id));}
      }
      case 'chat.archive': {
        find('chats',params.chatId);const ids=chatTree(params.chatId);
        for(const id of ids)if(chatLocks.has(id))throw new Error('Chat operation already pending');
        ids.forEach(id=>chatLocks.add(id));
        try{for(const chat of state.chats)if(ids.has(chat.id))chat.archived=true;await stopChats(ids,true);await changed();return {ok:true};}
        finally{ids.forEach(id=>chatLocks.delete(id));}
      }
      case 'chat.move':{
        const chat=find('chats',params.chatId),project=find('projects',params.projectId),ids=chatTree(chat.id);
        if(project.archived)throw new Error('Destination project is archived');assertMutable(ids);
        for(const candidate of state.chats)if(ids.has(candidate.id)){candidate.projectId=project.id;candidate.grants=[];candidate.projectGrants=[];candidate.updatedAt=now();}
        // The moved root no longer belongs to its old parent tree; keep child lineage inside the moved subtree.
        delete chat.parentChatId;
        const movedRuns=new Set(state.runs.filter(run=>ids.has(run.chatId)).map(run=>run.id));
        for(const run of state.runs)if(run.parentRunId&&(movedRuns.has(run.id)!==movedRuns.has(run.parentRunId)))delete run.parentRunId;
        await changed();return {ok:true,chatIds:[...ids],projectId:project.id};
      }
      case 'chat.delete':{
        find('chats',params.chatId);const ids=chatTree(params.chatId);assertMutable(ids);const result=removeChats(ids);await changed();await mediaStore.prune([...ids],true);return {ok:true,...result};
      }
      case 'project.archive':{
        const project=find('projects',params.projectId),ids=new Set(state.chats.filter(chat=>chat.projectId===project.id).map(chat=>chat.id));
        if([...ids].some(id=>chatLocks.has(id)))throw new Error('A project chat operation is pending');
        project.archived=true;for(const chat of state.chats)if(ids.has(chat.id))chat.archived=true;
        await stopChats(ids,true);await changed();return {ok:true,projectId:project.id};
      }
      case 'project.delete':{
        const project=find('projects',params.projectId),ids=new Set(state.chats.filter(chat=>chat.projectId===project.id).map(chat=>chat.id));
        assertMutable(ids);const result=removeChats(ids);state.projects=state.projects.filter(item=>item.id!==project.id);await changed();await mediaStore.prune([...ids],true);return {ok:true,projectId:project.id,...result};
      }
      case 'provider.save': {
        const id = params.id || randomUUID(); const existing = state.providers.find(item => item.id === id);
        if (id.startsWith('chatgpt:') || existing?.authKind === 'chatgpt') throw new Error('Manage this connection in ChatGPT accounts');
        if (providerEdits.has(id) || providerTests.has(id) || state.runs.some(run => run.providerId === id && live.has(run.id))) throw new Error('Provider is in use; stop its active runs or wait for its connection check before editing');
        const configuration = { id, name: params.name, kind: params.kind, baseUrl: validateBaseUrl(params.baseUrl), model: params.model, hasKey: existing?.hasKey || false,authorizationVersion:(existing?.authorizationVersion||0)+1 };
        if (existing?.hasKey && new URL(existing.baseUrl).origin !== new URL(configuration.baseUrl).origin && params.apiKey === undefined) throw new Error('Provider origin changed; explicitly replace or remove the saved API key');
        const effort = params.reasoningEffort ?? existing?.reasoningEffort;
        if (params.kind === 'openai-responses' && effort) configuration.reasoningEffort = effort;
        validateCredentialTransport(configuration.baseUrl, params.apiKey !== undefined ? !!params.apiKey : configuration.hasKey);
        providerEdits.add(id);
        try {
          if (params.apiKey !== undefined) { if (!host.setSecret) throw new Error('Credential storage is unavailable'); await host.setSecret(id, params.apiKey); configuration.hasKey = !!params.apiKey; }
          if (existing) { delete existing.reasoningEffort; Object.assign(existing, configuration); } else state.providers.push(configuration);
          await changed(); return structuredClone(configuration);
        } finally { providerEdits.delete(id); }
      }
      case 'provider.test': {
        if (providerEdits.has(params.id)) throw new Error('Provider configuration is being saved');
        providerTests.set(params.id, (providerTests.get(params.id) || 0) + 1);
        try { return await testProvider(structuredClone(find('providers', params.id)), host); }
        finally { const remaining = providerTests.get(params.id) - 1; if (remaining) providerTests.set(params.id, remaining); else providerTests.delete(params.id); }
      }
      case 'approval.resolve': {
        const approval = state.approvals.find(item => item.id === params.id), waiter = pending.get(params.id);
        if (!approval || !waiter) throw new Error('Approval is no longer pending');
        if (params.allow && approval.kind === 'project' && approval.targetProjectId && (!state.projects.some(project => project.id === approval.targetProjectId && !project.archived) || find('chats', approval.chatId).projectId !== approval.sourceProjectId)) {
          waiter.reject(new Error('Project scope changed while waiting for approval; retry the request.'));
          throw new Error('Project scope changed while waiting for approval; retry the request.');
        }
        if (params.allow && params.remember && approval.rememberable === false) throw new Error('This approval applies only to this operation');
        if (params.allow && params.remember) {
          const chat = find('chats', approval.chatId), run = find('runs', approval.runId);
          if (approval.kind === 'project') {
            if (chat.projectId !== approval.sourceProjectId || find('projects', approval.targetProjectId).archived) throw new Error('Project scope changed while waiting for approval');
            if (!chat.projectGrants.includes(approval.targetProjectId)) chat.projectGrants.push(approval.targetProjectId);
            if (!run.projectGrants.includes(approval.targetProjectId)) run.projectGrants.push(approval.targetProjectId);
          } else {
            if (!chat.grants.includes(approval.permission)) chat.grants.push(approval.permission);
            if (!run.grants.includes(approval.permission)) run.grants.push(approval.permission);
          }
          await changed();
        }
        if (params.allow) waiter.resolve(true); else waiter.reject(new Error('Permission denied by user'));
        return { ok: true };
      }
      case 'tool.run': {
        const tool = registry.get(params.name); if (!tool) throw new Error(`Unknown tool: ${params.name}`); validate(params.args, tool.parameters);
        const { runId } = await start(find('chats', params.chatId), undefined, undefined, params);
        const result = await live.get(runId).done; if (result.error) throw new Error(result.error); return result.result;
      }
      case 'settings.update': {
        if (params.defaultGrants && new Set(params.defaultGrants).size !== params.defaultGrants.length) throw new Error('Duplicate default permissions');
        const { defaultGrants, ...settings } = structuredClone(params);
        if (defaultGrants) state.defaultChatGrants = defaultGrants;
        Object.assign(state.settings, settings);
        if (Object.hasOwn(params, 'runTimeoutMs')) for (const [id, execution] of live) scheduleRunTimer(find('runs', id), execution);
        await changed(); return settingsSnapshot();
      }
      case 'extensions.reload': if (!host.reloadExtensions) throw new Error('Extension loading unavailable'); return host.reloadExtensions();
      case 'voice.start': case 'voice.stop': case 'voice.speak':
        if (params.chatId) find('chats', params.chatId);
        if (!host.voice) throw new Error('Voice unavailable'); return host.voice(method.slice(6), params);
      case 'app.openPath': if (!host.openPath) throw new Error('Opening paths unavailable'); return host.openPath(params.path);
      case 'app.bugReportDraft': return bugReportDraft({ ...params, errors: [...state.runs.filter(run => run.status === 'failed' && run.error).slice(-5).map(run => run.error), ...recentErrors, ...(params.errors || [])] });
      case 'app.reportIssue': if (!host.openIssue) throw new Error('Opening issue reports is unavailable'); return host.openIssue(reportIssueUrl(params));
      case 'app.openLink': if (!host.openWebLink) throw new Error('Opening browser links is unavailable'); return host.openWebLink(externalWebUrl(params.url));
      case 'app.restart': if (!host.restart) throw new Error('Restart unavailable'); return host.restart();
    }
  }
  const runtime = {
    remoteRequest: remoteWorkspace.dispatch, request, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, emit,
    readMedia, mediaNotes,
    publishMedia(args) { if (closed || !state.chats.some(chat => chat.id === args.chatId)) throw new Error('Chat no longer exists'); return mediaStore.publish(args); },
    registerTools(tools) { install(tools); },
    startRoutines:()=>routines.ready(),
    async withExternalProvider({ providerId, model }, callback) {
      if (closed) throw new Error('Runtime is closed');
      validate({ providerId, ...(model !== undefined ? { model } : {}) }, object({ providerId: idSchema, model: { type: 'string', minLength: 1, maxLength: 300 } }, ['providerId']));
      const provider = structuredClone(find('providers', providerId));
      if (provider.authKind === 'chatgpt') throw new Error('Account connections are not available to external sessions');
      if (providerEdits.has(providerId)) throw new Error('Provider configuration is being saved');
      provider.model = model || provider.model;
      if (!provider.model) throw new Error('Select a model for this external session');
      host.assertProviderAvailable?.(providerId, provider.model, {});
      providerTests.set(providerId, (providerTests.get(providerId) || 0) + 1);
      try { return await callback(provider); }
      finally { const remaining = providerTests.get(providerId) - 1; if (remaining) providerTests.set(providerId, remaining); else providerTests.delete(providerId); }
    },
    async createExternalSession({ projectId, providerId, model, title = 'External tools', toolNames, allowAutomatic = false }) {
      if (closed) throw new Error('Runtime is closed');
      validate({ projectId, providerId, toolNames, allowAutomatic }, object({ projectId: idSchema, providerId: idSchema, toolNames: { type: 'array', maxItems: 200, items: idSchema }, allowAutomatic: { const: false } }));
      validate(title, { type: 'string', minLength: 1, maxLength: 200 });
      const provider = find('providers', providerId);
      if (provider.authKind === 'chatgpt') throw new Error('Account connections are not available to external sessions');
      const selectedModel = model || provider.model;
      validate(selectedModel, { type: 'string', minLength: 1, maxLength: 300 });
      const externalTools = new Map();
      for (const name of toolNames) {
        if (/^(?:agent_|chat_|project_|harness_|settings_|upgrade_|extension_|hf_|local_model|voice_)/.test(name)) throw new Error('Administrative tools are not available to external sessions');
        const tool = registry.get(name); if (!tool) throw new Error(`Unknown tool: ${name}`);
        externalTools.set(name, tool.execute);
      }
      const id = randomUUID(), chat = await createChat(projectId, title, undefined, id);
      chat.providerId = providerId; chat.model = selectedModel; await changed();
      let sessionClosed = false;
      return {
        id,
        tools() { if (sessionClosed || closed) return []; return [...externalTools].flatMap(([name, execute]) => registry.get(name)?.execute === execute ? [toolMetadata(registry.get(name))] : []); },
        async callTool({ name, args, signal }) {
          if (sessionClosed || closed) throw new Error('External session is closed');
          signal?.throwIfAborted();
          if (find('chats', chat.id).projectId !== projectId) throw new Error('External session project changed; create a new session');
          const tool = registry.get(name);
          if (!tool || externalTools.get(name) !== tool.execute) throw new Error('Tool is not available to this external session');
          validate(args, tool.parameters);
          const { runId } = await start(chat, undefined, undefined, { name, args }, undefined, false, { externalSessionId: id, externalTools });
          const execution = live.get(runId);
          const cancel = () => { stopRun(runId, 'External request canceled').catch(error => emit({ type: 'error', message: error.message })); };
          signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
          try { const result = await execution.done; if (result.error) throw new Error(result.error); return result.result; }
          finally { signal?.removeEventListener('abort', cancel); }
        },
        async close() {
          if (sessionClosed) return; sessionClosed = true;
          if (closed) return;
          await stopChats(new Set([chat.id]), true);
          const current = state.chats.find(item => item.id === chat.id); if (current) { current.archived = true; await changed(); }
        },
      };
    },
    async setAccountProviders(providers) {
      if (closed) throw new Error('Runtime is closed');
      const nullableCount = { anyOf: [{type:'integer',minimum:1}, {type:'null'}] };
      const modelSchema = object({id:idSchema,name:{type:'string',maxLength:300},contextTokens:nullableCount,reasoningEfforts:{type:'array',maxItems:20,items:{type:'string',maxLength:32}},defaultReasoningEffort:reasoningEffortSchema}, ['id','name','contextTokens','reasoningEfforts']);
      const accountProviderSchema = object({id:idSchema,name:{type:'string',maxLength:300},kind:{const:'openai-responses'},authKind:{const:'chatgpt'},accountId:idSchema,baseUrl:{const:'https://api.openai.com/v1'},model:{type:'string',maxLength:300},hasKey:{type:'boolean'},connected:{type:'boolean'},models:{type:'array',maxItems:2000,items:modelSchema}});
      validate(providers,{type:'array',maxItems:100,items:accountProviderSchema});
      if(new Set(providers.map(provider=>provider.id)).size!==providers.length || providers.some(provider=>provider.id!==`chatgpt:${provider.accountId}`))throw new Error('Invalid ChatGPT account provider IDs');
      const incoming = structuredClone(providers), ids = new Set(incoming.map(provider=>provider.id));
      for(const provider of state.providers)if(provider.authKind==='chatgpt'&&!ids.has(provider.id)){provider.connected=false;provider.hasKey=false;}
      for(const provider of incoming){const existing=state.providers.find(item=>item.id===provider.id);if(existing)Object.assign(existing,provider);else state.providers.push(provider);}
      await changed(); return incoming;
    },
    async setExtensions(metadata) { state.extensions = structuredClone(metadata); await changed(); },
    async replaceExtensionTools(tools, metadata) { const copy = structuredClone(metadata); install(tools, true); state.extensions = copy; await changed(); },
    async close() { if (closed) return; closed = true; const closingRoutines = routines.close(); remoteWorkspace.close(); const done = [...settling]; await stopRuns(new Set(live.keys())); await Promise.all([...done, closingRoutines]); await store.flush(); listeners.clear(); },
  };
  const builtin = (name, description, parameters, execute) => ({ name, description, parameters, permission: 'read', execute });
  runtime.registerTools([
    { name: 'system_time', description: 'Read the current date and time from this PC, including UTC, local time, timezone and UTC offset. No shell or permission prompt is needed.', parameters: object({}), permission: 'read', execute: () => {
      const time = new Date();
      return { utc: time.toISOString(), local: time.toString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, utcOffsetMinutes: -time.getTimezoneOffset(), unixMilliseconds: time.getTime() };
    } },
    builtin('agent_create', 'Start a scoped child agent in a new chat; all agents share the same tools and inherited authority.', object({ task: string, title: string }, ['task']), async (args, ctx) => {
      checkSpawn(ctx.runId); const chat = await createChat(ctx.chat.projectId, args.title || args.task.slice(0, 80), ctx.chat.id); ctx.signal.throwIfAborted(); return { chatId: chat.id, ...await start(chat, args.task, ctx.runId) };
    }),
    builtin('agent_list', 'List runs in this project and explicitly authorized projects. A target projectId requests its separate user approval.', object({ projectId: idSchema }, []), async (args, ctx) => {
      if (args.projectId) await ctx.authorizeProject(args.projectId);
      const allowed = args.projectId ? new Set([args.projectId]) : projectIds(find('runs', ctx.runId));
      return state.runs.filter(run => allowed.has(find('chats', run.chatId).projectId)).map(({ id, chatId, parentRunId, status, error }) => ({ id, chatId, ...(parentRunId && allowed.has(find('chats', find('runs', parentRunId).chatId).projectId) ? { parentRunId } : {}), status, ...(error ? { error } : {}) }));
    }),
    builtin('agent_read', 'Inspect an authorized agent status, final reply and result indexes. Another project requires separate user approval. Nested inspections stay references.', object({ runId: idSchema, toolEventIds: { type: 'array', items: idSchema } }, ['runId']), async (args, ctx) => { const run = find('runs', args.runId), chat = find('chats', run.chatId), projectId = chat.projectId; await ctx.authorizeProject(projectId); if (find('chats', chat.id).projectId !== projectId) throw new Error('Target chat moved while waiting for approval; retry the request.'); return scopedInspection(agentInspection(run, chat, args.toolEventIds, ctx.chat.id), find('runs', ctx.runId)); }),
    builtin('agent_send', 'Deliver a message to another chat. Busy chats receive the message; idle chats start a child run with no extra authority.', object({ chatId: idSchema, text: string }), async (args, ctx) => {
      if (args.chatId === ctx.chat.id) throw new Error('Cannot send to your own active chat');
      const chat = find('chats', args.chatId), projectId=chat.projectId;
      if (chat.archived) throw new Error('Chat is archived');
      await ctx.authorizeProject(chat.projectId, `Send instructions to an agent in project ${find('projects', chat.projectId).name}: ${find('projects', chat.projectId).path}`);
      ctx.signal.throwIfAborted();
      if(find('chats',chat.id).projectId!==projectId)throw new Error('Target chat moved while waiting for approval; retry the request.');
      const running = state.runs.find(run => run.chatId === chat.id && active(run));
      if (running) {
        const sender = find('runs', ctx.runId), authority = new Set([...sender.grants, ...live.get(ctx.runId).approved]);
        if ([...running.grants, ...live.get(running.id).approved].some(permission => !authority.has(permission))) throw new Error('Cannot message an active agent with greater authority');
        if ([...projectIds(running)].some(id => !projectIds(sender).has(id))) throw new Error('Cannot message an active agent with greater project authority');
        if (chat.inbox?.length >= 32) throw new Error('Target agent inbox is full');
        (chat.inbox ||= []).push({ id: randomUUID(), text: args.text, source: 'agent', fromChatId: ctx.chat.id, runId: running.id, createdAt: now() });
        await changed(); return { delivered: false, queued: true, runId: running.id, active: true };
      }
      return { delivered: true, ...await start(chat, args.text, ctx.runId) };
    }),
    builtin('agent_wait', 'Wait for a descendant run, with a bounded timeout. Ancestor and unrelated waits are rejected to prevent cycles.', object({ runId: idSchema, timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 } }, ['runId']), async (args, ctx) => {
      if (args.runId === ctx.runId || !descendants(ctx.runId).has(args.runId)) throw new Error('May wait only for descendant agents');
      const execution = live.get(args.runId); let timer;
      try { if (execution) await abortable(Promise.race([execution.done, new Promise(resolveWait => { timer = setTimeout(resolveWait, args.timeoutMs || 30000); })]), ctx.signal); }
      finally { clearTimeout(timer); }
      const run = find('runs', args.runId), chat = find('chats', run.chatId), projectId = chat.projectId; await ctx.authorizeProject(projectId); if (find('chats', chat.id).projectId !== projectId) throw new Error('Target chat moved while waiting for approval; retry the request.'); return scopedInspection(agentInspection(run, chat, undefined, ctx.chat.id), find('runs', ctx.runId));
    }),
    builtin('agent_stop', 'Stop an authorized descendant agent and its descendants.', object({ runId: idSchema }), async (args, ctx) => { if (args.runId === ctx.runId || !descendants(ctx.runId).has(args.runId)) throw new Error('May stop only descendant agents'); const target = find('chats', find('runs', args.runId).chatId), projectId = target.projectId; await ctx.authorizeProject(projectId); if (find('chats', target.id).projectId !== projectId) throw new Error('Target chat moved while waiting for approval; retry the request.'); return stopRun(args.runId); }),
    builtin('chat_list', 'List chat metadata only in this project and explicitly authorized projects. A target projectId requests its separate user approval.', object({ projectId: idSchema }, []), async (args, ctx) => {
      if (args.projectId) await ctx.authorizeProject(args.projectId);
      const allowed = args.projectId ? new Set([args.projectId]) : projectIds(find('runs', ctx.runId));
      return state.chats.filter(chat => allowed.has(chat.projectId)).map(({ id, projectId, title, providerId, model, archived, parentChatId, createdAt, updatedAt }) => ({ id, projectId, title, providerId, model, archived, ...(parentChatId && allowed.has(find('chats', parentChatId).projectId) ? { parentChatId } : {}), createdAt, updatedAt }));
    }),
    builtin('chat_read', 'Inspect an authorized chat metadata, final reply and message index. Another project requires separate user approval. Selected text remains exact; nested inspections stay references.', object({ chatId: idSchema, messageIds: { type: 'array', items: idSchema } }, ['chatId']), async (args, ctx) => { const chat = find('chats', args.chatId), projectId = chat.projectId; await ctx.authorizeProject(projectId); if (find('chats', chat.id).projectId !== projectId) throw new Error('Target chat moved while waiting for approval; retry the request.'); return scopedInspection(chatInspection(chat, args.messageIds, ctx.chat.id), find('runs', ctx.runId)); }),
    builtin('chat_create', 'Create a chat in an authorized project. Cross-project access requires explicit user approval and does not inherit file/shell grants.', object({ projectId: idSchema, title: string }, ['projectId']), async (args, ctx) => { await ctx.authorizeProject(args.projectId); return structuredClone(await createChat(args.projectId, args.title, ctx.chat.id)); }),
    builtin('chat_rename', 'Rename an authorized chat; another project requires separate user approval.', object({ chatId: idSchema, title: string }), async (args, ctx) => { const chat = find('chats', args.chatId), projectId = chat.projectId; await ctx.authorizeProject(projectId); if (find('chats', chat.id).projectId !== projectId) throw new Error('Target chat moved while waiting for approval; retry the request.'); return request('chat.update', { id: args.chatId, title: args.title }); }),
    builtin('project_list', 'List this project and projects explicitly authorized by the user.', object({}), (_args, ctx) => { const allowed = projectIds(find('runs', ctx.runId)); return structuredClone(state.projects.filter(project => allowed.has(project.id))); }),
    builtin('project_request_access', 'Request separate user approval for one known target project ID or exact project name. Does not discover hidden projects or accept authority from conversation text.', object({ projectId: idSchema, name: string }, []), async (args, ctx) => {
      if (Number(args.projectId !== undefined) + Number(args.name !== undefined) !== 1) throw new Error('Supply exactly one projectId or exact project name');
      const matches = args.projectId ? [find('projects', args.projectId)] : state.projects.filter(project => project.name === args.name && !project.archived);
      if (matches.length !== 1) throw new Error('No unique project matches that exact name; select its ID in the project interface');
      await ctx.authorizeProject(matches[0].id); return structuredClone(matches[0]);
    }),
    builtin('project_create', 'Create one project at an existing absolute path after separate explicit user approval for that workspace. General file grants do not authorize new projects.', object({ name: string, path: string }), async (args, ctx) => {
      if (!isAbsolute(args.path)) throw new Error('Project path must be absolute');
      await approveProject(find('runs', ctx.runId), { name: args.name, path: resolve(args.path) }, `Create project ${args.name} at ${resolve(args.path)}`);
      return request('project.create', args);
    }),
    builtin('harness_inspect', 'Inspect harness source, providers, settings and tool names/permissions. Full tool schemas are already supplied to the model. Never returns credentials.', object({}), () => ({ sourceDir, version: 1, settings: settingsSnapshot(), providers: structuredClone(state.providers), tools: [...registry.values()].map(({ name, permission }) => ({ name, permission })), extensions: structuredClone(state.extensions) })),
    builtin('settings_update', 'Adjust the theme or bounded execution settings. Does not grant permissions or change defaults for future chats.', agentSettingsSchema, args => request('settings.update', args)),
    builtin('chat_configure', 'Configure this chat model/provider, supported context capacity and thinking, or voice preferences for future runs. Context settings are provider parameters, never history trimming. Cannot grant permissions or save credentials.', object({ providerId: idSchema, model: { type: 'string', maxLength: 300 },contextTokens:contextTokensSchema,thinking:thinkingSchema, voice: schemas['chat.update'].properties.voice }, []), async (args, ctx) => {
      if (args.providerId) {
        const provider = find('providers', args.providerId), hostname = new URL(provider.baseUrl).hostname;
        if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) await ctx.approve('network', `Configure future runs of this chat to send context to provider ${provider.name} at ${provider.baseUrl}`);
      }
      ctx.signal.throwIfAborted();
      const chat = await request('chat.update', { id: ctx.chat.id, ...args });
      return { id: chat.id, providerId: chat.providerId, model: chat.model, voice: chat.voice,contextTokens:chat.contextTokens,thinking:chat.thinking };
    }),
    builtin('voice_status', 'Read native voice availability and listening state.', object({}), (_args, ctx) => {
      if (!host.voice) throw new Error('Voice unavailable'); return host.voice('status', {}, ctx.signal);
    }),
    ...[
      ['start', object({ mode: { enum: ['dictation', 'assistant'] } })],
      ['stop', object({})],
      ['speak', object({ text: string })],
    ].map(([action, parameters]) => ({ name: `voice_${action}`, description: `Use native voice ${action} for this chat; requires computer permission.`, permission: 'computer', parameters, execute: (args, ctx) => {
      if (!host.voice) throw new Error('Voice unavailable'); return host.voice(action, { ...args, ...(action === 'speak' ? {} : { chatId: ctx.chat.id }) }, ctx.signal);
    } })),
  ]);
  return runtime;
}
