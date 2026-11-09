const capabilities=[
  ['inbox','Read inbox'],['drafts','Prepare reply drafts'],['send','Send reviewed drafts'],
  ['calendar','Read calendar'],['events','Create reviewed events and invitations']
];

export async function mountOutlook(pane,{request,getState,el,button,field,selectField,actions}) {
  const projects=getState().projects.filter(project=>!project.archived);
  let generation=0;
  const heading=text=>pane.replaceChildren(el('h3','',text));
  async function show(){
    const token=++generation,state=await request('outlook.state');
    if(token!==generation||!pane.isConnected)return;
    heading('Outlook & Microsoft 365');
    if(!projects.length){pane.append(el('p','hint','Create a project to connect a mailbox and calendar.'));return;}
    pane.append(button('Connect a project',()=>edit()));
    for(const record of state.connections){
      const project=projects.find(item=>item.id===record.projectId);
      const section=el('section','modal-section');
      section.append(el('h4','',project?.name||'Archived project'),el('p','hint',record.connected?'Connected · '+(record.accountName||'Microsoft account'):'Sign-in required'));
      section.append(el('p','',capabilities.filter(([key])=>record.caps[key]).map(([,label])=>label).join(' · ')));
      const controls=[button('Edit access',()=>edit(record))];
      if(record.connected){
        if(record.caps.inbox&&record.caps.drafts&&project)controls.push(button('Create triage routine',()=>triage(record)));
        controls.push(button('Disconnect',async()=>{await request('outlook.disconnect',{projectId:record.projectId});await show();}));
      }else if(project)controls.push(button('Sign in with Microsoft',()=>signIn(record),'button primary'));
      controls.push(button('Remove connection',async()=>{await request('outlook.remove',{projectId:record.projectId});await show();}));
      section.append(actions(...controls));pane.append(section);
    }
  }
  function edit(record={}){
    ++generation;heading('Project mailbox and calendar');
    const projectsField=selectField('Project',projects.map(p=>({value:p.id,label:p.name})),record.projectId||projects[0].id);
    projectsField.input.disabled=Boolean(record.projectId);
    const client=field('Application (client) ID',record.clientId||'','text','From your Microsoft Entra public-client app registration.'),
      tenant=field('Tenant',record.tenant||'common','text','Enter common, organizations, consumers or your directory (tenant) ID.');
    pane.append(projectsField.wrapper,client.wrapper,tenant.wrapper);
    const checks=new Map(capabilities.map(([key,label])=>{
      const row=field(label,'','checkbox');row.input.checked=Boolean(record.caps?.[key]??(key==='inbox'||key==='calendar'));pane.append(row.wrapper);return [key,row.input];
    }));
    pane.append(actions(button('Back',show),button('Save connection',async()=>{
      const caps=Object.fromEntries([...checks].map(([k,input])=>[k,input.checked]));
      await request('outlook.configure',{projectId:projectsField.input.value,clientId:client.input.value.trim(),tenant:tenant.input.value.trim(),caps});await show();
    },'button primary')));
  }
  async function signIn(record){
    const token=++generation,projectId=record.projectId,sign=await request('outlook.signIn',{projectId});
    if(!pane.isConnected||token!==generation)return;
    heading('Sign in with Microsoft');
    pane.append(el('p','','Enter this code on Microsoft’s sign-in page.'),el('code','',sign.userCode),
      actions(button('Open Microsoft sign-in',()=>request('app.openLink',{url:sign.verificationUrl}),'button primary'),
      button('Cancel',async()=>{++generation;await request('outlook.disconnect',{projectId});await show();})));
    const progress=el('p','hint','Waiting for Microsoft sign-in…');pane.append(progress);
    while(pane.isConnected&&token===generation){
      const status=await request('outlook.poll',{projectId});
      if(token!==generation||!pane.isConnected)return;
      if(!status.pending){await show();return;}
      await new Promise(resolve=>setTimeout(resolve,Math.max(500,Math.min(30000,status.next-Date.now()))));
    }
  }
  function triage(record){
    ++generation;heading('Create a mail-triage routine');
    const providers=getState().providers,provider=selectField('Model connection',providers.map(p=>({value:p.id,label:p.name})),providers[0]?.id);
    const model=field('Model',providers[0]?.model||'');
    provider.input.addEventListener('change',()=>{model.input.value=providers.find(p=>p.id===provider.input.value)?.model||'';});
    pane.append(provider.wrapper,model.wrapper,el('p','hint','The routine classifies unread messages and prepares reply drafts. Review and enable it in the Work Inbox.'),
      actions(button('Back',show),button('Create routine',async()=>{await request('outlook.triageRoutine',{projectId:record.projectId,providerId:provider.input.value,model:model.input.value.trim()});heading('Mail-triage routine created');pane.append(el('p','','Open the Work Inbox to preview and enable the routine.'),button('Done',show));},'button primary')));
  }
  await show();
}
