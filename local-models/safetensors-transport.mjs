const limit = 16 * 1024 * 1024;

// The worker receives only inherited stdio; this adapter never opens an upstream socket.
export function createSafetensorsTransport({quantization={mode:'none'}}={}) {
  let child, pending = Buffer.alloc(0), ready = false,handshake, closed = false, sequence = 0, active, paused = false, queue = Promise.resolve();
  function send(value) {
    const body = Buffer.from(JSON.stringify(value)); if (body.length > limit) throw new Error('Native request exceeds the pipe frame limit');
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length); child.stdin.write(Buffer.concat([header, body]));
  }
  function finish(error) {
    if (!active) return;
    const request = active; active = undefined;
    request.signal?.removeEventListener('abort', request.abort);
    if (error) { if (!request.canceled) { request.controller?.error(error); request.reject(error); } }
    else if (!request.canceled) {
      if (request.controller) { request.controller.enqueue(Buffer.from('data: [DONE]\n\n')); request.controller.close(); }
      else request.resolve(Response.json(request.result || { model:'worker-model',object:'chat.completion',choices:[{index:0,message:request.message,finish_reason:request.finishReason}],usage:request.usage }));
    }
    request.release();
  }
  function fail(error) { closed = true; ready = false; finish(error); }
  function accept(frame) {
    if (frame.kind === 'ready') { if (frame.protocol !== 2 || frame.model !== 'worker-model' || frame.backend !== 'cpu'||JSON.stringify(frame.quantization)!==JSON.stringify(quantization)) throw new Error('Native worker did not confirm the selected load profile');handshake={quantization:{...quantization,accepted:true,precision:'layer-dependent'}}; ready = true; return; }
    if (!active || frame.id !== active.id) throw new Error('Unexpected native worker request identity');
    if (frame.kind === 'error') { finish(new Error(String(frame.message || 'Native model request failed').slice(0,1500))); return; }
    if (frame.kind === 'done') { finish(); return; }
    if (active.canceled) return;
    if (frame.kind === 'result') { active.result = frame.value; return; }
    if (frame.kind !== 'chunk' || !frame.value || typeof frame.value !== 'object') throw new Error('Unexpected native worker response');
    if (active.controller) {
      active.controller.enqueue(Buffer.from(`data: ${JSON.stringify(frame.value)}\n\n`));
      if (active.controller.desiredSize <= 0) { paused = true; child.stdout.pause(); }
    } else {
      const choice = frame.value.choices?.[0];
      if (choice?.delta?.content) active.message.content += choice.delta.content;
      if (choice?.delta?.reasoning_content) active.message.reasoning_content = (active.message.reasoning_content || '') + choice.delta.reasoning_content;
      if (choice?.delta?.tool_calls?.length) { active.message.tool_calls ||= []; for (const call of choice.delta.tool_calls) { const index = call.index ?? 0, old = active.message.tool_calls[index]; if (!old) active.message.tool_calls[index] = structuredClone(call); else { if (call.id) old.id = call.id; if (call.function?.name) old.function.name = call.function.name; if (call.function?.arguments) old.function.arguments += call.function.arguments; } } }
      if (choice?.finish_reason) active.finishReason = choice.finish_reason;
      if (frame.value.usage) active.usage = frame.value.usage;
      if (Buffer.byteLength(JSON.stringify(active.message)) > limit) throw new Error('Native completion exceeds the response limit');
    }
  }
  function pump() {
    try {
      while (!paused && pending.length >= 4) {
        const length = pending.readUInt32LE(); if (!length || length > limit) throw new Error('Native worker exceeded its frame limit');
        if (pending.length < length + 4) break;
        const frame = pending.subarray(4,length+4); pending = pending.subarray(length+4); accept(JSON.parse(frame.toString('utf8')));
      }
    } catch (error) { fail(error); child?.kill(); }
  }
  const resume = () => { paused = false; pump(); if (!paused) child?.stdout.resume(); };
  return {
    observed(){if(!ready)throw new Error('Native load profile is not confirmed');return structuredClone(handshake);},
    attach(process) {
      child = process; child.stdout.on('data', bytes => { if (pending.length + bytes.length > limit + 1024*1024) { fail(new Error('Native pipe buffer exceeded limit')); child.kill(); return; } pending = Buffer.concat([pending,bytes]); pump(); });
      child.once('error',fail); child.once('close',()=>fail(new Error('Native worker exited')));
      child.stdin.on('error',fail);
    },
    async fetch(url, options = {}) {
      if (closed) throw new Error('Native worker is stopped');
      const route = new URL(url).pathname;
      if (route === '/v1/models') return ready ? Response.json({ data:[{id:'worker-model'}] }) : Response.json({error:'loading'},{status:503});
      if (!['/v1/chat/completions','/v1/completions'].includes(route)) throw new Error('Unsupported native worker method');
      const previous = queue; let release; queue = new Promise(resolve=>release=resolve); await previous;
      if (closed || options.signal?.aborted) { release(); throw options.signal?.reason || new Error('Native worker stopped'); }
      let body;try{body=JSON.parse(options.body);body.model='worker-model';}catch(error){release();throw error;}
      const request = { id:++sequence,release,signal:options.signal,canceled:false,message:{role:'assistant',content:''},finishReason:'stop',resolve:()=>{},reject:()=>{} }; active = request;
      request.abort = () => { if (active !== request || request.canceled) return; request.canceled=true; request.controller?.error(options.signal?.reason || new Error('Native request canceled')); request.reject(options.signal?.reason || new Error('Native request canceled')); send({kind:'cancel',id:request.id}); resume(); };
      options.signal?.addEventListener('abort',request.abort,{once:true});
      let result;
      if (body.stream) {
        const stream = new ReadableStream({start(controller){request.controller=controller;},pull:resume,cancel(){request.abort();}});
        result = new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
      } else result = new Promise((resolve,reject)=>{request.resolve=resolve;request.reject=reject;});
      try { send({kind:'generate',id:request.id,body}); } catch(error) { finish(error); throw error; }
      if (options.signal?.aborted) request.abort(); return result;
    },
    close() { fail(new Error('Native worker stopped')); child?.stdin?.end(); },
  };
}
