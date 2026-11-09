import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {createInteractivePreviews,artifactPath,artifactPolicy} from '../desktop/interactive-preview.mjs';
import {mediaGraphRevision} from '../core/media-artifacts.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t,{read}={}){
  const bytes=Buffer.from('<h1>Saved demo</h1>'),script=Buffer.from('window.count=1;'),asset={id:randomUUID(),name:'demo.js',kind:'asset',mimeType:'text/javascript',bytes:script.length,revision:digest(script),storage:'interactive'},media={id:randomUUID(),name:'demo.html',kind:'html',mimeType:'text/html',bytes:bytes.length,revision:digest(bytes),storage:'interactive',assets:[{name:'assets/demo.js',media:asset}]};media.graphRevision=mediaGraphRevision(media);
  const reads=[],views=[],handlers=new Map(),session=Object.assign(new EventEmitter(),{protocol:{handle:(scheme,handler)=>handlers.set(scheme,handler),unhandle:scheme=>handlers.delete(scheme)},webRequest:{onBeforeRequest:(_filter,handler)=>{session.beforeRequest=handler;}},setPermissionCheckHandler:handler=>{session.check=handler;},setPermissionRequestHandler:handler=>{session.permission=handler;},setDevicePermissionHandler:handler=>{session.device=handler;},setDisplayMediaRequestHandler:handler=>{session.display=handler;},clearStorageData:async()=>{session.cleared=(session.cleared||0)+1;}}),children=new Set(),window={isDestroyed:()=>false,webContents:{getZoomFactor:()=>1,focus(){}},getContentBounds:()=>({width:1000,height:800}),contentView:{addChildView:view=>children.add(view),removeChildView:view=>children.delete(view)}};
  const readAttachment=async(owner,id,offset,length,signal)=>{reads.push({owner,id,offset,length,signal});signal.throwIfAborted();if(read)return read({owner,id,offset,length,signal,media,asset,bytes,script});const value=id===media.id?media:id===asset.id?asset:null;if(!value)throw new Error('Denied');return{media:structuredClone(value),bytes:(id===media.id?bytes:script).subarray(offset,offset+length)};};
  const manager=createInteractivePreviews({readAttachment,getWindow:()=>window,chromiumVersion:'156.0.0',sessionFor:()=>session,createView:preferences=>{let destroyed=false;const contents=Object.assign(new EventEmitter(),{debugger:Object.assign(new EventEmitter(),{attach(){},sendCommand:async()=>({})}),setWindowOpenHandler:handler=>{contents.popup=handler;},setAudioMuted(){},setWebRTCIPHandlingPolicy(){},mainFrame:{framesInSubtree:[]},loadURL:async()=>{},executeJavaScript:async()=>{},isDestroyed:()=>destroyed,close(){destroyed=true;this.emit('destroyed');}}),view={webContents:contents,setBounds:bounds=>{view.bounds=bounds;},setVisible:visible=>{view.visible=visible;},preferences};views.push(view);return view;}});
  t.after(()=>manager.dispose());return{manager,media,asset,bytes,script,reads,views,session,handlers,children,params:{chatId:'chat',mediaId:media.id,leaseId:randomUUID(),bounds:{x:10,y:20,width:500,height:350}}};
}

test('artifact routes are exact virtual members and policies deny privileged destinations',()=>{
  const origin='faber-artifact://'+'a'.repeat(64);for(const name of ['index.html','wrapper.html','assets/demo.js'])assert.equal(artifactPath(origin+'/'+name,origin),name);
  for(const value of [origin+'/index.html?path=secret',origin+'/assets/%2e%2e/demo.js',origin+'/assets%2fdemo.js',origin+':80/index.html','https://example.invalid/index.html','faber://app/index.html',origin.replace('a','b')+'/index.html'])assert.equal(artifactPath(value,origin),null);
  const policy=artifactPolicy(origin);for(const token of ['sandbox allow-scripts',"frame-src 'none'","form-action 'none'","object-src 'none'","worker-src 'none'",'connect-src '+origin])assert.ok(policy.includes(token));assert.ok(!policy.includes('allow-same-origin'));assert.ok(!artifactPolicy(origin,true).includes('sandbox'));
});

test('private HTML host serves only declared immutable members with current chat ownership and bounded reads',async t=>{
  const f=fixture(t);assert.equal((await f.manager.request('media.preview.open',f.params)).status,'running');const record=f.manager.inspect(f.params.leaseId),handler=f.handlers.get('faber-artifact');
  assert.equal(f.views[0].preferences.nodeIntegration,false);assert.equal(f.views[0].preferences.sandbox,true);assert.equal(f.views[0].preferences.preload,undefined);assert.equal(f.session.check(),false);assert.equal(f.session.device(),false);assert.deepEqual(f.views[0].webContents.popup(),{action:'deny'});
  let prevented=false;f.views[0].webContents.emit('content-bounds-updated',{preventDefault(){prevented=true;}});assert.equal(prevented,true);
  let allow;f.session.beforeRequest({url:'https://unapproved.invalid'},value=>{allow=value;});assert.equal(allow.cancel,true);
  const response=await handler(new Request(record.origin+'/assets/demo.js'));assert.equal(response.status,200);assert.equal(response.headers.get('connection-allowlist'),'(response-origin)');assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.script);assert.ok(f.reads.every(row=>row.owner.chatId==='chat'&&row.length<=262144));
  const before=f.reads.length;for(const url of [record.origin+'/unknown.js','faber-artifact://'+'b'.repeat(64)+'/index.html'])assert.ok((await handler(new Request(url))).status>=400);assert.equal(f.reads.length,before);
  await f.manager.request('media.preview.stop',{leaseId:f.params.leaseId});assert.equal((await handler(new Request(record.origin+'/index.html'))).status,403);assert.equal(f.children.size,0);assert.ok(f.views[0].webContents.isDestroyed());assert.ok(f.session.cleared);
});

test('Stop cancels a pending owner read and replayed lease cannot restart a canceled preview',async t=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;}),f=fixture(t,{read:async({signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const opening=f.manager.request('media.preview.open',f.params);await ready;await f.manager.request('media.preview.stop',{leaseId:f.params.leaseId});assert.equal((await opening).status,'stopped');assert.equal((await f.manager.request('media.preview.open',f.params)).status,'stopped');assert.equal(f.views.length,0);
  await assert.rejects(f.manager.request('media.preview.open',{...f.params,chatId:'other'}),/another artifact/);assert.equal(f.reads.length,1);
});

test('wrong member metadata aborts streamed content and revocation rejects a new preview',async t=>{
  let changed=false,revoked=false;const f=fixture(t,{read:async({id,offset,length,media,asset,bytes,script})=>{if(revoked)throw new Error('Revoked');const ref=id===media.id?media:asset;return{media:changed?{...ref,revision:'b'.repeat(64)}:ref,bytes:(id===media.id?bytes:script).subarray(offset,offset+length)};}});await f.manager.request('media.preview.open',f.params);const record=f.manager.inspect(f.params.leaseId),handler=f.handlers.get('faber-artifact'),response=await handler(new Request(record.origin+'/index.html'));changed=true;await assert.rejects(response.arrayBuffer(),/changed/);await f.manager.stopAll();revoked=true;const denied=await f.manager.request('media.preview.open',{...f.params,leaseId:randomUUID()});assert.equal(denied.status,'stopped');assert.equal(f.children.size,0);
});
