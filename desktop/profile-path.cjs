const fs=require('node:fs');
const path=require('node:path');
// Preserve an existing profile in place; never move a folder used by a running release.
function getProfileDirectory(localAppData,{exists=filename=>{try{return fs.statSync(filename).isDirectory();}catch(error){if(error.code==='ENOENT')return false;throw error;}}}={}){
  const previous=path.join(localAppData,'SophiaHarness');
  return exists(previous)?previous:path.join(localAppData,'Faber');
}
module.exports={getProfileDirectory};
