import { randomUUID } from 'node:crypto';
import { responsesBody, responseEvents } from './responses.mjs';
import { validateChatImages } from './images.mjs';
import { providerUsage } from './usage.mjs';

export function validateBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Provider URL must be HTTP(S), without credentials, query or fragment');
  return url.href.replace(/\/$/, '');
}

export function validateCredentialTransport(baseUrl, hasKey) {
  const url = new URL(validateBaseUrl(baseUrl));
  if (hasKey && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('API keys require HTTPS for non-loopback providers');
}

export function providerMessages(messages, kind) {
  const result = [];
  const images = [];
  const flushImages = () => { result.push(...images.splice(0)); };
  for (const message of messages) {
    if (message.role !== 'tool') flushImages();
    const item = { role: message.role, content: message.content || '' };
    if (message.role === 'user' && message.images?.length) {
      validateChatImages(message.images);
      if (kind === 'openai') item.content = [...(message.content ? [{ type: 'text', text: message.content }] : []), ...message.images.map(url => ({ type: 'image_url', image_url: { url } }))];
      else item.images = message.images.map(image => image.split(',')[1]);
    }
    if (message.toolCalls?.length) item.tool_calls = message.toolCalls.map(call => ({
      ...(kind === 'openai' ? { id: call.id, type: 'function' } : {}),
      function: { name: call.name, arguments: kind === 'openai' ? JSON.stringify(call.args) : call.args },
    }));
    if (message.role === 'tool') {
      if (kind === 'openai') item.tool_call_id = message.toolCallId;
      else item.tool_name = message.toolName;
    }
    result.push(item);
    if (message.image) {
      if (kind === 'openai') images.push({ role: 'user', content: [{ type: 'text', text: `Screenshot from ${message.toolName || 'tool'}` }, { type: 'image_url', image_url: { url: message.image } }] });
      else images.push({ role: 'user', content: 'Tool screenshot', images: [message.image.split(',')[1]] });
    }
  }
  flushImages();
  return result;
}

async function* lines(body, signal) {
  if (!body) throw new Error('Provider returned an empty response body');
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    signal?.throwIfAborted();
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 8_000_000) throw new Error('Provider stream frame too large');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

async function* sseFrames(body, signal) {
  let data = '';
  function parse() {
    if (data.trim() === '[DONE]') return { type: '[DONE]' };
    try { return JSON.parse(data); } catch { throw new Error('Provider returned malformed streaming JSON'); }
  }
  for await (const line of lines(body, signal)) {
    if (!line) { if (data) { yield parse(); data = ''; } }
    else if (line.startsWith('data:')) { data += (data ? '\n' : '') + line.slice(5).trimStart(); if (data.length > 8_000_000) throw new Error('Provider stream frame too large'); }
  }
  if (data) yield parse();
}

function redact(message, secret) { const text = String(message); return (secret ? text.split(secret).join('[redacted]') : text).slice(0, 1500); }
async function requestError(response, secret) {
  let message = response.statusText;
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const chunks = []; let size = 0;
      try { while (size < 4096) { const item = await reader.read(); if (item.done) break; const chunk = item.value.subarray(0, 4096 - size); chunks.push(chunk); size += chunk.length; } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      try { const body = JSON.parse(Buffer.concat(chunks).toString()); message = body.error?.message || body.error || message; } catch { /* Only structured provider errors are displayed. */ }
    }
  } catch { /* HTTP status remains actionable even when the error body fails. */ }
  return new Error(`Provider HTTP ${response.status}: ${redact(message || 'Request rejected', secret)}`);
}

