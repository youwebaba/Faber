export function createRoutineControls({request,subscribe,getState,getProject,selectChat,modal,closeModal,el,button,field,selectField,checkedRow,actions,notify}){
  let state={routines:[],jobs:[],tools:[],paused:false},worker,view='',selectedJob,body,jobList;
  const rows=new Map();
  const title='Routines & background work';
  const run=async(method,args)=>{const result=await request(method,args);await load();return result;};
  async function load(){[state,worker]=await Promise.all([request('routines.state'),request('worker.state')]);return state;}
  const status=job=>job.status.replaceAll('_',' ');
  function updateJobs(){
    if(!jobList?.isConnected)return;
    for(const job of [...state.jobs].reverse()){
      let row=rows.get(job.id);
      if(!row){
        const node=el('section','modal-section'),name=el('strong'),phase=el('p','hint'),details=button('Inspect job',()=>showJob(job.id));details.dataset.routineJob=job.id;
        const stop=button('Stop',async()=>{await run('routines.stop',{jobId:job.id});updateJobs();});stop.dataset.stopJob=job.id;
        node.append(name,phase,actions(details,stop));row={node,name,phase,stop};rows.set(job.id,row);jobList.append(node);
      }
      row.name.textContent=`${job.preview?'Preview':'Run'} · ${job.definition.name} · revision ${job.revision}`;
      row.phase.textContent=`${status(job)} · attempt ${job.attempts}${job.reason?' · '+job.reason:''}`;
      row.stop.hidden=!['queued','running','waiting_approval','waiting_interaction'].includes(job.status);
    }
    for(const [id,row] of rows)if(!state.jobs.some(job=>job.id===id)){row.node.remove();rows.delete(id);}
  }
  async function show(){await load();view='list';body=modal(title);rows.clear();
    const background=el('section','modal-section');background.append(el('h3','','Background work'));
    const enabled=checkedRow('Keep working after closing the window',worker.enabled,'The signed-in background worker retains chats, jobs and approvals. Reopen from the tray or launch Faber again.');enabled.input.id='worker-enabled';
    const login=checkedRow('Start this profile at Windows sign-in',worker.startAtLogin,'Starts the opted-in profile in your signed-in Windows session.');login.input.id='worker-login';
    const sync=()=>{login.input.disabled=!enabled.input.checked;if(!enabled.input.checked)login.input.checked=false;};enabled.input.addEventListener('change',sync);sync();
    const save=button('Save background settings',async()=>{worker=await request('worker.configure',{enabled:enabled.input.checked,startAtLogin:login.input.checked});enabled.input.defaultChecked=enabled.input.checked;login.input.defaultChecked=login.input.checked;notify('Background settings saved.');});save.id='worker-save';
    const pause=button(state.paused?'Resume routine queue':'Pause work',async()=>{if(state.paused)await run('routines.pause',{paused:false});else await run('worker.pause',{});pause.textContent=state.paused?'Resume routine queue':'Pause work';updateJobs();});pause.id='worker-pause';
    background.append(enabled.wrapper,login.wrapper,save,actions(button('Close window',async()=>{closeModal();await request('worker.closeWindow');}),pause,button('Quit Faber',()=>request('worker.quit'))));body.append(background);
    const routines=el('section','modal-section');routines.append(el('h3','','Manual routines'),el('p','hint','Review the project, connection, inputs, approved tools and paths, expected outputs and completion criteria. Preview proposes writes; save and enable authorizes future manual runs.'),button('Create routine',()=>edit()));
    for(const routine of state.routines){
      const row=el('section','modal-section');row.dataset.routineId=routine.id;row.append(el('strong','',routine.definition.name),el('p','hint',`Revision ${routine.revision} · ${routine.enabled?'enabled':'disabled'}${routine.revokedAt?' · authorization revoked':''}`));
      const execute=button('Run manually',()=>runForm(routine.id,false));execute.disabled=!routine.enabled;execute.dataset.runRoutine=routine.id;
      row.append(actions(button('Review / edit',()=>edit(routine)),button('Preview',()=>runForm(routine.id,true)),execute,button(routine.enabled?'Disable':'Enable',async()=>{await run('routines.enable',{id:routine.id,enabled:!routine.enabled});await show();}),button('Revoke permissions',async()=>{await run('routines.revoke',{id:routine.id});await show();})));routines.append(row);
    }
    body.append(routines,el('h3','','Durable jobs'));jobList=el('div');jobList.id='routine-jobs';body.append(jobList);updateJobs();
  }
  async function edit(routine){
    await load();view='edit';body=modal(routine?'Review routine':'Create routine');jobList=null;
    const current=getState(),definition=routine?.definition||{},projectId=definition.projectId||getProject()?.id||current.projects.find(project=>!project.archived)?.id;
    const name=field('Routine name',definition.name||''),project=selectField('Project',current.projects.filter(project=>!project.archived).map(project=>({value:project.id,label:project.name})),projectId),provider=selectField('Connection',current.providers.map(provider=>({value:provider.id,label:provider.name})),definition.providerId||current.providers[0]?.id),model=field('Model',definition.model||current.providers.find(item=>item.id===provider.input.value)?.model||'');
    provider.input.addEventListener('change',()=>{model.input.value=current.providers.find(item=>item.id===provider.input.value)?.model||'';});
    const instructions=field('What should this routine do?',definition.instructions||'','textarea'),inputs=field('Inputs to inspect',definition.inputs||'','textarea'),outputs=field('Expected outputs',definition.outputs||'','textarea'),completion=field('How to know it is complete',definition.completion||'','textarea'),paths=field('Approved project-relative paths, one per line',(definition.paths||['.']).join('\n'),'textarea','A dot approves the whole selected project. Other projects and profile storage remain unavailable.');
    for(const [key,control] of Object.entries({name,project,provider,model,instructions,inputs,outputs,completion,paths})){control.input.id=`routine-${key}`;body.append(control.wrapper);}
    body.append(el('p','hint','The saved connection is used without an automatic provider fallback. API connections retain their normal billing.'));
    const tools=el('details','modal-section');tools.append(el('summary','','Approved tools'));
    const selected=definition.tools||['files_list','files_read','files_write'];
    const choices=state.tools.map(tool=>{const choice=checkedRow(tool.name,selected.includes(tool.name),`${tool.permission} · ${tool.description}`);choice.input.dataset.routineTool=tool.name;tools.append(choice.wrapper);return {name:tool.name,...choice};});body.append(tools);
    const grant=checkedRow('Allow file writes inside approved paths without asking',definition.grants?.includes('files')||false,'Desktop, shell, network and upgrade actions still require operation approval. Executable tools retain their normal Windows authority.');grant.input.id='routine-grant-files';body.append(grant.wrapper);
    const save=button('Save revision',async()=>{
      const value={...(routine?{id:routine.id}:{}),name:name.input.value,projectId:project.input.value,providerId:provider.input.value,model:model.input.value,instructions:instructions.input.value,inputs:inputs.input.value,outputs:outputs.input.value,completion:completion.input.value,paths:paths.input.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean),tools:choices.filter(choice=>choice.input.checked).map(choice=>choice.name),grants:grant.input.checked?['files']:[]};
      const saved=await run('routines.save',value);notify(`Saved revision ${saved.revision}. Preview and enable it from Routines.`);await show();
    },'button primary');save.id='routine-save';body.append(actions(save,button('Back',show)));
  }
  async function runForm(id,preview){
    const routine=state.routines.find(value=>value.id===id);view='run';body=modal(`${preview?'Preview':'Run'} ${routine.definition.name}`);jobList=null;
    body.append(el('p','hint',`Revision ${routine.revision} · ${routine.definition.inputs||'No additional input specification'}`));
    const inputs=field('Input snapshot for this job','','textarea','This snapshot stays with the job even after the routine is edited.');inputs.input.id='routine-run-inputs';body.append(inputs.wrapper);
    const start=button(preview?'Start preview':'Queue manual run',async()=>{const job=await run('routines.run',{id,inputs:inputs.input.value,preview});await showJob(job.id);},'button primary');start.id='routine-run-submit';body.append(actions(start,button('Back',show)));
  }
  async function showJob(id){
    await load();selectedJob=id;view='job';const job=state.jobs.find(value=>value.id===id);if(!job)return show();body=modal(`Job · ${job.definition.name}`);jobList=null;
    const phase=el('p','hint',`${status(job)} · revision ${job.revision} · attempt ${job.attempts}`);phase.id='routine-job-status';body.append(phase,el('p','hint',`Job ${job.id}`),el('p','',job.reason||''));
    for(const [label,value] of [['Input snapshot',job.inputs],['Observed input revisions',job.inputReceipts||[]],['Proposed actions',job.proposals],['Output receipts',job.outputs],['Routine definition',job.definition]]){const section=el('details','modal-section');section.append(el('summary','',label),el('pre','',typeof value==='string'?value:JSON.stringify(value,null,2)));body.append(section);}
    const controls=actions(button('Refresh',()=>showJob(id)),button('Back to routines',show));
    if(job.chatId&&getState().chats.some(chat=>chat.id===job.chatId))controls.append(button('Open activity chat',()=>{closeModal();selectChat(job.chatId,job.definition.projectId);}));
    if(['queued','running','waiting_approval','waiting_interaction'].includes(job.status))controls.append(button('Stop job',async()=>{await run('routines.stop',{jobId:id});await showJob(id);}));
    if(['paused','canceled'].includes(job.status)&&job.attempts<3)controls.append(button('Resume verified work',async()=>{await run('routines.resume',{jobId:id});await showJob(id);}));
    const approvals=getState().approvals.filter(approval=>approval.routineJobId===id);
    for(const approval of approvals){body.append(el('p','hint',approval.summary));controls.append(button('Allow once',async()=>{await request('approval.resolve',{id:approval.id,allow:true});await showJob(id);}),button('Deny',async()=>{await request('approval.resolve',{id:approval.id,allow:false});await showJob(id);}));}
    if(job.status==='needs_attention'){
      const note=field('Review destination evidence and record your decision','','textarea','Do not mark an uncertain send, append or external action as verified without checking its destination. Verified records an operator decision; it does not fabricate an external receipt.');note.input.id='routine-review-note';body.append(note.wrapper);
      controls.append(button('Verified at destination',async()=>{await run('routines.review',{jobId:id,outcome:'verified',note:note.input.value});await showJob(id);}),button('Abandon job',async()=>{await run('routines.review',{jobId:id,outcome:'abandoned',note:note.input.value});await showJob(id);}));
    }
    body.append(controls);
  }
  subscribe?.(event=>{
    if(event.type==='worker')worker=event.state;
    if(event.type==='state'&&event.state.jobs){state={...state,routines:event.state.routines,jobs:event.state.jobs,paused:event.state.workerQueue.paused};if(view==='list')updateJobs();}
    if(event.type==='routines'){state=event.state;if(view==='list')updateJobs();else if(view==='job'&&body?.isConnected&&document.querySelector('#routine-job-status')){const job=state.jobs.find(value=>value.id===selectedJob);if(job)document.querySelector('#routine-job-status').textContent=`${status(job)} · revision ${job.revision} · attempt ${job.attempts} · Refresh to inspect current receipts and approvals`;}}
  });
  return {show};
}
