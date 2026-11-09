import http from 'node:http';
import { isIP } from 'node:net';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { streamProvider } from '../core/provider.mjs';
import { validate, validateSchema } from '../core/registry.mjs';
import { validateChatImages } from '../core/images.mjs';
import { cleanUsage, closeIterator } from '../core/usage.mjs';
import { atomicWrite } from './recovery.mjs';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string', maxLength: 200 }, modelId = { type: 'string', minLength: 1, maxLength: 300 };
const configSchema = object({ bindAddress: { type: 'string', minLength: 1, maxLength: 64 }, port: { type: 'integer', minimum: 0, maximum: 65535 }, allowRemote: { type: 'boolean' }, projectId: text, providerId: text, model: { type: 'string', maxLength: 300 } });
const defaults = { bindAddress: '127.0.0.1', port: 8766, allowRemote: false, projectId: '', providerId: '', model: '' };
const secretId = 'external-gateway-token', protocols = ['2025-11-25', '2025-06-18', '2025-03-26'];
const bodyLimit = 4 * 1024 * 1024, outputLimit = 16 * 1024 * 1024, maxRequests = 4, maxSessions = 16, sessionIdleMs = 15 * 60000;
// Only these shipped tools enter an external session; addons and harness/account coordination stay private.
export const gatewayToolNames = Object.freeze(['system_time', 'files_list', 'files_read', 'files_write', 'images_show', 'shell_run', ...['windows', 'screenshot', 'focus', 'click', 'type', 'key', 'launch'].map(name => `desktop_${name}`), ...['open', 'navigate', 'snapshot', 'screenshot', 'click', 'type', 'key', 'scroll', 'close', 'tabs', 'new_tab', 'select_tab', 'back', 'forward', 'reload', 'download'].map(name => `browser_${name}`)]);
export const gatewayMethods = ['gateway.status', 'gateway.configure', 'gateway.start', 'gateway.stop', 'gateway.rotateToken'];

