const { app, BrowserWindow, dialog, ipcMain, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { Library } = require('./library.cjs');
const { PreviewService } = require('./previews.cjs');
const { TransferService } = require('./transfer.cjs');
const { DeviceMonitor } = require('./devices.cjs');
const { renderName, needsCapture } = require('./renderer/naming.js');
const { normalizeSettings } = require('./preferences.cjs');
const { SettingsStore } = require('./settings.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'photocull', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.PHOTOCULL_DATA_DIR) app.setPath('userData', path.resolve(process.env.PHOTOCULL_DATA_DIR));
let window, library, previews, transfers, devices, settings, quitting = false;
const rendererDir = path.join(__dirname, 'renderer');

function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents || !event.senderFrame?.url.startsWith('photocull://app/')) throw new Error('Untrusted caller.');
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  settings = new SettingsStore(dataDir); await settings.init();
  library = new Library(dataDir, { settings: () => settings.value });
  const send = (name, value) => { if (window && !window.isDestroyed()) window.webContents.send(name, value); };
  transfers = new TransferService({ onProgress: value => send('copy-progress', value), captureDate: item => previews.metadata(item).then(data => data.captured) });
  devices = new DeviceMonitor({ onChange: value => send('devices-changed', value),
    ...(process.env.PHOTOCULL_SMOKE_TEST === '1' ? { discover: async () => process.env.PHOTOCULL_TEST_DEVICES ? JSON.parse(await fs.readFile(process.env.PHOTOCULL_TEST_DEVICES, 'utf8')) : [] } : {}) });
  previews = new PreviewService(path.join(dataDir, 'previews'), { rendering: settings.value.rawRendering,
    onState: status => {
      if (window && !window.isDestroyed()) window.webContents.send('preview-state', status);
    } });
  protocol.handle('photocull', async request => {
    const url = new URL(request.url);
    if (url.hostname === 'app') {
      const allowed = new Set(['index.html', 'styles.css', 'app.js', 'naming.js', 'image-view.js']);
      const name = url.pathname.slice(1) || 'index.html';
      if (!allowed.has(name)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(rendererDir, name)).href);
    }
    if (url.hostname === 'image') {
      try {
        const [session, id, kind] = url.pathname.slice(1).split('/');
        const item = library.item(session, id);
        const data = await previews.get(item, kind, kind === 'thumb' ? 1 : url.searchParams.has('prefetch') ? 5 : 100);
        return new Response(data, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' } });
      } catch (e) { return new Response(e.message, { status: 422 }); }
    }
    return new Response('Not found', { status: 404 });
  });

  handle('fullscreen', value => {
    if (typeof value !== 'boolean') throw new Error('Invalid fullscreen mode.');
    window.setFullScreen(value); return { fullscreen: value };
  });
  handle('choose-folder', async ({ recursive = false } = {}) => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose a photo folder', properties: ['openDirectory'] });
    return result.canceled ? null : library.scan(result.filePaths[0], !!recursive);
  });
  handle('devices', () => devices.refresh());
  handle('open-device', async id => {
    const device = devices.devices.find(d => d.id === id);
    if (!device) throw new Error('This card is no longer connected.');
    const session = await library.scan(device.photoRoot, true);
    return { ...session, deviceId: device.id, deviceRoot: device.root };
  });
  handle('choose-copy-destination', async () => {
    if (process.env.PHOTOCULL_SMOKE_TEST === '1' && process.env.PHOTOCULL_TEST_DESTINATION) return process.env.PHOTOCULL_TEST_DESTINATION;
    const result = await dialog.showOpenDialog(window, { title: 'Copy picked originals to…', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('copy-picks', (session, destination, options) => transfers.copy(library.get(session), destination, { ...options, metadataSettings: settings.value, naming: options?.naming || settings.value.naming, folders: options?.folders || settings.value.folders, embedMetadata: options?.embedMetadata ?? settings.value.copyMetadata }));
  handle('naming-preview', async (session, naming) => {
    naming = normalizeSettings({ naming }).naming;
    const items = library.get(session).items;
    const item = items.find(i => i.flag === 'pick') || items[0];
    if (!item) return '';
    const captured = needsCapture(naming.template) ? (await previews.metadata(item)).captured : null;
    return renderName(item.name, naming, 0, { captured }).filename;
  });
  handle('cancel-copy', () => transfers.cancel());
  handle('reveal-destination', folder => shell.openPath(folder));
  handle('decide', (session, id, patch) => library.decide(session, id, patch));
  handle('history', (session, direction) => library.history(session, direction));
  handle('metadata', (session, id, kind = 'preview') => previews.metadata(library.item(session, id), kind));
  handle('preview-status', (session, id, kind = 'preview') => previews.status(library.item(session, id), kind));
  handle('settings', async patch => {
    const snapshot = patch === undefined ? settings.snapshot() : await settings.update(patch);
    if (previews.policy !== snapshot.rawRendering) previews.setPolicy(snapshot.rawRendering);
    return snapshot;
  });
  handle('save-preset', (name, value) => settings.savePreset(name, value));
  handle('delete-preset', id => settings.removePreset(id));
  handle('settings-folder', () => shell.openPath(settings.folder));
  handle('preview-settings', async value => {
    if (value !== undefined) { await settings.update({ rawRendering: value }); previews.setPolicy(value); }
    return { rawRendering: previews.policy, revision: previews.revision };
  });
  handle('retry-preview', async (session, id) => {
    const item = library.item(session, id);
    await previews.retry(item);
  });
  handle('focus', (session, ids) => {
    if (!Array.isArray(ids) || ids.length > 8) throw new Error('Invalid focus selection.');
    previews.focus(ids.map(id => library.item(session, id)));
  });
  handle('visible', (session, ids) => {
    if (!Array.isArray(ids) || ids.length > 128) throw new Error('Invalid visible image selection.');
    previews.visible(ids.map(id => library.item(session, id)));
  });
  handle('export-xmp', (session, profile) => library.exportXmp(session, profile ? normalizeSettings(profile) : settings.value));
  handle('export-manifest', async session => {
    const result = await dialog.showSaveDialog(window, { defaultPath: 'photocull-decisions.json', filters: [{ name: 'PhotoCull decisions', extensions: ['json'] }] });
    if (result.canceled) return null;
    await fs.writeFile(result.filePath, JSON.stringify(library.manifest(session), null, 2));
    return result.filePath;
  });
  handle('reveal-folder', session => shell.openPath(library.get(session).folder));
  handle('stats', () => ({ ...previews.stats, ...previews.renders.stats, memoryMB: Math.round(previews.memoryBytes / 1024 ** 2), cacheDir: previews.cacheDir }));
  // Test-only folder injection avoids automating native file dialogs.
  if (process.env.PHOTOCULL_SMOKE_TEST === '1') handle('test-open-folder', (folder, recursive) => library.scan(folder, recursive));

  async function createWindow() {
  if (window && !window.isDestroyed()) { window.show(); return; }
  const current = new BrowserWindow({ width: 1440, height: 960, minWidth: 1024, minHeight: 700,
    title: 'PhotoCull', backgroundColor: '#121614', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window = current;
  current.on('enter-full-screen', () => send('fullscreen-changed', { fullscreen: true }));
  current.on('leave-full-screen', () => send('fullscreen-changed', { fullscreen: false }));
  current.webContents.on('before-input-event', (event, input) => {
    if (process.platform === 'darwin' && input.type === 'keyDown' && input.meta && input.key.toLowerCase() === 'z') { event.preventDefault(); send('edit-shortcut', input.shift ? 'redo' : 'undo'); return; }
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      send('fullscreen-toggle');
    }
  });
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('photocull://app/')) event.preventDefault(); });
  current.on('closed', () => { if (window === current) window = null; });
  try { await current.loadURL('photocull://app/index.html'); } catch (error) { if (!current.isDestroyed()) throw error; }
  }
  const openRequested = async () => { if (!window) await createWindow(); send('open-folder-shortcut'); };
  const settingsRequested = async () => { if (!window) await createWindow(); send('settings-shortcut'); };
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu', submenu: [{role:'about'}, {label:'Settings…', accelerator:'Cmd+,', click:settingsRequested}, {type:'separator'}, {role:'services'}, {type:'separator'}, {role:'hide'}, {role:'hideOthers'}, {role:'unhide'}, {type:'separator'}, {role:'quit'}] }] : []),
    { label:'File', submenu:[{label:'Open folder…',accelerator:'CmdOrCtrl+O',click:openRequested},{role:'close'}] },
    {label:'Edit',submenu:[{label:'Undo',accelerator:'CmdOrCtrl+Z',click:()=>send('edit-shortcut','undo')},{label:'Redo',accelerator:'Shift+CmdOrCtrl+Z',click:()=>send('edit-shortcut','redo')},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    { label:'View', submenu:[{label:'Fullscreen',accelerator:process.platform === 'darwin'?'Ctrl+Cmd+F':'F11',click:()=>send('fullscreen-toggle')},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}] },
    { role:'windowMenu' },
  ];
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  await createWindow();
  devices.start();
  app.on('activate', () => { if (!window) void createWindow(); else window.show(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  Promise.allSettled([library?.writes, settings?.writes, previews?.close(), transfers?.close(), devices?.close()]).finally(() => app.quit());
});
