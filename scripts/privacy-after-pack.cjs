const path=require('node:path');
module.exports=async context=>{
  const {checkPrivacy}=await import('./privacy-check.mjs');
  checkPrivacy({archive:path.join(context.appOutDir,'resources','app.asar'),strict:true});
  const fs=require('node:fs/promises');
  const manifest=JSON.parse(await fs.readFile(path.join(context.packager.projectDir,'build','safetensors-runtime-lock.json'),'utf8'));
  const {verifySafetensorsPrivacy}=await import('./safetensors-privacy.mjs');
  await verifySafetensorsPrivacy(path.join(context.appOutDir,'resources','safetensors-runtime'),manifest);
};
