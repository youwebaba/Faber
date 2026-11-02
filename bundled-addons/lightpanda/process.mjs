import {spawn} from 'node:child_process';
export function run(command,args,{signal,timeout=30000,maxOutput=1024*1024}={}) {
  signal?.throwIfAborted();return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const kill=()=>{if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>{});}else child.kill('SIGKILL');};
    const abort=()=>{kill();finish(signal.reason||new Error('Canceled'));};const timer=setTimeout(()=>{kill();finish(new Error('Lightpanda helper timed out'));},timeout);
    signal?.addEventListener('abort',abort,{once:true});
    for(const [stream,key]of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',chunk=>{if(key==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();if(stdout.length+stderr.length>maxOutput){kill();finish(new Error('Lightpanda helper output exceeded limit'));}});
    child.on('error',error=>finish(error));child.on('close',code=>finish(null,{code,stdout:stdout.replaceAll('\0',''),stderr:stderr.replaceAll('\0','')}));
  });
}
export async function checked(command,args,options){const result=await run(command,args,options);if(result.code!==0)throw new Error(result.stderr.trim()||result.stdout.trim()||`Helper exited ${result.code}`);return result.stdout.trim();}
