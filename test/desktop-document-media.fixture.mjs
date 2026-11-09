import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pdfFixture,docxFixture,svgFixture,gifFixture,apngFixture,zipFixture} from './fixtures/documents.mjs';

export async function prepareDocumentMedia({window,runtime,chat,project,bridge,until,save,checks,capture}){
  const js=code=>window.webContents.executeJavaScript(code,true),files={'pages.pdf':pdfFixture(),'pages.docx':docxFixture(),'drawing.svg':svgFixture,'motion.gif':gifFixture(),'motion.apng':apngFixture(),'animated.png':apngFixture()},refs=[];
  for(const [name,bytes]of Object.entries(files)){await fs.writeFile(path.join(project.path,name),bytes);refs.push((await bridge('tool.run',{chatId:chat.id,name:'media_show',args:{path:name}})).media);}
  let externalRequests=0;const observe=event=>{if(event.url.includes('preview.invalid'))externalRequests++;};window.webContents.on('will-frame-navigate',observe);
  async function child(ref,scope){const source=await js(`document.querySelector(${JSON.stringify(`${scope} [data-media-id="${ref.id}"] iframe`)})?.src`);return window.webContents.mainFrame.frames.find(frame=>frame.url===source);}
  async function run(scope,deviceId){
    await js(`document.querySelectorAll(${JSON.stringify(scope+' details')}).forEach(node=>node.open=true)`);
    for(const ref of refs){
      const selector=`${scope} [data-media-id="${ref.id}"]`;
      await js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`);
      try{await until(()=>js(`Boolean(document.querySelector(${JSON.stringify(selector)})?.dataset.previewLoaded)`),`${ref.name} loaded`,25000);}catch(error){const childFrame=await child(ref,scope),diagnostic=childFrame?await childFrame.executeJavaScript(`JSON.stringify({status:document.querySelector('#status')?.textContent,body:document.body.innerText.slice(0,800),url:location.protocol})`):'No preview frame';throw new Error(error.message+'; '+diagnostic+'; '+await js(`JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.dataset)`));}
      let frame=await child(ref,scope);assert.ok(frame,ref.name+' isolated frame');
      assert.equal(await frame.executeJavaScript(`typeof window.faber==='undefined'&&typeof window.require==='undefined'&&(()=>{try{return parent.document===document}catch{return true}})()`),true,'artifact has no bridge or parent DOM access');
      if(ref===refs[0]){assert.deepEqual(await frame.executeJavaScript(`Promise.all(['faber-preview://viewer/core/state.mjs','faber-preview://viewer/frame.mjs?path=secret','faber://app/core/state.mjs','https://preview.invalid/private'].map(url=>fetch(url).then(response=>response.status,()=> 'blocked')))`),[403,403,'blocked','blocked'],'production preview protocol and CSP reject arbitrary static paths, app access and external fetches');checks.push('Actual isolated preview frame denies arbitrary paths, parent-app fetches and external network fetches');}
      if(ref.kind==='document'){
        assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).dataset.previewPages`),'2');
        await frame.executeJavaScript(`[...document.querySelectorAll('button')].find(node=>node.textContent==='Next page').click()`);
        await until(()=>frame.executeJavaScript(`document.querySelector('#page').textContent.includes('PAGE TWO')`),ref.name+' next page');
        if(ref.name.endsWith('.docx'))assert.equal(await frame.executeJavaScript(`document.querySelector('#page').textContent.includes('[Table row 1, cell 1]')&&document.querySelector('#page').textContent.includes('[Table row 2, cell 2]')&&document.querySelector('#page').textContent.includes('Fourth table cell')&&document.querySelector('#page').textContent.includes('[Image / graphic]')`),true,'DOCX table boundaries and actual embedded graphic have visible representations');
        else assert.ok(await frame.executeJavaScript(`(()=>{const canvas=document.querySelector('canvas'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,100).data;let dark=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]<100&&pixels[i+1]<100&&pixels[i+2]<100&&pixels[i+3])dark++;return dark>20;})()`),'PDF actually paints text on its canvas');
        await frame.executeJavaScript(`[...document.querySelectorAll('button')].find(node=>node.textContent==='Zoom in').click()`);
        await until(()=>frame.executeJavaScript(`document.querySelector('#page').textContent.includes('PAGE TWO')`),ref.name+' zoom redraw');
        await frame.executeJavaScript(`(()=>{const text=[...document.querySelectorAll('#page span')].filter(node=>node.textContent==='DOCX PAGE TWO note target').at(-1)||document.querySelector('#page span'),range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));})()`);
        await until(()=>js(`!document.querySelector(${JSON.stringify(selector+' .document-actions')}).querySelectorAll('button')[1].disabled`),ref.name+' selectable text');
        await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.querySelector('textarea').value=${JSON.stringify((deviceId?'Remote':'Local')+' review')};[...node.querySelectorAll('.document-actions button')].find(button=>button.textContent==='Highlight selection').click();})()`);
        await until(()=>js(`document.querySelector(${JSON.stringify(selector+' .document-notes ol')}).textContent.includes(${JSON.stringify((deviceId?'Remote':'Local')+' review')})`),ref.name+' saved annotation');
        const notes=await runtime.mediaNotes('read',{chatId:chat.id,mediaId:ref.id,revision:ref.revision});assert.ok(notes.notes.some(note=>note.page===2&&note.quote.includes('PAGE TWO')));if(deviceId)assert.equal(notes.notes.length,2);
        assert.ok(await frame.executeJavaScript(`CSS.highlights.get('faber-notes').size`));
        if(ref.name.endsWith('.docx')){assert.ok(notes.notes.at(-1).anchorStart>0);assert.equal(await frame.executeJavaScript(`[...CSS.highlights.get('faber-notes')].every(range=>range.startContainer.parentElement===[...document.querySelectorAll('#page span')].filter(node=>node.textContent==='DOCX PAGE TWO note target').at(-1))`),true,'repeated text highlights the selected occurrence');}
      }else if(ref.kind==='vector'){
        await until(()=>frame.executeJavaScript(`document.querySelector('img')?.naturalWidth===800`),'SVG real image decode');
        await frame.executeJavaScript(`[...document.querySelectorAll('button')].find(node=>node.textContent==='Zoom in').click()`);
        await frame.executeJavaScript(`(()=>{const viewport=document.querySelector('#viewport');viewport.dispatchEvent(new PointerEvent('pointerdown',{clientX:200,clientY:200,pointerId:1}));viewport.dispatchEvent(new PointerEvent('pointermove',{clientX:100,clientY:100,pointerId:1}));viewport.dispatchEvent(new PointerEvent('pointerup',{pointerId:1}));})()`);
        assert.ok(await frame.executeJavaScript(`document.querySelector('#viewport').scrollLeft>0`),'SVG panning');
        assert.equal(await frame.executeJavaScript(`document.querySelector('#page').querySelector('script,foreignObject,iframe')===null`),true,'SVG is decoded as an image rather than inserted as active DOM');
      }else{
        assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).dataset.previewFrames`),'2');
        const initial=await frame.executeJavaScript(`[...document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data]`);
        await frame.executeJavaScript(`[...document.querySelectorAll('button')].find(node=>node.textContent==='Next frame').click()`);
        await until(()=>js(`document.querySelector(${JSON.stringify(selector)}).dataset.previewFrame==='1'`),ref.name+' next frame');
        const next=await frame.executeJavaScript(`[...document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data]`);assert.notDeepEqual(next,initial,'actual decoded frames differ');
        await frame.executeJavaScript(`[...document.querySelectorAll('button')].find(node=>node.textContent==='Play').click()`);await until(()=>js(`document.querySelector(${JSON.stringify(selector)}).dataset.previewFrame==='0'`),ref.name+' plays');
        await frame.executeJavaScript(`[...document.querySelectorAll('button')].find(node=>node.textContent==='Pause').click()`);
      }
      await save({chatId:chat.id,mediaId:ref.id,...(deviceId?{deviceId}:{})},files[ref.name],(deviceId?'remote-':'local-')+ref.name);
      await capture?.((deviceId?'remote-':'local-')+ref.name.replace('.','-'));
    }
    assert.equal(externalRequests,0);checks.push(`${deviceId?'Paired TLS':'Local'} PDF/DOCX selection, pages/zoom and persistent revision/page annotations; SVG sanitized image pan/zoom; GIF/APNG actual frame play/pause/step; every original saves byte-identically`);
  }
  return{refs,run,async reconnect(scope){
    const ref=refs[0],selector=scope+` [data-media-id="${ref.id}"]`;await js(`document.querySelectorAll(${JSON.stringify(scope+' details')}).forEach(node=>node.open=true);document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    await until(()=>js(`Boolean(document.querySelector(${JSON.stringify(selector)})?.dataset.previewLoaded)`),'reconnected PDF preview');
    assert.equal(await js(`(()=>{const text=document.querySelector(${JSON.stringify(selector+' .document-notes')}).textContent;return text.includes('Local review')&&text.includes('Remote review')})()`),true,'persisted notes survive a reconnect');
    const animation=refs.find(ref=>ref.kind==='animation'),animationSelector=scope+` [data-media-id="${animation.id}"]`;await js(`document.querySelector(${JSON.stringify(animationSelector)}).scrollIntoView({block:'center'})`);await until(()=>js(`Boolean(document.querySelector(${JSON.stringify(animationSelector)})?.dataset.previewLoaded)`),'reconnected animation');const frame=await child(animation,scope);assert.equal(await frame.executeJavaScript(`[...document.querySelectorAll('button')].some(node=>node.textContent==='Play')&&![...document.querySelectorAll('button')].some(node=>node.textContent==='Pause')`),true,'reconnected animation remains paused');checks.push('Explicit paired reconnect restores saved revision/page annotations and leaves animation paused');
  },async malformed(scope){
    const name='malformed.docx';await fs.writeFile(path.join(project.path,name),zipFixture({'[Content_Types].xml':'<Types/>','word/document.xml':'<!DOCTYPE x [<!ENTITY y SYSTEM "https://preview.invalid/secret">]><document/>'}));const {media}=await bridge('tool.run',{chatId:chat.id,name:'media_show',args:{path:name}});await until(()=>js(`Boolean(document.querySelector(${JSON.stringify(scope+` [data-media-id="${media.id}"]`)}))`),'malformed descriptor');await js(`document.querySelectorAll(${JSON.stringify(scope+' details')}).forEach(node=>node.open=true);document.querySelector(${JSON.stringify(scope+` [data-media-id="${media.id}"]`)}).scrollIntoView({block:'center'})`);await until(()=>js(`document.querySelector(${JSON.stringify(scope+` [data-media-id="${media.id}"] .media-status`)})?.textContent.includes('entity')`),'DOCX external entity rejection');checks.push('Malformed DOCX entities are rejected inside the isolated preview');
  }};
}
