import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

const limit = 16 * 1024 * 1024;
async function json(response, maximum = limit) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > maximum) throw new Error('Native response exceeds the inspection limit'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function validateNativeRequest(value, alias) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.model !== alias) throw new Error('Select the loaded managed model');
  if (value.messages !== undefined && (!Array.isArray(value.messages) || value.messages.some(message => !message || typeof message !== 'object' || !(typeof message.content === 'string' || message.content === null || Array.isArray(message.content) && message.content.every(part => part?.type === 'text' && typeof part.text === 'string'))))) throw new Error('This native CPU runtime currently accepts text messages only');
  if (value.prompt !== undefined && typeof value.prompt !== 'string') throw new Error('This native CPU runtime requires a text prompt');
  if(value.tools!==undefined&&(!Array.isArray(value.tools)||value.tools.some(tool=>tool?.type!=='function'||typeof tool.function?.name!=='string')))throw new Error('Only Faber function tool definitions are supported');
  if(value.tool_choice!==undefined&&!['none','auto','required'].includes(value.tool_choice)&&!(value.tool_choice?.type==='function'&&typeof(value.tool_choice.function?.name||value.tool_choice.name)==='string'))throw new Error('Hosted native tools are unavailable');
  // The upstream API has agentic extensions beyond OpenAI. Forward only the model request contract.
  const allowed = new Set(['model', 'messages', 'prompt', 'stream', 'stream_options', 'temperature', 'top_p', 'top_k', 'min_p', 'max_tokens', 'max_completion_tokens', 'stop', 'frequency_penalty', 'presence_penalty', 'tools', 'tool_choice']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unsupported native request option');
  return value;
}

export async function createSafetensorsProxy({ upstream, key, alias, signal, fetchImpl = fetch }) {
  const parsed = new URL(upstream);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Native transport must use an owned loopback address');
  if (typeof key !== 'string' || key.length < 32) throw new Error('Native transport requires a random authentication secret');
  const expected = Buffer.from(`Bearer ${key}`), controllers = new Set(); let nativeModel;
  const server = http.createServer(async (request, response) => {
    const authorization = Buffer.from(request.headers.authorization || '');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected) || Object.hasOwn(request.headers,'origin')) { response.writeHead(401); response.end(); return; }
    const route = request.url;
    if (!(request.method === 'GET' && ['/health', '/v1/models', '/props'].includes(route) || request.method === 'POST' && ['/v1/chat/completions', '/v1/completions'].includes(route))) { response.writeHead(404); response.end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    const disconnected = () => { if (!response.writableEnded) controller.abort(new Error('Native request disconnected')); };
    response.on('close', disconnected);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    try {
      if (request.method === 'GET') {
        if (route === '/props') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return; }
        const listed = await fetchImpl(`${upstream}/v1/models`, { redirect: 'error', signal: AbortSignal.any([combined, AbortSignal.timeout(2000)]) });
        if (!listed.ok) throw new Error('Native model is still loading');
        const models = await json(listed, 1024 * 1024);
        if (!Array.isArray(models.data) || models.data.length !== 1 || typeof models.data[0].id !== 'string') throw new Error('Native model identity could not be verified');
        nativeModel = models.data[0].id;
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(route === '/health' ? { status: 'ok' } : { data: [{ id: alias, object: 'model' }] })); return;
      }
      if (!nativeModel) throw new Error('Wait for the native model to become ready');
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('Native request exceeds the 16 MiB limit'); chunks.push(chunk); }
      const body = validateNativeRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), alias); body.model = nativeModel;
      const result = await fetchImpl(`${upstream}${route}`, { method: 'POST', redirect: 'error', signal: combined, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!result.ok) { await result.body?.cancel(); throw new Error(`Native model request failed (HTTP ${result.status})`); }
      if (!body.stream) { const value = await json(result); value.model = alias; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let pending = ''; const decoder = new TextDecoder();
      const write = async text => { if (!response.write(text)) await once(response, 'drain', { signal: combined }); };
      for await (const chunk of result.body) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > limit) throw new Error('Native stream frame exceeds the limit');
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          let line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
          if (line.startsWith('data:') && line.slice(5).trim() !== '[DONE]') { const value = JSON.parse(line.slice(5)); value.model = alias; line = `data: ${JSON.stringify(value)}`; }
          await write(`${line}\n`);
        }
      }
      if (pending.trim()) throw new Error('Native stream ended within a frame');
      response.end();
    } catch (error) {
      if (!response.headersSent) { response.writeHead(request.method === 'GET' ? 503 : 400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.name === 'AbortError' ? 'Native request stopped' : error.message } })); }
      else response.destroy();
    } finally { controllers.delete(controller); response.off('close', disconnected); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let closing;
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close() { return closing ||= (async () => { for (const controller of controllers) controller.abort(new Error('Native model stopped')); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); })(); } };
}
