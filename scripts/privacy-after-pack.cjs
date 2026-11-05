const path=require('node:path');
module.exports=async context=>{
  const {checkPrivacy}=await import('./privacy-check.mjs');
  checkPrivacy({archive:path.join(context.appOutDir,'resources','app.asar'),strict:true});
};
