import {randomUUID} from 'node:crypto';
import {extractContent, normalizeWebUrl} from './content.mjs';

const HARD = {active: 32, jobs: 64, reservedPages: 50000, retainedBytes: 32 * 1024 * 1024, engines: 16};
const shared = {engines: new Set(), active: 0, reservedPages: 0, retainedBytes: 0, origins: new Map(), cursor: 0, scheduled: false};
const integer = (value, fallback, min, max, name) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
};
const ownerKey = owner => { if (typeof owner !== 'string' || !owner || owner.length > 200) throw Error('A bounded owner ID is required'); return owner; };
const terminal = job => ['completed', 'cancelled'].includes(job.state);
const allJobs = () => [...shared.engines].flatMap(engine => [...engine.jobs.values()].map(job => ({engine, job})));

function schedule() {
  if (shared.scheduled) return;
  shared.scheduled = true;
  queueMicrotask(() => {
    shared.scheduled = false;
    let idle = 0;
    const candidates = allJobs().filter(({job}) => !terminal(job));
    while (candidates.length && shared.active < HARD.active && idle < candidates.length) {
      const {engine, job} = candidates[shared.cursor++ % candidates.length];
      if (engine.launch(job)) idle = 0;
      else idle++;
    }
  });
}

export function createCrawlerEngine({reader, limits = {}} = {}) {
  if (!reader || typeof reader.read !== 'function') throw Error('A web reader is required');
  if (shared.engines.size >= HARD.engines) throw Error('Crawler process engine budget exhausted');
  const maxActive = integer(limits.maxActive, 16, 1, 32, 'maxActive');
  const maxJobs = integer(limits.maxJobs, 16, 1, HARD.jobs, 'maxJobs');
  const maxCompleted = integer(limits.maxCompleted, 8, 0, 32, 'maxCompleted');
  const maxJobBytes = integer(limits.maxJobBytes, 4 * 1024 * 1024, 512, HARD.retainedBytes, 'maxJobBytes');
  const maxRetainedBytes = integer(limits.maxRetainedBytes, 16 * 1024 * 1024, 512, HARD.retainedBytes, 'maxRetainedBytes');
  const completedTtlMs = integer(limits.completedTtlMs, 15 * 60 * 1000, 1, 24 * 60 * 60 * 1000, 'completedTtlMs');
  let closed = false, active = 0, retainedBytes = 0;
  const jobs = new Map();

  function remove(job) {
    if (!jobs.delete(job.id)) return;
    shared.reservedPages -= job.options.maxPages;
    shared.retainedBytes -= job.retainedBytes;
    retainedBytes -= job.retainedBytes;
  }
  function prune() {
    const completed = [...jobs.values()].filter(terminal).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
    while (completed.length && (completed.length > maxCompleted || Date.now() - Date.parse(completed[0].finishedAt) > completedTtlMs)) remove(completed.shift());
  }
  function get(owner, id) {
    ownerKey(owner); prune();
    const job = jobs.get(id);
    if (!job || job.owner !== owner) throw Error('Crawl not found');
    return job;
  }
  function finish(job) {
    if (job.active || job.queue.length || terminal(job)) return;
    job.state = job.controller.signal.aborted ? 'cancelled' : 'completed';
    job.finishedAt = new Date().toISOString();
    job.detach?.(); job.resolve(); prune();
  }
  function cancelJob(job) {
    if (terminal(job)) return;
    job.state = 'cancelling'; job.queue.length = 0;
    job.controller.abort(); finish(job); schedule();
  }
  function summary(page, query = '') {
    const {text = '', links = [], ...rest} = page;
    const found = query ? text.toLowerCase().indexOf(query) : 0;
    const start = Math.max(0, found - 70);
    return {...rest, textLength: text.length, linkCount: links.length, excerpt: text.slice(start, start + 240)};
  }
  function statusOf(job, {offset = 0, limit = 10, query = ''} = {}) {
    offset = integer(offset, 0, 0, 5000, 'offset'); limit = integer(limit, 10, 1, 50, 'limit');
    if (typeof query !== 'string' || query.length > 200) throw Error('query must be at most 200 characters');
    query = query.trim().toLowerCase();
    const pages = []; let cursor = offset;
    while (cursor < job.pages.length && pages.length < limit) {
      const page = job.pages[cursor++];
      if (!query || `${page.url}\n${page.title}\n${page.text ?? ''}`.toLowerCase().includes(query)) pages.push(summary(page, query));
    }
    return {id: job.id, state: job.state, createdAt: job.createdAt, finishedAt: job.finishedAt, options: {...job.options}, counts: {queued: job.queue.length, active: job.active, completed: job.completed, failed: job.failed, droppedPages: job.droppedPages}, retainedBytes: job.retainedBytes, pages, offset, nextOffset: cursor, hasMore: cursor < job.pages.length};
  }
  function store(job, page) {
    let size = Buffer.byteLength(JSON.stringify(page));
    // Leave room for evidence from the later sites in a large batch.
    const pagesLeft = job.options.maxPages - job.pages.length;
    const share = Math.floor((maxJobBytes - job.retainedBytes) / Math.max(1, pagesLeft));
    if (size > share && (page.text || page.links?.length)) {
      const compact = {...page, text: '', links: [], contentTruncated: true};
      const space = Math.max(0, share - Buffer.byteLength(JSON.stringify(compact)));
      let text = (page.text ?? '').slice(0, space);
      while (text && Buffer.byteLength(JSON.stringify(text)) - 2 > space) text = text.slice(0, Math.floor(text.length * 0.75));
      compact.text = text;
      let left = space - (Buffer.byteLength(JSON.stringify(text)) - 2);
      for (const link of page.links ?? []) {
        const cost = Buffer.byteLength(JSON.stringify(link)) + (compact.links.length ? 1 : 0);
        if (cost > left) break;
        compact.links.push(link); left -= cost;
      }
      page = compact; size = Buffer.byteLength(JSON.stringify(page));
    }
    if (job.retainedBytes + size > maxJobBytes || retainedBytes + size > maxRetainedBytes || shared.retainedBytes + size > HARD.retainedBytes) {
      page = {...page, text: '', links: [], contentTruncated: true};
      size = Buffer.byteLength(JSON.stringify(page));
    }
    if (job.retainedBytes + size > maxJobBytes || retainedBytes + size > maxRetainedBytes || shared.retainedBytes + size > HARD.retainedBytes) { job.droppedPages++; return; }
    job.pages.push(page); job.retainedBytes += size; retainedBytes += size; shared.retainedBytes += size;
  }
  function enqueue(job, url, depth) {
    if (job.seen.has(url) || job.aliases.has(url) || job.seen.size >= job.options.maxPages || !job.origins.has(new URL(url).origin)) return;
    job.seen.add(url); job.queue.push({url, depth});
  }
  async function run(job, item) {
    const id = String(++job.sequence);
    try {
      const response = await reader.read(item.url, {signal: job.controller.signal, allowedOrigins: job.allowRedirects ? undefined : job.origins});
      if (job.controller.signal.aborted) return;
      const finalUrl = normalizeWebUrl(response.url);
      if (!finalUrl || (!job.allowRedirects && !job.origins.has(new URL(finalUrl).origin))) throw Object.assign(Error('Redirect outside requested origins'), {code: 'URL_BLOCKED'});
      const content = extractContent({...response, url: finalUrl});
      const unreadable = response.status < 200 || response.status >= 300 ? {code: `HTTP_${response.status}`, error: `HTTP ${response.status}: page was not successfully read`} : content.unsupportedContent ? {code: 'UNSUPPORTED_CONTENT', error: 'This content type cannot be read as text'} : content.browserHandoff ? {code: 'BROWSER_REQUIRED', error: 'This page needs browser inspection'} : null;
      if (unreadable) {
        job.failed++; Object.assign(content, unreadable);
        content.browserHandoff ??= {url: finalUrl, reason: 'Open the source URL in Faber browser to inspect this response.'};
      } else job.completed++;
      job.aliases.add(finalUrl);
      if (finalUrl !== item.url) job.queue = job.queue.filter(queued => queued.url !== finalUrl);
      if (response.status >= 200 && response.status < 300 && item.depth < job.options.maxDepth) {
        for (const link of content.links) enqueue(job, link.url, item.depth + 1);
      }
      store(job, {id, requestedUrl: item.url, depth: item.depth, ...content});
    } catch (error) {
      if (!job.controller.signal.aborted) {
        job.failed++;
        store(job, {id, requestedUrl: item.url, url: item.url, depth: item.depth, title: '', error: String(error.message ?? error).slice(0, 500), code: String(error.code ?? 'FETCH_FAILED').slice(0, 80), retryAfterMs: error.retryAfterMs, text: '', links: []});
      }
    } finally {
      job.active--; active--; shared.active--;
      job.activeDepths.set(item.depth, job.activeDepths.get(item.depth) - 1);
      const origin = new URL(item.url).origin, count = shared.origins.get(origin) - 1;
      if (count) shared.origins.set(origin, count); else shared.origins.delete(origin);
      finish(job); schedule();
      if (closed && !active) { for (const entry of jobs.values()) remove(entry); shared.engines.delete(engine); }
    }
  }
  const engine = {jobs, launch(job) {
    if (closed || job.controller.signal.aborted || active >= maxActive || job.active >= job.options.concurrency || !job.queue.length) return false;
    let depth = job.queue[0].depth;
    for (const [level, count] of job.activeDepths) if (count && level < depth) depth = level;
    const index = job.queue.findIndex(item => item.depth === depth && (shared.origins.get(new URL(item.url).origin) ?? 0) < job.options.perOriginConcurrency);
    if (index < 0) return false;
    const [item] = job.queue.splice(index, 1), origin = new URL(item.url).origin;
    job.active++; active++; shared.active++;
    job.activeDepths.set(item.depth, (job.activeDepths.get(item.depth) ?? 0) + 1);
    shared.origins.set(origin, (shared.origins.get(origin) ?? 0) + 1);
    void run(job, item); return true;
  }};
  shared.engines.add(engine);

  function start(owner, {urls, maxPages, maxDepth, concurrency, perOriginConcurrency, signal} = {}, allowRedirects = false) {
    ownerKey(owner); if (closed) throw Error('Crawler is closed'); prune();
    if (!Array.isArray(urls) || !urls.length || urls.length > 1000) throw Error('urls must contain from 1 to 1000 explicit URLs');
    const seeds = [...new Set(urls.map(url => { const normalized = normalizeWebUrl(url); if (!normalized) throw Error('Invalid HTTP(S) seed URL'); return normalized; }))];
    const depth = integer(maxDepth, 1, 0, 10, 'maxDepth');
    const options = {maxPages: integer(maxPages, depth === 0 ? seeds.length : Math.max(100, seeds.length), seeds.length, 5000, 'maxPages'), maxDepth: depth, concurrency: integer(concurrency, 8, 1, 16, 'concurrency'), perOriginConcurrency: integer(perOriginConcurrency, 2, 1, 2, 'perOriginConcurrency')};
    // Completed jobs can be discarded to admit fresh work; active jobs are never displaced.
    for (const entry of allJobs().filter(({job}) => terminal(job)).sort((a, b) => a.job.finishedAt.localeCompare(b.job.finishedAt))) {
      if (jobs.size < maxJobs && allJobs().length < HARD.jobs && shared.reservedPages + options.maxPages <= HARD.reservedPages) break;
      entry.engine.remove(entry.job);
    }
    if (jobs.size >= maxJobs || allJobs().length >= HARD.jobs || shared.reservedPages + options.maxPages > HARD.reservedPages) throw Error('Crawler process/job budget exhausted; cancel or release existing work');
    const job = {id: randomUUID(), owner, options, allowRedirects, state: 'running', createdAt: new Date().toISOString(), controller: new AbortController(), origins: new Set(seeds.map(url => new URL(url).origin)), seen: new Set(), aliases: new Set(), queue: [], pages: [], readOffsets: new Map(), active: 0, activeDepths: new Map(), completed: 0, failed: 0, droppedPages: 0, sequence: 0, retainedBytes: 0};
    job.done = new Promise(resolve => { job.resolve = resolve; });
    jobs.set(job.id, job); shared.reservedPages += options.maxPages;
    for (const url of seeds) enqueue(job, url, 0);
    if (signal) {
      const abort = () => cancelJob(job);
      signal.addEventListener('abort', abort, {once: true}); job.detach = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
    schedule(); return statusOf(job);
  }
  function page(owner, {id, pageId, find, offset, limit, linkOffset, linkLimit} = {}) {
    const job = get(owner, id), record = job.pages.find(page => page.id === pageId);
    if (!record) throw Error('Crawl page not found or not retained');
    const start = offset ?? (find === undefined ? job.readOffsets.get(pageId) ?? 0 : 0);
    const view = readPage(record, {find, offset: start, limit, linkOffset, linkLimit});
    if (view.matchOffset !== null) job.readOffsets.set(pageId, view.nextOffset);
    return view;
  }
  function readPage(record, {find, offset, limit, linkOffset, linkLimit} = {}) {
    offset = integer(offset, 0, 0, 120000, 'offset'); limit = integer(limit, 8000, 1, 20000, 'limit');
    linkOffset = integer(linkOffset, 0, 0, 200, 'linkOffset'); linkLimit = integer(linkLimit, 25, 0, 50, 'linkLimit');
    const text = record.text ?? '', links = record.links ?? [];
    let matchOffset;
    if (find !== undefined) {
      if (typeof find !== 'string' || !find.trim() || find.length > 200) throw Error('find must be a nonempty phrase of at most 200 characters');
      // The regex engine preserves offsets even when Unicode case folding changes a string's length.
      const literal = new RegExp(find.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
      const match = literal.exec(text.slice(offset));
      matchOffset = match ? offset + match.index : null;
      offset = match ? Math.max(offset, matchOffset - Math.min(120, Math.floor(limit / 4))) : text.length;
    }
    const nextOffset = Math.min(text.length, offset + limit);
    return {...summary(record), ...(find !== undefined && {matchOffset}), text: text.slice(offset, nextOffset), totalTextChars: text.length, offset, nextOffset, hasMoreText: nextOffset < text.length, links: links.slice(linkOffset, linkOffset + linkLimit).map(link => ({...link})), totalLinks: links.length, linkOffset, nextLinkOffset: Math.min(links.length, linkOffset + linkLimit)};
  }
  engine.remove = remove;
  return {
    start: (owner, args) => start(owner, args),
    status: (owner, args = {}) => statusOf(get(owner, args.id), args),
    page,
    cancel(owner, id) { const job = get(owner, id); cancelJob(job); return statusOf(job); },
    cancelOwner(owner) { ownerKey(owner); for (const job of jobs.values()) if (job.owner === owner) cancelJob(job); },
    async scrape(owner, {url, signal} = {}) {
      // A single read follows public redirects validated by the reader; frontier crawls keep exact seed origins.
      const {id} = start(owner, {urls: [url], maxPages: 1, maxDepth: 0, signal}, true), job = jobs.get(id);
      await job.done;
      const view = job.pages[0] ? readPage(job.pages[0]) : null;
      if (view) job.readOffsets.set(view.id, view.nextOffset);
      return {id, state: job.state, page: view, ...(view?.hasMoreText && {continueWith: {tool: 'web_crawl_page', arguments: {id, pageId: view.id, offset: view.nextOffset}}})};
    },
    close() {
      closed = true; for (const job of jobs.values()) cancelJob(job);
      if (!active) { for (const job of jobs.values()) remove(job); shared.engines.delete(engine); }
    }
  };
}
