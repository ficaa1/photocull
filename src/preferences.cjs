const COLORS = [
  ['Red', '#df6262'], ['Yellow', '#dec45e'], ['Green', '#83bb72'], ['Blue', '#6f9cdb'],
  ['Purple', '#aa81d2'], ['Orange', '#dc9959'], ['Cyan', '#64b9be'], ['Gray', '#949b9a'],
].map(([name, hex], index) => ({ id: String(index + 1), name, hex, label: name }));
const METADATA = { writeRatings: true, writeLabels: true, rejectRating: true, pickColor: '3', rejectColor: '1',
  creator: '', copyright: '', title: '', caption: '', keywords: [] };
const NAMING = { template: '{filename}', text: '', start: 1 };
const FOLDERS = { mode: 'flat', name: '' };
const exportLogic = require('./renderer/export.js');
const EXPORT_PRESETS = exportLogic.PRESETS.map(p => ({ ...p, options: exportLogic.options(p.options), naming: NAMING, subfolder: '', conflict: 'unique' }));
const DEFAULTS = { version: 1, zoomPercent: 100, zoomClickCenter: false, rawRendering: 'missing', previewCacheGB: 2, autoAdvance: true, recursive: false, autoOpenCards: true, deleteMode: 'trash',
  copyJpeg: false, copyXmp: false, copyMetadata: false, folders: FOLDERS,
  // Develop and export: the Dehancer plugin executable ('' = its default location), the recipe new photos start
  // from, and the last export settings (Lightcraft ExportOptions, camelCase; checked by the shell).
  dehancerExe: '', dehancerFolder: '', defaultRecipe: 'neutral', exportOptions: { format: 'jpeg', quality: 90, colorSpace: 'srgb' }, exportSubfolder: '', exportConflict: 'unique', exportPresets: EXPORT_PRESETS, activePreset: 'standard', naming: NAMING, metadata: METADATA, colors: COLORS };
