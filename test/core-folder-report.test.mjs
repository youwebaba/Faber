import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runFolderReport} from '../core/folder-report.mjs';
import {fileTools} from '../tools/files.mjs';

test('folder report covers ten real input files with one explicit exception and reuses a committed report',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-folder-report-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const project={path:path.join(root,'project')},dataDir=path.join(root,'profile');await fs.mkdir(path.join(project.path,'input'),{recursive:true});
  for(let index=0;index<9;index++)await fs.writeFile(path.join(project.path,'input',`item-${index}.txt`),`Unique input ${index}: review the corresponding work item.`);await fs.writeFile(path.join(project.path,'input','needs-review.txt'),Buffer.from([0xff,0xfe,0x00]));
  const job={definition:{report:{inputDirectory:'input',outputDirectory:'reports',timeZone:'UTC'}},reportDate:'2026-11-09'},signal=new AbortController().signal,writer=fileTools().find(tool=>tool.name==='files_write');let calls=0,writes=0;
  const options={job,project,signal,contextTokens:4096,outputTokens:256,model:'Controlled local summary fixture',authorize:async()=>{},save:async()=>{},summarize:async input=>{calls++;return `Summary of ${input.text}`;},write:async args=>{writes++;return writer.execute(args,{project,dataDir,signal});}};
  const result=await runFolderReport(options);assert.equal(result.coverage,10);assert.equal(result.summarized,9);assert.equal(result.needsReview,1);assert.equal(calls,9);assert.equal(writes,1);const text=await fs.readFile(path.join(project.path,result.path),'utf8');for(let index=0;index<9;index++)assert.ok(text.includes(`Unique input ${index}`));assert.match(text,/needs-review\.txt/);assert.match(text,/Needs review/);
  const prior=job.report,duplicate={definition:job.definition,reportDate:job.reportDate};const reused=await runFolderReport({...options,job:duplicate,previousReports:[prior]});assert.equal(reused.reused,true);assert.equal(calls,9);assert.equal(writes,1);
});
test('a changed saved input and exhausted model budget remain visible instead of claiming full processing',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'faber-folder-report-budget-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'input'));await fs.writeFile(path.join(root,'input','a.txt'),'known');await fs.writeFile(path.join(root,'input','b.txt'),'second');
  const job={definition:{report:{inputDirectory:'input',outputDirectory:'reports',timeZone:'UTC'}},reportDate:'2026-11-09'},writer=fileTools().find(tool=>tool.name==='files_write'),signal=new AbortController().signal;let calls=0;
  const result=await runFolderReport({job,project:{path:root},signal,contextTokens:4096,outputTokens:128,model:'fixture',authorize:async()=>{},save:async()=>{},summarize:async()=>{calls++;const error=new Error('Token budget exhausted');error.budgetPause=true;throw error;},write:args=>writer.execute(args,{project:{path:root},dataDir:path.join(os.tmpdir(),'faber-report-unused-backup'),signal})});assert.equal(result.needsReview,2);assert.equal(calls,1);assert.equal(result.summarized,0);
});
