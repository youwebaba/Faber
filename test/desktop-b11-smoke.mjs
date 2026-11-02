import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runB11Smoke({ window, runtime, chat, dataDir }) {
  const calls = [], errors = [], screenshots = {}, held = new Set(); let finishStream;
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/api/chat'); assert.equal(request.method, 'POST');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
      const prompt = body.messages.findLast(item => item.role === 'user')?.content || '';
      const tools = body.messages.filter(item => item.role === 'tool');
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const frame = value => response.write(`${JSON.stringify({ model: 'b11-fixture', ...value })}\n`);
      const tool = (name, args) => { frame({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: true, prompt_eval_count: 100, eval_count: 10, eval_duration: 1000000000 }); response.end(); };
      if (prompt.includes('B11_TOOL_STREAM')) {
        if (!tools.some(item => item.tool_name === 'shell_run')) { tool('shell_run', { command: "Write-Output 'b11-command-result'" }); return; }
        frame({ message: { role: 'assistant', content: 'The controlled command completed. ' }, done: false });
        finishStream = () => { frame({ message: { role: 'assistant', content: 'Ready for your next step.' }, done: true, prompt_eval_count: 120, eval_count: 12, eval_duration: 2000000000 }); response.end(); finishStream = undefined; };
        return;
      }
      if (prompt.includes('B11_HANG_PARENT') && !tools.some(item => item.tool_name === 'agent_create')) { tool('agent_create', { task: 'B11_HANG_CHILD', title: 'Loop fixture child' }); return; }
      if (/B11_HANG_/.test(prompt)) { frame({ message: { role: 'assistant', content: 'Controlled waiting stream. ' }, done: false }); held.add(response); response.once('close', () => held.delete(response)); return; }
      frame({ message: { role: 'assistant', content: 'Controlled fixture response.' }, done: true, prompt_eval_count: 30, eval_count: 5, eval_duration: 1000000000 }); response.end();
    } catch (error) { errors.push(error.message); if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalRequest = runtime.request, pendingMutations = new Map();
  runtime.request = async (method, params) => {
    const tracked = ['chat.archive', 'chat.move', 'chat.delete', 'chat.forceStop', 'project.archive', 'project.delete'].includes(method);
    if (tracked) pendingMutations.set(method, (pendingMutations.get(method) || 0) + 1);
    try { return await originalRequest.call(runtime, method, params); }
    finally { if (tracked) { const remaining = pendingMutations.get(method) - 1; remaining ? pendingMutations.set(method, remaining) : pendingMutations.delete(method); } }
  };
  const js = code => window.webContents.executeJavaScript(code), state = () => runtime.request('state.get');
  async function wait(test, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await test(); if (result) return result; await pause(60); } throw new Error(`b1.1 smoke timeout: ${label}; ${await js('document.body.innerText')}`); }
  const click = selector => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing ${selector}');e.click()})()`);
  const key = async value => {
    // CDP targets this hidden fixture page; OS keyboard focus stays with the user.
    if (!window.webContents.debugger.isAttached()) { window.webContents.debugger.attach('1.3'); await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); }
    const key = value === 'Return' ? 'Enter' : value, code = key, windowsVirtualKeyCode = key === 'Enter' ? 13 : 27;
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  const set = (selector, value) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const select = id => click(`[data-chat-id="${id}"]`);
  async function context(kind, id, keyboard = false) {
    await wait(() => js(`!!document.querySelector('[data-${kind}-id="${id}"]')`), 'context target');
    await js(`(()=>{const e=document.querySelector('[data-${kind}-id="${id}"]');e.focus();e.dispatchEvent(${keyboard ? "new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true})" : "new MouseEvent('contextmenu',{clientX:140,clientY:210,bubbles:true,cancelable:true})"});})()`);
    await wait(() => js(`!document.querySelector('#chat-context-menu').hidden`), 'context menu');
  }
  async function capture(name) { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(100); const file = path.join(dataDir, `${name}.png`); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots[name] = file; }
  async function project(name) { const directory = path.join(dataDir, name); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'keep.txt'), 'Workspace file must remain'); return runtime.request('project.create', { name, path: directory }); }
  try {
    window.setSize(1100, 760);
    const provider = await runtime.request('provider.save', { name: 'b1.1 local fixture', kind: 'ollama', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'b11-fixture' });
    await runtime.request('chat.update', { id: chat.id, providerId: provider.id, model: 'b11-fixture' });
    await wait(() => js(`!!document.querySelector('[data-chat-id="${chat.id}"]')`), 'initial chat'); await select(chat.id);
    for (const theme of ['light', 'dark']) {
      await runtime.request('settings.update', { theme });
      await wait(() => js(`document.documentElement.dataset.theme==='${theme}' && document.querySelector('.faber-symbol').naturalWidth===427 && document.querySelector('.welcome-wordmark').naturalWidth===2172`), `supplied branding in ${theme} theme`);
      await capture(`b11-brand-${theme}`);
    }
    await wait(() => js(`!document.querySelector('#context-window').disabled && !document.querySelector('#thinking-toggle').disabled`), 'chat controls');
    await click('#context-window'); await set('#context-token-input', '8192'); await click('#apply-context-window');
    await wait(async () => (await state()).chats.find(item => item.id === chat.id).contextTokens === 8192, 'context saved');
    await wait(() => js(`!document.querySelector('#thinking-toggle').disabled`), 'thinking ready'); await click('#thinking-toggle');
    await wait(async () => (await state()).chats.find(item => item.id === chat.id).thinking === true, 'thinking on');
    await set('#prompt', 'B11_TOOL_STREAM'); await js(`document.querySelector('#composer').requestSubmit()`);
    const approval = await wait(async () => (await state()).approvals.find(item => item.chatId === chat.id), 'shell approval');
    await wait(() => js(`!!document.querySelector('.run-activity[data-run-id="${approval.runId}"]')`), 'inline activity');
    await js(`document.querySelector('.run-activity[data-run-id="${approval.runId}"]>summary').focus()`); await key('Return');
    await wait(() => js(`document.querySelector('.run-activity[open]')?.innerText.includes('shell_run')`), 'inline command');
    await js(`document.querySelector('.run-activity[open] .run-activity-tool>summary').focus()`); await key('Return');
    await wait(() => js(`!!document.querySelector('.run-activity[open] .run-activity-tool[open]')`), 'keyboard command disclosure');
    assert.match(await js(`document.querySelector('.run-activity[open]').innerText`), /b11-command-result/);
    await capture('b11-command-approval');
    await js(`[...document.querySelectorAll('.activity-pending-approval button')].find(e=>e.textContent==='Allow this run').click()`);
    await wait(() => typeof finishStream === 'function', 'held final stream');
    await wait(() => js(`document.querySelector('#context-usage').textContent.includes('8192') || document.querySelector('#context-usage').textContent.includes('8,192')`), 'live context count');
    await wait(() => js(`!document.querySelector('#token-rate').textContent.startsWith('—')`), 'live TPS'); await capture('b11-live-context');
    assert.equal(calls[0].options.num_ctx, 8192); assert.equal(calls[0].think, true);
    finishStream();
    const completed = await wait(async () => (await state()).runs.find(item => item.id === approval.runId && item.status === 'completed'), 'completed run');
    assert.equal(completed.modelCalls.at(-1).metrics.tokensPerSecond, 6);
    await wait(() => js(`document.querySelector('#token-rate').textContent==='6.0 tok/s'`), 'provider TPS');
    assert.match(await js(`document.querySelector('.run-activity[data-run-id="${approval.runId}"]').innerText`), /b11-command-result/);
    await capture('b11-completed-activity');

    const other = await runtime.request('chat.create', { projectId: chat.projectId, title: 'Unrelated live chat' });
    await runtime.request('chat.update', { id: other.id, providerId: provider.id, model: 'b11-fixture' });
    const otherRun = await runtime.request('chat.send', { chatId: other.id, text: 'B11_HANG_OTHER' });
    await select(chat.id); await set('#prompt', 'B11_HANG_PARENT'); await js(`document.querySelector('#composer').requestSubmit()`);
    const parent = await wait(async () => (await state()).runs.findLast(item => item.chatId === chat.id && item.status === 'running'), 'parent run');
    const child = await wait(async () => (await state()).runs.find(item => item.parentRunId === parent.id && item.status === 'running'), 'child run');
    await context('chat', chat.id, true); await capture('b11-chat-menu'); await click('#chat-context-menu [data-action="forceStop"]');
    await wait(async () => (await state()).runs.filter(item => [parent.id, child.id].includes(item.id)).every(item => item.status === 'canceled'), 'force stop parent and child');
    await wait(() => !pendingMutations.has('chat.forceStop'), 'force stop settled');
    assert.equal((await state()).runs.find(item => item.id === otherRun.runId).status, 'running'); await runtime.request('chat.forceStop', { chatId: other.id });

    const destination = await project('Move destination');
    await context('chat', chat.id); await click('#chat-context-menu [data-action="move"]'); await set('#move-project', destination.id); await click('#confirm-move-chat');
    await wait(async () => (await state()).chats.find(item => item.id === chat.id).projectId === destination.id, 'move existing');
    await wait(() => !pendingMutations.has('chat.move'), 'existing move settled');
    assert.equal((await state()).chats.find(item => item.id === child.chatId).projectId, destination.id);
    await context('chat', chat.id); await click('#chat-context-menu [data-action="move"]'); await set('#move-project', '__new__'); await set('#move-project-name', 'Created by move');
    const newFolder = path.join(dataDir, 'new-project-folder'); await fs.mkdir(newFolder); await set('#move-project-path', newFolder); await click('#confirm-move-chat');
    const moved = await wait(async () => (await state()).projects.find(item => item.name === 'Created by move'), 'new destination project');
    await wait(async () => (await state()).chats.find(item => item.id === chat.id).projectId === moved.id, 'move new');
    await wait(() => !pendingMutations.has('chat.move'), 'new move settled');

    const disposable = await runtime.request('chat.create', { projectId: chat.projectId, title: 'Delete this fixture chat' });
    await context('chat', disposable.id, true); await key('Escape');
    await wait(() => js(`document.querySelector('#chat-context-menu').hidden && document.activeElement.dataset.chatId==='${disposable.id}'`), 'Escape restores chat focus');
    await context('chat', disposable.id);
    await js(`document.querySelector('#prompt').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    assert.equal(await js(`document.querySelector('#chat-context-menu').hidden`), true);
    await context('chat', disposable.id); await click('#chat-context-menu [data-action="delete"]');
    assert.equal(await js(`document.querySelector('#delete-warning').textContent`), 'Are you sure you want to delete this chat? Deleted chats are not recoverable!');
    assert.equal(await js(`document.activeElement.id`), 'cancel-delete'); await key('Escape');
    await wait(() => js(`!document.querySelector('#modal').open && document.activeElement.dataset.chatId==='${disposable.id}'`), 'Escape cancels delete and restores focus'); assert.ok((await state()).chats.some(item => item.id === disposable.id));
    await context('chat', disposable.id); await click('#chat-context-menu [data-action="delete"]'); await click('#cancel-delete'); assert.ok((await state()).chats.some(item => item.id === disposable.id));
    await context('chat', disposable.id); await click('#chat-context-menu [data-action="delete"]'); await capture('b11-delete-confirmation');
    await select(other.id); await click('#confirm-delete'); await wait(async () => !(await state()).chats.some(item => item.id === disposable.id), 'chat delete'); assert.ok((await state()).chats.some(item => item.id === other.id));

    const archivedChat = await runtime.request('chat.create', { projectId: destination.id, title: 'Archive this chat' });
    await context('chat', archivedChat.id); await click('#chat-context-menu [data-action="archive"]');
    await wait(async () => (await state()).chats.find(item => item.id === archivedChat.id).archived, 'chat archive');
    await wait(() => !pendingMutations.has('chat.archive'), 'chat archive settled');
    await context('project', destination.id, true); await click('#chat-context-menu [data-action="archive"]');
    await wait(async () => (await state()).projects.find(item => item.id === destination.id).archived, 'project archive');
    await wait(() => !pendingMutations.has('project.archive'), 'project archive settled');
    await wait(() => js(`!document.querySelector('[data-project-id="${destination.id}"]')`), 'archived project hidden');
    const removedProject = await project('Delete project fixture'); await runtime.request('chat.create', { projectId: removedProject.id });
    await context('project', removedProject.id); await click('#chat-context-menu [data-action="delete"]');
    assert.equal(await js(`document.querySelector('#delete-warning').textContent`), 'Are you sure you want to delete this project? Deleted chats are not recoverable!');
    assert.equal(await js(`document.activeElement.id`), 'cancel-delete');
    await click('#cancel-delete'); assert.ok((await state()).projects.some(item => item.id === removedProject.id));
    await context('project', removedProject.id); await click('#chat-context-menu [data-action="delete"]'); await click('#confirm-delete');
    await wait(async () => !(await state()).projects.some(item => item.id === removedProject.id), 'project delete');
    assert.equal(await fs.readFile(path.join(removedProject.path, 'keep.txt'), 'utf8'), 'Workspace file must remain');

    await select(chat.id); await set('#prompt', 'Private draft survives b1.1 UI refresh');
    await js(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['private draft attachment'],'draft.txt',{type:'text/plain'}));const input=document.querySelector('#file-picker');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(() => js(`document.querySelectorAll('#image-drafts .image-draft').length===1 && !document.querySelector('#image-draft-status').textContent.includes('Reading')`), 'draft attachment');
    await click('#open-settings'); await wait(() => js(`!!document.querySelector('#reload-ui') && document.querySelector('.about-wordmark').naturalWidth===2172`), 'refresh action and About wordmark');
    await js(`document.querySelector('.about-wordmark').scrollIntoView()`); await capture('b11-about-brand'); await pause(100); await click('#reload-ui');
    await wait(() => js(`document.documentElement.dataset.uiReady==='true' && document.querySelector('#notice-text').textContent.includes('drafts are restored')`).catch(() => false), 'draft reload', 20000);
    assert.equal(await js(`document.querySelector('#prompt').value`), 'Private draft survives b1.1 UI refresh'); assert.equal(await js(`document.querySelectorAll('#image-drafts .image-draft').length`), 1);
    assert.ok(!(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')).includes('Private draft survives'));
    await capture('b11-restored-draft'); assert.deepEqual(errors, []);
    const report = { ok: true, realRenderer: true, loopbackProviderOnly: true, suppliedBrandingDarkAndLight: true, contextAndThinkingWire: true, liveAndReportedTPS: true, inlineActivityAndApproval: true, keyboardDisclosureAndFocusRestore: true, scopedForceStop: true, moveExistingAndNewProject: true, archiveChatAndProject: true, deletionCancelAndExactTargetConfirmation: true, workspaceFilesPreserved: true, draftReload: true, paidCalls: 0, screenshots };
    const reportPath = path.join(dataDir, 'b11-smoke-report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); return { ...report, reportPath };
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    finishStream?.(); for (const response of held) response.destroy();
    const snapshot = await state(); for (const item of snapshot.chats) if (snapshot.runs.some(run => run.chatId === item.id && ['running', 'waiting_approval'].includes(run.status))) await runtime.request('chat.forceStop', { chatId: item.id }).catch(() => {});
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    runtime.request = originalRequest;
  }
}
