import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../core/runtime.mjs';
import { fileTools } from '../tools/files.mjs';
import { imageTools } from '../tools/images.mjs';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
const tool = (name, execute, permission = 'read') => ({ name, description: 'Deterministic test fixture', permission, parameters: empty, execute });
async function fixture(t, provider = async function* () { yield { type: 'delta', text: 'Fixture complete.' }; }, host = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'faber-roadmap-'));
  const options = { dataDir: join(root, 'data'), sourceDir: join(root, 'source'), provider, host };
  const runtimes = [];
  const open = async () => { const runtime = await createRuntime(options); runtimes.push(runtime); return runtime; };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await open(), path = join(root, 'workspace'); await fs.mkdir(path);
  const project = await runtime.request('project.create', { name: 'Current', path });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  return { runtime, chat, project, root, options, open };
}
async function until(runtime, predicate) {
  for (let index = 0; index < 500; index++) {
    const state = await runtime.request('state.get'); if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture state timeout');
}
const finish = (runtime, id) => until(runtime, state => state.runs.some(run => run.id === id && !['running', 'waiting_approval'].includes(run.status)));

test('user followups validate before mutation, persist immediately and join the same run after a complete tool group', async t => {
  const hold = deferred(), entered = deferred(), seen = []; let effects = 0;
  const { runtime, chat, options } = await fixture(t, async function* ({ messages }) {
    seen.push(structuredClone(messages));
    if (messages.at(-1).content === 'Initial task') {
      yield { type: 'tool', id: 'hold', name: 'fixture_hold', args: {} };
      yield { type: 'tool', id: 'effect', name: 'fixture_effect', args: {} };
    } else yield { type: 'delta', text: 'Followup applied.' };
  });
  runtime.registerTools([tool('fixture_hold', async () => { entered.resolve(); await hold.promise; return { held: true }; }), tool('fixture_effect', () => ({ effects: ++effects }))]);
  const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Initial task' }); await entered.promise;
  const before = await runtime.request('state.get');
  await assert.rejects(runtime.request('chat.send', { chatId: chat.id, text: 'Invalid', images: ['data:image/png;base64,AAAA'] }), /signature/);
  assert.deepEqual(await runtime.request('state.get'), before);
  const queued = await runtime.request('chat.send', { chatId: chat.id, text: 'Correct this detail', images: [png] });
  assert.equal(queued.runId, runId); assert.equal(queued.queued, true);
  const disk = JSON.parse(await fs.readFile(join(options.dataDir, 'state.json'), 'utf8'));
  const pending = disk.chats[0].inbox[0];
  assert.equal(pending.id, queued.messageId); assert.equal(pending.source, 'user'); assert.deepEqual(pending.images, [png]);
  assert.ok(!disk.chats[0].messages.some(message => message.id === pending.id));
  hold.resolve(); const final = await finish(runtime, runId);
  assert.equal(final.runs.length, 1); assert.equal(final.runs[0].status, 'completed'); assert.equal(effects, 1);
  const messages = seen.at(-1), followup = messages.at(-1);
  assert.equal(followup.id, pending.id); assert.equal(followup.createdAt, pending.createdAt); assert.equal(followup.steering, true); assert.deepEqual(followup.images, [png]);
  assert.deepEqual(messages.slice(-4).map(message => message.role), ['assistant', 'tool', 'tool', 'user']);
  assert.equal(final.chats[0].messages.filter(message => message.id === pending.id).length, 1); assert.deepEqual(final.chats[0].inbox, []);
});

test('Stop and restart preserve pending user followups without replay; next explicit send applies them once in order', async t => {
  const started = deferred(); let calls = 0;
  const { runtime, chat, open } = await fixture(t, async function* ({ messages }) {
    calls++;
    if (messages.at(-1).content === 'Wait') { started.resolve(); yield { type: 'delta', text: 'Working' }; await new Promise(() => {}); }
    else yield { type: 'delta', text: 'Finished only after explicit send.' };
  });
  await runtime.request('chat.send', { chatId: chat.id, text: 'Wait' }); await started.promise;
  const queued = await runtime.request('chat.send', { chatId: chat.id, text: 'Pending correction', images: [png] });
  await runtime.request('chat.forceStop', { chatId: chat.id });
  assert.equal((await runtime.request('state.get')).chats[0].inbox[0].id, queued.messageId);
  await runtime.close(); const restarted = await open();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  const prior = await restarted.request('state.get'); assert.equal(prior.chats[0].inbox[0].id, queued.messageId); assert.equal(prior.runs.length, 1);
  const sent = await restarted.request('chat.send', { chatId: chat.id, text: 'Now continue' });
  const final = await finish(restarted, sent.runId);
  const users = final.chats[0].messages.filter(message => message.role === 'user');
  assert.deepEqual(users.map(message => message.content), ['Wait', 'Pending correction', 'Now continue']);
  assert.equal(users[1].id, queued.messageId); assert.deepEqual(users[1].images, [png]); assert.equal(calls, 2);
});

test('project lists default to authorized metadata and broad file grants never authorize another project', async t => {
  const { runtime, chat, project, root } = await fixture(t);
  const other = await runtime.request('project.create', { name: 'Private', path: join(root, 'private') });
  const target = await runtime.request('chat.create', { projectId: other.id, title: 'Private title' });
  await runtime.request('chat.update', { id: chat.id, grants: ['files', 'shell'] });
  const invoke = (name, args = {}) => runtime.request('tool.run', { chatId: chat.id, name, args });
  assert.deepEqual((await invoke('project_list')).map(item => item.id), [project.id]);
  const chats = await invoke('chat_list'); assert.deepEqual(chats.map(item => item.id), [chat.id]);
  assert.ok(chats.every(item => !Object.hasOwn(item, 'inbox') && !Object.hasOwn(item, 'contextCheckpoint')));
  const read = invoke('chat_read', { chatId: target.id }).then(value => ({ value }), error => ({ error }));
  const waiting = await until(runtime, state => state.approvals.length === 1), approval = waiting.approvals[0];
  assert.equal(approval.kind, 'project'); assert.equal(approval.permission, 'project'); assert.equal(approval.targetProjectId, other.id); assert.equal(approval.sourceProjectId, project.id);
  await runtime.request('approval.resolve', { id: approval.id, allow: false }); assert.match((await read).error.message, /denied/);
  const access = invoke('project_request_access', { name: 'Private' });
  const second = await until(runtime, state => state.approvals.length === 1);
  await runtime.request('approval.resolve', { id: second.approvals[0].id, allow: true, remember: true }); assert.equal((await access).id, other.id);
  assert.deepEqual((await invoke('project_list')).map(item => item.id), [project.id, other.id]);
  assert.ok((await invoke('chat_list')).some(item => item.id === target.id));
  const added = await runtime.request('project.create', { name: 'New private', path: join(root, 'new') });
  assert.ok(!(await invoke('project_list')).some(item => item.id === added.id));
  await runtime.request('chat.update', { id: chat.id, projectGrants: [] });
  assert.deepEqual((await invoke('project_list')).map(item => item.id), [project.id]);
  await assert.rejects(invoke('chat_configure', { projectGrants: [other.id] }), /unknown property/);
});

test('project consent covers exact project IDs, including roots with the same path, and cannot be granted by a model', async t => {
  const { runtime, chat, project } = await fixture(t);
  const other = await runtime.request('project.create', { name: 'Distinct scope', path: project.path });
  await runtime.request('chat.update', { id: chat.id, grants: ['files', 'shell'] });
  const creating = runtime.request('tool.run', { chatId: chat.id, name: 'chat_create', args: { projectId: other.id, title: 'Restricted child' } });
  const waiting = await until(runtime, state => state.approvals.length === 1);
  assert.equal(waiting.chats.length, 1); await runtime.request('approval.resolve', { id: waiting.approvals[0].id, allow: true });
  const child = await creating; assert.deepEqual(child.grants, []); assert.deepEqual(child.projectGrants, []);
  const denied = runtime.request('tool.run', { chatId: chat.id, name: 'project_create', args: { name: 'Another root', path: project.path } }).then(value => value, error => error);
  const creatingProject = await until(runtime, state => state.approvals.length === 1);
  assert.equal(creatingProject.approvals[0].rememberable, false); assert.equal(creatingProject.approvals[0].permission, 'project');
  await runtime.request('approval.resolve', { id: creatingProject.approvals[0].id, allow: false }); assert.match((await denied).message, /denied/);
});

test('nested project paths require separate consent and revocation cancels held cross-target effects and later dispatch', async t => {
  const entered = deferred(), release = deferred(); let effects = 0, dispatches = 0;
  const { runtime, chat, project } = await fixture(t, async function* ({ messages }) {
    if (messages.at(-1).role === 'user') { yield { type: 'tool', id: 'write', name: 'fixture_scoped_write', args: {} }; yield { type: 'tool', id: 'after', name: 'fixture_after', args: {} }; }
    else yield { type: 'delta', text: 'Done.' };
  });
  const nestedPath = join(project.path, 'nested'); await fs.mkdir(nestedPath);
  const nested = await runtime.request('project.create', { name: 'Nested private', path: nestedPath });
  runtime.registerTools([tool('fixture_scoped_write', async (_args, ctx) => {
    await ctx.authorizePath(join(nestedPath, 'file.txt')); entered.resolve(); await release.promise; ctx.signal.throwIfAborted(); effects++; return { effects };
  }), tool('fixture_after', () => ++dispatches)]);
  await runtime.request('chat.update', { id: chat.id, grants: ['files'] });
  const sent = await runtime.request('chat.send', { chatId: chat.id, text: 'Write once' });
  const waiting = await until(runtime, state => state.approvals.length === 1);
  assert.equal(waiting.approvals[0].targetProjectId, nested.id);
  await runtime.request('approval.resolve', { id: waiting.approvals[0].id, allow: true, remember: true }); await entered.promise;
  await runtime.request('chat.update', { id: chat.id, projectGrants: [] }); release.resolve();
  const final = await finish(runtime, sent.runId); assert.equal(final.runs.find(run => run.id === sent.runId).status, 'canceled');
  assert.equal(effects, 0); assert.equal(dispatches, 0); assert.deepEqual(final.chats[0].projectGrants, []);
});

test('revoking parent project authority stops foreign descendants and removes their inherited scope', async t => {
  const childEntered = deferred(); let target;
  const { runtime, chat, root } = await fixture(t, async function* ({ messages }) {
    if (messages.at(-1).content === 'Parent') yield { type: 'tool', id: 'send', name: 'agent_send', args: { chatId: target.id, text: 'Child' } };
    else if (messages.at(-1).content === 'Child') { childEntered.resolve(); await new Promise(() => {}); }
    else await new Promise(() => {});
  });
  const other = await runtime.request('project.create', { name: 'Target', path: join(root, 'target') });
  target = await runtime.request('chat.create', { projectId: other.id });
  await runtime.request('chat.update', { id: chat.id, projectGrants: [other.id], grants: ['shell'] });
  const sent = await runtime.request('chat.send', { chatId: chat.id, text: 'Parent' }); await childEntered.promise;
  let state = await runtime.request('state.get'), child = state.runs.find(run => run.parentRunId === sent.runId);
  assert.deepEqual(child.grants, []);
  await runtime.request('chat.update', { id: chat.id, projectGrants: [] });
  state = await finish(runtime, child.id); assert.equal(state.runs.find(run => run.id === child.id).status, 'canceled');
  assert.ok(state.runs.filter(run => [sent.runId, child.id].includes(run.id)).every(run => !run.projectGrants.includes(other.id)));
});

test('ancestor workspaces cannot bypass project isolation through raw profile state, secrets or inactive profile files', async t => {
  const host = { privatePaths: [] };
  const { runtime, root } = await fixture(t, undefined, host);
  const otherProfile = join(root, 'inactive-profile'); await fs.mkdir(otherProfile); host.privatePaths.push(otherProfile);
  await fs.writeFile(join(otherProfile, 'secrets.json'), 'PRIVATE_CREDENTIAL_FIXTURE');
  await fs.writeFile(join(otherProfile, 'capture.png'), Buffer.from(png.split(',')[1], 'base64'));
  const ancestor = await runtime.request('project.create', { name: 'Ancestor', path: root });
  const chat = await runtime.request('chat.create', { projectId: ancestor.id });
  await runtime.request('chat.update', { id: chat.id, grants: ['files'] }); runtime.registerTools([...fileTools(), ...imageTools()]);
  for (const [name, args] of [
    ['files_read', { path: 'data/state.json' }], ['files_list', { path: 'inactive-profile' }],
    ['files_read', { path: 'inactive-profile/secrets.json' }], ['images_show', { path: 'inactive-profile/capture.png' }],
    ['files_write', { path: 'inactive-profile/secrets.json', text: 'overwrite' }],
  ]) await assert.rejects(runtime.request('tool.run', { chatId: chat.id, name, args }), /Private Faber profile data/);
  assert.equal(await fs.readFile(join(otherProfile, 'secrets.json'), 'utf8'), 'PRIVATE_CREDENTIAL_FIXTURE');
  const session = await runtime.createExternalSession({ projectId: ancestor.id, providerId: 'local-ollama', toolNames: ['files_read'], allowAutomatic: false });
  await assert.rejects(session.callTool({ name: 'files_read', args: { path: 'data/state.json' } }), /Private Faber profile data/); await session.close();
});

test('a deleted target rejects a remembered pending approval instead of leaving an orphan waiter', async t => {
  const { runtime, chat, root } = await fixture(t);
  const other = await runtime.request('project.create', { name: 'Pending target', path: join(root, 'pending') });
  const target = await runtime.request('chat.create', { projectId: other.id });
  const reading = runtime.request('tool.run', { chatId: chat.id, name: 'chat_read', args: { chatId: target.id } }).then(value => value, error => error);
  const waiting = await until(runtime, state => state.approvals.length === 1);
  await runtime.request('project.delete', { projectId: other.id });
  await assert.rejects(runtime.request('approval.resolve', { id: waiting.approvals[0].id, allow: true, remember: true }), /scope changed/);
  assert.match((await reading).message, /scope changed/);
  assert.equal((await runtime.request('state.get')).approvals.length, 0);
});

test('a newly registered deeper project is not silently covered by an earlier path approval', async t => {
  const { runtime, chat, project } = await fixture(t); let effects = 0;
  const nestedPath = join(project.path, 'nested'), deeperPath = join(nestedPath, 'deep'); await fs.mkdir(deeperPath, { recursive: true });
  const nested = await runtime.request('project.create', { name: 'Nested', path: nestedPath });
  runtime.registerTools([tool('fixture_path_effect', async (_args, ctx) => { await ctx.authorizePath(join(deeperPath, 'file.txt')); ctx.signal.throwIfAborted(); return ++effects; })]);
  const writing = runtime.request('tool.run', { chatId: chat.id, name: 'fixture_path_effect', args: {} }).then(value => value, error => error);
  const waiting = await until(runtime, state => state.approvals.length === 1); assert.equal(waiting.approvals[0].targetProjectId, nested.id);
  const deeper = await runtime.request('project.create', { name: 'New private target', path: deeperPath });
  await runtime.request('approval.resolve', { id: waiting.approvals[0].id, allow: true });
  assert.match((await writing).message, /Registered project scope changed/); assert.equal(effects, 0);
  const again = runtime.request('tool.run', { chatId: chat.id, name: 'fixture_path_effect', args: {} }).then(value => value, error => error);
  const next = await until(runtime, state => state.approvals.length === 1); assert.equal(next.approvals[0].targetProjectId, deeper.id);
  await runtime.request('approval.resolve', { id: next.approvals[0].id, allow: false }); assert.match((await again).message, /denied/); assert.equal(effects, 0);
});
