const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'Faber-logo-render-')));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:">');
    for (const name of ['faber-symbol', 'faber-wordmark']) {
      const file = path.join(__dirname, '..', 'renderer', 'assets', name);
      const svg = await fs.readFile(`${file}.svg`);
      const png = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image(); image.src = ${JSON.stringify(`data:image/svg+xml;base64,${svg.toString('base64')}`)};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        if (!canvas.width || !canvas.height) throw new Error('Logo has no intrinsic size');
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        if (context.getImageData(0, 0, 1, 1).data[3] !== 0) throw new Error('Logo background must be transparent');
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      await fs.writeFile(`${file}.png`, Buffer.from(png, 'base64'));
      console.log(`Rendered ${name}.png from SVG with transparency`);
    }
  } finally { window.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
