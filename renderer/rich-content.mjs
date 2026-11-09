import { marked } from './vendor/marked.esm.js';
import { MAX_IMAGES, MAX_IMAGE_BYTES } from './chat-media.mjs';
import { snapshotImage } from './file-attachments.mjs';

const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': '\u00a0' };
const decodeText = value => String(value ?? '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, match => entities[match]);
const colors = new Set(['black', 'white', 'gray', 'grey', 'silver', 'red', 'maroon', 'orange', 'yellow', 'olive', 'green', 'lime', 'teal', 'aqua', 'cyan', 'blue', 'navy', 'purple', 'fuchsia', 'magenta', 'pink', 'brown', 'gold', 'violet', 'indigo']);
const inlineTags = { u: 'u', s: 'del', del: 'del', b: 'strong', strong: 'strong', i: 'em', em: 'em', sub: 'sub', sup: 'sup' };

export function safeContentLink(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  const text = decodeText(value);
  if (!/^https?:\/\//i.test(text) || /[\u0000-\u0020\u007f]/.test(text)) return null;
  try { const url = new URL(text); return url.username || url.password ? null : url.href; } catch { return null; }
}

export function safeOutputImage(value) {
  return snapshotImage(value) ? value : null;
}

function imageElement(source, alt, document) {
  const image = document.createElement('img'); image.src = source; image.alt = alt || 'Image output';
  image.loading = 'lazy'; image.decoding = 'async'; image.className = 'output-image';
  return image;
}

export function renderOutputImages(images, { document = globalThis.document, altPrefix = 'Image output' } = {}) {
  const container = document.createElement('div'); container.className = 'message-images output-images';
  let bytes = 0, count = 0; const seen = new Set();
  for (const value of Array.isArray(images) ? images : [images]) {
    if (count === MAX_IMAGES) break;
    const source = safeOutputImage(value);
    if (!source || seen.has(source) || bytes + source.length > MAX_IMAGE_BYTES) continue;
    seen.add(source); bytes += source.length; count++;
    container.append(imageElement(source, `${altPrefix} ${count}`, document));
  }
  return container;
}

export function renderRichContent(value, { document = globalThis.document, onOpenLink, onLastToken } = {}) {
  const source = typeof value === 'string' ? value : String(value ?? '');
  const root = document.createElement('div'); root.className = 'rich-content';
  let images = 0, imageBytes = 0, rendered = 0;
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const text = (parent, value) => parent.append(document.createTextNode(value));
  function link(parent, target, title, children, label, depth) {
    const href = safeContentLink(target);
    if (!href) { if (children) render(children, parent, depth + 1); else text(parent, label); return; }
    const anchor = node('a'); anchor.href = href; anchor.title = title || href; anchor.rel = 'noopener noreferrer';
    anchor.addEventListener('click', event => { event.preventDefault(); onOpenLink?.(href); });
    if (children) render(children, anchor, depth + 1); else text(anchor, label);
    parent.append(anchor);
  }
  function render(tokens, parent, depth = 0) {
    const stack = [{ node: parent, tag: null }];
    const current = () => stack.at(-1).node;
    for (const token of tokens || []) {
      // Long or deeply nested model output stays readable without growing an unbounded DOM.
      if (++rendered > 30000 || depth > 32) throw new Error('Rich text is too complex');
      const append = (tag, nested = token.tokens) => { const element = node(tag); current().append(element); render(nested, element, depth + 1); return element; };
      switch (token.type) {
        case 'space': case 'def': break;
        case 'paragraph': append('p'); break;
        case 'heading': append(`h${Math.max(1, Math.min(6, token.depth))}`); break;
        case 'blockquote': append('blockquote'); break;
        case 'strong': case 'em': case 'del': append(token.type); break;
        case 'text':
          if (token.tokens) render(token.tokens, current(), depth + 1); else text(current(), decodeText(token.text));
          break;
        case 'escape': text(current(), token.text); break;
        case 'codespan': current().append(node('code', token.text)); break;
        case 'code': { const pre = node('pre'); pre.append(node('code', token.text)); current().append(pre); break; }
        case 'br': current().append(node('br')); break;
        case 'hr': current().append(node('hr')); break;
        case 'checkbox': {
          const check = node('input'); check.type = 'checkbox'; check.checked = Boolean(token.checked); check.disabled = true;
          check.setAttribute('aria-label', token.checked ? 'Completed task' : 'Incomplete task'); current().append(check); break;
        }
        case 'list': {
          const list = node(token.ordered ? 'ol' : 'ul');
          if (token.ordered && Number.isSafeInteger(token.start) && token.start > 0) list.start = token.start;
          for (const item of token.items) { const li = node('li'); list.append(li); render(item.tokens, li, depth + 1); }
          current().append(list); break;
        }
        case 'table': {
          const scroller = node('div'); scroller.className = 'rich-table'; const table = node('table');
          const row = (cells, heading) => {
            const tr = node('tr');
            cells.forEach((cell, index) => { const td = node(heading ? 'th' : 'td'); if (heading) td.scope = 'col'; if (['left', 'center', 'right'].includes(token.align[index])) td.className = `align-${token.align[index]}`; render(cell.tokens, td, depth + 1); tr.append(td); });
            return tr;
          };
          const head = node('thead'); head.append(row(token.header, true)); table.append(head);
          const body = node('tbody'); token.rows.forEach(cells => body.append(row(cells, false))); table.append(body);
          scroller.append(table); current().append(scroller); break;
        }
        case 'link': link(current(), token.href, token.title, token.tokens, token.text, depth); break;
        case 'image': {
          const image = safeOutputImage(token.href);
          if (image && images < MAX_IMAGES && imageBytes + image.length <= MAX_IMAGE_BYTES) { images++; imageBytes += image.length; current().append(imageElement(image, decodeText(token.text), document)); }
          else link(current(), token.href, token.title, null, `Image: ${decodeText(token.text) || 'unavailable'}`, depth);
          break;
        }
        case 'html': {
          const raw = token.text;
          const opening = /^<(u|s|del|b|strong|i|em|sub|sup)>$/i.exec(raw);
          const closing = /^<\/(u|s|del|b|strong|i|em|sub|sup|span|font)>$/i.exec(raw);
          const color = /^<(span)\s+style\s*=\s*(["'])\s*color\s*:\s*([a-z]+|#[a-f0-9]{3}|#[a-f0-9]{6})\s*;?\s*\2\s*>$/i.exec(raw)
            || /^<(font)\s+color\s*=\s*(["'])([a-z]+|#[a-f0-9]{3}|#[a-f0-9]{6})\2\s*>$/i.exec(raw);
          if (opening || color && (color[3].startsWith('#') || colors.has(color[3].toLowerCase()))) {
            const tag = (opening || color)[1].toLowerCase(), element = node(inlineTags[tag] || 'span');
            if (color) element.style.color = color[3]; current().append(element); stack.push({ node: element, tag });
          } else if (closing && stack.length > 1 && closing[1].toLowerCase() === stack.at(-1).tag) stack.pop();
          else if (/^<br\s*\/?>$/i.test(raw)) current().append(node('br'));
          else text(current(), raw);
          break;
        }
        default: text(current(), token.raw ?? token.text ?? '');
      }
    }
  }
  try {
    // shortcut: very large replies render as plain text; move lexing to a worker if rich rendering above this size is needed.
    if (source.length > 200000) throw new Error('Rich text exceeds render budget');
    const tokens = marked.lexer(source, { gfm: true, breaks: true });
    render(tokens, root); onLastToken?.(tokens.at(-1));
  } catch { root.replaceChildren(document.createTextNode(source)); root.classList.add('rich-content-plain'); }
  return root;
}

function syncRichNodes(current, next) {
  if (current.isEqualNode(next)) return;
  if (current.nodeType === 3 && next.nodeType === 3) {
    if (next.data.startsWith(current.data)) current.appendData(next.data.slice(current.length));
    else current.replaceData(0,current.length,next.data);
    return;
  }
  if (current.nodeType !== 1 || next.nodeType !== 1 || !current.cloneNode(false).isEqualNode(next.cloneNode(false))) { current.replaceWith(next); return; }
  const previous = [...current.childNodes], incoming = [...next.childNodes];
  for (let i=0; i<incoming.length; i++) { if (previous[i]) syncRichNodes(previous[i],incoming[i]); else current.append(incoming[i]); }
  for (let i=incoming.length; i<previous.length; i++) previous[i].remove();
}

// Delimiters and replacements go back through the same bounded, sanitized Markdown renderer.
export function updateStreamContent(container, source, options = {}) {
  const prior = container.streamContent;
  if (source === prior?.text) return;
  const doc = options.document || container.ownerDocument;
  const delta = prior && source.startsWith(prior.text) ? source.slice(prior.text.length) : '';
  if (delta && prior.tail && source.length <= 200000 && (prior.mode === 'plain' ? /^[\p{L}\p{N} ,]+$/u.test(delta) : !/[\r\n`~]/.test(delta))) {
    prior.tail.appendData(delta); prior.text = source; return;
  }
  let last;
  const fresh = renderRichContent(source, {...options,document:doc,onLastToken:token=>{last=token;}});
  if (prior) syncRichNodes(container.firstChild,fresh);
  else { const cursor=doc.createElement('span'); cursor.className='stream-cursor'; container.replaceChildren(fresh,cursor); }
  const root=container.firstChild, paragraph=root.lastElementChild;
  let mode, tail;
  if (last?.type==='paragraph' && last.raw===last.text && /^[\p{L}\p{N} ,]+$/u.test(last.text) && paragraph?.childNodes.length===1 && paragraph.firstChild.nodeType===3) {
    mode='plain';tail=paragraph.firstChild;
  } else if (last?.type==='code' && /^(`{3,}|~{3,})[^\n]*\n/.test(last.raw) && !/[\r\n]$/.test(last.raw) && !/\n {0,3}(?:`{3,}|~{3,})\s*$/.test(last.raw) && paragraph?.localName==='pre' && paragraph.firstChild?.firstChild?.nodeType===3) {
    mode='code';tail=paragraph.firstChild.firstChild;
  }
  container.streamContent={text:source,mode,tail};
}
