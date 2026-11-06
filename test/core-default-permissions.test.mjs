import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../core/runtime.mjs';
import { openStore } from '../core/store.mjs';
import { validate } from '../core/registry.mjs';

const all = ['files', 'shell', 'computer', 'network', 'upgrade'];
const empty = { type: 'object', properties: {}, additionalProperties: false };
// The released a2.2 settings schema rejects unknown settings but preserves unknown root fields.
const a22SettingsSchema = { type: 'object', additionalProperties: false, properties: {
  theme: { enum: ['dark', 'light', 'system'] }, maxDepth: { type: 'integer', minimum: 0, maximum: 8 }, maxAgents: { type: 'integer', minimum: 1, maximum: 32 },
  runTimeoutMs: { anyOf: [{ const: 0 }, { type: 'integer', minimum: 1000, maximum: 2147483647 }] },
  uiScale: { type: 'number', minimum: 0.75, maximum: 1.5 }, onboardingComplete: { type: 'boolean' },
} };
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'faber-default-permissions-'));
  const options = { dataDir: join(root, 'data'), sourceDir: join(root, 'source'), provider: async function* () { yield { type: 'delta', text: 'Fixture response' }; } };
  const runtimes = [];
  const open = async () => { const runtime = await createRuntime(options); runtimes.push(runtime); return runtime; };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await open(), project = await runtime.request('project.create', { name: 'Fixture', path: options.sourceDir });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  return { runtime, project, chat, options, open };
}

test('user defaults are copied into future root chats and persist without changing existing chats or runs', async t => {
  const { runtime, project, chat, open } = await fixture(t);
  assert.deepEqual((await runtime.request('state.get')).settings.defaultGrants, []);
  const requested = [...all]; await runtime.request('settings.update', { defaultGrants: requested }); requested.length = 0;
  const created = await runtime.request('chat.create', { projectId: project.id });
  assert.deepEqual(created.grants, all); created.grants.length = 0;
  runtime.registerTools([{ name: 'fixture_effect', description: 'Synthetic effect', permission: 'files', parameters: empty, execute: () => ({ ok: true }) }]);
  assert.deepEqual(await runtime.request('tool.run', { chatId: created.id, name: 'fixture_effect', args: {} }), { ok: true });
  const priorRun = (await runtime.request('state.get')).runs.at(-1);
  await runtime.request('settings.update', { defaultGrants: ['network'] });
  const next = await runtime.request('chat.create', { projectId: project.id }); assert.deepEqual(next.grants, ['network']);
  const state = await runtime.request('state.get');
  assert.deepEqual(state.chats.find(item => item.id === chat.id).grants, []);
  assert.deepEqual(state.chats.find(item => item.id === created.id).grants, all);
  assert.deepEqual(state.runs.find(item => item.id === priorRun.id), priorRun);
  await runtime.request('chat.update', { id: created.id, grants: ['computer'] });
  assert.deepEqual((await runtime.request('state.get')).settings.defaultGrants, ['network']);
  await runtime.close(); const reopened = await open();
  assert.deepEqual((await reopened.request('state.get')).settings.defaultGrants, ['network']);
  assert.deepEqual((await reopened.request('chat.create', { projectId: project.id })).grants, ['network']);
});

