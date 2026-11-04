import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runB201UISmoke({ window, runtime, chat, dataDir }) {
  const screenshots = {};
  async function capture(name) {
    // A hidden Windows window can return its previous compositor frame on the first capture.
    window.webContents.invalidate(); await window.webContents.capturePage();
    await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await pause(100); const file = path.join(dataDir, `${name}.png`);
    await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots[name] = file;
  }
  const js = code => window.webContents.executeJavaScript(code), calls = [];
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (selector, value) => js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  async function wait(predicate, label) { const until = Date.now() + 10000; while (Date.now() < until) { if (await predicate()) return; await pause(50); } throw new Error(`b2.0.1 UI timeout: ${label}`); }
  await wait(() => js(`document.documentElement.dataset.uiReady==='true'`), 'renderer ready');
  await js(`document.querySelector('#modal').close()`);
  await click(`[data-chat-id="${chat.id}"]`);
  await click('#open-settings');
  assert.equal(await js(`document.querySelectorAll('.settings-categories button').length`), 9);
  assert.equal(await js(`document.querySelector('#settings-ui-scale').value`), '1');
  await capture('b201-settings');
  await change('#settings-ui-scale', '1.1');
  await wait(async () => (await runtime.request('state.get')).settings.uiScale === 1.1, 'scale persistence');
  await wait(() => Math.abs(window.webContents.getZoomFactor() - 1.1) < .001, 'host interface scale');
  await change('#settings-ui-scale', '1');
  await wait(async () => (await runtime.request('state.get')).settings.uiScale === 1, 'scale reset');
  await wait(() => Math.abs(window.webContents.getZoomFactor() - 1) < .001, 'host scale reset');
  await click('[data-settings-category="prompts"].nav-button');
  assert.equal(await js(`document.querySelectorAll('#prompt-library-preset option').length`), 7);
  await capture('b201-prompts');
  const old = (await runtime.request('state.get')).chats.find(item => item.id === chat.id).systemPrompt;
  await change('#prompt-library-preset', 'coding'); await change('#prompt-preset-text', 'Fixture coding guidance.');
  await js(`[...document.querySelectorAll('.settings-pane button')].find(node=>node.textContent==='Save preset').click()`);
  await wait(async () => (await runtime.request('state.get')).promptPresets.find(item => item.id === 'coding').text === 'Fixture coding guidance.', 'prompt saved');
  assert.equal((await runtime.request('state.get')).chats.find(item => item.id === chat.id).systemPrompt, old);
  await wait(() => js(`document.querySelector('#prompt-preset-text')?.value==='Fixture coding guidance.'`), 'prompt editor refreshed');
  await js(`[...document.querySelectorAll('.settings-pane button')].find(node=>node.textContent==='Apply to this chat').click()`);
  await wait(async () => (await runtime.request('state.get')).chats.find(item => item.id === chat.id).systemPrompt === 'Fixture coding guidance.', 'prompt snapshot applied');
  await click('[data-settings-category="about"].nav-button');
  await js(`[...document.querySelectorAll('.settings-pane button')].find(node=>node.textContent==='Report a bug').click()`);
  await wait(() => js(`!!document.querySelector('#bug-report-body')`), 'bug report draft');
  assert.match(await js(`document.querySelector('#bug-report-body').value`), /2\.0\.1/);
  assert.equal(await js(`document.querySelector('#bug-report-body').readOnly`), false);
  await click('#close-modal'); await click('#model-picker');
  assert.equal(await js(`document.querySelectorAll('[data-model-tab]').length`), 2);
  await change('#chat-connection', '__local_files__');
  assert.equal(await js(`document.querySelector('#local-model-start').textContent`), '▶');
  assert.equal(await js(`document.querySelector('#local-model-stop').textContent`), '■');
  assert.equal(await js(`document.querySelector('#local-model-start').getAttribute('aria-label')`), 'Start model');
  assert.equal(await js(`document.querySelector('#chat-prompt-preset').value`), '__current__');
  await click('[data-model-tab="openai"]');
  await wait(() => js(`!!document.querySelector('#chatgpt-sign-in')`), 'OpenAI tab');
  assert.equal(await js(`document.querySelector('#chatgpt-sign-in').textContent`), 'Continue with ChatGPT');
  assert.equal(await js(`document.querySelector('#chatgpt-model')===null`), true, 'No invented account catalog');
  await capture('b201-openai');
  await click('#close-modal'); await click('#open-settings');
  await js(`[...document.querySelectorAll('.settings-pane button')].find(node=>node.textContent==='Open quick start').click()`);
  assert.equal(await js(`document.querySelector('.claude-coming-soon').getAttribute('aria-disabled')`), 'true');
  assert.equal(await js(`document.querySelector('.claude-coming-soon').title`), 'Coming Soon');
  assert.equal(await js(`document.querySelector('.hardware-guidance').textContent.includes('CPU and GPUs')`), true);
  await capture('b201-quickstart');
  await click('#quickstart-done');
  await wait(() => js(`!document.querySelector('#modal').open`), 'quick start dismissed');

  // Exercise account-picker DOM and the selected-chat payload with a local fake
  // account service. This never opens an OAuth page or sends a model request.
  const picker = await js(`(async()=>{
    const {createChatGPTControls}=await import('./chatgpt.mjs');
    const root=document.createElement('section');document.body.append(root);
    const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
    const button=(text,fn,cls='')=>{const node=el('button',cls,text);node.addEventListener('click',()=>fn());return node;};
    const selectField=(label,options,value)=>{const wrapper=el('label','',label),input=el('select');for(const option of options){const node=el('option','',option.label);node.value=option.value;input.append(node);}input.value=value;wrapper.append(input);return{wrapper,input};};
    const account={id:'fixture-ui',providerId:'chatgpt:fixture-ui',label:'Fixture',connected:true,planEnabled:true,models:[{id:'fixture-model',name:'Fixture model',contextTokens:64000,reasoningEfforts:['low','high']},{id:'unknown-controls',name:'Unknown controls',contextTokens:null,reasoningEfforts:[]}]};
    const status={accounts:[account],activeAccountId:account.id,signIn:{status:'complete'}};
    const requests=[];let closed=false;
    const controls=createChatGPTControls({request:async(method,params)=>{requests.push({method,params});return method==='chatgpt.status'?status:{};},refresh:async()=>{},getChat:()=>({id:'fixture-chat'}),getState:()=>({providers:[]}),newChat:async()=>{},closeModal:()=>{closed=true;},el,button,selectField,actions:(...nodes)=>{const node=el('div');node.append(...nodes);return node;},createPromptChoice:()=>({root:el('div'),value:()=>({systemPromptPresetId:'coding',systemPrompt:'Fixture instructions'})}),notify:()=>{}});
    const dispose=controls.mount(root);await new Promise(resolve=>setTimeout(resolve,0));
    const capacity=root.querySelector('.model-capacity').textContent;
    let effort=root.querySelector('#chatgpt-reasoning');effort.value='high';effort.dispatchEvent(new Event('change'));
    root.querySelector('#chatgpt-use-model').click();await new Promise(resolve=>setTimeout(resolve,0));
    const model=root.querySelector('#chatgpt-model');model.value='unknown-controls';model.dispatchEvent(new Event('change'));
    const unknownDisabled=root.querySelector('#chatgpt-reasoning').disabled,unknownCapacity=root.querySelector('.model-capacity').textContent;
    dispose();root.remove();return {capacity,unknownDisabled,unknownCapacity,closed,update:requests.find(item=>item.method==='chat.update')?.params};
  })()`);
  assert.match(picker.capacity, /64,000/); assert.equal(picker.unknownDisabled, true); assert.match(picker.unknownCapacity, /not supplied/); assert.equal(picker.closed, true);
  assert.deepEqual(picker.update, { id: 'fixture-chat', providerId: 'chatgpt:fixture-ui', model: 'fixture-model', contextTokens: null, thinking: null, reasoningEffort: 'high', systemPromptPresetId: 'coding', systemPrompt: 'Fixture instructions' });
  return { b201UI: { settings: true, scale: true, prompts: true, quickStart: true, modelControls: true, chatGPTPicker: true, bugReport: true }, b201Screenshots: screenshots };
}
