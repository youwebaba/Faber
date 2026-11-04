import {spawn} from 'node:child_process';

export function runProcess(command,args=[],{cwd,signal,timeout=30000,maxOutput=1024*1024,env}={}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',bytes=0,reason,finished=false;
    const kill=()=>{
      if(!child.pid)return;
      if(process.platform==='win32') { const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); killer.on('error',()=>child.kill()); }
      else {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    };
    const stop=message=>{if(!reason)reason=message;kill();};
    const abort=()=>stop('Process cancelled');
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    const timer=setTimeout(()=>stop(`Process timed out after ${timeout} ms`),timeout);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.setEncoding('utf8').on('data',chunk=>{
      bytes+=Buffer.byteLength(chunk);if(bytes>maxOutput){stop('Process output limit exceeded');return;}
      if(key==='stdout')stdout+=chunk;else stderr+=chunk;
    });
    child.on('error',error=>{if(finished)return;finished=true;cleanup();reject(error);});
    child.on('close',code=>{if(finished)return;finished=true;cleanup();if(reason)reject(new Error(reason));else resolve({code,stdout,stderr});});
  });
}

export function shellTool(){return {name:'shell_run',description:'Run a bounded shell command in the project. Faber saves a core-source snapshot before commands; use staged upgrades for harness edits. This grants full user-account access, not a filesystem sandbox.',permission:'shell',parameters:{type:'object',additionalProperties:false,properties:{command:{type:'string',minLength:1,maxLength:20000},timeoutMs:{type:'integer',minimum:100,maximum:120000}},required:['command']},execute:async(args,ctx)=>{ctx.signal?.throwIfAborted();const coreBackup=await ctx.host?.backupCore?.(ctx.signal);ctx.signal?.throwIfAborted();return {...await runProcess(process.platform==='win32'?'powershell.exe':'/bin/sh',process.platform==='win32'?['-NoLogo','-NoProfile','-NonInteractive','-Command',args.command]:['-c',args.command],{cwd:ctx.project.path,signal:ctx.signal,timeout:args.timeoutMs??30000}),...(coreBackup?{coreBackup}:{})};}};}
