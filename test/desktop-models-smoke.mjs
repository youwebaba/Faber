import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const repoId='fixture/tiny-model',revision='a'.repeat(40);
const weights=Buffer.alloc(128*1024,0x31),alternate=Buffer.alloc(64*1024,0x32);
const payloads=new Map([['model.safetensors',weights],['alternate.safetensors',alternate],['config.json',Buffer.from('{"model_type":"fixture"}\n')]]);
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const metadata={id:repoId,sha:revision,downloads:42,likes:3,gated:false,pipeline_tag:'text-generation',tags:['safetensors'],safetensors:{total:32768,parameters:{F32:32768}},siblings:[...payloads].map(([rfilename,bytes])=>({rfilename,size:bytes.length,lfs:{size:bytes.length,sha256:digest(bytes)}}))};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function createHubSmokeFetch(){return async(input,options={})=>{
  const url=new URL(input);
  if(url.origin!=='https://huggingface.co')throw new Error('Controlled smoke never uses external network');
  if(url.pathname==='/api/models')return Response.json([metadata]);
  if(url.pathname===`/api/models/${repoId}`||url.pathname===`/api/models/${repoId}/revision/${revision}`)return Response.json(metadata);
  const prefix=`/${repoId}/resolve/${revision}/`;
  if(!url.pathname.startsWith(prefix))throw new Error(`Unexpected controlled smoke request: ${url.pathname}`);
  const bytes=payloads.get(decodeURIComponent(url.pathname.slice(prefix.length)));if(!bytes)throw new Error('Unknown smoke fixture file');
  let offset=0,canceled=false;
  return new Response(new ReadableStream({
    async pull(controller){await pause(35);if(canceled)return;if(options.signal?.aborted){controller.error(options.signal.reason??new Error('Aborted'));return;}if(offset===bytes.length){controller.close();return;}const next=bytes.subarray(offset,offset+1024);offset+=next.length;controller.enqueue(next);},
    cancel(){canceled=true;}
  }),{headers:{'Content-Length':String(bytes.length),'Content-Type':'application/octet-stream'}});
};}

