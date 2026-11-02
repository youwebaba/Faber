export function estimateInputTokens(body){
  const text=JSON.stringify(body,(key,value)=>key==='encrypted_content'||(key==='images'&&Array.isArray(value))||(typeof value==='string'&&value.startsWith('data:image/'))?'[not included in token estimate]':value);
  return Math.ceil(text.length/4);
}
export const estimateBasis='Approximate serialized text and tool schema characters / 4; images and opaque reasoning excluded. Not a tokenizer or capacity guarantee.';

export function callMetrics({started,firstToken,characters=0,usage={},timing={},estimatedInputTokens,capacityTokens},at=performance.now()){
  const elapsedMs=Math.max(0,at-started),estimatedOutputTokens=Math.ceil(characters/4);
  const metrics={estimatedInputTokens,estimateBasis,estimatedOutputTokens,elapsedMs,capacityTokens:capacityTokens??null,tokensPerSecondEstimated:true,tokensPerSecondBasis:'character-estimate'};
  for(const key of ['inputTokens','outputTokens'])if(Number.isSafeInteger(usage[key])&&usage[key]>=0)metrics[key]=usage[key];
  if(firstToken!==undefined)metrics.firstTokenMs=Math.max(0,firstToken-started);
  const seconds=elapsedMs/1000;
  if(metrics.outputTokens!==undefined){
    const evalMs=Number.isFinite(timing.generationMs)&&timing.generationMs>0?timing.generationMs:null;
    if(evalMs){metrics.generationMs=evalMs;metrics.tokensPerSecond=metrics.outputTokens/(evalMs/1000);metrics.tokensPerSecondBasis='provider-eval';}
    else if(seconds>0){metrics.tokensPerSecond=metrics.outputTokens/seconds;metrics.tokensPerSecondBasis='wall-clock';}
    metrics.tokensPerSecondEstimated=false;
  }else if(characters&&seconds>0)metrics.tokensPerSecond=estimatedOutputTokens/seconds;
  return metrics;
}
