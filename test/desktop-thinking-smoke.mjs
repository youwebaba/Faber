import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runThinkingSmoke({ window, runtime, chat, dataDir }) {
  const screenshots = {}, calls = [], replacements = [];
  let showReasoning, showText, correctText, finishText, finishSummary, summaryAttempts = 0;
  const unsubscribe = runtime.subscribe(event => { if (event.type === 'delta' && event.replace) replacements.push(event); });
  const message = (text, id = 'msg_fixture') => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
    if (calls.length === 2) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'This model maximum context length is 32000 tokens. The fixture requested 34000 tokens.' } })); return; }
    if (body.max_output_tokens && ++summaryAttempts === 1) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Synthetic first summary failure.' } })); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
    const frame = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const done = text => { frame({ type: 'response.completed', response: { id: `response_${calls.length}`, status: 'completed', output: [message(text)], usage: { input_tokens: 120, output_tokens: 12, output_tokens_details: { reasoning_tokens: 8 } } } }); response.end(); };
    if (calls.length === 1) {
      showReasoning = () => frame({ type: 'response.reasoning_summary_text.delta', output_index: 1, item_id: 'rs_fixture', summary_index: 0, delta: 'Reviewing the fixture request.' });
      showText = () => frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_fixture', delta: 'Partial draft' });
      correctText = () => frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'msg_fixture', text: 'Canonical answer.' });
      finishText = () => { done('Canonical answer.'); finishText = undefined; }; return;
    }
    if (body.max_output_tokens) { finishSummary = () => { done('The user requested a controlled fixture reply. The assistant completed it as Canonical answer. Continue the latest pending request without repeating completed actions.'); finishSummary = undefined; }; return; }
    done('Continued after compacting earlier context.');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const js = code => window.webContents.executeJavaScript(code), state = () => runtime.request('state.get');
  async function wait(predicate, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await predicate(); if (value) return value; await pause(60); } throw new Error(`Thinking smoke timeout: ${label}; ${await js('document.body.innerText')}`); }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const send = text => js(`(()=>{const prompt=document.querySelector('#prompt');prompt.value=${JSON.stringify(text)};prompt.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#composer').requestSubmit()})()`);
  async function capture(name) { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(80); const file = path.join(dataDir, `${name}.png`); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots[name] = file; }
  try {
    window.setSize(1200, 850);
    await wait(() => js(`!!document.querySelector('[data-chat-id="${chat.id}"]')`), 'fixture chat'); await click(`[data-chat-id="${chat.id}"]`);
    const provider = await runtime.request('provider.save', { name: 'Thinking protocol fixture', kind: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'thinking-fixture' });
    await runtime.request('chat.update', { id: chat.id, providerId: provider.id, model: 'thinking-fixture' });
    await send('THINKING_FIXTURE'); await wait(() => typeof showReasoning === 'function', 'held provider request');
    await wait(() => js(`document.querySelector('.run-activity-label')?.textContent==='Thinking…' && document.querySelector('#activity-content .model-progress')?.textContent==='Thinking…'`), 'chat and activity waiting label');
    assert.equal(await js(`document.querySelector('.run-activity-label').title`), 'Awaiting the model response.');
    assert.equal(await js(`document.querySelectorAll('.streaming').length`), 0);
    window.webContents.debugger.attach('1.3');
    try {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await wait(() => js(`document.querySelector('.thinking-pulse').getAnimations().some(animation=>animation.playState==='running')`), 'visible waiting pulse');
      await capture('thinking-waiting');
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await js(`getComputedStyle(document.querySelector('.thinking-pulse')).animationName`), 'none');
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    } finally { window.webContents.debugger.detach(); }
    showReasoning(); await wait(() => js(`document.querySelector('.run-activity-label')?.textContent==='Reviewing the fixture request.'`), 'provider progress summary');
    assert.equal(await js(`document.querySelectorAll('.streaming').length`), 0);
    showText(); await wait(() => js(`document.querySelector('.streaming .message-content')?.textContent==='Partial draft'`), 'partial visible text');
    await wait(() => js(`document.querySelector('#token-rate').title.includes('First visible token:')`), 'time to first visible token');
    correctText(); await wait(() => js(`document.querySelector('.streaming .message-content')?.textContent==='Canonical answer.'`), 'canonical replacement while streaming');
    assert.ok(replacements.some(event => event.text === 'Canonical answer.'));
    finishText(); await wait(async () => (await state()).runs.some(run => run.chatId === chat.id && run.status === 'completed'), 'first completion');
    await wait(() => js(`!document.querySelector('.streaming') && document.querySelector('#transcript').textContent.includes('Canonical answer.')`), 'saved canonical text');
    assert.equal(await js(`document.querySelector('#transcript').textContent.includes('Partial draft')`), false);
    assert.match(await js(`document.querySelector('#token-rate').textContent`), /tok\/s avg/);
    assert.match(await js(`document.querySelector('#token-rate').title`), /Total output average.*reasoning tokens.*First visible token:/);
    await send('CONTINUE_FIXTURE');
    const failed = await wait(async () => (await state()).runs.findLast(run => run.chatId === chat.id && run.status === 'failed' && run.contextOverflow && run.modelCalls.some(call => call.purpose === 'compaction')), 'context overflow and failed automatic summary');
    await wait(() => js(`document.querySelector('.run-note button')?.textContent==='Compact & continue'`), 'compact action');
    const before = (await state()).chats.find(item => item.id === chat.id).messages;
    await click('.run-note button'); await wait(() => typeof finishSummary === 'function', 'held summary request');
    await wait(() => js(`[...document.querySelectorAll('.run-activity-label')].some(node=>node.textContent==='Condensing earlier context…') && document.querySelector('#activity-content .model-progress')?.textContent==='Condensing earlier context…'`), 'compaction progress');
    assert.equal(await js(`document.querySelectorAll('.streaming').length`), 0); await capture('thinking-compacting');
    finishSummary();
    const complete = await wait(async () => { const next = await state(), run = next.runs.findLast(run => run.chatId === chat.id); return run.id !== failed.id && run.status === 'completed' ? next : null; }, 'resumed completion');
    const after = complete.chats.find(item => item.id === chat.id);
    assert.deepEqual(after.messages.slice(0, before.length), before, 'Compaction must preserve the original visible transcript');
    assert.equal(after.messages.filter(item => item.role === 'user').length, before.filter(item => item.role === 'user').length, 'Compaction must not insert a Continue user message');
    assert.ok(after.contextCheckpoint); assert.equal(after.messages.at(-1).content, 'Continued after compacting earlier context.');
    await wait(() => js(`document.querySelector('#token-usage').textContent.includes('Context summary')`), 'separate summary usage');
    await capture('thinking-completed');
    const report = { ok: true, realRenderer: true, loopbackOnly: true, thinkingPulse: true, reducedMotion: true, reportedProgress: true, canonicalReplacement: true, visibleTokenTiming: true, totalOutputAverageLabel: true, compactContinue: true, visibleTranscriptPreserved: true, noContinueMessage: true, paidCalls: 0, screenshots };
    const reportPath = path.join(dataDir, 'thinking-smoke-report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); return { ...report, reportPath };
  } finally {
    unsubscribe();
    await runtime.request('chat.forceStop', { chatId: chat.id }).catch(() => {});
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
