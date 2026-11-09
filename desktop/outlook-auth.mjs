const login='https://login.microsoftonline.com';
const graph='https://graph.microsoft.com/v1.0';
const deadline=signal=>signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000);
async function json(response){
  let raw='',bytes=0;
  for await(const chunk of response.body||[]){bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('Microsoft response exceeds the size limit.');raw+=Buffer.from(chunk).toString('binary');}
  return raw?JSON.parse(Buffer.from(raw,'binary').toString('utf8')):{};
}
export function outlookScopes(caps){
  return ['openid','offline_access','User.Read',...(caps.inbox||caps.drafts||caps.send?[caps.drafts?'Mail.ReadWrite':'Mail.Read']:[]),...(caps.send?['Mail.Send']:[]),...(caps.calendar||caps.events?[caps.events?'Calendars.ReadWrite':'Calendars.Read']:[])];
}
export function outlookAuth({host,fetcher=fetch,now=Date.now}){
  const pending=new Map(),refreshes=new Map(),lifetimes=new Map(),vaultUpdates=new Map();
  const vault=id=>'outlook:'+id;
  function lifetime(id){if(!lifetimes.has(id))lifetimes.set(id,new AbortController());return lifetimes.get(id);}
  function save(id,value,signal) {
    const operation=(vaultUpdates.get(id)||Promise.resolve()).catch(()=>{}).then(()=>{signal?.throwIfAborted();return host.setSecret(vault(id),value);});
    vaultUpdates.set(id,operation);
    return operation.finally(()=>{if(vaultUpdates.get(id)===operation)vaultUpdates.delete(id);});
  }
  async function form(url,values,signal){
    const response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values),redirect:'error',signal:deadline(signal)});
    const body=await json(response);
    if(!response.ok){const error=new Error('Microsoft authorization failed.');error.code=body.error||'authorization_failed';throw error;}
    return body;
  }
  function token(data,old={}){
    if(typeof data.access_token!=='string'||!data.access_token||data.token_type?.toLowerCase()!=='bearer')throw new Error('Unexpected Microsoft authorization response.');
    return {access:data.access_token,refresh:data.refresh_token||old.refresh||null,scope:data.scope||old.scope||'',expires:now()+Math.min(Math.max(Number(data.expires_in)||0,0),86400)*1000};
  }
  async function graphCall(access,route,options={}){
    if(typeof route!=='string'||!/^\/me(?:[/?]|$)/.test(route)||/[\\\r\n]/.test(route)||new URL(graph+route).pathname!=='/v1.0'+route.split('?')[0])throw new Error('Invalid Microsoft Graph operation.');
    const response=await fetcher(graph+route,{method:options.method||'GET',headers:{Authorization:'Bearer '+access,Prefer:'IdType="ImmutableId", outlook.timezone="UTC", outlook.body-content-type="text"',...(options.body?{'Content-Type':'application/json'}:{})},body:options.body?JSON.stringify(options.body):undefined,redirect:'error',signal:deadline(options.signal)});
    const value=await json(response);
    if(!response.ok){const error=new Error('Microsoft Graph request failed ('+response.status+').');error.status=response.status;throw error;}
    return value;
  }
  async function read(record){
    const raw=await host.getSecret(vault(record.id));if(!raw)throw new Error('Connect the Outlook account in Settings.');return JSON.parse(raw);
  }
  async function refresh(record,old){
    if(refreshes.has(record.id))return refreshes.get(record.id);
    const signal=lifetime(record.id).signal;
    const promise=(async()=>{
      if(!old.refresh)throw new Error('Reconnect the Outlook account in Settings.');
      try{
        const body=await form(login+'/'+record.tenant+'/oauth2/v2.0/token',{client_id:record.clientId,grant_type:'refresh_token',refresh_token:old.refresh,scope:outlookScopes(record.caps).join(' ')},signal);
        const saved=token(body,old);
        if(await host.getSecret(vault(record.id))!==JSON.stringify(old))throw new Error('Outlook authorization changed during refresh.');
        await save(record.id,JSON.stringify(saved),signal);signal.throwIfAborted();return saved;
      }catch(error){if(['invalid_grant','interaction_required'].includes(error.code))throw new Error('Outlook authorization expired. Reconnect in Settings.');throw error;}
    })();refreshes.set(record.id,promise);try{return await promise;}finally{if(refreshes.get(record.id)===promise)refreshes.delete(record.id);}
  }
  async function api(record,route,options={}){
    const signal=lifetime(record.id).signal;
    let current=await read(record);signal.throwIfAborted();if(current.expires<=now()+30000)current=await refresh(record,current);
    options={...options,signal:options.signal?AbortSignal.any([options.signal,signal]):signal};
    try{return await graphCall(current.access,route,options);}
    catch(error){if(error.status===401)throw new Error('Outlook authorization expired. Reconnect in Settings before retrying.');throw error;}
  }
  async function begin(record){
    cancel(record.id);
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,lifetime(record.id).signal]);
    pending.set(record.id,{controller});
    try{
      const info=await form(login+'/'+record.tenant+'/oauth2/v2.0/devicecode',{client_id:record.clientId,scope:outlookScopes(record.caps).join(' ')},signal);
      signal.throwIfAborted();
      const verification=new URL(info.verification_uri);
      if(verification.protocol!=='https:'||!['microsoft.com','www.microsoft.com','login.microsoftonline.com','microsoftonline.com','login.microsoft.com'].includes(verification.hostname)||verification.port||verification.username||verification.password||typeof info.device_code!=='string'||typeof info.user_code!=='string')throw new Error('Invalid Microsoft sign-in response.');
      const interval=Math.max(5,Number(info.interval)||5)*1000;
      const expires=now()+Math.min(1800,Number(info.expires_in)||900)*1000;
      pending.set(record.id,{controller,deviceCode:info.device_code,interval,expires,next:now()+interval});
      return {userCode:info.user_code,verificationUrl:verification.href,expires};
    }catch(error){if(pending.get(record.id)?.controller===controller)pending.delete(record.id);throw error;}
  }
  async function poll(record){
    const a=pending.get(record.id);if(!a?.deviceCode)throw new Error('Start Outlook sign-in again.');if(now()>a.expires){cancel(record.id);throw new Error('The sign-in code expired. Start again.');}
    if(now()<a.next)return {pending:true,next:a.next};a.next=now()+a.interval;
    try{
      const body=await form(login+'/'+record.tenant+'/oauth2/v2.0/token',{client_id:record.clientId,grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:a.deviceCode},a.controller.signal);
      const saved=token(body),me=await graphCall(saved.access,'/me?$select=id,displayName',{signal:a.controller.signal});
      if(!me.id||record.accountId&&record.accountId!==me.id)throw new Error('This connection belongs to a different Outlook account. Create a separate connection.');
      a.controller.signal.throwIfAborted();if(pending.get(record.id)!==a)throw new Error('Sign-in was superseded.');
      await save(record.id,JSON.stringify(saved),a.controller.signal);a.controller.signal.throwIfAborted();pending.delete(record.id);
      return {pending:false,accountId:me.id,accountName:me.displayName||'Microsoft account'};
    }catch(error){
      if(['authorization_pending','slow_down'].includes(error.code)){if(error.code==='slow_down')a.interval+=5000;a.next=now()+a.interval;return {pending:true,next:a.next};}
      if(pending.get(record.id)===a)pending.delete(record.id);throw error;
    }
  }
  function cancel(id){pending.get(id)?.controller.abort();pending.delete(id);}
  function end(id){cancel(id);lifetimes.get(id)?.abort();lifetimes.delete(id);refreshes.delete(id);}
  return {begin,poll,cancel,api,connected:async id=>Boolean(await host.getSecret(vault(id))),async disconnect(id){end(id);await save(id,'');},close(){for(const id of new Set([...pending.keys(),...lifetimes.keys()]))end(id);}};
}
