import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {bugReportDraft,releaseLabel} from '../core/bug-report.mjs';
import {dialog} from 'electron';
export async function runInstalledSmoke({runtime,modelHub,extensions,host,dataDir,sourceDir,window}) {
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir,'boot-state.json'),'utf8')).phase,'ready','Installed smoke must wait for the real renderer readiness handshake');
  const {version}=globalThis.__FABER_BOOTSTRAP__,marker=path.join(dataDir,'installer-fixture.json');let prior;
  assert.equal(releaseLabel,'a'+version.replace(/\.0$/,''));
  const labels=await window.webContents.executeJavaScript(`(()=>{
    document.querySelector('#open-settings').click();
    document.querySelector('button[data-settings-category="about"]').click();
    return {title:document.title,about:document.querySelector('.settings-pane h3').textContent,badge:document.querySelector('.build-label').textContent};
  })()`);
  assert.deepEqual(labels,{title:'Faber '+releaseLabel,about:'Faber '+releaseLabel,badge:releaseLabel});
  assert.equal(window.getTitle(),labels.title);
  assert.ok(bugReportDraft().title.startsWith('['+releaseLabel+']'));
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
  let mediaProbe;
  const [major,minor]=version.split('.').map(Number);
  if(major>2||major===2&&minor>=6){
    const {prepareDocumentMedia}=await import('./desktop-document-media.fixture.mjs'),js=code=>window.webContents.executeJavaScript(code,true),bridge=(method,params)=>js(`window.faber.request(${JSON.stringify(method)},${JSON.stringify(params)})`),checks=[],screenshots=[];
    async function until(check,label,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Installed media probe timeout: '+label);}
    if(!prior.mediaProjectId){const folder=await fs.mkdtemp(path.join(path.dirname(dataDir),'Faber-installed-media-')),project=await runtime.request('project.create',{name:'Installed media fixture',path:folder}),chat=await runtime.request('chat.create',{projectId:project.id,title:'Installed preview fixture'});Object.assign(prior,{mediaProjectId:project.id,mediaChatId:chat.id,mediaWorkspace:folder});await fs.writeFile(marker,JSON.stringify(prior));}
    const project=(await runtime.request('state.get')).projects.find(project=>project.id===prior.mediaProjectId),chat=(await runtime.request('state.get')).chats.find(chat=>chat.id===prior.mediaChatId);
    let retained=false;if(prior.mediaFirstRefs){for(const ref of prior.mediaFirstRefs){const value=await runtime.readMedia({chatId:chat.id,mediaId:ref.id,offset:0,length:Math.min(ref.bytes,262144)});assert.equal(value.media.revision,ref.revision);assert.equal(Buffer.from(value.data,'base64').length,ref.bytes);}const pdf=prior.mediaFirstRefs.find(ref=>ref.mimeType==='application/pdf');assert.ok((await runtime.mediaNotes('read',{chatId:chat.id,mediaId:pdf.id,revision:pdf.revision})).notes.length);retained=true;}
    await js(`document.querySelector('#close-modal').click()`);await until(()=>js(`Boolean(document.querySelector('#local-projects [data-chat-id="${chat.id}"]'))`),'media chat');await js(`document.querySelector('#local-projects [data-chat-id="${chat.id}"]').click()`);
    let chosen;const original=dialog.showSaveDialog;dialog.showSaveDialog=async()=>({canceled:false,filePath:chosen});
    try{
      const save=async(params,bytes,name)=>{chosen=path.join(project.path,name);await bridge('media.save',params);assert.deepEqual(await fs.readFile(chosen),bytes);},capture=async name=>{await fs.writeFile(path.join(dataDir,'installed-'+name+'.png'),(await window.webContents.capturePage()).toPNG());screenshots.push('installed-'+name+'.png');};
      const documents=await prepareDocumentMedia({window,runtime,chat,project,bridge,until,save,checks,capture});await documents.run('#transcript');prior.mediaFirstRefs??=documents.refs;
      let timedProbe;
      if(major>2||major===2&&minor>=7){
        const {prepareTimedMedia}=await import('./desktop-timed-media.fixture.mjs'),{webmFixture}=await import('./fixtures/media.mjs'),{mediaReferenceTree}=await import('../core/media.mjs');let priorTimedMembersRetained=false;
        if(prior.mediaTimedFirstRefs){for(const ref of prior.mediaTimedFirstRefs)for(const member of mediaReferenceTree({result:{media:ref}})){const result=await runtime.readMedia({chatId:chat.id,mediaId:member.id,length:Math.min(member.bytes,262144)});assert.equal(result.media.revision,member.revision);assert.equal(Buffer.from(result.data,'base64').length,Math.min(member.bytes,262144));}priorTimedMembersRetained=true;}
        const timed=await prepareTimedMedia({window,runtime,chat,project,bridge,until,save,checks,capture,videoBytes:await webmFixture(window)});await timed.run('#transcript');prior.mediaTimedFirstRefs??=timed.refs;timedProbe={ok:true,priorTimedMembersRetained};
      }
      await fs.writeFile(marker,JSON.stringify(prior));mediaProbe={ok:true,formats:documents.refs.map(ref=>ref.name),checks,screenshots,priorPreviewBytesAndNotesRetained:retained,...(timedProbe?{timedProbe}:{})};
    }
    finally{dialog.showSaveDialog=original;}
  }
  const report={ok:true,version,labels,dataDir,sourceDir,firstVersion:prior.firstVersion,rendererReady:true,oldWorkbenchRetained:true,projectsRetained:true,chatsRetained:true,encryptedFixtureKeyRetained:true,addonRetained:true,modelFolderRetained:true,noInference:true,...(mediaProbe?{mediaProbe}:{})};
  const reportPath=path.join(dataDir,`installer-${version}-report.json`);await fs.writeFile(reportPath,JSON.stringify(report,null,2));return {...report,reportPath};
}
