import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const idPattern=/^[a-z][a-z0-9-]{0,63}$/;
export function validateExtension(module){
  const {manifest,tools}=module;
  if(!manifest||manifest.schemaVersion!==1||!idPattern.test(manifest.id)||!/^\d+\.\d+\.\d+$/.test(manifest.version)||typeof manifest.name!=='string'||!Array.isArray(tools))throw new Error('Invalid extension manifest');
  const names=new Set();
  for(const tool of tools){
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)||names.has(tool.name)||typeof tool.execute!=='function'||!['read','files','shell','computer','network','upgrade'].includes(tool.permission)||tool.parameters?.type!=='object')throw new Error('Invalid extension tool');
    names.add(tool.name);
  }
  if(!Array.isArray(manifest.actions))throw new Error('Extension requires actions array');
  for(const action of manifest.actions){
    if(typeof action.id!=='string'||typeof action.label!=='string'||!names.has(action.tool)||!Array.isArray(action.fields))throw new Error('Invalid extension UI action');
    for(const field of action.fields)if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field.name)||!['text','number','boolean'].includes(field.type)||typeof field.label!=='string')throw new Error('Invalid extension action field');
  }
  return {tools,metadata:JSON.parse(JSON.stringify(manifest))};
}
export function createExtensions({dataDir,runtime,confirm}){
  const directory=path.join(dataDir,'extensions');
  const approved=new Map(),approvalFile=path.join(directory,'approved.json');
  const persist=async()=>{const temporary=approvalFile+'.tmp';await fs.writeFile(temporary,JSON.stringify([...approved.entries()].map(([id,e])=>({id,filename:path.basename(e.filename),digest:e.digest})),null,2));await fs.rename(temporary,approvalFile);};
  const api={
    async initialize(){
      let records;try{records=JSON.parse(await fs.readFile(approvalFile,'utf8'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
      if(!Array.isArray(records))throw new Error('Invalid extension approvals');
      for(const entry of records){
        if(!idPattern.test(entry.id)||!new RegExp(`^${entry.id}-[a-f0-9]{64}\\.mjs$`).test(entry.filename)||!/^[a-f0-9]{64}$/.test(entry.digest))throw new Error('Invalid extension approval record');
        const filename=path.join(directory,entry.filename);if((await fs.lstat(filename)).isSymbolicLink()||hash(await fs.readFile(filename))!==entry.digest)throw new Error('Approved extension changed on disk');
        const candidate=validateExtension(await import(pathToFileURL(filename).href));if(candidate.metadata.id!==entry.id)throw new Error('Extension identity changed');
        approved.set(entry.id,{filename,digest:entry.digest,...candidate});
      }
      return this.reload();
    },
    async install({source,id},signal){
      signal?.throwIfAborted();
      if(!idPattern.test(id)||typeof source!=='string'||source.length>1024*1024)throw new Error('Invalid extension ID or source');
      if(!await confirm(`Enable executable extension “${id}”?\n\nThis is trusted JavaScript with full access to your Windows account. It is not sandboxed.\nSHA-256: ${hash(source)}`))throw new Error('Extension activation declined');
      signal?.throwIfAborted();
      await fs.mkdir(directory,{recursive:true});
      const filename=path.join(directory,`${id}-${hash(source)}.mjs`);
      await fs.writeFile(filename,source,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      if(hash(await fs.readFile(filename))!==hash(source))throw new Error('Extension integrity mismatch');
      signal?.throwIfAborted();
      const candidate=validateExtension(await import(pathToFileURL(filename).href));
      signal?.throwIfAborted();
      if(candidate.metadata.id!==id)throw new Error('Extension ID differs from manifest');
      const previous=approved.get(id);
      approved.set(id,{filename,digest:hash(source),...candidate});
      try{await this.reload();await persist();}catch(error){if(previous)approved.set(id,previous);else approved.delete(id);await this.reload();throw error;}
      return candidate.metadata;
    },
    async reload(){
      const entries=[...approved.values()];
      for(const entry of entries)if(hash(await fs.readFile(entry.filename))!==entry.digest)throw new Error('Extension changed since approval; reinstall for a new approval');
      await runtime.replaceExtensionTools(entries.flatMap(e=>e.tools),entries.map(e=>e.metadata));
      return entries.map(e=>e.metadata);
    },
    async disable(id,signal){signal?.throwIfAborted();const previous=approved.get(id);approved.delete(id);try{const result=await this.reload();signal?.throwIfAborted();await persist();return result;}catch(error){if(previous)approved.set(id,previous);await this.reload();throw error;}}
  };
  let queue=Promise.resolve();
  return Object.fromEntries(Object.entries(api).map(([name,method])=>[name,(...args)=>{const result=queue.catch(()=>{}).then(()=>method.apply(api,args));queue=result;return result;} ]));
}
export function extensionTools(manager,sourceDir){return [
  {name:'extension_install',description:'Review and activate a single-file executable extension. Requires a native trust confirmation; approval persists for this exact source digest.',permission:'upgrade',parameters:{type:'object',additionalProperties:false,properties:{id:{type:'string'},source:{type:'string'}},required:['id','source']},execute:(args,ctx)=>manager.install(args,ctx.signal)},
  {name:'extension_sample',description:'Enable the bundled workspace summary tool and UI button after a native trust confirmation.',permission:'upgrade',parameters:{type:'object',properties:{},additionalProperties:false},execute:async(args,ctx)=>manager.install({id:'workspace-summary',source:await fs.readFile(path.join(sourceDir,'extensions','workspace-summary.mjs'),'utf8')},ctx.signal)},
  {name:'extension_disable',description:'Disable an active executable extension and remove its UI actions.',permission:'upgrade',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:(args,ctx)=>manager.disable(args.id,ctx.signal)}
];}
