import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess} from '../tools/process.mjs';
import {nativeAction} from '../desktop/native.mjs';

test('native Windows focus, literal typing, key and click affect only a dedicated fixture',{skip:process.env.SOPHIA_NATIVE_FIXTURE!=='1'?'Opt-in real desktop fixture; set SOPHIA_NATIVE_FIXTURE=1':false},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-native-test-')),resultPath=path.join(root,'fixture.json');
  const controller=new AbortController();
  const running=runProcess('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./desktop-native.fixture.ps1',import.meta.url)),'-ResultPath',resultPath],{signal:controller.signal,timeout:35000}).catch(error=>{if(!controller.signal.aborted)throw error;});
  t.after(async()=>{controller.abort();await running;await fs.rm(root,{recursive:true,force:true});});
  async function read(){return JSON.parse((await fs.readFile(resultPath,'utf8')).replace(/^\uFEFF/,''));}
  async function waitFor(predicate){let result,error;for(let i=0;i<50;i++){try{result=await read();if(predicate(result))return result;}catch(e){error=e;}await new Promise(r=>setTimeout(r,40));}if(!result)throw new Error(`Fixture could not be read: ${error?.message}; raw=${await fs.readFile(resultPath,'utf8').catch(()=>'<missing>')}`);return result;}
  let state;for(let i=0;i<100;i++){try{state=await read();break;}catch{await new Promise(r=>setTimeout(r,50));}}
  assert.ok(state?.handle,'fixture window is available');
  const windows=await nativeAction('windows');assert.ok(windows.some(w=>w.handle===state.handle),JSON.stringify({state,fixtureWindows:windows.filter(w=>w.title.includes('fixture'))}));
  assert.equal((await nativeAction('focus',{handle:state.handle})).focused,true);
  await nativeAction('type',{handle:state.handle,text:'literal +^%{}[]()'});assert.equal((await waitFor(s=>s.text==='literal +^%{}[]()')).text,'literal +^%{}[]()');
  await nativeAction('key',{handle:state.handle,keys:'{BACKSPACE}'});
  assert.equal((await waitFor(s=>s.text==='literal +^%{}[](')).text,'literal +^%{}[](');
  await nativeAction('click',{handle:state.handle,x:state.x,y:state.y});assert.equal((await waitFor(s=>s.clicked)).clicked,true);
  await assert.rejects(nativeAction('click',{handle:state.handle,x:-999999,y:-999999}),/outside/);
  const screen=await nativeAction('screenshot');assert.match(screen.image,/^data:image\/png;base64,/);assert.ok(screen.width>0&&screen.height>0);
});
