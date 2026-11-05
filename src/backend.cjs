const { inventory: handoffInventory, cleanup: cleanupHandoffs } = require('./handoffs.cjs');
const { testEditor, dehancerPreset } = require('./editors.cjs');
// PhotoCull backend. The Tauri shell runs this file under a bundled Node
// runtime and owns the window, dialogs and file deletion; everything that
// touches photos lives here.
//
// stdio protocol, one JSON object per line:
//   shell → backend   { id, method, params: [...] }
//   backend → shell   { id, ok: true, value } | { id, ok: false, error }
//                     { event, payload }
//                     { ready: { port, token } }      (once, at startup)
// Image bytes do not cross stdio: the renderer loads them from a
// token-protected HTTP server on 127.0.0.1.
//
// `node src/backend.cjs --web [--port N]` serves the renderer, RPC and events
// over the same HTTP server instead, so the UI can run in a plain browser for
// smoke tests and previews. Native dialogs and the trash are unavailable there.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { randomBytes } = require('node:crypto');
const { Library } = require('./library.cjs');
const { RecipeStore, planExport } = require('./develop.cjs');
const { planTiffs, writableFolder } = require('./develop-plan.cjs');
const { PreviewService } = require('./previews.cjs');
const { CullingService } = require('./culling.cjs');
const { TransferService } = require('./transfer.cjs');
const { BackupService } = require('./backup.cjs');
const { SettingsBundles } = require('./settings-bundle.cjs');
const { createLogger, diagnostics } = require('./diagnostics.cjs');
const { DeviceMonitor, discoverDevices } = require('./devices.cjs');
const { renderName, needsCapture } = require('./renderer/naming.js');
const { normalizeSettings } = require('./preferences.cjs');
const { SettingsStore } = require('./settings.cjs');

const web = process.argv.includes('--web');
const smoke = process.env.PHOTOCULL_SMOKE_TEST === '1';
// stdout carries the protocol; keep stray library logging off it.
console.log = console.info = console.debug = console.error;

const rendererDir = path.join(__dirname, 'renderer');
const RENDERER_FILES = new Map([['index.html', 'text/html'], ['styles.css', 'text/css'], ['app.js', 'text/javascript'],
  ['commands.js', 'text/javascript'], ['histogram.js', 'text/javascript'], ['develop.js', 'text/javascript'], ['export.js', 'text/javascript'],
  ['naming.js', 'text/javascript'], ['image-view.js', 'text/javascript'], ['loupe.js', 'text/javascript'], ['culling.js', 'text/javascript'], ['survey.js', 'text/javascript'], ['bridge.js', 'text/javascript']]);
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

function defaultDataDir() {
  // Matches Electron's userData folder, which is named after productName
  // ("PhotoCull"), so existing settings and decisions carry over. Case matters
  // on Linux.
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'PhotoCull');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'PhotoCull');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'PhotoCull');
}

