import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createCrawlerEngine} from '../tools/web-crawler/engine.mjs';
import {extractContent, normalizeWebUrl} from '../tools/web-crawler/content.mjs';

const response = (url, body, extra = {}) => ({url, status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from(body), retrievedAt: '2026-01-01T00:00:00Z', ...extra});
async function settled(engine, owner, id) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const result = engine.status(owner, {id, limit: 50});
    if (['completed', 'cancelled'].includes(result.state)) return result;
    await delay(2);
  }
  throw Error('Fixture crawl did not settle');
}
function engineFixture(t, read, limits) {
  const engine = createCrawlerEngine({reader: {read}, limits});
  t.after(() => engine.close()); return engine;
}

test('HTML5 extraction treats malformed HTML, entities, hidden/raw text and URLs as inert data', () => {
  globalThis.crawlerExecuted = false;
  const content = extractContent(response('https://seed.example/start', '<!doctype html><TITLE>AT&amp;T &copy;</TITLE><base href="/docs/"><p>First<br>Second &euro;<p hidden>secret<p aria-hidden="true">hidden</p><script>globalThis.crawlerExecuted=true;<a href="https://evil.example">bad</a></script><style>.x{color:red}</style><a href=next#one>Next <b>page</b></a><a href="next#two">duplicate</a><a href="javascript:alert(1)">inert</a><a href="https://u:p@evil.example/">credentials</a>'));
  assert.equal(content.title, 'AT&T ©');
  assert.match(content.text, /First\nSecond €/);
  assert.doesNotMatch(content.text, /secret|hidden|globalThis|color:red|bad/);
  assert.deepEqual(content.links, [{url: 'https://seed.example/docs/next', text: 'Next page'}]);
  assert.equal(globalThis.crawlerExecuted, false); delete globalThis.crawlerExecuted;
  assert.equal(normalizeWebUrl('https://seed.example/a#b'), 'https://seed.example/a');
  assert.equal(normalizeWebUrl('file:///secret'), null);
});

test('250 explicit synthetic sites crawl 750 pages in parallel with BFS, dedup and origin scope', async t => {
  const seeds = Array.from({length: 250}, (_, index) => `https://site${index}.example/`);
  const requests = [], activeOrigins = new Map(); let active = 0, peak = 0, originPeak = 0;
  const engine = engineFixture(t, async (url, {signal, allowedOrigins}) => {
    const parsed = new URL(url); assert.equal(allowedOrigins.size, 250); assert.ok(allowedOrigins.has(parsed.origin));
    active++; peak = Math.max(peak, active);
    activeOrigins.set(parsed.origin, (activeOrigins.get(parsed.origin) ?? 0) + 1); originPeak = Math.max(originPeak, activeOrigins.get(parsed.origin));
    requests.push(url);
    try {
      await delay(1, undefined, {signal});
      return response(url, `<title>Site ${parsed.hostname}</title><main>Useful content ${parsed.pathname}</main><a href="/one#fragment">One</a><a href="/one#duplicate">Cycle</a><a href="/two">Two</a><a href="https://unrequested.example/private">Outside</a><a href="/">Root</a>`);
    } finally { active--; activeOrigins.set(parsed.origin, activeOrigins.get(parsed.origin) - 1); }
  });
  const startedAt = performance.now();
  const {id} = engine.start('owner', {urls: seeds, maxPages: 1000, maxDepth: 1, concurrency: 16, perOriginConcurrency: 2});
  const result = await settled(engine, 'owner', id);
  assert.equal(result.counts.completed, 750); assert.equal(result.counts.failed, 0); assert.equal(result.counts.droppedPages, 0);
  assert.equal(requests.length, 750); assert.equal(new Set(requests).size, 750);
  assert.deepEqual(new Set(requests.slice(0, 250)), new Set(seeds));
  assert.ok(peak > 1 && peak <= 16); assert.ok(originPeak <= 2);
  assert.ok(requests.every(url => new URL(url).hostname !== 'unrequested.example'));
  const matched = engine.status('owner', {id, query: 'site249.example', limit: 10});
  assert.equal(matched.pages.length, 3); assert.ok(matched.pages.every(page => page.excerpt.length <= 240));
  const found = engine.page('owner', {id, pageId: matched.pages[0].id, limit: 7, linkLimit: 1});
  assert.equal(found.text.length, 7); assert.equal(found.links.length, 1); assert.equal(found.nextOffset, 7);
  assert.throws(() => engine.status('other', {id}), /not found/);
  t.diagnostic(JSON.stringify({sites: 250, pages: requests.length, peakConcurrentRequests: peak, peakPerOrigin: originPeak, retainedBytes: result.retainedBytes, elapsedMs: Math.round(performance.now() - startedAt)}));
});

