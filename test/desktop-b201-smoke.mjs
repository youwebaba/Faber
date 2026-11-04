import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Menu } from 'electron';
import { runDesktopSmoke } from './desktop-smoke.mjs';
import { runB201UISmoke } from './desktop-b201-ui-smoke.mjs';
import { runRichContentSmoke } from './desktop-rich-content-smoke.mjs';
import { runB201ContentSmoke } from './desktop-b201-content-smoke.mjs';

export async function runB201Smoke(context) {
  const baseline = await runDesktopSmoke(context);
  const settings = Menu.getApplicationMenu().items.find(item => item.label === 'Edit')?.submenu.items.find(item => item.label === 'Settings');
  assert.ok(settings, 'Native Edit menu exposes Settings');
  settings.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await context.window.webContents.executeJavaScript(`document.querySelector('#modal-title').textContent`), 'Settings');
  const ui = await runB201UISmoke(context);
  const richContent = await runRichContentSmoke(context);
  const content = await runB201ContentSmoke(context);
  const result = { ...baseline, ...ui, richContent, content, nativeSettings: true };
  await fs.writeFile(path.join(context.dataDir, 'b201-smoke-report.json'), JSON.stringify(result, null, 2));
  return result;
}
