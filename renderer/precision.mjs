import {formatBytes,formatParameters,requestGate} from './model-helpers.mjs';

export const precisionProfiles=[['q4_0','4-bit · Q4_0'],['q5_0','5-bit · Q5_0'],['mixed_q4_q8','Mixed Q4/Q8 · decoder halves'],['q8_0','8-bit · Q8_0'],['none','Original · float32 CPU']];
export function precisionLabel(mode){return precisionProfiles.find(item=>item[0]===mode)?.[1]||mode;}
const bytes=value=>Number.isFinite(value)?formatBytes(value):'Unknown';
export function createPrecisionControls({request,el,onChange}){
  if(!document.getElementById('native-fit-style')){const link=document.createElement('link');link.id='native-fit-style';link.rel='stylesheet';link.href=new URL('./precision.css',import.meta.url).href;document.head.append(link);}
  const root=el('section','native-precision');root.hidden=true;
  const label=el('label','form-row');label.append(el('span','','Precision before Start'));const slider=el('input');slider.type='range';slider.id='local-model-precision';slider.min='0';slider.step='1';slider.setAttribute('aria-label','Safetensors precision profile');label.append(slider);
  const selectLabel=el('label','form-row');selectLabel.append(el('span','','Load profile'));const select=el('select');select.id='local-model-quantization';for(const [mode,title]of precisionProfiles){const option=el('option','',title);option.value=mode;select.append(option);}const ten=el('option','','10-bit · unavailable on this native backend');ten.value='q10_0';ten.disabled=true;select.append(ten);selectLabel.append(select);
  const chooseProfile=el('option','','Choose a supported profile');chooseProfile.value='';chooseProfile.disabled=true;select.prepend(chooseProfile);
  const scale=el('p','hint','Smaller weight budget ← → Higher precision. Stop before changing a loaded model. Original files stay unchanged.');
  const result=el('p','hint');result.id='local-model-effective-precision';
  const summary=el('p','hint');summary.setAttribute('role','status');summary.id='local-model-fit-status';
  const tableWrap=el('div','native-fit-scroll'),table=el('table','native-fit-table');table.id='local-model-fit';tableWrap.append(table);
  const caveat=el('p','hint','Native GPU/offload is unavailable: this route runs on CPU. 10-bit has no codec in the pinned native library. Q5_0 and mixed Q4/Q8 are proven alternatives. Quantized profiles create temporary private verification files during Start, then remove them before readiness. RAM and disk headroom are estimates, not allocation guarantees.');
  root.append(label,selectLabel,scale,result,summary,tableWrap,caveat);
  const drafts=new Map(),gate=requestGate();let state={},choice,fit,lastRequest,disposed=false,modes=[];
  const profile=()=>choice?.quantizationWarning&&!drafts.has(choice.id)?null:({mode:drafts.get(choice?.id)||choice?.quantization?.mode||'none'});
  function draw(){
    if(disposed)return;root.hidden=choice?.format!=='safetensors';if(root.hidden)return;
    modes=precisionProfiles.map(item=>item[0]).filter(mode=>state.runtime?.safetensors?.quantizationModes?.includes(mode));
    const selected=profile()?.mode||'';select.value=selected;for(const option of select.options)option.disabled=!modes.includes(option.value);slider.max=String(Math.max(0,modes.length-1));slider.value=String(Math.max(0,modes.indexOf(selected)));slider.setAttribute('aria-valuetext',selected?precisionLabel(selected):'Choose a supported load profile');
    select.disabled=!state.runtime?.safetensors?.available||['loading','ready','stopping'].includes(state.process?.status);slider.disabled=select.disabled||!selected;
    const same=state.process?.modelId===choice.id&&state.process.quantization?.mode===selected,observed=same?state.process.observed:null;
    const saved=choice.effectivePrecision,precision=observed?.precision||(saved?.quantization?.mode===selected&&saved.payloadId===state.runtime?.safetensors?.payloadId?saved.precision:null);
    const formats=precision?.parametersByFormat?Object.entries(precision.parametersByFormat).map(([name,count])=>`${name}: ${formatParameters(count)} parameters`).join(', '):Object.entries(precision?.formats||{}).map(([name,count])=>`${name}: ${count} tensors`).join(', ');
    result.textContent=!selected?choice.quantizationWarning:precision?.verified&&Number.isFinite(precision.effectiveBitsPerParameter)?`${observed?'Current load':'Last matching load'} verified: ${precision.effectiveBitsPerParameter.toFixed(2)} bits/parameter${precision.method==='native-uqff-verification'?' packed weight budget, including format/scale metadata':' float32 loader execution'}. Formats: ${formats}. ${precision.fallbackCount||0} format fallbacks.`:'Effective precision is pending: Start verifies actual formats for this profile and model.';
    table.replaceChildren();if(!fit){summary.textContent='Estimating weights, default context and startup workspace…';return;}
    if(!fit.available){summary.textContent=`Fit estimate unavailable: ${fit.reason}`;return;}
    summary.textContent=`CPU placement · estimated default context ${fit.defaultContextTokens?.toLocaleString()||'unknown'} tokens. Estimates include temporary startup space; observed memory is a separate sample.`;
    const head=el('tr');for(const title of ['Resource','Estimated weights / context / workspace','Capacity and headroom','Observed'])head.append(el('th','',title));table.append(head);
    for(const [key,title,color]of [['vram','Selected VRAM','green'],['ram','System RAM','orange'],['disk','SSD/HDD backing','red']]){
      const row=fit.rows[key],tr=el('tr',`native-fit-${key}`);tr.append(el('th','',`${title} (${color})`),el('td','',`Weights ${bytes(row.weights)} · Context ${bytes(row.context)} · Workspace ${bytes(row.workspace)} · Total ${bytes(row.total)}`));
      tr.append(el('td','',key==='vram'?'0 B selected; GPU placement unsupported.':`Available ${bytes(row.capacity)} · Reserved headroom ${bytes(row.headroom)}${key==='disk'?` · Additional needed ${bytes(row.additionalBytes)}`:''} · ${row.fits===null?'Fit unknown':row.fits?'Fits estimate with reserve':'Exceeds available estimate / reserve'}`));
      tr.append(el('td','',key==='vram'?'Native CPU; no GPU offload.':key==='ram'?observed?.memory?`${bytes(observed.memory.residentBytes)} process working set at readiness; context can grow.`:observed?'CPU confirmed; working set unavailable.':'Start to observe process working set.':observed?.precision?.verificationRemoved?'Verification files removed before readiness; original weights retained.':'Original files remain on disk; temporary verification workspace is additional.'));table.append(tr);
    }
  }
  const change=mode=>{if(choice){drafts.set(choice.id,mode);fit=undefined;draw();onChange();}};select.addEventListener('change',()=>change(select.value));slider.addEventListener('input',()=>change(modes[Number(slider.value)]||'none'));
  return {root,profile,ready:()=>Boolean(profile()),setContext(next,nextChoice){state=next;choice=nextChoice;if(choice?.format!=='safetensors'){gate();lastRequest=undefined;fit=undefined;draw();return;}if(!profile()){gate();lastRequest=undefined;fit={available:false,reason:choice.quantizationWarning};draw();return;}const key=JSON.stringify([choice.id,profile()]),fresh=lastRequest!==key;if(fresh){lastRequest=key;fit=undefined;}draw();if(!fresh)return;const current=gate();request('localModels.details',{modelId:choice.id,quantization:profile()}).then(value=>{if(current()&&!disposed){fit=value.nativeFit;draw();}}).catch(error=>{if(current()&&!disposed){fit={available:false,reason:error.message};draw();}});},dispose(){disposed=true;gate();}};
}
