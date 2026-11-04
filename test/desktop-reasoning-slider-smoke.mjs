import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runReasoningSliderSmoke({ window, dataDir }) {
  const js = (fn, ...args) => window.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  async function wait(predicate, label) { const end = Date.now() + 10000; while (Date.now() < end) { if (await js(predicate)) return; await pause(30); } throw new Error('Reasoning slider smoke timeout: ' + label); }
  const click = selector => js(selector => document.querySelector(selector).click(), selector);
  const select = value => js(value => { const node = document.querySelector('#thinking-level'); node.value = String(value); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  const snapshots = {};
  const debuggerWasAttached = window.webContents.debugger.isAttached();
  async function key(key) {
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const windowsVirtualKeyCode = { ArrowLeft: 37, Escape: 27 }[key];
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode });
  }
  async function capture(name) {
    window.webContents.invalidate(); await window.webContents.capturePage(); await pause(80);
    const file = path.join(dataDir, name + '.png'); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); snapshots[name] = file;
  }
  try {
    await js(async () => {
      const { createChatControls } = await import('./chat-controls.mjs');
      const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
      const f = globalThis.__reasoningSliderFixture = {
        original: document.querySelector('#composer-controls'), requests: [], notices: [], active: false,
        chat: { id: 'slider-fixture', providerId: 'slider-provider', model: 'fixture-model', thinking: false, reasoningEffort: null, messages: [] },
        capabilities: { context: { configurable: true, mode: 'managed', capacityTokens: 8192, estimatedTokens: 100 }, thinking: { supported: true, mode: 'llama_cpp', effective: null }, reasoning: { supported: false, efforts: [], default: null } },
      };
      const request = async (method, params) => {
        if (method === 'chat.controls') return structuredClone(f.capabilities);
        if (method !== 'chat.update') throw new Error('Unexpected slider request: ' + method);
        f.requests.push(structuredClone(params));
        if (f.holdUpdate) await new Promise(resolve => { f.releaseUpdate = resolve; });
        if (f.failNext) { f.failNext = false; throw new Error('Fixture save rejected'); }
        Object.assign(f.chat, params); return structuredClone(f.chat);
      };
      f.sync = () => f.controls.setContext({ projects: [], providers: [{ id: 'slider-provider', model: f.chat.model }], tools: [] }, null, f.active);
      const button = (text, callback, className) => { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', callback); return node; };
      f.controls = createChatControls({ request, refresh: async () => f.sync(), getChat: () => f.chat, getDraft: () => '', getModelName: () => f.chat.model === 'account-fixture' ? 'OpenAI fixture model' : 'Qwen fixture model', el, button, icon: () => el('span', '', '◉'), notify: message => f.notices.push(message) });
      f.original.replaceWith(f.controls.root); f.sync();
    });
    await wait(() => !document.querySelector('#thinking-control').disabled, 'local capabilities');
    await click('#thinking-control');
    await wait(() => document.querySelector('#thinking-popover').matches(':popover-open'), 'local popover');
    assert.equal(await js(() => document.querySelector('#thinking-level').max), '2');
    assert.equal(await js(() => document.querySelector('#thinking-level').value), '1');
    assert.equal(await js(() => document.querySelector('#thinking-level-label').textContent), 'Off');
    assert.equal(await js(() => document.querySelector('#thinking-model').textContent), 'Qwen fixture model');
    assert.equal(await js(() => document.querySelector('#thinking-control').getAttribute('aria-expanded')), 'true');
    await capture('reasoning-slider-local');
    await js(() => { const range = document.querySelector('#thinking-level'); range.value = '2'; range.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await js(() => document.querySelector('#thinking-level-label').textContent), 'On');
    assert.equal(await js(() => __reasoningSliderFixture.requests.length), 0, 'Dragging previews the level before saving');
    await select(2);
    await wait(() => __reasoningSliderFixture.chat.thinking === true && !document.querySelector('#thinking-level').disabled, 'local thinking saved');
    assert.deepEqual(await js(() => __reasoningSliderFixture.requests.at(-1)), { id: 'slider-fixture', thinking: true, reasoningEffort: null });
    await click('#thinking-reset');
    await wait(() => __reasoningSliderFixture.chat.thinking === null && !document.querySelector('#thinking-level').disabled, 'default reset');
    assert.equal(await js(() => __reasoningSliderFixture.chat.reasoningEffort), null);
    await js(() => { const f = __reasoningSliderFixture; f.chat = { ...f.chat, model: 'account-fixture', thinking: false, reasoningEffort: 'high' }; f.capabilities.reasoning = { supported: true, efforts: ['none', 'low', 'high', 'xhigh', 'max'], default: 'high' }; f.capabilities.thinking.mode = 'responses'; f.controls.invalidate(); f.sync(); });
    await wait(() => !document.querySelector('#thinking-control').disabled, 'account capabilities');
    assert.equal(await js(() => document.querySelector('#thinking-popover').matches(':popover-open')), false, 'Model switch closes stale choices');
    await click('#thinking-control');
    assert.equal(await js(() => document.querySelector('#thinking-level').value), '1', 'Legacy thinking false takes precedence');
    await select(5);
    await wait(() => __reasoningSliderFixture.chat.reasoningEffort === 'max' && !document.querySelector('#thinking-level').disabled, 'advertised max');
    assert.deepEqual(await js(() => __reasoningSliderFixture.requests.at(-1)), { id: 'slider-fixture', thinking: null, reasoningEffort: 'max' });
    assert.equal(await js(() => document.querySelector('#thinking-level-label').textContent), 'Max');
    await capture('reasoning-slider-levels');
    await js(() => document.querySelector('#thinking-level').focus());
    await key('ArrowLeft');
    await wait(() => __reasoningSliderFixture.chat.reasoningEffort === 'xhigh' && !document.querySelector('#thinking-level').disabled, 'native keyboard selection');
    await key('ArrowLeft');
    await wait(() => __reasoningSliderFixture.chat.reasoningEffort === 'high' && !document.querySelector('#thinking-level').disabled, 'repeated keyboard selection retains focus');
    await key('Escape');
    await wait(() => !document.querySelector('#thinking-popover').matches(':popover-open'), 'Escape closes');
    assert.equal(await js(() => document.querySelector('#thinking-control').getAttribute('aria-expanded')), 'false');
    await click('#thinking-control');
    const outside = await js(() => { const bounds = document.querySelector('#chat-title').getBoundingClientRect(); return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; });
    for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...outside, button: 'left', clickCount: 1 });
    await wait(() => !document.querySelector('#thinking-popover').matches(':popover-open'), 'outside pointer closes');
    await click('#thinking-control');
    await js(() => { __reasoningSliderFixture.holdUpdate = true; });
    const beforePending = await js(() => __reasoningSliderFixture.requests.length);
    await select(2); await select(3);
    assert.equal(await js(() => __reasoningSliderFixture.requests.length), beforePending + 1, 'Pending writes block another selection');
    assert.equal(await js(() => document.querySelector('#thinking-level').disabled), true);
    await js(() => { const f = __reasoningSliderFixture; f.holdUpdate = false; f.releaseUpdate(); });
    await wait(() => __reasoningSliderFixture.chat.reasoningEffort === 'low' && !document.querySelector('#thinking-level').disabled, 'pending write settled');
    await js(() => { __reasoningSliderFixture.failNext = true; }); await select(3);
    await wait(() => __reasoningSliderFixture.notices.includes('Fixture save rejected') && !document.querySelector('#thinking-level').disabled, 'save error surfaced');
    assert.equal(await js(() => __reasoningSliderFixture.chat.reasoningEffort), 'low');
    assert.equal(await js(() => document.querySelector('#thinking-level').value), '2', 'Failed save restores persisted selection');
    const beforeActive = await js(() => __reasoningSliderFixture.requests.length);
    await js(() => { const f = __reasoningSliderFixture; f.active = true; f.sync(); });
    assert.equal(await js(() => document.querySelector('#thinking-popover').matches(':popover-open')), false);
    await select(3);
    assert.equal(await js(() => __reasoningSliderFixture.requests.length), beforeActive, 'An active run blocks saving even for a dispatched event');
    await js(() => { const f = __reasoningSliderFixture; f.active = false; f.sync(); });
    await click('#thinking-control');
    await js(() => { const f = __reasoningSliderFixture; f.chat = { ...f.chat, id: 'another-chat', thinking: null, reasoningEffort: null }; f.sync(); });
    await wait(() => !document.querySelector('#thinking-control').disabled, 'second chat');
    assert.equal(await js(() => document.querySelector('#thinking-popover').matches(':popover-open')), false, 'Chat switch closes stale choices');
    assert.equal(await js(() => __reasoningSliderFixture.requests.length), beforeActive);
    await js(() => { const f = __reasoningSliderFixture; f.capabilities.thinking.supported = false; f.capabilities.reasoning = { supported: false, efforts: [], default: null }; f.controls.invalidate(); f.sync(); });
    await wait(() => document.querySelector('#thinking-control').disabled, 'unsupported capability');
    return { check: 'Reasoning slider: local and advertised levels, reset, keyboard, pending/active guards, errors, model/chat switches', screenshots: snapshots };
  } finally {
    await js(() => { const f = globalThis.__reasoningSliderFixture; if (f) { f.controls.root.replaceWith(f.original); delete globalThis.__reasoningSliderFixture; } });
    if (!debuggerWasAttached && window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
  }
}
