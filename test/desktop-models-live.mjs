import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createModelHub} from '../model-hub/index.mjs';

if(!process.argv.includes('--allow-tiny-public-download'))throw new Error('Explicit --allow-tiny-public-download is required; this downloads exactly the documented 453864-byte public fixture.');
const repoId='hf-internal-testing/tiny-random-gpt2',revision='71034c5d8bde858ff824298bdedc65515b97d2b9';
const expectedBytes=453864,expectedHash='8111d5afb0715dbf5a31396d31432cb56370ba23f6650a035ea0fc8a20b4e500';
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'SophiaHarness-hf-live-'));
const sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hub=await createModelHub({dataDir,sourceDir,host:{getSecret:async()=>'',setSecret:async()=>{throw new Error('Live fixture must not save credentials');}},emit:()=>{}});
try{
  const search=await hub.request('models.search',{query:'tiny-random-gpt2',limit:3,format:'safetensors'});assert.ok(search.models.length);
  const details=await hub.request('models.inspect',{repoId,revision});assert.equal(details.revision,revision);
  const descriptor=details.files.find(file=>file.path==='model.safetensors');assert.equal(descriptor?.size,expectedBytes);assert.equal(descriptor?.sha256,expectedHash);
  const started=await hub.request('models.download',{repoId,revision,files:['model.safetensors']});
  let job;const deadline=Date.now()+120000;
  while(Date.now()<deadline){job=(await hub.request('models.state')).downloads.find(item=>item.id===started.id);if(['completed','failed','canceled','interrupted'].includes(job?.status))break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(job?.status,'completed',job?.error||'Download did not complete before timeout');
  const filename=path.join(job.directory,'model.safetensors'),bytes=await fs.readFile(filename),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length,expectedBytes);assert.equal(sha256,expectedHash);
  const result={ok:true,kind:'live-public-Hugging-Face',repoId,revision,searchResults:search.models.map(model=>model.id),jobId:job.id,filename,bytes:bytes.length,sha256};
  const report=path.join(dataDir,'live-model-download-report.json');await fs.writeFile(report,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,report}));
}finally{await hub.close();}
