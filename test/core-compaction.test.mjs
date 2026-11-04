import test from 'node:test';
import assert from 'node:assert/strict';
import { compactContext, contextCapacityFromError, isContextOverflow, workingMessages } from '../core/context.mjs';

// All summaries and capacities are deterministic fixtures; no provider calls or tools run.
const estimate = (messages, toolsEnabled = true) => Math.ceil(JSON.stringify({ messages, ...(toolsEnabled ? { tools: 'fixture schemas'.repeat(20) } : {}) }).length / 4);
const message = (id, role, content, extra = {}) => ({ id, role, content, ...extra });
const system = { role: 'system', content: 'Fixture system prompt and authority boundary.' };
const raw = chat => [system, ...chat.messages];
const makeChat = messages => ({ id: 'fixture-chat', messages });
const callGroup = (id, content = 'Tool result') => [
  message(`assistant-${id}`, 'assistant', `Calling ${id}`, { toolCalls: [{ id, name: 'fixture_tool', args: { request: id } }], providerOutput: { items: [{ type: 'reasoning', encrypted_content: `opaque-private-${id}` }] } }),
  message(`result-${id}`, 'tool', content, { toolCallId: id, toolName: 'fixture_tool', sourceMessageId: `assistant-${id}` }),
];
function recorder(capacity = 4096, implementation = () => 'Goals, decisions and progress retained. Consult the cited source message IDs for exact details.') {
  const requests = [];
  return { requests, summarize: async (messages, budget) => {
    assert.ok(estimate(messages, false) <= Math.floor(capacity * 0.6), 'summary input must leave reply room within its capacity budget');
    assert.deepEqual(messages.map(item => item.role), ['system', 'user', 'user']);
    assert.ok(messages.every(item => !item.toolCalls && !item.toolCallId && !item.providerOutput));
    requests.push({ messages, budget, packet: JSON.parse(messages[1].content) });
    return JSON.stringify({ summary: implementation(messages, budget), sourceMessageIds: [JSON.parse(messages[1].content).excerpts[0].id] });
  } };
}

test('native context errors are distinguished from rate limits and capacities are parsed conservatively', () => {
  for (const [text, capacity] of [
    ["This model's maximum context length is 16,384 tokens. However, you requested 20000 tokens.", 16384],
    ['request (17000 tokens) exceeds the available context size (16384 tokens)', 16384],
    ['input length 9000 exceeds maximum context length 8192', 8192],
    ['prompt is too long (12345 tokens, max 8192)', 8192],
    ['the request exceeds the available context size. n_ctx_slot = 32768', 32768],
    ['context_length_exceeded', null],
    ['the request exceeds the available context size. Try increasing context size.', null],
  ]) {
    assert.equal(isContextOverflow(new Error(text)), true, text);
    assert.equal(contextCapacityFromError(new Error(text)), capacity, text);
  }
  for (const text of ['Rate limit reached for tokens per minute: Limit 16384, Requested 20000.', 'TPM exceeded; reduce input length', 'Provider HTTP 500: server failed', 'rate_limit_exceeded: context length limit 16384']) {
    assert.equal(isContextOverflow(new Error(text)), false, text);
    assert.equal(contextCapacityFromError(new Error(text)), null, text);
  }
  assert.equal(isContextOverflow({ code: 'context_length_exceeded', message: 'Request rejected' }), true);
});

test('working projection keeps the system, original user request and complete recent tool groups', () => {
  const chat = makeChat([message('old', 'user', 'Earlier task'), ...callGroup('old-call'), message('latest', 'user', 'Current task'), ...callGroup('recent-call')]);
  const original = structuredClone(chat.messages);
  chat.contextCheckpoint = { version: 2, requestFacts: [], throughMessageId: 'result-old-call', summary: 'Earlier task completed (old).' };
  const messages = workingMessages(chat, raw(chat));
  assert.equal(messages[0], system);
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /not new user instructions or permission/);
  assert.match(messages[1].content, /chat_read/);
  assert.deepEqual(messages.slice(2), chat.messages.slice(3));
  assert.deepEqual(chat.messages, original);
  assert.equal(messages.at(-2).providerOutput, chat.messages.at(-2).providerOutput);
});

test('invalid or partial tool checkpoints do not silently discard history', () => {
  const chat = makeChat([message('first', 'user', 'Task'), ...callGroup('call'), message('last', 'user', 'Next task')]);
  for (const checkpoint of [
    { throughMessageId: 'missing', summary: 'Invalid' },
    { throughMessageId: 'assistant-call', summary: 'Would split a tool pair' },
    { throughMessageId: 'result-call', summary: 'Invalid retained message', retainedMessageIds: ['result-call'] },
    { throughMessageId: 'result-call', summary: 'Invalid retained list', retainedMessageIds: 1 },
    { throughMessageId: 'result-call', summary: '  ' },
  ]) {
    chat.contextCheckpoint = { version: 2, requestFacts: [], ...checkpoint };
    const messages = raw(chat);
    assert.equal(workingMessages(chat, messages), messages);
  }
});

