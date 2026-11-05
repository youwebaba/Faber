import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createGateway, gatewayToolNames } from '../desktop/gateway.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { fileTools } from '../tools/files.mjs';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const user = [{ role: 'user', content: 'Reply to this client only.' }];
async function until(check) { for (let count = 0; count < 200; count++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Gateway fixture timed out'); }
async function* answer() { yield { type: 'delta', text: 'Hello ' }; yield { type: 'delta', text: 'client' }; yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2 } }; }
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faber-gateway-test-')), sourceDir = path.join(root, 'source'), dataDir = path.join(root, 'data'), projectDir = path.join(root, 'project');
  await fs.mkdir(sourceDir); await fs.mkdir(projectDir); await fs.writeFile(path.join(projectDir, 'hello.txt'), 'project-only-content');
  const secrets = new Map(), events = [], calls = [], effects = [];
  const host = { getSecret: async id => secrets.get(id) || '', setSecret: async (id, value) => { secrets.set(id, value); }, isAutomaticTool: () => true };
  const runtime = await createRuntime({ dataDir, sourceDir, host, provider: async function* () { throw new Error('Gateway tools must not invoke a model'); } });
  runtime.registerTools([...fileTools(), { name: 'shell_run', description: 'Synthetic approval fixture; does not launch a shell.', parameters: empty, permission: 'shell', execute: (_args, ctx) => { effects.push({ projectId: ctx.project.id, runtimeKeys: Object.keys(ctx.runtime) }); return { fixture: true }; } }]);
  const project = await runtime.request('project.create', { name: 'Gateway target', path: projectDir });
  const privateProject = await runtime.request('project.create', { name: 'PRIVATE PROFILE TITLE', path: sourceDir });
  const privateChat = await runtime.request('chat.create', { projectId: privateProject.id, title: 'PRIVATE CHAT TITLE' });
  await runtime.request('chat.update', { id: privateChat.id, systemPrompt: 'PRIVATE PROMPT TEXT' });
  const provider = await runtime.request('provider.save', { id: 'gateway-fixture', name: 'Loopback protocol fixture', kind: options.kind || 'openai', baseUrl: options.baseUrl || 'http://127.0.0.1:1/v1', model: 'fixture-model', apiKey: options.apiKey || '' });
  const gatewayOptions = { dataDir, runtime, host, emit: event => events.push(event), ...(options.adapter ? {} : { stream: async function* (args) { calls.push(args); yield* (options.stream || answer)(args); } }) };
  let gateway = await createGateway(gatewayOptions), token;
  t.after(async () => { await gateway.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const result = { root, dataDir, runtime, project, privateChat, provider, events, calls, effects, secrets, host, gatewayOptions, get gateway() { return gateway; }, get token() { return token; } };
  result.configure = () => gateway.request('gateway.configure', { bindAddress: '127.0.0.1', port: 0, projectId: project.id, providerId: provider.id, model: 'fixture-model' });
  result.start = async () => { await result.configure(); ({ token } = await gateway.request('gateway.rotateToken')); return gateway.request('gateway.start'); };
  result.reopen = async () => { await gateway.close(); gateway = await createGateway(gatewayOptions); return gateway; };
  result.url = async suffix => { const state = await gateway.request('gateway.status'); return `${state.baseUrl.slice(0, -3)}${suffix}`; };
  result.fetch = async (suffix, value, extra = {}) => fetch(await result.url(suffix), { method: value === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra.headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')) });
  result.rpc = (value, session, extra = {}) => result.fetch('/mcp', value, { ...extra, headers: { Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session, 'Mcp-Protocol-Version': '2025-11-25' } : {}), ...extra.headers } });
  result.initialize = async () => { const response = await result.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }); assert.equal(response.status, 200, await response.text()); const id = response.headers.get('Mcp-Session-Id'); assert.ok(id); assert.equal((await result.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, id)).status, 202); return id; };
  return result;
}
function frames(text) { return text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6))); }
async function raw(url, headers) {
  return new Promise((resolve, reject) => { const request = http.request(url, { headers }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode, body })); }); request.on('error', reject); request.end(); });
}

