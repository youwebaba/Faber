import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { createWebReader, isPublicAddress, validateWebUrl, retryAfterMs } from '../tools/web-crawler/network.mjs';
import { parseRobots, robotsAllows } from '../tools/web-crawler/robots.mjs';

const publicIp = { address: '93.184.216.34', family: 4 };
function fixture(routes, options = {}) {
  const calls = [];
  const reader = createWebReader({ ...options, lookup: options.lookup ?? (async () => [publicIp]), request(url, opts, callback) {
    assert.equal(opts.method, 'GET');
    assert.equal(opts.agent, false);
    assert.equal(opts.rejectUnauthorized, true);
    assert.equal(opts.headers['User-Agent'], 'FaberCrawler/1.0');
    assert.equal(opts.headers.Cookie, undefined);
    assert.equal(opts.headers.Authorization, undefined);
    opts.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, publicIp.address); assert.equal(family, 4);
    });
    calls.push(url.href);
    const req = new EventEmitter();
    let response;
    req.destroy = () => response?.destroy();
    req.end = () => queueMicrotask(() => {
      if (opts.signal.aborted) { req.emit('error', opts.signal.reason); return; }
      const found = typeof routes === 'function' ? routes(url, opts) : routes[url.href] ?? routes[url.pathname];
      const route = found ?? (url.pathname === '/robots.txt' ? { status: 404 } : { body: 'hello' });
      response = route.stream ?? Readable.from([Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body ?? '')]);
      response.statusCode = route.status ?? 200;
      response.headers = route.headers ?? { 'content-type': 'text/html; charset=utf-8' };
      const abort = () => { response.destroy(opts.signal.reason); req.emit('error', opts.signal.reason); };
      opts.signal.addEventListener('abort', abort, { once: true });
      response.once('close', () => opts.signal.removeEventListener('abort', abort));
      callback(response);
    });
    return req;
  } });
  return { reader, calls };
}

test('public-only addresses reject private, reserved, mapped and transition networks', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.0.0.9', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', 'fc00::1', 'fe80::1', 'ff00::1',
    '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1', '3ffe::1', 'fe80::1%lo']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

test('URL validation blocks credentials, alternate IP notation, local names, ports and scope escape', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com', 'https://name:pass@example.com', 'http://127.1',
    'http://2130706433', 'http://0x7f000001', 'http://[::ffff:127.0.0.1]', 'http://localhost', 'https://x.local',
    'http://printer', 'https://example.com:22', 'http://example.com:443', 'https://example.com:80']) assert.throws(() => validateWebUrl(url), { code: 'URL_BLOCKED' }, url);
  assert.throws(() => validateWebUrl('https://other.com', new Set(['https://example.com'])), { code: 'URL_BLOCKED' });
  assert.equal(validateWebUrl('https://example.com:443/a#b').href, 'https://example.com/a');
});

test('robots merges exact user agent groups, longest match and allow tie with wildcard/end/encoding', () => {
  const rules = parseRobots('Disallow: /ignored\nUser-agent: *\nDisallow: /\nUser-agent: FaberCrawler\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nDisallow: /caf%C3%A9\nDisallow: /%62locked\nUser-agent: fabercrawler\nAllow: /same\nDisallow: /same');
  for (const path of ['/private', '/private/x', '/a.pdf', '/caf%C3%A9', '/café', '/blocked']) assert.equal(robotsAllows(rules, `https://example.com${path}`), false, path);
  for (const path of ['/', '/private/public/a', '/a.pdf?download', '/same', '/ignored', '/robots.txt']) assert.equal(robotsAllows(rules, `https://example.com${path}`), true, path);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /'), 'https://example.com/x'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: Other\nDisallow: /'), 'https://example.com/x'), true);
  const literalSpecial = parseRobots('User-agent: *\nDisallow: /file%2A\nDisallow: /price%24');
  assert.equal(robotsAllows(literalSpecial, 'https://example.com/file*'), false);
  assert.equal(robotsAllows(literalSpecial, 'https://example.com/price$'), false);
});

