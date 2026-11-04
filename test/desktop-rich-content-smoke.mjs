import assert from 'node:assert/strict';

// Called by the isolated desktop smoke. Uses only in-memory text and a one-pixel
// raster fixture; no network images, account calls, clipboard, or user files.
export async function runRichContentSmoke({ window }) {
  const result = await window.webContents.executeJavaScript(`(async () => {
    const { renderRichContent, renderOutputImages } = await import('./rich-content.mjs');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
    const host = document.createElement('section'); host.dataset.richSmoke = 'true'; document.body.append(host);
    let opened;
    try {
      const content = renderRichContent('**Bold** _italic_ ~~old~~ <u>Underline</u> <span style="color: #ff6600">Orange</span>\\n\\n- First\\n- Second\\n\\n[Read](https://example.com/)\\n\\n![remote](https://example.com/tracker.png)\\n\\n<img src=x onerror="alert(1)">', { onOpenLink: href => { opened = href; } });
      host.append(content, renderOutputImages([png, 'data:image/svg+xml;base64,PHN2Zy8+']));
      const image = host.querySelector('img'); image.loading = 'eager'; await image.decode();
      const anchor = content.querySelector('a'); const event = new MouseEvent('click', { bubbles: true, cancelable: true }); anchor.dispatchEvent(event);
      const span = content.querySelector('span');
      const partial = renderRichContent('**part'); host.append(partial); partial.replaceWith(renderRichContent('**complete**'));
      return {
        bold: content.querySelector('strong')?.textContent,
        underline: getComputedStyle(content.querySelector('u')).textDecorationLine,
        color: getComputedStyle(span).color,
        listItems: content.querySelectorAll('li').length,
        literalHTML: content.textContent.includes('<img src=x onerror="alert(1)">'),
        imageCount: host.querySelectorAll('img').length,
        imageWidth: image.naturalWidth,
        imageSrc: image.getAttribute('src'),
        opened, prevented: event.defaultPrevented,
        streamComplete: host.lastElementChild.querySelector('strong')?.textContent,
        whiteSpace: getComputedStyle(content).whiteSpace,
      };
    } finally { host.remove(); }
  })()`);
  assert.equal(result.bold, 'Bold'); assert.ok(result.underline.includes('underline'));
  assert.equal(result.color, 'rgb(255, 102, 0)'); assert.equal(result.listItems, 2);
  assert.equal(result.literalHTML, true); assert.equal(result.imageCount, 1); assert.equal(result.imageWidth, 1);
  assert.ok(result.imageSrc.startsWith('data:image/png;base64,'));
  assert.equal(result.opened, 'https://example.com/'); assert.equal(result.prevented, true);
  assert.equal(result.streamComplete, 'complete'); assert.equal(result.whiteSpace, 'normal');
  return { passed: true, checks: ['rich formatting', 'CSP-safe text color', 'literal unsafe HTML', 'embedded raster output', 'explicit link click', 'stream replacement'] };
}
