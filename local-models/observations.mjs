import fs from 'node:fs/promises';
import {runProcess} from '../tools/process.mjs';

export async function processMemory(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return null;
  try{
    if(process.platform==='win32'){
      const result=await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-Process -Id ${pid} | Select-Object WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`],{timeout:3000,maxOutput:2048});
      if(result.code!==0)return null;const value=JSON.parse(result.stdout.trim());if(!Number.isSafeInteger(value.WorkingSet64)||value.WorkingSet64<0)return null;
      return {residentBytes:value.WorkingSet64,privateBytes:Number.isSafeInteger(value.PrivateMemorySize64)?value.PrivateMemorySize64:null,source:'Windows process working set',checkedAt:new Date().toISOString()};
    }
    const text=await fs.readFile(`/proc/${pid}/status`,'utf8'),value=Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(text)?.[1]);return Number.isSafeInteger(value)?{residentBytes:value*1024,source:'Process resident set',checkedAt:new Date().toISOString()}:null;
  }catch{return null;}
}
