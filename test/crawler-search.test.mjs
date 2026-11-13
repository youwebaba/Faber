import test from 'node:test';
import assert from 'node:assert/strict';
import {searchWeb} from '../tools/web-crawler/search.mjs';

const json = value => ({status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(value)), retrievedAt: '2026-01-01T00:00:00Z'});

test('keyword discovery encodes one query, keeps provider order and drops unsafe and duplicate source URLs', async () => {
  const query = 'test & source?q=example + café';
  const reader = {async read(address, {allowedOrigins}) {
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.mwmbl.org'); assert.ok(allowedOrigins.has(url.origin)); assert.deepEqual([...url.searchParams], [['q', query]]);
    return json({results: [
      {url: 'http://127.0.0.1/local'}, {url: 'file:///example'}, {url: 'https://user:secret@example.com/'},
      {url: 'https://example.com/one#section', title: ' First  result ', content: ' a\npassage '},
      {url: 'https://example.com/one#other', title: 'Duplicate'}, {url: 'https://example.org/two'}, {url: 'https://example.org/three'},
    ]});
  }};
  const result = await searchWeb(reader, {query, limit: 2});
  assert.deepEqual(result.results, [{url: 'https://example.com/one', title: 'First result', snippet: 'a passage'}, {url: 'https://example.org/two', title: 'example.org', snippet: ''}]);
  assert.equal(result.sources[0].provider, 'Mwmbl'); assert.equal(result.untrusted, true);
});

test('empty or unavailable discovery falls back to Wiby with source credit and bounded public snippets', async () => {
  for (const primary of [json({results: []}), {status: 503, contentType: 'text/html'}]) {
    const calls = [];
    const result = await searchWeb({read: async address => {
      calls.push(new URL(address).hostname);
      return calls.length === 1 ? primary : json([{URL: 'https://example.com/article', Title: 'Archive', Snippet: 's'.repeat(1000)}]);
    }}, {query: 'an archive'});
    assert.deepEqual(calls, ['api.mwmbl.org', 'wiby.me']);
    assert.equal(result.sources[0].status, primary.status === 200 ? 'empty' : 'unavailable');
    assert.deepEqual(result.sources[1], {provider: 'Wiby', status: 'ok', attributionUrl: 'https://wiby.me/'});
    assert.equal(result.results[0].snippet.length, 420);
  }
});

test('lookup failure and a canceled lookup produce separate outcomes', async () => {
  const unavailable = await searchWeb({read: async () => { throw Error('Offline'); }}, {query: 'news'});
  assert.deepEqual(unavailable.results, []); assert.deepEqual(unavailable.sources.map(source => source.status), ['unavailable', 'unavailable']); assert.ok(unavailable.guidance);
  const controller = new AbortController(); let reads = 0;
  await assert.rejects(searchWeb({read: async () => { reads++; controller.abort(); throw controller.signal.reason; }}, {query: 'news'}, controller.signal), {name: 'AbortError'});
  assert.equal(reads, 1);
});
