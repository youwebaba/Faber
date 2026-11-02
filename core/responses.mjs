import { validateChatImages } from './images.mjs';
import { providerUsage } from './usage.mjs';

export function responsesInput(messages, provider) {
  const input = [], images = [];
  const flush = () => input.push(...images.splice(0));
  for (const message of messages) {
    if (message.role !== 'tool') flush();
    const saved = message.providerOutput;
    if (message.role === 'assistant' && saved?.kind === 'openai-responses' && saved.providerId === provider.id && saved.baseUrl === provider.baseUrl && saved.model === provider.model) {
      input.push(...structuredClone(saved.items));
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content || '' });
    } else {
      if (message.role === 'user' && message.images?.length) {
        validateChatImages(message.images);
        input.push({ role: 'user', content: [...(message.content ? [{ type: 'input_text', text: message.content }] : []), ...message.images.map(image_url => ({ type: 'input_image', image_url, detail: 'auto' }))] });
      } else if (message.content) input.push({ role: message.role, content: message.content });
      for (const call of message.toolCalls || []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
    }
    if (message.image) images.push({ role: 'user', content: [{ type: 'input_text', text: `Screenshot from ${message.toolName || 'tool'}` }, { type: 'input_image', image_url: message.image, detail: 'auto' }] });
  }
  flush(); return input;
}

export function responsesBody({ provider, messages, tools }) {
  return {
    model: provider.model, input: responsesInput(messages, provider), stream: true, store: false,
    include: ['reasoning.encrypted_content'],
    ...(provider.reasoningEffort ? { reasoning: { effort: provider.reasoningEffort } } : {}),
    tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
  };
}

export async function* responseEvents(frames, provider, signal) {
  let text = '', completed = false;
  for await (const frame of frames) {
    signal?.throwIfAborted();
    const usage = providerUsage(frame.response?.usage, 'openai-responses');
    if (Object.keys(usage).length) yield { type: 'usage', usage };
    if (frame.type === 'response.output_text.delta' || frame.type === 'response.refusal.delta') {
      if (typeof frame.delta !== 'string') throw new Error('Provider returned an invalid text delta');
      text += frame.delta; if (text.length > 1000000) throw new Error('Model response exceeds limit');
      yield { type: 'delta', text: frame.delta };
    }
    if (frame.type === 'error' || frame.type === 'response.failed' || frame.type === 'response.incomplete' || frame.type === 'response.cancelled' || frame.type === 'response.canceled') {
      const reason = frame.response?.error?.message || frame.error?.message || frame.message || frame.response?.incomplete_details?.reason || frame.type;
      throw new Error(`Responses generation failed: ${String(reason).slice(0, 1000)}`);
    }
    if (frame.type !== 'response.completed') continue;
    const response = frame.response;
    if (response?.status !== 'completed' || !Array.isArray(response.output)) throw new Error('Responses completion was missing its complete output');
    if (JSON.stringify(response.output).length > 8_000_000) throw new Error('Responses output exceeds the supported size');
    const calls = [], ids = new Set();
    let finalText = '';
    for (const item of response.output) {
      if (!item || !['message', 'reasoning', 'function_call'].includes(item.type)) throw new Error('Provider returned an unsupported Responses output item');
      if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || !item.call_id || ids.has(item.call_id) || typeof item.name !== 'string' || typeof item.arguments !== 'string' || (item.status && item.status !== 'completed')) throw new Error('Provider returned a duplicate or incomplete function call');
        ids.add(item.call_id);
        let args; try { args = JSON.parse(item.arguments); } catch { throw new Error(`Invalid JSON arguments for tool ${item.name}`); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`Tool ${item.name} arguments must be an object`);
        calls.push({ type: 'tool', id: item.call_id, name: item.name, args });
      }
      if (item.type === 'message') {
        if (item.role !== 'assistant' || !Array.isArray(item.content) || (item.status && item.status !== 'completed')) throw new Error('Provider returned an incomplete assistant message');
        for (const part of item.content) {
          if (part.type === 'output_text') finalText += part.text || '';
          else if (part.type === 'refusal') finalText += part.refusal || '';
        }
      }
    }
    if (calls.length > 32) throw new Error('Too many tool calls in one response');
    if (text && !finalText.startsWith(text)) throw new Error('Responses terminal text differs from its streamed output');
    if (finalText.length > text.length) yield { type: 'delta', text: finalText.slice(text.length) };
    signal?.throwIfAborted();
    yield { type: 'provider_output', data: { kind: 'openai-responses', providerId: provider.id, baseUrl: provider.baseUrl, model: provider.model, items: structuredClone(response.output) } };
    for (const call of calls) yield call;
    completed = true; break;
  }
  if (!completed) throw new Error('Responses stream ended before a completed response');
}
