const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { mapLimit } = require('./queue.cjs');
const { DEFAULTS } = require('./preferences.cjs');
const { readXmp, writeXmp, atomicWrite } = require('./xmp.cjs');

const RAW = new Set(['.arw', '.cr2', '.cr3', '.nef', '.nrw', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw', '.3fr', '.fff', '.iiq', '.rwl']);
const JPEG = new Set(['.jpg', '.jpeg']);
const SUPPORTED = new Set([...RAW, ...JPEG, '.png', '.webp', '.tif', '.tiff']);
const hash = s => createHash('sha256').update(s).digest('hex');
const filenameOrder = new Intl.Collator(undefined, { numeric: true });
const decision = (d = {}) => ({ flag: ['none', 'pick', 'reject'].includes(d.flag) ? d.flag : 'none',
  rating: Number.isInteger(d.rating) && d.rating >= 0 && d.rating <= 5 ? d.rating : 0,
  color: d.color === '' || /^[1-8]$/.test(d.color) ? d.color : null });

function groupFiles(files) {
  const groups = new Map();
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase();
    // Pair only a RAW with a JPEG of the same stem, in the same directory.
    const pairable = RAW.has(ext) || JPEG.has(ext);
    const stem = path.basename(f.path, path.extname(f.path)).toLowerCase();
    const dir = process.platform === 'win32' ? path.dirname(f.path).toLowerCase() : path.dirname(f.path);
    const key = pairable ? path.join(dir, stem) : f.path;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const records = [];
  for (const group of groups.values()) {
    const raws = group.filter(f => RAW.has(path.extname(f.path).toLowerCase()));
    const jpgs = group.filter(f => JPEG.has(path.extname(f.path).toLowerCase()));
    const paired = raws.length === 1 && jpgs.length === 1 && group.length === 2;
    for (const f of paired ? raws : group) {
      const raw = RAW.has(path.extname(f.path).toLowerCase());
      const companion = paired ? jpgs[0] : null;
      records.push({ ...f, id: hash(f.path).slice(0, 24), raw,
        companion: companion?.path ?? null, companionSize: companion?.size, companionMtimeMs: companion?.mtimeMs,
        fingerprint: `${f.size}:${f.mtimeMs}:${companion?.size ?? ''}:${companion?.mtimeMs ?? ''}`,
        sidecar: raw ? f.path.slice(0, -path.extname(f.path).length) + '.xmp' : f.path + '.xmp',
        flag: 'none', rating: 0, color: null, edited: false, source: raw ? 'Embedded RAW preview' : 'Original image' });
    }
  }
  return records.sort((a, b) => filenameOrder.compare(a.name, b.name) || a.path.localeCompare(b.path));
}

class Library {
  constructor(dataDir, { settings = () => DEFAULTS } = {}) {
    this.settings = settings;
    this.dataDir = dataDir;
    this.sessions = new Map();
    this.writes = Promise.resolve();
    this.scanGeneration = 0;
    this.pendingSaves = new Map(); this.stats = { sessionWrites: 0 };
  }

  async scan(folder, recursive = false) {
    const generation = ++this.scanGeneration;
    folder = await fs.realpath(folder);
    if (!(await fs.stat(folder)).isDirectory()) throw new Error('Choose a folder of images.');
    const files = [], warnings = [];
    const visit = async dir => {
      if (generation !== this.scanGeneration) throw new Error('Folder scan was superseded.');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && recursive && !entry.name.startsWith('.')) {
          try { await visit(path.join(dir, entry.name)); } catch (e) {
            if (generation !== this.scanGeneration) throw e;
            warnings.push(`${entry.name}: ${e.message}`);
          }
        } else if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) {
          files.push({ path: path.join(dir, entry.name), name: entry.name });
        }
      }
    };
    await visit(folder);
    const stats = await mapLimit(files, 8, async f => {
      try { const s = await fs.stat(f.path); return { ...f, size: s.size, mtimeMs: s.mtimeMs }; }
      catch (e) { warnings.push(`${f.name}: ${e.message}`); return null; }
    });
    const items = groupFiles(stats.filter(Boolean));
    const store = path.join(this.dataDir, 'sessions', hash(folder + ':' + recursive) + '.json');
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(store, 'utf8')).decisions ?? {}; }
    catch (e) { if (e.code !== 'ENOENT') warnings.push('Saved session could not be read; existing XMP will be used.'); }
    await mapLimit(items, 8, async item => {
      const cached = saved[item.id];
      if (cached?.fingerprint === item.fingerprint) Object.assign(item, decision(cached), { edited: cached.edited ?? (cached.flag !== 'none' || cached.rating > 0) });
      else {
        try {
          const stat = await fs.lstat(item.sidecar);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Unsupported sidecar');
          Object.assign(item, readXmp(await fs.readFile(item.sidecar, 'utf8'), this.settings()));
        } catch (e) { if (e.code !== 'ENOENT') warnings.push(`${item.name}: XMP could not be read.`); }
      }
    });
    if (generation !== this.scanGeneration) throw new Error('Folder scan was superseded.');
    const session = { id: randomUUID(), folder, items, byId: new Map(items.map(item => [item.id,item])), store, warnings, recursive, undo: [], redo: [] };
    // Image jobs already in flight retain their own file references.
    this.sessions.clear();
    this.sessions.set(session.id, session);
    return this.publicSession(session);
  }

  publicSession(s) {
    return { id: s.id, folder: s.folder, items: s.items.map(({ id, name, size, raw, companion, flag, rating, color, source, edited }) =>
      ({ id, name, size, raw, paired: !!companion, flag, rating, color, source, edited })), warnings: s.warnings, recursive: s.recursive };
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('This folder session has closed.');
    return s;
  }

  item(session, id) {
    const item = this.get(session).byId.get(id);
    if (!item) throw new Error('Image is not in this folder session.');
    return item;
  }

  save(s) {
    // Coalesce decisions made before this session's queued write starts. Every
    // caller still awaits a durable snapshot containing its change.
    const pending = this.pendingSaves.get(s.id);
    if (pending) return pending;
    const write = this.writes.catch(() => {}).then(async () => {
      this.pendingSaves.delete(s.id);
      const data = JSON.stringify({ version: 1, folder: s.folder, decisions: Object.fromEntries(s.items.map(i =>
        [i.id, { ...decision(i), fingerprint: i.fingerprint, edited: i.edited }])) });
      await fs.mkdir(path.dirname(s.store), { recursive: true });
      await atomicWrite(s.store, data); this.stats.sessionWrites++;
    });
    this.pendingSaves.set(s.id, write); this.writes = write;
    return write;
  }

  async decide(sessionId, imageId, patch) {
    const s = this.get(sessionId), item = this.item(sessionId, imageId);
    const before = decision(item), after = decision({ ...before, ...patch });
    s.undo.push({ id: item.id, before, after });
    if (s.undo.length > 500) s.undo.shift();
    s.redo = [];
    Object.assign(item, after, { edited: true });
    await this.save(s);
    return { id: item.id, ...after, edited: true };
  }

  async history(sessionId, direction) {
    const s = this.get(sessionId);
    const from = direction === 'redo' ? s.redo : s.undo;
    const to = direction === 'redo' ? s.undo : s.redo;
    const action = from.pop();
    if (!action) return null;
    to.push(action);
    const item = this.item(sessionId, action.id);
    Object.assign(item, direction === 'redo' ? action.after : action.before, { edited: true });
    await this.save(s);
    return { id: item.id, ...decision(item), edited: true };
  }

  async exportXmp(sessionId, settings = this.settings()) {
    const s = this.get(sessionId);
    // Snapshot decisions so keystrokes during export do not change the current batch.
    const items = s.items.filter(i => i.edited).map(i => ({ ...i, ...decision(i) }));
    const failures = [], paths = new Map();
    // A same-stem second RAW format must never silently overwrite another decision.
    for (const item of s.items) {
      const count = (paths.get(item.sidecar) ?? 0) + 1;
      paths.set(item.sidecar, count);
    }
    let written = 0;
    await mapLimit(items, 3, async item => {
      try {
        if (paths.get(item.sidecar) > 1) throw new Error('Multiple RAWs share this sidecar name; rename them before exporting.');
        await writeXmp(item.sidecar, item, settings);
        written++;
      } catch (e) { failures.push({ name: item.name, reason: e.message }); }
    });
    return { written, failures };
  }

  manifest(sessionId) {
    const s = this.get(sessionId);
    return { version: 1, folder: s.folder, created: new Date().toISOString(), images: s.items.map(i => ({
      file: i.path, companion: i.companion, sidecar: i.sidecar, ...decision(i) })) };
  }
}

module.exports = { Library, groupFiles, RAW, SUPPORTED, hash };