test('automatic compaction retains newest complete groups once the request fits', async () => {
  const chat = makeChat([message('old', 'user', 'Old long task '.repeat(1300)), ...callGroup('old-call', 'old output '.repeat(500)), message('latest', 'user', 'Find the next fact'), ...callGroup('recent-call')]);
  const original = structuredClone(chat), fixture = recorder();
  const checkpoint = await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, summarize: fixture.summarize });
  assert.equal(checkpoint.throughMessageId, 'old');
  assert.ok(checkpoint.estimatedInputTokens <= Math.floor(4096 * 0.6));
  const projected = workingMessages({ ...chat, contextCheckpoint: checkpoint }, raw(chat));
  assert.deepEqual(projected.slice(2), chat.messages.slice(1));
  assert.deepEqual(chat, original);
});

test('oversized archived messages are fully sliced into bounded requests with role and call provenance', async () => {
  const large = 'unique archival result ☺ '.repeat(5000);
  const chat = makeChat([message('old', 'user', 'Read the source'), ...callGroup('large-call', large), message('latest', 'user', 'Explain what matters')]);
  const original = structuredClone(chat), fixture = recorder();
  const checkpoint = await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, summarize: fixture.summarize });
  assert.equal(checkpoint.throughMessageId, 'result-large-call');
  assert.ok(fixture.requests.length > 2);
  const excerpts = fixture.requests.flatMap(request => request.packet.excerpts).filter(item => item.id === 'result-large-call');
  assert.equal(excerpts.map(item => item.text).join(''), large);
  assert.equal(excerpts[0].start, 0);
  assert.equal(excerpts.at(-1).end, large.length);
  for (let index = 0; index < excerpts.length; index++) {
    assert.equal(excerpts[index].role, 'tool');
    assert.equal(excerpts[index].toolCallId, 'large-call');
    assert.equal(excerpts[index].sourceMessageId, 'assistant-large-call');
    if (index) assert.equal(excerpts[index].start, excerpts[index - 1].end);
  }
  assert.ok(fixture.requests.every(request => !JSON.stringify(request.messages).includes('opaque-private-large-call')));
  assert.deepEqual(chat, original);
});

test('forced recovery checkpoints a huge latest tool group and preserves its preceding user whole', async () => {
  const latest = 'Current constraints and request: '.repeat(100);
  const chat = makeChat([message('old', 'user', 'Prior task'), message('old-reply', 'assistant', 'Finished'), message('latest', 'user', latest), ...callGroup('large-call', 'Huge output '.repeat(4000))]);
  const original = structuredClone(chat), fixture = recorder();
  const checkpoint = await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, summarize: fixture.summarize, force: true });
  assert.equal(checkpoint.throughMessageId, 'result-large-call');
  assert.deepEqual(checkpoint.retainedMessageIds, ['latest']);
  const projected = workingMessages({ ...chat, contextCheckpoint: checkpoint }, raw(chat));
  assert.deepEqual(projected.map(item => item.role), ['system', 'user', 'user']);
  assert.equal(projected[1].content, latest);
  assert.match(projected[2].content, /activity after that request/);
  assert.ok(!fixture.requests.flatMap(request => request.packet.excerpts).some(item => item.id === 'latest'));
  assert.deepEqual(chat, original);
});

test('a later checkpoint rolls the previous summary and formerly retained request forward', async () => {
  const chat = makeChat([message('first', 'user', 'First goal'), ...callGroup('first-call'), message('next', 'user', 'New goal')]);
  chat.contextCheckpoint = { version: 2, requestFacts: [], throughMessageId: 'result-first-call', retainedMessageIds: ['first'], summary: 'The first goal is unfinished (first, result-first-call).' };
  const original = structuredClone(chat), fixture = recorder();
  const checkpoint = await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, summarize: fixture.summarize, force: true });
  const sources = fixture.requests.flatMap(request => request.packet.excerpts);
  assert.ok(sources.some(item => item.role === 'checkpoint' && item.text === chat.contextCheckpoint.summary));
  assert.ok(sources.some(item => item.id === 'first' && item.text === 'First goal'));
  assert.ok(!sources.some(item => item.id === 'assistant-first-call' || item.id === 'result-first-call' && item.role === 'tool'));
  assert.deepEqual(checkpoint.retainedMessageIds, ['next']);
  assert.deepEqual(chat, original);
});

