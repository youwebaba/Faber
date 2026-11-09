import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import zipXml from '../tools/vendor/workbook.cjs';
import {workbookTools} from '../tools/workbook.mjs';
const {zipSync,unzipSync}=zipXml;
const namespace='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relns='http://schemas.openxmlformats.org/package/2006/relationships';
const worksheet='<worksheet xmlns="'+namespace+'"><dimension ref="A1:C2"/><sheetData><row r="1"><c r="A1" s="1" t="n"><v>3</v></c><c r="C1"><f>A1*2</f><v>6</v></c></row></sheetData></worksheet>';
async function fixture(t,calculation='<calcPr calcId="1"/>'){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-workbook-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const inputs={'xl/workbook.xml':'<workbook xmlns="'+namespace+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>'+calculation+'</workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="'+relns+'"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':worksheet,'xl/styles.xml':'<styleSheet xmlns="'+namespace+'"/>','xl/media/image.dat':'binary fixture bytes'};
  const parts=Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,Buffer.from(v)])),filename=path.join(root,'sample.xlsx');
  const original=zipSync(parts);await fs.writeFile(filename,original);
  const ctx={project:{id:'p',path:root},dataDir:path.join(root,'data'),signal:new AbortController().signal};
  const [read,write]=workbookTools(),range={path:'sample.xlsx',sheet:'Data',range:'A1:B1'};
  return {ctx,read:(args=range)=>read.execute(args,ctx),write:args=>write.execute({...range,...args},ctx),filename,original,parts,range};
}
test('range edits retain untouched formulas, style, assets and the original backup, and a retried update is idempotent',async t=>{
  const f=await fixture(t);assert.deepEqual((await f.read({path:'sample.xlsx'})).sheets,['Data']);
  const first=await f.read();assert.deepEqual(first.values,[[3,null]]);
  const args={values:[[5,'=literal']],expectedSha256:first.sha256};
  const updated=await f.write(args);assert.equal(updated.cells,2);assert.deepEqual(await fs.readFile(updated.backup),Buffer.from(f.original));
  assert.deepEqual((await f.read({...f.range,range:'A1:C1'})).values,[[5,'=literal',{formula:'A1*2',cached:6}]]);
  const saved=await fs.readFile(f.filename),parts=unzipSync(saved);
  for(const k of ['xl/styles.xml','xl/media/image.dat','xl/_rels/workbook.xml.rels'])assert.deepEqual(Buffer.from(parts[k]),f.parts[k]);
  assert.match(Buffer.from(parts['xl/worksheets/sheet1.xml']).toString(),/r="A1" s="1"/);
  assert.equal((await f.write(args)).alreadyApplied,true);assert.deepEqual(await fs.readFile(f.filename),saved);
  await assert.rejects(f.write({...args,values:[[9,'other']]}),/changed since/);
  await assert.rejects(f.write({...args,values:[[1]],expectedSha256:updated.sha256}),/matrix/);
});
test('workbook reader refuses malformed archives, out-of-project names and oversized ranges',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.read({...f.range,range:'A1:XFD1048576'}),/4,096/);
  await assert.rejects(f.read({...f.range,path:'../outside.xlsx'}),/escapes/);
  f.parts['xl/worksheets/sheet1.xml']=Buffer.from('<!DOCTYPE sheet><sheet/>');const bad=zipSync(f.parts);await fs.writeFile(f.filename,bad);
  await assert.rejects(f.write({values:[[1,2]],expectedSha256:createHash('sha256').update(bad).digest('hex')}),/DTD/);
});
test('editing a workbook without calculation properties requests recalculation in schema order',async t=>{
  const f=await fixture(t,'<extLst/>'),first=await f.read();
  await f.write({values:[[6,'demo']],expectedSha256:first.sha256});
  const contents=Buffer.from(unzipSync(await fs.readFile(f.filename))['xl/workbook.xml']).toString();
  assert.match(contents,/<\/sheets><calcPr[^>]*fullCalcOnLoad="1"[^>]*\/><extLst/);
});
