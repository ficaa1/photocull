// Defines window.photocull, the renderer's only route to the system.
// In the desktop app it talks to the Tauri shell, which forwards photo work to
// the Node backend (src/backend.cjs). Opened in a plain browser from
// `node src/backend.cjs --web`, it talks to that backend over HTTP instead.
(() => {
  const tauri = window.__TAURI__;
  const subscribers = new Map();
  const dispatch = (name, payload) => { for (const callback of subscribers.get(name) || []) callback(payload); };
  const subscribe = (name, callback) => {
    if (!subscribers.has(name)) subscribers.set(name, new Set());
    subscribers.get(name).add(callback);
    return () => subscribers.get(name).delete(callback);
  };
  const EVENTS = ['edit-shortcut', 'open-folder-shortcut', 'settings-shortcut', 'fullscreen-toggle', 'fullscreen-changed', 'devices-changed', 'copy-progress', 'preview-state', 'develop-progress', 'export-progress', 'lens-database-progress'];

  let backend, imageBase, platform, host, shell;
  if (tauri) {
    const info = window.__PHOTOCULL__;
    platform = info.platform;
    imageBase = { prefix: `http://127.0.0.1:${info.port}/image`, query: `t=${info.token}` };
    backend = (method, ...params) => tauri.core.invoke('backend', { method, params });
    for (const name of EVENTS) void tauri.event.listen(name, event => dispatch(name, event.payload));
    // Develop and export run in the Rust shell (src-tauri/src/develop.rs), so they need the desktop app.
    shell = (command, args) => tauri.core.invoke(command, args);
    host = {
      pickFolder: title => tauri.core.invoke('pick_folder', { title }),
      pickSaveFile: (defaultName, filterName, extension) => tauri.core.invoke('pick_save_file', { defaultName, filterName, extension }),
      openFolder: folder => tauri.core.invoke('open_folder', { path: folder }),
      fullscreen: value => tauri.core.invoke('set_fullscreen', { value }),
      deletePhotos: (session, ids, mode) => tauri.core.invoke('delete_photos', { session, ids, mode }),
      saveManifest: session => tauri.core.invoke('save_manifest', { session }),
    };
  } else {
    shell = async () => { throw new Error('Developing and exporting need the desktop app.'); };
    const token = new URLSearchParams(location.search).get('t') || '';
    platform = 'web';
    imageBase = { prefix: `${location.origin}/image`, query: `t=${token}` };
    backend = async (method, ...params) => {
      const response = await fetch(`/rpc?t=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
      const reply = await response.json();
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    };
    const events = new EventSource(`/events?t=${token}`);
    for (const name of EVENTS) events.addEventListener(name, event => dispatch(name, JSON.parse(event.data)));
    // Browser mode stands in for native dialogs with a path prompt.
    const askPath = message => { const value = prompt(message); return value?.trim() || null; };
    host = {
      pickFolder: async title => askPath(`${title} (full path)`),
      pickSaveFile: async defaultName => askPath(`Save ${defaultName} to (full path)`),
      openFolder: async () => { throw new Error('Opening folders needs the desktop app.'); },
      fullscreen: async value => {
        if (value && !document.fullscreenElement) await document.documentElement.requestFullscreen().catch(() => {});
        if (!value && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
        return { fullscreen: !!document.fullscreenElement };
      },
      deletePhotos: (session, ids, mode) => backend('delete-photos', session, ids, mode),
      saveManifest: async session => {
        const file = askPath('Save photocull-decisions.json to (full path)');
        return file ? backend('write-manifest', session, file) : null;
      },
    };
    document.addEventListener('fullscreenchange', () => dispatch('fullscreen-changed', { fullscreen: !!document.fullscreenElement }));
  }

  // develop_render replies with [u32 LE header length][JSON header][JPEG].
  const unpackFrame = buffer => {
    const view = new DataView(buffer), length = view.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
    return { ...header, blob: new Blob([new Uint8Array(buffer, 4 + length)], { type: 'image/jpeg' }) };
  };

  const api = {
    platform,
    canDevelop: !!tauri,
    // Recipes and per-photo develop state (Node backend).
    recipes: () => backend('recipes'),
    saveRecipe: recipe => backend('save-recipe', recipe),
    deleteRecipe: id => backend('delete-recipe', id),
    duplicateRecipe: id => backend('duplicate-recipe', id),
    importRecipes: async () => {
      const file = tauri ? await shell('pick_recipe_file', {}) : prompt('Import .photocull-recipe.json (full path)');
      return file ? backend('import-recipes', file) : null;
    },
    exportRecipes: async (id = null) => {
      let file = await host.pickSaveFile('recipes.photocull-recipe.json', 'PhotoCull recipe', 'photocull-recipe.json');
      if (file && !file.endsWith('.photocull-recipe.json')) file = file.replace(/\.json$/i, '') + '.photocull-recipe.json';
      return file ? backend('export-recipes', file, id) : null;
    },
    developGet: (session, id) => backend('develop-get', session, id),
    developSet: (session, ids, value) => backend('develop-set', session, ids, value),
    developFolder: session => backend('develop-folder', session),
    developFolderCheck: folder => backend('develop-folder-check', folder),
    revealDevelop: (session, id) => shell('reveal_develop', { session, id }),
    developResult: async (session, id) => unpackFrame(await shell('develop_result', { session, id })),
    developPlan: (session, ids, folder) => backend('develop-plan', session, ids, folder),
    makeFolder: folder => backend('make-folder', folder),
    pickFolder: title => host.pickFolder(title),
    exportPlan: (session, ids, options) => backend('export-plan', session, ids, options),
    // Rendering (Rust shell). settings are partial Lightcraft develop settings.
    developInfo: (session, id) => shell('develop_info', { session, id }),
    developRender: async (session, id, settings, settled) => unpackFrame(await shell('develop_render', { session, id, settings, settled: !!settled })),
    developTiffs: (session, folder, items, options = {}) => shell('develop_tiffs', { session, folder, items, options }),
    developCancel: () => shell('develop_cancel', {}),
    dehancerEdit: (session, id) => shell('dehancer_edit', { session, id }),
    exportPhotos: (session, items, options, overwrite = false, metadataOverrides = null) => shell('export_photos', { session, items, options, overwrite, metadataOverrides }),
    lensDatabase: () => shell('lens_database', {}),
    downloadLensDatabase: () => shell('download_lens_database', {}),
    onDevelopProgress: callback => subscribe('develop-progress', callback),
    onExportProgress: callback => subscribe('export-progress', callback),
    onLensDatabaseProgress: callback => subscribe('lens-database-progress', callback),
    canTrash: !!tauri,
    imageUrl: (session, id, kind, params = '') => `${imageBase.prefix}/${session}/${id}/${kind}?${imageBase.query}${params}`,
    onEdit: callback => subscribe('edit-shortcut', callback),
    onOpenFolder: callback => subscribe('open-folder-shortcut', callback),
    onSettings: callback => subscribe('settings-shortcut', callback),
    onFullscreenToggle: callback => subscribe('fullscreen-toggle', callback),
    onFullscreen: callback => subscribe('fullscreen-changed', callback),
    onDevices: callback => subscribe('devices-changed', callback),
    onCopyProgress: callback => subscribe('copy-progress', callback),
    onPreviewState: callback => subscribe('preview-state', callback),
    fullscreen: value => {
      if (typeof value !== 'boolean') return Promise.reject(new Error('Invalid fullscreen mode.'));
      return host.fullscreen(value);
    },
    namingPreview: (session, naming, id = null, extension = null) => backend('naming-preview', session, naming, id, extension),
    settings: patch => backend('settings', patch),
    savePreset: (name, value) => backend('save-preset', name, value),
    deletePreset: id => backend('delete-preset', id),
    settingsFolder: async () => host.openFolder(await backend('settings-folder')),
    devices: () => backend('devices'),
    openDevice: id => backend('open-device', id),
    chooseCopyDestination: async () => await backend('test-destination') || host.pickFolder('Copy picked originals to…'),
    copyPicks: (session, destination, options) => backend('copy-picks', session, destination, options),
    cancelCopy: () => backend('cancel-copy'),
    revealDestination: folder => host.openFolder(folder),
    chooseFolder: async ({ recursive = false } = {}) => {
      const folder = await host.pickFolder('Choose a photo folder');
      return folder ? backend('scan', folder, !!recursive) : null;
    },
    openPath: (folder, recursive) => backend('scan', folder, !!recursive),
    decide: (session, id, patch) => backend('decide', session, id, patch),
    decideMany: (session, ids, patch) => backend('decide-many', session, ids, patch),
    history: (session, direction) => backend('history', session, direction),
    metadata: (session, id, kind) => backend('metadata', session, id, kind),
    previewStatus: (session, id, kind, original = false) => backend('preview-status', session, id, kind, original),
    previewSettings: value => backend('preview-settings', value),
    retryPreview: (session, id) => backend('retry-preview', session, id),
    previewCache: () => backend('preview-cache'),
    clearPreviewCache: () => backend('clear-preview-cache'),
    focus: (session, ids) => backend('focus', session, ids),
    visible: (session, ids) => backend('visible', session, ids),
    exportXmp: (session, profile) => backend('export-xmp', session, profile),
    exportManifest: session => host.saveManifest(session),
    revealFolder: async session => host.openFolder(await backend('session-folder', session)),
    deletePhotos: (session, ids, mode) => host.deletePhotos(session, ids, mode),
    stats: () => backend('stats'),
  };
  window.photocull = Object.freeze(api);
})();
