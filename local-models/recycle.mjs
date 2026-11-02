import fs from 'node:fs/promises';
import {outputPath,noLinks} from '../model-hub/paths.mjs';

const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
// Called under the hub's file reservation and the local manager lifecycle fence.
export async function recycleModel({directory,model,currentFiles=[],trashItem,signal}){
  if(!trashItem)throw new Error('Recycle Bin is unavailable in this host');
  if(!model.files?.length)throw new Error('No detected model files to recycle');
  const entries=[];
  for(const relative of model.files){
    signal?.throwIfAborted();const target=await outputPath(directory,relative),stat=await fs.lstat(target);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Model file changed; refresh the library');
    if(currentFiles.some(file=>file.target.toLowerCase()===target.toLowerCase()||(file.dev===stat.dev&&file.ino===stat.ino)))throw new Error('Stop the loaded model before moving its files to Recycle Bin');
    entries.push({relative,target,stat});
  }
  const files=[];
  try{
    for(const entry of entries){
      signal?.throwIfAborted();await noLinks(entry.target);
      if(!same(entry.stat,await fs.lstat(entry.target)))throw new Error('Model file changed during deletion; remaining files were preserved');
      signal?.throwIfAborted();await trashItem(entry.target);files.push(entry.relative);
    }
    return {deleted:true,modelId:model.id,files};
  }catch(error){
    if(!files.length)throw error;
    return {deleted:false,modelId:model.id,files,remainingFiles:model.files.filter(file=>!files.includes(file)),error:error.message};
  }
}
