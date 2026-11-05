const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./xmp.cjs');
const { DEFAULTS, BUILTINS, normalizeSettings, clone, text } = require('./preferences.cjs');
class SettingsStore {
  constructor(dataDir) {
    this.folder = path.join(dataDir, 'settings'); this.file = path.join(this.folder, 'settings.json');
    this.legacy = path.join(dataDir, 'settings.json'); this.presetsFolder = path.join(this.folder, 'presets');
    this.value = clone(DEFAULTS); this.presets = clone(BUILTINS); this.writes = Promise.resolve(); this.warning = '';
  }
  async init() {
    const migrate = input => {
      // Existing users who supplied a creator requested that metadata in copied files.
      if (!Object.hasOwn(input, 'copyMetadata') && input.metadata?.creator) input.copyMetadata = true;
      // WebP was always lossless before quality-based encoding was introduced.
      if (input.exportOptions?.format === 'webp' && !Object.hasOwn(input.exportOptions, 'webpLossless')) input.exportOptions.webpLossless = true;
      return normalizeSettings(input);
    };
    await fs.mkdir(this.presetsFolder, { recursive: true });
    try { this.value = migrate(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') {
        try { this.value = migrate(JSON.parse(await fs.readFile(this.legacy, 'utf8'))); }
        catch (legacyError) { if (legacyError.code !== 'ENOENT') this.warning = 'Previous settings could not be read.'; }
        await atomicWrite(this.file, JSON.stringify(this.value, null, 2));
      } else this.warning = 'Settings could not be read. Defaults loaded; existing file retained.';
    }
    for (const name of await fs.readdir(this.presetsFolder)) {
      if (!/^[\da-f-]{36}\.json$/i.test(name)) continue;
      try {
        const file = path.join(this.presetsFolder, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) continue;
        const preset = JSON.parse(await fs.readFile(file, 'utf8')), value = normalizeSettings(preset);
        this.presets.push({ id: name.slice(0, -5), name: text(preset.name, 80), metadata: value.metadata, colors: value.colors, naming: value.naming, folders: value.folders });
      } catch { this.warning = 'Some presets could not be read.'; }
    }
    if (!this.presets.some(p => p.id === this.value.activePreset)) { this.value.activePreset = 'standard'; this.warning ||= 'Active preset unavailable.'; }
    return this.snapshot();
  }
  snapshot() { return { ...clone(this.value), presets: clone(this.presets), folder: this.folder, warning: this.warning }; }
  serial(work) { const result = this.writes.catch(() => {}).then(work); this.writes = result; return result; }
  update(patch) {
    return this.serial(async () => {
      const value = normalizeSettings(patch, this.value);
      if (!this.presets.some(p => p.id === value.activePreset)) throw new Error('Unknown metadata preset.');
      await atomicWrite(this.file, JSON.stringify(value, null, 2)); this.value = value;
      return this.snapshot();
    });
  }
  savePreset(name, input) {
    return this.serial(async () => {
      name = text(name, 80); if (!name) throw new Error('Enter a preset name.');
      if (this.presets.some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Error('Preset name already exists.');
      const value = normalizeSettings(input), id = randomUUID();
      const preset = { id, name, metadata: value.metadata, colors: value.colors, naming: value.naming, folders: value.folders };
      await atomicWrite(path.join(this.presetsFolder, id + '.json'), JSON.stringify(preset, null, 2));
      this.presets.push(preset); return { preset: clone(preset), settings: this.snapshot() };
    });
  }
  removePreset(id) {
    return this.serial(async () => {
      if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('Built-in presets cannot be deleted.');
      const value = clone(this.value);
      if (value.activePreset === id) value.activePreset = 'standard';
      await atomicWrite(this.file, JSON.stringify(value, null, 2)); this.value = value;
      await fs.rm(path.join(this.presetsFolder, id + '.json'), { force: true });
      this.presets = this.presets.filter(p => p.id !== id); return this.snapshot();
    });
  }
}
module.exports = { SettingsStore };
