import html from '../vendor/web-html.cjs';

export function normalizeWebUrl(input, base) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

const ignored = new Set(['script', 'style', 'template', 'noscript', 'svg', 'canvas', 'iframe', 'object']);
const blocks = new Set(['p', 'div', 'br', 'hr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'tr', 'td', 'main', 'nav', 'blockquote', 'pre']);
const clean = text => text.replace(/[\t\r\f ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const charsetOf = value => /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(value)?.slice(1).find(Boolean);

function decode(body, contentType) {
  if (!Buffer.isBuffer(body)) return String(body ?? '');
  let charset = charsetOf(contentType);
  if (!charset && /^(text\/html|application\/xhtml\+xml)(;|$)/i.test(contentType)) {
    // Prescan only the bounded HTML encoding prefix; parsing keeps script/comment lookalikes inert.
    const stack = [html.parse(body.subarray(0, 1024).toString('latin1'))];
    while (stack.length && !charset) {
      const node = stack.pop();
      if (node.tagName === 'meta') {
        const attrs = Object.fromEntries((node.attrs ?? []).map(({name, value}) => [name, value]));
        charset = attrs.charset || (attrs['http-equiv']?.toLowerCase() === 'content-type' && charsetOf(attrs.content ?? ''));
      }
      const children = node.childNodes ?? [];
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }
  }
  try { return new TextDecoder(charset || 'utf-8').decode(body); }
  catch { return new TextDecoder('utf-8').decode(body); }
}

// HTML is parsed as inert data. No DOM, scripts, subresources or browser session are created.
export function extractContent(response, {maxTextChars = 120000, maxLinks = 200} = {}) {
  if (!Number.isSafeInteger(maxTextChars) || maxTextChars < 0 || maxTextChars > 120000 || !Number.isSafeInteger(maxLinks) || maxLinks < 0 || maxLinks > 1000) throw Error('Extraction limits exceed bounds');
  const {url, status, contentType = '', bytes, retrievedAt} = response;
  const source = decode(response.body, contentType);
  const result = {url, status, contentType, bytes: bytes ?? (Buffer.isBuffer(response.body) ? response.body.length : Buffer.byteLength(source)), retrievedAt, title: '', text: '', textTruncated: false, links: [], linksTruncated: false};
  if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(contentType)) {
    if (/^(text\/[^;\s]+|application\/(json|ld\+json|xml))(;|$)/i.test(contentType)) {
      result.text = source.slice(0, maxTextChars);
      result.textTruncated = source.length > maxTextChars;
    } else result.unsupportedContent = true;
    return result;
  }
  const document = html.parse(source), stack = [{node: document, hidden: false, title: false, anchor: null, linked: false, main: false, article: false, navigation: false}];
  const buckets = Object.fromEntries(['all', 'body', 'main', 'article'].map(name => [name, {parts: [], length: 0, truncated: false}]));
  function append(bucket, value) {
    const part = value.slice(0, maxTextChars - bucket.length);
    if (part) { bucket.parts.push(part); bucket.length += part.length; }
    if (value.length > part.length && value.slice(part.length).trim()) bucket.truncated = true;
  }
  let scripts = 0, password = false, substantive = false, emptyApp = false, base = url;
  const seen = new Set();
  while (stack.length) {
    const {node, hidden, title, anchor, linked, main, article, navigation} = stack.pop(), tag = node.tagName;
    if (tag === 'script') scripts++;
    const attrs = Object.fromEntries((node.attrs ?? []).map(({name, value}) => [name, value]));
    const concealed = hidden || ignored.has(tag) || Object.hasOwn(attrs, 'hidden') || attrs['aria-hidden'] === 'true' || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style ?? '');
    if (!concealed && tag === 'input' && attrs.type?.toLowerCase() === 'password') password = true;
    const role = (attrs.role ?? '').toLowerCase().split(/\s+/);
    const inMain = main || tag === 'main' || role.includes('main'), inArticle = article || tag === 'article';
    const inNavigation = navigation || ['nav', 'aside', 'footer'].includes(tag) || role.some(value => ['navigation', 'complementary', 'contentinfo'].includes(value));
    if (!concealed && /^(?:app|root|__next|__nuxt)$/i.test(attrs.id ?? '') && !(node.childNodes ?? []).some(child => child.tagName || (child.nodeName === '#text' && child.value.trim()))) emptyApp = true;
    if (tag === 'base') base = normalizeWebUrl(attrs.href, url) ?? base;
    let currentAnchor = anchor;
    if (tag === 'a' && !concealed) {
      const href = normalizeWebUrl(attrs.href, base);
      if (href && !seen.has(href)) {
        if (result.links.length < maxLinks) { seen.add(href); result.links.push(currentAnchor = {url: href, text: ''}); }
        else { result.linksTruncated = true; currentAnchor = null; }
      } else currentAnchor = null;
    }
    if (node.nodeName === '#text' && !concealed) {
      if (title) result.title = (result.title + node.value).slice(0, 500);
      else {
        append(buckets.all, node.value);
        if (!inNavigation) {
          append(buckets.body, node.value);
          if (inMain) append(buckets.main, node.value);
          if (inArticle) append(buckets.article, node.value);
          if (!linked && node.value.trim()) substantive = true;
        }
      }
      if (currentAnchor) currentAnchor.text = (currentAnchor.text + node.value).slice(0, 240);
    }
    if (blocks.has(tag) && !concealed) {
      append(buckets.all, '\n');
      if (!inNavigation) { append(buckets.body, '\n'); if (inMain) append(buckets.main, '\n'); if (inArticle) append(buckets.article, '\n'); }
    }
    const children = node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index--) stack.push({node: children[index], hidden: concealed, title: title || tag === 'title', anchor: currentAnchor, linked: linked || tag === 'a', main: inMain, article: inArticle, navigation: inNavigation});
  }
  result.title = clean(result.title);
  for (const name of ['main', 'article', 'body', 'all']) {
    const bucket = buckets[name], text = clean(bucket.parts.join(''));
    if (text || name === 'all') { result.text = text; result.textTruncated = bucket.truncated; break; }
  }
  for (const link of result.links) link.text = clean(link.text);
  const gate = /(?:^|\n)\s*(?:please enable javascript|(?:you (?:need|must) to )?enable javascript to (?:continue|access|view|use|run)|javascript (?:is required|disabled)|checking your browser|verify you are human|loading[.\u2026\s]*$)/i.test(result.text);
  if ((password && result.text.length < 1000) || (scripts && ((!substantive && (emptyApp || !result.text)) || gate))) {
    result.browserHandoff = {url, reason: 'This page may require JavaScript or browser verification. Open this URL in Faber browser.'};
  }
  return result;
}
