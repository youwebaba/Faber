import {fileURLToPath} from 'node:url';
import {runProcess} from '../tools/process.mjs';
const script=fileURLToPath(new URL('./native.ps1',import.meta.url));
export async function nativeAction(action,args={},signal){
  if(process.platform!=='win32')throw new Error('Native desktop tools require Windows');
  const payload=Buffer.from(JSON.stringify({action,args})).toString('base64');
  const result=await runProcess('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Payload',payload],{signal,timeout:30000,maxOutput:32*1024*1024});
  if(result.code!==0)throw new Error(result.stderr.trim()||`Desktop helper exited ${result.code}`);
  return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
}
export function nativeTools(){
  const string={type:'string'},handle={type:'string',pattern:'^[0-9]+$'};
  const definitions=[
    ['windows','List visible Windows applications and handles.',{},[]],
    ['screenshot','Capture the virtual desktop. May contain private visible information.',{},[]],
    ['focus','Focus a window by its listed handle.',{handle},['handle']],
    ['click','Click absolute virtual-desktop pixel coordinates; optionally focus a window first.',{x:{type:'integer'},y:{type:'integer'},button:{type:'string',enum:['left','right']},handle},['x','y']],
    ['type','Type literal text into a specified window.',{handle,text:{type:'string',maxLength:10000}},['handle','text']],
    ['key','Send one keyboard chord to a specified window: ^s (Ctrl+S), +{TAB} (Shift+Tab), %{F4} (Alt+F4), {ENTER}, arrow keys, or F1-F24.',{handle,keys:{type:'string',maxLength:200}},['handle','keys']],
    ['launch','Launch an application or associated local document by path.',{path:string},['path']]
  ];
  return definitions.map(([action,description,properties,required])=>({name:`desktop_${action}`,description,permission:'computer',parameters:{type:'object',additionalProperties:false,properties,required},execute:(args,ctx)=>ctx.host.desktop(action,args,ctx.signal)}));
}
