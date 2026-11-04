import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFS from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {app, BrowserWindow, session, WebContentsView} from 'electron';
import {createBrowserManager} from '../desktop/browser.mjs';

const root=syncFS.mkdtempSync(path.join(os.tmpdir(),'Faber-browser-forms-'));app.setPath('userData',root);
void app.whenReady().then(async()=>{
  let browser,parking,server;const views=[],requests=[],steps=[]
  const mark=async step=>{steps.push(step);await fs.writeFile(path.join(root,'steps.json'),JSON.stringify(steps));};
  try {
    server=http.createServer((request,response)=>{requests.push(request.url);response.setHeader('Content-Type','text/html');response.end(`<!doctype html><title>Controlled form fixture</title><h1>Agent form fixture</h1><select id="choice" aria-label="Fixture choice"><option value="alpha">Alpha</option><option value="beta">Beta</option></select><a id="link" aria-label="Owned target link" target="_blank" rel="opener" href="/popup">Open owned tab</a><p id="result">Waiting</p><script>addEventListener('message',event=>{if(event.origin===location.origin&&event.data==='linked-popup')document.querySelector('#result').textContent='Opener handshake received'});if(location.pathname==='/popup'&&window.opener)window.opener.postMessage('linked-popup',location.origin);if(location.pathname==='/auto')window.open('/unsolicited');</script>`);});
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
    parking=new BrowserWindow({width:1280,height:800,useContentSize:true,show:false,focusable:false,skipTaskbar:true,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    browser=createBrowserManager({dataDir:path.join(root,'manager'),timeoutMs:5000,createView:options=>{const view=new WebContentsView(options);views.push(view);return view;},createSession:(partition,options)=>session.fromPartition(partition,options),getChat:id=>({id}),parkView:(view,size)=>{parking.contentView.addChildView(view);view.setBounds({x:0,y:0,...size});view.setVisible(true);},unparkView:view=>parking.contentView.removeChildView(view),isViewAllowed:()=>false});
    await browser.initialize();
    const chatId='agent-forms',tool=(name,args={})=>browser.tools().find(item=>item.name==='browser_'+name).execute(args,{chat:{id:chatId},signal:new AbortController().signal});
    const state=async()=>(await browser.request('browser.state')).sessions.find(item=>item.chatId===chatId);
    const wait=async(predicate,label)=>{const end=Date.now()+7000;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Form fixture timeout: '+label);};
    await tool('open',{url:base+'/main'});await wait(async()=>!(await state()).loading,'page loading finishes');await tool('screenshot');const first=(await state()).activeTabId,parent=views[0].webContents;await mark('opened actual hidden agent tab');
    let snapshot=await tool('snapshot');
    if(!process.argv.includes('--popup-only')){
    await mark('click default native select through browser tool');await tool('click',{elementId:snapshot.elements.find(item=>item.label==='Fixture choice').id});
    await mark('send ArrowDown/Enter through browser tools');await tool('key',{key:'ArrowDown'});await tool('key',{key:'Enter'});
    const selectState=await parent.executeJavaScript("({value:document.querySelector('#choice').value,focused:document.activeElement.id,documentFocused:document.hasFocus()})");await fs.writeFile(path.join(root,'select-state.json'),JSON.stringify(selectState));assert.equal(selectState.value,'beta');await mark('native select CDP interaction passed');}
    snapshot=await tool('snapshot');const windowCount=BrowserWindow.getAllWindows().length;
    await tool('click',{elementId:snapshot.elements.find(item=>item.label==='Owned target link').id});await mark('validated targetblank click dispatched');
    await wait(async()=>(await state()).tabs.length===2,'owned popup tab');await wait(()=>parent.executeJavaScript("document.querySelector('#result').textContent==='Opener handshake received'"),'opener handshake');
    const own=await state(),popup=own.tabs.find(tab=>tab.id!==first),popupPage=views.find(view=>view.webContents.getURL()===base+'/popup').webContents;
    assert.equal(popupPage.session,parent.session);assert.equal(await popupPage.executeJavaScript('window.opener!==null'),true);assert.equal(BrowserWindow.getAllWindows().length,windowCount);assert.equal(parking.isVisible(),false);assert.equal(parking.isFocusable(),false);
    await tool('close',{tabId:popup.id});await tool('select_tab',{tabId:first});
    await tool('navigate',{url:base+'/auto'});await new Promise(resolve=>setTimeout(resolve,150));assert.equal((await state()).tabs.length,1);assert.ok(!requests.includes('/unsolicited'));
    const report={ok:true,root,actualCDPSelect:!process.argv.includes('--popup-only'),ownedTargetBlankTab:true,openerHandshake:true,sameChatCookies:true,unsolicitedPopupDenied:true,noExtraOSWindow:true,parkingHidden:true,strictPointerMeasurement:false,steps};
    await fs.writeFile(path.join(root,'forms-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }catch(error){const report={ok:false,root,steps,error:error.stack||error.message};await fs.writeFile(path.join(root,'forms-failure.json'),JSON.stringify(report,null,2));console.error(JSON.stringify(report));process.exitCode=1;}
  finally{await browser?.close().catch(()=>{});if(parking&&!parking.isDestroyed())parking.destroy();if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1);});
