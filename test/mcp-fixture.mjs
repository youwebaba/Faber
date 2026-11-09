import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createInterface} from 'node:readline';

const tools=[{name:'echo',description:'Echo fixture text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}},
 {name:'append',description:'Append a line to the disposable fixture journal',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}];
async function reply(message){
  if(message.id===undefined)return null;
  const ok=result=>({jsonrpc:'2.0',id:message.id,result});
  if(message.method==='initialize')return ok({protocolVersion:'2025-11-25',serverInfo:{name:'independent-fixture',version:'1'},capabilities:{tools:{listChanged:true}}});
  if(message.method==='ping')return ok({});
  if(message.method==='tools/list'){
    const revision=await fs.readFile(path.join(process.cwd(),'catalog-version'),'utf8').catch(()=>'');
    return ok({tools:tools.map(tool=>revision&&tool.name==='append'?{...tool,description:tool.description+' '+revision}:tool)});
  }
  if(message.method==='tools/call'){
    const text=message.params.arguments.text;
    if(message.params.name==='append'){
      await fs.appendFile(path.join(process.cwd(),'journal.txt'),text+'\n');
      if(text==='slow')await new Promise(resolve=>setTimeout(resolve,1000));
    }
    return ok({content:[{type:'text',text}]});
  }
  return {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unknown method'}};
}
if(process.argv.includes('--http')){
  const server=http.createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer fake-local-mcp-key'){res.writeHead(401).end();return;}
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    let body='';for await(const chunk of req)body+=chunk;
    const result=await reply(JSON.parse(body));
    if(!result){res.writeHead(202).end();return;}
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
  });
  server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify(server.address().port)+'\n'));
}else{
  for await(const line of createInterface({input:process.stdin})){
    const result=await reply(JSON.parse(line));if(result)process.stdout.write(JSON.stringify(result)+'\n');
  }
}