test('scheduler is fair across origins and jobs, and enforces process concurrency across engines', async t => {
  let active = 0, peak = 0; const origins = new Map(), requests = [];
  const reader = async (url, {signal}) => {
    const origin = new URL(url).origin; active++; peak = Math.max(peak, active); origins.set(origin, (origins.get(origin) ?? 0) + 1);
    assert.ok(origins.get(origin) <= 2); requests.push(url);
    try { await delay(5, undefined, {signal}); return response(url, '<p>content</p>'); }
    finally { active--; origins.set(origin, origins.get(origin) - 1); }
  };
  const engines = Array.from({length: 3}, () => engineFixture(t, reader, {maxActive: 32}));
  const same = Array.from({length: 20}, (_, index) => `https://same.example/${index}`);
  const jobs = engines.map((engine, index) => engine.start(`owner${index}`, {urls: [...same, ...Array.from({length: 30}, (_, site) => `https://e${index}s${site}.example/`)], maxDepth: 0, concurrency: 16}));
  const results = await Promise.all(engines.map((engine, index) => settled(engine, `owner${index}`, jobs[index].id)));
  assert.ok(results.every(result => result.counts.completed === 50)); assert.ok(peak > 16 && peak <= 32);
  assert.ok(requests.slice(0, 10).some(url => !url.startsWith('https://same.example/')));
  t.diagnostic(JSON.stringify({jobs: 3, pages: requests.length, processPeakConcurrency: peak}));
});

test('job cancellation, owner closure and engine closure abort active reads and discard frontier', async t => {
  let started = 0, aborted = 0;
  const engine = engineFixture(t, async (url, {signal}) => {
    started++;
    try { await delay(1000, undefined, {signal}); return response(url, 'unexpected'); }
    catch (error) { aborted++; throw error; }
  });
  const urls = Array.from({length: 80}, (_, index) => `https://s${index}.example/`);
  const first = engine.start('a', {urls, concurrency: 8}), second = engine.start('b', {urls, concurrency: 8});
  await delay(5); engine.cancelOwner('a');
  const stopped = await settled(engine, 'a', first.id);
  assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.counts.queued, 0); assert.equal(stopped.counts.active, 0);
  assert.equal(engine.status('b', {id: second.id}).state, 'running');
  engine.cancel('b', second.id); await settled(engine, 'b', second.id);
  const third = engine.start('c', {urls}); await delay(5); engine.close(); await delay(5);
  assert.ok(aborted > 0); assert.equal(aborted, started);
  assert.throws(() => engine.start('c', {urls}), /closed/); assert.throws(() => engine.status('c', {id: third.id}), /not found/);
  t.diagnostic(JSON.stringify({started, aborted}));
});

test('depth/page budgets, redirect scope, failures and JavaScript browser handoff remain explicit', async t => {
  const requests = [];
  const engine = engineFixture(t, async url => {
    requests.push(url);
    if (url.endsWith('/redirect')) return response('https://outside.example/', 'outside');
    if (url.endsWith('/error')) throw Object.assign(Error('Rate limited'), {code: 'RATE_LIMITED', retryAfterMs: 1000});
    return response(url, '<title>App</title><div id="app"></div><script src="app.js"></script><a href="/detail">Real detail</a><a href="/other">Other</a>');
  });
  const zero = engine.start('a', {urls: ['https://seed.example/'], maxDepth: 0});
  assert.equal((await settled(engine, 'a', zero.id)).counts.failed, 1);
  const bounded = engine.start('a', {urls: ['https://seed.example/'], maxPages: 2, maxDepth: 10});
  assert.equal((await settled(engine, 'a', bounded.id)).counts.failed, 2);
  const bad = engine.start('a', {urls: ['https://seed.example/redirect', 'https://seed.example/error'], maxDepth: 0});
  const failures = await settled(engine, 'a', bad.id);
  assert.equal(failures.counts.failed, 2); assert.deepEqual(new Set(failures.pages.map(page => page.code)), new Set(['URL_BLOCKED', 'RATE_LIMITED']));
  const scrape = await engine.scrape('a', {url: 'https://seed.example/'});
  assert.equal(scrape.state, 'completed'); assert.equal(scrape.page.browserHandoff.url, 'https://seed.example/'); assert.equal(scrape.page.links[0].url, 'https://seed.example/detail');
  assert.equal(scrape.page.code, 'BROWSER_REQUIRED');
});

