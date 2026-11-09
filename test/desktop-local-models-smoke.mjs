import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import {scanLocalModels} from '../local-models/library.mjs';
import {readGGUFMetadata} from '../local-models/details.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function createLocalModelSmoke(dataDir, modelHub) {
  const directory = path.join(path.dirname(dataDir), `${path.basename(dataDir)}-models`); await fs.mkdir(directory);
  const header = Buffer.alloc(24); header.write('GGUF'); header.writeUInt32LE(3, 4);
  for (const name of ['Fixture-Q4_K_M.gguf', 'Failure-Q4_K_M.gguf', 'Split-Q8_0-00001-of-00002.gguf', 'mmproj-Fixture.gguf','MtpTarget-Q8_0.gguf','MtpDraft-Q4_K_M.gguf']) await fs.writeFile(path.join(directory, name), header);
  const tensorHeader=Buffer.from(JSON.stringify({'model.layers.0.self_attn.q_proj.weight':{dtype:'F32',shape:[32,32],data_offsets:[0,4096]}})),tensorPrefix=Buffer.alloc(8);tensorPrefix.writeBigUInt64LE(BigInt(tensorHeader.length));
  await fs.writeFile(path.join(directory,'model.safetensors'),Buffer.concat([tensorPrefix,tensorHeader,Buffer.alloc(4096)]));
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({model_type:'llama',num_hidden_layers:2,hidden_size:32,num_attention_heads:2,num_key_value_heads:2,max_position_embeddings:256}));await fs.writeFile(path.join(directory,'tokenizer.json'),'{}');
  await modelHub.request('models.settings.save', { downloadDirectory: directory });
  const native=(await scanLocalModels({directory})).models.find(model=>model.format==='safetensors');await fs.mkdir(path.join(dataDir,'local-models'),{recursive:true});await fs.writeFile(path.join(dataDir,'local-models','state.json'),JSON.stringify({version:1,providerId:null,loadProfiles:{[native.id]:{mode:'future_fixture_precision',opaque:{keep:true}}}}));
  const children = [], script = fileURLToPath(new URL('./desktop-local-models.fixture.mjs', import.meta.url)),nativeScript=fileURLToPath(new URL('./desktop-safetensors.fixture.mjs',import.meta.url));
  const fixtureExecutable=await fs.realpath(process.execPath); // Trusted Electron dependency caches may use a junction.
  return { directory, children, options: { executable: process.execPath,safetensorsExecutable:fixtureExecutable,safetensorsVerify:async()=>true, pollMs: 50, loadTimeoutMs: 15000,
    speculationReader:(filename,options)=>path.basename(filename).startsWith('Mtp')?Promise.resolve({complete:true,architecture:'qwen35',splitCount:null,tensors:['eh_proj','enorm','hnorm','shared_head_norm'].map(part=>({name:`blk.24.nextn.${part}.weight`,elements:1024}))}):readGGUFMetadata(filename,options),
    spawnImpl: (_executable, args, options) => { const child = spawn(process.execPath, [args.length===2?nativeScript:script, ...args], { ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' } }); children.push(child); return child; },
  } };
}
export async function runLocalModelSmoke({ window, runtime, localModels, chat, dataDir, fixture }) {
  window.webContents.on('console-message',event=>{if(event.level==='error'||event.level>=2)console.error('Model fixture renderer:',event.message);});
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = async (predicate, label) => { const until = Date.now() + 20000; while (Date.now() < until) { if (await predicate()) return; await pause(75); } const diagnostic=await evaluate(`JSON.stringify({selected:document.querySelector('#chat-local-model')?.value,status:document.querySelector('#local-model-status')?.textContent,error:document.querySelector('#local-model-error')?.textContent,startDisabled:document.querySelector('#local-model-start')?.disabled,stopDisabled:document.querySelector('#local-model-stop')?.disabled})`);throw new Error(`Timed out: ${label}; ${diagnostic}`); };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (selector, value) => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));if(node.value!==${JSON.stringify(value)})throw new Error('Selection changed synchronously: '+${JSON.stringify(selector)}+' -> '+node.value);})()`);
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
  const native=(await state()).models.find(item=>item.format==='safetensors');assert.equal(native.available,true,native.reason);
  await change('#chat-local-model',`download:${native.id}`);await wait(()=>evaluate(`document.querySelector('#local-model-start').disabled&&document.querySelector('#local-model-quantization').value===''&&document.querySelector('.native-precision').textContent.includes('unsupported in this version')`),'unknown profile requires supported selection');await change('#local-model-quantization','q4_0');await wait(()=>evaluate(`!document.querySelector('#local-model-start').disabled`),'native Start enabled after profile choice');
  await evaluate(`(()=>{const slider=document.querySelector('#local-model-precision');slider.value='1';slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(()=>evaluate(`document.querySelector('#local-model-quantization').value==='q5_0'&&document.querySelectorAll('#local-model-fit tr').length===4`),'precision slider and three resource estimates');
  assert.equal(await evaluate(`document.querySelector('#local-model-quantization option[value="q10_0"]').disabled`),true);await evaluate(`document.querySelector('.native-precision').scrollIntoView({block:'start'})`);const fitScreenshot=await capture('native-fit-before-start.png');await click('#local-model-start');
  await wait(async()=>(await state()).process.status==='ready','native ready');const nativeReady=(await state()).process;assert.equal(nativeReady.observed.backend,'cpu');
  assert.deepEqual(nativeReady.quantization,{mode:'q5_0'});assert.equal(nativeReady.observed.quantization.accepted,true);assert.equal(nativeReady.observed.precision.verified,true);
  assert.notEqual((await runtime.request('state.get')).chats.find(item=>item.id===chat.id).model,nativeReady.model);
  await wait(()=>evaluate(`!document.querySelector('#chat-use-model').disabled`),'native Use enabled');await click('#chat-use-model');
  await runtime.request('chat.send',{chatId:chat.id,text:'Check controlled native transport'});
  await wait(async()=>!(await runtime.request('state.get')).runs.some(run=>run.chatId===chat.id&&['running','waiting_approval'].includes(run.status)),'native chat finished');
  assert.ok((await runtime.request('state.get')).chats.find(item=>item.id===chat.id).messages.some(message=>message.role==='assistant'&&message.content==='Controlled native reply'));
  await click('#model-picker');await change('#chat-connection','__local_files__');await wait(()=>evaluate(`!!document.querySelector('#chat-local-model option[value="download:${native.id}"]')`),'native model reopened');await change('#chat-local-model',`download:${native.id}`);await wait(()=>evaluate(`!document.querySelector('#local-model-stop')?.disabled`),'native Stop enabled');await click('#local-model-stop');await wait(async()=>(await state()).process.status==='stopped','native stopped');
  await runtime.request('chat.update',{id:chat.id,grants:['computer']});await runtime.request('tool.run',{chatId:chat.id,name:'local_model_start',args:{modelId:native.id}});await wait(async()=>(await state()).process.status==='ready','agent native Start');
  assert.deepEqual((await state()).process.quantization,{mode:'q5_0'},'Agent default Start restores the successful per-model profile');
  await runtime.request('tool.run',{chatId:chat.id,name:'local_model_stop',args:{}});await wait(async()=>(await state()).process.status==='stopped','agent native Stop');
  const mtpTarget=(await state()).models.find(item=>item.relativePath==='MtpTarget-Q8_0.gguf'),mtpDraft=(await state()).models.find(item=>item.relativePath==='MtpDraft-Q4_K_M.gguf');
  assert.equal((await localModels.request('localModels.details',{modelId:mtpTarget.id})).speculation.nativeMtp.supported,true);await evaluate(`new Promise(resolve=>{const dialog=document.querySelector('dialog[open]');dialog.addEventListener('close',()=>resolve(true),{once:true});dialog.close();})`);await click('#model-picker');await change('#chat-connection','__local_files__');await wait(()=>evaluate(`!!document.querySelector('#chat-local-model option[value="download:${mtpTarget.id}"]')`),'MTP model reopened');
  await change('#chat-local-model',`download:${mtpTarget.id}`);await wait(()=>evaluate(`!document.querySelector('#local-model-speculation option[value="native_mtp"]').disabled`),'native MTP capability');await change('#local-model-speculation','native_mtp');await evaluate(`(()=>{const count=document.querySelector('#local-model-spec-tokens');count.value='0';count.dispatchEvent(new Event('input',{bubbles:true}));})()`);assert.equal(await evaluate(`document.querySelector('#local-model-start').disabled`),true);await change('#local-model-speculation','off');await wait(()=>evaluate(`!document.querySelector('#local-model-start').disabled&&document.querySelector('#local-model-spec-tokens').value==='3'`),'Off restores valid disabled token count');await change('#local-model-speculation','native_mtp');await evaluate(`(()=>{const count=document.querySelector('#local-model-spec-tokens');count.value='4';count.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('#local-model-start');await wait(async()=>(await state()).process.status==='ready','picker native MTP ready');assert.equal((await state()).process.observed.speculation.tokens,4);await wait(()=>evaluate(`document.querySelector('#local-model-speculation-effective').textContent.includes('draft-mtp')`),'visible effective MTP');await click('#local-model-stop');await wait(async()=>(await state()).process.status==='stopped','picker MTP Stop');
  await runtime.request('tool.run',{chatId:chat.id,name:'local_model_configure',args:{mode:'cpu',gpuIds:[],cpuIds:[],threads:2,memoryMap:true}});await change('#local-model-speculation','draft_model');await change('#local-model-draft',mtpDraft.id);await wait(()=>evaluate(`!document.querySelector('#local-model-start').disabled`),'separate draft Start enabled');await click('#local-model-start');await wait(async()=>(await state()).process.status==='ready','picker separate draft ready');assert.equal((await state()).process.observed.speculation.draft.id,mtpDraft.id);await click('#local-model-stop');await wait(async()=>(await state()).process.status==='stopped','picker draft Stop');
  assert.ok(!(await fs.readdir(fixture.directory)).some(name=>name.startsWith('.faber-safetensors-')));
  const nativeScreenshot=await capture('local-safetensors-ready-stop.png');
  assert.ok(fixture.children.every(child => child.exitCode !== null || child.signalCode));
  assert.ok(!(await fs.readdir(path.join(dataDir, 'local-models'))).some(name => name.endsWith('.key')));
  const report = { ok: true, realRenderer: true, controlledChildProcesses: fixture.children.length, registeredTools: 3, explicitSelection: true, startReadyStop: true, cancelLoading: true, incompatibleError: true, keyFilesRemoved: true, nativePickerStartUseStop:true,nativeChatThroughPrivatePipe:true,nativeAgentTools:true,nativeStagingRemoved:true, readyScreenshot, failureScreenshot,nativeScreenshot };
  report.nativeSlider=true;report.nativeThreeResourceEstimates=true;report.nativeEffectivePrecision=true;report.fitScreenshot=fitScreenshot;
  report.nativeMtpPicker=true;report.separateDraftPicker=true;report.speculationTokenCount=true;report.effectiveSpeculation=true;
  const reportPath = path.join(dataDir, 'local-model-smoke-report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); return { ...report, reportPath };
}
