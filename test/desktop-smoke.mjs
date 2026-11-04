import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runAttachmentSmoke } from './desktop-attachments-smoke.mjs';
import { runReasoningSliderSmoke } from './desktop-reasoning-slider-smoke.mjs';

export async function runDesktopSmoke({window,runtime,chat,dataDir,live=false}){
  const checks=[],screenshots={};
  const js=code=>window.webContents.executeJavaScript(code);
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(predicate,label,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){const value=await predicate();if(value)return value;await pause(100);}throw new Error(`Smoke timeout: ${label}`);}
  const state=()=>runtime.request('state.get');
  const click=selector=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing smoke element');e.click();return true})()`);
  await until(()=>js(`!![...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(chat.title)})`),'chat navigation');
  await js(`[...document.querySelectorAll('.chat-nav')].find(e=>e.title===${JSON.stringify(chat.title)}).click()`);
  assert.equal(await js(`document.querySelector('#chat-title').textContent`),chat.title);checks.push('Select real fixture chat through navigation DOM');
  if(!live){const attachment=await runAttachmentSmoke({window,runtime,chat,dataDir});checks.push(attachment.check); const slider=await runReasoningSliderSmoke({window,dataDir});checks.push(slider.check);Object.assign(screenshots,slider.screenshots);}
  await click('#model-picker');assert.ok(await js(`[...document.querySelectorAll('#modal input,#modal select')].some(e=>e.value==='qwen3.5:9b')`));await click('#close-modal');checks.push('Open model picker');
  await click('#open-tools');const toolCount=await js(`document.querySelectorAll('.tool-row').length`);assert.equal(toolCount,(await state()).tools.length);await click('#close-modal');checks.push(`Render all ${toolCount} registered tools`);
  async function theme(value){await click('#open-settings');await js(`(()=>{const e=document.querySelector('#modal select');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await until(()=>js(`document.documentElement.dataset.theme===${JSON.stringify(value)}`),`theme ${value}`);await click('#close-modal');await until(()=>js(`!document.querySelector('#modal').open`),'settings dialog closed');await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);await pause(100);const filename=path.join(dataDir,`smoke-${value}.png`);await fs.writeFile(filename,(await window.webContents.capturePage()).toPNG());screenshots[value]=filename;}
  async function submit(text){await js(`(()=>{const e=document.querySelector('#prompt');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#composer').requestSubmit()})()`);}
  let liveResult;
  if(live){
    await runtime.request('settings.update',{runTimeoutMs:120000});
    const before=new Set((await state()).runs.map(r=>r.id));
    await submit('This is an explicit two-tool verification. You must call project_list with {} first, even if project context is already available. Then call files_read with {"path":"hello.txt"}. Both actual tool calls are required. After both results, reply in one short sentence quoting the exact text from hello.txt. Do not change files or call any other tools.');
    const started=await until(async()=> (await state()).runs.find(r=>r.chatId===chat.id&&!before.has(r.id)),'GUI send starts local run');
    const finished=await until(async()=>{const run=(await state()).runs.find(r=>r.id===started.id);return ['completed','failed','canceled'].includes(run?.status)?run:null;},'local tool-backed reply',120000);
    assert.equal(finished.status,'completed',finished.error);
    for(const name of ['project_list','files_read'])assert.ok(finished.toolEvents.some(e=>e.name===name&&e.status==='completed'),`Missing completed ${name}`);
    const reply=(await state()).chats.find(c=>c.id===chat.id).messages.findLast(m=>m.role==='assistant'&&m.runId===started.id&&m.content)?.content;
    assert.ok(reply?.includes('Faber isolated smoke fixture'),'Reply should quote real fixture content');
    await until(()=>js(`document.querySelector('#transcript').innerText.includes('Faber isolated smoke fixture')`),'render real assistant reply');
    checks.push('DOM send → actual loopback qwen3.5:9b → project_list/files_read → rendered verified reply');
    await theme('dark');await theme('light');
    let deltaRun;const unsubscribe=runtime.subscribe(event=>{if(event.type==='delta'&&event.chatId===chat.id&&event.runId!==started.id)deltaRun=event.runId;});
    try{
      await submit('Without tools, write a very long 10000-word explanation of how to organize a fictional library. Begin immediately and continue in detail.');
      await until(()=>deltaRun,'second local generation first visible token',120000);
      await until(()=>js(`!document.querySelector('#stop-run').hidden`),'visible GUI Stop');await click('#stop-run');
      const stopped=await until(async()=>{const run=(await state()).runs.find(r=>r.id===deltaRun);return run?.status==='canceled'?run:null;},'GUI Stop cancels local generation');
      checks.push('DOM Stop cancels an actual streaming local generation');liveResult={provider:'local-ollama',model:'qwen3.5:9b',runId:started.id,toolEvents:finished.toolEvents.map(e=>({name:e.name,status:e.status})),reply,stoppedRunId:stopped.id,stopStatus:stopped.status};
    }finally{unsubscribe();}
  }else{await theme('dark');await theme('light');}
  // The bundled sample is registered directly only inside this disposable smoke runtime.
  const sample=await import('../extensions/workspace-summary.mjs');await runtime.replaceExtensionTools(sample.tools,[sample.manifest]);
  await click('#open-tools');await js(`[...document.querySelectorAll('#modal button')].find(e=>e.textContent==='Extensions').click()`);
  assert.equal(await js(`document.querySelector('.extension-actions button')?.textContent`),'Summarize workspace');
  await click('.extension-actions button');assert.equal(await js(`document.querySelector('#modal-title').textContent`),'Summarize workspace');
  await js(`[...document.querySelectorAll('#modal button')].find(e=>e.textContent==='Run tool').click()`);
  await until(()=>js(`document.querySelector('#modal-title').textContent==='Summarize workspace result'`),'extension action result');
  assert.match(await js(`document.querySelector('#modal-body').innerText`),/files/);await click('#close-modal');checks.push('Declarative extension action creates form and runs real sample tool');
  const result={ok:true,live,checks,toolCount,screenshots,liveResult};const report=path.join(dataDir,'smoke-report.json');await fs.writeFile(report,JSON.stringify(result,null,2));return {...result,report};
}
