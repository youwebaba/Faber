export async function mountMcp(pane,{request,getState,el,button,field,selectField,actions}) {
  const projects=getState().projects.filter(project=>!project.archived);
  async function refresh(){
    const state=await request('mcp.list');if(!pane.isConnected)return;
    pane.replaceChildren(el('h3','','MCP connections'));
    pane.append(button('Add server',()=>edit()));
    for(const record of state.connections){
      const section=el('section','modal-section'),project=projects.find(item=>item.id===record.projectId);
      section.append(el('h4','',record.name),el('p','hint',`${record.state} · ${project?.name||'Project unavailable'} · ${record.transport==='http'?'Streamable HTTP':'Local stdio'}`));
      if(record.error)section.append(el('p','error-text',record.error));
      const run=(method,params={})=>async()=>{await request(method,{id:record.id,...params});await refresh();};
      section.append(actions(button('Edit',()=>edit(record)),button(record.state==='connected'?'Refresh tools':'Connect',run(record.state==='connected'?'mcp.refresh':'mcp.connect')),button('Disable',run('mcp.disable')),button('Remove connection',run('mcp.remove'),'button danger')));
      for(const tool of record.tools){
        const row=el('details','tool-message');
        row.append(el('summary','',tool.name+(tool.allowed?' · enabled':'')),el('p','hint',tool.description));
        if(tool.reason)row.append(el('p','hint',`Unavailable: ${tool.reason}`));
        else {
          const grant=record.grants.find(item=>item.name===tool.name),mode=selectField('Action type',[{value:'write',label:'Changes data · ask every time'},{value:'read',label:'Read only'}],grant?.effect||'write');
          row.append(mode.wrapper,button(tool.allowed?'Revoke tool':'Allow in this project',async()=>{await request('mcp.grant',{id:record.id,name:tool.name,fingerprint:tool.fingerprint,effect:mode.input.value,enabled:!tool.allowed});await refresh();}));
        }
        section.append(row);
      }
      pane.append(section);
    }
  }
  function edit(record={}){
    pane.replaceChildren(el('h3','',record.id?'Edit MCP server':'Add MCP server'));
    if(!projects.length){pane.append(el('p','hint','Create a project before connecting an MCP server.'),button('Back',refresh));return;}
    const name=field('Name',record.name),project=selectField('Project',projects.map(p=>({value:p.id,label:p.name})),record.projectId||projects[0].id);
    const type=selectField('Transport',[{value:'http',label:'Streamable HTTP'},{value:'stdio',label:'Local stdio'}],record.transport||'http');
    const url=field('Server URL',record.url,'url'),command=field('Executable',record.command,'text','Full path to the trusted server program. It runs under your Windows account.');
    const args=field('Arguments',record.args?.join('\n'),'textarea','One argument per line.'),env=field('Credential variable',record.credentialEnv,'text','Optional environment variable for the local server.');
    const secret=field('Credential','','password','Stored in the profile credential vault. Leave blank to keep the credential for this endpoint.');secret.input.autocomplete='new-password';
    const update=()=>{const http=type.input.value==='http';url.wrapper.hidden=!http;for(const control of [command,args,env])control.wrapper.hidden=http;};type.input.addEventListener('change',update);update();
    pane.append(name.wrapper,project.wrapper,type.wrapper,url.wrapper,command.wrapper,args.wrapper,env.wrapper,secret.wrapper,actions(button('Cancel',refresh),button('Save server',async()=>{
      const cfg={...(record.id?{id:record.id}:{}),name:name.input.value.trim(),projectId:project.input.value,transport:type.input.value};
      if(cfg.transport==='http')cfg.url=url.input.value.trim();
      else{cfg.command=command.input.value.trim();cfg.args=args.input.value.split(/\r?\n/).filter(Boolean);if(env.input.value.trim())cfg.credentialEnv=env.input.value.trim();}
      if(secret.input.value)cfg.credential=secret.input.value;
      await request('mcp.save',cfg);secret.input.value='';await refresh();
    },'button primary')));
  }
  await refresh();
}
