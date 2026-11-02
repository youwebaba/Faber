// These are provider parameters, never transcript retention or output-token limits.
export const contextTokensSchema = {anyOf:[{type:'integer',minimum:1,maximum:2147483647},{type:'null'}]};
export const thinkingSchema = {anyOf:[{type:'boolean'},{type:'null'}]};

export function providerControls(provider, declared) {
  let context={configurable:false,mode:'fixed',capacityTokens:null,reason:'This API does not expose a configurable context capacity.'};
  let thinking={supported:false,mode:'unsupported',effective:null,reason:'A thinking-off parameter is not declared for this model.'};
  if(provider.kind==='ollama'){
    context={configurable:true,mode:'ollama',capacityTokens:null};
    thinking={supported:true,mode:'ollama',effective:null,reason:'Boolean thinking is model-dependent; the Ollama server validates support. Default uses the model setting.'};
  }
  // Only the owning host may identify a managed llama.cpp endpoint. A URL or name is not proof.
  if(provider.kind==='openai'&&declared?.context?.mode==='managed'){
    context={configurable:declared.context.configurable!==false,mode:'managed',capacityTokens:Number.isSafeInteger(declared.context.capacityTokens)&&declared.context.capacityTokens>0?declared.context.capacityTokens:null,requiresRestart:true};
    if(declared.thinking?.supported&&declared.thinking.mode==='llama_cpp')thinking={supported:true,mode:'llama_cpp',effective:null,reason:'The selected GGUF chat template must support enable_thinking.'};
  }
  // Official model documentation explicitly excludes none for Astra and 6.1 Sol.
  // https://developers.openai.com/api/docs/guides/latest-model
  if(provider.kind==='openai-responses'&&new URL(provider.baseUrl).origin==='https://api.openai.com'&&['gpt-6.1-terra','gpt-6-sol','gpt-6-luna'].includes(provider.model)){
    thinking={supported:true,mode:'responses',effective:provider.reasoningEffort?provider.reasoningEffort!=='none':null};
  }
  return {context,thinking};
}

export function configuredControls(provider, chat, declared, check=true) {
  const controls=providerControls(provider,declared),contextTokens=chat.contextTokens??null,thinking=chat.thinking??null;
  if(check&&contextTokens!==null&&!controls.context.configurable)throw new Error('This provider has a fixed context capacity; reset the chat context to provider default.');
  if(check&&thinking!==null&&!controls.thinking.supported)throw new Error('Thinking on/off is unsupported for this provider/model; use provider default.');
  return {...controls,contextTokens,thinking:{...controls.thinking,selected:thinking,effective:thinking??controls.thinking.effective}};
}
