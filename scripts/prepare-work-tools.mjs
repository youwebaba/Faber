import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const [file,source,notices] of [
  ['desktop/vendor/mcp-client.cjs',"export {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'; export {StdioClientTransport} from '@modelcontextprotocol/client/stdio';",'MCP-CLIENT-NOTICES'],
  ['tools/vendor/workbook.cjs',"export {unzipSync,zipSync} from 'fflate'; export {DOMParser,XMLSerializer} from '@xmldom/xmldom';",'WORKBOOK-NOTICES'],
  ['tools/vendor/web-html.cjs',"export {parse} from 'parse5';",'WEB-HTML-NOTICES'],
  ['tools/vendor/crawler-mcp-server.cjs',"export {Server} from '@modelcontextprotocol/server'; export {StdioServerTransport} from '@modelcontextprotocol/server/stdio';",'CRAWLER-MCP-NOTICES']
]){
  const result=await build({absWorkingDir:root,stdin:{contents:source,resolveDir:root},outfile:path.join(root,file),bundle:true,platform:'node',format:'cjs',target:'node24',minify:true,metafile:true,legalComments:'eof'});
  const manifests=new Map();
  for(const input of Object.keys(result.metafile.inputs).filter(name=>name.includes('node_modules/'))){
    let dir=path.dirname(path.resolve(root,input));
    while(dir!==root){
      try{
        const pkg=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
        if(pkg.name&&pkg.version){
          const key=pkg.name+'@'+pkg.version;
          if(!manifests.has(key)){
            const filenames=(await fs.readdir(dir)).filter(name=>/^(licen[sc]e|copying|notice)([.-]|$)/i.test(name));
            if(!filenames.length)throw new Error('Missing notice for '+key);
            manifests.set(key,await Promise.all(filenames.sort().map(async name=>name+'\n'+await fs.readFile(path.join(dir,name),'utf8'))));
          }
          break;
        }
      }catch(error){if(error.code!=='ENOENT')throw error;}
      dir=path.dirname(dir);
    }
  }
  await fs.writeFile(path.join(root,'build/licenses',notices+'.txt'),[...manifests].sort(([a],[b])=>a.localeCompare(b)).map(([name,licenses])=>name+'\n\n'+licenses.join('\n')).join('\n\n'));
  console.log(file+' prepared with notices for '+manifests.size+' packages.');
}