test('gateway stays off, validates its selected scope, stores only nonsecret config and restores stopped', async t => {
  const f = await fixture(t); const initial = await f.gateway.request('gateway.status');
  assert.equal(initial.running, false); assert.equal(initial.hasToken, false); assert.equal(initial.config.bindAddress, '127.0.0.1');
  await assert.rejects(f.gateway.request('gateway.start'), /target project/);
  await assert.rejects(f.gateway.request('gateway.configure', { bindAddress: '0.0.0.0' }), /literal IP/);
  await assert.rejects(f.gateway.request('gateway.configure', { bindAddress: '192.0.2.1' }), /remote access consent/);
  await assert.rejects(f.gateway.request('gateway.configure', { bindAddress: 'attacker.example' }), /literal IP/);
  await assert.rejects(f.gateway.request('gateway.configure', { port: 65536 }), /range/);
  await f.configure(); await assert.rejects(f.gateway.request('gateway.start'), /token/);
  const rotated = await f.gateway.request('gateway.rotateToken'); assert.match(rotated.token, /^[\w-]{43}$/); assert.equal(rotated.running, false);
  const status = await f.gateway.request('gateway.start'); assert.equal(status.running, true); assert.match(status.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  await assert.rejects(f.gateway.request('gateway.configure', { model: 'new' }), /Stop/);
  assert.equal(JSON.stringify([f.events, await f.gateway.request('gateway.status'), await fs.readFile(path.join(f.dataDir, 'gateway.json'), 'utf8')]).includes(rotated.token), false);
  assert.equal(f.secrets.get('external-gateway-token'), rotated.token);
  await f.reopen(); const restored = await f.gateway.request('gateway.status'); assert.equal(restored.running, false); assert.equal(restored.hasToken, true); assert.equal(restored.config.projectId, f.project.id);
});

test('every route and MCP handshake require auth, reject host/origin abuse, and expose one model', async t => {
  const f = await fixture(t); const status = await f.start(), origin = status.baseUrl.slice(0, -3);
  assert.equal((await fetch(`${origin}/v1/models`)).status, 401);
  assert.equal((await f.fetch('/v1/models', undefined, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.fetch('/v1/models', undefined, { headers: { Origin: 'http://attacker.example' } })).status, 403);
  assert.equal((await f.fetch('/v1/models', undefined, { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await f.fetch('/v1/models', undefined, { headers: { Origin: '' } })).status, 403);
  assert.equal((await raw(`${origin}/v1/models`, { Host: 'attacker.example', Authorization: `Bearer ${f.token}` })).status, 403);
  const duplicate = await raw(`${origin}/v1/models`, ['Host', new URL(origin).host, 'Authorization', `Bearer ${f.token}`, 'Authorization', `Bearer ${f.token}`]); assert.equal(duplicate.status, 400);
  const response = await f.fetch('/v1/models'); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null); const body = await response.json(); assert.deepEqual(body.data.map(item => item.id), ['fixture-model']);
  assert.equal(JSON.stringify(body).includes('PRIVATE'), false);
  assert.equal((await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});

test('chat completion has JSON/SSE compatibility, measured usage and no profile history', async t => {
  const f = await fixture(t); await f.start();
  const response = await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user }); assert.equal(response.status, 200);
  const output = await response.json(); assert.equal(output.object, 'chat.completion'); assert.equal(output.choices[0].message.content, 'Hello client'); assert.equal(output.usage.total_tokens, 15); assert.equal(output.usage.prompt_tokens_details.cached_tokens, 2);
  assert.deepEqual(f.calls[0].messages, user); assert.deepEqual(f.calls[0].tools, []); assert.equal(JSON.stringify(f.calls[0].messages).includes('PRIVATE'), false);
  const streamed = await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user, stream: true, stream_options: { include_usage: true } }); const content = await streamed.text(), chunks = frames(content);
  assert.equal(chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta.content || '').join(''), 'Hello client'); assert.equal(chunks.at(-1).usage.total_tokens, 15); assert.match(content, /data: \[DONE\]/);
  assert.equal((await f.fetch('/v1/chat/completions', { model: 'other', messages: user })).status, 404);
  assert.equal((await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user, temperature: 1 })).status, 400);
  assert.equal((await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://attacker.example/image.png' } }] }] })).status, 400);
  assert.equal((await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: [{ role: 'tool', content: 'missing call', tool_call_id: 'none' }] })).status, 400);
});

