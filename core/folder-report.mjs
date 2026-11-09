import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {containedPath} from '../tools/files.mjs';
import {validate} from './registry.mjs';

export const folderReportSchema={type:'object',additionalProperties:false,required:['inputDirectory','outputDirectory','timeZone'],properties:{inputDirectory:{type:'string',minLength:1,maxLength:4096},outputDirectory:{type:'string',minLength:1,maxLength:4096},timeZone:{type:'string',minLength:1,maxLength:100}}};
const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
const relative=(root,target)=>path.relative(root,target).split(path.sep).join('/');
const inside=(root,target)=>{const value=path.relative(root,target);return !value||value!=='..'&&!value.startsWith('..'+path.sep)&&!path.isAbsolute(value);};
const safe=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\[\]`]/g,'\\$&');

async function readInput(root,name,{signal,authorize,maxBytes}){
  const target=await containedPath(root,name);await authorize(target);signal.throwIfAborted();
  const expected=await fs.lstat(target);if(!expected.isFile()||expected.isSymbolicLink()||expected.size>maxBytes)throw new Error(`Input exceeds the verified ${maxBytes}-byte model-context limit or is not an ordinary file`);
  const handle=await fs.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    if(!same(expected,await handle.stat()))throw new Error('Input identity changed before reading');await authorize(target);
    if(await containedPath(root,name)!==target||!same(expected,await fs.lstat(target)))throw new Error('Input path changed before reading');
    const chunks=[];let bytes=0;for await(const chunk of handle.createReadStream({autoClose:false})){signal.throwIfAborted();bytes+=chunk.length;if(bytes>maxBytes)throw new Error('Input grew beyond its verified context limit');chunks.push(chunk);}
    if(!same(expected,await handle.stat())||!same(expected,await fs.lstat(target)))throw new Error('Input changed while being read');
    const content=Buffer.concat(chunks,bytes),text=new TextDecoder('utf-8',{fatal:true}).decode(content);
    if(text.includes('\0'))throw new Error('Binary input needs review');return {text,sha256:digest(content),bytes};
  }finally{await handle.close();}
}
async function discover(root,input,output,authorize,signal){
  const files=[],folders=[input];
  while(folders.length){signal.throwIfAborted();const folder=folders.shift();await authorize(folder);let entries;
    try{entries=await fs.readdir(folder,{withFileTypes:true});}catch(error){files.push({path:relative(root,folder),status:'needs_review',error:`Folder could not be enumerated (${error.code||'read error'})`});continue;}
    for(const entry of entries){const target=path.join(folder,entry.name);if(inside(output,target))continue;
      if(files.length+folders.length>=1000)throw new Error('Report folder exceeds 1,000 inputs; narrow the approved input folder');
      if(entry.isSymbolicLink())files.push({path:relative(root,target),status:'needs_review',error:'Linked inputs are not followed'});
      else if(entry.isDirectory())folders.push(target);else if(entry.isFile())files.push({path:relative(root,target),status:'pending'});
    }
  }
  return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export function renderFolderReport(report,model){
  const lines=[`# Folder report — ${report.date}`,'',`Model: ${safe(model)}`,`Inputs: ${report.inputs.length}. Summary results and explicit exceptions follow.`,''];
  for(const input of report.inputs){lines.push(`## ${safe(input.path)}`,'',`Status: ${input.status==='summarized'?'Summarized':'Needs review'}`);if(input.sha256)lines.push(`SHA-256: ${input.sha256}`);lines.push('',safe(input.summary||input.error||'This input was not processed; review is required.'),'');}
  lines.push('---',`Input snapshot: ${report.manifestDigest}`,'The summaries are model-generated. Input references and exceptions are retained for review.','');return lines.join('\n');
}

