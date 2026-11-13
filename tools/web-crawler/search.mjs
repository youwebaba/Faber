import {validateWebUrl} from './network.mjs';

const providers = [
  {name: 'Mwmbl', site: 'https://mwmbl.org/', endpoint: 'https://api.mwmbl.org/api/v2/search/', rows: value => value?.results, hit: item => [item.url, item.title, item.content]},
  {name: 'Wiby', site: 'https://wiby.me/', endpoint: 'https://wiby.me/json/', rows: value => value, hit: item => [item.URL, item.Title, item.Snippet || item.Description]}
];

const snippet = (value, limit) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';

export async function searchWeb(reader, {query, limit = 8}, signal) {
  query = query.trim();
  if (!query) throw new Error('Enter a web search query.');
  const sources = [];
  for (const provider of providers) {
    signal?.throwIfAborted();
    const endpoint = new URL(provider.endpoint);
    endpoint.searchParams.set('q', query);
    try {
      const response = await reader.read(endpoint.href, {signal, allowedOrigins: new Set([endpoint.origin])});
      if (response.status !== 200 || !response.contentType.toLowerCase().includes('json')) throw new Error('Search provider returned HTTP ' + response.status + ' or a non-JSON response.');
      const rows = provider.rows(JSON.parse(response.body.toString('utf8')));
      if (!Array.isArray(rows)) throw new Error('Search provider returned an unrecognized results format.');
      const results = [], seen = new Set();
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const [address, title, content] = provider.hit(row);
        let url;
        try { url = validateWebUrl(address).href; } catch { continue; }
        if (url.length > 2048 || seen.has(url)) continue;
        seen.add(url);
        results.push({url, title: snippet(title, 240) || new URL(url).hostname, snippet: snippet(content, 420)});
        if (results.length === limit) break;
      }
      sources.push({provider: provider.name, attributionUrl: provider.site, status: results.length ? 'ok' : 'empty'});
      if (results.length) return {query, results, sources, retrievedAt: response.retrievedAt, untrusted: true};
    } catch (error) {
      signal?.throwIfAborted();
      sources.push({provider: provider.name, attributionUrl: provider.site, status: 'unavailable', reason: String(error.message).slice(0, 250)});
    }
  }
  return {query, results: [], sources, untrusted: true, guidance: 'No source links were retrieved. Try another query or supply known public source URLs to web_crawl.'};
}
