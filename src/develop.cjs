// Develop recipes and per-photo develop state. Rendering happens in the Tauri shell (src-tauri/src/develop.rs,
// Lightcraft's engine); this side stores what to render and plans where exports go.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./xmp.cjs');
const { normalizeSettings } = require('./preferences.cjs');
const { renderName, needsCapture } = require('./renderer/naming.js');

// Recipes hold partial Lightcraft develop settings (crates/develop/src/settings.rs field names), applied over
// PhotoCull's base: Lightcraft's raw defaults with sharpening and noise reduction off and the lens profile on.
const BUILTIN_RECIPES = [
  { id: 'neutral', name: 'Neutral', builtin: true, settings: { profile: { id: 'lc.neutral' } } },
  { id: 'camera', name: 'Camera look', builtin: true, settings: { profile: { id: 'lc.color' } } },
  // Derived from Dehancer's ACR quick guide; adjusted for Lightcraft's tone mapping (see docs/recipes-export.md).
  { id: 'dehancer-guide', name: 'Flat base (for film emulation)', builtin: true,
    settings: { profile: { id: 'lc.color' }, light: { exposure: 0, contrast: -25, highlights: -30, blacks: 25 } } },
];
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_RECIPE_FILE_BYTES = 1024 * 1024;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

function checkSettings(settings) {
  if (!isObject(settings)) throw new Error('Invalid develop settings.');
  const visit = (value, depth = 0) => {
    if (depth > 24 || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid develop settings.');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid develop settings key.');
        visit(child, depth + 1);
      }
    } else if (value !== null && !['number', 'boolean', 'string'].includes(typeof value)) throw new Error('Invalid develop settings.');
  };
  visit(settings);
  if (Buffer.byteLength(JSON.stringify(settings)) > MAX_SETTINGS_BYTES) throw new Error('Develop settings are too large.');
  if ('light' in settings && !isObject(settings.light)) throw new Error('Invalid light settings.');
  for (const [key, min, max] of [['exposure', -5, 5], ...['contrast','highlights','shadows','whites','blacks'].map(k => [k, -100, 100])]) {
    if (settings.light && key in settings.light && (!Number.isFinite(settings.light[key]) || settings.light[key] < min || settings.light[key] > max)) throw new Error('Invalid light adjustment.');
  }
  return structuredClone(settings);
}

function checkName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new Error('Enter a recipe name.');
  return name.trim();
}

class RecipeStore {
  constructor(settingsFolder) {
    this.folder = path.join(settingsFolder, 'recipes');
    this.user = [];
    this.warning = '';
  }

  async init() {
    await fs.mkdir(this.folder, { recursive: true });
    for (const name of await fs.readdir(this.folder)) {
      if (!/^[\da-f-]{36}\.json$/i.test(name)) continue;
      try {
        const file = path.join(this.folder, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES * 2) continue;
        const recipe = JSON.parse(await fs.readFile(file, 'utf8'));
        this.user.push({ id: name.slice(0, -5), name: checkName(recipe.name), settings: checkSettings(recipe.settings) });
      } catch { this.warning = 'Some develop recipes could not be read.'; }
    }
    this.user.sort((a, b) => a.name.localeCompare(b.name));
  }

  list() { return [...structuredClone(BUILTIN_RECIPES), ...structuredClone(this.user)]; }

  get(id) { return this.list().find(recipe => recipe.id === id) || null; }

  async save({ id, name, settings }) {
    name = checkName(name); settings = checkSettings(settings);
    if (BUILTIN_RECIPES.some(r => r.id === id)) throw new Error('Built-in recipes cannot be changed. Save a new recipe instead.');
    if (id !== undefined && id !== null && !/^[\da-f-]{36}$/i.test(id)) throw new Error('Unknown recipe.');
    if (this.list().some(r => r.id !== id && r.name.toLowerCase() === name.toLowerCase())) throw new Error('A recipe with that name already exists.');
    const recipe = { id: id || randomUUID(), name, settings };
    await atomicWrite(path.join(this.folder, recipe.id + '.json'), JSON.stringify(recipe, null, 2));
    this.user = [...this.user.filter(r => r.id !== recipe.id), recipe].sort((a, b) => a.name.localeCompare(b.name));
    return structuredClone(recipe);
  }

  uniqueName(name) {
    name = checkName(name); let candidate = name;
    for (let n = 2; this.list().some(r => r.name.toLowerCase() === candidate.toLowerCase()); n++) candidate = `${name.slice(0, 72)} (${n})`;
    return candidate;
  }

  async duplicate(id) {
    const recipe = this.get(id); if (!recipe) throw new Error('Unknown recipe.');
    return this.save({ name: this.uniqueName(recipe.name), settings: recipe.settings });
  }

  async importFile(file) {
    checkRecipePath(file);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECIPE_FILE_BYTES) throw new Error('Recipe file is too large or is not a regular file.');
    const rows = parseRecipeFile(await fs.readFile(file, 'utf8'));
    const saved = [];
    for (const row of rows) saved.push(await this.save({ name: this.uniqueName(row.name), settings: row.settings }));
    return saved;
  }

  async exportFile(file, id = null) {
    checkRecipePath(file);
    const rows = id ? [this.get(id)] : this.user;
    if (rows.length > 100) throw new Error('Use at most 100 recipes per bundle.');
    if (rows.some(r => !r)) throw new Error('Unknown recipe.');
    const recipe = r => ({ type: 'photocull-recipe', version: 1, name: r.name, settings: checkSettings(r.settings) });
    const data = JSON.stringify(id ? recipe(rows[0]) : { type: 'photocull-recipe-bundle', version: 1, recipes: rows.map(recipe) }, null, 2);
    if (Buffer.byteLength(data) > MAX_RECIPE_FILE_BYTES) throw new Error('Recipe bundle is too large. Export recipes separately.');
    const stat = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Choose a regular recipe file.');
    await atomicWrite(file, data);
    return file;
  }

  async remove(id) {
    if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('Built-in recipes cannot be deleted.');
    await fs.rm(path.join(this.folder, id + '.json'), { force: true });
    this.user = this.user.filter(r => r.id !== id);
  }
}

