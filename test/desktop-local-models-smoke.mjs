import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function createLocalModelSmoke(dataDir, modelHub) {
  const directory = path.join(path.dirname(dataDir), `${path.basename(dataDir)}-models`); await fs.mkdir(directory);
  const header = Buffer.alloc(24); header.write('GGUF'); header.writeUInt32LE(3, 4);
  for (const name of ['Fixture-Q4_K_M.gguf', 'Failure-Q4_K_M.gguf', 'Split-Q8_0-00001-of-00002.gguf', 'mmproj-Fixture.gguf']) await fs.writeFile(path.join(directory, name), header);
  await fs.writeFile(path.join(directory, 'model.safetensors'), '{}');
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({model_type:'llama'}));await fs.writeFile(path.join(directory,'tokenizer.json'),'{}');
  await modelHub.request('models.settings.save', { downloadDirectory: directory });
  const children = [], script = fileURLToPath(new URL('./desktop-local-models.fixture.mjs', import.meta.url)),nativeScript=fileURLToPath(new URL('./desktop-safetensors.fixture.mjs',import.meta.url));
  return { directory, children, options: { executable: process.execPath,safetensorsExecutable:process.execPath,safetensorsVerify:async()=>true, pollMs: 50, loadTimeoutMs: 15000,
    spawnImpl: (_executable, args, options) => { const child = spawn(process.execPath, [args.length===1?nativeScript:script, ...args], { ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' } }); children.push(child); return child; },
  } };
}
export async function runLocalModelSmoke({ window, runtime, localModels, chat, dataDir, fixture }) {
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = async (predicate, label) => { const until = Date.now() + 20000; while (Date.now() < until) { if (await predicate()) return; await pause(75); } throw new Error(`Timed out: ${label}`); };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (selector, value) => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const state = () => localModels.request('localModels.list');
  const capture = async name => { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(100); const target = path.join(dataDir, name); await fs.writeFile(target, (await window.webContents.capturePage()).toPNG()); return target; };
  const initial = await state(), model = initial.models.find(item => item.relativePath === 'Fixture-Q4_K_M.gguf');
  assert.ok(model?.available); assert.equal(initial.models.find(item => item.relativePath.includes('Split')).available, false);
  assert.ok(!initial.models.some(item => item.relativePath.includes('mmproj')));
  const tools = (await runtime.request('state.get')).tools;
  for (const name of ['local_models_list', 'local_model_start', 'local_model_stop']) assert.ok(tools.some(tool => tool.name === name));
  await evaluate(`Array.from(document.querySelectorAll('.chat-nav')).find(node=>node.textContent.includes('Desktop smoke check')).click()`);
  await click('#model-picker'); await change('#chat-connection', '__local_files__');
  await wait(() => evaluate(`!!document.querySelector('#chat-local-model option[value="download:${model.id}"]')`), 'folder choices');
  await change('#chat-local-model', `download:${model.id}`); await wait(() => evaluate(`!document.querySelector('#local-model-start').disabled`), 'Start enabled'); await click('#local-model-start');
  await wait(async () => (await state()).process.status === 'loading', 'loading state');
  assert.equal((await runtime.request('state.get')).chats.find(item => item.id === chat.id).providerId, chat.providerId);
  await wait(async () => (await state()).process.status === 'ready', 'ready state');
  await wait(() => evaluate(`!document.querySelector('#chat-use-model').disabled`), 'Use enabled');
  window.setSize(1100, 760); await pause(100); const readyScreenshot = await capture('local-model-ready.png');
  const ready = (await state()).process; await click('#chat-use-model');
  await wait(async () => (await runtime.request('state.get')).chats.find(item => item.id === chat.id).providerId === ready.providerId, 'explicit chat selection');
  await wait(() => evaluate(`!document.querySelector('#modal').open`), 'Use closes picker');
  await click('#model-picker'); await wait(() => evaluate(`document.querySelector('#chat-connection')?.value==='__local_files__' && !document.querySelector('#local-model-stop')?.disabled`), 'managed picker reopened');
  await click('#local-model-stop'); await wait(async () => (await state()).process.status === 'stopped', 'process stopped');
  assert.ok(fixture.children.every(child => child.exitCode !== null || child.signalCode));
  await assert.rejects(runtime.request('chat.send', { chatId: chat.id, text: 'Must refuse without starting inference' }), /Start this downloaded/);
  // Stop after a new Start reaches loading: no late provider registration or orphan child.
  await change('#chat-local-model', `download:${model.id}`); await wait(() => evaluate(`!document.querySelector('#local-model-start').disabled`), 'restart enabled'); await click('#local-model-start');
  await wait(async () => (await state()).process.status === 'loading', 'second loading');
  await wait(() => evaluate(`!document.querySelector('#local-model-stop').disabled`), 'cancel control'); await click('#local-model-stop');
  await wait(async () => (await state()).process.status === 'stopped', 'loading canceled');
  const failure = initial.models.find(item => item.relativePath.startsWith('Failure'));
  await change('#chat-local-model', `download:${failure.id}`); await wait(() => evaluate(`!document.querySelector('#local-model-start').disabled`), 'failure fixture Start enabled'); await click('#local-model-start');
  await wait(async () => (await state()).process.status === 'failed', 'failure reported');
  await wait(() => evaluate(`document.querySelector('#local-model-status').textContent.includes('Controlled incompatible')`), 'visible runtime failure');
  const failureScreenshot = await capture('local-model-failure.png');
  const native=(await state()).models.find(item=>item.format==='safetensors');assert.equal(native.available,true);
  await change('#chat-local-model',`download:${native.id}`);await wait(()=>evaluate(`!document.querySelector('#local-model-start').disabled`),'native Start enabled');await click('#local-model-start');
  await wait(async()=>(await state()).process.status==='ready','native ready');const nativeReady=(await state()).process;assert.equal(nativeReady.observed.backend,'cpu');
  assert.notEqual((await runtime.request('state.get')).chats.find(item=>item.id===chat.id).model,nativeReady.model);
  await wait(()=>evaluate(`!document.querySelector('#chat-use-model').disabled`),'native Use enabled');await click('#chat-use-model');
  await runtime.request('chat.send',{chatId:chat.id,text:'Check controlled native transport'});
  await wait(async()=>!(await runtime.request('state.get')).runs.some(run=>run.chatId===chat.id&&['running','waiting_approval'].includes(run.status)),'native chat finished');
  assert.ok((await runtime.request('state.get')).chats.find(item=>item.id===chat.id).messages.some(message=>message.role==='assistant'&&message.content==='Controlled native reply'));
  await click('#model-picker');await change('#chat-connection','__local_files__');await wait(()=>evaluate(`!!document.querySelector('#chat-local-model option[value="download:${native.id}"]')`),'native model reopened');await change('#chat-local-model',`download:${native.id}`);await wait(()=>evaluate(`!document.querySelector('#local-model-stop')?.disabled`),'native Stop enabled');await click('#local-model-stop');await wait(async()=>(await state()).process.status==='stopped','native stopped');
  await runtime.request('chat.update',{id:chat.id,grants:['computer']});await runtime.request('tool.run',{chatId:chat.id,name:'local_model_start',args:{modelId:native.id}});await wait(async()=>(await state()).process.status==='ready','agent native Start');
  await runtime.request('tool.run',{chatId:chat.id,name:'local_model_stop',args:{}});await wait(async()=>(await state()).process.status==='stopped','agent native Stop');
  assert.ok(!(await fs.readdir(fixture.directory)).some(name=>name.startsWith('.faber-safetensors-')));
  const nativeScreenshot=await capture('local-safetensors-ready-stop.png');
  assert.ok(fixture.children.every(child => child.exitCode !== null || child.signalCode));
  assert.ok(!(await fs.readdir(path.join(dataDir, 'local-models'))).some(name => name.endsWith('.key')));
  const report = { ok: true, realRenderer: true, controlledChildProcesses: fixture.children.length, registeredTools: 3, explicitSelection: true, startReadyStop: true, cancelLoading: true, incompatibleError: true, keyFilesRemoved: true, nativePickerStartUseStop:true,nativeChatThroughPrivatePipe:true,nativeAgentTools:true,nativeStagingRemoved:true, readyScreenshot, failureScreenshot,nativeScreenshot };
  const reportPath = path.join(dataDir, 'local-model-smoke-report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); return { ...report, reportPath };
}
