export function createCaptureUI({document,request,subscribe,el,button}){
  const toolbar=document.querySelector('.header-actions'),launch=button('Share video',choose,'button');
  const indicator=el('div','capture-indicator'),label=el('strong'),end=button('Stop',()=>stop(),'button');
  indicator.setAttribute('role','status');indicator.hidden=true;indicator.append(label,end);toolbar.prepend(launch,indicator);
  const dialog=el('dialog','capture-dialog'),title=el('h2','','Share live video'),body=el('section','modal-section'),notice=el('p','hint');
  title.id='capture-title';dialog.setAttribute('aria-labelledby',title.id);dialog.append(title,body,notice);document.body.append(dialog);
  const video=el('video','capture-preview');video.muted=true;video.playsInline=true;video.autoplay=true;
  const canvas=el('canvas'),context=canvas.getContext('2d',{alpha:false});
  let selection,stream,timer,work=0,closing=false;
  function action(text,fn){return button(text,async()=>{try{await fn();}catch(error){notice.textContent=error.message;}},'button');}
  function clean(){clearTimeout(timer);work++;for(const track of stream?.getTracks()||[])track.stop();stream=null;video.srcObject=null;selection=null;indicator.hidden=true;launch.hidden=false;}
  async function stop(){clean();await request('capture.stop');if(dialog.open)dialog.close();}
  function showError(error){notice.textContent=error.message;void stop().catch(()=>{});}
  async function choose(){
    if(dialog.open)return;
    dialog.showModal();title.textContent='Share live video';body.replaceChildren();notice.textContent='Loading available sources…';
    try{
      const [options,cameras]=await Promise.all([request('capture.sources'),navigator.mediaDevices.enumerateDevices().catch(()=>[])]);
      if(!dialog.open)return;
      const sourceLabel=el('label','form-row','Source'),source=el('select'),viewerLabel=el('label','form-row','Viewer'),viewer=el('select');
      const all=[...options.sources.map(s=>({kind:s.id.split(':')[0],id:s.id,name:s.name})),
        ...cameras.filter(d=>d.kind==='videoinput'&&d.deviceId).map((d,i)=>({kind:'camera',id:d.deviceId,name:d.label||'Camera '+(i+1)}))];
      if(!all.some(s=>s.kind==='camera'))all.push({kind:'camera',id:'default',name:'System default camera'});
      all.forEach((s,i)=>source.add(new Option(s.name,String(i))));viewer.add(new Option('This PC only',''));
      for(const d of options.controllers)viewer.add(new Option(d.name,d.id));
      sourceLabel.append(source);viewerLabel.append(viewer);notice.textContent='';body.append(sourceLabel,viewerLabel,
        action('Review share',async()=>{
          const selected=all[Number(source.value)],approval=await request('capture.prepare',{kind:selected.kind,source:selected.id,...(viewer.value?{deviceId:viewer.value}:{})});
          if(!dialog.open){await request('capture.stop');return;}
          selection={...selected,...approval,source:selected.id};body.replaceChildren(el('p','',selected.name+(approval.viewer?' → '+approval.viewer:' · This PC only')),action('Start sharing',start),action('Cancel',stop));
        }),action('Cancel',()=>dialog.close()));
    }catch(error){notice.textContent=error.message;body.append(action('Close',()=>dialog.close()));}
  }
  async function start(){
    if(!selection||stream)return;
    const s=selection,epoch=++work;
    const options={frameRate:{ideal:10,max:15},width:{ideal:1280},height:{ideal:720}};
    try{
      const result=await(s.kind==='camera'?navigator.mediaDevices.getUserMedia({video:{...options,...(s.source!=='default'?{deviceId:{exact:s.source}}:{})},audio:false}):navigator.mediaDevices.getDisplayMedia({video:true,audio:false}));
      if(epoch!==work||s!==selection){for(const t of result.getTracks())t.stop();return;}
      stream=result;for(const t of stream.getVideoTracks())t.addEventListener('ended',()=>void stop().catch(()=>{}),{once:true});
      video.srcObject=stream;body.replaceChildren(video,action('Stop sharing',stop),action('Return to chat',()=>{closing=true;dialog.close();}));
      await video.play();await request('capture.started',{id:s.id});
      if(epoch!==work)return;
      launch.hidden=true;indicator.hidden=false;label.textContent='● Live · '+s.name+(s.viewer?' → '+s.viewer:'');
      async function frame(){
        if(epoch!==work)return;
        try{
          if(!s.viewer){await request('capture.heartbeat',{id:s.id});}
          else if(video.videoWidth&&video.videoHeight){
            const ratio=Math.min(1,1280/video.videoWidth,720/video.videoHeight);canvas.width=Math.max(1,Math.floor(video.videoWidth*ratio));canvas.height=Math.max(1,Math.floor(video.videoHeight*ratio));
            context.drawImage(video,0,0,canvas.width,canvas.height);
            let jpeg=canvas.toDataURL('image/jpeg',0.64);
            if(jpeg.length>131094){canvas.width=Math.max(1,Math.floor(canvas.width/2));canvas.height=Math.max(1,Math.floor(canvas.height/2));context.drawImage(video,0,0,canvas.width,canvas.height);jpeg=canvas.toDataURL('image/jpeg',0.49);}
            if(jpeg.length<=131094)await request('capture.frame',{id:s.id,jpeg});
          }
          if(epoch===work)timer=setTimeout(frame,s.viewer?210:1200);
        }catch(error){if(epoch===work)showError(error);}
      }
      await frame();
    }catch(error){clean();await request('capture.stop').catch(()=>{});notice.textContent=error.message;body.replaceChildren(action('Close',()=>dialog.close()));}
  }
  dialog.addEventListener('close',()=>{if(!closing&&selection)void stop().catch(()=>{});closing=false;});
  subscribe(e=>{if(e.type==='capture'&&e.state.phase==='off'){clean();notice.textContent=e.state.reason||'Sharing stopped.';if(dialog.open)body.replaceChildren(action('Close',()=>dialog.close()));}});
  window.addEventListener('pagehide',clean,{once:true});
}
