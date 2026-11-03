import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runB12Smoke({ window, runtime, chat, dataDir, localModels, fixture }) {
  const screenshots = {}, calls = []; let secondTool, appendFinal, finishFinal;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
    const index = body.messages.findLastIndex(item => item.role === 'user'), prompt = body.messages[index]?.content || '', tools = body.messages.slice(index).filter(item => item.role === 'tool');
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const frame = data => response.write(`${JSON.stringify({ model: 'timeline-fixture', ...data })}\n`);
    const tool = (name, args, content = '') => { frame({ message: { role: 'assistant', content, tool_calls: [{ function: { name, arguments: args } }] }, done: true }); response.end(); };
    const done = content => { frame({ message: { role: 'assistant', content }, done: true }); response.end(); };
    if (prompt === 'B12_TIMELINE') {
      if (!tools.length) { tool('shell_run', { command: "Write-Output 'first result'" }, 'First, I will run the first command.'); return; }
      if (tools.length === 1) {
        frame({ message: { role: 'assistant', content: 'The first command finished. Now the second command.' }, done: false });
        secondTool = () => { tool('shell_run', { command: "Write-Output 'second result'" }); secondTool = undefined; }; return;
      }
      frame({ message: { role: 'assistant', content: `Both commands finished.\n${'A controlled result line.\n'.repeat(45)}` }, done: false });
      appendFinal = () => frame({ message: { role: 'assistant', content: '\nA later streamed chunk.' }, done: false });
      finishFinal = () => { done('\nFinal response complete.'); finishFinal = undefined; }; return;
    }
    if (prompt === 'B12_CHILD') { if (!tools.length) tool('agent_create', { task: 'B12_CHILD_TASK', title: 'Chronology child' }, 'Starting a child to read the fixture.'); else done('Child dispatched.'); return; }
    if (prompt === 'B12_CHILD_TASK') { if (!tools.length) tool('files_read', { path: 'hello.txt' }, 'Reading the child fixture.'); else done('Child read completed.'); return; }
    done('Continuation response.');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const js = code => window.webContents.executeJavaScript(code), state = () => runtime.request('state.get');
  async function wait(predicate, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await predicate(); if (result) return result; await pause(60); } throw new Error(`b1.2 smoke timeout: ${label}; ${await js('document.body.innerText')}`); }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (selector, value) => js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const send = async text => { await change('#prompt', text); await js(`document.querySelector('#composer').requestSubmit()`); };
  async function capture(name) { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(80); const file = path.join(dataDir, `${name}.png`); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots[name] = file; }
  const transcriptOrder = () => js(`[...document.querySelector('#transcript').children].map(node=>node.dataset.activityId?'activity:'+node.dataset.activityId:node.classList.contains('streaming')?'stream':node.dataset.messageId).filter(Boolean)`);
  try {
    window.setSize(1200, 850);
    await fs.copyFile(path.join(fixture.directory, 'Fixture-Q4_K_M.gguf'), path.join(fixture.directory, 'Qwen3.5-9B-Q4_K_M.gguf'));
    const library = await localModels.request('localModels.list'), model = library.models.find(item => item.relativePath === 'Qwen3.5-9B-Q4_K_M.gguf'); assert.ok(model?.available);
    await wait(() => js(`!!document.querySelector('[data-chat-id="${chat.id}"]')`), 'chat'); await click(`[data-chat-id="${chat.id}"]`);
    await click('#model-picker'); await change('#chat-connection', '__local_files__');
    await wait(() => js(`!!document.querySelector('#chat-local-model option[value="download:${model.id}"]')`), 'scanned model'); await change('#chat-local-model', `download:${model.id}`);
    await wait(() => js(`!document.querySelector('#local-model-start').disabled`), 'Start'); await click('#local-model-start');
    const ready = await wait(async () => { const value = (await localModels.request('localModels.list')).process; return value.status === 'ready' ? value : null; }, 'managed ready');
    await wait(() => js(`!document.querySelector('#chat-use-model').disabled`), 'Use'); await click('#chat-use-model');
    await wait(() => js(`document.querySelector('#model-label').textContent.includes('Qwen3.5-9B-Q4_K_M') && !document.querySelector('#modal').open`), 'friendly composer name');
    assert.equal((await state()).chats.find(item => item.id === chat.id).model, ready.model); assert.match(ready.model, /^faber-/);
    await capture('b12-friendly-model'); await localModels.request('localModels.stop');
    await wait(() => js(`document.querySelector('#model-label').textContent.includes('Qwen3.5-9B-Q4_K_M')`), 'friendly name after Stop');
    await click('#model-picker'); await wait(() => js(`document.querySelector('#chat-local-model').selectedOptions[0]?.textContent.includes('Qwen3.5-9B-Q4_K_M')`), 'friendly picker selection'); await capture('b12-model-picker'); await click('#close-modal');

    const provider = await runtime.request('provider.save', { name: 'Chronology fixture', kind: 'ollama', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'timeline-fixture' });
    await runtime.request('chat.update', { id: chat.id, providerId: provider.id, model: 'timeline-fixture' });
    await wait(() => js(`document.querySelector('#model-label').textContent==='timeline-fixture'`), 'API identity label');
    await send('B12_TIMELINE');
    const approval = await wait(async () => (await state()).approvals.find(item => item.chatId === chat.id), 'approval');
    await wait(() => js(`!!document.querySelector('.run-activity[data-run-id="${approval.runId}"]')`), 'live activity');
    await click(`.run-activity[data-run-id="${approval.runId}"]>summary`);
    await wait(() => js(`!!document.querySelector('.run-activity[open] .activity-pending-approval')`), 'inline approval');
    await js(`window.__b12Card=document.querySelector('.run-activity[open]');window.__b12Tool=window.__b12Card.querySelector('.run-activity-tool');window.__b12Tool.open=true`);
    await js(`[...document.querySelectorAll('.activity-pending-approval button')].find(node=>node.textContent==='Allow this run').click()`);
    await wait(() => typeof secondTool === 'function', 'second response stream');
    await wait(() => js(`document.querySelector('.streaming')?.textContent.includes('The first command finished')`), 'stream after first activity');
    let order = await transcriptOrder(); assert.ok(order.indexOf(`activity:${approval.runId}:step:0`) < order.indexOf('stream'));
    secondTool(); await wait(() => typeof finishFinal === 'function', 'final held response');
    await wait(() => js(`document.querySelectorAll('.run-activity[data-run-id="${approval.runId}"]').length===2 && document.querySelector('.streaming')?.textContent.includes('Both commands finished')`), 'second activity interleaved');
    const snapshot = await state(), messages = snapshot.chats.find(item => item.id === chat.id).messages;
    const first = messages.find(message => message.content?.includes('First, I will')), middle = messages.find(message => message.content?.includes('The first command finished'));
    order = await transcriptOrder(); assert.deepEqual(order.slice(1), [first.id, `activity:${approval.runId}:step:0`, middle.id, `activity:${approval.runId}:step:1`, 'stream']);
    assert.equal(await js(`window.__b12Card===document.querySelector('.run-activity') && window.__b12Card.open && window.__b12Tool===document.querySelector('.run-activity-tool') && window.__b12Tool.open`), true);
    assert.equal(await js(`document.querySelectorAll('#transcript>.tool-message').length`), 0);
    await js(`document.querySelector('#transcript').scrollTop=0`); const before = await js(`document.querySelector('#transcript').scrollTop`); appendFinal();
    await wait(() => js(`document.querySelector('.streaming').textContent.includes('A later streamed chunk')`), 'later delta');
    assert.equal(await js(`document.querySelector('#transcript').scrollTop`), before); await capture('b12-chronological-live');
    await js(`window.__b12Card.open=false;document.querySelector('#transcript').scrollTop=0`); await capture('b12-chronology-overview');
    await js(`(()=>{const node=document.querySelector('#transcript');node.scrollTop=(node.scrollHeight-node.clientHeight)/2})()`);
    const middleScroll = await js(`document.querySelector('#transcript').scrollTop`); appendFinal();
    await wait(() => js(`document.querySelector('.streaming').textContent.split('A later streamed chunk').length===3`), 'middle reader delta');
    assert.equal(await js(`document.querySelector('#transcript').scrollTop`), middleScroll);
    finishFinal(); await wait(async () => (await state()).runs.find(run => run.id === approval.runId)?.status === 'completed', 'completion');
    await wait(() => js(`!document.querySelector('.streaming')`), 'stream replaced exactly once');
    const terminal = await transcriptOrder(); assert.equal(terminal.filter(id => id.startsWith('activity:')).length, 2); assert.ok(terminal.indexOf(`activity:${approval.runId}:step:1`) < terminal.length - 1);
    await send('B12_CONTINUE'); await wait(async () => (await state()).chats.find(item => item.id === chat.id).messages.some(message => message.content === 'Continuation response.'), 'continuation reply');
    await wait(async () => (await state()).runs.filter(run => run.chatId === chat.id).every(run => run.status === 'completed'), 'continuation complete');
    assert.deepEqual((await transcriptOrder()).slice(0, terminal.length), terminal);

    await send('B12_CHILD');
    const child = await wait(async () => (await state()).runs.find(run => run.parentRunId && run.status === 'completed'), 'child completed');
    await wait(async () => (await state()).runs.find(run => run.id === child.parentRunId)?.status === 'completed', 'parent completed');
    await wait(() => js(`!!document.querySelector('.run-activity [data-agent-run-id="${child.id}"]')`), 'child inline branch');
    await capture('b12-chronological-completed');
    const preReload = await transcriptOrder();
    await click('#open-settings'); await click('#reload-ui');
    await wait(() => js(`document.documentElement.dataset.uiReady==='true' && document.querySelector('#notice-text').textContent.includes('drafts are restored')`).catch(() => false), 'UI reload');
    assert.deepEqual(await transcriptOrder(), preReload); await capture('b12-chronology-after-refresh');
    const report = { ok: true, realRenderer: true, loopbackOnly: true, scannedFriendlyName: true, aliasUnchanged: true, friendlyNameAfterStop: true, perStepChronology: true, liveApproval: true, stableDisclosures: true, readerScrollPreserved: true, noDuplicateToolCards: true, continuationAndChildRuns: true, chronologyAfterRefresh: true, paidCalls: 0, screenshots };
    const reportPath = path.join(dataDir, 'b12-smoke-report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); return { ...report, reportPath };
  } finally {
    secondTool?.(); finishFinal?.();
    const remaining = await state();
    for (const item of remaining.chats.filter(chat => remaining.runs.some(run => run.chatId === chat.id && ['running', 'waiting_approval'].includes(run.status)))) await runtime.request('chat.forceStop', { chatId: item.id }).catch(() => {});
    if (['loading', 'ready', 'stopping'].includes((await localModels.request('localModels.list')).process.status)) await localModels.request('localModels.stop').catch(() => {});
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