test('client functions are returned once after validation, never executed as Faber tools', async t => {
  const f = await fixture(t, { stream: async function* () { yield { type: 'delta', text: 'Calling' }; yield { type: 'tool', id: 'external-call', name: 'client_function', args: { value: 2 } }; } }); await f.start();
  const tools = [{ type: 'function', function: { name: 'client_function', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } } }];
  const response = await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user, stream: true, tools, max_completion_tokens: 50 }); const chunks = frames(await response.text()), calls = chunks.flatMap(chunk => chunk.choices.flatMap(choice => choice.delta.tool_calls || []));
  assert.equal(calls.length, 1); assert.equal(calls[0].function.arguments, '{"value":2}'); assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls'); assert.equal(f.calls[0].provider.compactionTokens, 50); assert.deepEqual(f.effects, []);
  const next = await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: [...user, { role: 'assistant', content: null, tool_calls: [{ id: 'external-call', type: 'function', function: { name: 'client_function', arguments: '{"value":2}' } }] }, { role: 'tool', tool_call_id: 'external-call', content: '2' }], tools }); assert.equal(next.status, 200);
});

test('Responses revisions buffer canonical SSE text, and broken model frames return generic errors', async t => {
  const f = await fixture(t, { kind: 'openai-responses', stream: async function* () { yield { type: 'delta', text: 'Draft text' }; yield { type: 'text', text: 'Canonical text' }; } }); await f.start();
  const response = await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user, stream: true }); const text = await response.text(); assert.equal(frames(text).flatMap(frame => frame.choices).map(choice => choice.delta.content || '').join(''), 'Canonical text'); assert.equal(text.includes('Draft text'), false);
  const bad = await fixture(t, { stream: async function* () { throw new Error('SECRET-UPSTREAM-CREDENTIAL'); } }); await bad.start(); const failed = await bad.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user }); assert.equal(failed.status, 502); assert.equal((await failed.text()).includes('SECRET'), false);
  const truncated = await fixture(t, { stream: async function* () { yield { type: 'delta', text: 'partial' }; throw new Error('Model output reached its token limit'); } }); await truncated.start(); const limited = await (await truncated.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user })).json(); assert.equal(limited.choices[0].message.content, 'partial'); assert.equal(limited.choices[0].finish_reason, 'length');
});

test('MCP negotiates lifecycle, exposes scoped shared tools, denies global methods, closes sessions', async t => {
  const f = await fixture(t); await f.start(); const session = await f.initialize();
  const listed = await (await f.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).json();
  assert.ok(listed.result.tools.some(tool => tool.name === 'files_read')); assert.equal(listed.result.tools.some(tool => /agent|chat|project|harness/.test(tool.name)), false); assert.ok(listed.result.tools.every(tool => gatewayToolNames.includes(tool.name))); assert.equal(JSON.stringify(listed).includes('PRIVATE'), false);
  const read = await (await f.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'files_read', arguments: { path: 'hello.txt' }, chatId: f.privateChat.id } }, session)).json(); assert.equal(read.result.isError, false); assert.equal(JSON.parse(read.result.content[0].text).text, 'project-only-content');
  const escape = await (await f.rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'files_read', arguments: { path: '../source/private.txt' } } }, session)).json(); assert.equal(escape.result.isError, true);
  assert.equal((await (await f.rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_list', arguments: {} } }, session)).json()).error.code, -32602);
  assert.equal((await (await f.rpc({ jsonrpc: '2.0', id: 6, method: 'state.get' }, session)).json()).error.code, -32601);
  assert.equal((await f.rpc({ jsonrpc: '2.0', id: 7, method: 'ping' }, session, { headers: { 'Mcp-Protocol-Version': 'wrong' } })).status, 400);
  assert.equal((await f.fetch('/mcp')).status, 405);
  assert.equal((await f.fetch('/mcp', undefined, { method: 'DELETE', headers: { 'Mcp-Session-Id': session, 'Mcp-Protocol-Version': '2025-11-25' } })).status, 200);
  assert.equal((await f.rpc({ jsonrpc: '2.0', id: 8, method: 'ping' }, session)).status, 404);
});

test('external tools never receive automatic authority; each run requires a fresh human approval', async t => {
  const f = await fixture(t); await f.start(); const session = await f.initialize();
  for (const [id, allow] of [[2, false], [3, true], [4, false]]) {
    const pending = f.rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'shell_run', arguments: {} } }, session);
    const approval = await until(async () => (await f.runtime.request('state.get')).approvals[0]); assert.equal(approval.permission, 'shell');
    if (allow) await assert.rejects(f.runtime.request('approval.resolve', { id: approval.id, allow, remember: true }), /only to this operation/);
    await f.runtime.request('approval.resolve', { id: approval.id, allow }); const result = await (await pending).json(); assert.equal(result.result.isError, !allow);
  }
  assert.deepEqual(f.effects, [{ projectId: f.project.id, runtimeKeys: [] }]);
});