test('plain text is readable; HTML errors, login gates and binary files retain sources without successful coverage', async t => {
  const engine = engineFixture(t, async url => {
    if (url.endsWith('/plain')) return response(url, 'Useful plain text', {contentType: 'text/plain; charset=utf-8'});
    if (url.endsWith('/file')) return response(url, '%PDF-binary', {contentType: 'application/pdf'});
    if (url.endsWith('/login')) return response(url, '<title>Sign in</title><form><input type=password><p>Sign in to read this page</form>');
    return response(url, '<title>Missing &amp; unavailable</title><p>Partial useful text<a href="/help">Help', {status: url.endsWith('/404') ? 404 : 500});
  });
  const {id} = engine.start('a', {urls: ['plain', 'file', 'login', '404', '500'].map(path => `https://seed.example/${path}`), maxDepth: 0});
  const result = await settled(engine, 'a', id);
  assert.equal(result.counts.completed, 1); assert.equal(result.counts.failed, 4);
  assert.deepEqual(new Set(result.pages.filter(page => page.code).map(page => page.code)), new Set(['UNSUPPORTED_CONTENT', 'BROWSER_REQUIRED', 'HTTP_404', 'HTTP_500']));
  const missing = engine.page('a', {id, pageId: result.pages.find(page => page.status === 404).id});
  assert.match(missing.text, /Partial useful text/); assert.equal(missing.title, 'Missing & unavailable'); assert.equal(missing.links[0].url, 'https://seed.example/help');
  assert.equal(missing.browserHandoff.url, missing.url); assert.equal(missing.requestedUrl, missing.url);
  assert.equal(result.pages.find(page => page.url.endsWith('/plain')).excerpt, 'Useful plain text');
});

test('single scrape permits guarded canonical public redirects while discovery crawls keep exact origins', async t => {
  const engine = engineFixture(t, async (url, {allowedOrigins}) => {
    if (allowedOrigins) assert.deepEqual([...allowedOrigins], ['http://seed.example']);
    return response('https://www.seed.example/final', '<title>Final article</title><p>Readable final content</p>');
  });
  const scrape = await engine.scrape('a', {url: 'http://seed.example/start'});
  assert.equal(scrape.page.requestedUrl, 'http://seed.example/start'); assert.equal(scrape.page.url, 'https://www.seed.example/final'); assert.equal(scrape.page.title, 'Final article');
  const {id} = engine.start('a', {urls: ['http://seed.example/start'], maxDepth: 0});
  const crawl = await settled(engine, 'a', id); assert.equal(crawl.counts.failed, 1); assert.equal(crawl.pages[0].code, 'URL_BLOCKED');
});

test('large batches keep searchable evidence from late pages and single reads can find a passage beyond the first excerpt', async t => {
  const phrase = 'gzip.decompress(data)';
  const engine = engineFixture(t, async url => response(url, `<main><p>Source ${url}: ${'α'.repeat(12500)}</p><p>${phrase} Returns bytes. ${phrase} Second occurrence.</p></main>`));
  const urls = Array.from({length: 250}, (_, index) => `https://site${index}.example/manual`);
  const {id} = engine.start('owner', {urls, maxDepth: 0, concurrency: 16});
  const batch = await settled(engine, 'owner', id);
  assert.equal(batch.counts.completed, 250); assert.equal(batch.counts.droppedPages, 0);
  const last = engine.status('owner', {id, offset: 249});
  assert.equal(last.pages.length, 1); assert.ok(last.pages[0].textLength > 1000); assert.ok(last.pages[0].contentTruncated);
  assert.ok(batch.retainedBytes <= 4 * 1024 * 1024);
  const single = await engine.scrape('owner', {url: urls[0]});
  assert.doesNotMatch(single.page.text, /Returns bytes/);
  assert.equal(single.page.hasMoreText, true);
  assert.equal(single.continueWith.arguments.offset, single.page.nextOffset);
  const continuation = engine.page('owner', {id: single.id, pageId: single.page.id, limit: 6000});
  assert.equal(continuation.offset, single.page.nextOffset); assert.match(continuation.text, /Returns bytes/); assert.equal(continuation.hasMoreText, false);
  assert.equal(engine.page('owner', {id: single.id, pageId: single.page.id, limit: 100}).text, '');
  assert.match(engine.page('owner', {id: single.id, pageId: single.page.id, offset: 0, limit: 100}).text, /Source/);
  const loc = {id: single.id, pageId: single.page.id, find: phrase.toUpperCase(), limit: 100, linkLimit: 0};
  const match = engine.page('owner', loc);
  assert.ok(match.matchOffset > 8000); assert.match(match.text, /gzip\.decompress\(data\) Returns bytes/); assert.deepEqual(match.links, []);
  const later = engine.page('owner', {...loc, offset: match.matchOffset + phrase.length});
  assert.ok(later.matchOffset > match.matchOffset); assert.match(later.text,/Second occurrence/);
  const missing = engine.page('owner', {...loc, find: 'absent [phrase]'});
  assert.equal(missing.matchOffset, null); assert.equal(missing.text, '');
});

