import fs from 'node:fs/promises';
import path from 'node:path';
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
export function extensionTools(manager,sourceDir){return [
  {name:'extension_install',description:'Review and activate a single-file executable extension. Requires a native trust confirmation; approval persists for this exact source digest.',permission:'upgrade',parameters:{type:'object',additionalProperties:false,properties:{id:{type:'string'},source:{type:'string'}},required:['id','source']},execute:(args,ctx)=>manager.install(args,ctx.signal)},
  {name:'extension_sample',description:'Enable the bundled workspace summary tool and UI button after a native trust confirmation.',permission:'upgrade',parameters:{type:'object',properties:{},additionalProperties:false},execute:async(args,ctx)=>manager.install({id:'workspace-summary',source:await fs.readFile(path.join(sourceDir,'extensions','workspace-summary.mjs'),'utf8')},ctx.signal)},
  {name:'extension_disable',description:'Disable an active executable extension and remove its UI actions.',permission:'upgrade',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:(args,ctx)=>manager.disable(args.id,ctx.signal)}
];}
