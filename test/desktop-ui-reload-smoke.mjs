import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const repoId = 'fixture/reload', revision = 'c'.repeat(40), bytes = Buffer.alloc(512 * 1024, 7);
export async function createUIReloadSmoke(dataDir, sourceDir) {
  const fixtureSource = `${dataDir}-source`; await fs.mkdir(fixtureSource);
  await fs.cp(path.join(sourceDir, 'renderer'), path.join(fixtureSource, 'renderer'), { recursive: true });
  await fs.mkdir(path.join(fixtureSource, 'test')); await fs.mkdir(path.join(fixtureSource, 'core'));
  await fs.writeFile(path.join(fixtureSource, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(fixtureSource, 'core', 'fixture.mjs'), 'export const value=1;');
  await fs.writeFile(path.join(fixtureSource, 'test', 'fixture.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';test('copied renderer exists',()=>assert.match(fs.readFileSync('renderer/index.html','utf8'),/ui-smoke-marker/));");
  const index = path.join(fixtureSource, 'renderer', 'index.html'); await fs.writeFile(index, (await fs.readFile(index, 'utf8')).replace('<head>', '<head><meta name="ui-smoke-marker" content="before"><script type="module" src="/marker.mjs"></script>'));
  await fs.writeFile(path.join(fixtureSource, 'renderer', 'marker.mjs'), "document.documentElement.dataset.fixtureVersion='before';");
  let response, calls = 0;
  const server = http.createServer(async (request, reply) => {
    if (request.url === '/health') { reply.end('alive'); return; }
    if (request.url !== '/api/chat' || request.method !== 'POST') { reply.writeHead(404); reply.end(); return; }
    for await (const _ of request) { /* Consume only this controlled fixture request. */ }
    calls++; response = reply; reply.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    reply.write(JSON.stringify({ message: { role: 'assistant', content: 'Before renderer reload. ' }, done: false }) + '\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input); assert.equal(url.origin, 'https://huggingface.co');
    const file = { rfilename: 'model.safetensors', size: bytes.length, lfs: { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
    if (url.pathname.startsWith('/api/models/')) return Response.json({ id: repoId, sha: revision, siblings: [file] });
    assert.equal(url.pathname, `/${repoId}/resolve/${revision}/model.safetensors`);
    let offset = 0, canceled = false;
    return new Response(new ReadableStream({ async pull(controller) { await pause(200); if (canceled) return; if (options.signal?.aborted) { controller.error(options.signal.reason); return; } if (offset === bytes.length) { controller.close(); return; } controller.enqueue(bytes.subarray(offset, offset += 1024)); }, cancel() { canceled = true; } }), { headers: { 'Content-Length': String(bytes.length) } });
  };
  return { sourceDir: fixtureSource, fetchImpl, baseUrl: `http://127.0.0.1:${server.address().port}`, get calls() { return calls; },
    chunk(text) { response.write(JSON.stringify({ message: { role: 'assistant', content: text }, done: false }) + '\n'); },
    finish() { response.end(JSON.stringify({ message: { role: 'assistant', content: 'After renderer reload.' }, done: true, prompt_eval_count: 10, eval_count: 5 }) + '\n'); },
    async close() { if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); },
  };
}

export async function runUIReloadSmoke({ window, runtime, modelHub, localModels, upgrades, uiReload, chat, dataDir, fixture, localFixture }) {
  const js = code => window.webContents.executeJavaScript(code), state = () => runtime.request('state.get');
  async function until(predicate, label) { const until = Date.now() + 20000; while (Date.now() < until) { try { if (await predicate()) return; } catch { /* Navigation invalidates only the old renderer execution context. */ } await pause(60); } throw new Error(`UI reload smoke timeout: ${label}`); }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const select = async target => { await until(() => js(`!![...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(target.title)})`), 'chat navigation'); await js(`[...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(target.title)}).click()`); };
  const setDraft = async (text, filename) => { await js(`(()=>{const prompt=document.querySelector('#prompt');prompt.value=${JSON.stringify(text)};prompt.dispatchEvent(new Event('input',{bubbles:true}));const transfer=new DataTransfer();transfer.items.add(new File(['Private unsent file'],${JSON.stringify(filename)},{type:'text/plain'}));const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));transfer.items.add(new File([bytes],'draft.png',{type:'image/png'}));const input=document.querySelector('#file-picker');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`); await until(() => js(`document.querySelectorAll('#image-drafts .image-draft').length===2 && !document.querySelector('#image-draft-status').textContent.includes('Reading')`), 'attachment draft settled'); };
  const originalPid = process.pid, references = { runtime, modelHub, localModels };
  await until(() => js(`document.documentElement.dataset.uiReady==='true'`), 'initial renderer ready');
  const listed = await localModels.request('localModels.list'); await localModels.request('localModels.start', { modelId: listed.models.find(item => item.relativePath === 'Fixture-Q4_K_M.gguf').id });
  await until(async () => (await localModels.request('localModels.list')).process.status === 'ready', 'controlled local server ready');
  const localPid = localFixture.children[0].pid;
  const provider = await runtime.request('provider.save', { name: 'Reload loopback fixture', kind: 'ollama', baseUrl: fixture.baseUrl, model: 'reload-fixture' });
  await runtime.request('chat.update', { id: chat.id, providerId: provider.id, model: 'reload-fixture' });
  const other = await runtime.request('chat.create', { projectId: chat.projectId, title: 'Second unsent draft' });
  await runtime.request('chat.send', { chatId: chat.id, text: 'Controlled reload stream' });
  await until(async () => fixture.calls === 1 && (await state()).streams?.length > 0, 'active fixture stream');
  const runId = (await state()).runs.find(item => item.chatId === chat.id).id;
  await modelHub.request('models.download', { repoId, revision, files: ['model.safetensors'] });
  await until(async () => (await modelHub.request('models.state')).downloads.some(job => job.downloadedBytes > 0), 'active fixture download');
  const download = (await modelHub.request('models.state')).downloads[0];
  await select(chat); await setDraft('First private unsent draft', 'first.txt'); await select(other); await setDraft('Second private unsent draft', 'second.txt');
  const originalHTML = await fs.readFile(path.join(fixture.sourceDir, 'renderer', 'index.html'), 'utf8');
  window.webContents.once('did-start-loading', () => fixture.chunk('During refresh. '));
  const staged = await upgrades.stage([{ path: 'renderer/index.html', content: originalHTML.replace('content="before"', 'content="after"') }, { path: 'renderer/marker.mjs', content: "document.documentElement.dataset.fixtureVersion='after';" }]); await upgrades.verify(staged.id); const applied = await upgrades.apply(staged.id); assert.equal(applied.restartRequired, false);
  await until(() => js(`document.querySelector('meta[name="ui-smoke-marker"]')?.content==='after' && document.documentElement.dataset.fixtureVersion==='after' && document.querySelector('#prompt').value==='Second private unsent draft'`), 'automatic reload restores selected draft');
  await until(async () => await uiReload.request('app.uiState') === null, 'restoration ack');
  assert.equal(process.pid, originalPid); assert.equal(references.runtime, runtime); assert.equal(references.localModels, localModels); assert.equal(references.modelHub, modelHub);
  assert.equal(localFixture.children[0].pid, localPid); assert.equal(localFixture.children[0].exitCode, null);
  assert.equal((await state()).runs.find(item => item.id === runId).status, 'running');
  assert.ok((await modelHub.request('models.state')).downloads.find(job => job.id === download.id).downloadedBytes > download.downloadedBytes);
  assert.equal(await (await fetch(`${fixture.baseUrl}/health`)).text(), 'alive');
  for (const [target, text, filename] of [[other, 'Second private unsent draft', 'second.txt'], [chat, 'First private unsent draft', 'first.txt']]) { await select(target); assert.equal(await js(`document.querySelector('#prompt').value`), text); assert.equal(await js(`document.querySelectorAll('#image-drafts .image-draft').length`), 2); assert.ok(await js(`document.querySelector('#image-drafts').textContent.includes(${JSON.stringify(filename)})`)); }
  await until(() => js(`document.querySelector('#transcript').textContent.includes('Before renderer reload.')`), 'active stream restored');
  fixture.finish(); await until(async () => (await state()).runs.find(item => item.id === runId).status === 'completed', 'same run completes');
  await until(() => js(`document.querySelector('#transcript').textContent.includes('After renderer reload.')`), 'completion rendered');
  const expectedReply = 'Before renderer reload. During refresh. After renderer reload.';
  assert.equal((await state()).chats.find(item => item.id === chat.id).messages.findLast(item => item.role === 'assistant' && item.runId === runId).content, expectedReply);
  assert.equal(await js(`[...document.querySelectorAll('.message.assistant .message-content')].at(-1).textContent`), expectedReply);
  await upgrades.rollback(); await until(() => js(`document.querySelector('meta[name="ui-smoke-marker"]')?.content==='before' && document.documentElement.dataset.fixtureVersion==='before' && document.querySelector('#prompt').value==='First private unsent draft'`), 'rollback renderer reload');
  await until(async () => await uiReload.request('app.uiState') === null, 'rollback ack');
  // A backend source change must reject a renderer handoff before unloading it.
  const backend = await upgrades.stage([{ path: 'core/fixture.mjs', content: 'export const value=2;' }]); await upgrades.verify(backend.id); await upgrades.apply(backend.id);
  await click('#open-settings'); await click('#reload-ui');
  await until(() => js(`document.body.textContent.includes('Backend changes are pending')`), 'backend reload rejection');
  await click('#close-modal'); assert.equal(await js(`document.querySelector('#prompt').value`), 'First private unsent draft'); assert.equal(await js(`document.querySelectorAll('#image-drafts .image-draft').length`), 2);
  await modelHub.request('models.cancel', { id: download.id }); await localModels.request('localModels.stop');
  window.setSize(1100, 760); await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(100);
  const screenshot = path.join(dataDir, 'ui-reloaded-drafts.png'); await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
  const report = { ok: true, sameHostPid: originalPid, sameRunId: runId, sameLocalProcess: true, downloadContinued: true, twoChatDraftsAndAttachments: true, activeStreamRestored: true, reloadGapChunkExactlyOnce: true, freshRendererMarker: true, rollbackReload: true, backendRejectedWithoutDraftLoss: true, cloudCalls: 0, screenshot };
  const reportPath = path.join(dataDir, 'ui-reload-smoke-report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); return { ...report, reportPath };
}
