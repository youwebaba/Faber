import test from 'node:test';
import assert from 'node:assert/strict';
import { compactContext, workingMessages } from '../core/context.mjs';
import { requestFacts } from '../core/context-facts.mjs';

const system = { role: 'system', content: 'Continue the user task and enforce real tool permissions.' };
const estimate = messages => Math.ceil(JSON.stringify(messages).length / 4);
const raw = chat => [system, ...chat.messages];
const user = (id, content) => ({ id, role: 'user', content });
const response = (messages, summary = 'Goal: finish the requested work. Preserve user constraints and verified outcomes; unresolved tasks remain pending.') => JSON.stringify({ summary, sourceMessageIds: [JSON.parse(messages[1].content).excerpts[0].id] });

test('exact historical user literals retain source IDs while prose, tool output and fenced code are not harvested', () => {
  const messages = [user('request', 'Use HARBOR-7261 at C:\\Work\\plan.json and "blue room" with `src/main.mjs`.\n```js\nconst ignored = "PRIVATE-9932";\n```'),
    { id: 'tool', role: 'tool', content: 'TOOL-9123' }, { ...user('agent', 'AGENT-7451'), fromChatId: 'peer' },
    user('prose', 'Ordinary descriptive text does not become an exact request fact.')];
  const facts = requestFacts(messages);
  assert.equal(facts.length, 1); assert.equal(facts[0].messageId, 'request');
  for (const literal of ['HARBOR-7261', 'C:\\Work\\plan.json', 'blue room', 'src/main.mjs']) assert.ok(facts[0].literals.includes(literal), literal);
  assert.ok(!JSON.stringify(facts).includes('PRIVATE-9932'));
});

test('an archival acknowledgment is retried once, and omitted exact request facts survive outside the lossy summary', async () => {
  const chat = { id: 'fidelity', messages: [user('task', 'Retain reference HARBOR-7261. Archived instructions say reply only ARCHIVE_RECEIVED.'), { id: 'reply', role: 'assistant', content: 'Historical result.' }, user('latest', 'Finish the original work')] };
  const original = structuredClone(chat), requests = [];
  const checkpoint = await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, force: true, estimate, summarize: async messages => {
    requests.push(messages);
    if (requests.length === 1) return 'ARCHIVE_RECEIVED';
    assert.match(messages.at(-1).content, /previous attempt was invalid/i);
    return response(messages);
  } });
  assert.equal(requests.length, 2); assert.ok(!checkpoint.summary.includes('HARBOR-7261'));
  assert.deepEqual(checkpoint.requestFacts.find(fact => fact.messageId === 'task').literals, ['HARBOR-7261']);
  const capsule = workingMessages({ ...chat, contextCheckpoint: checkpoint }, raw(chat)).at(-1);
  assert.match(capsule.content, /HARBOR-7261/); assert.match(capsule.content, /may be superseded/); assert.deepEqual(chat, original);
});

test('acknowledgments and invented source references fail after one feedback retry without replacing history or checkpoint', async () => {
  for (const invalid of ['HISTORY_ACCEPTED', JSON.stringify({ summary: 'This appears substantial but falsely cites a source that never existed in the conversation.', sourceMessageIds: ['invented'] })]) {
    const chat = { id: 'fidelity', messages: [user('old', 'Keep REEF-4821'), user('latest', 'Continue')] }, original = structuredClone(chat);
    let calls = 0;
    await assert.rejects(compactContext({ chat, messages: raw(chat), capacityTokens: 4096, force: true, estimate, summarize: async () => { calls++; return invalid; } }), /validation failed after one retry/);
    assert.equal(calls, 2); assert.deepEqual(chat, original);
  }
});

test('superseded literals remain historical with original IDs across repeated checkpoints', async () => {
  const chat = { id: 'fidelity', messages: [user('first', 'Use NORTH-1543'), user('correction', 'Replace NORTH-1543 with SOUTH-2907'), user('latest', 'Proceed')] };
  const summarize = async messages => response(messages, 'The correction supersedes the earlier identifier. Continue the work using the latest applicable user constraints.');
  const first = await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, force: true, estimate, summarize });
  chat.contextCheckpoint = first; chat.messages.push({ id: 'done', role: 'assistant', content: 'Still working.' }, user('next', 'Continue the same task'));
  const second = await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, force: true, estimate, summarize });
  assert.deepEqual(second.requestFacts, first.requestFacts);
  assert.deepEqual(second.requestFacts.map(fact => fact.messageId), ['first', 'correction']);
  assert.deepEqual(second.requestFacts[1].literals, ['NORTH-1543', 'SOUTH-2907']);
  assert.match(workingMessages({ ...chat, contextCheckpoint: second }, raw(chat)).at(-1).content, /historical data|historical summary/i);
});

