export async function docxPages(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer); let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) if (view.getUint32(offset,true) === 0x06054b50) { end = offset; break; }
  if (end < 0 || view.getUint16(end+4,true) || view.getUint16(end+6,true)) throw new Error('Unsupported or malformed DOCX archive');
  const count = view.getUint16(end+10,true); let offset = view.getUint32(end+16,true), expanded = 0, documentBytes;
  if (!count || count > 512 || offset >= end) throw new Error('DOCX archive exceeds its entry limit');
  const names = new Set();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset,true) !== 0x02014b50) throw new Error('Malformed DOCX archive directory');
    const flags=view.getUint16(offset+8,true),method=view.getUint16(offset+10,true),compressed=view.getUint32(offset+20,true),size=view.getUint32(offset+24,true),nameLength=view.getUint16(offset+28,true),extra=view.getUint16(offset+30,true),comment=view.getUint16(offset+32,true),local=view.getUint32(offset+42,true);
    const name = new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset+46,offset+46+nameLength)); expanded += size;
    if (flags&1 || ![0,8].includes(method) || size>8*1024*1024 || expanded>32*1024*1024 || size>Math.max(1024,compressed*200) || !name || name.includes('..') || /[\\\x00]/.test(name) || name.startsWith('/') || names.has(name) || offset+46+nameLength+extra+comment>end || local+30>offset || view.getUint32(local,true)!==0x04034b50) throw new Error('DOCX archive violates its size or structure limits');
    names.add(name);
    const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    if (start+compressed>offset) throw new Error('Malformed DOCX archive entry');
    if (name==='word/document.xml') {
      const content=bytes.subarray(start,start+compressed);
      if (method===0) documentBytes=content;
      else {
        const reader=new Blob([content]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),chunks=[];let total=0;
        try { while(true){const item=await reader.read();if(item.done)break;total+=item.value.length;if(total>size||total>8*1024*1024)throw new Error('DOCX expansion exceeds its declared size');chunks.push(item.value);} }
        finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
        documentBytes=new Uint8Array(total);let position=0;for(const chunk of chunks){documentBytes.set(chunk,position);position+=chunk.length;}
      }
      if(documentBytes.length!==size)throw new Error('DOCX expanded size did not match');
    }
    offset +=46+nameLength+extra+comment;
  }
  if(!documentBytes||!names.has('[Content_Types].xml'))throw new Error('DOCX has no Word document');
  const xml=new TextDecoder('utf-8',{fatal:true}).decode(documentBytes);
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('DOCX entity declarations are not supported');
  if((xml.match(/</g)||[]).length>100000)throw new Error('DOCX XML node limit exceeded');
  const parsed=new DOMParser().parseFromString(xml,'application/xml'),ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  if(parsed.querySelector('parsererror')||parsed.documentElement.namespaceURI!==ns||parsed.documentElement.localName!=='document')throw new Error('Malformed Word document XML');
  const paragraphs=[...parsed.getElementsByTagNameNS(ns,'p')];if(paragraphs.length>10000)throw new Error('DOCX paragraph limit exceeded');
  const pages=[[]];let characters=0,runs=0;
  for(const paragraph of paragraphs){
    const segments=[[]];
    if(paragraph.getElementsByTagNameNS(ns,'pageBreakBefore').length&&pages.at(-1).length)pages.push([]);
    for(const run of paragraph.getElementsByTagNameNS(ns,'r')){
      if(++runs>50000)throw new Error('DOCX run limit exceeded');
      for(const node of run.children){
        if(node.localName==='lastRenderedPageBreak'||node.localName==='br'&&node.getAttributeNS(ns,'type')==='page'){segments.push([]);continue;}
        const text=node.localName==='t'?node.textContent:node.localName==='tab'?'\t':node.localName==='br'?'\n':['drawing','pict'].includes(node.localName)?'[Image / graphic]':node.localName==='object'?'[Embedded object]':['footnoteReference','endnoteReference'].includes(node.localName)?'[Footnote / endnote]':'';
        characters+=text.length;if(characters>2_000_000)throw new Error('DOCX text limit exceeded');
        if(text)segments.at(-1).push({text,bold:run.getElementsByTagNameNS(ns,'b').length>0,italic:run.getElementsByTagNameNS(ns,'i').length>0});
      }
    }
    let cell=paragraph.parentElement;while(cell&&cell.localName!=='tc')cell=cell.parentElement;
    const row=cell?.parentElement,table=row?.parentElement;
    for(let segment=0;segment<segments.length;segment++){
      const parts=segments[segment];
      if(cell&&row?.localName==='tr')parts.unshift({text:`[Table row ${[...table.children].filter(node=>node.localName==='tr').indexOf(row)+1}, cell ${[...row.children].filter(node=>node.localName==='tc').indexOf(cell)+1}] `,bold:true});
      if(segment||pages.at(-1).reduce((sum,row)=>sum+row.reduce((n,part)=>n+part.text.length,0),0)>2500)pages.push([]);
      if(parts.length)pages.at(-1).push(parts);
    }
    if(pages.length>500)throw new Error('DOCX page limit exceeded');
  }
  if(!pages.at(-1).length&&pages.length>1)pages.pop();
  if([...names].some(name=>/^word\/(header|footer)\d+\.xml$/.test(name)))pages[0].unshift([{text:'[Header / footer content is omitted from this text reflow]',bold:true}]);
  if(!pages[0].length)pages[0].push([{text:'[No readable body text in this document]',bold:true}]);
  return pages;
}
