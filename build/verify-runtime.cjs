const {verifyRuntime}=require('../desktop/runtime-integrity.cjs');
const {verifyLightpanda}=require('../desktop/lightpanda-integrity.cjs');
module.exports=async context=>{
  const {checkPrivacy}=await import('../scripts/privacy-check.mjs');
  checkPrivacy({root:context.packager.projectDir,strict:true});
  await verifyRuntime(context.packager.projectDir);
  await verifyLightpanda(context.packager.projectDir);
  const {verifyMusicRuntime}=await import('../local-music/integrity.mjs');
  const fs=require('node:fs/promises'),path=require('node:path');
  const musicLock=JSON.parse(await fs.readFile(path.join(context.packager.projectDir,'build','music-runtime-lock.json'),'utf8'));
  await verifyMusicRuntime(path.join(context.packager.projectDir,'.runtime','music-runtime'),musicLock);
  const {verifyNativeRuntime}=await import('../native/integrity.mjs');
  await verifyNativeRuntime(context.packager.projectDir);
};