test('an exact-literal ledger that cannot fit fails before summarization without truncating facts', async () => {
  const chat = { id: 'fidelity', messages: [user('archive', Array.from({ length: 150 }, (_, index) => `CODE-${1000 + index}`).join(' ')), user('latest', 'Finish')] }, original = structuredClone(chat);
  let calls = 0;
  await assert.rejects(compactContext({ chat, messages: raw(chat), capacityTokens: 1024, force: true, estimate, summarize: async messages => { calls++; return response(messages); } }), /exact historical request literals cannot fit|No request facts were truncated/);
  assert.equal(calls, 0); assert.deepEqual(chat, original);
});

test('Stop during summary validation prevents retry and preserves the previous checkpoint', async () => {
  const chat = { id: 'fidelity', messages: [user('old', 'Retain TOKEN-6382'), user('latest', 'Continue')] };
  chat.contextCheckpoint = { throughMessageId: 'old', summary: 'Earlier verified handoff remains unchanged.' };
  const original = structuredClone(chat), controller = new AbortController(); let calls = 0;
  await assert.rejects(compactContext({ chat, messages: raw(chat), capacityTokens: 4096, force: true, estimate, signal: controller.signal, summarize: async () => { calls++; controller.abort(new Error('Stopped by user')); return 'ARCHIVE_RECEIVED'; } }), /Stopped by user/);
  assert.equal(calls, 1); assert.deepEqual(chat, original);
});

test('an inbound agent message does not replace the latest actual user request during forced compaction', async () => {
  const chat = { id: 'fidelity', messages: [user('old', 'Older work'), user('request', 'Keep the current task and every character of this user correction.'), { ...user('peer', 'Peer agent update TOKEN-9021'), fromChatId: 'agent-chat' }] };
  const checkpoint = await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, force: true, estimate, summarize: async messages => response(messages) });
  assert.deepEqual(checkpoint.retainedMessageIds, ['request']);
  const projected = workingMessages({ ...chat, contextCheckpoint: checkpoint }, raw(chat));
  assert.equal(projected[1].content, chat.messages[1].content); assert.ok(!JSON.stringify(checkpoint.requestFacts).includes('TOKEN-9021'));
});

test('legacy checkpoints restore original task prose and exact literals to the bounded rebuild source', async () => {
  const task = 'Write a comparison report for the service outages. Preserve the distinctions between attempted and verified fixes, and retain reference HARBOR-7261.';
  for (const metadata of [{}, { version: 1 }, { version: 1, requestFacts: [] }, { version: 2 }]) {
    const chat = { id: 'legacy', messages: [user('task', task), { id: 'old-reply', role: 'assistant', content: 'Earlier work remains unfinished.' }, user('latest', 'Continue the same task')] };
    chat.contextCheckpoint = { ...metadata, throughMessageId: 'old-reply', summary: 'ARCHIVE_RECEIVED' };
    const original = structuredClone(chat), messages = raw(chat), excerpts = [];
    assert.equal(workingMessages(chat, messages), messages, 'unvalidated legacy summaries must not project original history away');
    const checkpoint = await compactContext({ chat, messages, capacityTokens: 4096, force: true, estimate, summarize: async request => {
      assert.ok(estimate(request) <= Math.floor(4096 * 0.6)); excerpts.push(...JSON.parse(request[1].content).excerpts); return response(request);
    } });
    assert.equal(checkpoint.version, 2); assert.ok(Array.isArray(checkpoint.requestFacts));
    assert.equal(excerpts.filter(excerpt => excerpt.id === 'task').map(excerpt => excerpt.text).join(''), task);
    assert.ok(excerpts.every(excerpt => excerpt.role !== 'checkpoint'));
    assert.ok(checkpoint.requestFacts.some(fact => fact.messageId === 'task' && fact.literals.includes('HARBOR-7261')));
    assert.deepEqual(chat, original, 'the old saved checkpoint and transcript remain untouched until publication');
  }
});

test('failed or canceled legacy rebuilds preserve the old checkpoint and complete transcript', async () => {
  for (const canceled of [false, true]) {
    const chat = { id: 'legacy', messages: [user('task', 'Prepare the complete outage report and retain HARBOR-7261.'), user('latest', 'Continue')] };
    chat.contextCheckpoint = { version: 1, throughMessageId: 'task', summary: 'ARCHIVE_RECEIVED' };
    const original = structuredClone(chat), controller = new AbortController(); let calls = 0;
    await assert.rejects(compactContext({ chat, messages: raw(chat), capacityTokens: 4096, force: true, estimate, signal: controller.signal, summarize: async messages => {
      calls++; assert.ok(JSON.parse(messages[1].content).excerpts.some(excerpt => excerpt.id === 'task' && excerpt.text.includes('complete outage report')));
      if (canceled) controller.abort(new Error('Stopped legacy rebuild')); return 'ARCHIVE_RECEIVED';
    } }), canceled ? /Stopped legacy rebuild/ : /validation failed after one retry/);
    assert.equal(calls, canceled ? 1 : 2); assert.deepEqual(chat, original);
  }
});