function failure(status, message, code = 'invalid_request_error') { return Object.assign(new Error(message), { status, code }); }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function loopback(address) { return address === '::1' || /^127\./.test(address); }
function configuration(value) {
  validate(value, { ...configSchema, required: Object.keys(defaults) });
  if (!isIP(value.bindAddress) || value.bindAddress.includes('%') || ['0.0.0.0', '::'].includes(value.bindAddress)) throw new Error('Choose a literal IP address for one local interface. Wildcard addresses are unavailable.');
  if (!loopback(value.bindAddress) && value.allowRemote !== true) throw new Error('A network address requires explicit remote access consent.');
  return value;
}
function digest(value) { return createHash('sha256').update(value).digest(); }
function json(response, status, body, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); response.end(body === undefined ? undefined : JSON.stringify(body));
}
async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw failure(415, 'Use application/json.');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw failure(415, 'Compressed request bodies are unavailable.');
  if (Number(request.headers['content-length']) > bodyLimit) throw failure(413, 'Request exceeds 4 MiB.');
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > bodyLimit) throw failure(413, 'Request exceeds 4 MiB.'); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw failure(400, 'Invalid JSON body.'); }
}
async function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Canceled')); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function chatInput(value, selectedModel) {
  validate(value, object({ model: modelId, messages: { type: 'array', minItems: 1, maxItems: 512 }, stream: { type: 'boolean' }, tools: { type: 'array', maxItems: 128 }, tool_choice: { enum: ['auto', 'none'] }, stream_options: object({ include_usage: { type: 'boolean' } }), max_tokens: { type: 'integer', minimum: 1, maximum: 1048576 }, max_completion_tokens: { type: 'integer', minimum: 1, maximum: 1048576 }, n: { const: 1 } }, ['model', 'messages']));
  if (value.model !== selectedModel) throw failure(404, 'This model is not served by this endpoint.', 'model_not_found');
  if (value.max_tokens !== undefined && value.max_completion_tokens !== undefined) throw failure(400, 'Choose one output-token limit.');
  if (value.stream_options && value.stream !== true) throw failure(400, 'stream_options requires stream:true.');
  const tools = (value.tools || []).map(tool => {
    validate(tool, object({ type: { const: 'function' }, function: object({ name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' }, description: { type: 'string', maxLength: 12000 }, parameters: { type: 'object' }, strict: { const: false } }, ['name', 'parameters']) }, ['type', 'function']));
    validateSchema(tool.function.parameters);
    if (tool.function.parameters.type !== 'object') throw failure(400, 'Function parameters must be an object schema.');
    return { name: tool.function.name, description: tool.function.description || tool.function.name, parameters: tool.function.parameters };
  });
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw failure(400, 'Function names must be unique.');
  const pending = new Map(), seen = new Set();
  const messages = value.messages.map(message => {
    validate(message, object({ role: { enum: ['system', 'developer', 'user', 'assistant', 'tool'] }, content: { anyOf: [{ type: 'string', maxLength: 1000000 }, { type: 'array', maxItems: 32 }, { type: 'null' }] }, tool_calls: { type: 'array', maxItems: 32 }, tool_call_id: { type: 'string', minLength: 1, maxLength: 200 } }, ['role', 'content']));
    const result = { role: message.role === 'developer' ? 'system' : message.role, content: message.content ?? '' };
    if (message.role !== 'tool' && pending.size) throw failure(400, 'Every assistant tool call needs a tool result before the next message.');
    if (Array.isArray(message.content)) {
      if (message.role !== 'user') throw failure(400, 'Content arrays are supported for user messages only.');
      const strings = [], images = [];
      for (const part of message.content) {
        if (part?.type === 'text') { validate(part, object({ type: { const: 'text' }, text: { type: 'string', maxLength: 1000000 } }, ['type', 'text'])); strings.push(part.text); }
        else { validate(part, object({ type: { const: 'image_url' }, image_url: object({ url: { type: 'string', maxLength: bodyLimit }, detail: { enum: ['auto'] } }, ['url']) }, ['type', 'image_url'])); images.push(part.image_url.url); }
      }
      validateChatImages(images); result.content = strings.join('\n'); if (images.length) result.images = images;
    }
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant') throw failure(400, 'Only assistant messages can contain tool calls.');
      result.toolCalls = message.tool_calls.map(call => {
        validate(call, object({ id: { type: 'string', minLength: 1, maxLength: 200 }, type: { const: 'function' }, function: object({ name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' }, arguments: { type: 'string', maxLength: 1000000 } }, ['name', 'arguments']) }, ['id', 'type', 'function']));
        if (seen.has(call.id)) throw failure(400, 'Tool call IDs must be unique.');
        let args; try { args = JSON.parse(call.function.arguments); } catch { throw failure(400, 'Function arguments must be JSON.'); }
        if (!record(args)) throw failure(400, 'Function arguments must be an object.');
        seen.add(call.id); pending.set(call.id, call.function.name); return { id: call.id, name: call.function.name, args };
      });
    }
    if (message.role === 'tool') {
      if (!pending.has(message.tool_call_id) || typeof message.content !== 'string') throw failure(400, 'Tool results must match a preceding tool call.');
      result.toolCallId = message.tool_call_id; result.toolName = pending.get(message.tool_call_id); pending.delete(message.tool_call_id);
    } else if (message.tool_call_id !== undefined) throw failure(400, 'Only tool results can contain tool_call_id.');
    return result;
  });
  if (pending.size) throw failure(400, 'Complete all tool results before requesting a model response.');
  return { messages, tools: value.tool_choice === 'none' ? [] : tools, stream: value.stream === true, includeUsage: value.stream_options?.include_usage === true, maxTokens: value.max_completion_tokens ?? value.max_tokens };
}
function usageResult(usage) {
  if (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens)) return undefined;
  return { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens, ...(usage.cachedInputTokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } } : {}), ...(usage.reasoningTokens !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}) };
}

export async function createGateway({ dataDir, runtime, host = {}, emit = () => {}, stream = streamProvider }) {
  if (!dataDir || !runtime) throw new Error('Gateway requires a private data directory and runtime.');
  const configFile = path.join(dataDir, 'gateway.json');
  let config = { ...defaults }, token = '', server = null, address = null, closed = false, controlQueue = Promise.resolve();
  try { const saved = await fs.readFile(configFile); if (saved.length > 4096) throw new Error('Configuration exceeds 4 KiB'); config = configuration(JSON.parse(saved.toString())); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read gateway configuration; saved file preserved.'); }
  try { const saved = await host.getSecret?.(secretId); if (typeof saved === 'string' && /^[\w-]{43}$/.test(saved)) token = saved; } catch { /* An unavailable credential store disables serving until a token can be saved. */ }
  const sessions = new Map(), active = new Map(), tasks = new Set(), incoming = new Set();
  const origin = () => address ? `http://${isIP(config.bindAddress) === 6 ? `[${config.bindAddress}]` : config.bindAddress}:${address.port}` : null;
  const status = () => ({ running: !!server?.listening, activeRequests: incoming.size, activeSessions: sessions.size, hasToken: !!token, config: { ...config }, baseUrl: origin() ? `${origin()}/v1` : null, mcpUrl: origin() ? `${origin()}/mcp` : null });
  const changed = () => { try { emit({ type: 'gateway', state: status() }); } catch { /* A detached UI cannot interrupt serving. */ } };
  async function route() {
    const state = await runtime.request('state.get'), project = state.projects.find(item => item.id === config.projectId), provider = state.providers.find(item => item.id === config.providerId);
    if (!project || project.archived) throw new Error('Select an available target project.');
    if (!provider || provider.authKind || provider.id.startsWith('chatgpt:') || !['ollama', 'openai', 'openai-responses'].includes(provider.kind)) throw new Error('Select a saved local or API connection. Account subscription relaying is unavailable.');
    if (!config.model.trim()) throw new Error('Select the exact model to serve.');
    return { provider, project, toolNames: (state.tools || []).filter(tool => gatewayToolNames.includes(tool.name)).map(tool => tool.name) };
  }
  function authorize(request) {
    for (const name of ['authorization', 'host', 'origin', 'mcp-session-id', 'mcp-protocol-version']) if (request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === name).length > 1) throw failure(400, 'Duplicate security header.');
    const allowedHosts = new Set([new URL(origin()).host.toLowerCase()]);
    if (loopback(config.bindAddress)) { allowedHosts.add(`localhost:${address.port}`); allowedHosts.add(`127.0.0.1:${address.port}`); allowedHosts.add(`[::1]:${address.port}`); }
    if (!allowedHosts.has(request.headers.host?.toLowerCase()) || request.headers.forwarded || request.headers['x-forwarded-host']) throw failure(403, 'Invalid endpoint host.');
    if (request.headers.origin !== undefined && ![...allowedHosts].some(value => request.headers.origin === `http://${value}`)) throw failure(403, 'Cross-origin access is unavailable.');
    const supplied = /^Bearer ([\w-]{43})$/i.exec(request.headers.authorization || '')?.[1];
    if (!token || !supplied || !timingSafeEqual(digest(supplied), digest(token))) throw failure(401, 'A valid bearer token is required.', 'authentication_error');
  }
  async function closeSession(id) { const session = sessions.get(id); if (!session) return; sessions.delete(id); for (const operation of session.calls.values()) operation.abort(new Error('External session closed')); await session.context.close(); changed(); }
  function fence(lifetime) {
    lifetime.controller.signal.throwIfAborted();
    if (server !== lifetime.server || !server?.listening || lifetime.request.aborted || lifetime.response.destroyed || lifetime.request.socket.destroyed) throw failure(503, 'Endpoint stopped or client disconnected.');
  }
  function operation(lifetime, session) {
    fence(lifetime);
    if (active.size >= maxRequests) throw failure(429, 'External request concurrency limit reached.', 'rate_limit_error');
    const controller = lifetime.controller, id = randomUUID(); active.set(id, controller); changed();
    const timer = setTimeout(() => controller.abort(new Error('External request timed out')), 10 * 60000); timer.unref?.();
    return { controller, signal: controller.signal, done() { clearTimeout(timer); active.delete(id); if (session) session.touched = Date.now(); changed(); } };
  }
  async function completion(request, response, value, lifetime) {
    let input; try { input = chatInput(value, config.model); } catch (error) { throw error.status ? error : failure(400, error.message); }
    await abortable(route(), lifetime.controller.signal); fence(lifetime);
    const op = operation(lifetime), id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000), model = config.model;
    let content = '', usage = {}, calls = [], finishReason = 'stop', sent = 0;
    const frame = async delta => {
      const payload = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null }], ...(input.includeUsage ? { usage: null } : {}) };
      if (!response.write(`data: ${JSON.stringify(payload)}\n\n`)) await once(response, 'drain', { signal: op.signal });
    };
    try {
      if (input.stream) { response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); await frame({ role: 'assistant', content: '' }); }
      await runtime.withExternalProvider({ providerId: config.providerId, model }, async provider => {
        fence(lifetime);
        const transport = new AbortController(), signal = AbortSignal.any([op.signal, transport.signal]);
        const iterator = stream({ provider: { ...provider, ...(input.maxTokens ? { compactionTokens: input.maxTokens } : {}) }, messages: input.messages, tools: input.tools, signal, host })[Symbol.asyncIterator]();
        let finished = false;
        try {
          while (true) {
            const next = await abortable(iterator.next(), signal); if (next.done) { finished = true; break; } const event = next.value;
            if (event.type === 'delta' || event.type === 'text') {
              if (typeof event.text !== 'string') throw new Error('Invalid model text');
              const previous = content; content = event.type === 'text' ? event.text : content + event.text;
              if (Buffer.byteLength(content) > outputLimit) throw new Error('Model response exceeds limit');
              // Responses can revise earlier text; buffer that adapter until its canonical output completes.
              if (input.stream && provider.kind !== 'openai-responses') { if (event.type === 'text' && !content.startsWith(previous)) throw new Error('Model revised streamed text'); await frame({ content: content.slice(sent) }); sent = content.length; }
            }
            if (event.type === 'usage') usage = { ...usage, ...cleanUsage(event.usage) };
            if (event.type === 'tool') {
              if (calls.length >= 32) throw new Error('Too many function calls');
              const tool = input.tools.find(item => item.name === event.name); if (!tool) throw new Error('Model requested an unavailable function'); validate(event.args, tool.parameters);
              if (calls.some(call => call.id === event.id)) throw new Error('Duplicate function call ID');
              calls.push({ id: typeof event.id === 'string' && event.id.length <= 200 ? event.id : randomUUID(), type: 'function', function: { name: event.name, arguments: JSON.stringify(event.args) } });
              if (Buffer.byteLength(JSON.stringify(calls)) > outputLimit) throw new Error('Function calls exceed limit');
            }
          }
        } catch (error) { if (!op.signal.aborted && error.message === 'Model output reached its token limit') finishReason = 'length'; else throw error; }
        finally { if (!finished) { transport.abort(new Error('Provider stream closed')); closeIterator(iterator); } }
      });
      op.signal.throwIfAborted();
      if (Buffer.byteLength(content) + Buffer.byteLength(JSON.stringify(calls)) > outputLimit) throw new Error('Model response exceeds limit');
      if (calls.length) finishReason = 'tool_calls';
      const measured = usageResult(usage);
      if (input.stream) {
        if (content.length > sent) await frame({ content: content.slice(sent) });
        if (calls.length) await frame({ tool_calls: calls.map((call, index) => ({ index, ...call })) });
        response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(input.includeUsage ? { usage: null } : {}) })}\n\n`);
        if (input.includeUsage && measured) response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: measured })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else json(response, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: content || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finishReason }], ...(measured ? { usage: measured } : {}) });
    } catch {
      const error = { message: op.signal.aborted ? 'Model request canceled.' : 'Model request failed.', type: 'server_error', code: op.signal.aborted ? 'request_canceled' : 'provider_error' };
      if (response.headersSent) { if (!response.destroyed) response.end(`data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`); } else json(response, op.signal.aborted ? 503 : 502, { error });
    } finally { op.done(); }
  }
  async function mcp(request, response, value, lifetime) {
    if (!record(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.length > 200 || (value.params !== undefined && !record(value.params)) || (Object.hasOwn(value, 'id') && !(typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200 || Number.isSafeInteger(value.id)))) throw failure(400, 'Invalid JSON-RPC request.');
    const notification = !Object.hasOwn(value, 'id'), params = value.params || {}, send = result => json(response, 200, { jsonrpc: '2.0', id: value.id, result });
    if (!(request.headers.accept || '').includes('application/json') || !(request.headers.accept || '').includes('text/event-stream')) throw failure(406, 'MCP requires Accept: application/json, text/event-stream.');
    if (value.method === 'initialize') {
      if (notification || request.headers['mcp-session-id'] || typeof params.protocolVersion !== 'string' || !record(params.capabilities) || !record(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') throw failure(400, 'Invalid MCP initialization.');
      if (sessions.size >= maxSessions) throw failure(429, 'External session limit reached.', 'rate_limit_error');
      const selected = await abortable(route(), lifetime.controller.signal); fence(lifetime); const op = operation(lifetime);
      try {
        const creation = Promise.resolve(runtime.createExternalSession({ projectId: config.projectId, providerId: config.providerId, model: config.model, title: 'External MCP session', toolNames: selected.toolNames, allowAutomatic: false }));
        void creation.then(context => { if (op.signal.aborted || server !== lifetime.server) return context.close(); }).catch(() => {});
        const context = await abortable(creation, op.signal);
        if (op.signal.aborted || server !== lifetime.server || !server?.listening) { await context.close(); throw failure(503, 'Endpoint stopped.'); }
        if (sessions.size >= maxSessions) { await context.close(); throw failure(429, 'External session limit reached.', 'rate_limit_error'); }
        const id = randomBytes(32).toString('base64url'), version = protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols[0];
        sessions.set(id, { context, version, initialized: false, calls: new Map(), touched: Date.now() }); changed();
        json(response, 200, { jsonrpc: '2.0', id: value.id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'Faber', version: '1.0.0' }, instructions: 'Project-bound Faber tools. Privileged operations require approval in Faber. This token cannot approve requests or inspect other chats.' } }, { 'Mcp-Session-Id': id });
      } finally { op.done(); }
      return;
    }
    const session = sessions.get(request.headers['mcp-session-id']); if (!session) throw failure(404, 'MCP session not found. Initialize a new session.');
    if ((request.headers['mcp-protocol-version'] || '2025-03-26') !== session.version) throw failure(400, 'MCP protocol version does not match this session.');
    session.touched = Date.now();
    if (notification) {
      if (value.method === 'notifications/initialized') session.initialized = true;
      else if (value.method === 'notifications/cancelled') session.calls.get(params.requestId)?.abort(new Error('Canceled by external client'));
      json(response, 202); return;
    }
    if (value.method === 'ping') { send({}); return; }
    if (!session.initialized) throw failure(400, 'Send notifications/initialized before using tools.');
    if (value.method === 'tools/list') { if (params.cursor !== undefined) { json(response, 200, { jsonrpc: '2.0', id: value.id, error: { code: -32602, message: 'Pagination cursor is invalid.' } }); return; } send({ tools: (await session.context.tools()).filter(tool => gatewayToolNames.includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) }); return; }
    if (value.method !== 'tools/call') { json(response, 200, { jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Method not found.' } }); return; }
    if (typeof params.name !== 'string' || (params.arguments !== undefined && !record(params.arguments))) { json(response, 200, { jsonrpc: '2.0', id: value.id, error: { code: -32602, message: 'Invalid tool arguments.' } }); return; }
    if (session.calls.has(value.id)) throw failure(400, 'Duplicate active request ID.');
    const available = await session.context.tools(); if (!gatewayToolNames.includes(params.name) || !available.some(tool => tool.name === params.name)) { json(response, 200, { jsonrpc: '2.0', id: value.id, error: { code: -32602, message: 'Unknown external tool.' } }); return; }
    const op = operation(lifetime, session); session.calls.set(value.id, op.controller);
    try {
      const result = await session.context.callTool({ name: params.name, args: params.arguments || {}, signal: op.signal });
      const serialized = JSON.stringify(result ?? null); if (Buffer.byteLength(serialized) > outputLimit) throw new Error('Tool result exceeds 16 MiB.');
      const image = typeof result?.image === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(result.image) ? result.image : null;
      send({ content: [{ type: 'text', text: image ? JSON.stringify({ ...result, image: '[image supplied]' }) : serialized }, ...(image ? [{ type: 'image', data: image.split(',')[1], mimeType: image.slice(5, image.indexOf(';')) }] : [])], isError: false });
    } catch { send({ content: [{ type: 'text', text: op.signal.aborted ? 'Tool request canceled.' : 'Tool request failed or was denied. Review its activity in Faber.' }], isError: true }); }
    finally { session.calls.delete(value.id); op.done(); }
  }
  async function handle(request, response, owner) {
    const controller = new AbortController(), lifetime = { controller, server: owner, request, response }; incoming.add(controller);
    const disconnect = () => { if (!response.writableFinished) controller.abort(new Error('External client disconnected')); };
    response.once('close', disconnect); request.once('aborted', disconnect);
    try {
      fence(lifetime); authorize(request);
      if (request.url === '/v1/models' && request.method === 'GET') { await abortable(route(), controller.signal); fence(lifetime); json(response, 200, { object: 'list', data: [{ id: config.model, object: 'model', created: 0, owned_by: 'faber' }] }); return; }
      if (request.url === '/v1/chat/completions' && request.method === 'POST') { await completion(request, response, await abortable(body(request), controller.signal), lifetime); return; }
      if (request.url === '/mcp') {
        if (request.method === 'DELETE') { const id = request.headers['mcp-session-id']; if (!sessions.has(id)) throw failure(404, 'MCP session not found.'); if ((request.headers['mcp-protocol-version'] || '2025-03-26') !== sessions.get(id).version) throw failure(400, 'MCP protocol version does not match this session.'); await closeSession(id); json(response, 200, {}); return; }
        if (request.method === 'GET') { json(response, 405, { error: { message: 'Standalone SSE is unavailable; use POST.' } }, { Allow: 'POST, DELETE' }); return; }
        if (request.method === 'POST') { const value = await abortable(body(request), controller.signal); fence(lifetime); await mcp(request, response, value, lifetime); return; }
      }
      throw failure(404, 'Endpoint not found.');
    } catch (error) { json(response, error.status || 503, { error: { message: error.status ? error.message : 'External endpoint is unavailable.', type: error.code || 'server_error' } }, error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="Faber"' } : {}); }
    finally { incoming.delete(controller); response.off('close', disconnect); request.off('aborted', disconnect); changed(); }
  }
  async function stop() {
    const running = server; server = null; address = null;
    for (const controller of incoming) controller.abort(new Error('External endpoint stopped'));
    const stopped = running ? new Promise(resolve => running.close(resolve)) : Promise.resolve(); running?.closeAllConnections();
    await Promise.allSettled([...sessions.keys()].map(closeSession)); await Promise.allSettled([...tasks]); await stopped; changed(); return status();
  }
  const sweeper = setInterval(() => { for (const [id, session] of sessions) if (!session.calls.size && Date.now() - session.touched > sessionIdleMs) void closeSession(id).catch(() => {}); }, 60000); sweeper.unref?.();
  return {
    request(method, params = {}) {
      if (method === 'gateway.status') { validate(params, object()); return Promise.resolve(status()); }
      const next = controlQueue.catch(() => {}).then(async () => {
        if (closed) throw new Error('Gateway is closed.');
        if (!gatewayMethods.includes(method)) throw new Error('Unknown gateway request.');
        validate(params, method === 'gateway.configure' ? configSchema : object());
        if (method === 'gateway.configure') {
          if (server || active.size) throw new Error('Stop the endpoint before changing its configuration.');
          const nextConfig = configuration({ ...config, ...params }); const previous = config; config = nextConfig;
          try { await route(); await atomicWrite(configFile, JSON.stringify(nextConfig, null, 2)); } catch (error) { config = previous; throw error; } changed(); return status();
        }
        if (method === 'gateway.stop') return stop();
        if (method === 'gateway.rotateToken') {
          if (!host.setSecret) throw new Error('Encrypted credential storage is unavailable.');
          await stop(); const replacement = randomBytes(32).toString('base64url'); await host.setSecret(secretId, replacement); token = replacement; changed(); return { ...status(), token: replacement };
        }
        if (method === 'gateway.start') {
          if (server?.listening) return status();
          await route(); if (!token) throw new Error('Create and copy a gateway token before starting.');
          if (typeof runtime.createExternalSession !== 'function' || typeof runtime.withExternalProvider !== 'function') throw new Error('This runtime does not support scoped external requests.');
          const candidate = http.createServer({ maxHeaderSize: 16384 }, (request, response) => { const task = handle(request, response, candidate); tasks.add(task); void task.finally(() => tasks.delete(task)); });
          candidate.headersTimeout = 10000; candidate.requestTimeout = 30000; candidate.keepAliveTimeout = 5000; candidate.maxHeadersCount = 32; candidate.maxConnections = 32;
          try { await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen({ host: config.bindAddress, port: config.port, exclusive: true }, () => { candidate.off('error', reject); resolve(); }); }); } catch { candidate.close(); throw new Error('Cannot bind the selected IP/port. Check that it is a local interface and the port is free.'); }
          candidate.on('error', () => { void controlQueue.then(stop).catch(() => {}); }); server = candidate; address = candidate.address(); changed(); return status();
        }
      }); controlQueue = next; return next;
    },
    async close() { if (closed) return; closed = true; clearInterval(sweeper); await controlQueue.catch(() => {}); await stop(); },
  };
}
