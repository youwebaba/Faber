import fs from 'node:fs/promises';
export const manifest={schemaVersion:1,id:'workspace-summary',name:'Workspace summary',version:'1.0.0',description:'Count top-level workspace files and folders.',actions:[{id:'summarize',label:'Summarize workspace',tool:'workspace_summary',fields:[]}]};
export const tools=[{name:'workspace_summary',description:'Count top-level workspace files and directories.',permission:'read',parameters:{type:'object',properties:{},additionalProperties:false},execute:async(args,ctx)=>{
  const entries=await fs.readdir(ctx.project.path,{withFileTypes:true});
  return {files:entries.filter(e=>e.isFile()).length,directories:entries.filter(e=>e.isDirectory()).length,symlinks:entries.filter(e=>e.isSymbolicLink()).length};
}}];