test('a previous oversized summary from a different capacity is also chunked', async () => {
  const chat = makeChat([message('old', 'user', 'Original history'), message('latest', 'user', 'Continue')]);
  chat.contextCheckpoint = { version: 2, requestFacts: [], throughMessageId: 'old', summary: 'Earlier decisions and exact references. '.repeat(1500), capacityTokens: 131072 };
  const fixture = recorder();
  await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, summarize: fixture.summarize, force: true });
  const excerpts = fixture.requests.flatMap(request => request.packet.excerpts).filter(item => item.role === 'checkpoint');
  assert.ok(excerpts.length > 1);
  assert.equal(excerpts.map(item => item.text).join(''), chat.contextCheckpoint.summary);
});

test('an oversized latest request fails actionably without changing or summarizing it', async () => {
  const chat = makeChat([message('old', 'assistant', 'Earlier answer'), message('latest', 'user', 'Keep every character '.repeat(2000))]);
  const original = structuredClone(chat);
  let called = false;
  await assert.rejects(compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, summarize: async () => { called = true; return ''; } }), error => error.contextOverflow === true && /latest request was preserved in full/.test(error.message));
  assert.equal(called, false);
  assert.deepEqual(chat, original);
});

test('system and tool overhead are included while summary calls exclude tool schemas', async () => {
  const chat = makeChat([message('old', 'user', 'Earlier task'), message('latest', 'user', 'Current task')]);
  const original = structuredClone(chat);
  await assert.rejects(compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate: (messages, toolsEnabled = true) => estimate(messages, false) + (toolsEnabled ? 4000 : 0), summarize: async () => 'summary' }), error => error.contextOverflow && /reduce enabled tools/.test(error.message));
  assert.deepEqual(chat, original);
  const fixture = recorder();
  await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, summarize: fixture.summarize, force: true });
  assert.equal(fixture.requests.length, 1);
});

test('cancellation after an awaited summary never publishes a partial checkpoint', async () => {
  const chat = makeChat([message('old', 'user', 'Earlier data '.repeat(3000)), message('latest', 'user', 'Continue')]);
  chat.contextCheckpoint = { throughMessageId: 'old', summary: 'Previous checkpoint.' };
  const original = structuredClone(chat), controller = new AbortController();
  let calls = 0;
  await assert.rejects(compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, signal: controller.signal, force: true, summarize: async () => { calls++; controller.abort(new Error('Fixture canceled')); return 'A completed summary arrives after Stop.'; } }), /Fixture canceled/);
  assert.equal(calls, 1);
  assert.deepEqual(chat, original);
});

test('failure after one successful chunk leaves the old checkpoint and transcript untouched', async () => {
  const chat = makeChat([message('old', 'user', 'Earlier data '.repeat(5000)), message('latest', 'user', 'Continue')]);
  const original = structuredClone(chat);
  let calls = 0;
  const fixture = recorder(4096, () => { if (++calls === 2) throw new Error('Provider disconnected'); return 'First chunk summarized with its goal, constraints and pending work.'; });
  await assert.rejects(compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, summarize: fixture.summarize }), /Provider disconnected/);
  assert.equal(calls, 2);
  assert.deepEqual(chat, original);
});

test('empty or oversized generated summaries fail without truncating or saving them', async () => {
  for (const response of ['   ', 'Excessive summary '.repeat(1000)]) {
    const chat = makeChat([message('old', 'assistant', 'Earlier answer'), message('latest', 'user', 'Continue')]);
    const original = structuredClone(chat);
    const fixture = recorder(4096, () => response);
    await assert.rejects(compactContext({ chat, messages: raw(chat), capacityTokens: 4096, estimate, summarize: fixture.summarize }), /substantive summary|longer than its requested budget/);
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(chat, original);
  }
});

test('bounded summary budget override permits one smaller recovery attempt', async () => {
  const chat = makeChat([message('old', 'assistant', 'Earlier answer'), message('latest', 'user', 'Continue')]);
  const fixture = recorder();
  await compactContext({ chat, messages: raw(chat), capacityTokens: 4096, summaryBudgetTokens: 128, estimate, summarize: fixture.summarize, force: true });
  assert.ok(fixture.requests.every(request => request.budget === 128));
});

test('a conservative summary capacity chunks unknown-capacity history without shrinking latest-request feasibility', async () => {
  const chat = makeChat([message('old', 'assistant', 'Archive from an unknown-capacity provider '.repeat(2000)), message('latest', 'user', 'Latest request stays complete '.repeat(250))]);
  const original = structuredClone(chat), fixture = recorder(4096);
  const checkpoint = await compactContext({ chat, messages: raw(chat), capacityTokens: 32768, summaryCapacityTokens: 4096, estimate, summarize: fixture.summarize, force: true });
  assert.ok(fixture.requests.length > 2);
  assert.ok(fixture.requests.every(request => request.budget <= Math.floor(4096 * 0.12)));
  assert.equal(workingMessages({ ...chat, contextCheckpoint: checkpoint }, raw(chat))[1].content, chat.messages[1].content);
  assert.equal(checkpoint.capacityTokens, 32768);
  assert.deepEqual(chat, original);
});
