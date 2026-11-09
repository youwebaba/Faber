import path from 'node:path';
import {openStore} from '../core/store.mjs';
import {validate} from '../core/registry.mjs';

const settingsSchema={type:'object',properties:{enabled:{type:'boolean'},startAtLogin:{type:'boolean'}},required:['enabled','startAtLogin'],additionalProperties:false};
export const workerMethods=['worker.state','worker.configure','worker.closeWindow','worker.pause','worker.quit'];
export async function createBackgroundWorker({dataDir,sourceDir,profileId='default',app,isAttached,closeWindow,pause,quit,emit=()=>{},allowLoginMutation=true}){
  const store=await openStore(path.join(dataDir,'background-worker'),{enabled:false,startAtLogin:false});validate(store.state,settingsSchema);
  const settings=store.state;
  const snapshot=()=>({...settings,pid:process.pid,attached:isAttached(),owner:true,signInRequiresInteractiveUser:true});
  return {
    get enabled(){return settings.enabled;},
    get hiddenStart(){return process.argv.includes('--background-worker')&&settings.enabled;},
    async request(method,args={}){
      if(!workerMethods.includes(method))throw new Error('Unknown worker action');
      if(method==='worker.configure'){
        validate(args,settingsSchema);if(args.startAtLogin&&!args.enabled)throw new Error('Enable background work before starting at sign-in');
        if(args.startAtLogin!==settings.startAtLogin){
          if(!allowLoginMutation)throw new Error('Sign-in registration is disabled in isolated smoke profiles');
          const startupArgs=['--background-worker','--worker-profile',profileId];
          app.setLoginItemSettings({openAtLogin:args.startAtLogin,path:process.execPath,args:app.isPackaged?startupArgs:[sourceDir,...startupArgs]});
        }
        Object.assign(settings,args);await store.save(settings);emit({type:'worker',state:snapshot()});return snapshot();
      }
      validate(args,{type:'object',properties:{},additionalProperties:false});
      if(method==='worker.state')return snapshot();
      if(method==='worker.closeWindow'){await closeWindow();return {closed:true,continuing:settings.enabled};}
      if(method==='worker.pause'){await pause();return {paused:true};}
      if(method==='worker.quit'){setImmediate(quit);return {quitting:true};}
    },
    close:()=>store.flush(),
  };
}
