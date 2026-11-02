import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const u32=value=>{const b=Buffer.alloc(4);b.writeUInt32LE(value);return b;};
const u64=value=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(value));return b;};
const ggufString=value=>Buffer.concat([u64(Buffer.byteLength(value)),Buffer.from(value)]);
function fixtureGGUF(){const metadata=[['general.architecture',8,ggufString('llama')],['general.file_type',4,u32(15)]];const tensors=[['embedding.weight',[10,20]],['output.weight',[2,3]]];return Buffer.concat([Buffer.from('GGUF'),u32(3),u64(tensors.length),u64(metadata.length),...metadata.flatMap(([key,type,value])=>[ggufString(key),u32(type),value]),...tensors.flatMap(([name,dims])=>[ggufString(name),u32(dims.length),...dims.map(u64),u32(0),u64(0)]),Buffer.alloc(4096)]);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function runFaberSmoke({window,runtime,modelHub,localModels,chat,dataDir,fixture}) {
  await fs.writeFile(path.join(fixture.directory,'Fixture-Q4_K_M.gguf'),fixtureGGUF());
  const js=code=>window.webContents.executeJavaScript(code),shots={};
  async function wait(test,label){const end=Date.now()+15000;while(Date.now()<end){if(await test())return;await pause(60);}throw new Error(`Faber smoke timeout: ${label}; ${await js("document.body.innerText")}`);}
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change=(selector,value)=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  async function capture(name){window.setSize(1100,760);await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(300);shots[name]=path.join(dataDir,`${name}.png`);await fs.writeFile(shots[name],(await window.webContents.capturePage()).toPNG());}
  const manifest={schemaVersion:1,id:'smoke-notes',name:'Fixture notes',description:'Controlled local package used only in this isolated smoke profile.',version:'1.0.0',entry:'index.mjs',hostApi:1,permissions:['read']};
  const code=`export const manifest={schemaVersion:1,id:'smoke-notes',name:'Fixture notes',version:'1.0.0',actions:[]};export const tools=[{name:'smoke_note',description:'Controlled addon fixture',permission:'read',parameters:{type:'object',additionalProperties:false,properties:{}},execute:()=>({ok:true})}];`;
  await fs.writeFile(path.join(dataDir,'faber-smoke-addon.faber-addon.json'),JSON.stringify({schemaVersion:1,manifest,files:[{path:'index.mjs',content:code}]}));
  await click('#open-addons');await click('#addons-import-file');
  await wait(()=>js(`document.querySelector('[data-addon-id="smoke-notes"] .addon-status')?.textContent.includes('Enabled')`),'imported addon');
  assert.ok((await runtime.request('state.get')).tools.some(tool=>tool.name==='smoke_note'));await capture('faber-addons');
  await click('[data-addon-id="smoke-notes"] [data-action="disable"]');await wait(()=>js(`!!document.querySelector('[data-addon-id="smoke-notes"] [data-action="enable"]')`),'disabled addon');
  assert.ok(!(await runtime.request('state.get')).tools.some(tool=>tool.name==='smoke_note'));
  await click('[data-addon-id="smoke-notes"] [data-action="enable"]');await wait(()=>js(`!!document.querySelector('[data-addon-id="smoke-notes"] [data-action="disable"]')`),'enabled addon');
  await click('[data-addon-id="smoke-notes"] [data-action="uninstall"]');await wait(()=>js(`!document.querySelector('[data-addon-id="smoke-notes"]')`),'uninstalled addon');await click('#close-modal');
  await js(`Array.from(document.querySelectorAll('.chat-nav')).find(e=>e.textContent.includes('Desktop smoke check')).click()`);
  await click('#model-picker');await change('#chat-connection','__local_files__');const hardwareModel=(await localModels.request('localModels.list')).models.find(m=>m.relativePath==='Fixture-Q4_K_M.gguf');await wait(()=>js(`!!document.querySelector('#chat-local-model option[value="download:${hardwareModel.id}"]')`),'hardware model choice');await change('#chat-local-model',`download:${hardwareModel.id}`);await wait(()=>js(`!document.querySelector('#local-hardware').hidden`),'visible hardware picker');
  await js(`document.querySelector('#local-hardware').open=true`);await wait(()=>js(`!!document.querySelector('#hardware-gpus [data-gpu-id="CUDA0"]')`),'fixture GPU');
  await change('#hardware-mode','custom');await click('#hardware-gpus [data-gpu-id="CUDA0"]');await change('#hardware-threads','2');
  await click('#hardware-save');await wait(async()=> (await localModels.request('localModels.hardware')).configuration.mode==='custom','saved hardware');
  assert.deepEqual((await localModels.request('localModels.hardware')).configuration.gpuIds,['CUDA0']);await js(`document.querySelector('#local-hardware').scrollIntoView({block:'start'})`);await capture('faber-hardware');await click('#close-modal');
  await click('#open-models');await js(`document.querySelector('#model-search-query').value='tiny';document.querySelector('#model-search-form').requestSubmit()`);
  await wait(()=>js(`document.querySelectorAll('#model-results [data-repo-id]').length>0`),'search cards');await wait(()=>js(`!document.querySelector('#model-search-form button').disabled`),'search settled');await capture('faber-model-grid');
  await click('#model-downloads-tab');await wait(()=>js(`document.querySelectorAll('#disk-library-grid [data-model-id]').length>=3`),'disk library');await capture('faber-library');
  const library=await localModels.request('localModels.list');const inspected=library.models.find(m=>m.relativePath==='Fixture-Q4_K_M.gguf');await click(`[data-model-id="${inspected.id}"] .model-card-main`);await wait(()=>js(`document.querySelector('#disk-metadata-status')?.textContent.includes('local GGUF')`),'local metadata');assert.match(await js(`document.querySelector('#disk-model-detail [data-metric="parameters"]').textContent`),/206/);assert.match(await js(`document.querySelector('#disk-model-detail [data-metric="quantization"]').textContent`),/Q4_K_M/);await capture('faber-model-details');
  const target=library.models.find(m=>m.relativePath.startsWith('Split'));
  assert.equal(target.available,false);await click(`[data-model-id="${target.id}"] [data-action="recycle-model"]`);
  await wait(async()=>!(await localModels.request('localModels.list')).models.some(m=>m.id===target.id),'fixture recycled');
  assert.equal((await fs.readdir(path.join(dataDir,'fixture-recycle'))).length,1);assert.ok((await fs.stat(path.join(fixture.directory,'Fixture-Q4_K_M.gguf'))).isFile());
  const report={ok:true,realRenderer:true,isolated:true,addonImportDisableEnableUninstall:true,hardwareConfigurationSaved:true,searchGrid:true,diskLibrary:true,offlineGGUFDetails:true,recycleAdapter:'controlled fixture move; native Recycle Bin not invoked',noInference:true,noRealModelLoad:true,screenshots:shots};
  const reportPath=path.join(dataDir,'faber-smoke-report.json');await fs.writeFile(reportPath,JSON.stringify(report,null,2));return {...report,reportPath};
}

