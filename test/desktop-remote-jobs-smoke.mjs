import assert from 'node:assert/strict';

export async function verifyRemoteJobInbox({window,runtime,project,until,checks}){
  const paused=(await runtime.request('routines.state')).paused;
  await runtime.request('routines.pause',{paused:true});
  try{
    const routine=await runtime.request('routines.save',{projectId:project.id,name:'Remote inbox check',providerId:'local-ollama',model:'fixture',instructions:'Check a disposable project.',inputs:'',outputs:'A report',completion:'Report ready.',tools:['files_list'],paths:['.'],grants:[]});
    const job=await runtime.request('routines.run',{id:routine.id,preview:true});
    const js=code=>window.webContents.executeJavaScript(code,true);
    const ready='document.querySelector("#remote-work-inbox")';
    await until(()=>js(`!${ready}.hidden&&!${ready}.disabled`),'host advertises work inbox');
    await js(`${ready}.click()`);
    const btn=text=>`[...document.querySelectorAll('.remote-inbox[open] button')].find(el=>el.textContent.includes(${JSON.stringify(text)}))`;
    await until(()=>js(`!!${btn(routine.definition.name)}`),'paired job list');
    await js(`${btn(routine.definition.name)}.click()`);
    await until(()=>js(`!!${btn('Stop job')}`),'paired job detail');
    await js(`${btn('Stop job')}.click()`);
    await until(async()=>(await runtime.request('routines.state')).jobs.find(row=>row.id===job.id)?.status==='canceled','remote stop applied once');
    await until(()=>js(`document.querySelector('.remote-inbox').textContent.includes('canceled')`),'updated remote receipt');
    await js(`${btn('Close')}.click()`);
    assert.equal(await js(`!!document.querySelector('.remote-inbox[open]')`),false);
    checks.push('paired Work Inbox lists, reads and stops a queued disposable job over its encrypted relay');
  }finally{if(!paused)await runtime.request('routines.pause',{paused:false});}
}
