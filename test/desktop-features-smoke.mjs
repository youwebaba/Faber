import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const repoId = 'fixture/quantized', revision = 'b'.repeat(40), modelId = 'fixture-responses-model';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const shardNames = ['Model-Q4_K_M-00001-of-00002.gguf', 'Model-Q4_K_M-00002-of-00002.gguf'];
const payloads = new Map([
  [shardNames[0], Buffer.alloc(32768, 1)], [shardNames[1], Buffer.alloc(32768, 2)],
  ['Other-Q4_K_M.gguf', Buffer.alloc(1024, 3)], ['Model-IQ2_XS.gguf', Buffer.alloc(1024, 4)],
  ['Model-Q8_0-00001-of-00002.gguf', Buffer.alloc(1024, 5)], ['mmproj-Model-F16.gguf', Buffer.alloc(1024, 6)],
  ['Model-BF16.gguf', Buffer.alloc(2048, 7)],
]);
const metadata = { id: repoId, sha: revision, tags: ['gguf'], gguf: { total: 1000, totalFileSize: 65536 }, siblings: [...payloads].map(([rfilename, bytes]) => ({ rfilename, size: bytes.length, lfs: { size: bytes.length, sha256: sha(bytes) } })) };

export async function createFeatureSmoke(dataDir) {
  const upgradeSourceDir = path.join(dataDir, 'upgrade-source');
  await fs.mkdir(path.join(upgradeSourceDir, 'renderer'), { recursive: true });
  await fs.mkdir(path.join(upgradeSourceDir, 'test'));
  await fs.writeFile(path.join(upgradeSourceDir, 'renderer', 'fixture.mjs'), 'export const value = 1;\n');
  await fs.writeFile(path.join(upgradeSourceDir, 'test', 'fixture.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../renderer/fixture.mjs'; test('fixture upgrade',()=>assert.equal(value,2));\n");
  await fs.writeFile(path.join(upgradeSourceDir, 'package.json'), '{"type":"module"}\n');
  const calls = [], errors = [], transfers = [], imageRequests = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer fixture-key-not-a-secret');
      if (request.method === 'GET' && request.url === '/v1/models') { calls.push({ kind: 'models' }); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: modelId }] })); return; }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.model, modelId); assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.reasoning.effort, 'medium');
      for (const name of ['project_list', 'upgrade_stage', 'upgrade_verify', 'hf_download_model']) assert.ok(body.tools.some(tool => tool.name === name));
      const outputs = body.input.filter(item => item.type === 'function_call_output');
      calls.push({ kind: 'responses', toolCount: body.tools.length, outputs: outputs.map(item => ({ call_id: item.call_id, output: JSON.parse(item.output) })) });
      const sequence = calls.filter(item => item.kind === 'responses').length;
      const lastUser = body.input.findLast(item => item.role === 'user');
      const imageParts = Array.isArray(lastUser?.content) ? lastUser.content.filter(item => item.type === 'input_image') : [];
      const call = (id, name, args) => ({ type: 'function_call', id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
      let output;
      if (imageParts.length) {
        imageRequests.push(imageParts.map(item => item.image_url));
        output = [{ type: 'message', id: 'msg-image', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The controlled image reached the Responses provider.', annotations: [] }] }];
      } else if (!outputs.some(item => item.call_id === 'projects')) output = [call('projects', 'project_list', {})];
      else if (!outputs.some(item => item.call_id === 'stage')) output = [call('stage', 'upgrade_stage', { changes: [{ path: 'renderer/fixture.mjs', content: 'export const value = 2;\n' }] })];
      else if (!outputs.some(item => item.call_id === 'verify')) {
        const staged = JSON.parse(outputs.find(item => item.call_id === 'stage').output); assert.equal(staged.status, 'staged');
        output = [call('verify', 'upgrade_verify', { id: staged.id })];
      } else {
        const verified = JSON.parse(outputs.find(item => item.call_id === 'verify').output); assert.equal(verified.verified, true);
        const text = 'Fixture Responses connection used project_list, staged a source change, and passed its isolated test. Nothing was applied.';
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
        output = [{ type: 'message', id: 'msg-final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
      }
      if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `fixture-response-${sequence}`, status: 'completed', output, usage: { input_tokens: 1000 + sequence, output_tokens: 20 + sequence, input_tokens_details: { cached_tokens: 200 + sequence }, output_tokens_details: { reasoning_tokens: 5 } } } })}\n\n`);
    } catch (error) { errors.push(error.message); if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input); assert.equal(url.origin, 'https://huggingface.co');
    if (url.pathname === '/api/models') return Response.json([metadata]);
    if (url.pathname === `/api/models/${repoId}` || url.pathname === `/api/models/${repoId}/revision/${revision}`) return Response.json(metadata);
    const prefix = `/${repoId}/resolve/${revision}/`; assert.ok(url.pathname.startsWith(prefix));
    const name = decodeURIComponent(url.pathname.slice(prefix.length)), bytes = payloads.get(name); assert.ok(bytes); transfers.push(name);
    let offset = 0, canceled = false;
    return new Response(new ReadableStream({ async pull(controller) {
      await pause(35); if (canceled) return;
      if (options.signal?.aborted) { controller.error(options.signal.reason); return; }
      if (offset === bytes.length) { controller.close(); return; }
      const next = bytes.subarray(offset, offset + 1024); offset += next.length; controller.enqueue(next);
    }, cancel() { canceled = true; } }), { headers: { 'Content-Length': String(bytes.length) } });
  };
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId, upgradeSourceDir, fetchImpl, calls, errors, transfers, imageRequests, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export async function runFeatureSmoke({ window, modelHub, runtime, chat, dataDir, fixture }) {
  const checks = [], screenshots = {}, js = code => window.webContents.executeJavaScript(code);
  const state = () => runtime.request('state.get');
  async function until(predicate, label, timeout = 15000) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await predicate(); if (value) return value; await pause(60); } throw new Error(`Feature smoke timeout: ${label}`); }
  const click = selector => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing feature smoke selector: '+${JSON.stringify(selector)});e.click()})()`);
  const button = text => js(`(()=>{const e=[...document.querySelectorAll('#modal button')].find(e=>e.textContent===${JSON.stringify(text)});if(!e)throw new Error('Missing feature smoke button: '+${JSON.stringify(text)});e.click()})()`);
  const set = (selector, value) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  async function capture(name) { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(80); const filename = path.join(dataDir, `${name}.png`); await fs.writeFile(filename, (await window.webContents.capturePage()).toPNG()); screenshots[name] = filename; }
  await until(() => js(`!![...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(chat.title)})`), 'chat navigation');
  await js(`[...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(chat.title)}).click()`);
  window.setSize(1100, 760);
  await click('#model-picker'); await click('#add-cloud-connection');
  assert.equal(await js(`document.querySelector('#connection-kind').value`), 'openai-responses');
  assert.equal(await js(`document.querySelector('#connection-url').value`), 'https://api.openai.com/v1');
  assert.match(await js(`document.querySelector('#modal-body').innerText`), /gpt-6-astra/); assert.match(await js(`document.querySelector('#modal-body').innerText`), /gpt-6.1-sol/);
  assert.match(await js(`document.querySelector('#connection-disclosure').innerText`), /billed/);
  await capture('cloud-preset'); checks.push('OpenAI Responses preset, suggested model IDs and cloud disclosure visible; no public API request');
  await set('#connection-name', 'Controlled Responses fixture'); await set('#connection-url', fixture.baseUrl); await set('#connection-model', fixture.modelId); await set('#connection-key', 'fixture-key-not-a-secret'); await set('#connection-reasoning', 'medium');
  await button('Save & list models');
  await until(() => js(`document.querySelector('#connection-result')?.innerText.includes('Connection responded')`), 'actual loopback model listing');
  const provider = (await state()).providers.find(item => item.name === 'Controlled Responses fixture'); assert.ok(provider?.hasKey); assert.equal(provider.kind, 'openai-responses'); assert.equal(provider.reasoningEffort, 'medium');
  assert.equal((await state()).chats.find(item => item.id === chat.id).providerId, 'local-ollama'); assert.equal(fixture.calls.filter(item => item.kind === 'responses').length, 0);
  assert.ok(!(await fs.readFile(path.join(dataDir, 'secrets.json'), 'utf8')).includes('fixture-key-not-a-secret'));
  checks.push('Save & list uses real provider.test over loopback and encrypted storage, with no inference or chat-provider change');
  await button('Save connection'); await until(() => js(`!!document.querySelector('#chat-connection')`), 'return to chat model picker');
  assert.equal(await js(`document.querySelector('#chat-connection').value`), provider.id); await button('Use in this chat');
  await until(async () => (await state()).chats.find(item => item.id === chat.id).providerId === provider.id, 'explicit per-chat provider selection');
  await js(`(()=>{const e=document.querySelector('#prompt');e.value='Run the controlled tool and staged-upgrade fixture.';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#composer').requestSubmit()})()`);
  const approval = await until(async () => (await state()).approvals.find(item => item.chatId === chat.id && item.permission === 'upgrade'), 'visible upgrade approval');
  await until(() => js(`!![...document.querySelectorAll('#approval-list button')].find(e=>e.textContent==='Allow for this run')`), 'upgrade approval DOM');
  await capture('cloud-upgrade-approval');
  await js(`[...document.querySelectorAll('#approval-list button')].find(e=>e.textContent==='Allow for this run').click()`);
  const run = await until(async () => (await state()).runs.find(item => item.id === approval.runId && ['completed', 'failed', 'canceled'].includes(item.status)), 'Responses tool loop', 30000);
  assert.equal(run.status, 'completed', run.error);
  for (const name of ['project_list', 'upgrade_stage', 'upgrade_verify']) assert.ok(run.toolEvents.some(item => item.name === name && item.status === 'completed'), name);
  assert.deepEqual(fixture.errors, []); assert.equal(fixture.calls.filter(item => item.kind === 'responses').length, 4);
  assert.equal(await fs.readFile(path.join(fixture.upgradeSourceDir, 'renderer', 'fixture.mjs'), 'utf8'), 'export const value = 1;\n');
  await assert.rejects(fs.access(path.join(dataDir, 'upgrades', 'last-applied.json')));
  await until(() => js(`document.querySelector('#transcript').innerText.includes('Nothing was applied.')`), 'rendered Responses reply'); await capture('cloud-tool-reply');
  checks.push('Real Responses SSE adapter runs project_list, GUI-approved upgrade_stage and actual staged Node tests; original isolated source remains unchanged');
  const cloud = { providerId: provider.id, kind: provider.kind, endpoint: fixture.baseUrl, runId: run.id, toolEvents: run.toolEvents.map(item => ({ name: item.name, status: item.status })), modelLists: fixture.calls.filter(item => item.kind === 'models').length, responseRequests: 4, fixtureSourceUnchanged: true };
  assert.equal(run.modelCalls.length, 4);
  for (const [index, call] of run.modelCalls.entries()) {
    assert.equal(call.sequence, index + 1); assert.equal(call.status, 'completed');
    assert.deepEqual(call.usage, { inputTokens: 1001 + index, outputTokens: 21 + index, cachedInputTokens: 201 + index, reasoningTokens: 5 });
  }
  await until(() => js(`document.querySelectorAll('#token-usage .usage-run[data-run-id="${run.id}"] .model-call').length===4`), 'all model call usage rows');
  await js(`document.querySelector('#token-usage .usage-run[data-run-id="${run.id}"]').open=true`);
  assert.match(await js(`document.querySelector('#token-usage .model-call[data-call-id="${run.modelCalls[0].id}"] .usage-input').textContent`), /1,001|1001/);
  assert.match(await js(`document.querySelector('#token-usage .model-call[data-call-id="${run.modelCalls[0].id}"] .usage-output').textContent`), /21/);
  await capture('model-call-usage'); checks.push('Four Responses requests record and render separate exact input/output/cached/reasoning usage');

  async function pasteImage(color) {
    return js(`(async()=>{const canvas=document.createElement('canvas');canvas.width=128;canvas.height=96;const ctx=canvas.getContext('2d');ctx.fillStyle=${JSON.stringify(color)};ctx.fillRect(0,0,128,96);ctx.fillStyle='black';ctx.font='14px sans-serif';ctx.fillText('Fixture image',10,48);const url=canvas.toDataURL('image/png');const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],'fixture.png',{type:'image/png'}));const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});document.querySelector('#prompt').dispatchEvent(event);if(!event.defaultPrevented)throw new Error('Image paste was not handled');return url})()`);
  }
  await set('#prompt', 'Keep this ordinary draft');
  const textPasteHandled = await js(`(()=>{const transfer=new DataTransfer();transfer.setData('text/plain','plain clipboard fixture');const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});document.querySelector('#prompt').dispatchEvent(event);return event.defaultPrevented})()`);
  assert.equal(textPasteHandled, false);
  await pasteImage('#f6b85c'); await until(() => js(`document.querySelectorAll('#image-drafts .image-draft img').length===1`), 'first image preview');
  const retainedImage = await pasteImage('#8bb9ef'); await until(() => js(`document.querySelectorAll('#image-drafts .image-draft img').length===2`), 'second image preview');
  await click('#image-drafts button[aria-label^="Remove image"]');
  assert.equal(await js(`document.querySelectorAll('#image-drafts .image-draft img').length`), 1); assert.equal(await js(`document.querySelector('#image-drafts img').src`), retainedImage);
  assert.equal(await js(`document.querySelector('#prompt').value`), 'Keep this ordinary draft');
  const otherChat = await runtime.request('chat.create', { projectId: chat.projectId, title: 'Attachment draft isolation' });
  await until(() => js(`!![...document.querySelectorAll('.chat-nav')].find(e=>e.title==='Attachment draft isolation')`), 'other chat navigation');
  await js(`[...document.querySelectorAll('.chat-nav')].find(e=>e.title==='Attachment draft isolation').click()`);
  assert.equal(await js(`document.querySelectorAll('#image-drafts .image-draft').length`), 0); await set('#prompt', 'Other chat draft');
  await js(`[...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(chat.title)}).click()`);
  assert.equal(await js(`document.querySelector('#prompt').value`), 'Keep this ordinary draft'); assert.equal(await js(`document.querySelector('#image-drafts img').src`), retainedImage);
  const countBeforeFailure = (await state()).runs.length;
  await set('#prompt', 'x'.repeat(200001)); await js(`document.querySelector('#composer').requestSubmit()`);
  await until(() => js(`!document.querySelector('#notice').hidden&&document.querySelector('#notice').classList.contains('error')`), 'rejected send notice');
  assert.equal((await state()).runs.length, countBeforeFailure); assert.equal(await js(`document.querySelector('#prompt').value.length`), 200001); assert.equal(await js(`document.querySelector('#image-drafts img').src`), retainedImage);
  await set('#prompt', ''); await click('#dismiss-notice'); await capture('pasted-image-draft');
  await js(`document.querySelector('#composer').requestSubmit()`);
  const imageRun = await until(async () => (await state()).runs.find(item => item.chatId === chat.id && item.id !== run.id && ['completed', 'failed', 'canceled'].includes(item.status)), 'image-only Responses reply');
  assert.equal(imageRun.status, 'completed', imageRun.error); assert.deepEqual(fixture.imageRequests, [[retainedImage]]); assert.deepEqual(fixture.errors, []);
  const imageMessage = (await state()).chats.find(item => item.id === chat.id).messages.findLast(item => item.role === 'user');
  assert.equal(imageMessage.content, ''); assert.deepEqual(imageMessage.images, [retainedImage]);
  await until(() => js(`document.querySelectorAll('.message-images img').length===1&&document.querySelectorAll('#image-drafts .image-draft').length===0`), 'persisted image and cleared sent preview');
  assert.equal(imageRun.modelCalls.length, 1); assert.deepEqual(imageRun.modelCalls[0].usage, { inputTokens: 1005, outputTokens: 25, cachedInputTokens: 205, reasoningTokens: 5 });
  await until(() => js(`!!document.querySelector('#token-usage .model-call[data-call-id="${imageRun.modelCalls[0].id}"] .usage-input')`), 'image call usage DOM');
  await js(`document.querySelector('#token-usage .usage-run[data-run-id="${imageRun.id}"]').open=true`); await capture('image-reply-usage');
  await js(`[...document.querySelectorAll('.chat-nav')].find(e=>e.title==='Attachment draft isolation').click()`); assert.equal(await js(`document.querySelector('#prompt').value`), 'Other chat draft');
  await js(`[...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(chat.title)}).click()`);
  checks.push('Synthetic image paste previews/removes attachments without touching the OS clipboard; text/chat drafts survive switching and rejected send; image-only send persists and reaches the real Responses wire with per-call usage');
  const images = { kind: 'synthetic-paste-event', runId: imageRun.id, imageCount: imageMessage.images.length, sha256: sha(retainedImage), usage: imageRun.modelCalls[0].usage, otherChatId: otherChat.id, failureDraftPreserved: true };
  for (const name of ['Image project A', 'Image project B']) {
    const directory = path.join(dataDir, name); await fs.mkdir(directory);
    await runtime.request('project.create', { name, path: directory });
  }
  async function selectProject(name) {
    await until(() => js(`!![...document.querySelectorAll('.project-button')].find(e=>e.textContent.includes(${JSON.stringify(name)}))`), 'project navigation');
    await js(`[...document.querySelectorAll('.project-button')].find(e=>e.textContent.includes(${JSON.stringify(name)})).click()`);
  }
  await selectProject('Image project A'); await set('#prompt', 'Project A unsent draft'); const projectImage = await pasteImage('#91c9a0');
  await until(() => js(`document.querySelectorAll('#image-drafts .image-draft img').length===1`), 'new project image preview');
  await selectProject('Image project B'); assert.equal(await js(`document.querySelector('#prompt').value`), ''); assert.equal(await js(`document.querySelectorAll('#image-drafts .image-draft').length`), 0); await set('#prompt', 'Project B unsent draft');
  await selectProject('Image project A'); assert.equal(await js(`document.querySelector('#prompt').value`), 'Project A unsent draft'); assert.equal(await js(`document.querySelector('#image-drafts img').src`), projectImage); await capture('project-image-draft');
  await selectProject('Image project B'); assert.equal(await js(`document.querySelector('#prompt').value`), 'Project B unsent draft'); assert.equal(await js(`document.querySelectorAll('#image-drafts .image-draft').length`), 0);
  await js(`[...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(chat.title)}).click()`);
  checks.push('Unsent new-chat text and image drafts remain isolated when switching project headings');
  await click('#open-models'); await set('#model-search-query', 'quantized'); await set('#model-search-format', 'gguf'); await js(`document.querySelector('#model-search-form').requestSubmit()`);
  await until(() => js(`!!document.querySelector('#model-results [data-repo-id="${repoId}"]')`), 'quantized fixture search'); await click(`#model-results [data-repo-id="${repoId}"]`);
  await until(() => js(`!!document.querySelector('#model-quantizations .quantization-pill')`), 'quantization catalog');
  const details = await modelHub.request('models.inspect', { repoId, revision });
  const variant = details.quantizations.find(item => item.label === 'Model-Q4_K_M'), incomplete = details.quantizations.find(item => item.encoding === 'Q8_0');
  assert.equal(variant.files.length, 2); assert.equal(variant.sizeBytes, 65536); assert.equal(details.quantizations.filter(item => item.encoding === 'Q4_K_M').length, 2);
  assert.equal(await js(`document.querySelector('#model-quantizations [data-quantization-id="${incomplete.id}"]').disabled`), true);
  assert.ok(!(await js(`document.querySelector('#model-quantizations').innerText`)).includes('mmproj'));
  await click(`#model-quantizations [data-quantization-id="${variant.id}"]`);
  assert.match(await js(`document.querySelector('#model-quantization-summary').innerText`), /2 files/);
  await js(`document.querySelector('#model-manual-files').open=true`); await click('#model-detail input[data-path="Other-Q4_K_M.gguf"]');
  assert.match(await js(`document.querySelector('#model-download-selected').textContent`), /selected files/);
  await click(`#model-quantizations [data-quantization-id="${variant.id}"]`); await js(`document.querySelector('#model-manual-files').open=false`);
  await js(`document.querySelector('#model-detail').scrollTop=0`); await capture('quantization-catalog-compact');
  window.setSize(1440, 960); await js(`document.querySelector('#model-detail').scrollTop=0`); await capture('quantization-catalog');
  checks.push('Quantization groups distinguish same-encoding models, disable missing shards, exclude auxiliary files and retain manual selection');
  await click('#model-download-selected');
  const active = await until(async () => (await modelHub.request('models.state')).downloads.find(job => job.quantizationId === variant.id && job.speedBytesPerSecond > 0), 'variant stream speed');
  await capture('quantization-progress');
  const job = await until(async () => (await modelHub.request('models.state')).downloads.find(item => item.id === active.id && ['completed', 'failed'].includes(item.status)), 'complete shard download');
  assert.equal(job.status, 'completed', job.error); assert.equal(job.totalBytes, 65536); assert.deepEqual(job.files.map(file => file.path), shardNames); assert.deepEqual(fixture.transfers, shardNames);
  for (const name of shardNames) assert.equal(sha(await fs.readFile(path.join(job.directory, name))), sha(payloads.get(name)));
  for (const name of [...payloads.keys()].filter(name => !shardNames.includes(name))) await assert.rejects(fs.access(path.join(job.directory, name)));
  checks.push('GUI-selected quantization expands authoritative pinned shard set through existing downloader, progress/speed and exact disk hashes; no other variant transferred');
  await click('#model-browse-tab'); await capture('quantization-complete');
  const quantization = { repoId, revision, id: variant.id, label: variant.label, files: job.files.map(file => ({ path: file.path, size: file.size, sha256: file.verifiedSha256 })), totalBytes: job.totalBytes, status: job.status };
  const result = { ok: true, kind: 'controlled-loopback-and-HF-fixtures-no-cloud-inference', checks, screenshots, cloud, images, quantization };
  const report = path.join(dataDir, 'features-smoke-report.json'); await fs.writeFile(report, JSON.stringify(result, null, 2)); return { ...result, report };
}
