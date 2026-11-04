import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function containedPath(root, relative = '.', {missing = false} = {}) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || /^[a-z]:|^\\\\|:/i.test(relative)) throw new Error('Use a relative workspace path');
  const base = await fs.realpath(root);
  const target = path.resolve(base, relative);
  const inside = value => { const rel = path.relative(base, value); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
  if (!inside(target)) throw new Error('Path escapes workspace');
  let probe = target;
  let resolved;
  while (true) {
    try { const real=await fs.realpath(probe);if (!inside(real)) throw new Error('Symlink escapes workspace');resolved=path.join(real,path.relative(probe,target));break; }
    catch (error) {
      if (!missing || error.code !== 'ENOENT' || probe === base) throw error;
      probe = path.dirname(probe);
    }
  }
  return resolved;
}

const schema = properties => ({type:'object', properties, additionalProperties:false});
async function authorizedPath(ctx,relative,options){const file=await containedPath(ctx.project.path,relative,options);await ctx.authorizePath?.(file,`Access a file in another registered project: ${file}`);ctx.signal?.throwIfAborted();if(await containedPath(ctx.project.path,relative,options)!==file)throw new Error('File path changed while waiting for approval');return file;}
export function fileTools() {
  return [
    {name:'files_list', description:'List a project-relative directory (maximum 500 entries).',permission:'read',parameters:schema({path:{type:'string'}}),execute:async (args,ctx) => {
      const entries = await fs.readdir(await authorizedPath(ctx,args.path ?? '.'),{withFileTypes:true});
      return {entries:entries.slice(0,500).map(e=>({name:e.name,type:e.isSymbolicLink()?'symlink':e.isDirectory()?'directory':'file'})),truncated:entries.length>500};
    }},
    {name:'files_read',description:'Read UTF-8 text in the project, up to 1 MiB.',permission:'read',parameters:{...schema({path:{type:'string'}}),required:['path']},execute:async (args,ctx)=>{
      const file=await authorizedPath(ctx,args.path); const stat=await fs.stat(file);
      if(!stat.isFile()||stat.size>1024*1024) throw new Error('Expected a text file up to 1 MiB');
      const text=await fs.readFile(file,'utf8');return {path:args.path,text,sha256:crypto.createHash('sha256').update(text).digest('hex')};
    }},
    {name:'files_write',description:'Atomically write UTF-8 text in the project, retaining a previous-content backup outside the project. Optional expectedSha256 prevents overwriting newer edits.',permission:'files',parameters:{...schema({path:{type:'string'},text:{type:'string',maxLength:1048576},expectedSha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}),required:['path','text']},execute:async(args,ctx)=>{
      ctx.signal?.throwIfAborted();
      const file=await authorizedPath(ctx,args.path,{missing:true});
      if(ctx.sourceDir){const relative=path.relative(await fs.realpath(ctx.sourceDir),file);if(relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('Running harness source is protected: use upgrade_stage, upgrade_verify, and upgrade_apply');}
      let previous=null;try{previous=await fs.readFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
      const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
      const before=previous===null?null:digest(previous);
      if(args.expectedSha256&&args.expectedSha256!==before)throw new Error('File changed since it was read');
      let backup;
      if(previous!==null){if(!ctx.dataDir)throw new Error('A private data directory is required to back up existing files');const folder=path.join(ctx.dataDir,'file-backups');await fs.mkdir(folder,{recursive:true});backup=path.join(folder,crypto.randomUUID()+'.bak');await fs.writeFile(backup,previous,{flag:'wx'});}
      await fs.mkdir(path.dirname(file),{recursive:true});
      await containedPath(ctx.project.path,args.path,{missing:true});
      const temporary=path.join(path.dirname(file),`.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
      try{await fs.writeFile(temporary,args.text,{encoding:'utf8',flag:'wx'});ctx.signal?.throwIfAborted();await containedPath(ctx.project.path,args.path,{missing:true});let current=null;try{current=digest(await fs.readFile(file));}catch(error){if(error.code!=='ENOENT')throw error;}if(current!==before)throw new Error('File changed during write');ctx.signal?.throwIfAborted();await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}
      return {path:args.path,bytes:Buffer.byteLength(args.text),sha256:digest(args.text),backup};
    }}
  ];
}
