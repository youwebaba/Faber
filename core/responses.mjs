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
      } else if (message.content) input.push({ role: provider.authKind === 'chatgpt' && message.role === 'system' ? 'developer' : message.role, content: message.content });
      for (const call of message.toolCalls || []) input.push({ type: 'function_call', call_id: call.id, name: call.name, ...(provider.authKind === 'chatgpt' ? { namespace: 'faber' } : {}), arguments: JSON.stringify(call.args) });
    }
    if (message.image) images.push({ role: 'user', content: [{ type: 'input_text', text: `Screenshot from ${message.toolName || 'tool'}` }, { type: 'input_image', image_url: message.image, detail: 'auto' }] });
  }
  flush(); return input;
}

export function responsesBody({ provider, messages, tools }) {
  const thinking=provider.chatOptions?.thinking;
  const selectedEffort=provider.chatOptions?.reasoningEffort??provider.reasoningEffort;
  const effort=provider.chatOptions?.thinkingMode==='responses'&&typeof thinking==='boolean'?(thinking?(selectedEffort&&selectedEffort!=='none'?selectedEffort:provider.chatOptions?.defaultReasoningEffort||'medium'):'none'):selectedEffort;
  const functions=tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
  return {
    model: provider.model, input: responsesInput(messages, provider), stream: true, store: false,
    include: ['reasoning.encrypted_content'],
    ...(Number.isSafeInteger(provider.compactionTokens) && provider.compactionTokens > 0 ? { max_output_tokens: provider.compactionTokens } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    tools: provider.authKind==='chatgpt'&&functions.length?[{type:'namespace',name:'faber',description:'Faber local tools. Each tool keeps its normal user-granted permissions.',tools:functions}]:functions,
  };
}

export async function* responseEvents(frames, provider, signal) {
  let text = '', arrivalText = '', legacy = false, completed = false, lastProgress = '', summaryKey = '', summary = '', lastVisibleText = '', completedBytes = 0, incompleteSnapshot = false;
  const items = new Map(), completedItems = new Map(), completedIds = new Set();
  function* display(nextText) {
    signal?.throwIfAborted();
    if (nextText.length > 1000000) throw new Error('Model response exceeds limit');
    if (nextText.trim()) lastVisibleText = nextText;
    if (nextText === text) return;
    const event = nextText.startsWith(text) ? { type: 'delta', text: nextText.slice(text.length) } : { type: 'text', text: nextText };
    text = nextText; yield event;
  }
  function* progress(phase, summary) {
    signal?.throwIfAborted();
    const next = JSON.stringify([phase, summary || '']);
    if (next === lastProgress) return;
    lastProgress = next; yield { type: 'progress', phase, ...(summary ? { summary } : {}) };
  }
  for await (const frame of frames) {
    signal?.throwIfAborted();
    const usage = providerUsage(frame.response?.usage, 'openai-responses');
    if (Object.keys(usage).length) yield { type: 'usage', usage };
    if (frame.type === 'response.output_item.added') {
      const phase = frame.item?.type === 'reasoning' ? 'thinking' : frame.item?.type === 'message' ? 'responding' : frame.item?.type === 'function_call' ? 'preparing_tools' : undefined;
      if (phase) yield* progress(phase);
    }
    if (frame.type === 'response.output_item.done') {
      if (frame.item?.status !== 'completed' && !(frame.item?.type === 'reasoning' && frame.item.status === undefined)) { incompleteSnapshot = true; continue; }
      const item = frame.item, index = frame.output_index, previous = completedItems.get(index);
      if (!Number.isSafeInteger(index) || index < 0 || typeof item.id !== 'string' || !item.id ||
          (items.get(index)?.id && items.get(index).id !== item.id) ||
          (previous && (previous.id !== item.id || previous.type !== item.type)) ||
          (!previous && completedIds.has(item.id))) throw new Error('Provider returned an invalid completed output item identity');
      completedBytes += JSON.stringify(item).length - (previous ? JSON.stringify(previous).length : 0);
      if (completedBytes > 8_000_000) throw new Error('Responses output exceeds the supported size');
      completedItems.set(index, structuredClone(item)); completedIds.add(item.id);
    }
    if (frame.type === 'response.function_call_arguments.delta' || frame.type === 'response.function_call_arguments.done') yield* progress('preparing_tools');
    if (frame.type === 'response.reasoning_text.delta') yield* progress('thinking');
    if (frame.type === 'response.reasoning_summary_text.delta' || frame.type === 'response.reasoning_summary_text.done' || frame.type === 'response.reasoning_summary_part.added' || frame.type === 'response.reasoning_summary_part.done') {
      const key = JSON.stringify([frame.item_id ?? frame.output_index, frame.summary_index]);
      if (key !== summaryKey) { summaryKey = key; summary = ''; }
      const supplied = frame.type === 'response.reasoning_summary_text.delta' ? frame.delta : frame.text ?? frame.part?.text;
      // Only provider-supplied public summary previews are displayed; hidden reasoning stays opaque.
      if (typeof supplied === 'string') summary = (frame.type === 'response.reasoning_summary_text.delta' ? summary + supplied : supplied).slice(0, 2000);
      yield* progress('thinking', summary);
    }
    if (['response.output_text.delta', 'response.refusal.delta', 'response.output_text.done', 'response.refusal.done'].includes(frame.type)) {
      const done = frame.type.endsWith('.done'), kind = frame.type.startsWith('response.output_text.') ? 'output_text' : 'refusal';
      const value = done ? frame[kind === 'output_text' ? 'text' : 'refusal'] : frame.delta;
      if (typeof value !== 'string') throw new Error('Provider returned invalid streamed text');
      if (value.length > 1000000) throw new Error('Model response exceeds limit');
      for (const index of [frame.output_index, frame.content_index]) if (index !== undefined && (!Number.isSafeInteger(index) || index < 0)) throw new Error('Provider returned an invalid text part index');
      if (frame.item_id !== undefined && (typeof frame.item_id !== 'string' || !frame.item_id)) throw new Error('Provider returned an invalid text item ID');
      const indexed = frame.output_index !== undefined && frame.content_index !== undefined;
      if (indexed) {
        const item = items.get(frame.output_index) || { id: frame.item_id, parts: new Map() };
        if (item.id && frame.item_id && item.id !== frame.item_id) throw new Error('Provider changed a streamed text item ID');
        item.id ||= frame.item_id;
        const part = item.parts.get(frame.content_index) || { type: kind, text: '' };
        if (part.type !== kind) throw new Error('Provider changed a streamed text part type');
        part.text = done ? value : part.text + value;
        item.parts.set(frame.content_index, part); items.set(frame.output_index, item);
      }
      if (!done) {
        arrivalText += value; if (arrivalText.length > 1000000) throw new Error('Model response exceeds limit');
        legacy ||= !indexed;
      }
      yield* progress('responding');
      // An unindexed part snapshot cannot safely replace a multi-message stream before completion.
      if (!done || (indexed && !legacy)) yield* display(legacy ? arrivalText : [...items].sort(([a], [b]) => a - b).flatMap(([, item]) => [...item.parts].sort(([a], [b]) => a - b).map(([, part]) => part.text)).join(''));
    }
    if (frame.type === 'error' || frame.type === 'response.failed' || frame.type === 'response.incomplete' || frame.type === 'response.cancelled' || frame.type === 'response.canceled') {
      const reason = frame.response?.error?.message || frame.error?.message || frame.message || frame.response?.incomplete_details?.reason || frame.type;
      throw new Error(`Responses generation failed: ${String(reason).slice(0, 1000)}`);
    }
    if (frame.type !== 'response.completed') continue;
    const response = frame.response;
    if (response?.status !== 'completed' || !Array.isArray(response.output)) throw new Error('Responses completion was missing its complete output');
    if (!response.output.length && incompleteSnapshot) throw new Error('Responses completion included an incomplete output item snapshot');
    // A nonempty terminal list stays authoritative; an empty list uses completed snapshots.
    const output = response.output.length ? response.output : [...completedItems].sort(([a], [b]) => a - b).map(([, item]) => item);
    if (JSON.stringify(output).length > 8_000_000) throw new Error('Responses output exceeds the supported size');
    const calls = [], ids = new Set();
    let finalText = '';
    for (const item of output) {
      if (!item || !['message', 'reasoning', 'function_call'].includes(item.type)) throw new Error('Provider returned an unsupported Responses output item');
      if (item.type === 'function_call') {
        if (provider.authKind === 'chatgpt' && item.namespace !== 'faber') throw new Error('ChatGPT returned a function outside the Faber namespace');
        if (typeof item.call_id !== 'string' || !item.call_id || ids.has(item.call_id) || typeof item.name !== 'string' || typeof item.arguments !== 'string' || (item.status && item.status !== 'completed')) throw new Error('Provider returned a duplicate or incomplete function call');
        ids.add(item.call_id);
        let args; try { args = JSON.parse(item.arguments); } catch { throw new Error(`Invalid JSON arguments for tool ${item.name}`); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`Tool ${item.name} arguments must be an object`);
        calls.push({ type: 'tool', id: item.call_id, name: item.name, args });
      }
      if (item.type === 'message') {
        if (item.role !== 'assistant' || !Array.isArray(item.content) || (item.status && item.status !== 'completed')) throw new Error('Provider returned an incomplete assistant message');
        for (const part of item.content) {
          if (!part || !['output_text', 'refusal'].includes(part.type)) throw new Error('Provider returned an unsupported Responses content part');
          const value = part.type === 'output_text' ? part.text : part.refusal;
          if (typeof value !== 'string') throw new Error('Provider returned invalid completed text');
          finalText += value;
        }
      }
    }
    if (calls.length > 32) throw new Error('Too many tool calls in one response');
    if (!calls.length && !finalText.trim() && lastVisibleText) {
      yield* display(lastVisibleText);
      signal?.throwIfAborted();
      throw new Error(`Responses completion omitted completed visible output (terminal items: ${response.output.length}; completed snapshots: ${completedItems.size})`);
    }
    signal?.throwIfAborted();
    // Completed output is authoritative; indexed parts may interleave or be revised at completion.
    yield* display(finalText);
    signal?.throwIfAborted();
    yield { type: 'provider_output', data: { kind: 'openai-responses', providerId: provider.id, baseUrl: provider.baseUrl, model: provider.model, items: structuredClone(output) } };
    for (const call of calls) { signal?.throwIfAborted(); yield call; }
    signal?.throwIfAborted();
    completed = true; break;
  }
  if (!completed) throw new Error('Responses stream ended before a completed response');
}