test('reader caches and coalesces robots for concurrent pages and returns bounded UTF8 body bytes', async t => {
  const { reader, calls } = fixture({ '/robots.txt': { body: 'User-agent: *\nDisallow: /private\nAllow: /private/public' } });
  t.after(() => reader.close());
  const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => reader.read(`https://example.com/page${i}`)));
  assert.equal(calls.filter(url => url.endsWith('/robots.txt')).length, 1);
  assert.equal(responses[0].body.toString('utf8'), 'hello');
  assert.equal(responses[0].bytes, 5);
  assert.equal(responses[0].url, 'https://example.com/page0');
  assert.ok(Number.isFinite(Date.parse(responses[0].retrievedAt)));
  await assert.rejects(reader.read('https://example.com/private'), { code: 'ROBOTS_DENIED' });
  assert.equal(calls.some(url => url.endsWith('/private')), false);
  await reader.read('https://example.com/private/public');
});

test('revalidates every DNS result and redirect; cannot rebind or escape allowed origins', async t => {
  let lookups = 0;
  const { reader, calls } = fixture({ '/start': { status: 302, headers: { location: '/next' } } }, {
    lookup: async () => ++lookups === 3 ? [{ address: '127.0.0.1', family: 4 }] : [publicIp]
  });
  t.after(() => reader.close());
  await assert.rejects(reader.read('https://example.com/start'), { code: 'URL_BLOCKED' });
  assert.equal(calls.length, 2);
  for (const location of ['http://127.0.0.1/x', 'https://other.com/x', 'http://example.com/x']) {
    const f = fixture({ '/start': { status: 302, headers: { location } } });
    t.after(() => f.reader.close());
    await assert.rejects(f.reader.read('https://example.com/start', { allowedOrigins: new Set(['https://example.com']) }), { code: 'URL_BLOCKED' });
    assert.equal(f.calls.length, 2);
  }
  const mixed = fixture({}, { lookup: async () => [publicIp, { address: '10.0.0.1', family: 4 }] });
  t.after(() => mixed.reader.close());
  await assert.rejects(mixed.reader.read('https://example.com'), { code: 'ROBOTS_UNAVAILABLE' });
  assert.equal(mixed.calls.length, 0);
});

test('page redirects check destination robots while robots redirects remain public-only', async t => {
  const f = fixture({ '/start': { status: 302, headers: { location: 'https://other.com/private' } },
    'https://other.com/robots.txt': { body: 'User-agent: *\nDisallow: /private' } });
  t.after(() => f.reader.close());
  await assert.rejects(f.reader.read('https://example.com/start'), { code: 'ROBOTS_DENIED' });
  assert.equal(f.calls.includes('https://other.com/private'), false);
  const robotsRedirect = fixture({ '/robots.txt': { status: 302, headers: { location: 'http://169.254.169.254/robots.txt' } } });
  t.after(() => robotsRedirect.reader.close());
  await assert.rejects(robotsRedirect.reader.read('https://example.com/start'), { code: 'ROBOTS_UNAVAILABLE' });
  assert.equal(robotsRedirect.calls.length, 1);
});

test('robots 5xx/network errors fail closed and are briefly cached; unavailable 4xx allow', async t => {
  for (const status of [500, 503]) {
    const f = fixture({ '/robots.txt': { status } });
    t.after(() => f.reader.close());
    await assert.rejects(f.reader.read('https://example.com/a'), { code: 'ROBOTS_UNAVAILABLE' });
    await assert.rejects(f.reader.read('https://example.com/b'), { code: 'ROBOTS_UNAVAILABLE' });
    assert.equal(f.calls.length, 1);
  }
  const unavailable = fixture({ '/robots.txt': { status: 404 } });
  t.after(() => unavailable.reader.close());
  assert.equal((await unavailable.reader.read('https://example.com/a')).status, 200);
});

test('429 and Retry-After prevent repeat requests, including robots 429', async t => {
  for (const pathname of ['/robots.txt', '/a']) {
    const f = fixture({ [pathname]: { status: 429, headers: { 'retry-after': '120' } } });
    t.after(() => f.reader.close());
    await assert.rejects(f.reader.read('https://example.com/a'), error => error.code === 'RATE_LIMITED' && error.retryAfterMs === 120_000);
    const count = f.calls.length;
    await assert.rejects(f.reader.read('https://example.com/b'), error => error.code === 'RATE_LIMITED' && error.retryAfterMs > 0);
    assert.equal(f.calls.length, count);
  }
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')), 60_000);
  assert.equal(retryAfterMs('bad'), 60_000);
});

