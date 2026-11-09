import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
const script=fileURLToPath(new URL('./voice.ps1',import.meta.url));

export function activationTarget(chats,text,selectedId){
  const eligible=chats.filter(c=>!c.archived&&c.voice?.enabled&&c.voice.phrase?.trim()).map(c=>({chat:c,phrase:c.voice.phrase.trim()})).sort((a,b)=>b.phrase.length-a.phrase.length);
  const matches=eligible.filter(({phrase})=>text.toLocaleLowerCase().startsWith(phrase.toLocaleLowerCase())&&(!text[phrase.length]||/[\s,.!?:;]/.test(text[phrase.length])));
  if(!matches.length)return null;
  const longest=matches.filter(m=>m.phrase.length===matches[0].phrase.length);
  const match=longest.find(m=>m.chat.id===selectedId)??(longest.length===1?longest[0]:null);
  if(!match)throw new Error('Several chats use this activation phrase. Select the intended chat or give each a distinct phrase.');
  return {chatId:match.chat.id,text:text.slice(match.phrase.length).replace(/^[\s,.!?:;]+/,'')};
}
export function createVoice({runtime,emit}){
  let child,session=null,armed=null,sequence=0,speaking=false,stderr='',generation=0,speechQueue=Promise.resolve();
  const pending=new Map(),spoken=new Set();
  const publish=(status,extra={})=>emit({type:'voice',status,chatId:session?.chatId,mode:session?.mode,...extra});
  function close(){
    generation++;
    session=null;armed=null;speaking=false;
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Speech helper stopped'));}pending.clear();
    if(child){const old=child;child=null;old.stdin.end();if(process.platform==='win32'){const killer=spawn('taskkill.exe',['/PID',String(old.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>old.kill());}else old.kill();}
    publish('off');
  }
  async function transcript(text){
    if(!session||speaking)return;
    const token=generation;
    if(session.mode==='dictation'){publish('transcript',{text,final:true});return;}
    try{
      const state=await runtime.request('state.get');
      if(token!==generation||!session)return;
      let target=activationTarget(state.chats,text,session.chatId);
      if(!target&&armed&&armed.until>Date.now())target={chatId:armed.chatId,text};
      if(!target)return;
      if(!target.text){armed={chatId:target.chatId,until:Date.now()+10000};publish('listening',{chatId:target.chatId,text:'Activation heard. Listening for your request.'});return;}
      armed=null;
      publish('transcript',{chatId:target.chatId,text:target.text,final:true});
      await runtime.request('chat.send',target);
    }catch(error){publish('error',{error:error.message});}
  }
  function ensure(){
    if(process.platform!=='win32')throw new Error('Offline speech requires Windows System.Speech');
    if(child)return;
    child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const current=child;stderr='';
    current.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
    createInterface({input:current.stdout}).on('line',line=>{
      let event;try{event=JSON.parse(line.replace(/^\uFEFF/,''));}catch{return;}
      if(event.kind==='response'){
        const request=pending.get(event.id);if(!request)return;pending.delete(event.id);clearTimeout(request.timer);
        event.ok?request.resolve(event):request.reject(new Error(event.error));
      }else if(event.kind==='transcript')void transcript(event.text);
      else if(event.kind==='error')publish('error',{error:event.error});
    });
    current.on('error',error=>{publish('error',{error:error.message});close();});
    current.on('exit',code=>{if(child!==current)return;child=null;for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error(stderr||`Speech helper exited ${code}`));}pending.clear();session=null;publish('error',{error:stderr||`Speech helper exited ${code}`});});
  }
  function command(action,args={}){
    ensure();const id=`${++sequence}-${crypto.randomUUID()}`;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Speech helper timed out'));close();},action==='speak'?180000:15000);
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,action,...args})+'\n',error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});
    });
  }
  const api={
    async action(action,args={},signal){
      signal?.throwIfAborted();
      if(action==='stop'){close();return {listening:false};}
      if(action==='status')return command('status');
      if(action==='start'){
        if(!['dictation','assistant'].includes(args.mode))throw new Error('Invalid voice mode');
        close();const token=generation;
        const state=await runtime.request('state.get');if(token!==generation)throw new Error('Speech start cancelled');signal?.throwIfAborted();if(!state.chats.some(c=>c.id===args.chatId&&!c.archived))throw new Error('Unknown voice chat');
        for(const run of state.runs??[])if(run.status==='completed')spoken.add(run.id);
        session={chatId:args.chatId,mode:args.mode};publish('starting');
        const abort=()=>close();signal?.addEventListener('abort',abort,{once:true});
        try{const result=await command('start');if(token!==generation)throw new Error('Speech start cancelled');signal?.throwIfAborted();publish('listening');return result;}catch(error){if(token===generation){close();publish('error',{error:error.message});}throw error;}finally{signal?.removeEventListener('abort',abort);}
      }
      if(action==='speak'){
        if(typeof args.text!=='string'||!args.text.trim()||args.text.length>20000)throw new Error('Speech text must contain 1–20000 characters');
        const token=generation;
        const operation=speechQueue.catch(()=>{}).then(async()=>{
          if(token!==generation)throw new Error('Speech cancelled');signal?.throwIfAborted();
          speaking=true;publish('speaking');const abort=()=>close();signal?.addEventListener('abort',abort,{once:true});
          try{return await command('speak',{text:args.text});}finally{signal?.removeEventListener('abort',abort);if(token===generation){speaking=false;publish(session?'listening':'off');}}
        });speechQueue=operation;return operation;
      }
      throw new Error('Unknown voice action');
    },close
  };
  const unsubscribe=runtime.subscribe(event=>{
    if(event.type!=='state'||!session||session.mode!=='assistant')return;
    for(const run of event.state.runs??[]){
      if(run.status!=='completed'||spoken.has(run.id))continue;
      spoken.add(run.id);
      const chat=event.state.chats.find(c=>c.id===run.chatId);
      if(!chat?.voice?.enabled||!chat.voice.speakReplies)continue;
      const message=chat.messages.findLast(m=>m.role==='assistant'&&m.runId===run.id&&m.content);
      const token=generation;
      if(message)void api.action('speak',{text:message.content.slice(0,20000)}).catch(error=>{if(session&&token===generation)publish('error',{error:error.message});});
    }
  },{accept:type=>type==='state'&&session?.mode==='assistant'});
  return {...api,close(){unsubscribe();close();}};
}