// Only the selected local model summarizes data. Discovery, coverage and output identity are deterministic.
export async function runFolderReport({job,project,signal,authorize,summarize,save,write,contextTokens,outputTokens,model,previousReports=[]}){
  validate(job.definition.report,folderReportSchema);const root=await fs.realpath(project.path),settings=job.definition.report,input=await containedPath(root,settings.inputDirectory),output=await containedPath(root,settings.outputDirectory,{missing:true});
  if(inside(output,input))throw new Error('The report input folder cannot be inside its output folder');
  const date=job.reportDate;if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw new Error('Report date must be captured before admission');
  const filename=path.posix.join(settings.outputDirectory.split(path.sep).join('/'),`folder-report-${date}.md`),maxBytes=Math.min(1024*1024,Math.floor(contextTokens-outputTokens-768));
  if(!Number.isSafeInteger(maxBytes)||maxBytes<128)throw new Error('Increase the verified local context or reduce per-call output tokens before running a folder report');
  let report=job.report;
  if(!report){report=job.report={date,path:filename,stage:'scanning',inputs:await discover(root,input,output,authorize,signal),snapshotAt:new Date().toISOString()};await save();}
  const texts=new Map();
  for(const entry of report.inputs){
    signal.throwIfAborted();if(entry.status==='needs_review')continue;
    try{const current=await readInput(root,entry.path,{signal,authorize,maxBytes:maxBytes-Buffer.byteLength(entry.path)});if(entry.sha256&&entry.sha256!==current.sha256)throw new Error('Input changed after the saved snapshot; review before processing a new revision');Object.assign(entry,{sha256:current.sha256,bytes:current.bytes});texts.set(entry.path,current.text);}
    catch(error){signal.throwIfAborted();entry.status='needs_review';entry.error=(error.code?`Input could not be read (${error.code})`:error.message).replaceAll(root,'[project]').slice(0,1000);}
  }
  report.manifestDigest=digest(JSON.stringify(report.inputs.map(({path,sha256,bytes,error})=>({path,sha256,bytes,error}))));await save();
  const prior=previousReports.find(value=>value!==report&&value.date===date&&value.stage==='completed');
  if(prior){
    if(prior.manifestDigest!==report.manifestDigest)throw new Error('A dated report already exists for different inputs. Review it rather than overwriting a committed report');
    const existing=await readInput(root,prior.path,{signal,authorize,maxBytes:16*1024*1024});if(existing.sha256!==prior.sha256)throw new Error('Previously committed report no longer matches its receipt');job.report={...structuredClone(prior),reused:true};await save();return {path:prior.path,sha256:prior.sha256,reused:true,coverage:prior.inputs.length};
  }
  try{
    const existing=await readInput(root,filename,{signal,authorize,maxBytes:16*1024*1024});
    if(!report.writeIntent||existing.sha256!==report.writeIntent.sha256)throw new Error('An existing dated report has no matching receipt; review it before creating another output');
    report.stage='completed';report.sha256=existing.sha256;report.reconciled=true;report.needsReview=report.inputs.some(entry=>entry.status!=='summarized');delete report.draft;await save();return {path:filename,sha256:existing.sha256,reconciled:true,coverage:report.inputs.length};
  }catch(error){if(error.code!=='ENOENT')throw error;}
  report.stage='summarizing';await save();
  for(const entry of report.inputs){
    signal.throwIfAborted();if(entry.status!=='pending')continue;report.currentInput=entry.path;await save();
    try{
      const summary=await summarize({path:entry.path,text:texts.get(entry.path),sha256:entry.sha256});signal.throwIfAborted();
      if(typeof summary!=='string'||!summary.trim())throw new Error('The local model returned no summary');entry.summary=summary.trim();entry.status='summarized';
    }catch(error){signal.throwIfAborted();entry.status='needs_review';entry.error=String(error.message).replaceAll(root,'[project]').slice(0,1000);if(error.budgetPause){for(const remaining of report.inputs.filter(value=>value.status==='pending')){remaining.status='needs_review';remaining.error='Model budget paused before this input was processed';}break;}}
    await save();
  }
  delete report.currentInput;report.needsReview=report.inputs.some(entry=>entry.status!=='summarized');report.draft=renderFolderReport(report,model);if(Buffer.byteLength(report.draft)>1048576)throw new Error('Report exceeds the 1 MiB structured-write bound; narrow the input folder');report.draftSha256=digest(report.draft);report.stage='writing';report.writeIntent={path:filename,sha256:report.draftSha256,createdAt:new Date().toISOString()};await save();signal.throwIfAborted();
  const result=await write({path:filename,text:report.draft,expectedSha256:null});signal.throwIfAborted();if(result.sha256!==report.draftSha256)throw new Error('Report writer did not return the expected output digest');
  report.stage='completed';report.sha256=result.sha256;report.completedAt=new Date().toISOString();report.needsReview=report.inputs.some(entry=>entry.status!=='summarized');delete report.draft;await save();
  return {...result,coverage:report.inputs.length,summarized:report.inputs.filter(entry=>entry.status==='summarized').length,needsReview:report.inputs.filter(entry=>entry.status==='needs_review').length,inputSnapshot:report.manifestDigest};
}
