import {validateLiveFrame} from './live-frame.mjs';

export function createLiveViewer({document,el,rpc,device,available}){
  const dialog=el('dialog','capture-dialog'),title=el('h2','','Live video'),status=el('p','hint'),image=el('img','capture-preview'),stop=el('button','button','Stop watching');
  title.id='remote-capture-title';image.alt='Live video from the paired device';image.hidden=true;dialog.setAttribute('aria-labelledby',title.id);
  let session,target,generation=0,timer;
  function end(message,notify=true){
    generation++;clearTimeout(timer);const last=session,peer=target;session=undefined;target=undefined;
    image.removeAttribute('src');image.hidden=true;status.textContent=message;
    if(notify&&last&&peer===device()&&available())void rpc('capture.leave',last,peer).catch(()=>{});
  }
  stop.onclick=()=>dialog.close();dialog.append(title,status,image,stop);document.body.append(dialog);
  dialog.addEventListener('close',()=>end('Stopped watching.'));
  function connectionChanged(){if(target&&(target!==device()||!available()))end('Viewing ended because the connection changed. The host must authorize a new share.',false);}
  async function open(){
    if(dialog.open)return;dialog.showModal();target=device();const token=++generation;status.textContent='Checking the host…';
    try{
      const share=await rpc('capture.status',{},target);
      if(token!==generation)return;
      if(!share.id){end('The host is not sharing video with this device.',false);return;}
      session={id:share.id,view:crypto.randomUUID()};await rpc('capture.join',session,target);
      if(token!==generation)return;status.textContent='Live · '+share.label;let after=0;
      const next=async()=>{
        try{
          if(!available()||target!==device()){connectionChanged();return;}
          const frame=await rpc('capture.read',{...session,after},target);
          if(token!==generation)return;
          if(frame.jpeg){
            image.src=validateLiveFrame(frame.jpeg);image.hidden=false;after=frame.sequence;
          }
          timer=setTimeout(next,220);
        }catch(error){if(token===generation)end('Viewing ended. '+error.message);}
      };
      await next();
    }catch(error){if(token===generation)end(error.message);}
  }
  return {open,connectionChanged};
}
