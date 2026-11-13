import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { parseRobots, robotsAllows } from './robots.mjs';

function failure(code, message, extra = {}) { return Object.assign(new Error(message), { code }, extra); }

function ipNumber(address) {
  if (isIP(address) === 4) return address.split('.').reduce((n, part) => n * 256n + BigInt(part), 0n);
  if (isIP(address) !== 6 || address.includes('%')) return null;
  // Mapped/embedded IPv4 cannot be a permitted global IPv6 destination.
  if (address.includes('.')) return null;
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return words.reduce((n, part) => n * 65536n + BigInt(`0x${part}`), 0n);
}
const inRange = (value, base, bits, width) => value >> BigInt(width - bits) === ipNumber(base) >> BigInt(width - bits);

// Conservative public-unicast policy based on IANA special-purpose registries.
export function isPublicAddress(address) {
  const value = ipNumber(address);
  if (value === null) return false;
  if (isIP(address) === 4) {
    return ![['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]].some(([base, bits]) => inRange(value, base, bits, 32));
  }
  return inRange(value, '2000::', 3, 128)
    && ![['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]]
      .some(([base, bits]) => inRange(value, base, bits, 128));
}

export function validateWebUrl(input, allowedOrigins) {
  let url;
  try { url = new URL(input); } catch { throw failure('URL_BLOCKED', 'Expected an absolute public HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
    || url.href.length > 8192) throw failure('URL_BLOCKED', 'Only credential-free HTTP(S) on standard ports is permitted.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(hostname) ? !isPublicAddress(hostname) : !hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|onion)$/.test(hostname)) {
    throw failure('URL_BLOCKED', 'Local, private and reserved destinations are blocked.');
  }
  if (allowedOrigins && !new Set(allowedOrigins).has(url.origin)) throw failure('URL_BLOCKED', 'URL is outside the allowed origins.');
  url.hash = '';
  return url;
}

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string') return 60_000;
  if (/^\d+$/.test(value.trim())) return Math.min(Number(value.trim()) * 1000, 2_147_483_647);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - now, 2_147_483_647)) : 60_000;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Host-only reader. read(url,{signal,allowedOrigins:Set<string>}) returns
 * {url,status,contentType,body:Buffer,bytes,retrievedAt}; bytes are decoded.
 * No cookies, credentials, custom headers, JS, browser profile or proxy support.
 * lookup/request are trusted test transports, never tool/user parameters; they
 * receive only validated public addresses. No allow-private option exists.
 */
export function createWebReader({ maxBytes = 2 * 1024 * 1024, timeoutMs = 15_000, maxRedirects = 5,
  robotsCacheMs = 3_600_000, maxRobotsEntries = 256, lookup = dnsLookup,
  request = (url, options, callback) => (url.protocol === 'https:' ? https : http).request(url, options, callback) } = {}) {
  for (const [name, value, max] of [['maxBytes', maxBytes, 16 * 1024 * 1024], ['timeoutMs', timeoutMs, 120_000],
    ['maxRedirects', maxRedirects + 1, 11], ['robotsCacheMs', robotsCacheMs, 86_400_000], ['maxRobotsEntries', maxRobotsEntries, 1024]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new TypeError(`Invalid ${name}.`);
  }
  const cache = new Map(), pending = new Map(), cooldown = new Map(), controllers = new Set();
  let closed = false;

  async function scoped(signal, action) {
    if (closed) throw failure('READER_CLOSED', 'Web reader is closed.');
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort(signal.reason ?? failure('ABORT_ERR', 'Read cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(failure('TIMEOUT', 'Web read deadline exceeded.')), timeoutMs);
    try { return await abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return action(controller.signal); }), controller.signal); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(controller); }
  }

  function checkCooldown(url) {
    const until = cooldown.get(url.origin) ?? 0;
    if (until > Date.now()) throw failure('RATE_LIMITED', 'Origin requested a retry delay.', { retryAfterMs: until - Date.now(), retryAt: new Date(until).toISOString() });
    cooldown.delete(url.origin);
  }

  async function once(url, signal, byteLimit) {
    signal.throwIfAborted();
    checkCooldown(url);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(lookup(host, { all: true, verbatim: true }), signal);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) {
      throw failure('URL_BLOCKED', 'DNS returned a private or reserved address.');
    }
    const pinned = addresses[0];
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = request(url, { method: 'GET', agent: false, signal, family: pinned.family, autoSelectFamily: false,
          lookup: (_host, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
          maxHeaderSize: 16 * 1024, rejectUnauthorized: true,
          headers: { 'User-Agent': 'FaberCrawler/1.0', Accept: 'text/html,application/xhtml+xml,text/plain,application/xml,text/xml;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br' } }, async res => {
          try {
            const status = res.statusCode;
            if (status === 429 || (status === 503 && res.headers['retry-after'])) {
              const delay = retryAfterMs(res.headers['retry-after']);
              const until = Date.now() + delay;
              if (cooldown.size >= maxRobotsEntries && !cooldown.has(url.origin)) cooldown.delete(cooldown.keys().next().value);
              cooldown.set(url.origin, until);
              res.destroy();
              throw failure('RATE_LIMITED', 'Origin requested a retry delay.', { status, retryAfterMs: delay, retryAt: new Date(until).toISOString() });
            }
            if ([301, 302, 303, 307, 308].includes(status)) {
              const location = res.headers.location;
              res.destroy();
              if (!location) throw failure('REDIRECT_INVALID', 'Redirect has no Location header.');
              resolve({ redirect: new URL(location, url), status });
              return;
            }
            const length = Number(res.headers['content-length']);
            if (Number.isFinite(length) && length > byteLimit) throw failure('TOO_LARGE', 'Response exceeds byte limit.');
            let wireBytes = 0, bytes = 0;
            const chunks = [];
            const wireBound = new Transform({ transform(chunk, _encoding, callback) {
              wireBytes += chunk.length;
              callback(wireBytes > byteLimit ? failure('TOO_LARGE', 'Encoded response exceeds byte limit.') : null, chunk);
            } });
            const encoding = (res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
            const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
              : encoding === 'br' ? createBrotliDecompress() : null;
            if (!decoder && encoding !== 'identity') throw failure('ENCODING_UNSUPPORTED', 'Unsupported response encoding.');
            const sink = new Writable({ write(chunk, _encoding, callback) {
              bytes += chunk.length;
              if (bytes > byteLimit) callback(failure('TOO_LARGE', 'Decoded response exceeds byte limit.'));
              else { chunks.push(chunk); callback(); }
            } });
            await pipeline([res, wireBound, ...(decoder ? [decoder] : []), sink], { signal });
            resolve({ url: url.href, status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), bytes, retrievedAt: new Date().toISOString() });
          } catch (error) { res.destroy(); reject(error); }
        });
        req.on('error', reject);
        req.on('upgrade', (_res, socket) => { socket.destroy(); reject(failure('PROTOCOL_BLOCKED', 'Protocol upgrades are blocked.')); });
        req.end();
      } catch (error) { req?.destroy(); reject(error); }
    });
  }

  async function loadRobots(origin, signal) {
    let current = new URL('/robots.txt', origin);
    // Cross-origin robots redirects are permitted by RFC 9309, but every target
    // receives the same public-IP/port checks; HTTPS cannot downgrade to HTTP.
    for (let hop = 0; hop <= maxRedirects; hop++) {
      validateWebUrl(current);
      const response = await once(current, signal, 512 * 1024);
      if (response.redirect) {
        if (current.protocol === 'https:' && response.redirect.protocol !== 'https:') throw failure('URL_BLOCKED', 'HTTPS downgrade blocked.');
        current = response.redirect;
        continue;
      }
      if (response.status >= 500 || response.status < 200 || (response.status >= 300 && response.status < 400)) {
        throw failure('ROBOTS_UNAVAILABLE', 'Robots policy is temporarily unavailable.');
      }
      return response.status >= 400 ? [] : parseRobots(response.body.toString('utf8'));
    }
    throw failure('ROBOTS_UNAVAILABLE', 'Robots redirect limit exceeded.');
  }

  async function robots(url, signal) {
    const entry = cache.get(url.origin);
    let result;
    if (entry && entry.until > Date.now()) result = entry;
    else {
      if (!pending.has(url.origin)) {
        if (pending.size >= maxRobotsEntries) throw failure('CAPACITY_LIMIT', 'Too many pending robots policies.');
        const shared = { controller: new AbortController(), waiters: 0 };
        const promise = scoped(shared.controller.signal, inner => loadRobots(url.origin, inner)).then(rules => ({ rules, until: Date.now() + robotsCacheMs }), error => ({
          error: error.code === 'RATE_LIMITED' ? error : failure('ROBOTS_UNAVAILABLE', 'Robots policy could not be safely retrieved.'),
          until: Date.now() + Math.max(60_000, error.retryAfterMs ?? 0)
        })).then(value => {
          if (!closed && !shared.controller.signal.aborted) {
            if (cache.size >= maxRobotsEntries && !cache.has(url.origin)) cache.delete(cache.keys().next().value);
            cache.set(url.origin, value);
          }
          return value;
        }).finally(() => { if (pending.get(url.origin) === shared) pending.delete(url.origin); });
        shared.promise = promise;
        pending.set(url.origin, shared);
      }
      const shared = pending.get(url.origin);
      shared.waiters++;
      try { result = await abortable(shared.promise, signal); }
      finally {
        shared.waiters--;
        if (!shared.waiters && pending.get(url.origin) === shared) {
          pending.delete(url.origin);
          shared.controller.abort(failure('ABORT_ERR', 'No readers remain for robots policy.'));
        }
      }
    }
    if (result.error) throw result.error;
    if (!robotsAllows(result.rules, url)) throw failure('ROBOTS_DENIED', 'robots.txt disallows this path.');
  }

  return {
    read(input, { signal, allowedOrigins } = {}) {
      return scoped(signal, async inner => {
        let current = validateWebUrl(input, allowedOrigins);
        for (let hop = 0; hop <= maxRedirects; hop++) {
          validateWebUrl(current, allowedOrigins);
          checkCooldown(current);
          await robots(current, inner);
          const response = await once(current, inner, maxBytes);
          if (!response.redirect) return response;
          if (current.protocol === 'https:' && response.redirect.protocol !== 'https:') throw failure('URL_BLOCKED', 'HTTPS downgrade blocked.');
          current = response.redirect;
        }
        throw failure('REDIRECT_LIMIT', 'Page redirect limit exceeded.');
      });
    },
    close() {
      closed = true;
      for (const controller of controllers) controller.abort(failure('ABORT_ERR', 'Web reader closed.'));
      cache.clear(); cooldown.clear();
    }
  };
}