export async function runModelHubSmoke({window,modelHub,runtime,chat,dataDir}){
  const checks=[],screenshots={},js=code=>window.webContents.executeJavaScript(code);
  const state=()=>modelHub.request('models.state');
  async function until(predicate,label,timeout=15000){const started=Date.now();while(Date.now()-started<timeout){const value=await predicate();if(value)return value;await pause(60);}throw new Error(`Model smoke timeout: ${label}`);}
  const click=selector=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing model smoke selector');e.click()})()`);
  const set=async(selector,value)=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  async function capture(name){await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);await pause(80);const filename=path.join(dataDir,`${name}.png`);await fs.writeFile(filename,(await window.webContents.capturePage()).toPNG());screenshots[name]=filename;}
  async function tool(name,args,allow=[]){
    const approvals=[];const unsubscribe=runtime.subscribe(event=>{if(event.type==='approval'&&event.approval.chatId===chat.id){approvals.push(event.approval);void runtime.request('approval.resolve',{id:event.approval.id,allow:allow.includes(event.approval.permission)}).catch(()=>{});}});
    try{return {result:await runtime.request('tool.run',{chatId:chat.id,name,args}),approvals};}finally{unsubscribe();}
  }
  const names=['hf_search_models','hf_model_details','hf_download_model','hf_download_status','hf_cancel_download','hf_set_download_directory'];
  const registry=(await runtime.request('state.get')).tools;for(const name of names)assert.ok(registry.some(item=>item.name===name),`Missing AI tool ${name}`);
  await assert.rejects(tool('hf_search_models',{query:'tiny',limit:1}),/denied/i);
  const searched=await tool('hf_search_models',{query:'tiny',limit:1},['network']);assert.deepEqual(searched.approvals.map(a=>a.permission),['network']);assert.equal(searched.result.models[0].id,repoId);
  await runtime.request('chat.update',{id:chat.id,grants:['network']});
  assert.equal((await tool('hf_model_details',{repoId})).result.revision,revision);
  const agentDirectory=path.join(dataDir,'models','agent-selected');const configured=await tool('hf_set_download_directory',{downloadDirectory:agentDirectory},['files']);assert.deepEqual(configured.approvals.map(a=>a.permission),['files']);assert.equal((await state()).downloadDirectory,agentDirectory);
  assert.equal((await tool('hf_download_status',{})).result.downloadDirectory,agentDirectory);
  checks.push('All six hf_* tools share the runtime registry; search/files permissions gate real manager operations');
  const destination=path.join(dataDir,'models','selected');
  await click('#open-settings');await click('[data-settings-category="models"].nav-button');await until(()=>js(`!!document.querySelector('#model-download-directory')`),'folder setting');
  await set('#model-download-directory',destination);await click('#model-save-settings');await until(async()=> (await state()).downloadDirectory===destination,'saved folder');
  await click('#close-modal');checks.push('Settings saves the selected download folder in the real isolated manager');
  await click('#open-models');await set('#model-search-query','tiny');await js(`document.querySelector('#model-search-format').value='safetensors';document.querySelector('#model-search-form').requestSubmit()`);
  await until(()=>js(`!!document.querySelector('#model-results [data-repo-id="${repoId}"]')`),'search results');
  const listing=await js(`document.querySelector('#model-results').innerText`);assert.match(listing,/Parameters/);assert.match(listing,/VRAM estimate/);
  await click(`#model-results [data-repo-id="${repoId}"]`);await until(()=>js(`!!document.querySelector('#model-detail input[data-path="model.safetensors"]')`),'file details');
  assert.match(await js(`document.querySelector('#model-detail').innerText`),new RegExp(revision));checks.push('Search/details show parameters, size, labeled VRAM estimate and pinned revision');await capture('models-browser');
  await click('#model-detail input[data-path="model.safetensors"]');assert.match(await js(`document.querySelector('#model-selection-summary').textContent`),/^1 file selected/);
  await click('#model-download-selected');
  const active=await until(async()=> (await state()).downloads.find(job=>job.status==='downloading'&&job.downloadedBytes>0&&job.speedBytesPerSecond>0),'streamed progress and speed');
  const laterBytes=active.downloadedBytes+4096;
  await set('#model-search-query','preserve this search draft');
  await click('#open-settings');await click('[data-settings-category="models"].nav-button');const draft=path.join(dataDir,'unsaved-folder');await set('#model-download-directory',draft);
  await until(async()=> (await state()).downloads.find(job=>job.id===active.id)?.downloadedBytes>laterBytes,'later progress event');
  assert.equal(await js(`document.querySelector('#model-download-directory').value`),draft);assert.equal(await js(`document.querySelector('#model-search-query').value`),'preserve this search draft');
  await click('#close-modal');
  assert.match(await js(`document.querySelector('#model-downloads [data-id="${active.id}"] .model-job-speed').textContent`),/\/s/);
  assert.ok(await js(`document.querySelector('#model-downloads [data-id="${active.id}"] progress').value>0`));await capture('models-progress');checks.push('Real streamed transfer displays progress/speed and preserves unsaved Settings/search inputs');
  const completed=await until(async()=> (await state()).downloads.find(job=>job.id===active.id&&job.status==='completed'),'completed selected file');
  assert.equal(completed.files.length,1);const file=path.join(completed.directory,'model.safetensors');assert.equal(digest(await fs.readFile(file)),digest(weights));
  await assert.rejects(fs.access(path.join(completed.directory,'alternate.safetensors')));checks.push('Only the selected file is published, with verified on-disk SHA-256');
  await click('#model-browse-tab');await click('#model-detail input[data-path="model.safetensors"]');await click('#model-detail input[data-path="alternate.safetensors"]');await click('#model-download-selected');
  const canceling=await until(async()=> (await state()).downloads.find(job=>job.id!==completed.id&&job.status==='downloading'&&job.downloadedBytes>0),'second active download');
  await click(`#model-downloads [data-id="${canceling.id}"] [data-action="cancel-download"]`);
  const canceled=await until(async()=> (await state()).downloads.find(job=>job.id===canceling.id&&job.status==='canceled'),'GUI cancellation');
  await assert.rejects(fs.access(path.join(canceled.directory,'alternate.safetensors')));checks.push('GUI Cancel stops an in-flight stream without publishing a complete file');await capture('models-downloads');
  const agentDownload=await tool('hf_download_model',{repoId,revision,files:['alternate.safetensors']},['files']);assert.deepEqual(agentDownload.approvals.map(a=>a.permission),['files']);assert.ok(agentDownload.approvals[0].summary.includes(destination));assert.match(agentDownload.approvals[0].summary,/65536 bytes/);
  await until(async()=> (await state()).downloads.find(job=>job.id===agentDownload.result.id&&job.downloadedBytes>0),'agent-originated active transfer');
  assert.equal((await tool('hf_cancel_download',{id:agentDownload.result.id})).result.status,'canceled');assert.equal((await tool('hf_download_status',{id:agentDownload.result.id})).result.status,'canceled');
  checks.push('AI download requests fixed-destination files approval; AI status/cancel operate on the same background job');
  window.setSize(1100,760);await click('#model-browse-tab');await capture('models-browser-compact');
  await click('#open-settings');await click('[data-settings-category="models"].nav-button');await js(`document.querySelector('#model-download-settings').scrollIntoView({block:'center'})`);await capture('models-settings-compact');await click('#close-modal');
  const result={ok:true,kind:'deterministic-controlled-fetch',checks,destination,completed:{id:completed.id,file,bytes:weights.length,sha256:digest(weights)},canceled:{id:canceled.id,status:canceled.status},screenshots};
  const report=path.join(dataDir,'models-smoke-report.json');await fs.writeFile(report,JSON.stringify(result,null,2));return {...result,report};
}
