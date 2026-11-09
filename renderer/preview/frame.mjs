import {docxPages} from './docx.mjs';
const token=location.hash.slice(1),page=document.querySelector('#page'),toolbar=document.querySelector('#toolbar'),status=document.querySelector('#status'),viewport=document.querySelector('#viewport');
let payload,pageNumber=1,pageCount=1,zoom=1,pdf,pdfTask,renderTask,decoder,animationTimer,frameIndex=0,frameCount=1,playing=false,stopped=false,notes=[],objectUrl,renderVersion=0;
const send=(type,extra={})=>parent.postMessage({token,type,...extra},'*');
const button=(label,action)=>{const node=document.createElement('button');node.type='button';node.textContent=label;node.addEventListener('click',()=>Promise.resolve(action()).catch(fail));toolbar.append(node);return node;};
const fail=error=>{if(error.name==='RenderingCancelledException')return;stop();status.hidden=false;status.textContent=error.message||'This attachment cannot be previewed.';send('error',{message:status.textContent});};
function report(){send('state',{page:pageNumber,pages:pageCount,zoom,frame:frameIndex,frames:frameCount,playing});}
function boundedCanvas(width,height){if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width*height>8_000_000||width>8192||height>8192)throw new Error('Decoded page or frame exceeds the preview pixel limit');const canvas=document.createElement('canvas');canvas.width=Math.ceil(width);canvas.height=Math.ceil(height);return canvas;}
function highlight(){
  if(!globalThis.Highlight||!CSS.highlights)return;
  const nodes=[];const walk=document.createTreeWalker(page,NodeFilter.SHOW_TEXT);while(walk.nextNode())nodes.push(walk.currentNode);
  const text=nodes.map(node=>node.textContent).join(''),ranges=[];
  for(const note of notes.filter(note=>note.page===pageNumber&&note.quote)){
    const start=Number.isInteger(note.anchorStart)?note.anchorStart:text.indexOf(note.quote);if(start<0||text.slice(start,start+note.quote.length)!==note.quote)continue;const range=document.createRange();let offset=0,started=false;
    for(const node of nodes){const end=offset+node.length;if(!started&&start<end){range.setStart(node,start-offset);started=true;}if(started&&start+note.quote.length<=end){range.setEnd(node,start+note.quote.length-offset);ranges.push(range);break;}offset=end;}
  }
  CSS.highlights.set('faber-notes',new Highlight(...ranges));
}
async function render(){
  const version=++renderVersion;renderTask?.cancel();page.replaceChildren();status.textContent=payload.pages?'DOCX text reflow. Tables have labeled cells; graphics have placeholders. Original Word pagination and layout may differ.':'';status.hidden=!payload.pages;
  if(pdf){
    const source=await pdf.getPage(pageNumber);if(version!==renderVersion||stopped)return;const size=source.getViewport({scale:zoom}),canvas=boundedCanvas(size.width,size.height);page.append(canvas);page.style.width=size.width+'px';page.style.height=size.height+'px';
    renderTask=source.render({canvasContext:canvas.getContext('2d'),viewport:size});const deadline=setTimeout(()=>{renderTask?.cancel();void pdfTask.destroy();fail(new Error('PDF page rendering exceeded 30 seconds'));},30000);try{await renderTask.promise;}finally{clearTimeout(deadline);}if(version!==renderVersion||stopped)return;
    const text=await source.getTextContent();if(text.items.length>50000||text.items.reduce((sum,item)=>sum+(item.str?.length||0),0)>2_000_000)throw new Error('PDF text layer limit exceeded');
    const layer=document.createElement('div');layer.className='text-layer';page.append(layer);
    for(const item of text.items){if(typeof item.str!=='string')continue;const span=document.createElement('span'),m=pdfLib.Util.transform(size.transform,item.transform),height=Math.hypot(m[2],m[3]);span.textContent=item.str;span.style.left=m[4]+'px';span.style.top=(m[5]-height)+'px';span.style.fontSize=height+'px';span.style.fontFamily='sans-serif';layer.append(span);const measured=span.getBoundingClientRect().width;if(measured&&item.width)span.style.transform=`scaleX(${item.width*zoom/measured})`;}
  }else if(payload.pages){
    const doc=document.createElement('div');doc.className='docx';for(const parts of payload.pages[pageNumber-1]){const p=document.createElement('p');for(const part of parts){const span=document.createElement('span');span.textContent=part.text;if(part.bold)span.style.fontWeight='bold';if(part.italic)span.style.fontStyle='italic';p.append(span);}doc.append(p);}page.append(doc);page.style.width=(760*zoom)+'px';page.style.height='auto';doc.style.zoom=zoom;
  }else if(payload.ref.kind==='vector'){
    const image=document.createElement('img');image.src=objectUrl;image.style.width=(payload.width*zoom)+'px';image.alt=payload.ref.name;image.draggable=false;page.append(image);await image.decode();page.style.width='fit-content';page.style.height='auto';
  }else if(decoder){await drawFrame();}
  highlight();report();
}
let pdfLib;
async function drawFrame(){
  const frame=await decoder.decode({frameIndex,completeFramesOnly:true});try{if(stopped)return;if(frame.image.displayWidth*frame.image.displayHeight*frameCount>32_000_000)throw new Error('Animation exceeds its decoded frame memory limit');const canvas=boundedCanvas(frame.image.displayWidth,frame.image.displayHeight);canvas.getContext('2d').drawImage(frame.image,0,0);page.replaceChildren(canvas);canvas.style.width=(canvas.width*zoom)+'px';canvas.style.height=(canvas.height*zoom)+'px';status.hidden=false;status.textContent=`Frame ${frameIndex+1} of ${frameCount}`;report();if(playing)animationTimer=setTimeout(()=>{frameIndex=(frameIndex+1)%frameCount;void drawFrame().catch(fail);},Math.max(20,Math.min(10000,(frame.image.duration||100000)/1000)));}finally{frame.image.close();}
}
function stop(){stopped=true;playing=false;clearTimeout(animationTimer);renderTask?.cancel();decoder?.close();void pdfTask?.destroy();if(objectUrl)URL.revokeObjectURL(objectUrl);}
async function open(data){
  send('phase',{phase:'opening'});
  payload=data;notes=data.notes||[];pageNumber=Math.max(1,data.initial?.page||1);zoom=Math.max(.25,Math.min(3,data.initial?.zoom||1));toolbar.replaceChildren();
  if(data.ref.kind==='document'){
    if(data.ref.mimeType==='application/pdf'){
      pdfLib=await import('faber-preview://viewer/pdfjs/build/pdf.mjs');pdfLib.GlobalWorkerOptions.workerSrc='faber-preview://viewer/pdfjs/build/pdf.worker.mjs';
      send('phase',{phase:'pdf-library-ready'});
      pdfTask=pdfLib.getDocument({data:new Uint8Array(data.bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,maxImageSize:8_000_000,stopAtErrors:true,cMapUrl:'faber-preview://viewer/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'faber-preview://viewer/pdfjs/standard_fonts/',wasmUrl:'faber-preview://viewer/pdfjs/wasm/',useWorkerFetch:true});
      const deadline=setTimeout(()=>{void pdfTask.destroy();fail(new Error('PDF loading exceeded 15 seconds'));},15000);try{pdf=await pdfTask.promise;}finally{clearTimeout(deadline);}pageCount=pdf.numPages;if(pageCount>2000)throw new Error('PDF page limit exceeded');
    }else{payload.pages=await docxPages(data.bytes);pageCount=payload.pages.length;status.hidden=false;status.textContent='DOCX reflow preview. Original Word pagination may differ.';}
    pageNumber=Math.min(pageNumber,pageCount);button('Previous page',async()=>{pageNumber=Math.max(1,pageNumber-1);await render();});const label=document.createElement('span');label.id='page-label';toolbar.append(label);button('Next page',async()=>{pageNumber=Math.min(pageCount,pageNumber+1);await render();});
  }else if(data.ref.kind==='vector'){
    const xml=new TextDecoder('utf-8',{fatal:true}).decode(data.bytes);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('SVG entity declarations are unsupported');const doc=new DOMParser().parseFromString(xml,'image/svg+xml');if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg'||doc.documentElement.namespaceURI!=='http://www.w3.org/2000/svg')throw new Error('Malformed SVG');
    const nodes=[...doc.querySelectorAll('*')];if(nodes.length>20000)throw new Error('SVG element limit exceeded');
    for(const node of nodes){if(['script','foreignObject','iframe','object','embed','audio','video','style','animate','set','animateTransform','animateMotion'].includes(node.localName)){node.remove();continue;}for(const attribute of [...node.attributes])if(/^on/i.test(attribute.name)||attribute.localName==='href'&&!attribute.value.startsWith('#')||/url\s*\(\s*[^#]/i.test(attribute.value)||attribute.name==='style')node.removeAttribute(attribute.name);}
    const root=doc.documentElement,box=(root.getAttribute('viewBox')||'').trim().split(/[ ,]+/).map(Number);data.width=Number.parseFloat(root.getAttribute('width'))||box[2]||800;data.height=Number.parseFloat(root.getAttribute('height'))||box[3]||600;boundedCanvas(data.width,data.height);objectUrl=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)],{type:'image/svg+xml'}));
    let drag;viewport.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};if(event.isTrusted)viewport.setPointerCapture(event.pointerId);});viewport.addEventListener('pointermove',event=>{if(drag){viewport.scrollLeft=drag.left+drag.x-event.clientX;viewport.scrollTop=drag.top+drag.y-event.clientY;}});viewport.addEventListener('pointerup',()=>{drag=null;});
  }else{
    const type=data.ref.mimeType==='image/apng'?'image/png':data.ref.mimeType;if(!globalThis.ImageDecoder||!await ImageDecoder.isTypeSupported(type))throw new Error('This animation decoder is unavailable');decoder=new ImageDecoder({data:data.bytes,type,preferAnimation:true});await decoder.tracks.ready;frameCount=decoder.tracks.selectedTrack.frameCount;if(!frameCount||frameCount>500)throw new Error('Animation frame limit exceeded');
    const play=button('Play',async()=>{playing=!playing;play.textContent=playing?'Pause':'Play';clearTimeout(animationTimer);if(playing)await drawFrame();else report();});button('Previous frame',async()=>{playing=false;play.textContent='Play';clearTimeout(animationTimer);frameIndex=(frameIndex+frameCount-1)%frameCount;await drawFrame();});button('Next frame',async()=>{playing=false;play.textContent='Play';clearTimeout(animationTimer);frameIndex=(frameIndex+1)%frameCount;await drawFrame();});
  }
  button('Zoom out',async()=>{zoom=Math.max(.25,zoom-.25);await render();});button('Zoom in',async()=>{zoom=Math.min(3,zoom+.25);await render();});button('Reset zoom',async()=>{zoom=1;await render();});
  await render();send('loaded',{pages:pageCount,frames:frameCount,bridgeAbsent:typeof window.faber==='undefined'});
}
addEventListener('message',event=>{if(event.source!==parent||event.data?.token!==token)return;if(event.data.type==='open'&&!payload)void open(event.data).catch(fail);if(event.data.type==='notes'){notes=event.data.notes||[];highlight();}if(event.data.type==='page'&&Number.isInteger(event.data.page)&&event.data.page>=1&&event.data.page<=pageCount){pageNumber=event.data.page;void render().catch(fail);}if(event.data.type==='stop')stop();});
document.addEventListener('selectionchange',()=>{const selection=getSelection();if(selection?.rangeCount&&page.contains(selection.anchorNode)&&page.contains(selection.focusNode)){const range=selection.getRangeAt(0),prefix=range.cloneRange();prefix.selectNodeContents(page);prefix.setEnd(range.startContainer,range.startOffset);send('selection',{page:pageNumber,quote:selection.toString().slice(0,4000),anchorStart:prefix.toString().length});}});
const observer=new MutationObserver(()=>{const label=document.querySelector('#page-label');if(label)label.textContent=`Page ${pageNumber} of ${pageCount}`;});observer.observe(page,{childList:true});
addEventListener('pagehide',stop);send('ready');
