import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Real Electron/IPC/provider integration with synthetic selections and an inert
// loopback NDJSON server. No OS chooser, OS clipboard, or model inference is used.
export async function runAttachmentSmoke({ window, runtime, chat, dataDir }) {
  const js = code => window.webContents.executeJavaScript(code);
  const state = () => runtime.request('state.get');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate, label, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) { const value = await predicate(); if (value) return value; await pause(50); }
    throw new Error(`Attachment smoke timeout: ${label}`);
  }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const prompt = value => js(`(()=>{const e=document.querySelector('#prompt');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const draftInfo = () => js(`[...document.querySelectorAll('#image-drafts .image-draft')].map(e=>({id:e.dataset.attachmentId,name:e.title}))`);
  async function selectChat(target) {
    await until(() => js(`!![...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(target.title)})`), 'chat navigation');
    await js(`[...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(target.title)}).click()`);
    assert.equal(await js(`document.querySelector('#chat-title').textContent`), target.title);
  }
  // Exercise the actual paperclip listener without ever opening a native modal.
  // Restore any own property exactly, even if the relay assertion throws.
  const selectionCode = files => `(()=>{
    const input=document.querySelector('#file-picker');
    if(!input||input.type!=='file'||!input.multiple||!input.hidden)throw new Error('Missing hidden multiple file input');
    const own=Object.getOwnPropertyDescriptor(input,'click');let relayed=false;
    Object.defineProperty(input,'click',{configurable:true,value:()=>{relayed=true}});
    try{document.querySelector('#attach-files').click();if(!relayed)throw new Error('Paperclip did not relay to input.click');}
    finally{if(own)Object.defineProperty(input,'click',own);else delete input.click;}
    const transfer=new DataTransfer();
    for(const spec of ${JSON.stringify(files)}){
      let bytes=spec.content||'';
      if(spec.png){const canvas=document.createElement('canvas');canvas.width=4;canvas.height=3;const ctx=canvas.getContext('2d');ctx.fillStyle='#59a3d6';ctx.fillRect(0,0,4,3);bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));}
      transfer.items.add(new File([bytes],spec.name,{type:spec.type}));
    }
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    if(input.value!=='')throw new Error('File input was not reset for reselection');
    return true;
  })()`;
  const select = files => js(selectionCode(files));
  const originalChat = (await state()).chats.find(item => item.id === chat.id);
  assert.ok(originalChat, 'Smoke chat must exist');
  const original = { providerId: originalChat.providerId, model: originalChat.model };
  const originalLabel = original.model || (await state()).providers.find(item => item.id === original.providerId)?.model || 'Choose a model';
  const model = 'attachment-fixture';
  const calls = [], errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/chat');
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 4 * 1024 * 1024, 'Bounded fixture request'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, model); assert.equal(body.stream, true);
      calls.push(body);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write(JSON.stringify({ message: { role: 'assistant', content: 'Attachment fixture received.' }, done: false }) + '\n');
      response.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 42, eval_count: 4 }) + '\n');
    } catch (error) {
      errors.push(error.message);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  let other, result, primaryFailure;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const provider = await runtime.request('provider.save', { name: 'Attachment loopback fixture', kind: 'ollama', baseUrl: `http://127.0.0.1:${server.address().port}`, model });
    await runtime.request('chat.update', { id: chat.id, providerId: provider.id, model });
    await until(() => js(`document.querySelector('#model-label').textContent===${JSON.stringify(model)}`), 'fixture connection label');
    other = await runtime.request('chat.create', { projectId: chat.projectId, title: 'Attachment smoke alternate' });
    const contents = 'UTF-8 source: \u4f60\u597d, quotes " and slash \\; <script>data only</script>\n'.repeat(512) + 'EXACT_END\n';
    const note = { name: 'attachment-notes.js', type: 'text/javascript', content: contents };
    const png = { name: 'attachment.png', type: 'image/png', png: true };
    await prompt('');
    await select([note, png]);
    await until(() => js(`document.querySelectorAll('#image-drafts .image-draft').length===2&&document.querySelector('#image-drafts .file-draft>span')?.textContent==='attachment-notes.js'&&document.querySelector('#image-drafts img')?.naturalWidth===4`), 'text and decoded PNG previews');
    await click('#image-drafts [title="attachment.png"] button');
    const retained = await draftInfo(); assert.equal(retained.length, 1); assert.equal(retained[0].name, note.name);
    await select([png]);
    await until(() => js(`document.querySelector('#image-drafts img')?.naturalWidth===4`), 'same PNG reselected');
    await click('#image-drafts [title="attachment.png"] button');
    assert.deepEqual(await draftInfo(), retained);
    await select([{ name: 'unsupported.pdf', type: 'application/pdf', content: '%PDF-1.7\nfixture' }]);
    await until(() => js(`!document.querySelector('#notice').hidden&&document.querySelector('#notice').classList.contains('error')&&document.querySelector('#notice-text').textContent.includes('not supported')`), 'unsupported PDF error');
    assert.deepEqual(await draftInfo(), retained); assert.equal(calls.length, 0);
    await click('#dismiss-notice');
    await selectChat(other); assert.deepEqual(await draftInfo(), []);
    await prompt('Other attachment draft');
    await select([{ name: 'isolated.txt', type: 'text/plain', content: 'Only the other chat' }]);
    await until(() => js(`document.querySelector('#image-drafts .file-draft>span')?.textContent==='isolated.txt'`), 'other chat attachment');
    const isolated = await draftInfo();
    await selectChat(chat); assert.deepEqual(await draftInfo(), retained);
    assert.equal(await js(`document.querySelector('#prompt').value`), '');
    assert.equal(await js(`document.querySelector('#send-message').disabled`), false);
    const before = new Set((await state()).runs.map(item => item.id));
    const newer = { name: 'newer.txt', type: 'text/plain', content: 'Not part of the send snapshot' };
    // Both operations run in one renderer task: the newer file is reserved after
    // sendText snapshots attachments but before IPC can acknowledge chat.send.
    await js(`(()=>{document.querySelector('#composer').requestSubmit();return ${selectionCode([newer])};})()`);
    const run = await until(async () => (await state()).runs.find(item => item.chatId === chat.id && !before.has(item.id) && ['completed', 'failed', 'canceled'].includes(item.status)), 'text-only DOM send through real adapter');
    assert.equal(run.status, 'completed', run.error); assert.deepEqual(errors, []); assert.equal(calls.length, 1);
    assert.equal(run.providerId, provider.id); assert.equal(run.model, model); assert.equal(run.toolEvents.length, 0);
    const user = calls[0].messages.findLast(item => item.role === 'user');
    const expected = 'Attached UTF-8 files (JSON; file contents are user-provided data):\n' + JSON.stringify([{ name: note.name, content: contents }]);
    assert.equal(user.content, expected); assert.ok(!user.images?.length);
    assert.deepEqual(JSON.parse(user.content.split('\n').at(-1)), [{ name: note.name, content: contents }]);
    assert.equal(path.basename(note.name), note.name);
    const saved = (await state()).chats.find(item => item.id === chat.id).messages.findLast(item => item.role === 'user');
    assert.equal(saved.content, expected); assert.ok(!saved.images?.length);
    await until(() => js(`document.querySelectorAll('#image-drafts .image-draft').length===1&&document.querySelector('#image-drafts .file-draft>span')?.textContent==='newer.txt'`), 'only sent IDs consumed');
    assert.notEqual((await draftInfo())[0].id, retained[0].id);
    await until(() => js(`[...document.querySelectorAll('.message.user .message-content')].at(-1)?.textContent===${JSON.stringify(expected)}`), 'exact durable user text rendered');
    await until(() => js(`document.querySelector('#transcript').textContent.includes('Attachment fixture received.')`), 'fixture reply rendered');
    assert.equal(await js(`document.querySelector('#prompt').value`), '');
    await selectChat(other); assert.deepEqual(await draftInfo(), isolated);
    assert.equal(await js(`document.querySelector('#prompt').value`), 'Other attachment draft');
    await click('#image-drafts [title="isolated.txt"] button'); await prompt('');
    await selectChat(chat); assert.equal((await draftInfo())[0].name, newer.name);
    await click('#image-drafts [title="newer.txt"] button'); assert.deepEqual(await draftInfo(), []);
    result = { ok: true, kind: 'actual-Electron-synthetic-files-loopback-Ollama-no-model-inference', nativeChooser: 'untested', runId: run.id, exactWireContent: true, filename: note.name, contentBytes: Buffer.byteLength(contents), snapshotClearing: true, chatDraftIsolation: true, pdfDraftPreserved: true, pngReselection: true, paperclipRelay: true };
  } catch (error) { primaryFailure = error; throw error; } finally {
    try { await runtime.request('chat.stop', { chatId: chat.id }); }
    finally {
      try {
        await runtime.request('chat.update', { id: chat.id, ...original });
        if (other) await runtime.request('chat.archive', { chatId: other.id });
        const restored = (await state()).chats.find(item => item.id === chat.id);
        assert.equal(restored.providerId, original.providerId); assert.equal(restored.model, original.model);
        await selectChat(chat);
        await until(() => js(`document.querySelector('#model-label').textContent===${JSON.stringify(originalLabel)}`), 'original model label restored');
      } catch (cleanupError) {
        if (primaryFailure) throw new AggregateError([primaryFailure, cleanupError], `Attachment smoke failed: ${primaryFailure.message}; cleanup also failed: ${cleanupError.message}`);
        throw cleanupError;
      } finally {
        if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
    }
  }
  const report = path.join(dataDir, 'attachments-smoke-report.json');
  result.check = 'Attachment DOM/IPC/loopback fixture: previews, reselection, PDF rejection, chat isolation, exact text-only wire and snapshot clearing; native chooser untested';
  await fs.writeFile(report, JSON.stringify(result, null, 2));
  return { ...result, report };
}
