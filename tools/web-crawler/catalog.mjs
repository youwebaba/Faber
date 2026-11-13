const string = (maxLength, description) => ({type: 'string', minLength: 1, maxLength, ...(description && {description})});
const integer = (minimum, maximum, description) => ({type: 'integer', minimum, maximum, ...(description && {description})});
const args = (properties, required) => ({type: 'object', properties, required, additionalProperties: false});
const url = string(2048, 'Absolute public HTTP(S) source URL.');
const id = string(128, 'Use the id returned by web_crawl or web_scrape.');
const pageLimit = integer(1, 50);
const linkPaging = {linkOffset: integer(0, 200), linkLimit: integer(0, 50)};

export const crawlerTools = [
  {name: 'web_search', description: 'Search for public sources. The query is sent to Mwmbl, with Wiby as fallback. Send only public search terms. Open relevant links with web_scrape or web_crawl before citing a factual claim. Credit Wiby when using its results.', inputSchema: args({query: string(512), limit: integer(1, 20)}, ['query'])},
  {name: 'web_scrape', description: 'Read one public page as text with its title, final source URL and links. If the fact is beyond the first excerpt, call web_crawl_page with the returned id, pageId=page.id, and find set to a keyword. For interactive pages, login, forms or uploads use browser_open.', inputSchema: args({url}, ['url'])},
  {name: 'web_crawl', description: 'Start a parallel read-only research job across public seed URLs. Use maxDepth 0 to read a batch of exact URLs, or 1+ to follow links within the supplied origins. Poll web_crawl_status for successes, failures and matching passages.', inputSchema: args({urls: {type: 'array', items: url, minItems: 1, maxItems: 1000}, maxPages: integer(1, 5000, 'Total page budget including seeds.'), maxDepth: integer(0, 10), concurrency: integer(1, 16), perOriginConcurrency: integer(1, 2)}, ['urls'])},
  {name: 'web_crawl_status', description: 'Read job progress and a small page of source summaries. Pass query to find a literal phrase in retained text. Use offset=nextOffset for later pages, including while discovery is still running. Optional waitMs waits briefly for results. Inspect failures before describing coverage.', inputSchema: args({id, query: string(200), offset: integer(0, 5000), limit: pageLimit, waitMs: integer(0, 10000)}, ['id'])},
  {name: 'web_crawl_page', description: 'Read evidence from one retained page. With no offset it continues after the last excerpt. Use find to locate a phrase anywhere in the retained text, or set offset to reread a character range. Inspect the passage before citing. If contentTruncated, scrape the source individually.', inputSchema: args({id, pageId: string(64), find: string(200, 'Literal case-insensitive phrase to locate at or after offset.'), offset: integer(0, 120000, 'Explicit starting character. Zero rereads the start.'), limit: integer(1, 20000, 'Maximum characters to return.'), ...linkPaging}, ['id', 'pageId'])},
  {name: 'web_crawl_cancel', description: 'Stop an owned crawl and return a summary. Completed pages remain available for this run, within the retention budget.', inputSchema: args({id}, ['id'])}
];
