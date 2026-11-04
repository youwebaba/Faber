const {verifyRuntime}=require('../desktop/runtime-integrity.cjs');
const {verifyLightpanda}=require('../desktop/lightpanda-integrity.cjs');
module.exports=async context=>{
  await verifyRuntime(context.packager.projectDir);
  await verifyLightpanda(context.packager.projectDir);
  const {verifyNativeRuntime}=await import('../native/integrity.mjs');
  await verifyNativeRuntime(context.packager.projectDir);
};
