import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {app, BrowserWindow, screen, webContents} from 'electron';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runBrowserSmoke({window, runtime, browser, chat, dataDir}) {
  const checks = [], screenshots = {}, calls = [], inputObservations = [];
  const measureInput = process.argv.includes('--smoke-browser-measure-input');
  let otherWindow, releaseCapture, releasePoint, stage='initializing';
  const mark=async value=>{stage=value;await fs.writeFile(path.join(dataDir,'browser-smoke-progress.json'),JSON.stringify({stage,checks},null,2));};
  const watchdog=process.argv.includes('--browser-manual-fixture')?null:setTimeout(()=>{console.error(JSON.stringify({ok:false,stage,error:'Browser integration fixture exceeded90seconds'}));app.exit(1);},90000); watchdog?.unref();
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/chat/completions') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      calls.push(JSON.parse(Buffer.concat(chunks)));
      const first = calls.length % 2 === 1, delta = first ? {tool_calls: [{index: 0, id: 'fixture-' + calls.length, function: {name: 'browser_screenshot', arguments: '{}'}}]} : {content: 'Controlled browser response.'};
      response.writeHead(200, {'Content-Type': 'text/event-stream'}); response.end('data: ' + JSON.stringify({choices: [{delta, finish_reason: first ? 'tool_calls' : 'stop'}]}) + '\n\ndata: [DONE]\n\n'); return;
    }
    if (request.url === '/hold') return;
    if (request.url === '/download') {response.setHeader('Content-Disposition', 'attachment; filename="controlled.txt"'); response.end('Controlled download bytes'); return;}
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><meta charset="utf-8"><title>Controlled browser ${request.url}</title>
      <style>body{font:20px sans-serif;height:2200px;margin:0;padding:12px;background:#edf5ff}input,button,select{font:18px sans-serif;position:absolute;left:35px}#field{top:80px;width:245px;height:36px}#submit{top:140px;width:180px;height:40px}#result{position:absolute;top:185px}#choice{top:240px;width:220px}#check{top:290px}#popup{top:340px}#file{top:395px;width:260px}#download{position:absolute;top:455px;left:35px}#wheel{position:fixed;right:10px;top:8px}#isolation{position:absolute;top:505px;font-size:12px}</style>
      <h1>Controlled browser page</h1><input id="field" aria-label="Fixture text"><button id="submit" onclick="document.querySelector('#result').textContent='Submitted: '+document.querySelector('#field').value">Submit fixture</button><p id="result">Waiting</p>
      <select id="choice" aria-label="Fixture select"><option value="alpha">Alpha</option><option value="beta">Beta</option></select><input id="check" type="checkbox" aria-label="Fixture checkbox">
      <button id="popup" onclick="window.open('/popup','fixture-popup')">Open popup</button><input id="file" type="file" aria-label="Fixture upload"><a id="download" href="/download">Download controlled file</a><button id="blob" style="top:550px" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['Controlled blob download bytes'],{type:'text/plain'}));a.download='controlled-blob.txt';a.click()">Download blob</button><p id="wheel">Scroll:0</p><p id="isolation"></p>
      <script>document.querySelector('#isolation').textContent='Isolation:'+['require','process','faber','electron'].map(key=>typeof window[key]).join(',');document.querySelector('#field').addEventListener('keydown',event=>{if(event.key==='Enter')document.querySelector('#submit').click()});addEventListener('scroll',()=>document.querySelector('#wheel').textContent='Scroll:'+Math.round(scrollY));addEventListener('message',event=>{if(event.origin===location.origin&&event.data==='popup-handshake')document.querySelector('#result').textContent='Popup handshake received'});if(location.pathname==='/popup'&&window.opener){window.opener.postMessage('popup-handshake',location.origin);document.querySelector('h1').textContent='Owned popup fixture';const close=document.createElement('button');close.id='close-popup';close.textContent='Close popup';close.style.top='610px';close.onclick=()=>window.close();document.body.append(close);}</script>`);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const js = (fn, ...args) => window.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const request = (name, args = {}) => browser.request('browser.' + name, {chatId: chat.id, ...args});
  const state = () => browser.request('browser.state', {});
  const group = async () => (await state()).sessions.find(item => item.chatId === chat.id);
  const tool = (name, args = {}) => runtime.request('tool.run', {chatId: chat.id, name: 'browser_' + name, args});
  const direct = (name, args = {}, signal = new AbortController().signal) => browser.tools().find(item => item.name === 'browser_' + name).execute(args, {chat, signal});
  const currentPage = async () => {const own = await group(), tab = own.tabs.find(item => item.id === own.activeTabId); return webContents.getAllWebContents().find(contents => contents !== window.webContents && contents.getURL() === tab.url);};
  const attached = contents => window.contentView.children.find(view => view.webContents === contents);
  async function wait(predicate, label, timeout = 15000) {const end = Date.now() + timeout; while (Date.now() < end) {const result = await predicate(); if (result) return result; await pause(30);} throw new Error('Browser smoke timeout: ' + label + '; ' + await js(() => document.querySelector('#browser-error')?.textContent || ''));}
  async function settledAgent() {
    let previous='',stable=0;
    await wait(async()=>{const own=await group(),tab=own.tabs.find(item=>item.id===own.activeTabId),size=await js(()=>{const r=document.querySelector('#browser-page-slot').getBoundingClientRect();return {width:r.width,height:r.height};});
      const key=JSON.stringify([tab.id,tab.url,tab.viewport,size,tab.loading]);const matches=tab.loaded&&!tab.loading&&Math.abs(tab.viewport.width-size.width)<=2&&Math.abs(tab.viewport.height-size.height)<=2;
      stable=matches&&key===previous?stable+1:0;previous=key;return stable>=3;},'agent monitor viewport settles');
  }
  const selectChat = () => js(id => document.querySelector('[data-chat-id="' + id + '"]').click(), chat.id);
  const visibleFrame = () => js(() => {const image = document.querySelector('#browser-frame'); return !image.hidden && image.complete && image.naturalWidth > 0;});
  async function capture(name) {await js(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const file = path.join(dataDir, name + '.png'); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots[name] = file;}
  try {
    await wait(() => js(id => !!document.querySelector('[data-chat-id="' + id + '"]'), chat.id), 'fixture chat');
    await selectChat();
    await js(() => {const prompt = document.querySelector('#prompt'); prompt.value = 'preserved browser fixture draft'; prompt.dispatchEvent(new Event('input', {bubbles: true})); prompt.focus();});
    window.setTitle('Faber isolated browser takeover fixture'); window.show(); if(!window.isVisible()){window.hide();window.show();} window.focus();assert.equal(window.isVisible(),true,'Owned interactive fixture must be genuinely visible before native/layout tests');
    await tool('open', {url: base + '/main'});
    let page = await currentPage();
    assert.ok(page); const preferences = page.getLastWebPreferences();
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.ok(!preferences.preload);
    assert.equal(app.commandLine.hasSwitch('remote-debugging-port'), false);
    assert.equal(await page.executeJavaScript("['require','process','faber','electron'].map(key=>typeof window[key]).join(',')"), 'undefined,undefined,undefined,undefined');
    await wait(visibleFrame, 'decoded right-docked agent frame');
    assert.equal(await js(() => document.activeElement?.id), 'prompt', 'Agent page creation preserves composer focus');
    checks.push('Real sandboxed WCV, no Node/preload/bridge/debug port, agent creation preserves draft/focus');
    if (process.argv.includes('--browser-manual-fixture')) {
      window.focus(); await request('takeover'); window.focus();await wait(()=>attached(page),'initial native attachment at unchanged pane geometry');
      const nativeTrace=[];
      page.on('before-mouse-event',(_event,input)=>nativeTrace.push({event:'before-mouse',type:input.type,time:Date.now()}));
      page.session.on('will-download',(event,item,contents)=>nativeTrace.push({event:'will-download',prevented:event.defaultPrevented,scheme:item.getURL().split(':')[0],webContentsId:contents?.id,visible:window.isVisible(),focused:window.isFocused(),attached:Boolean(attached(contents)),time:Date.now()}));
      await page.executeJavaScript("window.__fixtureBlobTrace=[];const b=document.querySelector('#blob'),original=b.onclick;b.onclick=function(event){window.__fixtureBlobTrace.push({event:'handler-start',trusted:event.isTrusted,active:navigator.userActivation.isActive});try{return original.call(this,event)}catch(error){window.__fixtureBlobTrace.push({event:'handler-error',message:error.message});throw error}finally{window.__fixtureBlobTrace.push({event:'handler-end'})}};undefined");
      const uploadFile = path.join(dataDir, 'controlled-upload.txt'); await fs.writeFile(uploadFile, 'Controlled file upload bytes');
      const releaseFile = path.join(dataDir, 'manual-browser-finish.flag');
      const ready = {manualFixtureReady: true, nativeAttachedAtReady: Boolean(attached(page)), windowFocusedAtReady: window.isFocused(), windowTitle: window.getTitle(), fixtureUrl: base + '/main', popupUrl: base + '/popup', dataDir, uploadFile, releaseFile, httpDownload:{filename:'controlled.txt',destination:path.join(dataDir,'controlled.txt')},blobDownload:{filename:'controlled-blob.txt',destination:path.join(dataDir,'controlled-blob.txt')}, noPersonalProfile: true, nativeWindowsInteractionObserved: false};
      await fs.writeFile(path.join(dataDir, 'manual-browser-ready.json'), JSON.stringify(ready, null, 2)); console.log(JSON.stringify(ready));
      while (!await fs.access(releaseFile).then(() => true, () => false)) {
        const current = await group();
        const ui = await js(() => {const slot=document.querySelector('#browser-page-slot'),r=slot.getBoundingClientRect();return {documentFocused:document.hasFocus(),documentHidden:document.hidden,panelHidden:document.querySelector('#browser-panel').hidden,selectedChat:document.querySelector('#browser-session').value,slot:{x:r.x,y:r.y,width:r.width,height:r.height},modalOpen:document.querySelector('#modal').open,inert:document.body.inert,modelsOpen:document.body.classList.contains('models-open'),error:document.querySelector('#browser-error').textContent};});
        await fs.writeFile(path.join(dataDir,'manual-browser-live.json'),JSON.stringify({windowFocused:window.isFocused(),windowVisible:window.isVisible(),nativeChildren:window.contentView.children.filter(view=>view.webContents).map(view=>({url:view.webContents.getURL(),bounds:view.getBounds()})),session:current,ui,nativeTrace:nativeTrace.slice(-20),blobScriptTrace:page.isDestroyed()?[]:await page.executeJavaScript('window.__fixtureBlobTrace||[]')},null,2));
        await pause(400);
      }
      const actualForm = page.isDestroyed() ? {pageClosed:true} : await page.executeJavaScript("({text:document.querySelector('#field').value,result:document.querySelector('#result').textContent,choice:document.querySelector('#choice').value,checked:document.querySelector('#check').checked})");
      const finished = {...ready, finished:true, actualForm}; await fs.writeFile(path.join(dataDir,'manual-browser-finished.json'),JSON.stringify(finished,null,2)); return finished;
    }
    let cursor;
    if (measureInput) {
      otherWindow = new BrowserWindow({width: 460, height: 180, title: 'Faber isolated input focus fixture', show: false, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
      await otherWindow.loadURL('data:text/html,' + encodeURIComponent('<title>Independent input fixture</title><input id="other" autofocus>'));
      otherWindow.show(); otherWindow.focus(); await otherWindow.webContents.executeJavaScript("document.querySelector('#other').focus()");
      await wait(() => BrowserWindow.getFocusedWindow() === otherWindow, 'dedicated input fixture focus'); cursor = screen.getCursorScreenPoint();
    }
    async function unchangedInput() {
      if (!measureInput) return;
      const value = {focused: BrowserWindow.getFocusedWindow() === otherWindow, inputFocused: await otherWindow.webContents.executeJavaScript("document.hasFocus()&&document.activeElement.id==='other'"), cursor: screen.getCursorScreenPoint()};
      inputObservations.push(value); assert.ok(value.focused && value.inputFocused); assert.deepEqual(value.cursor, cursor); assert.equal(await otherWindow.webContents.executeJavaScript("document.querySelector('#other').value"), '');
    }
    let snapshot = await tool('snapshot');
    const field = snapshot.elements.find(item => item.label === 'Fixture text'); assert.ok(field);
    await tool('type', {elementId: field.id, text: 'Structured browser input', clear: true}); await unchangedInput();
    snapshot = await tool('snapshot'); await tool('click', {elementId: snapshot.elements.find(item => item.label === 'Submit fixture').id}); await unchangedInput();
    assert.match((await tool('snapshot')).text, /Submitted: Structured browser input/);
    let frame = await tool('screenshot');
    assert.match(frame.image, /^data:image\/png;base64,/); assert.ok(frame.width > 0 && frame.height > 0);
    await tool('click', {x: 120, y: 100, frameId: frame.frameId}); await tool('key', {key: 'End'}); await tool('type', {text: ' + vision'}); await tool('key', {key: 'Enter'}); await unchangedInput();
    assert.match((await tool('snapshot')).text, /Structured browser input \+ vision/);
    frame = await tool('screenshot'); await tool('scroll', {deltaY: 450, frameId: frame.frameId}); await unchangedInput();
    await wait(() => page.executeJavaScript('scrollY>0'), 'page-local wheel');
    if (measureInput) await fs.writeFile(path.join(dataDir, 'browser-input-isolation-report.json'), JSON.stringify({ok: true, strictInputMeasurement: true, cursor, inputObservations}, null, 2));
    otherWindow?.hide(); window.focus();
    await tool('navigate', {url: base + '/main'}); await wait(visibleFrame, 'fresh frame');
    const firstTab = (await group()).activeTabId;
    await tool('new_tab', {url: base + '/second'}); const secondTab = (await group()).activeTabId;
    assert.notEqual(firstTab, secondTab);
    const parkedBefore=await tool('screenshot',{tabId:firstTab});
    let parkedSnapshot=await tool('snapshot',{tabId:firstTab});
    await tool('type',{tabId:firstTab,elementId:parkedSnapshot.elements.find(item=>item.label==='Fixture text').id,text:'Parked first tab update',clear:true});
    parkedSnapshot=await tool('snapshot',{tabId:firstTab});await tool('click',{tabId:firstTab,elementId:parkedSnapshot.elements.find(item=>item.label==='Submit fixture').id});
    const parkedAfter=await tool('screenshot',{tabId:firstTab});assert.notEqual(parkedBefore.image,parkedAfter.image);assert.match((await tool('snapshot',{tabId:firstTab})).text,/Submitted: Parked first tab update/);
    assert.equal((await group()).activeTabId,secondTab,'Targeted parked-tab actions do not select another tab');
    screenshots.parkedFirst=path.join(dataDir,'browser-parked-first.png');await fs.writeFile(screenshots.parkedFirst,Buffer.from(parkedAfter.image.split(',')[1],'base64'));
    checks.push('First parked tab still receives targeted input and fresh screenshots beneath a second tab');
    await tool('navigate', {url: base + '/history-one'}); await tool('navigate', {url: base + '/history-two'});
    const settledDocument = async pathname => { await wait(async () => {const actual = await currentPage(); return actual && !actual.isLoading() && (await group()).tabs.find(tab => tab.id === secondTab)?.loading === false && await actual.executeJavaScript('document.title') === 'Controlled browser ' + pathname;}, 'loaded document ' + pathname); assert.equal((await tool('snapshot')).title, 'Controlled browser ' + pathname); };
    await tool('back'); await settledDocument('/history-one');
    await tool('forward'); await settledDocument('/history-two');
    await tool('reload'); await settledDocument('/history-two');
    await tool('select_tab', {tabId: firstTab}); page = await currentPage();
    await assert.rejects(tool('click', {x: 100, y: 100, frameId: frame.frameId}), /stale|frame/i);
    const another = await runtime.request('chat.create', {projectId: chat.projectId, title: 'Other private browser fixture'});
    await runtime.request('tool.run', {chatId: another.id, name: 'browser_open', args: {url: base + '/other-private-marker'}});
    for (const result of [await tool('tabs'), await tool('open', {url: base + '/main'}), await tool('new_tab', {url: base + '/scoped'})]) {
      const encoded = JSON.stringify(result); assert.ok(!encoded.includes('other-private-marker') && !encoded.includes(another.id)); assert.ok(!Object.hasOwn(result, 'history') && !Object.hasOwn(result, 'bookmarks') && !Object.hasOwn(result, 'downloads'));
    }
    await tool('close'); await tool('select_tab', {tabId: firstTab}); page = await currentPage();
    await js(id => {const node = document.querySelector('#browser-session'); node.value = id; node.dispatchEvent(new Event('change', {bubbles: true}));}, chat.id);
    checks.push('Tabs/back/forward/reload, stale handles, and agent responses restricted to their chat');
    await settledAgent();snapshot = await tool('snapshot');
    const pointSend = page.debugger.sendCommand.bind(page.debugger); let pointEntered;
    let pointSeen=false;pointEntered=()=>{pointSeen=true;};const pointGate = new Promise(resolve=>{releasePoint=resolve;});
    page.debugger.sendCommand = async(method,args)=>{const result=await pointSend(method,args);if(method==='Runtime.evaluate'&&args.expression?.startsWith('(function elementPoint(')){pointEntered();await pointGate;}return result;};
    const stalePoint = direct('click',{elementId:snapshot.elements.find(item=>item.label==='Fixture text').id}).then(value=>({value}),error=>({error}));
    await wait(()=>pointSeen,'held element lookup gate');
    const viewportBefore = (await group()).tabs.find(item=>item.id===firstTab).viewport.width;
    const viewportHeight=(await group()).tabs.find(item=>item.id===firstTab).viewport.height;
    const resizeResult=await request('view',{tabId:firstTab,visible:true,x:0,y:0,width:viewportBefore+20,height:viewportHeight});
    const resizeAfter=(await group()).tabs.find(item=>item.id===firstTab).viewport;
    assert.notEqual(resizeAfter.width,viewportBefore,JSON.stringify({resizeResult,resizeAfter,viewportBefore,windowVisible:window.isVisible(),windowMinimized:window.isMinimized(),windowFocused:window.isFocused()}));
    releasePoint(); assert.ok((await stalePoint).error,'A late element lookup cannot click old coordinates after viewport resize'); page.debugger.sendCommand=pointSend;
    const restoreBounds=await js(()=>{const r=document.querySelector('#browser-page-slot').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    await request('view',{tabId:firstTab,visible:true,...restoreBounds});
    await js(()=>document.querySelector('#browser-bookmark').click());
    await wait(async()=> (await state()).bookmarks.some(item=>item.url===base+'/main'),'actual bookmark action');
    await tool('navigate',{url:base+'/main'}); page=await currentPage(); await settledAgent();await wait(visibleFrame,'fresh frame after resize guard');
    checks.push('Actual held element lookup rejects stale coordinates after concurrent viewport resize');

    const provider = await runtime.request('provider.save', {name: 'Controlled browser protocol', kind: 'openai', baseUrl: base + '/v1', model: 'browser-fixture'});
    await runtime.request('chat.update', {id: chat.id, providerId: provider.id, model: 'browser-fixture'});
    await wait(visibleFrame, 'live frame before takeover race');
    const send = page.debugger.sendCommand.bind(page.debugger); let captured;
    let captureSeen=false;captured=()=>{captureSeen=true;};
    const gate = new Promise(resolve => {releaseCapture = resolve;});
    page.debugger.sendCommand = async (method, args) => {const result = await send(method, args); if (method === 'Page.captureScreenshot') {captured(); await gate;} return result;};
    let shotSettled = false, typeSettled = false;
    const oldShot = direct('screenshot').then(value => {shotSettled = true; return {value};}, error => {shotSettled = true; return {error};});
    await wait(()=>captureSeen,'held screenshot gate');await mark('screenshot gate entered');
    const oldType = direct('type', {text: 'MUST NOT REPLAY'}).then(value => {typeSettled = true; return {value};}, error => {typeSettled = true; return {error};});
    await mark('takeover requested');const takeover = request('takeover');
    await wait(async () => (await group()).mode === 'human', 'immediate authority revocation before capture settles');
    assert.equal(shotSettled, false); assert.equal(typeSettled, false);
    releaseCapture(); await takeover; page.debugger.sendCommand = send; await mark('takeover completed');
    await wait(() => attached(page), 'same actual page embedded during takeover');await mark('native page attached');
    await pause(150); assert.equal(shotSettled, false); assert.equal(typeSettled, false);
    const stop = new AbortController(); let pausedSettled = false;
    const paused = direct('tabs', {}, stop.signal).then(() => {pausedSettled = true;}, error => {pausedSettled = true; return error;});
    await pause(150); assert.equal(pausedSettled, false); stop.abort(new Error('Controlled Stop'));
    assert.ok(await paused instanceof Error); assert.equal(page.isDestroyed(), false);
    assert.ok(!browser.tools().some(item => ['browser_resume', 'browser_takeover'].includes(item.name)));
    await mark('stopped human wait successfully');
    // Native select popups require the external Windows input driver used by root.
    await page.executeJavaScript("document.querySelector('#field').value='Human private fixture value';document.querySelector('#choice').value='beta'");
    await mark('private page mutation complete');
    checks.push('Native popup/opener interaction is reserved for the separate external Windows fixture proof');
    await mark('paused model run requested');const {runId} = await runtime.request('chat.send', {chatId: chat.id, text: 'Controlled pause test'});
    await wait(() => calls.length === 1, 'one provider tool request'); await pause(300); assert.equal(calls.length, 1, 'Human takeover must not spin repeated provider tool-error calls');
    await js(() => {const resume = document.querySelector('#browser-resume'); resume.focus(); resume.click();});
    await wait(async () => (await group()).mode === 'agent', 'explicit Resume');
    releaseCapture(); page.debugger.sendCommand = send;
    assert.ok((await oldShot).error && (await oldType).error, 'Old epoch observations/actions reject after Resume');
    assert.equal(await page.executeJavaScript("document.querySelector('#field').value"), 'Human private fixture value');
    await wait(async () => (await runtime.request('state.get')).runs.find(run => run.id === runId)?.status === 'completed', 'paused model finishes after Resume');
    assert.equal(calls.length, 2);
    const next = await runtime.request('chat.send', {chatId: chat.id, text: 'Controlled actual screenshot'});
    await wait(async () => (await runtime.request('state.get')).runs.find(run => run.id === next.runId)?.status === 'completed', 'vision screenshot loop');
    assert.ok(calls[3].messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && /^data:image\/png;base64,/.test(part.image_url.url))));
    checks.push('Takeover holds in-flight/queued reads and actions; Stop frees waits; explicit Resume rejects stale commands without replay or provider loop');
    checks.push('Private page state survives Resume without stale typing; actual screenshot-to-vision pipeline; native Windows human interaction is separate root proof');

    await request('takeover'); window.focus(); await wait(() => attached(page), 'native view for geometry');
    const bounds = await js(() => {const r = document.querySelector('#browser-page-slot').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};});
    let native = attached(page).getBounds(); assert.ok(Math.abs(native.width - bounds.width) <= 2 && Math.abs(native.height - bounds.height) <= 2);
    await js(() => document.querySelector('#open-settings').click()); await wait(() => !attached(page), 'settings dialog occludes native page');
    await js(() => document.querySelector('#close-modal').click()); await wait(() => attached(page), 'native page restores after modal');
    const dragBounds=await js(()=>{const r=document.querySelector('#browser-divider').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};});
    const dragWidth=await js(()=>document.querySelector('#browser-panel').getBoundingClientRect().width);
    window.webContents.sendInputEvent({type:'mouseDown',...dragBounds,button:'left',clickCount:1});await wait(()=>!attached(page),'native page hidden during divider drag');
    window.webContents.sendInputEvent({type:'mouseMove',x:dragBounds.x-30,y:dragBounds.y,modifiers:['leftButtonDown']});window.webContents.sendInputEvent({type:'mouseUp',x:dragBounds.x-30,y:dragBounds.y,button:'left',clickCount:1});
    await wait(()=>js(before=>document.querySelector('#browser-panel').getBoundingClientRect().width>before,dragWidth),'pointer divider resizing');
    await wait(()=>attached(page),'native page restores after divider drag');
    const oldWidth = await js(() => document.querySelector('#browser-panel').getBoundingClientRect().width);
    await js(() => {const node=document.querySelector('#browser-divider'); node.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));});
    await wait(() => js(before => document.querySelector('#browser-panel').getBoundingClientRect().width > before, oldWidth), 'keyboard divider resizing');
    await wait(() => attached(page), 'native view after resize');
    await runtime.request('settings.update', {uiScale: 1.25}); await wait(() => window.webContents.getZoomFactor() === 1.25, 'UI zoom');
    await wait(async()=>{const view=attached(page);if(!view)return false;const r=await js(()=>{const b=document.querySelector('#browser-page-slot').getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};}),actual=view.getBounds();return ['x','y','width','height'].every(key=>Math.abs(actual[key]-Math.round(r[key]*1.25))<=2);},'zoom-scaled native bounds settle');
    const zoomBounds = await js(() => {const r=document.querySelector('#browser-page-slot').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    native = attached(page).getBounds(); assert.ok(Math.abs(native.width - Math.round(zoomBounds.width * 1.25)) <= 2);
    await request('resume'); await settledAgent(); const scaledFrame = await tool('screenshot'), scaledTab = (await group()).tabs.find(item => item.id === firstTab); assert.equal(scaledFrame.width, scaledTab.viewport.width); assert.equal(scaledFrame.height, scaledTab.viewport.height);
    await runtime.request('settings.update', {uiScale: 1});
    await settledAgent();await wait(visibleFrame, 'dynamic agent frame after native handoff');
    frame = await tool('screenshot');
    const tab = (await group()).tabs.find(item => item.id === firstTab), slot = await js(() => {const r=document.querySelector('#browser-page-slot').getBoundingClientRect();return {width:r.width,height:r.height};});
    assert.equal(frame.width, tab.viewport.width); assert.equal(frame.height, tab.viewport.height); assert.ok(Math.abs(frame.width-slot.width)<=2 && Math.abs(frame.height-slot.height)<=2);
    assert.equal(await js(() => document.querySelector('#prompt').value), 'preserved browser fixture draft');
    await capture('browser-expanded-agent-view');
    if(!otherWindow){otherWindow=new BrowserWindow({width:460,height:180,title:'Faber owned background-monitor focus fixture',show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await otherWindow.loadURL('data:text/html,'+encodeURIComponent('<title>Other owned application fixture</title><input id="other" autofocus>'));}
    await page.executeJavaScript("document.activeElement?.blur()");
    const beforeBackground=await js(()=>document.querySelector('#browser-frame').src);
    otherWindow.show();if(!otherWindow.isVisible()){otherWindow.hide();otherWindow.show();}otherWindow.focus();await otherWindow.webContents.executeJavaScript("document.querySelector('#other').focus()");
    await wait(()=>BrowserWindow.getFocusedWindow()===otherWindow,'owned other window foreground');
    await page.executeJavaScript("document.querySelector('#result').textContent='Autonomous background monitor update'");
    await pause(600);
    await wait(()=>js(before=>{const image=document.querySelector('#browser-frame');return image.src!==before&&!image.hidden&&image.complete&&image.naturalWidth>0;},beforeBackground),'fresh background monitor frame');
    assert.equal(BrowserWindow.getFocusedWindow(),otherWindow,'Background browser frame must not steal foreground');assert.equal(await otherWindow.webContents.executeJavaScript('document.hasFocus()'),true);
    screenshots.backgroundMonitor=path.join(dataDir,'browser-background-monitor.png');await fs.writeFile(screenshots.backgroundMonitor,(await window.webContents.capturePage()).toPNG());
    checks.push('Autonomous page change updates monitored frame while another owned window retains foreground focus');
    otherWindow.hide();window.focus();
    checks.push('Right dock/native slot, modal hiding, accessible divider resizing, zoom-scaled bounds, dynamic screenshot viewport and preserved composer');
    const result = {ok:true, noPersonalProfile:true, noPaidInference:true, checks, screenshots, strictInputMeasurement:measureInput, inputObservations, nativeWindowsHumanTypingProven:false, dataDir};
    await fs.writeFile(path.join(dataDir,'browser-smoke-report.json'),JSON.stringify(result,null,2)); return result;
  } catch(error) {
    const ui=await js(()=>{const r=document.querySelector('#browser-page-slot')?.getBoundingClientRect();return {selected:document.querySelector('#browser-session')?.value,activeTab:document.querySelector('[data-browser-tab][aria-selected="true"]')?.dataset.browserTab,slot:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,panelHidden:document.querySelector('#browser-panel')?.hidden,bodyClass:document.body.className,focused:document.hasFocus(),error:document.querySelector('#browser-error')?.textContent};}).catch(()=>null);
    await fs.writeFile(path.join(dataDir,'browser-smoke-failure.json'),JSON.stringify({stage,checks,error:error.stack||error.message,browser:await state().catch(()=>null),hostWindow:{visible:window.isVisible(),focused:window.isFocused(),minimized:window.isMinimized()},ui},null,2));await capture('browser-expanded-failure').catch(()=>{});throw error;
  } finally {
    clearTimeout(watchdog);releaseCapture?.();releasePoint?.(); otherWindow?.destroy(); await browser.close();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
}
