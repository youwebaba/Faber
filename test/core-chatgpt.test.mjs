import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../core/runtime.mjs';
import { streamProvider } from '../core/provider.mjs';

// Exercise the whole runtime tool loop with an injected account transport. These
// are synthetic tokens and SSE frames, never real sign-in or plan usage.
for (const [namespace, emptyTerminal] of [['faber', false], ['other', false], ['faber', true]]) test(`ChatGPT runtime ${emptyTerminal ? 'replays Sol-style completed snapshots with empty terminal output' : namespace === 'faber' ? 'replays namespaced tools and opaque reasoning' : 'rejects a foreign namespace before tool execution'}`, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'faber-chatgpt-loop-test-'));
  const accountId = '12345678-1234-1234-1234-123456789abc', providerId = `chatgpt:${accountId}`;
  const requests = []; let executed = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    requests.push(JSON.parse(init.body));
    const output = requests.length === 1 ? [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque fixture', summary: [] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', namespace, name: 'fixture_read', arguments: '{}', status: 'completed' },
    ] : [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'finished' }], status: 'completed' }];
    const frames = emptyTerminal ? output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })) : [];
    frames.push({ type: 'response.completed', response: { status: 'completed', output: emptyTerminal ? [] : output, usage: { input_tokens: 100, output_tokens: 10 } } });
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
  };
  const runtime = await createRuntime({ dataDir: path.join(root, 'data'), sourceDir: path.join(root, 'source'),
    host: { getChatGPTToken: () => 'fixture-token', getSecret: () => { throw new Error('Account requests must not use API-key storage'); }, providerControls: () => ({ context: { capacityTokens: 128000 }, reasoning: { efforts: ['none', 'high'], default: 'high' } }) },
    provider: args => streamProvider({ ...args, fetchImpl }),
  });
  t.after(async () => { await runtime.close(); assert.ok(path.basename(root).startsWith('faber-chatgpt-loop-test-')); await fs.rm(root, { recursive: true, force: true }); });
  await runtime.setAccountProviders([{ id: providerId, accountId, name: 'Fixture', kind: 'openai-responses', authKind: 'chatgpt', baseUrl: 'https://api.openai.com/v1', model: 'fixture', hasKey: true, connected: true,
    models: [{ id: emptyTerminal ? 'gpt-6.1-sol' : 'fixture', name: 'Fixture', contextTokens: 128000, reasoningEfforts: ['none', 'high'], defaultReasoningEffort: 'high' }],
  }]);
  runtime.registerTools([{ name: 'fixture_read', description: 'Fixture only', permission: emptyTerminal ? 'files' : 'read', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => { executed++; return { value: 3 }; } }]);
  const project = await runtime.request('project.create', { name: 'Fixture', path: path.join(root, 'source') });
  const chat = await runtime.request('chat.create', { projectId: project.id });
  await runtime.request('chat.update', { id: chat.id, providerId, model: emptyTerminal ? 'gpt-6.1-sol' : 'fixture', reasoningEffort: 'high', thinking: null, ...(emptyTerminal ? { grants: ['files'] } : {}) });
  const sent = await runtime.request('chat.send', { chatId: chat.id, text: 'Use fixture tool' });
  let state, run;
  for (let i = 0; i < 200; i++) {
    state = await runtime.request('state.get'); run = state.runs.find(item => item.id === sent.runId);
    if (run && !['running', 'waiting_approval'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(JSON.stringify(state).includes('fixture-token'), false);
  assert.equal(requests[0].tools[0].type, 'namespace'); assert.equal(requests[0].input[0].role, 'developer');
  if (namespace !== 'faber') { assert.equal(run.status, 'failed'); assert.match(run.error, /outside the Faber namespace/); assert.equal(executed, 0); assert.equal(requests.length, 1); return; }
  assert.equal(run.status, 'completed', run.error); assert.equal(executed, 1); assert.equal(requests.length, 2);
  assert.equal(requests[1].input.find(item => item.type === 'function_call').namespace, 'faber');
  assert.equal(requests[1].input.find(item => item.type === 'function_call_output').call_id, 'call_1');
  assert.equal(requests[1].input.find(item => item.type === 'reasoning').encrypted_content, 'opaque fixture');
  assert.equal(requests[1].reasoning.effort, 'high');
  assert.deepEqual(run.modelCalls.map(call => call.usage), [{ inputTokens: 100, outputTokens: 10 }, { inputTokens: 100, outputTokens: 10 }]);
  assert.equal(state.chats.find(item => item.id === chat.id).messages.at(-1).content, 'finished');
  if (emptyTerminal) {
    assert.equal(requests[0].model, 'gpt-6.1-sol'); assert.deepEqual(state.chats.find(item => item.id === chat.id).grants, ['files']);
    assert.equal(run.toolEvents.filter(event => event.status === 'completed').length, 1);
    await runtime.close();
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'data', 'state.json'), 'utf8'));
    const saved = persisted.chats.find(item => item.id === chat.id).messages.at(-1);
    assert.equal(saved.content, 'finished'); assert.equal(saved.providerOutput.items[0].id, 'msg_1');
  }
});
