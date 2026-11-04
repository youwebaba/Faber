const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
// Preserve an existing profile in place; never move a folder used by a running release.
function getProfileDirectory(localAppData,{exists=filename=>{try{return fs.statSync(filename).isDirectory();}catch(error){if(error.code==='ENOENT')return false;throw error;}}}={}){
  const previous=path.join(localAppData,'SophiaHarness');
  return exists(previous)?previous:path.join(localAppData,'Faber');
}
function createProfiles(localAppData,{defaultDirectory=getProfileDirectory(localAppData)}={}){
  const root=path.join(path.resolve(localAppData),'FaberProfiles'),file=path.join(root,'profiles.json');
  const validId=id=>id==='default'||typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
  const name=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw new Error('Profile name must contain 1–80 characters');return value.trim();};
  let saved;
  try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Profile registry could not be read; existing profiles were preserved');}
  saved??={schemaVersion:1,currentId:'default',defaultDirectory,profiles:[{id:'default',name:'Default'}]};
  if(saved.schemaVersion!==1||!path.isAbsolute(saved.defaultDirectory||'')||![defaultDirectory,...['SophiaHarness','Faber'].map(folder=>path.join(path.resolve(localAppData),folder))].includes(saved.defaultDirectory)||!Array.isArray(saved.profiles)||!saved.profiles.length||saved.profiles.length>100||saved.profiles.some(row=>!row||Object.keys(row).some(key=>!['id','name'].includes(key))||!validId(row.id)||typeof row.name!=='string'||name(row.name)!==row.name)||new Set(saved.profiles.map(row=>row.id)).size!==saved.profiles.length||!saved.profiles.some(row=>row.id==='default')||!saved.profiles.some(row=>row.id===saved.currentId))throw new Error('Invalid profile registry; existing profiles were preserved');
  const directory=id=>{if(!saved.profiles.some(row=>row.id===id))throw new Error('Unknown profile');return id==='default'?saved.defaultDirectory:path.join(root,'profiles',id);};
  function persist(){fs.mkdirSync(root,{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify(saved,null,2),{flag:'wx',mode:0o600,flush:true});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}}
  const snapshot=()=>({currentId:saved.currentId,profiles:saved.profiles.map(row=>({...row,current:row.id===saved.currentId})),switchRequiresRestart:true});
  return {list:snapshot,directory,privatePaths:Object.freeze([...new Set([root,saved.defaultDirectory,path.resolve(localAppData,'Faber'),path.resolve(localAppData,'SophiaHarness')])]),get currentId(){return saved.currentId;},create(value){if(saved.profiles.length>=100)throw new Error('Profile limit reached');const row={id:randomUUID(),name:name(value)};saved.profiles.push(row);try{persist();}catch(error){saved.profiles.pop();throw error;}return {...row,current:false};},rename(id,value){const row=saved.profiles.find(row=>row.id===id);if(!row)throw new Error('Unknown profile');const previous=row.name;row.name=name(value);try{persist();}catch(error){row.name=previous;throw error;}return {...row,current:id===saved.currentId};},select(id){directory(id);const previous=saved.currentId;saved.currentId=id;try{persist();}catch(error){saved.currentId=previous;throw error;}return snapshot();}};
}
function assertProfileSwitchAllowed({draftsCleared,runs=[],downloads=[],voiceBusy=false,uiPending=false,updating=false,gatewayActive=0}){
  if(draftsCleared!==true)throw new Error('Resolve unsent drafts and open forms before switching profiles');
  if(runs.some(run=>['running','waiting_approval'].includes(run.status)))throw new Error('Stop running chats before switching profiles');
  if(downloads.some(job=>['queued','downloading'].includes(job.status)))throw new Error('Wait for or cancel active downloads before switching profiles');
  if(voiceBusy||uiPending||updating)throw new Error('Finish voice, interface refresh and source updates before switching profiles');
  if(gatewayActive>0)throw new Error('Wait for or stop active external API requests before switching profiles');
}
module.exports={getProfileDirectory,createProfiles,assertProfileSwitchAllowed};
