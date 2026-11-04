import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRichContent, renderOutputImages, safeContentLink, safeOutputImage } from '../renderer/rich-content.mjs';
import { MAX_IMAGE_BYTES } from '../renderer/chat-media.mjs';

// This deliberately has no HTML parser. Any accidental raw-HTML rendering fails.
class Element {
  constructor(tag = null, text = '') { this.tag = tag; this.value = text; this.children = []; this.style = {}; this.attributes = {}; this.events = {}; this.className = ''; this.classList = { add: name => { this.className += ` ${name}`; } }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  set textContent(value) { this.children = []; this.value = String(value); }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Unsafe HTML sink used'); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.events[name] = listener; }
}
const document = { createElement: tag => new Element(tag), createTextNode: text => new Element(null, text) };
const all = (root, tag) => [root, ...root.children.flatMap(child => all(child, null))].filter(node => !tag || node.tag === tag);
const render = text => renderRichContent(text, { document });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
const data = (format, bytes) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`;

test('rich replies render emphasis, indentation, ordered and task lists, tables, headings, and literal code', () => {
  const source = '# Results\n\n**Strong** *italic* ~~removed~~ <u>underline</u>\n\n> Indented\n\n3. Third\n4. Fourth\n   - Nested\n\n- [x] Finished\n- [ ] Remaining\n\n| Name | Count |\n| :--- | ---: |\n| A | **2** |\n\n`<b>literal</b>`\n\n```html\n<script>alert(1)</script>\n```';
  const root = render(source);
  for (const tag of ['h1', 'strong', 'em', 'del', 'u', 'blockquote', 'ol', 'ul', 'table', 'pre']) assert.ok(all(root, tag).length, tag);
  assert.equal(all(root, 'ol')[0].start, 3);
  assert.deepEqual(all(root, 'input').map(node => [node.type, node.checked, node.disabled]), [['checkbox', true, true], ['checkbox', false, true]]);
  assert.equal(all(root, 'td').at(-1).className, 'align-right');
  assert.deepEqual(all(root, 'code').map(node => node.textContent), ['<b>literal</b>', '<script>alert(1)</script>']);
  assert.equal(all(root, 'script').length, 0);
  assert.equal(source.startsWith('# Results\n\n**Strong**'), true, 'Rendering never mutates the raw copy source');
});

test('HTML is literal except exact emphasis tags and single allowlisted color declarations', () => {
  const root = render('<span style="color: #ff6600">Orange **bold**</span> <font color="red">Red</font> <u>Under</u>');
  assert.deepEqual(all(root, 'span').map(node => node.style.color), ['#ff6600', 'red']);
  assert.equal(all(root, 'u')[0].textContent, 'Under');
  for (const source of [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>x</svg>',
    '<iframe src="https://example.com">x</iframe>', '<a href="javascript:alert(1)">x</a>',
    '<span style="color: red; background: url(https://example.com/a)">x</span>',
    '<span style="color: expression(alert(1))">x</span>', '<span style="color: transparent">x</span>',
    '<span style="color:red" onclick="alert(1)">x</span>', '<u onclick="alert(1)">x</u>',
  ]) {
    const result = render(source);
    assert.equal(result.textContent, source);
    for (const tag of ['script', 'img', 'svg', 'iframe', 'a', 'span', 'u']) assert.equal(all(result, tag).length, 0, source);
  }
  assert.equal(render('&lt;script&gt; &#x41; &amp;').textContent, '<script> A &');
});

test('links accept HTTP(S) only, have no automatic navigation, and preserve query entities', () => {
  const bad = ['javascript:alert(1)', 'data:text/html,a', 'file:///C:/secret', '//example.com', 'https://user:pass@example.com', 'http://exa\nmple.com', 'https://example.com/a b', 'http://'];
  for (const href of bad) assert.equal(safeContentLink(href), null, href);
  assert.equal(safeContentLink('https://example.com/?a=1&amp;b=2'), 'https://example.com/?a=1&b=2');
  let opened, prevented = false;
  const root = renderRichContent('[Read](https://example.com/) [unsafe](javascript:alert%281%29)', { document, onOpenLink: href => { opened = href; } });
  const anchors = all(root, 'a'); assert.equal(anchors.length, 1); assert.equal(opened, undefined);
  anchors[0].events.click({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(opened, 'https://example.com/');
  assert.equal(root.textContent, 'Read unsafe');
});

test('incomplete streaming markup remains safe and can be replaced with a complete rendering', () => {
  for (const source of ['**working', '[link](java', '<span style="color:', '```js\nconst n = "<img onerror=x>";', '<u>starting']) {
    const result = render(source);
    assert.equal(all(result, 'script').length + all(result, 'img').length, 0);
    assert.ok(result.textContent.length > 0);
  }
  const complete = render('**working now**'); assert.equal(all(complete, 'strong')[0].textContent, 'working now');
  const large = '**a**'.repeat(40001); const result = render(large);
  assert.equal(result.textContent, large); assert.ok(result.className.includes('rich-content-plain'));
  const deep = '> '.repeat(40) + 'nested'; assert.equal(render(deep).textContent, deep);
});

test('raster output validates MIME, magic bytes, canonical base64, encoded size, and count', () => {
  const jpeg = data('jpeg', [255, 216, 255, 224]);
  const webp = data('webp', 'RIFF1234WEBP');
  for (const image of [png, jpeg, webp]) assert.equal(safeOutputImage(image), image);
  for (const image of [null, '', 'https://example.com/a.png', 'file:///C:/a.png', data('svg+xml', '<svg/>'), data('png', '<svg onload="x"/>'), jpeg.replace('jpeg', 'png'), png + '\n', png.replace(/=$/, ''), 'data:image/jpeg;base64,/9j/4B==', 'data:image/png;base64,' + 'A'.repeat(MAX_IMAGE_BYTES)]) assert.equal(safeOutputImage(image), null);
  const output = renderOutputImages([png, png, jpeg, webp, 'https://example.com/tracker.png'], { document });
  assert.equal(all(output, 'img').length, 3);
  assert.deepEqual(all(output, 'img').map(node => node.alt), ['Image output 1', 'Image output 2', 'Image output 3']);
  assert.equal(all(renderOutputImages(Array.from({ length: 10 }, (_, i) => data('jpeg', [255, 216, 255, i])), { document }), 'img').length, 8);
  const bytes = Buffer.alloc(3 * 1024 * 1024); bytes.set([255, 216, 255]);
  const one = data('jpeg', bytes); bytes[3] = 1; const two = data('jpeg', bytes);
  assert.equal(all(renderOutputImages([one, two], { document }), 'img').length, 1, 'The encoded aggregate is bounded');
});

test('Markdown images only render validated embedded raster data and never fetch URLs automatically', () => {
  const root = render(`![plot](${png}) ![Remote plot](https://example.com/a.png) ![No](file:///C:/secret.png)`);
  assert.equal(all(root, 'img').length, 1); assert.equal(all(root, 'img')[0].src, png);
  assert.equal(all(root, 'a').length, 1); assert.equal(all(root, 'a')[0].textContent, 'Image: Remote plot');
  assert.ok(root.textContent.endsWith('Image: No'));
});
