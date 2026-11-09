import assert from 'node:assert/strict';

export async function runOutlookSettingsSmoke({window,chat}){
  const result=await window.webContents.executeJavaScript(`(async()=>{
    const wait=async(check,label)=>{const end=Date.now()+8000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Outlook settings: '+label);};
    const button=text=>[...document.querySelectorAll('.settings-pane button')].find(node=>node.textContent===text);
    const input=label=>[...document.querySelectorAll('.settings-pane label')].find(node=>node.querySelector('span').textContent===label).querySelector('input,select');
    const state=async()=>(await window.faber.request('outlook.state')).connections.find(row=>row.projectId===${JSON.stringify(chat.projectId)});
    document.querySelector('#modal').close();document.querySelector('#open-settings').click();
    document.querySelector('.nav-button[data-settings-category=outlook]').click();
    (await wait(()=>button('Connect a project'),'project connection')).click();
    input('Project').value=${JSON.stringify(chat.projectId)};input('Application (client) ID').value='00000000-0000-4000-8000-000000000001';
    input('Prepare reply drafts').checked=true;button('Save connection').click();
    await wait(()=>button('Sign in with Microsoft'),'sign-in control');const saved=await state();
    button('Edit access').click();const checks=['Read inbox','Prepare reply drafts','Send reviewed drafts','Read calendar','Create reviewed events and invitations'].map(label=>input(label).checked);
    button('Back').click();(await wait(()=>button('Remove connection'),'remove action')).click();await wait(async()=>!await state(),'connection removal');
    document.querySelector('#close-modal').click();return {linked:saved.connected,drafts:saved.caps.drafts,checks};
  })()`);
  assert.deepEqual(result,{linked:false,drafts:true,checks:[true,true,false,true,false]});
  return {configured:true,scopesRestored:true,signInControl:true,removed:true};
}
