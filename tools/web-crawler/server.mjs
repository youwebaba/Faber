import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import protocol from '../vendor/crawler-mcp-server.cjs';
import {validate} from '../../core/registry.mjs';
import {crawlerTools} from './catalog.mjs';
import {createCrawlerEngine} from './engine.mjs';
import {createWebReader} from './network.mjs';
import {searchWeb} from './search.mjs';

export async function serveCrawler({transport, reader = createWebReader()} = {}) {
  const {Server, StdioServerTransport} = protocol;
  const server = new Server({name: 'faber-web-crawler', version: '1.0.0'}, {capabilities: {tools: {}}});
  const engine = createCrawlerEngine({reader});
  // The desktop allocates this stdio connection to exactly one authorized chat run.
  const owner = 'stdio';
  server.onclose = () => { engine.close(); reader.close(); };
  server.setRequestHandler('tools/list', () => ({tools: crawlerTools}));
  server.setRequestHandler('tools/call', async ({params}, context) => {
    try {
      const tool = crawlerTools.find(item => item.name === params.name);
      if (!tool) throw new Error('Unknown crawler tool.');
      const args = params.arguments ?? {}, signal = context.mcpReq.signal;
      validate(args, tool.inputSchema);
      signal.throwIfAborted();
      let data;
      switch (tool.name) {
        case 'web_search': data = await searchWeb(reader, args, signal); break;
        case 'web_scrape': data = await engine.scrape(owner, {...args, signal}); break;
        case 'web_crawl': data = engine.start(owner, {...args, signal}); break;
        case 'web_crawl_page': data = engine.page(owner, args); break;
        case 'web_crawl_cancel': data = engine.cancel(owner, args.id); break;
        case 'web_crawl_status': {
          const end = Date.now() + (args.waitMs ?? 0);
          data = engine.status(owner, args);
          while (data.state === 'running' && !data.pages.length && Date.now() < end) {
            await delay(Math.min(200, end - Date.now()), undefined, {signal});
            data = engine.status(owner, args);
          }
          break;
        }
      }
      const value = {...data, untrusted: true};
      return {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value};
    } catch (error) {
      return {isError: true, content: [{type: 'text', text: String(error.message || error).slice(0, 600)}]};
    }
  });
  try {
    await server.connect(transport ?? new StdioServerTransport(process.stdin, process.stdout, {maxBufferSize: 4 * 1024 * 1024}));
  } catch (error) {
    engine.close();
    reader.close();
    throw error;
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serveCrawler();
}
