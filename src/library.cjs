const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { mapLimit } = require('./queue.cjs');
const { DEFAULTS } = require('./preferences.cjs');
const { readXmp, writeXmp, atomicWrite, sidecarPaths, portableDevelop, resolveDevelop, shouldWriteSidecars } = require('./xmp.cjs');
const { developState, checkSettings } = require('./develop.cjs');

const RAW = new Set(['.arw', '.cr2', '.cr3', '.nef', '.nrw', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw', '.3fr', '.fff', '.iiq', '.rwl']);
const JPEG = new Set(['.jpg', '.jpeg']);
const SUPPORTED = new Set([...RAW, ...JPEG, '.png', '.webp', '.tif', '.tiff']);
const hash = s => createHash('sha256').update(s).digest('hex');
const filenameOrder = new Intl.Collator(undefined, { numeric: true });
const decision = (d = {}) => ({ flag: ['none', 'pick', 'reject'].includes(d.flag) ? d.flag : 'none',
  rating: Number.isInteger(d.rating) && d.rating >= 0 && d.rating <= 5 ? d.rating : 0,
  color: d.color === '' || /^[1-8]$/.test(d.color) ? d.color : null,
  // In PhotoCull's own Trash: hidden from the other views, still on disk.
  trashed: d.trashed === true });

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
        sidecar: sidecarPaths(f.path)[0], sidecars: sidecarPaths(f.path), modified: 0,
        flag: 'none', rating: 0, color: null, edited: false, source: raw ? 'Embedded RAW preview' : 'Original image' });
    }
  }
  return records.sort((a, b) => filenameOrder.compare(a.name, b.name) || a.path.localeCompare(b.path));
}

const developSummary = develop => ({ developed: !!develop?.tiff && !develop?.missing, externalEdit: !!develop?.editedBy && !develop?.missing, editedBy: develop?.editedBy ?? null, tiff: develop?.tiff ?? null, handoffMissing: !!develop?.missing, developRevision: develop?.revision ?? 0, recipe: develop?.recipe ?? null, adjusted: !!develop?.settings });

class Library {
  constructor(dataDir, { settings = () => DEFAULTS, recipeSettings = () => null, onWarning = () => {} } = {}) {
    this.settings = settings; this.recipeSettings = recipeSettings; this.onWarning = onWarning;
    this.dataDir = dataDir;
    this.sessions = new Map();
    this.writes = Promise.resolve();
    this.scanGeneration = 0;
    this.pendingSaves = new Map(); this.stats = { sessionWrites: 0, sidecarWrites: 0 };
    this.pendingSidecars = new Map(); this.sidecarWrites = Promise.resolve();
  }

