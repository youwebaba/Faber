import {parentPort,workerData} from 'node:worker_threads';
import zipXml from './vendor/workbook.cjs';
import path from 'node:path';
const {unzipSync,zipSync,DOMParser,XMLSerializer}=zipXml;
const main='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const strict='http://purl.oclc.org/ooxml/spreadsheetml/main';
const docRel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
const serialize=node=>encoder.encode(new XMLSerializer().serializeToString(node));
const children=(node,name)=>Array.from(node.childNodes||[]).filter(el=>el.nodeType===1&&el.localName===name&&el.namespaceURI===node.namespaceURI);
const elements=(node,name)=>Array.from(node.getElementsByTagNameNS(node.documentElement.namespaceURI,name));
function xml(files,name){
  if(!files[name]||files[name].length>16*1024*1024)throw new Error('Missing or oversized workbook XML part.');
  const source=decoder.decode(files[name]);
  if(/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('DTD and entities are unsupported in workbook XML.');
  return new DOMParser({onError:(level,message)=>{if(level!=='warning')throw Error(message);}}).parseFromString(source,'application/xml');
}
function coordinate(text){
  const match=/^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(text);
  if(!match)throw new Error('Use an A1-style cell or range.');
  const col=[...match[1]].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0),row=Number(match[2]);
  if(col>16384||row>1048576)throw new Error('Cell is outside an Excel sheet.');
  return {col,row};
}
function address(row,column){let col=column,letters='';while(col){col--;letters=String.fromCharCode(65+col%26)+letters;col=Math.floor(col/26);}return letters+row;}
function range(ref){const pieces=ref.toUpperCase().split(':');if(pieces.length>2)throw new Error('Use a single rectangular range.');const start=coordinate(pieces[0]),end=coordinate(pieces.at(-1));if(start.col>end.col||start.row>end.row)throw new Error('Invalid range order.');return {start,end};}
function overlap(a,b){return a.start.row<=b.end.row&&a.end.row>=b.start.row&&a.start.col<=b.end.col&&a.end.col>=b.start.col;}
function workbook(bytes,args){
  const seen=new Set();let total=0;
  const files=unzipSync(bytes,{filter:entry=>{
    if(!entry.name||entry.name.includes('\\')||entry.name.startsWith('/')||entry.name.split('/').includes('..')||entry.name.includes('\0')||seen.has(entry.name.toLowerCase())||seen.size>=2048)throw new Error('Invalid workbook archive entry.');
    seen.add(entry.name.toLowerCase());total+=entry.originalSize;
    if(!Number.isSafeInteger(total)||total>96*1024*1024||entry.originalSize>32*1024*1024)throw new Error('Expanded workbook exceeds the limit.');
    return true;
  }});
  const book=xml(files,'xl/workbook.xml'),rels=xml(files,'xl/_rels/workbook.xml.rels');
  if(![main,strict].includes(book.documentElement.namespaceURI))throw new Error('Unsupported workbook namespace.');
  const sheets=elements(book,'sheet'),names=sheets.map(sheet=>sheet.getAttribute('name'));
  if(!args.sheet)return {sheets:names};
  const sheet=sheets.find(sheet=>sheet.getAttribute('name')===args.sheet);if(!sheet)throw new Error('Worksheet was not found.');
  const id=sheet.getAttributeNS(docRel,'id')||sheet.getAttribute('r:id'),rel=elements(rels,'Relationship').find(el=>el.getAttribute('Id')===id);
  if(!rel||rel.getAttribute('TargetMode')==='External'||!rel.getAttribute('Type').endsWith('/worksheet'))throw new Error('Unsupported worksheet relationship.');
  const target=rel.getAttribute('Target');
  const dest=target.startsWith('/')?path.posix.normalize(target).slice(1):path.posix.normalize(path.posix.join('xl',target));
  if(!dest.startsWith('xl/')||/[\\?#\x00]/.test(dest))throw new Error('Invalid worksheet target.');
  const part=xml(files,dest),data=elements(part,'sheetData')[0];if(!data)throw new Error('No worksheet data.');
  const area=range(args.range||'A1:A1'),height=area.end.row-area.start.row+1,width=area.end.col-area.start.col+1;
  if(width*height>4096)throw new Error('Read or update up to 4,096 cells at a time.');
  const rows=new Map(children(data,'row').map(row=>[Number(row.getAttribute('r')),row]));
  const sharedPaths=elements(rels,'Relationship').find(el=>el.getAttribute('Type').endsWith('/sharedStrings')&&el.getAttribute('TargetMode')!=='External');
  const sharedTarget=sharedPaths?.getAttribute('Target');
  const sharedFile=sharedTarget&&(sharedTarget.startsWith('/')?sharedTarget.slice(1):path.posix.normalize(path.posix.join('xl',sharedTarget)));
  const strings=sharedFile&&files[sharedFile]?elements(xml(files,sharedFile),'si').map(si=>Array.from(si.getElementsByTagNameNS(si.namespaceURI,'t')).map(t=>t.textContent).join('')):[];
  if(args.values){
    if(args.values.length!==height||args.values.some(row=>!Array.isArray(row)||row.length!==width))throw new Error('The value matrix must exactly match the selected range.');
    if([...seen].some(name=>name.startsWith('_xmlsignatures/')||name.endsWith('vbaproject.bin'))||elements(part,'sheetProtection').length)throw new Error('Signed, protected or macro-enabled workbooks cannot be edited.');
    for(const node of [...elements(part,'mergeCell'),...elements(part,'f').filter(el=>['array','shared','dataTable'].includes(el.getAttribute('t')))]){
      const ref=node.getAttribute('ref')||node.parentNode?.getAttribute?.('r');
      if(ref&&overlap(area,range(ref)))throw new Error('The range intersects merged cells or a shared formula.');
    }
  }
  const values=[];
  for(let r=area.start.row;r<=area.end.row;r++){
    let row=rows.get(r);
    if(args.values&&!row){row=part.createElementNS(data.namespaceURI,'row');row.setAttribute('r',String(r));data.insertBefore(row,children(data,'row').find(node=>Number(node.getAttribute('r'))>r)||null);rows.set(r,row);}
    const cells=row?children(row,'c'):[],map=new Map(cells.map(cell=>[cell.getAttribute('r'),cell])),result=[];
    for(let c=area.start.col;c<=area.end.col;c++){
      const ref=address(r,c);let cell=map.get(ref);
      if(args.values){
        const val=args.values[r-area.start.row][c-area.start.col];
        if(!cell){
          cell=part.createElementNS(part.documentElement.namespaceURI,'c');cell.setAttribute('r',ref);
          const before=cells.find(el=>coordinate(el.getAttribute('r')).col>c)||children(row,'extLst')[0]||null;
          row.insertBefore(cell,before);
        }
        for(const name of ['f','v','is'])for(const child of children(cell,name))cell.removeChild(child);
        cell.removeAttribute('t');
        if(val!==null){
          const make=name=>part.createElementNS(part.documentElement.namespaceURI,name);
          const node=make(typeof val==='string'?'is':'v');
          if(typeof val==='string'){if(val.length>32767||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(val))throw new Error('Invalid Excel text value.');cell.setAttribute('t','inlineStr');const t=make('t');t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');t.appendChild(part.createTextNode(val));node.appendChild(t);}
          else{if(typeof val!=='boolean'&&(typeof val!=='number'||!Number.isFinite(val)))throw new Error('Use text, finite numbers, Boolean values or null.');if(typeof val==='boolean')cell.setAttribute('t','b');node.appendChild(part.createTextNode(typeof val==='boolean'?Number(val).toString():String(val)));}
          cell.insertBefore(node,children(cell,'extLst')[0]||null);
        }
      }
      if(!cell){result.push(null);continue;}
      const t=cell.getAttribute('t'),v=children(cell,'v')[0]?.textContent??null,f=children(cell,'f')[0];
      let value=t==='s'?strings[Number(v)]??null:t==='b'?v==='1':t==='inlineStr'?Array.from(cell.getElementsByTagNameNS(cell.namespaceURI,'t')).map(t=>t.textContent).join(''):v!==null&&(!t||t==='n')?Number(v):v;
      if(f)value={formula:f.textContent,cached:value};
      result.push(value);
    }values.push(result);
  }
  if(!args.values)return {sheet:args.sheet,range:args.range,values};
  const dim=elements(part,'dimension')[0];if(dim?.getAttribute('ref')){
    const used=range(dim.getAttribute('ref'));
    dim.setAttribute('ref',address(Math.min(used.start.row,area.start.row),Math.min(used.start.col,area.start.col))+':'+address(Math.max(used.end.row,area.end.row),Math.max(used.end.col,area.end.col)));
  }
  files[dest]=serialize(part);
  const calc=elements(book,'calcPr')[0];
  if(calc){calc.setAttribute('fullCalcOnLoad','1');files['xl/workbook.xml']=serialize(book);}
  const output=zipSync(files,{level:1});if(output.length>32*1024*1024)throw new Error('Updated workbook exceeds 32 MiB.');
  return {sheet:args.sheet,range:args.range,values,output};
}
try{const result=workbook(new Uint8Array(workerData.bytes),workerData.args);parentPort.postMessage({result},result.output?[result.output.buffer]:[]);}
catch(error){parentPort.postMessage({error:error.message});}

