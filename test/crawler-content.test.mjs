import test from 'node:test';
import assert from 'node:assert/strict';
import {extractContent} from '../tools/web-crawler/content.mjs';

const response = (body, extra = {}) => ({url: 'https://docs.example/final/page', status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from(body), retrievedAt: '2026-11-12T00:00:00Z', ...extra});

test('main text gets its own budget while all visible navigation links and source metadata remain available', () => {
  const page = response(`<title>Official reference</title><nav>${'<a href="/menu">Long site navigation</a>'.repeat(1000)}</nav><main><h1>Reference</h1><p>The useful documented behavior starts here.</p><a href="../next#section">Next section</a><nav>Contents boilerplate</nav></main><footer><a href="/legal">Legal policy</a></footer>`);
  const result = extractContent(page, {maxTextChars: 100});
  assert.equal(result.text, 'Reference\nThe useful documented behavior starts here.Next section');
  assert.equal(result.textTruncated, false); assert.doesNotMatch(result.text, /navigation|boilerplate|Legal/);
  assert.equal(result.title, 'Official reference'); assert.equal(result.url, page.url); assert.equal(result.status, 200); assert.equal(result.retrievedAt, page.retrievedAt); assert.equal(result.bytes, page.body.length);
  assert.deepEqual(result.links, [{url: 'https://docs.example/menu', text: 'Long site navigation'}, {url: 'https://docs.example/next', text: 'Next section'}, {url: 'https://docs.example/legal', text: 'Legal policy'}]);
});

test('visible role main is preferred, articles are used when no main is useful, and nested articles are not duplicated', () => {
  const main = extractContent(response('<article>Unrelated teaser</article><div role="main"><article><p>Actual documentation</p></article></div>'));
  assert.equal(main.text, 'Actual documentation');
  const article = extractContent(response('<main hidden>Hidden main</main><main> </main><aside>Sidebar</aside><article><p>Article one</p><article>Nested detail</article></article><article>Article two</article>'));
  assert.equal(article.text, 'Article one\nNested detail\nArticle two');
  const body = extractContent(response('<main><nav>Empty content area</nav></main><p>Body fallback remains useful.</p>'));
  assert.equal(body.text, 'Body fallback remains useful.');
});

test('body fallback omits legal/site navigation without needing a main element', () => {
  const result = extractContent(response('<nav><a href="/privacy">Privacy policy</a><a href="/terms">Terms</a></nav><h1>Release note</h1><p>The release fixes the documented issue.</p><footer>Copyright and legal links</footer>'));
  assert.equal(result.text, 'Release note\nThe release fixes the documented issue.');
  assert.equal(result.links.length, 2); assert.equal(result.browserHandoff, undefined);
});

test('nav-only sites retain usable navigation text and links even with an analytics script', () => {
  const result = extractContent(response('<title>Directory</title><nav><a href="/one">One destination</a><a href="/two">Two destinations</a></nav><script src="analytics.js"></script>'));
  assert.equal(result.text, 'One destinationTwo destinations'); assert.equal(result.links.length, 2); assert.equal(result.browserHandoff, undefined);
});

test('short genuine content with analytics stays readable, including content that discusses JavaScript', () => {
  for (const text of ['A short genuine document.', 'How to enable JavaScript in a browser.']) {
    const result = extractContent(response(`<main><h1>Guide</h1><p>${text}</p></main><script src="analytics.js"></script>`));
    assert.equal(result.browserHandoff, undefined); assert.match(result.text, /Guide/);
  }
});

test('empty JavaScript applications and explicit verification gates retain useful browser URLs', () => {
  for (const body of ['<div id="app"></div><script src="app.js"></script><a href="/help">Help</a>', '<script src="app.js"></script>', '<main>Please enable JavaScript to continue.</main><script src="app.js"></script>', '<main>Checking your browser</main><script src="check.js"></script>']) {
    const result = extractContent(response(body)); assert.equal(result.browserHandoff?.url, 'https://docs.example/final/page');
  }
});

test('declared HTTP charsets use TextDecoder for HTML and plain text, with safe unknown-label fallback', () => {
  const html = extractContent(response(Buffer.from('<title>Caf\xe9</title><main>Price \x80</main>', 'latin1'), {contentType: 'text/html; charset="windows-1252"'}));
  assert.equal(html.title, 'Café'); assert.equal(html.text, 'Price €');
  const plain = extractContent(response(Buffer.from('Caf\xe9', 'latin1'), {contentType: 'text/plain; charset=iso-8859-1'})); assert.equal(plain.text, 'Café');
  const fallback = extractContent(response('<main>UTF-8 café</main>', {contentType: 'text/html; charset=not-a-real-encoding'})); assert.equal(fallback.text, 'UTF-8 café');
});

test('bounded meta charset prescan honors real declarations while script/comment lookalikes stay inert', () => {
  const meta = extractContent(response(Buffer.from('<meta charset=windows-1252><main>Caf\xe9</main>', 'latin1'), {contentType: 'text/html'})); assert.equal(meta.text, 'Café');
  const equiv = extractContent(response(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><main>Caf\xe9</main>', 'latin1'), {contentType: 'text/html'})); assert.equal(equiv.text, 'Café');
  const fake = extractContent(response('<script>"<meta charset=windows-1252>"</script><!-- <meta charset=windows-1252> --><main>UTF-8 café</main>', {contentType: 'text/html'})); assert.equal(fake.text, 'UTF-8 café');
});