test('MCP cancellation and token rotation revoke pending approvals and old sessions', async t => {
  const f = await fixture(t); await f.start(); const session = await f.initialize();
  const pending = f.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shell_run', arguments: {} } }, session);
  await until(async () => (await f.runtime.request('state.get')).approvals.length);
  assert.equal((await f.rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }, session)).status, 202);
  assert.equal((await (await pending).json()).result.isError, true); await until(async () => !(await f.runtime.request('state.get')).approvals.length); assert.deepEqual(f.effects, []);
  const interrupted = f.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shell_run', arguments: {} } }, session).catch(error => error);
  await until(async () => (await f.runtime.request('state.get')).approvals.length);
  const oldToken = f.token, rotated = await f.gateway.request('gateway.rotateToken'); await interrupted;
  assert.equal(rotated.running, false); assert.equal(rotated.activeRequests, 0); assert.equal(rotated.activeSessions, 0); assert.notEqual(rotated.token, oldToken);
  assert.equal((await f.runtime.request('state.get')).approvals.length, 0); assert.deepEqual(f.effects, []);
  await f.gateway.request('gateway.start'); assert.equal((await f.fetch('/v1/models')).status, 401); assert.equal((await f.fetch('/v1/models', undefined, { headers: { Authorization: `Bearer ${rotated.token}` } })).status, 200);
  assert.equal((await f.rpc({ jsonrpc: '2.0', id: 4, method: 'ping' }, session, { headers: { Authorization: `Bearer ${rotated.token}` } })).status, 404);
  assert.equal(JSON.stringify(f.events).includes(rotated.token), false);
});

test('client disconnect releases provider lease, and Stop cancels active model requests', async t => {
  let started = 0, canceled = 0;
  const f = await fixture(t, { stream: async function* ({ signal }) { started++; yield { type: 'delta', text: 'started' }; await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { canceled++; reject(signal.reason); }, { once: true })); } }); await f.start();
  const response = await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user, stream: true }); await until(() => started === 1);
  await assert.rejects(f.runtime.request('provider.save', { id: f.provider.id, name: 'Changed', kind: 'openai', baseUrl: 'http://127.0.0.1:2/v1', model: 'fixture-model' }), /in use/);
  await response.body.cancel(); await until(() => canceled === 1); await until(async () => (await f.gateway.request('gateway.status')).activeRequests === 0);
  const pending = f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user }).catch(error => error); await until(() => started === 2);
  const stopped = await f.gateway.request('gateway.stop'); await pending; assert.equal(stopped.activeRequests, 0); assert.equal(stopped.running, false); assert.equal(canceled, 2);
  await f.runtime.request('provider.save', { id: f.provider.id, name: 'Changed', kind: 'openai', baseUrl: 'http://127.0.0.1:2/v1', model: 'fixture-model' });
});

test('request sizes and concurrent inference are bounded', async t => {
  let started = 0;
  const f = await fixture(t, { stream: async function* ({ signal }) { started++; await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } }); await f.start();
  const tooLarge = await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: [{ role: 'user', content: 'x'.repeat(4 * 1024 * 1024) }] }); assert.equal(tooLarge.status, 413);
  const pending = Array.from({ length: 4 }, () => f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user }).catch(error => error)); await until(() => started === 4);
  assert.equal((await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user })).status, 429);
  await f.gateway.request('gateway.stop'); await Promise.all(pending); assert.equal((await f.gateway.request('gateway.status')).activeRequests, 0);
});

