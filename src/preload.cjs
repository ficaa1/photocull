const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (name, ...args) => {
  const result = await ipcRenderer.invoke(name, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const subscribe = (name, callback) => {
  const listener = (_, value) => callback(value);
  ipcRenderer.on(name, listener);
  return () => ipcRenderer.removeListener(name, listener);
};
const api = {
  platform: process.platform,
  onEdit: callback => subscribe('edit-shortcut', callback),
  onOpenFolder: callback => subscribe('open-folder-shortcut', callback),
  onSettings: callback => subscribe('settings-shortcut', callback),
  fullscreen: value => invoke('fullscreen', value),
  onFullscreenToggle: callback => subscribe('fullscreen-toggle', callback),
  onFullscreen: callback => subscribe('fullscreen-changed', callback),
  namingPreview: (session, naming) => invoke('naming-preview', session, naming),
  settings: patch => invoke('settings', patch),
  savePreset: (name, value) => invoke('save-preset', name, value),
  deletePreset: id => invoke('delete-preset', id),
  settingsFolder: () => invoke('settings-folder'),
  devices: () => invoke('devices'),
  openDevice: id => invoke('open-device', id),
  onDevices: callback => subscribe('devices-changed', callback),
  chooseCopyDestination: () => invoke('choose-copy-destination'),
  copyPicks: (session, destination, options) => invoke('copy-picks', session, destination, options),
  cancelCopy: () => invoke('cancel-copy'),
  onCopyProgress: callback => subscribe('copy-progress', callback),
  revealDestination: folder => invoke('reveal-destination', folder),
  chooseFolder: options => invoke('choose-folder', options),
  decide: (session, id, patch) => invoke('decide', session, id, patch),
  history: (session, direction) => invoke('history', session, direction),
  metadata: (session, id, kind) => invoke('metadata', session, id, kind),
  previewStatus: (session, id, kind) => invoke('preview-status', session, id, kind),
  previewSettings: value => invoke('preview-settings', value),
  retryPreview: (session, id) => invoke('retry-preview', session, id),
  onPreviewState: callback => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on('preview-state', listener);
    return () => ipcRenderer.removeListener('preview-state', listener);
  },
  focus: (session, ids) => invoke('focus', session, ids),
  visible: (session, ids) => invoke('visible', session, ids),
  exportXmp: (session, profile) => invoke('export-xmp', session, profile),
  exportManifest: session => invoke('export-manifest', session),
  revealFolder: session => invoke('reveal-folder', session),
  stats: () => invoke('stats'),
};
if (process.env.PHOTOCULL_SMOKE_TEST === '1') api.testOpenFolder = (folder, recursive) => invoke('test-open-folder', folder, recursive);
contextBridge.exposeInMainWorld('photocull', api);
