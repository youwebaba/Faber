const {verifyRuntime}=require('../desktop/runtime-integrity.cjs');
const {verifyLightpanda}=require('../desktop/lightpanda-integrity.cjs');
module.exports=async context=>{
  const {checkPrivacy}=await import('../scripts/privacy-check.mjs');
  checkPrivacy({root:context.packager.projectDir,strict:true});
  await verifyRuntime(context.packager.projectDir);
  await verifyLightpanda(context.packager.projectDir);
  const {verifyNativeRuntime}=await import('../native/integrity.mjs');
  await verifyNativeRuntime(context.packager.projectDir);
};
