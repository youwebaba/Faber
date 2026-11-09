import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

export async function runMcpSettingsSmoke({window,chat}) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('./mcp-fixture.mjs',import.meta.url)),'--http'],{
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['ignore','pipe','ignore']
  });
  const exit=once(child,'exit'),lines=createInterface({input:child.stdout});
  try {
    const [line]=await once(lines,'line',{signal:AbortSignal.timeout(10000)}),port=Number(line);
    assert.ok(Number.isInteger(port)&&port>0&&port<=65535);
    return await window.webContents.executeJavaScript(`(async()=>{
      const marker='Renderer MCP fixture';
      const wait=async(check,label)=>{const end=Date.now()+10000;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('MCP settings: '+label);};
      const findButton=(label,root=document.querySelector('.settings-pane'))=>[...(root?.querySelectorAll('button')||[])].find(button=>button.textContent===label);
      const field=(label,value)=>{const row=[...document.querySelectorAll('.settings-pane label')].find(el=>el.querySelector('span')?.textContent===label),input=row.querySelector('input,select');input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));};
      const record=async()=>(await window.faber.request('mcp.list',{})).connections.find(row=>row.name===marker);
      document.querySelector('#modal').close();document.querySelector('#open-settings').click();
      document.querySelector('.nav-button[data-settings-category=mcp]').click();
      (await wait(()=>findButton('Add server'),'category')).click();
      field('Name',marker);field('Project',${JSON.stringify(chat.projectId)});field('Server URL','http://127.0.0.1:${port}');field('Credential','fake-local-mcp-key');
      findButton('Save server').click();(await wait(()=>findButton('Connect'),'saved form')).click();
      const echo=()=>[...document.querySelectorAll('.settings-pane details')].find(el=>el.querySelector('summary').textContent.startsWith('echo'));
      (await wait(echo,'discovered tools')).open=true;
      const mode=echo().querySelector('select');mode.value='read';mode.dispatchEvent(new Event('change'));
      findButton('Allow in this project',echo()).click();
      await wait(async()=>(await record())?.grants.some(g=>g.name==='echo'&&g.effect==='read'),'scoped read grant');
      (await wait(()=>findButton('Revoke tool',echo()),'revoke button')).click();
      await wait(async()=>(await record())?.grants.length===0,'revoked');
      (await wait(()=>findButton('Disable'),'disable')).click();
      await wait(async()=>(await record())?.state==='disabled','disabled');
      (await wait(()=>findButton('Remove connection'),'remove')).click();
      await wait(async()=>!await record(),'removed');
      document.querySelector('#close-modal').click();
      return {saved:true,discovered:true,projectGrant:true,revoked:true,removed:true};
    })()`);
  } finally {lines.close();child.kill();await exit;}
}