  async scan(folder, recursive = false, { removable = false } = {}) {
    const generation = ++this.scanGeneration;
    await this.flushSidecars();
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
      try { const s = await fs.stat(f.path); return { ...f, size: s.size, mtimeMs: s.mtimeMs, fileId: `${s.dev}:${s.ino}` }; }
      catch (e) { warnings.push(`${f.name}: ${e.message}`); return null; }
    });
    const items = groupFiles(stats.filter(Boolean));
    let imported = false; const unsynced = [];
    const store = path.join(this.dataDir, 'sessions', hash(folder + ':' + recursive) + '.json');
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(store, 'utf8')).decisions ?? {}; }
    catch (e) { if (e.code !== 'ENOENT') warnings.push('Saved session could not be read; existing XMP will be used.'); }
    await mapLimit(items, 8, async item => {
      const cached = saved[item.id];
      const valid = cached?.fingerprint === item.fingerprint;
      if (valid) Object.assign(item, decision(cached), { modified: cached.modified || 0, edited: cached.edited ?? (cached.flag !== 'none' || cached.rating > 0), develop: developState(resolveDevelop(cached.develop, item.path, folder)) });
      const sidecars = [], existingSidecars = [];
      for (const file of item.sidecars) {
        try {
          const stat = await fs.lstat(file);
          existingSidecars.push({ file, modified: stat.mtimeMs });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Unsupported sidecar');
          const state = readXmp(await fs.readFile(file, 'utf8'), this.settings(), { portable: true });
          if (state.warning) warnings.push(`${item.name}: ${state.warning}`);
          if (state.develop) {
            try { if (state.develop.settings) state.develop.settings = checkSettings(state.develop.settings); }
            catch { delete state.develop; warnings.push(`${item.name}: Invalid PhotoCull develop settings in XMP; decisions were still imported.`); }
          }
          existingSidecars.at(-1).modified = Math.max(state.modified, stat.mtimeMs);
          sidecars.push({ file, state, modified: Math.max(state.modified, stat.mtimeMs) });
        } catch (e) { if (e.code !== 'ENOENT') warnings.push(`${item.name}: XMP could not be read (${path.basename(file)}).`); }
      }
      // Ties favor the cached session, then the Lightroom filename. Both naming
      // styles are read; future writes use the newest existing sidecar.
      sidecars.sort((a, b) => b.modified - a.modified || item.sidecars.indexOf(a.file) - item.sidecars.indexOf(b.file));
      existingSidecars.sort((a, b) => b.modified - a.modified || item.sidecars.indexOf(a.file) - item.sidecars.indexOf(b.file));
      if (existingSidecars.length) item.sidecar = existingSidecars[0].file;
      if (sidecars.length) {
        const winner = sidecars[0];
        if (!valid || winner.modified > item.modified) {
          const state = winner.state;
          Object.assign(item, decision({ ...item, ...state }), { modified: winner.modified });
          imported = true;
          if (Object.hasOwn(state, 'develop')) {
            const resolved = resolveDevelop(state.develop, item.path, folder);
            item.develop = developState(resolved);
          }
        }
      }
      if (valid && item.modified > (sidecars[0]?.modified || 0) && (item.edited || item.develop)) unsynced.push(item);
      if (item.develop?.tiff) item.develop.missing = !await fs.stat(item.develop.tiff).then(s => s.isFile(), () => false);
    });
    if (generation !== this.scanGeneration) throw new Error('Folder scan was superseded.');
    const root = await fs.stat(folder);
    const session = { id: randomUUID(), folder, folderId: `${root.dev}:${root.ino}`, items, byId: new Map(items.map(item => [item.id,item])), store, warnings, recursive, removable: !!removable, undo: [], redo: [] };
    // Image jobs already in flight retain their own file references.
    this.sessions.clear();
    this.sessions.set(session.id, session);
    if (imported) await this.save(session);
    if (unsynced.length) this.queueSidecars(session, unsynced);
    return this.publicSession(session);
  }

  publicSession(s) {
    return { id: s.id, folder: s.folder, items: s.items.map(({ id, name, size, raw, companion, flag, rating, color, trashed, source, edited, develop }) =>
      ({ id, name, size, raw, paired: !!companion, flag, rating, color, trashed, source, edited, ...developSummary(develop) })), warnings: s.warnings, recursive: s.recursive, removable: s.removable };
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
        [i.id, { ...decision(i), fingerprint: i.fingerprint, modified: i.modified, edited: i.edited, ...(i.develop ? { develop: portableDevelop(i.develop, i.path, s.folder) } : {}) }])) });
      await fs.mkdir(path.dirname(s.store), { recursive: true });
      await atomicWrite(s.store, data); this.stats.sessionWrites++;
    });
    this.pendingSaves.set(s.id, write); this.writes = write;
    return write;
  }

  sidecarItem(s, item) {
    const develop = item.develop ? { ...item.develop, settings: item.develop.settings ?? this.recipeSettings(item.develop.recipe) ?? null } : null;
    return { ...item, photoRoot: s.folder, develop };
  }

  changed(s, items) {
    for (const item of items) item.modified = Math.max(Date.now(), (item.modified || 0) + 1);
    this.queueSidecars(s, items);
  }

  queueSidecars(s, items) {
    for (const item of items) this.pendingSidecars.set(s.id + ':' + item.id, { s, item });
    clearTimeout(this.sidecarTimer);
    this.sidecarTimer = setTimeout(() => { void this.flushSidecars(); }, 250);
    this.sidecarTimer.unref?.();
  }

  async flushSidecars() {
    clearTimeout(this.sidecarTimer);
    const pending = [...this.pendingSidecars.values()]; this.pendingSidecars.clear();
    this.sidecarWrites = this.sidecarWrites.catch(() => {}).then(async () => {
      const owners = new Map();
      for (const { s } of pending) if (!owners.has(s.id)) {
        const counts = new Map();
        for (const item of s.items) counts.set(item.sidecar, (counts.get(item.sidecar) || 0) + 1);
        owners.set(s.id, counts);
      }
      await mapLimit(pending, 3, async ({ s, item }) => {
        if (!s.byId.has(item.id) || !shouldWriteSidecars(this.settings(), s.removable)) return;
        try {
          const root = await fs.stat(s.folder);
          if (`${root.dev}:${root.ino}` !== s.folderId || await fs.realpath(s.folder) !== s.folder) throw new Error('Photo folder changed; reopen it before writing XMP.');
          const source = await fs.lstat(item.path);
          if (!source.isFile() || source.isSymbolicLink() || `${source.dev}:${source.ino}` !== item.fileId || source.size !== item.size || source.mtimeMs !== item.mtimeMs) throw new Error('Photo changed; reopen it before writing XMP.');
          if (owners.get(s.id).get(item.sidecar) > 1) throw new Error('Multiple photos share this sidecar name.');
          await writeXmp(item.sidecar, this.sidecarItem(s, item), this.settings());
          this.stats.sidecarWrites++;
        } catch (e) {
          const warning = `${item.name}: XMP not written: ${e.message}`;
          if (!s.warnings.includes(warning)) { s.warnings.push(warning); this.onWarning({ session: s.id, message: warning }); }
        }
      });
    });
    return this.sidecarWrites;
  }

  async close() { await this.flushSidecars(); await this.writes; }

  // Develop state (see develop.cjs). Not part of undo: it is edited in the develop view, not by culling keys.
  developGet(sessionId, imageId) {
    const item = this.item(sessionId, imageId);
    return { id: item.id, name: item.name, raw: item.raw, ...(item.develop || { recipe: null, settings: null, tiff: null, editedBy: null }), edited: !!item.develop?.editedBy, missing: !!item.develop?.missing };
  }

  async developSet(sessionId, ids, { recipe = null, settings = null } = {}) {
    const s = this.get(sessionId);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100_000) throw new Error('Choose photos to develop.');
    if (recipe !== null && (typeof recipe !== 'string' || recipe.length > 80)) throw new Error('Unknown recipe.');
    settings = settings === null ? null : checkSettings(settings);
    const items = [...new Set(ids)].map(id => this.item(sessionId, id));
    for (const item of items) {
      const missing = item.develop?.missing;
      item.develop = developState({ ...item.develop, recipe, settings, tiff: item.develop?.tiff ?? null, editedBy: item.develop?.editedBy ?? null });
      if (item.develop && missing) item.develop.missing = true;
    }
    this.changed(s, items);
    await this.save(s);
    return { items: items.map(item => ({ id: item.id, ...developSummary(item.develop) })) };
  }

  // Called only by the shell after it writes a hand-off or detects an external save.
  async developMark(sessionId, imageId, { tiff, edited, editedBy, exported, exportedStamp: confirmedStamp } = {}) {
    const s = this.get(sessionId), item = this.item(sessionId, imageId);
    const next = { ...(item.develop || {}) };
    if (typeof tiff === 'string') { next.tiff = tiff; next.editedBy = null; next.exported = false; }
    if (editedBy) { next.editedBy = editedBy; next.exported = false; }
    else if (edited === true) { next.editedBy = 'dehancer'; next.exported = false; }
    if (exported === true) next.exported = true;
    next.revision = (item.develop?.revision || 0) + (exported === true ? 0 : 1);
    next.handoffs = [...(next.handoffs || [])];
    if (next.tiff) {
      const previous = next.handoffs.find(r => r.path === next.tiff);
      const realPath = typeof tiff !== 'string' && previous ? previous.realPath : await fs.realpath(next.tiff).catch(() => next.tiff);
      const stat = typeof tiff === 'string' || exported === true ? await fs.stat(next.tiff).catch(()=>null) : null;
      const stamp = stat ? {bytes:stat.size,mtime:stat.mtimeMs} : null;
      const exportedStamp = next.exported ? (confirmedStamp || stamp || previous?.exportedStamp || null) : null;
      const writtenStamp = typeof tiff === 'string' ? stamp : previous?.writtenStamp || null;
      const record = { path: next.tiff, realPath, editedBy: next.editedBy || null, exported: !!next.exported, exportedStamp, writtenStamp };
      next.handoffs = [...next.handoffs.filter(r => r.path !== next.tiff), record];
    }
    item.develop = developState(next);
    this.changed(s, [item]);
    await this.save(s);
    return { id: item.id, ...developSummary(item.develop) };
  }

  async decide(sessionId, imageId, patch) {
    const s = this.get(sessionId), item = this.item(sessionId, imageId);
    const before = decision(item), after = decision({ ...before, ...patch });
    s.undo.push({ id: item.id, before, after });
    if (s.undo.length > 500) s.undo.shift();
    s.redo = [];
    Object.assign(item, after, { edited: true });
    this.changed(s, [item]);
    await this.save(s);
    return { id: item.id, ...after, edited: true };
  }

  async decideMany(sessionId, ids, patch) {
    const s = this.get(sessionId);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100_000) throw new Error('Choose photos to edit.');
    const items = [...new Set(ids)].map(id => this.item(sessionId, id));
    const batch = items.map(item => {
      const before = decision(item), after = decision({ ...before, ...patch });
      return { id: item.id, before, after };
    });
    s.undo.push({ batch });
    if (s.undo.length > 500) s.undo.shift();
    s.redo = [];
    const result = batch.map(({ id, after }, index) => {
      Object.assign(items[index], after, { edited: true });
      return { id, ...after, edited: true };
    });
    this.changed(s, items);
    await this.save(s);
    return { items: result };
  }

  async history(sessionId, direction) {
    const s = this.get(sessionId);
    const from = direction === 'redo' ? s.redo : s.undo;
    const to = direction === 'redo' ? s.undo : s.redo;
    const action = from.pop();
    if (!action) return null;
    to.push(action);
    const items = (action.batch || [action]).map(entry => {
      const item = this.item(sessionId, entry.id);
      Object.assign(item, direction === 'redo' ? entry.after : entry.before, { edited: true });
      return { id: item.id, ...decision(item), edited: true };
    });
    this.changed(s, items.map(i => this.item(sessionId, i.id)));
    await this.save(s);
    return action.batch ? { items } : items[0];
  }

  async exportXmp(sessionId, settings = this.settings()) {
    await this.flushSidecars();
    const s = this.get(sessionId);
    // Snapshot decisions so keystrokes during export do not change the current batch.
    const items = s.items.filter(i => i.edited || i.modified && i.develop).map(i => this.sidecarItem(s, i));
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

  // Lists the files to delete for each photo, image first, so a failure there
  // leaves its companion untouched. Every file is checked against what the
  // scan saw: a swapped card or a folder replaced by a symlink must not let a
  // stale session delete files the user never reviewed. Changed photos are
  // returned in `skipped` and nothing of theirs is deleted.
  // XMP sidecars are listed separately with their owners, because same-stem
  // RAWs share one; delete a sidecar only once all its owners are gone.
  async deletionPlan(sessionId, ids) {
    await this.flushSidecars();
    const s = this.get(sessionId);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100_000) throw new Error('Choose photos to delete.');
    const changed = 'Changed since the folder was opened; open the folder again.';
    let root;
    try { root = await fs.stat(s.folder); if (await fs.realpath(s.folder) !== s.folder) root = null; } catch { root = null; }
    if (!root || `${root.dev}:${root.ino}` !== s.folderId) throw new Error('The photo folder has changed or is no longer available. Open it again.');
    const lstat = async file => { try { const stat = await fs.lstat(file); return stat.isFile() ? stat : null; } catch { return null; } };
    const unchanged = async item => {
      const dir = path.dirname(item.path);
      try { if (await fs.realpath(dir) !== dir) return false; } catch { return false; }
      const image = await lstat(item.path);
      if (!image || `${image.dev}:${image.ino}` !== item.fileId || image.size !== item.size || image.mtimeMs !== item.mtimeMs) return false;
      if (!item.companion) return true;
      const companion = await lstat(item.companion);
      return !companion || companion.size === item.companionSize && companion.mtimeMs === item.companionMtimeMs;
    };
    const doomed = [...new Set(ids)].map(id => this.item(sessionId, id));
    const checked = await mapLimit(doomed, 8, async item => ({ item, ok: await unchanged(item) }));
    const photos = [], skipped = [], deleting = new Set();
    for (const { item, ok } of checked) {
      if (!ok) { skipped.push({ id: item.id, name: item.name, reason: changed }); continue; }
      deleting.add(item.id);
      photos.push({ id: item.id, name: item.name, files: [item.path, ...(item.companion && await lstat(item.companion) ? [item.companion] : [])] });
    }
    const owners = new Map();
    for (const item of s.items) for (const file of item.sidecars) {
      if (!owners.has(file)) owners.set(file, []);
      owners.get(file).push(item.id);
    }
    const sidecars = [];
    for (const [file, ids] of owners) {
      // A sidecar still used by a photo that stays (or was skipped) is kept.
      if (ids.every(id => deleting.has(id)) && await lstat(file)) sidecars.push({ file, owners: ids });
    }
    return { folder: s.folder, removable: !!s.removable, photos, sidecars, skipped };
  }

  // Drops deleted photos from the session, its undo history and its saved decisions.
  async forget(sessionId, ids) {
    const s = this.get(sessionId), gone = new Set(ids);
    s.items = s.items.filter(item => !gone.has(item.id));
    for (const id of gone) s.byId.delete(id);
    const keep = actions => actions.flatMap(action => {
      if (!action.batch) return gone.has(action.id) ? [] : [action];
      const batch = action.batch.filter(entry => !gone.has(entry.id));
      return batch.length ? [{ batch }] : [];
    });
    s.undo = keep(s.undo); s.redo = keep(s.redo);
    await this.save(s);
    return { removed: [...gone] };
  }

  manifest(sessionId) {
    const s = this.get(sessionId);
    return { version: 1, folder: s.folder, created: new Date().toISOString(), images: s.items.map(i => ({
      file: i.path, companion: i.companion, sidecar: i.sidecar, ...decision(i) })) };
  }
}

module.exports = { Library, groupFiles, RAW, SUPPORTED, hash };
