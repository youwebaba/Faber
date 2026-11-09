import WebSocketClient from '../desktop/vendor/ws/lib/websocket.js';
import { createHash } from 'node:crypto';
import { responsesBody, responseEvents } from './responses.mjs';

export function supportsNativeSteering(provider) {
  // Subscription-backed Responses has no verified WebSocket steering contract.
  return provider.kind === 'openai-responses' && provider.baseUrl === 'https://api.openai.com/v1' && provider.hasKey === true && provider.authKind !== 'chatgpt' && !provider.id?.startsWith('chatgpt:') && /^gpt-6(?:[.-]|$)/.test(provider.model);
}

export async function* streamResponsesWebSocket({ provider, messages, tools, signal, secret, onSteer, WebSocketImpl = WebSocketClient }) {
  signal?.throwIfAborted();
  const socket = new WebSocketImpl('wss://api.openai.com/v1/responses', { headers: { Authorization: `Bearer ${secret}` }, handshakeTimeout: 30000, followRedirects: false, perMessageDeflate: false, maxPayload: 8_000_000 });
  const queue = [], corrections = [], resumed = new Map(), outputs = new Map(), eventIds = new Map(), completedOutputs = new Map();
  let wake, failure, opened = false, responseId, terminal, queuedBytes = 0, wireResponseId, steeringTimer;
  const notify = () => { wake?.(); wake = undefined; };
  const fail = error => { failure ||= error; notify(); };
  const awaitSteering = () => {
    clearTimeout(steeringTimer);
    steeringTimer = setTimeout(() => fail(new Error('Responses steering acknowledgement or continuation timed out; the outcome is unknown. No request was replayed.')), 30000);
    steeringTimer.unref?.();
  };
  const send = value => { signal?.throwIfAborted(); if (!opened || failure) throw failure || new Error('Responses WebSocket is not open'); socket.send(JSON.stringify(value)); };
  const flush = () => {
    if (!opened || !responseId) return;
    for (const correction of corrections) if (correction.state === 'queued') {
      const input = correction.images?.length ? [{ role: 'user', content: [...(correction.text ? [{ type: 'input_text', text: correction.text }] : []), ...correction.images.map(image_url => ({ type: 'input_image', image_url, detail: 'auto' }))] }] : correction.text;
      send({ type: 'response.steer', previous_response_id: responseId, input });
      correction.state = 'sent'; correction.parent = responseId;
      awaitSteering();
    }
  };
  onSteer?.(correction => { corrections.push({ ...correction, state: 'queued' }); flush(); });
  const onOpen = () => { opened = true; notify(); };
  const onMessage = data => {
    try {
      const text = data.toString(); queuedBytes += Buffer.byteLength(text);
      if (queuedBytes > 16_000_000) throw new Error('Responses WebSocket output exceeds limit');
      const frame = JSON.parse(text);
      if (!frame || typeof frame.type !== 'string') throw new Error('Invalid Responses WebSocket event');
      if (frame.type === 'response.created' && frame.response?.id !== wireResponseId) { wireResponseId = frame.response?.id; eventIds.clear(); }
      if (Number.isSafeInteger(frame.sequence_number)) {
        const key = frame.type + '/' + frame.sequence_number, previous = eventIds.get(key), digest = createHash('sha256').update(text).digest('hex');
        if (previous === digest) { queuedBytes -= Buffer.byteLength(text); return; }
        if (previous || eventIds.size >= 100000) throw new Error('Responses WebSocket event identity changed or exceeded limit');
        eventIds.set(key, digest);
      }
      queue.push({ frame, bytes: Buffer.byteLength(text) }); notify();
    } catch (error) { fail(error); }
  };
  const onError = () => fail(new Error('Responses WebSocket failed; a steering acknowledgement may be unknown. No request was replayed.'));
  const onClose = () => fail(new Error('Responses WebSocket closed before completion; steering outcome may be unknown. No request was replayed.'));
  const abort = () => { fail(signal.reason || new Error('Responses WebSocket canceled')); socket.terminate(); };
  socket.on('open', onOpen); socket.on('message', onMessage); socket.on('error', onError); socket.on('close', onClose); signal?.addEventListener('abort', abort, { once: true });
  async function nextFrame() {
    while (!queue.length) { signal?.throwIfAborted(); if (failure) throw failure; await new Promise(resolve => { wake = resolve; }); }
    const next = queue.shift(); queuedBytes -= next.bytes; return next.frame;
  }
  const body = responsesBody({ provider, messages, tools }); delete body.stream;
  try {
    while (!opened) { if (failure) throw failure; await new Promise(resolve => { wake = resolve; }); }
    signal?.throwIfAborted(); send({ type: 'response.create', ...body });
    while (true) {
      terminal = undefined;
      const frames = async function* () {
        while (true) {
          const frame = await nextFrame();
          if (frame.type === 'response.steer.accepted') {
            const previous = corrections.find(item => item.providerId === frame.steer?.id);
            if (previous) { if (previous.parent !== frame.steer.previous_response_id) throw new Error('Steering acceptance changed its parent'); continue; }
            const correction = corrections.find(item => item.state === 'sent' && item.parent === frame.steer?.previous_response_id);
            if (!correction || typeof frame.steer?.id !== 'string') throw new Error('Unmatched steering acceptance');
            correction.state = 'accepted'; correction.providerId = frame.steer.id;
            awaitSteering();
            yield { type: 'faber.steering', id: correction.id, status: 'accepted' }; continue;
          }
          if (frame.type === 'response.steer.failed') {
            const correction = corrections.find(item => frame.steer?.id ? item.providerId === frame.steer.id : item.state === 'sent' && item.parent === frame.steer?.previous_response_id);
            if (!correction) throw new Error('Unmatched steering rejection');
            correction.state = 'failed'; yield { type: 'faber.steering', id: correction.id, status: 'failed', error: frame.error?.message || 'Provider rejected steering' };
            if (!corrections.some(item => ['sent', 'accepted'].includes(item.state))) {
              clearTimeout(steeringTimer);
              if (outputs.has(responseId)) throw new Error('Steering was rejected after the original response ended; no correction was replayed.');
            }
            continue;
          }
          if (frame.type === 'response.steer.pending') {
            const parent = frame.steer?.previous_response_id, signature = JSON.stringify(frame.required_input);
            if (resumed.has(parent)) { if (resumed.get(parent) !== signature) throw new Error('Pending steering required input changed'); continue; }
            if (frame.reason !== 'waiting_for_required_input' || !Array.isArray(frame.required_input) || !corrections.some(item => item.providerId === frame.steer?.id && item.state === 'accepted')) throw new Error('Invalid pending steering continuation');
            const pendingCalls = outputs.get(parent)?.filter(item => item.type === 'function_call') || [];
            const input = frame.required_input.map(item => {
              if (item.type !== 'function_call_output' || !pendingCalls.some(call => call.call_id === item.call_id && call.name === item.name)) throw new Error('Steering requested an unknown tool result');
              return { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify({ error: 'Action superseded by user steering before dispatch. No tool was executed.' }) };
            });
            if (new Set(input.map(item => item.call_id)).size !== input.length) throw new Error('Steering requested duplicate tool results');
            resumed.set(parent, signature); send({ type: 'response.create', ...body, previous_response_id: parent, input }); continue;
          }
          if (frame.type === 'response.created') {
            if (typeof frame.response?.id !== 'string' || !frame.response.id) throw new Error('Invalid Responses response identity');
            if (responseId && responseId !== frame.response.id) {
              for (const correction of corrections) if (correction.state === 'accepted') {
                if (frame.response.previous_response_id && frame.response.previous_response_id !== correction.parent) throw new Error('Steering continuation belongs to another response');
                correction.state = 'applied'; yield { type: 'faber.steering', id: correction.id, status: 'applied' };
              }
              if (!corrections.some(item => ['sent', 'accepted'].includes(item.state))) clearTimeout(steeringTimer);
            }
            responseId = frame.response.id; flush();
          }
          if (frame.type === 'response.output_item.done' && frame.item?.status === 'completed' && Number.isSafeInteger(frame.output_index)) {
            if (!completedOutputs.has(responseId)) completedOutputs.set(responseId, new Map());
            completedOutputs.get(responseId).set(frame.output_index, frame.item);
          }
          if (['response.completed', 'response.incomplete', 'response.failed', 'response.cancelled', 'response.canceled'].includes(frame.type)) {
            terminal = frame;
            outputs.set(frame.response?.id || responseId, frame.response?.output?.length ? frame.response.output : [...(completedOutputs.get(responseId) || [])].sort(([a], [b]) => a - b).map(([, item]) => item));
          }
          yield frame;
          if (terminal) return;
        }
      };
      for await (const event of responseEvents(frames(), provider, signal, { nativeSteering: true })) yield event;
      if (!corrections.some(item => ['sent', 'accepted'].includes(item.state))) return;
      // Accepted input belongs to the server; wait for its successor and never resend it.
      // The next parser also handles required-input events after a terminal response.
    }
  } finally {
    clearTimeout(steeringTimer);
    onSteer?.(undefined); signal?.removeEventListener('abort', abort);
    socket.removeListener('open', onOpen); socket.removeListener('message', onMessage); socket.removeListener('close', onClose);
    socket.terminate();
  }
}