function checkRecipePath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.photocull-recipe.json')) throw new Error('Choose a .photocull-recipe.json file.');
}
function parseRecipeFile(data) {
  if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_RECIPE_FILE_BYTES) throw new Error('Recipe file is too large.');
  const value = JSON.parse(data);
  if (!isObject(value) || value.version !== 1) throw new Error('Unsupported recipe version.');
  const rows = value.type === 'photocull-recipe-bundle' ? value.recipes : [value];
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Use at most 100 recipes per bundle.');
  return rows.map(r => {
    if (!isObject(r) || r.type !== 'photocull-recipe' || r.version !== 1) throw new Error('Invalid recipe schema.');
    return { name: checkName(r.name), settings: checkSettings(r.settings) };
  });
}

// Per-photo develop state as stored in the session: the recipe it started from, its own settings (null = the
// recipe's), the developed TIFF and whether Dehancer saved an edit into it.
function developState(input) {
  if (!isObject(input)) return null;
  const state = {
    recipe: typeof input.recipe === 'string' && input.recipe.length <= 80 ? input.recipe : null,
    settings: isObject(input.settings) ? input.settings : null,
    tiff: typeof input.tiff === 'string' && path.isAbsolute(input.tiff) ? input.tiff : null,
    edited: input.edited === true,
    revision: Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
  };
  return state.recipe || state.settings || state.tiff ? state : null;
}

// Destination paths for an export: the naming template, an extension, an optional subfolder, and unique names
// when asked ("unique" adds -2, -3 … to names that exist or repeat; otherwise duplicates are reported).
async function planExport(items, input) {
  if (input.preset) {
    const preset = normalizeSettings({ exportPresets: [input.preset] }).exportPresets.find(p => p.id === input.preset.id);
    input = { naming: preset.naming, subfolder: preset.subfolder, conflict: preset.conflict, extension: require('./renderer/export.js').FORMATS[preset.options.format].extension, ...input };
  }
  let { folder, naming, subfolder = '', extension, conflict = 'unique', captureDate, protectedPaths = [] } = input;
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose an export folder.');
  if (!['jpg', 'jxl', 'tif', 'png', 'avif', 'webp'].includes(extension)) throw new Error('Invalid export format.');
  if (!['unique', 'skip', 'overwrite'].includes(conflict)) throw new Error('Invalid conflict option.');
  naming = normalizeSettings({ naming: naming || {} }).naming;
  subfolder = normalizeSettings({ folders: { mode: subfolder ? 'named' : 'flat', name: subfolder } }).folders.name;
  const dir = subfolder ? path.join(folder, subfolder) : folder;
  const key = file => path.resolve(file).toLowerCase();
  const sourcePaths = [...new Set([...protectedPaths, ...items.flatMap(i => [i.path, i.companion, i.develop?.tiff])].filter(Boolean))];
  const sources = new Set(sourcePaths.map(key));
  // Sources and destinations must use the same resolved parents (e.g. /var -> /private/var on macOS).
  for (const file of sourcePaths) {
    try { sources.add(key(await fs.realpath(file))); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      try { sources.add(key(path.join(await fs.realpath(path.dirname(file)), path.basename(file)))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  const now = new Date(), taken = new Map(), plan = [];
  const stat = async file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  // Resolve the existing parent to detect output folders aliased onto a source folder.
  let realDir;
  try { realDir = await fs.realpath(dir); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try { realDir = path.join(await fs.realpath(folder), subfolder); } catch (e) { if (e.code !== 'ENOENT') throw e; realDir = dir; }
  }
  const diskNames = new Map((await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).map(name => [key(path.join(dir, name)), path.join(dir, name)]));
  for (const [index, item] of items.entries()) {
    const row = { id: item.id, name: item.name };
    try {
      const captured = needsCapture(naming.template) ? await captureDate(item) : null;
      const { stem } = renderName(item.name, naming, index, { captured, now });
      let dest = path.join(dir, `${stem}.${extension}`);
      const occupied = async file => taken.has(key(file)) || sources.has(key(file)) || sources.has(key(path.join(realDir, path.basename(file)))) || diskNames.has(key(file)) || !!await stat(file);
      if (conflict === 'unique') for (let n = 2; await occupied(dest); n++) dest = path.join(dir, `${stem}-${n}.${extension}`);
      row.dest = dest;
      if (sources.has(key(dest)) || sources.has(key(path.join(realDir, path.basename(dest))))) throw new Error('Export would replace a source image or developed TIFF. Choose another folder or name.');
      const previous = taken.get(key(dest));
      if (previous) {
        previous.error = `Two photos would both be named ${path.basename(dest)}.`;
        throw new Error(previous.error);
      }
      taken.set(key(dest), row);
      if (diskNames.has(key(dest))) row.dest = dest = diskNames.get(key(dest));
      const existing = await stat(dest);
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Destination is not a regular file.');
      if (existing && conflict === 'skip') { row.skip = true; row.reason = 'Already exists'; }
    } catch (error) { row.error = error.message; }
    plan.push(row);
  }
  return plan;
}

module.exports = { RecipeStore, BUILTIN_RECIPES, developState, checkSettings, parseRecipeFile, planExport };
