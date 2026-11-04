import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

export async function runB201ContentSmoke({ window, runtime, dataDir }) {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
  const workspace = await fs.mkdtemp(path.join(path.dirname(dataDir), 'Faber-content-workspace-'));
  await fs.writeFile(path.join(workspace, 'pixel.png'), Buffer.from(png, 'base64'));
  const calls = [], server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    if (calls.length === 1) response.end(JSON.stringify({ message: { role: 'assistant', content: '**Opening the image.**', tool_calls: [{ function: { name: 'images_show', arguments: { path: 'pixel.png' } } }] }, done: true }) + '\n');
    else {
      response.write(JSON.stringify({ message: { role: 'assistant', content: '**Formatting fixture**\n\n_Italic_ · <u>Underline</u> · ~~Strikeout~~ · <span style="color: #ff6600">Orange</span>\n\n' }, done: false }) + '\n');
      response.end(JSON.stringify({ message: { role: 'assistant', content: '- A bullet\n  - A nested bullet\n\n1. A numbered step\n2. Another step\n\n```js\nconst ready = true;\n```\n\nThe image above came from a project file.' }, done: true, prompt_eval_count: 70, eval_count: 35 }) + '\n');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const js = code => window.webContents.executeJavaScript(code);
  async function wait(predicate, label) { const end = Date.now() + 10000; while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Content smoke timeout: ${label}`); }
  try {
    const project = await runtime.request('project.create', { name: 'Formatting & images', path: workspace });
    const chat = await runtime.request('chat.create', { projectId: project.id, title: 'Formatting and image fixture' });
    const provider = await runtime.request('provider.save', { name: 'Isolated fixture', kind: 'ollama', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture-model' });
    await runtime.request('chat.update', { id: chat.id, providerId: provider.id, model: 'fixture-model' });
    await wait(() => js(`!!document.querySelector('[data-chat-id="${chat.id}"]')`), 'chat appears');
    await js(`document.querySelector('[data-chat-id="${chat.id}"]').click()`);
    const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: 'Show the saved image and formatted text.' });
    await wait(async () => { const run = (await runtime.request('state.get')).runs.find(item => item.id === runId); if (run.status === 'failed') throw new Error(run.error); return run.status === 'completed'; }, 'tool-backed response');
    await wait(() => js(`document.querySelector('#transcript').innerText.includes('The image above came from a project file.')`), 'visible final reply');
    const result = await js(`(()=>{const root=document.querySelector('#transcript');return {bold:[...root.querySelectorAll('strong')].map(node=>node.textContent),underlined:root.querySelector('u')?.textContent,lists:root.querySelectorAll('.rich-content li').length,images:root.querySelectorAll('img.output-image').length,code:root.querySelector('pre code')?.textContent};})()`);
    assert.ok(result.bold.includes('Formatting fixture')); assert.equal(result.underlined, 'Underline'); assert.equal(result.lists, 4); assert.equal(result.images, 1); assert.match(result.code, /const ready = true/);
    assert.equal(calls.length, 2); assert.ok(calls[0].tools.some(tool => tool.function.name === 'images_show'));
    assert.ok(calls[1].messages.some(message => message.images?.includes(png)), 'Tool image reaches provider vision input');
    window.webContents.invalidate(); await window.webContents.capturePage();
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const screenshot = path.join(dataDir, 'b201-content.png'); await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    return { transcriptFormatting: true, projectImageTool: true, providerVisionInput: true, screenshot };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