test('existing profiles acquire no default authority unless explicitly configured', async t => {
  const { runtime, project, chat, options, open } = await fixture(t); await runtime.close();
  const file = join(options.dataDir, 'state.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  delete saved.defaultChatGrants; delete saved.settings.defaultGrants; saved.chats[0].grants = ['shell']; await fs.writeFile(file, JSON.stringify(saved));
  const reopened = await open(), state = await reopened.request('state.get');
  assert.deepEqual(state.settings.defaultGrants, []); assert.deepEqual(state.chats.find(item => item.id === chat.id).grants, ['shell']);
  assert.deepEqual((await reopened.request('chat.create', { projectId: project.id })).grants, []);
});

test('invalid default grants reject before mutation and invalid saved defaults preserve the original file', async t => {
  const { runtime, options } = await fixture(t);
  for (const defaultGrants of [null, 'shell', {}, ['read'], ['admin'], ['shell', 'shell'], [...all, 'files'], [false]]) {
    await assert.rejects(runtime.request('settings.update', { theme: 'light', defaultGrants }));
    const state = await runtime.request('state.get'); assert.deepEqual(state.settings.defaultGrants, []); assert.equal(state.settings.theme, 'dark');
  }
  await runtime.close();
  const file = join(options.dataDir, 'state.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const defaultGrants of [['unknown'], ['files', 'files']]) {
    saved.settings.defaultGrants = defaultGrants; const bytes = JSON.stringify(saved); await fs.writeFile(file, bytes);
    await assert.rejects(createRuntime(options)); assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
  delete saved.settings.defaultGrants;
  for (const defaultGrants of [null, 'shell', ['read'], ['files', 'files']]) {
    saved.defaultChatGrants = defaultGrants; const bytes = JSON.stringify(saved); await fs.writeFile(file, bytes);
    await assert.rejects(createRuntime(options)); assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
});

test('saved defaults survive the strict a2.2 settings/store round trip without changing chat authority', async t => {
  const { runtime, project, chat, options, open } = await fixture(t);
  const settings = await runtime.request('settings.update', { defaultGrants: all }); assert.deepEqual(settings.defaultGrants, all);
  const future = await runtime.request('chat.create', { projectId: project.id });
  assert.deepEqual((await runtime.request('tool.run', { chatId: chat.id, name: 'harness_inspect', args: {} })).settings.defaultGrants, all);
  assert.equal(Object.hasOwn(await runtime.request('state.get'), 'defaultChatGrants'), false);
  await runtime.close();
  const legacy = await openStore(options.dataDir, {});
  validate(legacy.state.settings, a22SettingsSchema); assert.equal(Object.hasOwn(legacy.state.settings, 'defaultGrants'), false); assert.deepEqual(legacy.state.defaultChatGrants, all);
  legacy.state.settings.theme = 'light'; await legacy.save(legacy.state); await legacy.flush();
  const reopened = await open(), state = await reopened.request('state.get');
  assert.equal(state.settings.theme, 'light'); assert.deepEqual(state.settings.defaultGrants, all);
  assert.deepEqual(state.chats.find(item => item.id === chat.id).grants, []); assert.deepEqual(state.chats.find(item => item.id === future.id).grants, all);
  assert.deepEqual((await reopened.request('chat.create', { projectId: project.id })).grants, all);
});

test('in-progress nested defaults migrate only after validation and conflicting copies preserve the file', async t => {
  const { runtime, options, open } = await fixture(t); await runtime.close();
  const file = join(options.dataDir, 'state.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  delete saved.defaultChatGrants; saved.settings.defaultGrants = ['network']; await fs.writeFile(file, JSON.stringify(saved));
  const migrated = await open(); assert.deepEqual((await migrated.request('state.get')).settings.defaultGrants, ['network']); await migrated.close();
  const canonical = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(Object.hasOwn(canonical.settings, 'defaultGrants'), false); assert.deepEqual(canonical.defaultChatGrants, ['network']);
  canonical.settings.defaultGrants = ['shell']; const conflict = JSON.stringify(canonical); await fs.writeFile(file, conflict);
  await assert.rejects(createRuntime(options), /Conflicting default permissions/); assert.equal(await fs.readFile(file, 'utf8'), conflict);
});

test('agents cannot change future-chat authority through settings_update', async t => {
  const { runtime, chat } = await fixture(t);
  const tool = (await runtime.request('state.get')).tools.find(item => item.name === 'settings_update');
  assert.equal(tool.parameters.properties.defaultGrants, undefined); assert.equal(tool.parameters.additionalProperties, false);
  await assert.rejects(runtime.request('tool.run', { chatId: chat.id, name: 'settings_update', args: { defaultGrants: all } }), /unknown property/);
  await runtime.request('tool.run', { chatId: chat.id, name: 'settings_update', args: { theme: 'light' } });
  const state = await runtime.request('state.get'); assert.deepEqual(state.settings.defaultGrants, []); assert.equal(state.settings.theme, 'light');
});

test('changing future defaults leaves a running existing chat without additional authority', async t => {
  const { runtime, chat } = await fixture(t); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), called = new Promise(resolve => { entered = resolve; });
  runtime.registerTools([{ name: 'fixture_hold', description: 'Synthetic running tool', permission: 'read', parameters: empty, execute: async () => { entered(); await gate; return { ok: true }; } }]);
  const call = runtime.request('tool.run', { chatId: chat.id, name: 'fixture_hold', args: {} }); await called;
  try {
    await runtime.request('settings.update', { defaultGrants: all }); const state = await runtime.request('state.get');
    assert.deepEqual(state.chats.find(item => item.id === chat.id).grants, []); assert.deepEqual(state.runs.at(-1).grants, []); assert.equal(state.runs.at(-1).status, 'running');
  } finally { release(); await call; }
});

test('agent-created same-project and cross-project chats retain bounded inheritance despite broader defaults', async t => {
  const { runtime, project, chat, options } = await fixture(t);
  const other = await runtime.request('project.create', { name: 'Other fixture', path: join(options.sourceDir, 'other') });
  await runtime.request('chat.update', { id: chat.id, grants: ['files'], projectGrants: [other.id] });
  await runtime.request('settings.update', { defaultGrants: all });
  const same = await runtime.request('tool.run', { chatId: chat.id, name: 'chat_create', args: { projectId: project.id } });
  const cross = await runtime.request('tool.run', { chatId: chat.id, name: 'chat_create', args: { projectId: other.id } });
  assert.equal(same.parentChatId, chat.id); assert.deepEqual(same.grants, ['files']); assert.deepEqual(same.projectGrants, [other.id]);
  assert.equal(cross.parentChatId, chat.id); assert.deepEqual(cross.grants, []); assert.deepEqual(cross.projectGrants, []);
  const spawned = await runtime.request('tool.run', { chatId: chat.id, name: 'agent_create', args: { task: 'Fixture child' } }), state = await runtime.request('state.get');
  assert.deepEqual(state.chats.find(item => item.id === spawned.chatId).grants, ['files']); assert.deepEqual(state.runs.find(item => item.id === spawned.runId).grants, ['files']);
  assert.deepEqual((await runtime.request('chat.create', { projectId: other.id })).grants, all);
});

test('external sessions start with no grants and still require approval despite profile defaults', async t => {
  const { runtime, project } = await fixture(t); let effects = 0;
  runtime.registerTools([{ name: 'fixture_network', description: 'Synthetic external effect', permission: 'network', parameters: empty, execute: () => ++effects }]);
  await runtime.request('settings.update', { defaultGrants: all });
  const session = await runtime.createExternalSession({ projectId: project.id, providerId: 'local-ollama', toolNames: ['fixture_network'] });
  const external = (await runtime.request('state.get')).chats.find(item => item.externalSessionId === session.id); assert.deepEqual(external.grants, []);
  const approval = new Promise(resolve => { const off = runtime.subscribe(event => { if (event.type === 'approval') { off(); resolve(event.approval); } }); });
  const call = session.callTool({ name: 'fixture_network', args: {} }); const rejected = assert.rejects(call);
  const pending = await approval; assert.equal(pending.rememberable, false);
  await runtime.request('approval.resolve', { id: pending.id, allow: false }); await rejected;
  assert.equal(effects, 0); assert.deepEqual((await runtime.request('state.get')).runs.at(-1).grants, []); await session.close();
});