async function start() {
  const dataDir = path.resolve(process.env.PHOTOCULL_DATA_DIR || defaultDataDir());
  const logger = createLogger(dataDir);
  const stderr=console.error.bind(console);
  console.error=(...args)=>{logger.write('error',...args);stderr(...args);};
  console.warn=(...args)=>{logger.write('warn',...args);stderr(...args);};
  console.log=console.info=console.debug=console.error;
  logger.write('info','PhotoCull sidecar started %s %s',process.version,process.platform);
  const token = randomBytes(24).toString('hex');
  const listeners = new Set();
  const send = (event, payload) => {
    if (web) for (const res of listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(payload ?? null)}\n\n`);
    else process.stdout.write(JSON.stringify({ event, payload }) + '\n');
  };

  const settings = new SettingsStore(dataDir); await settings.init();
  const library = new Library(dataDir, { settings: () => settings.value, recipeSettings: id => recipes.get(id)?.settings, onWarning: warning => send('sidecar-warning', warning) });
  let previews;
  const transfers = new TransferService({ recipeSettings: id => recipes.get(id)?.settings, onProgress: value => send('copy-progress', value), captureDate: item => previews.metadata(item).then(data => data.captured) });
  const backups = new BackupService(dataDir, { onProgress: value => send('backup-progress', value) });
  const devices = new DeviceMonitor({ discover: async () => { const found=await discoverDevices(settings.value);for(const device of found)device.backup=await backups.snapshot(device.root,'volume:'+device.identity).catch(()=>null);return found; }, onChange: value => send('devices-changed', value),
    ...(smoke ? { discover: async () => process.env.PHOTOCULL_TEST_DEVICES ? JSON.parse(await fs.readFile(process.env.PHOTOCULL_TEST_DEVICES, 'utf8')) : [] } : {}) });
  const GB = 1024 ** 3;
  previews = new PreviewService(path.join(dataDir, 'previews'), { rendering: settings.value.rawRendering, maxDiskBytes: settings.value.previewCacheGB * GB, onState: status => send('preview-state', status) });

  const culling = new CullingService(library,previews,() => settings.value);
  const onCard = async folder => {
    const real = await fs.realpath(folder);
    return devices.devices.some(device => inside(device.root, real));
  };
  // Copying and deleting must not overlap: a copy could read a photo that a
  // deletion is removing. The shell brackets each deletion with
  // deletion-plan (which takes the lock) and deletion-end.
  let deleting = false;
  const recipes = new RecipeStore(settings.folder);
  await recipes.init();
  const bundles = new SettingsBundles(settings, recipes);
  const requireIdle = () => { if(importing || deleting || transfers.active || backups.active)throw new Error('Wait for the current file operation to finish.'); };
  const backupSource = async source => { if(typeof source !== 'string' || !path.isAbsolute(source))throw new Error('Choose a card or folder.');const real=await fs.realpath(source);if(!(await fs.stat(real)).isDirectory())throw new Error('Choose a folder.');return real; };
  previews.editorName = id => settings.value.editors.find(e=>e.id===id)?.name;
  let importing=false;
  const previewPhoto = photo => photo.develop?.missing ? { ...photo, develop: null } : photo;
  const methods = {
    'app-info': async () => ({ name: 'PhotoCull', version: require('../package.json').version, license: 'MIT',
      copyright: 'Copyright (C) 2026 Filip Biljic', notices: await fs.readFile(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8') }),
    'workspace-info': () => ({ smoke, welcome: !smoke || process.env.PHOTOCULL_TEST_WELCOME === '1' }),
    'settings-bundle-export': (file,options) => { requireIdle();return bundles.export(file,options); },
    'settings-bundle-preview': (input,options) => { requireIdle();return bundles.preview(input,options); },
    'settings-bundle-apply': async token => { requireIdle();importing=true;let result;try{result=await bundles.apply(token);}finally{importing=false;}previews.setPolicy(settings.value.rawRendering);await previews.setDiskLimit(settings.value.previewCacheGB * GB);return result; },
    'diagnostics': details => diagnostics(dataDir,settings.value,details),
    'log-folder': () => logger.folder,
    'manual-card': async source => { requireIdle();const root=await backupSource(source);await settings.update({manualCards:[...new Set([...settings.value.manualCards,root])]});return devices.refresh(); },
    'backup-start': async (source,destination,options={}) => {
      requireIdle(); source=await backupSource(source);requireIdle();
      const device=devices.devices.find(d=>d.root===source);
      return backups.start(source,destination,{identity:device ? 'volume:'+(device.identity||device.id) : 'folder:'+source,label:device?.label || path.basename(source),template:options.template || settings.value.backupTemplate});
    },
    'backup-status': async source => { requireIdle();source=await backupSource(source);const device=devices.devices.find(d=>d.root===source);return backups.status(source,device ? 'volume:'+(device.identity||device.id) : 'folder:'+source); },
    'backup-cancel': () => backups.cancel(),
    // Develop (rendering is in the shell, src-tauri/src/develop.rs).
    'recipes': () => ({ recipes: recipes.list(), defaultRecipe: settings.value.defaultRecipe, warning: recipes.warning }),
    'save-recipe': recipe => recipes.save(recipe || {}),
    'delete-recipe': id => recipes.remove(id),
    'duplicate-recipe': id => recipes.duplicate(id),
    'import-recipes': file => recipes.importFile(file),
    'export-recipes': (file, id) => recipes.exportFile(file, id),
    'develop-get': async (session, id) => {
      const state = library.developGet(session, id);
      if (state.tiff && !await fs.stat(state.tiff).then(s => s.isFile(), () => false)) { state.missing = true; state.edited = false; }
      const recipe = recipes.get(state.recipe) || recipes.get(settings.value.defaultRecipe) || recipes.get('neutral');
      return { ...state, recipe: recipe.id, recipeSettings: recipe.settings, settings: state.settings ?? recipe.settings };
    },
    'develop-set': (session, ids, value) => library.developSet(session, ids, value || {}),
    'develop-folder': async session => {
      const s = library.get(session);
      const folder = settings.value.handoffFolder;
      const valid = folder && await writableFolder(folder);
      return { folder: s.removable || settings.value.handoffAlways ? (valid ? folder : null) : path.join(s.folder, settings.value.handoffSubfolder), removable: s.removable };
    },
    'develop-folder-check': async folder => { if (!await writableFolder(folder)) throw new Error('Choose an existing writable TIFF folder.'); return folder; },
    'develop-plan': async (session, ids, folder, extension = 'tif') => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100_000) throw new Error('Choose RAW photos to send.');
      return planTiffs([...new Set(ids)].map(id => library.item(session, id)), folder, library.get(session).items, extension);
    },
    'make-folder': async folder => {
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Invalid folder.');
      await fs.mkdir(folder, { recursive: true });
      return folder;
    },
    'export-plan': async (session, ids, options) => {
      const s = library.get(session);
      if (!Array.isArray(ids) || !ids.length || ids.length > 100_000) throw new Error('Choose photos to export.');
      const items = [...new Set(ids)].map(id => library.item(session, id));
      if (items.some(item => item.trashed)) throw new Error('Photos in Trash cannot be exported.');
      return planExport(items, { ...(options || {}), protectedPaths: s.items.flatMap(i => [i.path, i.companion, i.develop?.tiff, ...(i.develop?.handoffs || []).map(r=>r.path)]).filter(Boolean), captureDate: item => previews.metadata(item).then(data => data.captured) });
    },
    // Shell-only: Lightcraft's AVIF muxer carries EXIF but omits XMP. The file is still staged.
    'export-embed-xmp': async (file, xmp) => {
      if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.avif.partial') || typeof xmp !== 'string' || xmp.length > 1024 * 1024) throw new Error('Invalid staged export metadata.');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Staged export is not a regular file.');
      const result = await previews.exif.write(file, { XMP: xmp }, ['-overwrite_original']);
      if (result.warnings?.length) throw new Error(result.warnings.join('; '));
      const handle = await fs.open(file, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
    },
    // Only the shell calls these two.
    'develop-context': async (session, id) => {
      const item = library.item(session, id);
      const stat=item.develop?.tiff ? await fs.stat(item.develop.tiff).catch(()=>null) : null;
      return { file: item.path, name: item.name, raw: item.raw, tiff: item.develop?.tiff ?? null, editedBy: item.develop?.editedBy ?? null, handoffStamp: stat ? {bytes:stat.size,mtime:stat.mtimeMs} : null };
    },
    'editor-context': id => { const editor = settings.value.editors.find(e => e.id === id); if (!editor) throw new Error('Choose a saved editor.'); return editor; },
    'editor-preset': () => dehancerPreset(),
    'editor-test': editor => testEditor(editor),
    'handoff-usage': session => handoffInventory(library.get(session)),
    'handoff-prepare': (session, ids) => previews.suspendHandoffs(ids.map(id=>library.item(session,id))),
    'handoff-release': (session, ids) => previews.resumeHandoffs(ids.map(id=>library.item(session,id))),
    'handoff-clean': async (session, token, allowUnexported) => {
      const items=library.get(session).items;
      await previews.suspendHandoffs(items);
      try { return await cleanupHandoffs(library, session, token, allowUnexported); }
      finally { previews.resumeHandoffs(items); }
    },
    'handoff-exported': async (session, records) => {
      const ids=[];
      for (const record of records) {
        const item=library.item(session,record.id),file=item.develop?.tiff;
        if (!file || file!==record.path) continue;
        const stat=await fs.stat(file).catch(()=>null);
        if (!stat || record.stamp?.bytes!==stat.size || record.stamp?.mtime!==stat.mtimeMs) continue;
        await library.developMark(session,record.id,{exported:true,exportedStamp:record.stamp});ids.push(record.id);
      }
      if (!settings.value.deleteHandoffsAfterExport) return null;
      const items=ids.map(id=>library.item(session,id));
      await previews.suspendHandoffs(items);
      try { const usage = await handoffInventory(library.get(session)); return await cleanupHandoffs(library, session, usage.token, false, ids); }
      finally { previews.resumeHandoffs(items); }
    },
    'develop-mark': async (session, id, mark) => { const result=await library.developMark(session, id, mark || {}); previews.invalidatePhoto(library.item(session,id)); return result; },
    'scan': async (folder, recursive) => {
      if (typeof folder !== 'string' || !folder) throw new Error('Choose a photo folder.');
      return library.scan(folder, !!recursive, { removable: await onCard(folder) });
    },
    'devices': () => devices.refresh(),
    'open-device': async id => {
      const device = devices.devices.find(d => d.id === id);
      if (!device) throw new Error('This card is no longer connected.');
      const session = await library.scan(device.photoRoot, true, { removable: true });
      return { ...session, deviceId: device.id, deviceRoot: device.root };
    },
    'test-destination': () => smoke ? process.env.PHOTOCULL_TEST_DESTINATION || null : null,
    'copy-picks': (session, destination, options) => deleting || backups.active ? Promise.reject(new Error('Wait for the current file operation to finish.')) : transfers.copy(library.get(session), destination, { ...options, metadataSettings: settings.value,
      naming: options?.naming || settings.value.naming, folders: options?.folders || settings.value.folders, embedMetadata: options?.embedMetadata ?? settings.value.copyMetadata }),
    'naming-preview': async (session, naming, id = null, extension = null) => {
      naming = normalizeSettings({ naming }).naming;
      const items = library.get(session).items;
      const item = id ? library.item(session, id) : items.find(i => i.flag === 'pick' && !i.trashed) || items[0];
      if (!item) return '';
      const captured = needsCapture(naming.template) ? (await previews.metadata(item)).captured : null;
      if (extension !== null && !['jpg', 'jxl', 'tif', 'png', 'avif', 'webp'].includes(extension)) throw new Error('Invalid export format.');
      const rendered = renderName(item.name, naming, 0, { captured });
      return extension ? `${rendered.stem}.${extension}` : rendered.filename;
    },
    'cancel-copy': () => transfers.cancel(),
    'decide': (session, id, patch) => library.decide(session, id, patch),
    'decide-many': (session, ids, patch) => library.decideMany(session, ids, patch),
    'analysis-source': (session,id) => culling.source(session,id),
    'analysis-store': (session,id,key,score) => culling.store(session,id,key,score),
    'keep-sharpest': (session,ids) => deleting ? Promise.reject(new Error('Wait for the deletion to finish.')) : culling.keep(session,ids),
    'history': (session, direction) => library.history(session, direction),
    'metadata': (session, id, kind = 'preview') => previews.metadata(previewPhoto(library.item(session, id)), kind),
    // size: the photo's real oriented pixel size (or null), for loupe zoom percentages.
    'preview-status': async (session, id, kind = 'preview', original = false) => {
      const photo = library.item(session, id), item = original ? { ...photo, develop: null } : previewPhoto(photo);
      return { ...previews.status(item, kind), size: await previews.dimensions(item) };
    },
    'settings': async patch => {
      const snapshot = patch === undefined || patch === null ? settings.snapshot() : await settings.update(patch);
      if (previews.policy !== snapshot.rawRendering) previews.setPolicy(snapshot.rawRendering);
      if (previews.maxDiskBytes !== snapshot.previewCacheGB * GB) await previews.setDiskLimit(snapshot.previewCacheGB * GB);
      return snapshot;
    },
    'save-preset': (name, value) => settings.savePreset(name, value),
    'delete-preset': id => settings.removePreset(id),
    'settings-folder': () => settings.folder,
    'preview-settings': async value => {
      if (value !== undefined && value !== null) { await settings.update({ rawRendering: value }); previews.setPolicy(value); }
      return { rawRendering: previews.policy, revision: previews.revision };
    },
    'preview-cache': () => previews.diskUsage(),
    'clear-preview-cache': () => previews.clearDisk(),
    'retry-preview': async (session, id) => { await previews.retry(previewPhoto(library.item(session, id))); },
    'focus': (session, ids) => {
      if (!Array.isArray(ids) || ids.length > 8) throw new Error('Invalid focus selection.');
      previews.focus(ids.map(id => previewPhoto(library.item(session, id))));
    },
    'visible': (session, ids) => {
      if (!Array.isArray(ids) || ids.length > 128) throw new Error('Invalid visible image selection.');
      previews.visible(ids.map(id => previewPhoto(library.item(session, id))));
    },
    'export-xmp': (session, profile) => library.exportXmp(session, profile ? normalizeSettings(profile) : settings.value),
    // Only the shell calls this, with a path from a native save dialog.
    'write-manifest': async (session, file) => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Choose where to save the decisions.');
      await fs.writeFile(file, JSON.stringify(library.manifest(session), null, 2));
      return file;
    },
    'session-folder': session => library.get(session).folder,
    'deletion-plan': async (session, ids) => {
      if (deleting) throw new Error('Another deletion is already running.');
      if (backups.active || transfers.active) throw new Error('Wait for the copy to finish.');
      deleting = true;
      try { return await library.deletionPlan(session, ids); } catch (error) { deleting = false; throw error; }
    },
    'deletion-end': () => { deleting = false; },
    'forget': (session, ids) => library.forget(session, ids),
    'stats': () => ({ ...previews.stats, ...previews.renders.stats, memoryMB: Math.round(previews.memoryBytes / 1024 ** 2), cacheDir: previews.cacheDir }),
  };
  if (web) {
    // Browser mode has no shell to move files to the trash, so it deletes permanently.
    methods['delete-photos'] = async (session, ids, mode) => {
      if (mode !== 'permanent') throw new Error('Moving to the trash needs the desktop app.');
      const plan = await methods['deletion-plan'](session, ids);
      try {
        const deleted = [], failures = [...plan.skipped];
        for (const photo of plan.photos) {
          try { await fs.rm(photo.files[0]); } catch (error) { failures.push({ name: photo.name, reason: error.message }); continue; }
          deleted.push(photo.id);
          for (const file of photo.files.slice(1)) await fs.rm(file).catch(error => failures.push({ name: path.basename(file), reason: error.message }));
        }
        const gone = new Set(deleted);
        for (const sidecar of plan.sidecars) {
          if (sidecar.owners.every(id => gone.has(id))) await fs.rm(sidecar.file).catch(error => failures.push({ name: path.basename(sidecar.file), reason: error.message }));
        }
        let warning = null;
        if (deleted.length) await library.forget(session, deleted).catch(error => { warning = `Deleted, but PhotoCull could not save the session: ${error.message}`; });
        return { deleted, failures, warning };
      } finally { deleting = false; }
    };
  }
  const call = async (method, params) => {
    if(importing && ['settings','save-preset','delete-preset','save-recipe','delete-recipe','duplicate-recipe','import-recipes'].includes(method) && params?.[0] !== undefined)throw new Error('Wait for settings import to finish.');
    if (!Object.hasOwn(methods, method)) throw new Error(`Unknown request: ${method}`);
    try { return await methods[method](...(Array.isArray(params) ? params : [])); } catch(error) { logger.write('error','%s: %s',method,error.message);throw error; }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const [, route, ...rest] = url.pathname.split('/');
    // Reject other hostnames so a web page cannot reach this server through DNS rebinding.
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) { res.writeHead(403).end(); return; }
    const authorized = url.searchParams.get('t') === token || req.headers['x-photocull-token'] === token;
    try {
      if (route === 'image' && authorized) {
        const [session, id, kind] = rest;
        const photo = library.item(session, id), item = url.searchParams.get('original') === '1' ? { ...photo, develop: null } : previewPhoto(photo);
        // cached=1 only returns already generated images (404 otherwise);
        // prefetch=N ranks look-ahead work below anything on screen.
        const rank = Number(url.searchParams.get('prefetch')) || 0;
        const data = url.searchParams.has('cached') ? await previews.peek(item, kind)
          : await previews.get(item, kind, kind === 'thumb' ? 1 : url.searchParams.has('prefetch') ? Math.max(2, Math.min(9, 10 - rank)) : 100);
        if (!data) { res.writeHead(404, { 'Cache-Control': 'no-store' }).end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Length': data.length });
        res.end(data); return;
      }
      if (web && route === 'rpc' && req.method === 'POST' && authorized) {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4 * 1024 ** 2) throw new Error('Request too large.'); }
        const { method, params } = JSON.parse(body);
        let reply;
        try { reply = { ok: true, value: await call(method, params) ?? null }; } catch (error) { reply = { ok: false, error: error.message }; }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply)); return;
      }
      if (web && route === 'events' && authorized) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.write(': ready\n\n');
        listeners.add(res); req.on('close', () => listeners.delete(res)); return;
      }
      const name = web && req.method === 'GET' && rest.length === 0 ? route || 'index.html' : null;
      if (name && RENDERER_FILES.has(name)) {
        res.writeHead(200, { 'Content-Type': RENDERER_FILES.get(name) + '; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await fs.readFile(path.join(rendererDir, name))); return;
      }
      res.writeHead(authorized || !route ? 404 : 403).end();
    } catch (error) { if (!res.headersSent) res.writeHead(422, { 'Content-Type': 'text/plain' }); res.end(error.message); }
  });
  const requestedPort = web ? Number(process.argv[process.argv.indexOf('--port') + 1]) || 0 : 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve); });
  const { port } = server.address();

  let closing = null;
  const shutdown = () => closing ??= (async () => {
    server.close();
    await Promise.allSettled([library.close(), settings.writes, previews.close(), transfers.close(), backups.close(), devices.close()]);
    process.exit(0);
  })();
  methods.shutdown = () => { void shutdown(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

  if (web) {
    console.error(`PhotoCull web UI: http://127.0.0.1:${port}/?t=${token}`);
    if (process.env.PHOTOCULL_URL_FILE) await fs.writeFile(process.env.PHOTOCULL_URL_FILE, `http://127.0.0.1:${port}/?t=${token}`);
  } else {
    process.stdout.write(JSON.stringify({ ready: { port, token, platform: process.platform } }) + '\n');
    const input = readline.createInterface({ input: process.stdin });
    input.on('line', async line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      let reply;
      try { reply = { id: message.id, ok: true, value: await call(message.method, message.params) ?? null }; }
      catch (error) { reply = { id: message.id, ok: false, error: error.message }; }
      process.stdout.write(JSON.stringify(reply) + '\n');
    });
    // The shell closing stdin means it has gone away; finish pending writes and exit.
    input.on('close', () => { void shutdown(); });
  }
  devices.start();
}

start().catch(error => { console.error(error); process.exit(1); });