test('encoded and decoded response limits stop gzip/brotli bombs and oversized plain bodies', async t => {
  for (const encoding of ['identity', 'gzip', 'br']) {
    const body = Buffer.alloc(5000, 'a');
    const encoded = encoding === 'gzip' ? gzipSync(body) : encoding === 'br' ? brotliCompressSync(body) : body;
    const f = fixture({ '/a': { body: encoded, headers: { 'content-encoding': encoding } } }, { maxBytes: 1024 });
    t.after(() => f.reader.close());
    await assert.rejects(f.reader.read('https://example.com/a'), { code: 'TOO_LARGE' });
  }
  const f = fixture({ '/a': { body: gzipSync('hello'), headers: { 'content-encoding': 'gzip' } } });
  t.after(() => f.reader.close());
  assert.equal((await f.reader.read('https://example.com/a')).body.toString(), 'hello');
});

test('deadline covers DNS and cancellation interrupts body; close rejects future reads', async t => {
  const dns = createWebReader({ timeoutMs: 20, lookup: () => new Promise(() => {}) });
  t.after(() => dns.close());
  await assert.rejects(dns.read('https://example.com/a'), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const f = fixture({ '/a': { stream: new Readable({ read() { this.push('part'); this._read = () => {}; } }) } });
  t.after(() => f.reader.close());
  const result = f.reader.read('https://example.com/a', { signal: controller.signal });
  setTimeout(() => controller.abort(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })), 20);
  await assert.rejects(result, { code: 'ABORT_ERR' });
  f.reader.close();
  await assert.rejects(f.reader.read('https://example.com/a'), { code: 'READER_CLOSED' });
});

test('cancelled robots readers release the shared request; precancelled reads issue no request', async t => {
  const stream = new Readable({ read() {} });
  const f = fixture({ '/robots.txt': { stream } });
  t.after(() => f.reader.close());
  const controller = new AbortController();
  const reading = f.reader.read('https://example.com/a', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.destroyed, true);
  const before = f.calls.length;
  await assert.rejects(f.reader.read('https://example.com/b', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, before);
});

test('one cancelled waiter does not cancel robots for another reader', async t => {
  const stream = new Readable({ read() {} });
  const f = fixture({ '/robots.txt': { stream } });
  t.after(() => f.reader.close());
  const controller = new AbortController();
  const cancelled = f.reader.read('https://example.com/a', { signal: controller.signal });
  const active = f.reader.read('https://example.com/b');
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(stream.destroyed, false);
  stream.push('User-agent: *\nAllow: /'); stream.push(null);
  assert.equal((await active).body.toString(), 'hello');
  assert.equal(f.calls.filter(url => url.endsWith('/robots.txt')).length, 1);
});

test('redirect loops and oversized declared content are bounded; robots cache evicts old origins', async t => {
  const loop = fixture({ '/a': { status: 302, headers: { location: '/a' } } }, { maxRedirects: 2 });
  t.after(() => loop.reader.close());
  await assert.rejects(loop.reader.read('https://example.com/a'), { code: 'REDIRECT_LIMIT' });
  assert.equal(loop.calls.filter(url => url.endsWith('/a')).length, 3);
  const large = fixture({ '/a': { headers: { 'content-length': '10000' } } }, { maxBytes: 1024 });
  t.after(() => large.reader.close());
  await assert.rejects(large.reader.read('https://example.com/a'), { code: 'TOO_LARGE' });
  const cache = fixture({}, { maxRobotsEntries: 1 });
  t.after(() => cache.reader.close());
  for (const host of ['example.com', 'example.org', 'example.com']) await cache.reader.read(`https://${host}/a`);
  assert.equal(cache.calls.filter(url => url.endsWith('/robots.txt')).length, 3);
});

test('pathological robots wildcard work fails closed', () => {
  const rules = parseRobots(`User-agent: *\nDisallow: /*${'a'.repeat(4000)}b`);
  assert.throws(() => robotsAllows(rules, `https://example.com/${'a'.repeat(8000)}`), { code: 'ROBOTS_UNAVAILABLE' });
});

test('live public HTTPS read uses the guarded production transport', {
  skip: process.env.FABER_CRAWLER_LIVE_NETWORK !== '1'
}, async t => {
  const reader = createWebReader({ timeoutMs: 10_000 });
  t.after(() => reader.close());
  const response = await reader.read('https://example.com/', { allowedOrigins: new Set(['https://example.com']) });
  assert.equal(response.status, 200);
  assert.match(response.body.toString('utf8'), /Example Domain/i);
});
