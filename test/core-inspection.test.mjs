import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../core/runtime.mjs';
import { responsesInput } from '../core/responses.mjs';

test('existing recursive inspection history projects to references without rewriting ordinary or durable content', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'faber-inspection-test-'));
  const options = { dataDir: join(root, 'data'), sourceDir: join(root, 'source') };
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const first = await createRuntime(options); runtimes.push(first);
  const project = await first.request('project.create', { name: 'Fixture', path: options.sourceDir });
  const chat = await first.request('chat.create', { projectId: project.id });
  const provider = await first.request('provider.save', { name: 'Fixture', kind: 'openai-responses', baseUrl: 'http://localhost:1/v1', model: 'fixture' });
  await first.request('chat.update', { id: chat.id, providerId: provider.id });
  await first.close();
  const statePath = join(options.dataDir, 'state.json'), state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const ordinary = 'Original full file content '.repeat(4000);
  const nested = { chat: { messages: [{ role: 'assistant', providerOutput: { items: [{ encrypted_content: 'COPIED_OPAQUE'.repeat(10000) }] }, image: 'data:image/png;base64,OLD_IMAGE_BYTES', content: ordinary }] } };
  const calls = ['chat_read', 'agent_read', 'agent_wait'].map((name, i) => ({ id: `inspection-${i}`, name, args: name === 'chat_read' ? { chatId: chat.id } : { runId: 'old-run' } }));
  const actualOpaque = { type: 'reasoning', id: 'rs_actual', summary: [], encrypted_content: 'ACTUAL_OPAQUE_MUST_STAY' };
  const output = [actualOpaque, ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }))];
  state.chats[0].messages = [
    { id: 'user', role: 'user', content: ordinary },
    { id: 'ordinary-call', role: 'assistant', content: '', toolCalls: [{ id: 'file', name: 'files_read', args: { path: 'source' } }] },
    { id: 'ordinary-result', role: 'tool', toolCallId: 'file', toolName: 'files_read', content: JSON.stringify({ text: ordinary, chat: nested }) },
    { id: 'inspection-calls', role: 'assistant', content: '', toolCalls: calls, providerOutput: { kind: provider.kind, providerId: provider.id, baseUrl: provider.baseUrl, model: provider.model, items: output } },
    ...calls.map((call, i) => ({ id: `snapshot-${i}`, role: 'tool', toolCallId: call.id, toolName: call.name, content: JSON.stringify({ ...nested, previousInspection: JSON.stringify(nested) }) })),
    { id: 'final', role: 'assistant', content: 'Useful previous final reply', status: 'completed', runId: 'old-run' },
  ];
  state.runs.push({ id: 'old-run', chatId: chat.id, status: 'completed', toolEvents: [{ id: 'file-event', name: 'files_read', args: { path: 'source' }, result: { text: ordinary }, status: 'completed' }, { id: 'inspection-event', name: 'chat_read', args: { chatId: chat.id }, result: nested, status: 'completed' }] });
  state.runs[0].toolEvents.push({ id: 'image-event', name: 'desktop_screenshot', args: {}, result: { image: 'data:image/png;base64,OLD_IMAGE_BYTES', description: 'actual screenshot' }, status: 'completed' });
  const original = structuredClone(state.chats[0].messages);
  await fs.writeFile(statePath, JSON.stringify(state));
  let seen;
  const runtime = await createRuntime({ ...options, provider: async function* (input) { seen = input; yield { type: 'delta', text: 'done' }; } }); runtimes.push(runtime);
  const ended = new Promise(resolve => runtime.subscribe(event => { if (event.type === 'state' && event.state.runs.some(run => run.status === 'completed' && run.id !== 'old-run')) resolve(); }));
  await runtime.request('chat.send', { chatId: chat.id, text: 'continue' }); await ended;
  for (const message of original) {
    const projected = seen.messages.find(item => item.id === message.id);
    if (message.id.startsWith('snapshot-')) {
      const view = JSON.parse(projected.content);
      assert.equal(view.reference.messageId, message.id); assert.equal(view.reference.chatId, chat.id);
      assert.ok(projected.content.length < message.content.length / 100);
      assert.ok(!projected.content.includes('COPIED_OPAQUE')); assert.ok(!projected.content.includes('OLD_IMAGE_BYTES'));
    } else assert.equal(projected.content, message.content);
  }
  assert.deepEqual(seen.messages.find(message => message.providerOutput).providerOutput.items, output);
  const wire = responsesInput(seen.messages, provider);
  assert.ok(wire.some(item => item.encrypted_content === actualOpaque.encrypted_content));
  // Ordinary tool data is not reclassified by a nested chat-shaped value.
  assert.equal(wire.find(item => item.call_id === 'file' && item.type === 'function_call_output').output, original[2].content);
  const disk = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.deepEqual(disk.chats[0].messages.slice(0, original.length), original);

  const inspect = (name, args) => runtime.request('tool.run', { chatId: chat.id, name, args });
  const index = await inspect('chat_read', { chatId: chat.id });
  assert.equal(index.finalReply.content, undefined); assert.ok(index.finalReply.id); assert.ok(index.messages.every(message => message.content === undefined));
  assert.ok(!JSON.stringify(index).includes('COPIED_OPAQUE'));
  const selected = await inspect('chat_read', { chatId: chat.id, messageIds: ['ordinary-result', 'snapshot-0'] });
  assert.equal(selected.messages[0].content, original[2].content);
  assert.equal(JSON.parse(selected.messages[1].content).reference.messageId, 'snapshot-0');
  const agent = await inspect('agent_read', { runId: 'old-run', toolEventIds: ['file-event', 'inspection-event'] });
  assert.equal(agent.toolEvents[0].result.text, ordinary);
  assert.equal(agent.toolEvents[1].result, undefined); assert.equal(agent.toolEvents[1].reference.toolEventId, 'inspection-event');
  assert.equal(agent.run.toolEvents, undefined); assert.equal(agent.run.modelCalls, undefined);
  assert.ok(!JSON.stringify(agent).includes('COPIED_OPAQUE'));
  const image = await inspect('agent_read', { runId: 'old-run', toolEventIds: ['image-event'] });
  assert.ok(!JSON.stringify(image).includes('OLD_IMAGE_BYTES')); assert.equal(image.toolEvents[0].result.description, 'actual screenshot');
  assert.deepEqual(image.toolEvents[0].result.imageReference, { runId: 'old-run', toolEventId: 'image-event' });
  const otherChat = await runtime.request('chat.create', { projectId: project.id });
  const cross = await runtime.request('tool.run', { chatId: otherChat.id, name: 'agent_read', args: { runId: 'old-run' } });
  assert.equal(cross.finalReply.content, 'Useful previous final reply'); assert.equal(cross.finalReply.runId, 'old-run');
  await assert.rejects(inspect('chat_read', { chatId: chat.id, messageIds: ['missing'] }), /Unknown message/);
  const harness = await inspect('harness_inspect', {});
  assert.ok(harness.tools.every(tool => !Object.hasOwn(tool, 'parameters')));
});
