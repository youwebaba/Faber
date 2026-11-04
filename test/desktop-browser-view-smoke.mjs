import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFS from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {app, BrowserWindow, session, WebContentsView, nativeImage} from 'electron';
import {createBrowserManager} from '../desktop/browser.mjs';

const parkingMode = process.argv.find(value => value.startsWith('--parking='))?.slice('--parking='.length) || 'hidden';
assert.ok(['none', 'hidden', 'offscreen', 'view-offscreen'].includes(parkingMode));
const captureMode = 'cdp';
const root = syncFS.mkdtempSync(path.join(os.tmpdir(), 'Faber-browser-view-'));
app.setPath('userData', root);
const digest = image => createHash('sha256').update(image).digest('hex');
function pixel(frame, x, y) { const image = nativeImage.createFromDataURL(frame.image), bitmap = image.toBitmap(); assert.equal(bitmap.length, frame.width * frame.height * 4); return [...bitmap.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4)]; }
void app.whenReady().then(async () => {
  let manager, hostWindow, parkingWindow, server;
  const networkTrace=[];const views = [], steps = [], mark = async step => { steps.push(step); await fs.writeFile(path.join(root, 'steps.json'), JSON.stringify(steps)); };
  try {
    server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Real view fixture</title><style>body{font:24px sans-serif;background:#eef6ff;padding:30px}input,button{font:24px sans-serif}</style><style>#viewport-pixel,#action-pixel{position:fixed;left:5px;top:5px;width:10px;height:10px;z-index:10;background:blue}#action-pixel{left:25px;background:red}@media(max-width:600px){#viewport-pixel{background:lime}}</style><i id="viewport-pixel"></i><i id="action-pixel"></i><h1>Real Chromium view</h1><label>Fixture text <input id="field"></label><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#field\').value;document.querySelector(\'#action-pixel\').style.background=\'lime\'">Submit fixture</button><p id="result">Initial page</p><style>html{overflow:hidden}.responsive-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.responsive-card{background:#bdf;border:2px solid blue;padding:8px;min-height:60px}@media(max-width:600px){.responsive-grid{grid-template-columns:1fr}.responsive-card{background:#bfb}}</style><div class="responsive-grid"><article class="responsive-card">Responsive left card</article><article class="responsive-card">Responsive middle card</article><article class="responsive-card">Responsive right card</article></div>'); });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    hostWindow = new BrowserWindow({width: 800, height: 600, useContentSize: true, show: false, title: 'Faber controlled WebContentsView fixture', webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
    if (parkingMode !== 'none') parkingWindow = new BrowserWindow({width: 1280, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: {backgroundThrottling: false, ...(parkingMode === 'offscreen' ? {offscreen: true} : {})}});
    const park = (view, size) => { hostWindow.contentView.removeChildView(view); parkingWindow.contentView.addChildView(view); view.setBounds({x:0,y:0,...size}); view.setVisible(true); };
    const managerOptions = {dataDir: path.join(root, 'manager'), createView: options => { const view = new WebContentsView(parkingMode === 'view-offscreen' ? {...options, webPreferences: {...options.webPreferences, offscreen: true}} : options); views.push(view); return view; }, createSession:(partition,options)=>{const owned=session.fromPartition(partition,options),before=owned.webRequest.onBeforeRequest.bind(owned.webRequest);owned.webRequest.onBeforeRequest=(filter,listener)=>before(filter,(details,callback)=>{const item={resourceType:details.resourceType,scheme:details.url.split(':')[0],webContentsId:details.webContentsId};listener(details,result=>{networkTrace.push({...item,canceled:!!result.cancel});callback(result);});});owned.on('will-download',(_event,_item,contents)=>networkTrace.push({event:'will-download',webContentsId:contents?.id}));return owned;},prepareNativeDownload:item=>item.setSavePath(path.join(root,'controlled-blob.txt')), getChat: id => ({id}), attachView: (view, bounds) => { parkingWindow?.contentView.removeChildView(view); view.setBounds(bounds); hostWindow.contentView.addChildView(view); }, detachView: view => hostWindow.contentView.removeChildView(view), parkView: park, unparkView: view => parkingWindow.contentView.removeChildView(view), isViewAllowed: () => true}; manager = createBrowserManager(managerOptions);
    await manager.initialize(); await mark('initialized');
    const chatId = 'view-fixture', request = (method, args = {}) => manager.request('browser.' + method, {chatId, ...args});
    const tool = (name, args = {}) => manager.tools().find(item => item.name === 'browser_' + name).execute(args, {chat: {id: chatId}, signal: new AbortController().signal});
    await tool('open', {url: 'http://127.0.0.1:' + server.address().port + '/'}); await mark('opened detached view');
    const contents = views[0].webContents;
    const first = await tool('screenshot'); await fs.writeFile(path.join(root, 'detached-before.png'), Buffer.from(first.image.split(',')[1], 'base64')); assert.deepEqual(pixel(first, 10, 10), [255, 0, 0, 255]); await mark('captured detached 1280x800');
    await new Promise(resolve => setTimeout(resolve, 2200)); const staticFrame = await tool('screenshot'); assert.equal(staticFrame.width, 1280); assert.equal(staticFrame.height, 800); assert.equal(staticFrame.image, first.image); await mark('fresh full frame from static parked page after idle');
    let snapshot = await tool('snapshot'); await mark('read detached snapshot');
    await tool('type', {elementId: snapshot.elements.find(item => item.label === 'Fixture text').id, text: 'Detached CDP input', clear: true}); await mark('typed into detached page');
    snapshot = await tool('snapshot'); await mark('read snapshot after typing'); await tool('click', {elementId: snapshot.elements.find(item => item.label === 'Submit fixture').id}); await mark('clicked detached submit');
    assert.equal(await contents.executeJavaScript("document.querySelector('#result').textContent"), 'Detached CDP input');
    await mark('verified detached DOM after input'); const typed = await tool('screenshot'); assert.deepEqual(pixel(typed, 30, 10), [0, 255, 0, 255]); await fs.writeFile(path.join(root, 'fresh-submit.png'), Buffer.from(typed.image.split(',')[1], 'base64')); assert.notEqual(digest(typed.image), digest(first.image)); await mark('fresh detached screenshot after real CDP typing/click');
    await request('takeover');
    hostWindow.showInactive();
    await request('view', {visible: true, x: 0, y: 0, width: 640, height: 480});
    assert.ok(hostWindow.contentView.children.some(view => view.webContents === contents), 'Same actual page attaches natively');
    await contents.executeJavaScript("document.querySelector('#result').textContent='Native surface fixture update'");
    await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const native = await contents.capturePage(); await fs.writeFile(path.join(root, 'native-surface.png'), native.toPNG());
    assert.equal(await contents.executeJavaScript("document.querySelector('#result').textContent"), 'Native surface fixture update');
    await mark('same page native attached and updated');
    if(process.argv.includes('--blob-probe')){
      await contents.executeJavaScript("(()=>{const b=document.createElement('button');b.id='blob';b.style='position:fixed;left:20px;bottom:15px';b.textContent='Download controlled blob';b.onclick=()=>{const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['Controlled blob download bytes'],{type:'text/plain'}));a.download='controlled-blob.txt';a.click();};document.body.append(b);})()");
      if(process.argv.includes('--blob-inline'))await contents.executeJavaScript("window.__blobErrors=[];addEventListener('error',event=>window.__blobErrors.push(event.message));document.querySelector('#blob').setAttribute('onclick', \"const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['Controlled blob download bytes'],{type:'text/plain'}));a.download='controlled-blob.txt';a.click()\")");
      contents.on('before-mouse-event',(_event,input)=>networkTrace.push({event:'mouse',type:input.type}));
      const point=await contents.executeJavaScript("(()=>{const r=document.querySelector('#blob').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      for(const type of ['mouseDown','mouseUp'])contents.sendInputEvent({type,...point,button:'left',clickCount:1});
      await new Promise(resolve=>setTimeout(resolve,500));
      const blobFile=path.join(root,'controlled-blob.txt'),bytes=await fs.readFile(blobFile,'utf8').catch(()=>null);
      await fs.writeFile(path.join(root,'blob-trace.json'),JSON.stringify({root,hostVisible:hostWindow.isVisible(),networkTrace,inlineErrors:await contents.executeJavaScript('window.__blobErrors||[]'),saved:bytes==='Controlled blob download bytes'},null,2));
      console.log(JSON.stringify({blobProbe:true,root,saved:bytes==='Controlled blob download bytes',inlineErrors:await contents.executeJavaScript('window.__blobErrors||[]'),networkTrace}));
    }
    await request('resume'); hostWindow.hide();
    assert.ok(!hostWindow.contentView.children.some(view => view.webContents === contents), 'Resume detaches native view');
    const resumed = await tool('screenshot'); assert.equal(resumed.width, 640); assert.equal(resumed.height, 480); assert.notEqual(digest(resumed.image), digest(typed.image));
    assert.match((await tool('snapshot')).text, /Native surface fixture update/);
    await fs.writeFile(path.join(root, 'detached-resumed.png'), Buffer.from(resumed.image.split(',')[1], 'base64'));
    await mark('fresh resumed parked pane-sized screenshot');
    let prior = resumed.image;
    for (const text of ['Fresh cycle one', 'Fresh cycle two']) {
      snapshot = await tool('snapshot'); await tool('type', {elementId: snapshot.elements.find(item => item.label === 'Fixture text').id, text, clear: true});
      snapshot = await tool('snapshot'); await tool('click', {elementId: snapshot.elements.find(item => item.label === 'Submit fixture').id});
      const next = await tool('screenshot'); assert.notEqual(digest(next.image), digest(prior)); assert.equal(await contents.executeJavaScript("document.querySelector('#result').textContent"), text); prior = next.image;
    }
    await mark('two additional fresh input/capture cycles');

    const subscriptionBeforeNavigation = contents.beginFrameSubscription.bind(contents); let automaticNavigation;
    contents.beginFrameSubscription = callback => {
      subscriptionBeforeNavigation(callback);
      if (!automaticNavigation) automaticNavigation = contents.executeJavaScript('location.href=' + JSON.stringify('http://127.0.0.1:' + server.address().port + '/automatic'));
    };
    try { await assert.rejects(tool('screenshot'), /Browser page changed while capturing/); assert.ok(automaticNavigation, 'Page script navigates during an actual Chromium capture'); await automaticNavigation; }
    finally { contents.beginFrameSubscription = subscriptionBeforeNavigation; }
    const automaticDeadline = Date.now() + 5000;
    while ((contents.isLoading() || (await manager.request('browser.state')).sessions[0].loading) && Date.now() < automaticDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(contents.isLoading(), false); assert.equal((await tool('snapshot')).url, 'http://127.0.0.1:' + server.address().port + '/automatic');
    const automaticFrame = await tool('screenshot'); assert.equal(automaticFrame.width, 640); assert.equal(automaticFrame.height, 480);
    await mark('website navigation during native capture settles and fresh observation/capture remain usable');

    // Verify real page layout after lazy human restore, not PNG size alone.
    await request('takeover'); await manager.close(); views.length = 0;
    manager = createBrowserManager(managerOptions); await manager.initialize();
    assert.equal(views.length, 0, 'Persisted human tabs restore lazily');
    const restored = (await manager.request('browser.state', {})).sessions.find(item => item.chatId === chatId);
    assert.equal(restored.mode, 'human'); assert.equal(restored.loaded, false);
    await request('resume');
    const loadDeadline = Date.now() + 5000;
    while (views.at(-1).webContents.isLoading() && Date.now() < loadDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(views.at(-1).webContents.isLoading(), false, 'Lazy resumed document finishes loading before race');
    const resumedContents = views.at(-1).webContents, subscribe = resumedContents.beginFrameSubscription.bind(resumedContents);
    let resizeDuringCapture;
    resumedContents.beginFrameSubscription = callback => {
      subscribe(callback);
      if (!resizeDuringCapture) resizeDuringCapture = request('view', {visible: true, x: 0, y: 0, width: 492, height: 650});
    };
    try {
      await tool('screenshot').catch(error => { assert.match(error.message, /changed|viewport|capture/i); });
      assert.ok(resizeDuringCapture, 'Actual Chromium capture initiated the overlapping resize');
      await resizeDuringCapture;
    } finally { resumedContents.beginFrameSubscription = subscribe; }
    const responsiveFrame = await tool('screenshot');
    const responsiveLayout = await resumedContents.executeJavaScript("(()=>{const cards=[...document.querySelectorAll('.responsive-card')].map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,right:r.right}});return {innerWidth,innerHeight,visualWidth:visualViewport.width,columns:getComputedStyle(document.querySelector('.responsive-grid')).gridTemplateColumns,cards}})()");
    const layoutMetrics = await resumedContents.debugger.sendCommand('Page.getLayoutMetrics');
    assert.equal(responsiveFrame.width, 492); assert.equal(responsiveFrame.height, 650); assert.deepEqual(pixel(responsiveFrame, 10, 10), [0, 255, 0, 255], 'First captured raster must show the narrow media-query color');
    assert.equal(responsiveLayout.innerWidth, 492); assert.equal(responsiveLayout.visualWidth, 492);
    assert.equal(layoutMetrics.cssLayoutViewport.clientWidth, 492); assert.equal(layoutMetrics.cssLayoutViewport.clientHeight, 650);
    assert.equal(layoutMetrics.cssVisualViewport.clientWidth, 492);
    assert.ok(responsiveLayout.cards[1].y > responsiveLayout.cards[0].y, 'Narrow media query must stack real cards into one column');
    assert.ok(responsiveLayout.cards.every(card => card.right <= 492), 'Responsive content must fit the pane instead of cropping a wide layout');
    await fs.writeFile(path.join(root, 'responsive-resume.png'), Buffer.from(responsiveFrame.image.split(',')[1], 'base64'));
    await mark('lazy human restore, actual capture/resize overlap, and responsive DOM/layout viewport proof');
    const report = {ok: true, root, responsiveLayoutAfterLazyResume: {dom: responsiveLayout, cdp: layoutMetrics, width: responsiveFrame.width, height: responsiveFrame.height}, parkingMode, captureMode, subscription: 'transaction', realElectron: true, detachedScreenshot: true, browserLocalCDPInput: true, imageChangedAfterInput: true, samePageNativeAttachment: true, freshScreenshotAfterDetach: true, resumedViewport: {width: resumed.width, height: resumed.height}, nativeCaptureSize: native.getSize(), nativeWindowsHumanTypingProven: false, strictPointerMeasurement: false, steps};
    await fs.writeFile(path.join(root, 'view-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } catch (error) {
    const report = {ok: false, root, parkingMode, captureMode, subscription: 'frame', steps, error: error.stack || error.message}; await fs.writeFile(path.join(root, 'view-failure.json'), JSON.stringify(report, null, 2)); console.error(JSON.stringify(report)); process.exitCode = 1;
  } finally {
    await manager?.close().catch(error => console.error(error.message));
    if (hostWindow && !hostWindow.isDestroyed()) hostWindow.destroy();
    if (parkingWindow && !parkingWindow.isDestroyed()) parkingWindow.destroy();
    if (server) await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
    app.exit(process.exitCode || 0);
  }
}).catch(error => {console.error(error); app.exit(1);});