for (const kind of ['openai', 'ollama', 'openai-responses']) test(`gateway reuses the real ${kind} adapter against synthetic loopback upstream`, async t => {
  const received = [], upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); received.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    if (kind === 'ollama') { response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.end(JSON.stringify({ message: { content: 'canonical' }, done: false }) + '\n' + JSON.stringify({ done: true, prompt_eval_count: 9, eval_count: 2 }) + '\n'); }
    else if (kind === 'openai') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'canonical' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n'); }
    else { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end([{ type: 'response.output_text.delta', delta: 'draft' }, { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', usage: { input_tokens: 9, output_tokens: 2 }, output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'canonical', annotations: [] }] }] } }].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const f = await fixture(t, { adapter: true, kind, baseUrl: `http://127.0.0.1:${upstream.address().port}${kind === 'ollama' ? '' : '/v1'}`, apiKey: 'fake-UPSTREAM-SECRET-FIXTURE' }); await f.start();
  const output = await (await f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user, stream: true, stream_options: { include_usage: true } })).text();
  assert.equal(frames(output).flatMap(frame => frame.choices).map(choice => choice.delta.content || '').join(''), 'canonical'); assert.equal(frames(output).at(-1).usage.total_tokens, 11);
  assert.equal(received.length, 1); assert.equal(received[0].authorization, 'Bearer fake-UPSTREAM-SECRET-FIXTURE'); assert.equal(JSON.stringify(received[0].body).includes('PRIVATE'), false); assert.equal(output.includes('fake-UPSTREAM-SECRET-FIXTURE'), false); assert.equal(output.includes('draft'), false);
  assert.equal(received[0].url, kind === 'ollama' ? '/api/chat' : kind === 'openai' ? '/v1/chat/completions' : '/v1/responses');
});
test('Stop fences requests paused before model or MCP admission without waiting for route reads', { timeout: 3000 }, async t => {
  for (const kind of ['model', 'mcp']) {
    const f = await fixture(t); await f.start();
    const original = f.runtime.request; let release, entered = false, contexts = 0;
    const gate = new Promise(resolve => release = resolve);
    f.runtime.request = async (method, params) => { if (method === 'state.get') { entered = true; await gate; } return original(method, params); };
    const create = f.runtime.createExternalSession;
    f.runtime.createExternalSession = args => { contexts++; return create(args); };
    const pending = (kind === 'model' ? f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user }) : f.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } })).catch(error => error);
    await until(() => entered);
    const stopped = await f.gateway.request('gateway.stop'); assert.equal(stopped.running, false); assert.equal(stopped.activeRequests, 0);
    await pending; release(); f.runtime.request = original;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0); assert.equal(contexts, 0);
    assert.equal((await f.runtime.request('state.get')).chats.some(chat => chat.externalSessionId), false);
  }
});

test('disconnect during preflight cannot start inference after the route resolves', { timeout: 3000 }, async t => {
  const f = await fixture(t); await f.start();
  const original = f.runtime.request; let release, entered = false;
  const gate = new Promise(resolve => release = resolve);
  f.runtime.request = async (method, params) => { if (method === 'state.get') { entered = true; await gate; } return original(method, params); };
  const client = new AbortController(), pending = f.fetch('/v1/chat/completions', { model: 'fixture-model', messages: user }, { signal: client.signal }).catch(error => error);
  await until(() => entered); client.abort(); await pending;
  await until(async () => (await f.gateway.request('gateway.status')).activeRequests === 0);
  release(); f.runtime.request = original; await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
});

test('Stop cancels a partial request body before it reaches model admission', { timeout: 3000 }, async t => {
  const f = await fixture(t); await f.start();
  const request = http.request(await f.url('/v1/chat/completions'), { method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' } });
  const finished = new Promise(resolve => { request.on('error', resolve); request.on('response', response => { response.resume(); response.on('end', resolve); }); });
  request.write('{"model":');
  await until(async () => (await f.gateway.request('gateway.status')).activeRequests === 1);
  const stopped = await f.gateway.request('gateway.stop'); await finished; assert.equal(stopped.activeRequests, 0); assert.equal(f.calls.length, 0);
});

test('rotation drains a delayed MCP initializer and archives its late context', { timeout: 3000 }, async t => {
  const f = await fixture(t); await f.start();
  const original = f.runtime.createExternalSession; let release, entered = false;
  const gate = new Promise(resolve => release = resolve);
  f.runtime.createExternalSession = async args => { entered = true; await gate; return original(args); };
  const pending = f.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }).catch(error => error);
  await until(() => entered); const rotated = await f.gateway.request('gateway.rotateToken'); await pending;
  assert.equal(rotated.running, false); assert.equal(rotated.activeRequests, 0); assert.equal(rotated.activeSessions, 0);
  release();
  await until(async () => { const external = (await f.runtime.request('state.get')).chats.filter(chat => chat.externalSessionId); return external.length === 1 && external.every(chat => chat.archived); });
  assert.equal(f.effects.length, 0);
});
