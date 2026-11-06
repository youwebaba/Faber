import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function runInstalledSmoke({runtime,modelHub,extensions,host,dataDir,sourceDir}) {
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir,'boot-state.json'),'utf8')).phase,'ready','Installed smoke must wait for the real renderer readiness handshake');
  const {version}=globalThis.__FABER_BOOTSTRAP__,marker=path.join(dataDir,'installer-fixture.json');let prior;
  try{prior=JSON.parse(await fs.readFile(marker,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!prior){
    const folder=path.join(dataDir,'fixture-project');await fs.mkdir(folder);const project=await runtime.request('project.create',{name:'Preserved installer fixture',path:folder});
    const chat=await runtime.request('chat.create',{projectId:project.id,title:'Preserved installer chat'});
    await runtime.request('provider.save',{id:'installer-fixture',name:'Isolated fixture connection',kind:'openai',baseUrl:'http://127.0.0.1:1/v1',model:'fixture',apiKey:'fake-installer-smoke-key'});
    const models=`${dataDir}-models`;await fs.mkdir(models);await fs.writeFile(path.join(models,'retained-model.bin'),'fixture model retention');await modelHub.request('models.settings.save',{downloadDirectory:models});
    await extensions.install({id:'installer-fixture',source:"export const manifest={schemaVersion:1,id:'installer-fixture',name:'Installer fixture',version:'1.0.0',actions:[]};export const tools=[{name:'installer_fixture_read',description:'Fixture',permission:'read',parameters:{type:'object',properties:{},additionalProperties:false},execute:()=>({ok:true})}];"});
    prior={firstVersion:version,firstSource:sourceDir,projectId:project.id,chatId:chat.id,models};await fs.writeFile(marker,JSON.stringify(prior));await fs.writeFile(path.join(sourceDir,'.retained-source-fixture'),'approved source workbench retained');
  }
  const state=await runtime.request('state.get');assert.equal(state.projects.find(p=>p.id===prior.projectId).name,'Preserved installer fixture');assert.equal(state.chats.find(c=>c.id===prior.chatId).title,'Preserved installer chat');
  assert.equal(await host.getSecret('installer-fixture'),'fake-installer-smoke-key');assert.ok(state.tools.some(t=>t.name==='installer_fixture_read'));
  assert.equal((await modelHub.request('models.state')).downloadDirectory,prior.models);assert.equal(await fs.readFile(path.join(prior.models,'retained-model.bin'),'utf8'),'fixture model retention');
  assert.equal(await fs.readFile(path.join(prior.firstSource,'.retained-source-fixture'),'utf8'),'approved source workbench retained');
  if(version!==prior.firstVersion)assert.notEqual(sourceDir,prior.firstSource);
  const report={ok:true,version,dataDir,sourceDir,firstVersion:prior.firstVersion,rendererReady:true,oldWorkbenchRetained:true,projectsRetained:true,chatsRetained:true,encryptedFixtureKeyRetained:true,addonRetained:true,modelFolderRetained:true,noInference:true};
  const reportPath=path.join(dataDir,`installer-${version}-report.json`);await fs.writeFile(reportPath,JSON.stringify(report,null,2));return {...report,reportPath};
}
