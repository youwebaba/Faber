export function createRemoteWorkInbox({document,el,rpc,selectChat,device,available}) {
  const dialog=el('dialog','remote-inbox'),heading=el('h2','','Host Work Inbox'),body=el('section','modal-section'),notice=el('p','hint');
  heading.id='host-work-title';dialog.setAttribute('aria-labelledby',heading.id);
  let target,selected,sequence=0,timer,draft='',offset=0;
  function button(text,action){
    const node=el('button','button',text);node.type='button';
    node.onclick=async()=>{node.disabled=true;try{await action();}catch(error){if(dialog.open)notice.textContent=error.message;}finally{node.disabled=false;}};
    return node;
  }
  function close(){clearTimeout(timer);sequence++;if(dialog.open)dialog.close();}
  const bar=el('header','modal-actions');bar.append(heading,button('Close',close));
  dialog.append(bar,notice,body);document.body.append(dialog);
  dialog.addEventListener('close',()=>{clearTimeout(timer);sequence++;selected=target=undefined;draft='';body.replaceChildren();});
  function connectionChanged(){if(dialog.open&&(target!==device()||!available()))close();}
  function poll(){
    clearTimeout(timer);
    if(!dialog.open)return;
    timer=setTimeout(()=>{
      if(body.contains(document.activeElement)||body.querySelector('details[open]')){poll();return;}
      void show().catch(error=>{if(dialog.open){notice.textContent=error.message;poll();}});
    },3000);
  }
  async function show(){
    const token=++sequence;clearTimeout(timer);connectionChanged();if(!dialog.open)return;
    const value=await rpc(selected?'work.read':'work.list',selected?{jobId:selected}:{offset,limit:50},target);
    if(!dialog.open||token!==sequence||device()!==target)return;
    notice.textContent='';body.replaceChildren();
    if(!selected){
      for(const job of value.jobs)body.append(button(job.name+' · '+job.status+' · '+job.projectName,()=>{selected=job.id;draft='';return show();}));
      if(!value.jobs.length)body.append(el('p','hint','No routine jobs on this host.'));
      if(offset)body.append(button('Newer jobs',()=>{offset=Math.max(0,offset-50);return show();}));
      if(value.nextOffset!==null)body.append(button('Older jobs',()=>{offset=value.nextOffset;return show();}));
    }else{
      const j=value;
      body.append(button('Back to jobs',()=>{selected=undefined;draft='';return show();}),el('h3','',j.name),el('p','hint',[j.projectName,j.status,'Attempt '+j.attempts].join(' · ')));
      if(j.reason)body.append(el('p','',j.reason));
      if(j.chatId)body.append(button('Open activity chat',async()=>{close();await selectChat(j.chatId,j.projectId);}));
      const evidence=[['Current step',j.step],['Source files',j.sources],['Outputs',j.outputs],['Report',j.report],['Budget',j.budget]];
      for(const [label,item] of evidence)if(item&&(!Array.isArray(item)||item.length)){const details=el('details','modal-section');details.append(el('summary','',label),el('pre','result-content',JSON.stringify(item,null,2)));body.append(details);}
      for(const a of j.approvals){const section=el('section','approval');section.append(el('p','',a.summary));
        for(const [label,allow] of [['Allow this step',true],['Deny',false]])section.append(button(label,async()=>{await rpc('work.approve',{jobId:j.id,runId:a.runId,id:a.id,allow},target);await show();}));
        body.append(section);
      }
      if(['queued','loading_model','running','waiting_approval','waiting_interaction','waiting_resource'].includes(j.status)){
        if(j.runId){const label=el('label','form-row','Correction for this attempt'),box=el('textarea');box.value=draft;box.oninput=()=>{draft=box.value;};label.append(box);body.append(label,button('Steer job',async()=>{await rpc('work.steer',{jobId:j.id,runId:j.runId,correctionId:crypto.randomUUID(),text:draft},target);draft='';await show();}));}
        body.append(button('Stop job',async()=>{await rpc('work.stop',{jobId:j.id,...(j.runId?{runId:j.runId}:{})},target);await show();}));
      }
    }
    body.append(button('Refresh',show));
    poll();
  }
  async function open(){if(dialog.open)return;target=device();selected=undefined;offset=0;draft='';notice.textContent='Loading host jobs…';dialog.showModal();await show();}
  return {open,connectionChanged,close};
}
