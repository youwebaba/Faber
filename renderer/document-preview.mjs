let transfers=Promise.resolve();
export function createDocumentPreview({ref,context,source,request,document=globalThis.document,window=globalThis.window,available=true}) {
  const node=document.createElement('figure');node.className='message-media document-preview';node.dataset.mediaId=ref.id;
  const caption=document.createElement('figcaption');caption.textContent=ref.name;
  const frame=document.createElement('iframe');frame.title=ref.name;frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.setAttribute('referrerpolicy','no-referrer');
  const status=document.createElement('p');status.className='media-status hint';status.setAttribute('role','status');
  const controls=document.createElement('div');controls.className='document-actions';const button=(text,handler)=>{const button=document.createElement('button');button.type='button';button.className='button';button.textContent=text;button.addEventListener('click',()=>Promise.resolve(handler()).catch(error=>{status.textContent=error.message;}));controls.append(button);return button;};
  const owner={chatId:context.chatId,...(context.deviceId?{deviceId:context.deviceId}:{})},annotationOwner={...owner,mediaId:ref.id,revision:ref.revision};
  let controller,token,loaded=false,page=1,pages=1,zoom=1,quote='',anchorStart,notes=[],pending,disposed=false,visible=false;
  const post=(type,extra={})=>frame.contentWindow?.postMessage({token,type,...extra},'*');
  const save=button('Save original…',()=>request('media.save',{...owner,mediaId:ref.id}));
  const pageLabel=document.createElement('span');pageLabel.className='preview-page-label';controls.append(pageLabel);
  const noteBox=document.createElement('div');noteBox.className='document-notes';
  const input=document.createElement('textarea');input.maxLength=2000;input.placeholder='Add a note to this page';input.setAttribute('aria-label','Document note');
  const list=document.createElement('ol');list.setAttribute('aria-label','Saved document highlights and notes');
  function renderNotes(){list.replaceChildren();for(const note of notes){const row=document.createElement('li'),text=document.createElement('span');text.textContent=`Page ${note.page}: ${note.quote?`“${note.quote}” `:''}${note.text}`;const go=document.createElement('button');go.type='button';go.textContent='Go to page';go.addEventListener('click',()=>post('page',{page:note.page}));const remove=document.createElement('button');remove.type='button';remove.textContent='Delete';remove.setAttribute('aria-label','Delete annotation');remove.addEventListener('click',async()=>{try{const value=await request('media.notes.delete',{...annotationOwner,noteId:note.id});notes=value.notes;renderNotes();post('notes',{notes});}catch(error){status.textContent=error.message;}});row.append(text,go,remove);list.append(row);}}
  async function annotate(kind){
    if(!loaded||!available)throw new Error('Open the document before annotating it');
    if(kind==='highlight'&&!quote)throw new Error('Select document text to highlight');
    if(kind==='note'&&!input.value.trim()&&!quote)throw new Error('Write a note or select document text');
    const fields={...annotationOwner,page,kind,quote,text:input.value.trim(),...(quote&&anchorStart!==undefined?{anchorStart}:{})},key=JSON.stringify(fields);
    if(pending?.key!==key)pending={key,args:{...fields,noteId:crypto.randomUUID()}};
    const value=await request('media.notes.save',pending.args);pending=null;notes=value.notes;input.value='';renderNotes();post('notes',{notes});status.textContent='Annotation saved.';
  }
  const highlight=ref.kind==='document'?button('Highlight selection',()=>annotate('highlight')):null;
  if(ref.kind==='document'){button('Save note',()=>annotate('note'));noteBox.append(input,list);}node.append(caption,controls,frame,status,noteBox);
  async function load(){
    const active=controller;status.textContent='Loading attachment…';
    try{
      const response=await fetch(source,{signal:active.signal,cache:'no-store'});if(!response.ok||Number(response.headers.get('content-length'))!==ref.bytes||response.headers.get('content-type')!==ref.mimeType)throw new Error('Attachment is no longer available');
      const bytes=new Uint8Array(ref.bytes),reader=response.body.getReader();let offset=0;
      try{while(true){const next=await reader.read();if(next.done)break;if(offset+next.value.length>bytes.length)throw new Error('Attachment exceeds its declared size');bytes.set(next.value,offset);offset+=next.value.length;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(offset!==bytes.length)throw new Error('Attachment transfer was incomplete');
      if(ref.kind==='document'){const value=await request('media.notes.read',annotationOwner);notes=value.notes;renderNotes();}
      active.signal.throwIfAborted();if(controller!==active||disposed)return;
      post('open',{bytes:bytes.buffer,ref,notes,initial:{page,zoom}});status.textContent='Opening preview…';
    }catch(error){if(!active.signal.aborted)status.textContent=error.message;}
  }
  const receive=event=>{
    const value=event.data;if(disposed||event.source!==frame.contentWindow||value?.token!==token)return;
    if(value.type==='ready'){const active=controller;transfers=transfers.catch(()=>{}).then(()=>{if(controller===active&&!active.signal.aborted)return load();});}
    if(value.type==='phase'&&typeof value.phase==='string')node.dataset.previewPhase=value.phase;
    if(value.type==='loaded'){loaded=true;node.dataset.previewLoaded='true';status.textContent='';if(value.bridgeAbsent!==true){stop();status.textContent='Preview isolation could not be established';}}
    if(value.type==='state'&&Number.isInteger(value.page)&&value.page>=1&&Number.isInteger(value.pages)&&value.pages>=1&&value.pages<=2000&&Number.isFinite(value.zoom)&&value.zoom>=.25&&value.zoom<=3){if(page!==value.page){quote='';anchorStart=undefined;if(highlight)highlight.disabled=true;}page=value.page;pages=value.pages;zoom=value.zoom;pageLabel.textContent=ref.kind==='document'?`Page ${page} of ${pages}`:`${Math.round(zoom*100)}%`;node.dataset.previewPages=String(pages);node.dataset.previewFrame=String(value.frame||0);node.dataset.previewFrames=String(value.frames||1);}
    if(value.type==='selection'&&value.page===page&&typeof value.quote==='string'&&value.quote.length<=4000&&Number.isInteger(value.anchorStart)&&value.anchorStart>=0&&value.anchorStart<=2_000_000){quote=value.quote;anchorStart=value.anchorStart;if(highlight)highlight.disabled=!quote;}
    if(value.type==='error'&&typeof value.message==='string')status.textContent=value.message.slice(0,500);
  };
  window.addEventListener('message',receive);
  function start(){if(disposed)return;controller=new AbortController();token=crypto.randomUUID();loaded=false;quote='';anchorStart=undefined;if(highlight)highlight.disabled=true;frame.src=`faber-preview://viewer/index.html#${token}`;save.disabled=false;}
  function stop(){controller?.abort();post('stop');loaded=false;delete node.dataset.previewLoaded;frame.src='about:blank';if(highlight)highlight.disabled=true;}
  const observer=new window.IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(visible&&available&&!controller)start();});observer.observe(node);
  if(!available)status.textContent='Connect to the host to open this attachment.';
  return {node,preview:true,stop,setAvailable(value){available=value;if(value){controller=undefined;if(visible)start();}else{stop();status.textContent='Connect to the host to open this attachment.';}},destroy(){stop();disposed=true;observer.disconnect();window.removeEventListener('message',receive);}};
}
