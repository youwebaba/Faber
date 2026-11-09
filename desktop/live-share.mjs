import {randomUUID} from 'node:crypto';
import {liveFrameBytes,validateLiveFrame} from '../renderer/live-frame.mjs';
import {validate} from '../core/registry.mjs';

const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string',minLength:1,maxLength:256},token={type:'string',pattern:'^[a-f0-9-]{36}$'};
export const liveFrameInterval=200;
const local={
  'capture.sources':object({}),'capture.state':object({}),'capture.stop':object({}),
  'capture.prepare':object({kind:{enum:['camera','screen','window']},source:text,deviceId:text},['kind','source']),
  'capture.started':object({id:token}),'capture.frame':object({id:token,jpeg:{type:'string',maxLength:liveFrameBytes*4/3+32}}),
  'capture.heartbeat':object({id:token}),
};
const remote={
  'capture.status':object({}),'capture.join':object({id:token,view:token}),
  'capture.read':object({id:token,view:token,after:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}}),
  'capture.leave':object({id:token,view:token}),
};
export const captureMethods=Object.keys(local),remoteCaptureMethods=Object.keys(remote);

export function createLiveShare({sources,confirm,controllers,emit,now=Date.now}){
  let current,revision=0,closed=false;
  const state=()=>current?{id:current.id,phase:current.phase,kind:current.kind,label:current.label,viewer:current.viewerName||null}:{phase:'off'};
  function stop(reason='Stopped'){
    revision++;if(!current)return;
    current.frame=null;current=null;emit({type:'capture',state:{phase:'off',reason}});
  }
  function checkTime(){
    if(current&&(now()>current.expires||current.phase==='live'&&now()-(current.lastFrame||current.started)>5000))stop('Sharing timed out. Start a new share to reconnect.');
  }
  const timer=setInterval(checkTime,750);timer.unref?.();
  function owner(id){checkTime();if(!current||current.id!==id)throw Error('This live share has ended.');return current;}
  function reconcile(devices){if(current?.deviceId&&!devices?.some(d=>d.role==='controller'&&d.id===current.deviceId&&d.online))stop('The paired viewer disconnected.');}
  async function request(method,args={}){
    if(closed||!Object.hasOwn(local,method))throw Error('Live capture unavailable.');validate(args,local[method]);checkTime();
    if(method==='capture.state')return state();
    if(method==='capture.stop'){stop();return state();}
    if(method==='capture.sources')return {sources:(await sources()).map(({id,name})=>({id,name})),controllers:(await controllers()).filter(d=>d.role==='controller'&&d.online).map(({id,name})=>({id,name}))};
    if(method==='capture.prepare'){
      const reservation=++revision;
      const source=args.kind==='camera'?null:(await sources()).find(s=>s.id===args.source&&s.id.startsWith(args.kind+':'));
      if(args.kind!=='camera'&&!source)throw Error('Select a currently available screen or window.');
      const viewer=args.deviceId&&(await controllers()).find(d=>d.role==='controller'&&d.online&&d.id===args.deviceId);
      if(args.deviceId&&!viewer)throw Error('The selected paired viewer is unavailable.');
      const label=source?.name||'Camera';
      if(!await confirm(label,viewer?.name)||closed||reservation!==revision)throw Error('Live sharing was not authorized.');
      if(viewer&&!(await controllers()).some(d=>d.role==='controller'&&d.online&&d.id===viewer.id))throw Error('The paired viewer disconnected.');
      if(closed||reservation!==revision)throw Error('The capture selection changed.');
      stop('Replaced by a new share');
      current={id:randomUUID(),kind:args.kind,source:source?.id||args.source,label,deviceId:viewer?.id,viewerName:viewer?.name,phase:'prepared',expires:now()+45000,sequence:0,lastFrame:0,permissionUsed:false};
      emit({type:'capture',state:state()});return state();
    }
    const share=owner(args.id);
    if(method==='capture.started'){
      if(share.phase!=='prepared'||!share.permissionUsed)throw Error('Select and start the approved source first.');
      share.phase='live';share.started=now();share.expires=now()+45000;emit({type:'capture',state:state()});return state();
    }
    if(share.phase!=='live')throw Error('The live source has not started.');
    if(method==='capture.heartbeat'){
      if(share.deviceId)throw Error('The paired viewer requires real frames.');
      share.lastFrame=now();share.expires=now()+5000;return {accepted:true};
    }
    if(!share.deviceId)throw Error('This capture is local only.');
    if(now()-share.lastFrame<liveFrameInterval)return {accepted:false};
    share.frame=validateLiveFrame(args.jpeg);share.lastFrame=now();share.sequence++;
    return {accepted:true,sequence:share.sequence};
  }
  function capturePermission(kind,consume=false){
    checkTime();if(!current||current.kind!==kind||current.phase!=='prepared'||(consume&&current.permissionUsed))return null;
    if(consume)current.permissionUsed=true;
    return {id:current.id,source:current.source};
  }
  function remoteRequest(method,args,{device,signal}={}){
    if(closed||!Object.hasOwn(remote,method)||!device?.id)throw Error('Paired viewing unavailable.');validate(args,remote[method]);signal?.throwIfAborted();checkTime();
    const share=current?.deviceId===device.id&&current.phase==='live'?current:null;
    if(method==='capture.status')return share?{id:share.id,kind:share.kind,label:share.label}:{id:null};
    if(!share||share.id!==args.id)throw Error('This live share is unavailable.');
    if(method==='capture.join'){
      if(share.view&&share.view!==args.view){stop('The viewer session changed. Authorize a new live share.');throw Error('A fresh host share is required.');}
      share.view=args.view;share.expires=now()+3500;return {id:share.id};
    }
    if(!share.view||args.view!==share.view)throw Error('This viewing session has ended.');
    if(method==='capture.leave'){stop('The paired viewer stopped watching.');return {stopped:true};}
    share.expires=now()+3500;
    if(share.sequence<=args.after||!share.frame)return {sequence:share.sequence};
    return {sequence:share.sequence,jpeg:share.frame};
  }
  return {request,remoteRequest,capturePermission,reconcile,stop,close(){closed=true;clearInterval(timer);stop('Faber closed.');}};
}
