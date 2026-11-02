// Installer-owned bootstrap stays outside the editable application's import graph.
const { app, dialog, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const appRoot = path.resolve(__dirname, '..');
const smokeModes = new Set(['--smoke','--smoke-live','--smoke-models','--smoke-features','--smoke-local-models','--smoke-ui-reload','--smoke-package','--smoke-faber','--smoke-installed']);
const smoke = process.argv.some(value => smokeModes.has(value));
const profileIndex = process.argv.indexOf('--smoke-profile');
let dataDir;
try {
  if (profileIndex !== -1) {
    if (!smoke || !path.isAbsolute(process.argv[profileIndex + 1] || '')) throw new Error('--smoke-profile requires a smoke mode and an absolute isolated directory');
    dataDir = path.resolve(process.argv[profileIndex + 1]);
    const temporaryRelative = path.relative(path.resolve(os.tmpdir()), dataDir);
    if (!temporaryRelative || temporaryRelative === '..' || temporaryRelative.startsWith(`..${path.sep}`) || path.isAbsolute(temporaryRelative)) throw new Error('Smoke profiles must be isolated children of the system temporary directory');
  } else dataDir = smoke ? fs.mkdtempSync(path.join(os.tmpdir(), 'Faber-smoke-')) : path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'SophiaHarness');
  fs.mkdirSync(dataDir, { recursive: true }); app.setPath('userData', dataDir);
  app.setAppUserModelId('ai.clocal.faber');
  protocol.registerSchemesAsPrivileged([{ scheme: 'sophia', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  if (!app.requestSingleInstanceLock()) { if (process.argv.includes('--rollback-last')) { console.error('Close Faber before running recovery.'); app.quit(); process.exit(1); } app.quit(); process.exit(0); }
  void (async () => {
    const packaged = app.isPackaged;
    const { prepareWorkbench } = await import(pathToFileURL(path.join(appRoot, 'desktop', 'packaged-paths.mjs')).href);
    const workbenchRoot = smoke ? `${dataDir}-workbench` : path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'FaberWorkbench');
    const sourceDir = packaged ? await prepareWorkbench({ bundledSource: appRoot, workbenchRoot, version: app.getVersion() }) : appRoot;
    globalThis.__FABER_BOOTSTRAP__ = Object.freeze({ dataDir, sourceDir, packaged, resourcesPath: process.resourcesPath, version: app.getVersion(), hasLock: true });
    if (process.argv.includes('--rollback-last')) {
      const { readRecoveryRecord, restoreUpgrade } = await import(pathToFileURL(path.join(appRoot, 'desktop', 'recovery.mjs')).href);
      const result = await restoreUpgrade({ dataDir, sourceDir, record: await readRecoveryRecord(dataDir, sourceDir) });
      if(smoke) { fs.writeFileSync(path.join(dataDir,'recovery-report.json'),JSON.stringify(result)); console.log(JSON.stringify(result)); }
      else { await app.whenReady(); await dialog.showMessageBox({ type: 'info', title: 'Faber recovery', message: `Restored upgrade ${result.id}. Start Faber again to load the recovered source.` }); }
      app.quit(); return;
    }
    await import(pathToFileURL(path.join(sourceDir, 'desktop', 'main.mjs')).href);
  })().catch(async error => { console.error(error); await app.whenReady(); if (!smoke) dialog.showErrorBox('Faber could not start', `${error.message}\n\nYour data and workbench have been preserved. For source recovery run Faber.exe --rollback-last.`); app.exit(1); });
} catch (error) { console.error(error); app.exit(1); }
