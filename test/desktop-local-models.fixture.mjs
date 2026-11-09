// Controlled child process for the opt-in Electron smoke; never loads weights.
import http from 'node:http';
import fs from 'node:fs/promises';
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const key = await fs.readFile(arg('--api-key-file'), 'utf8');
const alias = arg('--alias'), started = Date.now();
if (arg('--model').includes('Failure')) { process.stderr.write('Controlled incompatible model fixture'); process.exit(2); }
const spec=process.argv.includes('--spec-type')?arg('--spec-type'):null;if(spec)process.stderr.write(`I spec common_specu: adding speculative implementation '${spec}'\nI spec common_specu: - n_max=${arg('--spec-draft-n-max')}, n_min=0, p_min=0.00\n`);
http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/health') { response.statusCode = Date.now() - started < 1200 ? 503 : 200; response.end('{}'); return; }
  if (request.url === '/v1/models' && request.headers.authorization === `Bearer ${key}`) { response.end(JSON.stringify({ data: [{ id: alias }] })); return; }
  if (request.url === '/props' && request.headers.authorization === `Bearer ${key}`) { response.end(JSON.stringify({default_generation_settings:{n_ctx:process.argv.includes('--ctx-size')?Number(arg('--ctx-size')):2048}})); return; }
  if(request.url==='/slots'&&request.headers.authorization===`Bearer ${key}`){response.end(JSON.stringify([{speculative:!!spec}]));return;}
  response.statusCode = 403; response.end('{}');
}).listen(Number(arg('--port')), '127.0.0.1');
