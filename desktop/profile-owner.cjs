// Installer-owned kernel lock: the OS releases ownership when the worker dies.
const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
async function acquireProfileOwner(directory){
  const canonical=await fs.realpath(directory),key=createHash('sha256').update(process.platform==='win32'?canonical.toLowerCase():canonical).digest('hex');
  const address=process.platform==='win32'?`\\\\.\\pipe\\faber-profile-${key}`:path.join(os.tmpdir(),`faber-profile-${key}.sock`);
  const server=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,()=>{server.removeListener('error',reject);resolve();});});
  let closed=false;
  return {pid:process.pid,async close(){if(closed)return;closed=true;await new Promise(resolve=>server.close(resolve));}};
}
module.exports={acquireProfileOwner};