const BUILTINS = [
  { id: 'standard', name: 'Standard', metadata: METADATA, naming: NAMING, folders: FOLDERS, colors: COLORS },
  { id: 'ratings', name: 'Ratings only', metadata: { ...METADATA, writeLabels: false }, naming: NAMING, folders: FOLDERS, colors: COLORS },
  { id: 'labels', name: 'Labels only', metadata: { ...METADATA, writeRatings: false, rejectRating: false }, naming: NAMING, folders: FOLDERS, colors: COLORS },
];
const clone = value => structuredClone(value);
function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error('Invalid settings text.');
  return value.trim();
}
function normalizeSettings(value = {}, base = DEFAULTS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings.');
  const result = clone(base);
  for (const key of ['autoAdvance', 'recursive', 'autoOpenCards', 'zoomClickCenter', 'copyJpeg', 'copyXmp', 'copyMetadata']) if (key in value) {
    if (typeof value[key] !== 'boolean') throw new Error('Invalid setting: ' + key);
    result[key] = value[key];
  }
  if ('zoomPercent' in value) {
    if (!Number.isFinite(value.zoomPercent) || value.zoomPercent < 5 || value.zoomPercent > 1600) throw new Error('Zoom must be between 5% and 1600%.');
    result.zoomPercent = value.zoomPercent;
  }
  if ('rawRendering' in value) {
    if (!['off', 'missing', 'small'].includes(value.rawRendering)) throw new Error('Invalid RAW rendering option.');
    result.rawRendering = value.rawRendering;
  }
  if ('previewCacheGB' in value) {
    if (![1, 2, 5, 10].includes(value.previewCacheGB)) throw new Error('Invalid preview cache size.');
    result.previewCacheGB = value.previewCacheGB;
  }
  if ('deleteMode' in value) {
    if (!['trash', 'permanent'].includes(value.deleteMode)) throw new Error('Invalid delete mode.');
    result.deleteMode = value.deleteMode;
  }
  if ('activePreset' in value) result.activePreset = text(value.activePreset, 80);
  if ('dehancerExe' in value) {
    result.dehancerExe = text(value.dehancerExe, 1024);
    if (result.dehancerExe && !/.exe$/i.test(result.dehancerExe) && process.platform === 'win32') throw new Error('Choose DehancerLightroom.exe.');
  }
  if ('dehancerFolder' in value) {
    result.dehancerFolder = text(value.dehancerFolder, 1024);
    const path = require('node:path');
    if (result.dehancerFolder && ((!path.isAbsolute(result.dehancerFolder) && !path.win32.isAbsolute(result.dehancerFolder)) || /[\r\n]/.test(result.dehancerFolder))) throw new Error('Choose an absolute Dehancer folder.');
  }
  if ('defaultRecipe' in value) result.defaultRecipe = text(value.defaultRecipe, 80) || 'neutral';
  if ('exportOptions' in value) {
    if (!value.exportOptions || typeof value.exportOptions !== 'object' || Array.isArray(value.exportOptions) || JSON.stringify(value.exportOptions).length > 16384) throw new Error('Invalid export settings.');
    result.exportOptions = require('./renderer/export.js').options(value.exportOptions);
  }
  if ('exportSubfolder' in value) result.exportSubfolder = text(value.exportSubfolder, 120);
  if ('exportConflict' in value) {
    if (!['unique', 'skip', 'overwrite'].includes(value.exportConflict)) throw new Error('Invalid conflict option.');
    result.exportConflict = value.exportConflict;
  }
  if ('metadata' in value) {
    if (!value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata)) throw new Error('Invalid metadata preset.');
    for (const key of ['writeRatings', 'writeLabels', 'rejectRating']) if (key in value.metadata) {
      if (typeof value.metadata[key] !== 'boolean') throw new Error('Invalid metadata option.');
      result.metadata[key] = value.metadata[key];
    }
    for (const key of ['pickColor', 'rejectColor']) if (key in value.metadata) {
      if (!['', '1', '2', '3', '4', '5', '6', '7', '8'].includes(value.metadata[key])) throw new Error('Invalid color mapping.');
      result.metadata[key] = value.metadata[key];
    }
    for (const key of ['creator', 'copyright', 'title', 'caption']) if (key in value.metadata) result.metadata[key] = text(value.metadata[key], key === 'caption' ? 8192 : 1024);
    if ('keywords' in value.metadata) {
      if (!Array.isArray(value.metadata.keywords) || value.metadata.keywords.length > 100) throw new Error('Use at most 100 keywords.');
      result.metadata.keywords = [...new Set(value.metadata.keywords.map(v => text(v, 128)).filter(Boolean))];
    }
  }
  if ('folders' in value) {
    if (!value.folders || typeof value.folders !== 'object') throw new Error('Invalid folder settings.');
    const folders = { ...result.folders, ...value.folders };
    if (!['flat', 'named', 'preserve'].includes(folders.mode)) throw new Error('Invalid folder layout.');
    folders.name = text(folders.name, 120);
    if (folders.name && (/[<>:"/\\|?*]/.test(folders.name) || /[. ]$/.test(folders.name) || folders.name === '.' || folders.name === '..' || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(folders.name))) throw new Error('Invalid folder name.');
    if (folders.mode === 'named' && !folders.name) throw new Error('Enter a folder name.');
    result.folders = { mode: folders.mode, name: folders.name };
  }
  if ('naming' in value) {
    const input = value.naming;
    if (!input || typeof input !== 'object') throw new Error('Invalid filename template.');
    const naming = { ...result.naming, ...input };
    naming.template = text(naming.template, 180); naming.text = text(naming.text, 80);
    if (!naming.template || /[<>:"/\\|?*]/.test(naming.template.replace(/\{[^{}]+\}/g, ''))) throw new Error('Invalid filename template.');
    const tokens = naming.template.match(/\{[^{}]*\}/g) || [];
    if (tokens.some(token => !/^\{(filename|text|date|capturedate|year|month|day|seq(?::[1-6])?)\}$/.test(token)) || /[{}]/.test(naming.template.replace(/\{[^{}]*\}/g, ''))) throw new Error('Unknown filename token.');
    if (/[<>:"/\\|?*]/.test(naming.text)) throw new Error('Custom text contains invalid filename characters.');
    if (!Number.isInteger(naming.start) || naming.start < 1 || naming.start > 999999999) throw new Error('Sequence must start between 1 and 999999999.');
    result.naming = { template: naming.template, text: naming.text, start: naming.start };
  }
  if ('colors' in value) {
    if (!Array.isArray(value.colors) || value.colors.length !== 8) throw new Error('Define eight color labels.');
    result.colors = value.colors.map((color, index) => {
      if (color?.id !== String(index + 1) || !/^#[\da-f]{6}$/i.test(color.hex)) throw new Error('Invalid color label.');
      return { id: color.id, name: text(color.name, 64) || `Color ${color.id}`, hex: color.hex, label: text(color.label, 128) };
    });
  }
  if ('exportPresets' in value) {
    if (!Array.isArray(value.exportPresets) || value.exportPresets.length > 100) throw new Error('Use at most 100 export presets.');
    const ids = new Set(), names = new Set();
    result.exportPresets = value.exportPresets.map(p => {
      if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(p.id) || ids.has(p.id)) throw new Error('Invalid export preset id.');
      const builtin = EXPORT_PRESETS.find(b => b.id === p.id);
      const name = text(p.name, 80);
      if (builtin && name !== builtin.name || !builtin && EXPORT_PRESETS.some(b => b.name.toLowerCase() === name.toLowerCase())) throw new Error('Built-in export preset names are reserved.');
      if (!name || names.has(name.toLowerCase())) throw new Error('Export preset names must be unique.');
      ids.add(p.id); names.add(name.toLowerCase());
      const normalized = normalizeSettings({ exportOptions: p.options || {}, naming: p.naming || NAMING, folders: { mode: p.subfolder ? 'named' : 'flat', name: p.subfolder || '' }, exportConflict: p.conflict || 'unique' }, { ...DEFAULTS, exportPresets: [] });
      return { id: p.id, name, builtin: EXPORT_PRESETS.some(b => b.id === p.id), options: normalized.exportOptions, naming: normalized.naming, subfolder: normalized.folders.name, conflict: normalized.exportConflict };
    });
    // Built-ins can be reset, but never removed (or relabeled as user presets).
    for (const preset of EXPORT_PRESETS) if (!ids.has(preset.id)) result.exportPresets.push(clone(preset));
    if (result.exportPresets.length > 100) throw new Error('Use at most 100 export presets including built-ins.');
  } else if (base === DEFAULTS && 'exportOptions' in value) {
    result.exportPresets.push({ id: 'migrated-last-export', name: 'My last export', options: clone(result.exportOptions), naming: clone(result.naming), subfolder: result.exportSubfolder, conflict: result.exportConflict, builtin: false });
  }
  return result;
}
module.exports = { COLORS, METADATA, NAMING, FOLDERS, DEFAULTS, BUILTINS, normalizeSettings, clone, text };