test('extraction bounds text and retained unique links even for a large link flood', () => {
  const content = extractContent(response('https://seed.example/', Array.from({length: 10000}, (_, index) => `<a href="/${index}">Link ${index}</a>`).join('')), {maxLinks: 3, maxTextChars: 20});
  assert.equal(content.links.length, 3); assert.equal(content.linksTruncated, true); assert.ok(content.text.length <= 20); assert.equal(content.textTruncated, true);
});

test('bounded retention preserves completion counters, supports stable raw cursors and evicts old jobs', async t => {
  const engine = engineFixture(t, async url => response(url, `<title>Bounded</title><p>${'x'.repeat(10000)}</p><a href="/next">Next</a>`), {maxJobBytes: 2400, maxRetainedBytes: 4000, maxCompleted: 2});
  const urls = Array.from({length: 15}, (_, index) => `https://seed.example/${index}`);
  const first = engine.start('a', {urls, maxDepth: 0});
  const result = await settled(engine, 'a', first.id);
  assert.equal(result.counts.completed, 15); assert.ok(result.retainedBytes <= 2400); assert.ok(result.counts.droppedPages > 0);
  assert.ok(result.pages.every(page => page.contentTruncated));
  const cursor = engine.status('a', {id: first.id, limit: 1});
  const next = engine.status('a', {id: first.id, offset: cursor.nextOffset, limit: 1});
  assert.notEqual(cursor.pages[0]?.id, next.pages[0]?.id);
  await engine.scrape('a', {url: 'https://seed.example/second'}); await engine.scrape('a', {url: 'https://seed.example/third'});
  assert.throws(() => engine.status('a', {id: first.id}), /not found/);
});

test('admission and readback bounds reject invalid input, honor caller signal and cap total jobs', async t => {
  const engine = engineFixture(t, async url => response(url, '<p>ok</p>'), {maxJobs: 1});
  assert.throws(() => engine.start('a', {urls: ['file:///secret']}), /Invalid/);
  assert.throws(() => engine.start('a', {urls: ['https://a.example/'], maxPages: 5001}), /maxPages/);
  assert.throws(() => engine.start('a', {urls: Array(1001).fill('https://a.example/')}), /1000/);
  const controller = new AbortController(); controller.abort();
  const cancelled = engine.start('a', {urls: ['https://a.example/'], signal: controller.signal}); assert.equal(cancelled.state, 'cancelled');
  const {id} = engine.start('a', {urls: ['https://a.example/']});
  assert.throws(() => engine.start('a', {urls: ['https://b.example/']}), /budget exhausted/);
  const result = await settled(engine, 'a', id);
  assert.throws(() => engine.status('a', {id, limit: 51}), /limit/); assert.throws(() => engine.status('a', {id, query: 'x'.repeat(201)}), /query/);
  assert.throws(() => engine.page('a', {id, pageId: result.pages[0].id, limit: 20001}), /limit/);
});

test('process frontier reservations and job admission budgets apply across independent engines', async t => {
  const read = async (url, {signal}) => { await delay(1000, undefined, {signal}); return response(url, '<p>ok</p>'); };
  const first = engineFixture(t, read), second = engineFixture(t, read);
  for (let index = 0; index < 10; index++) first.start('a', {urls: [`https://s${index}.example/`], maxPages: 5000});
  assert.throws(() => second.start('b', {urls: ['https://last.example/'], maxPages: 1}), /budget exhausted/);
  first.close();
  const engines = [second, ...Array.from({length: 4}, () => engineFixture(t, read))];
  for (let index = 0; index < 64; index++) engines[Math.floor(index / 16)].start('a', {urls: [`https://s${index}.example/`], maxPages: 1});
  assert.throws(() => engines[4].start('b', {urls: ['https://last.example/'], maxPages: 1}), /budget exhausted/);
  for (const engine of engines) engine.close();
  await delay(1);
});