export async function* streamProvider({ provider, messages, tools, signal, host = {}, fetchImpl = fetch }) {
  const ollama = provider.kind === 'ollama';
  const responses = provider.kind === 'openai-responses';
  validateCredentialTransport(provider.baseUrl, provider.hasKey);
  const secret = provider.hasKey ? await host.getSecret?.(provider.id) : undefined;
  if (provider.hasKey && !secret) throw new Error('Provider credential is unavailable; save the API key again');
  const connection = new AbortController();
  const timer = setTimeout(() => connection.abort(new Error('Provider connection timed out')), 30000);
  const requestSignal = signal ? AbortSignal.any([signal, connection.signal]) : connection.signal;
  let response;
  try { response = await fetchImpl(`${validateBaseUrl(provider.baseUrl)}${ollama ? '/api/chat' : responses ? '/responses' : '/chat/completions'}`, {
    method: 'POST', signal: requestSignal, redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(responses ? responsesBody({ provider, messages, tools }) : { model: provider.model, messages: providerMessages(messages, provider.kind), stream: true,
      ...(ollama ? { think: false } : {}),
      ...(!ollama ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    }),
  }); } finally { clearTimeout(timer); }
  if (!response.ok) throw await requestError(response, secret);
  if (responses) {
    try { yield* responseEvents(sseFrames(response.body, requestSignal), provider, requestSignal); }
    catch (error) { throw new Error(redact(error.message, secret), { cause: error }); }
    return;
  }
  const calls = new Map();
  let finished = false, completionError;
  for await (const line of lines(response.body, signal)) {
    if (!line.trim() || (!ollama && !line.startsWith('data:'))) continue;
    const data = ollama ? line : line.slice(5).trim();
    if (data === '[DONE]') { finished = true; break; }
    let frame;
    try { frame = JSON.parse(data); } catch { throw new Error('Provider returned malformed streaming JSON'); }
    const usage = providerUsage(ollama ? frame : frame.usage, provider.kind);
    if (Object.keys(usage).length) yield { type: 'usage', usage };
    if (frame.error) throw new Error(`Provider error: ${typeof frame.error === 'string' ? frame.error : frame.error.message || 'unknown error'}`);
    if (ollama) {
      if (frame.message?.content) yield { type: 'delta', text: frame.message.content };
      for (const call of frame.message?.tool_calls || []) {
        yield { type: 'tool', id: call.id || randomUUID(), name: call.function.name, args: call.function.arguments };
      }
      if (frame.done) finished = true;
    } else {
      const choice = frame.choices?.[0];
      if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content };
      for (const call of choice?.delta?.tool_calls || []) {
        const current = calls.get(call.index) || { id: '', name: '', arguments: '' };
        current.id += call.id || '';
        current.name += call.function?.name || '';
        current.arguments += call.function?.arguments || '';
        calls.set(call.index, current);
      }
      // The optional usage-only chunk follows finish_reason, including length.
      if (choice?.finish_reason === 'length') completionError = new Error('Model output reached its token limit');
      if (choice?.finish_reason) finished = true;
    }
  }
  if (!finished) throw new Error('Provider stream ended before completion');
  if (completionError) throw completionError;
  for (const call of calls.values()) {
    let args;
    try { args = JSON.parse(call.arguments || '{}'); } catch { throw new Error(`Invalid JSON arguments for tool ${call.name}`); }
    yield { type: 'tool', id: call.id || randomUUID(), name: call.name, args };
  }
}

export async function testProvider(provider, host = {}, fetchImpl = fetch) {
  try {
    validateCredentialTransport(provider.baseUrl, provider.hasKey);
    const secret = provider.hasKey ? await host.getSecret?.(provider.id) : undefined;
    if (provider.hasKey && !secret) throw new Error('Provider credential unavailable');
    const response = await fetchImpl(`${validateBaseUrl(provider.baseUrl)}${provider.kind === 'ollama' ? '/api/tags' : '/models'}`, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
    if (!response.ok) throw await requestError(response, secret);
    const body = await response.json();
    const models = provider.kind === 'ollama' ? body.models : body.data;
    if (!Array.isArray(models) || models.length > 5000 || models.some(item => typeof (item?.name || item?.id) !== 'string')) throw new Error('Provider returned an invalid model listing');
    return { ok: true, models: [...new Set(models.map(item => item.name || item.id))] };
  } catch (error) { return { ok: false, error: error.message }; }
}
