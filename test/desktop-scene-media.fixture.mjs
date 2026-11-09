import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {scenes} from './fixtures/scenes.mjs';
import {mediaReferenceTree} from '../core/media.mjs';

export async function prepareSceneMedia({window,chat,project,bridge,until,save,checks,capture}){
  const f=scenes(),files=new Map([['triangle.glb',f.glb],['triangle.gltf',f.gltf],['triangle.stl',f.stl],...f.assets]),refs=[],js=code=>window.webContents.executeJavaScript(code,true);
  for(const [name,bytes]of files){await fs.mkdir(path.dirname(path.join(project.path,name)),{recursive:true});await fs.writeFile(path.join(project.path,name),bytes);}
  for(const name of ['triangle.glb','triangle.gltf','triangle.stl'])refs.push((await bridge('tool.run',{chatId:chat.id,name:'media_show',args:{path:name,...(name.endsWith('.gltf')?{assets:[...f.assets.keys()].map(name=>({name,path:name}))}:{})}})).media);
  const selector=(scope,ref)=>scope+` [data-media-id="${ref.id}"]`;
  const click=(s,label)=>js(`(()=>{const b=[...document.querySelector(${JSON.stringify(s)}).querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)throw Error('Missing scene control '+${JSON.stringify(label)});b.click()})()`);
  async function run(scope,deviceId){
    for(const ref of refs){const s=selector(scope,ref);await until(()=>js(`Boolean(document.querySelector(${JSON.stringify(s)}))`),'3D descriptor');await js(`document.querySelectorAll(${JSON.stringify(scope+' details')}).forEach(n=>n.open=true);document.querySelector(${JSON.stringify(s)}).scrollIntoView({block:'center'})`);await click(s,'Open 3D');
      try{await until(()=>js(`document.querySelector(${JSON.stringify(s)}).dataset.previewLoaded==='true'`),ref.name+' WebGL load',20000);}catch(e){throw Error(e.message+'; '+await js(`document.querySelector(${JSON.stringify(s+' .media-status')}).textContent`));}
      const url=await js(`document.querySelector(${JSON.stringify(s+' iframe')}).src`),frame=window.webContents.mainFrame.frames.find(frame=>frame.url===url);assert.ok(frame);
      assert.equal(await frame.executeJavaScript(`typeof window.faber==='undefined'&&typeof require==='undefined'&&(()=>{try{return parent.document===document}catch{return true}})()`),true,'isolated scene has no preload/Node/parent DOM');
      assert.ok(await frame.executeJavaScript(`(()=>{const c=document.querySelector('canvas'),g=c?.getContext('webgl2');return !!g&&c.width>0&&c.height>0&&g.getParameter(g.VERSION).includes('WebGL')})()`),'real WebGL context');
      const position=()=>js(`JSON.parse(document.querySelector(${JSON.stringify(s)}).dataset.scenePosition)`),initial=await position(),different=async()=>JSON.stringify(await position())!==JSON.stringify(initial);
      const outer=await js(`(()=>{const r=document.querySelector(${JSON.stringify(s+' iframe')}).getBoundingClientRect();return {x:r.x,y:r.y}})()`),inner=await frame.executeJavaScript(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`),point={x:Math.round(outer.x+inner.x),y:Math.round(outer.y+inner.y)};
      window.show();window.focus();const debug=window.webContents.debugger;debug.attach('1.3');try{await debug.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await debug.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});await debug.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+40,y:point.y+20,button:'left',buttons:1});await debug.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+40,y:point.y+20,button:'left',buttons:0,clickCount:1});await until(different,'pointer OrbitControls rotates camera');}finally{debug.detach();}
      await frame.executeJavaScript(`document.querySelector('[data-action="reset"]').click()`);await until(async()=>{const p=await position();return p.every((v,i)=>Math.abs(v-initial[i])<1e-8);},'reset after pointer orbit');
      await frame.executeJavaScript(`document.querySelector('[data-action="left"]').click()`);await until(different,'orbit rotates actual camera');
      await frame.executeJavaScript(`document.querySelector('[data-action="reset"]').click()`);await until(async()=>{const p=await position();return p.every((v,i)=>Math.abs(v-initial[i])<1e-8);},'reset camera');
      await frame.executeJavaScript(`document.querySelector('[data-action="zoomIn"]').click()`);await until(different,'zoom changes camera');const zoomed=await position();assert.ok(Math.hypot(...zoomed)<Math.hypot(...initial),'zoom moves toward centered fixture');
      await frame.executeJavaScript(`document.querySelector('[data-action="panRight"]').click()`);await until(async()=>JSON.stringify(await position())!==JSON.stringify(zoomed),'pan moves camera');
      await frame.executeJavaScript(`document.querySelector('[data-action="reset"]').click()`);await until(async()=>{const p=await position();return p.every((v,i)=>Math.abs(v-initial[i])<1e-8);},'reset after pan/zoom');
      await capture?.((deviceId?'remote-':'local-')+ref.name.replace('.','-'));
      for(const member of mediaReferenceTree({result:{media:ref}})){const original=member.id===ref.id?files.get(ref.name):files.get(ref.assets.find(a=>a.media.id===member.id).name);await save({chatId:chat.id,mediaId:member.id,...(deviceId?{deviceId}:{})},Buffer.from(original),(deviceId?'remote-':'local-')+'scene-'+member.name);}
      await click(s,'Stop preview');assert.equal(await js(`document.querySelector(${JSON.stringify(s+' iframe')}).src`),'about:blank');
    }
    checks.push(`${deviceId?'Paired encrypted loopback':'Local'} GLB/glTF/STL real isolated WebGL render, orbit/pan/zoom/reset, byte-identical original/buffer/texture saves and explicit stop`);
  }
  return {refs,run,async canceledRemote(scope,delay,wasAborted,isPending){const s=selector(scope,refs[1]);delay(refs[1].assets[0].media.id);await click(s,'Open 3D');await until(isPending,'pending encrypted scene dependency');await click(s,'Stop preview');await until(wasAborted,'scene cancel reaches host transfer');delay(null);assert.equal(await js(`document.querySelector(${JSON.stringify(s+' iframe')}).src`),'about:blank');checks.push('Stop during pending encrypted 3D dependency transfer closes its host request without opening a viewer');},async open(scope){const s=selector(scope,refs[1]);await click(s,'Open 3D');await until(()=>js(`document.querySelector(${JSON.stringify(s)}).dataset.previewLoaded==='true'`),'scene reopen');await js(`window.sceneSmokeFrame=document.querySelector(${JSON.stringify(s+' iframe')})`);return s;},async stopped(scope){const s=selector(scope,refs[1]);await until(()=>js(`window.sceneSmokeFrame?.src==='about:blank'`),'offline scene cleanup');}};
}
