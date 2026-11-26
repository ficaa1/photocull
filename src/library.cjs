const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { mapLimit } = require('./queue.cjs');
const { descriptive, textFields } = require('./renderer/metadata-filter.js');
const { DEFAULTS, text } = require('./preferences.cjs');
const { readXmp, writeXmp, atomicWrite, sidecarPaths, portableDevelop, resolveDevelop, shouldWriteSidecars, normalizeCaptureMetadata } = require('./xmp.cjs');
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
// Structured failures carry a stable code for the tether bridge; `message` stays readable.
const coded = (code, message, extra = {}) => Object.assign(new Error(message), { code, detail: { code, message, retryable: false, ...extra } });
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };

// Excluded files were proven to belong to a different exposure and always stand alone. An entry
// names the file it saw (`dev:ino`), so a different file later saved under that path pairs normally;
// a file whose identity is unknown stays excluded.
function exclusionMap(entries = []) {
  const map = new Map();
  for (const entry of entries) {
    if (typeof entry === 'string') map.set(entry, null);
    else if (typeof entry?.path === 'string') map.set(entry.path, typeof entry.fileId === 'string' ? entry.fileId : null);
  }
  return map;
}
function excluded(file, exclude, fileId) {
  if (!exclude?.has(file)) return false;
  const id = exclude instanceof Map ? exclude.get(file) : null;
  return !id || !fileId || id === fileId;
}

// Pair only a RAW with a JPEG of the same stem, in the same directory.
function groupKey(file, exclude, fileId) {
  const ext = path.extname(file).toLowerCase();
  if (!(RAW.has(ext) || JPEG.has(ext)) || excluded(file, exclude, fileId)) return file;
  const dir = process.platform === 'win32' ? path.dirname(file).toLowerCase() : path.dirname(file);
  return path.join(dir, path.basename(file, path.extname(file)).toLowerCase());
}

function groupFiles(files, { exclude } = {}) {
  const groups = new Map();
  for (const f of files) {
    const key = groupKey(f.path, exclude, f.fileId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const records = [];
  for (const [key, group] of groups) {
    const raws = group.filter(f => RAW.has(path.extname(f.path).toLowerCase()));
    const jpgs = group.filter(f => JPEG.has(path.extname(f.path).toLowerCase()));
    const paired = raws.length === 1 && jpgs.length === 1 && group.length === 2;
    for (const f of paired ? raws : group) {
      const raw = RAW.has(path.extname(f.path).toLowerCase());
      const companion = paired ? jpgs[0] : null;
      records.push({ ...f, id: hash(f.path).slice(0, 24), raw, group: key,
        companion: companion?.path ?? null, companionSize: companion?.size, companionMtimeMs: companion?.mtimeMs,
        fingerprint: `${f.size}:${f.mtimeMs}:${companion?.size ?? ''}:${companion?.mtimeMs ?? ''}`,
        sidecar: sidecarPaths(f.path)[0], sidecars: sidecarPaths(f.path), modified: 0,
        flag: 'none', rating: 0, color: null, edited: false, source: raw ? 'Embedded RAW preview' : 'Original image' });
    }
  }
  return records.sort(itemOrder);
}
const itemOrder = (a, b) => filenameOrder.compare(a.name, b.name) || a.path.localeCompare(b.path);
function insertSorted(items, item) {
  let low = 0, high = items.length;
  while (low < high) { const mid = (low + high) >> 1; if (itemOrder(items[mid], item) <= 0) low = mid + 1; else high = mid; }
  items.splice(low, 0, item);
}
function captureMetadata(value) { try { return value ? normalizeCaptureMetadata(value) : undefined; } catch { return undefined; } }
const captureState = c => ({ exposureId: typeof c.exposureId === 'string' ? c.exposureId : undefined, ordinal: Number.isSafeInteger(c.ordinal) ? c.ordinal : undefined,
  contentRev: Number.isSafeInteger(c.contentRev) && c.contentRev > 0 ? c.contentRev : 0, captureMetadata: captureMetadata(c.captureMetadata), captureDevelop: c.captureDevelop === true });
const metadataState = item => Object.hasOwn(item, 'metadataOverrides') ? { metadataOverrides: item.metadataOverrides } : {};
const restore = (item, cached, folder) => Object.assign(item, decision(cached), captureState(cached), metadataState(cached), {
  modified: cached.modified || 0, edited: cached.edited ?? (cached.flag !== 'none' || cached.rating > 0),
  develop: developState(resolveDevelop(cached.develop, item.path, folder)), observedMetadata: cached.observedMetadata,
  sidecarMetadata: Object.hasOwn(cached, 'metadataOverrides') ? cached.sidecarMetadata : item.sidecarMetadata
});
function mergeXmpMetadata(item, cached, incoming) {
  const remote = incoming.metadata || {}, overrides = { ...incoming.metadataOverrides };
  const baseline = cached?.observedMetadata || cached?.sidecarMetadata || {};
  let unsynced = false;
  for (const [key, local] of Object.entries(cached?.metadataOverrides || {})) {
    const previous = key === 'creator' ? baseline.creators || baseline.creator : baseline[key];
    const current = key === 'creator' ? remote.creators || remote.creator : remote[key];
    if (JSON.stringify(current) === JSON.stringify(previous) || JSON.stringify(current) === JSON.stringify(local)) {
      overrides[key] = local;
      if (JSON.stringify(local) !== JSON.stringify(remote[key])) unsynced = true;
    }
  }
  item.sidecarMetadata = remote;
  item.observedMetadata = remote;
  if (Object.keys(overrides).length) item.metadataOverrides = overrides;
  else delete item.metadataOverrides;
  return unsynced;
}

// Session JSON fields that tie a photo to a tethered exposure.
const captureFields = i => ({ ...(i.exposureId ? { exposureId: i.exposureId, ordinal: i.ordinal } : {}), ...(i.contentRev ? { contentRev: i.contentRev } : {}),
  ...(i.captureMetadata ? { captureMetadata: i.captureMetadata } : {}), ...(i.captureDevelop ? { captureDevelop: true } : {}) });
function indexItem(s, item) {
  s.byPath.set(item.path, item.id);
  if (item.companion) s.byPath.set(item.companion, item.id);
  if (!s.byGroup.has(item.group)) s.byGroup.set(item.group, new Set());
  s.byGroup.get(item.group).add(item.id);
}
function unindexItem(s, item) {
  for (const file of [item.path, item.companion]) if (file && s.byPath.get(file) === item.id) s.byPath.delete(file);
  s.byGroup.get(item.group)?.delete(item.id);
  if (!s.byGroup.get(item.group)?.size) s.byGroup.delete(item.group);
}

const developSummary = develop => ({ developed: !!develop?.tiff && !develop?.missing, externalEdit: !!develop?.editedBy && !develop?.missing, editedBy: develop?.editedBy ?? null, tiff: develop?.tiff ?? null, handoffLinked: !!develop?.handoffs.some(r => r.path === develop.tiff && r.linked), handoffMissing: !!develop?.missing, developRevision: develop?.revision ?? 0, recipe: develop?.recipe ?? null, adjusted: !!develop?.settings });

class Library {
  constructor(dataDir, { settings = () => DEFAULTS, recipeSettings = () => null, onWarning = () => {}, keepSessions = 1, linkedHandoffs = () => new Set(), pairingExclusions = () => [], captureExposure = () => null, embeddedMetadata = async () => ({}), cardRoots = async () => [] } = {}) {
    // The desktop app has one open folder. The server keeps several, one per
    // folder, with a stable id so every browser shares it.
    this.keepSessions = keepSessions; this.embeddedMetadata = embeddedMetadata; this.cardRoots = cardRoots;
    this.settings = settings; this.recipeSettings = recipeSettings; this.onWarning = onWarning; this.linkedHandoffs = linkedHandoffs; this.pairingExclusions = pairingExclusions; this.captureExposure = captureExposure;
    this.ingests = Promise.resolve();
    this.dataDir = dataDir;
    this.sessions = new Map();
    this.writes = Promise.resolve();
    this.scanGeneration = 0;
    this.pendingSaves = new Map(); this.stats = { sessionWrites: 0, sidecarWrites: 0 };
    this.pendingSidecars = new Map(); this.sidecarWrites = Promise.resolve();
  }

  async scan(folder, recursive = false, { removable = false } = {}) {
    const generation = ++this.scanGeneration;
    const superseded = () => this.keepSessions === 1 && generation !== this.scanGeneration;
    await this.flushSidecars();
    folder = await fs.realpath(folder);
    if (!(await fs.stat(folder)).isDirectory()) throw new Error('Choose a folder of images.');
    const files = [], warnings = [];
    let protectedRoots = [];
    try { protectedRoots = await this.cardRoots(); }
    catch { warnings.push('Camera card detection unavailable. Source XMP autosave waits for card detection.'); }
    removable ||= protectedRoots.some(root => inside(root, folder));
    const visit = async dir => {
      if (superseded()) throw new Error('Folder scan was superseded.');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && recursive && !entry.name.startsWith('.')) {
          try { await visit(path.join(dir, entry.name)); } catch (e) {
            if (superseded()) throw e;
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
    const items = groupFiles(stats.filter(Boolean), { exclude: exclusionMap(this.pairingExclusions(folder)) });
    let imported = false; const unsynced = [];
    const store = path.join(this.dataDir, 'sessions', hash(folder + ':' + recursive) + '.json');
    const existing = [...this.sessions.values()].find(s => s.store === store);
    const previous = this.keepSessions > 1 ? existing : null;
    if (existing) await this.writes.catch(() => {});
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(store, 'utf8')).decisions ?? {}; }
    catch (e) { if (e.code !== 'ENOENT') warnings.push('Saved session could not be read; existing XMP will be used.'); }
    await mapLimit(items, 8, async item => {
      item.removable = removable || protectedRoots.some(root => inside(root, item.path));
      let needsMetadataSync = false;
      let cached = saved[item.id], valid = cached?.fingerprint === item.fingerprint;
      // A RAW published after its JPEG but before the session save still owns the JPEG's capture decisions.
      const provisional = !valid && item.companion ? saved[hash(item.companion).slice(0, 24)] : null;
      if (provisional?.exposureId && provisional.fingerprint === `${item.companionSize}:${item.companionMtimeMs}::`) { cached = { ...provisional, contentRev: (provisional.contentRev || 0) + 1 }; valid = true; }
      // Likewise a RAW saved alone keeps its decisions once the tether proves the new JPEG is the same exposure.
      else if (!valid && item.companion && cached?.exposureId && cached.fingerprint === `${item.size}:${item.mtimeMs}::`
        && this.captureExposure({ path: item.companion, size: item.companionSize }) === cached.exposureId) { cached = { ...cached, contentRev: (cached.contentRev || 0) + 1 }; valid = true; }
      if (valid) restore(item, cached, folder);
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
          needsMetadataSync = mergeXmpMetadata(item, valid ? cached : null, state);
          if (state.captureMetadata) item.captureMetadata = state.captureMetadata;
          imported = true;
          if (Object.hasOwn(state, 'develop')) {
            const resolved = resolveDevelop(state.develop, item.path, folder);
            item.develop = developState(resolved);
          }
        } else if (!Object.hasOwn(cached, 'metadataOverrides')) item.sidecarMetadata = winner.state.metadata;
      }
      const ahead = valid && item.modified > (sidecars[0]?.modified || 0);
      if (!item.removable && (needsMetadataSync || ahead && (item.edited || item.develop || item.captureMetadata || Object.hasOwn(item, 'metadataOverrides')))) unsynced.push(item);
      if (item.develop?.tiff) item.develop.missing = !await fs.stat(item.develop.tiff).then(s => s.isFile(), () => false);
    });
    if (superseded()) throw new Error('Folder scan was superseded.');
    const root = await fs.stat(folder);
    const session = { id: previous?.id ?? randomUUID(), folder, folderId: `${root.dev}:${root.ino}`, items, byId: new Map(items.map(item => [item.id,item])), store, warnings, recursive, removable: !!removable, undo: [], redo: [], linkedPaths: this.linkedHandoffs(),
      rev: 0, aliases: new Map(), byPath: new Map(), byGroup: new Map() };
    for (const item of items) indexItem(session, item);
    // Image jobs already in flight retain their own file references.
    this.sessions.delete(previous?.id);
    while (this.sessions.size >= this.keepSessions) this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(session.id, session);
    if (imported) await this.save(session);
    if (unsynced.length) this.queueSidecars(session, unsynced);
    return this.publicSession(session);
  }

  publicItem({ id, name, size, raw, companion, flag, rating, color, trashed, source, edited, develop, contentRev, exposureId, ordinal, captureMetadata, sidecarMetadata, metadataOverrides }) {
    return { id, name, size, raw, paired: !!companion, flag, rating, color, trashed, source, edited, ...developSummary(develop), contentRev: contentRev || 0,
      ...(sidecarMetadata ? { sidecarMetadata } : {}), ...(metadataOverrides !== undefined ? { metadataOverrides } : {}),
      ...(exposureId ? { exposureId, ordinal } : {}), ...(captureMetadata ? { captureMetadata } : {}) };
  }

  publicSession(s) {
    return { id: s.id, folder: s.folder, items: s.items.map(item => this.publicItem(item)), warnings: s.warnings, recursive: s.recursive, removable: s.removable };
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw coded('STALE_SESSION', 'This folder session has closed.');
    return s;
  }

  // A provisional JPEG ID keeps resolving to its RAW after a remap, so edits already in flight land on the right photo.
  item(session, id) {
    const s = this.get(session), item = s.byId.get(id) ?? s.byId.get(s.aliases.get(id));
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
        [i.id, {
          ...decision(i), path: path.relative(s.folder, i.path), fingerprint: i.fingerprint, modified: i.modified,
          edited: i.edited, observedMetadata: Object.hasOwn(i, 'metadataOverrides') ? i.observedMetadata : undefined, ...captureFields(i), ...metadataState(i),
          sidecarMetadata: Object.hasOwn(i, 'metadataOverrides') ? i.sidecarMetadata : undefined,
          ...(i.develop ? { develop: portableDevelop(i.develop, i.path, s.folder) } : {})
        }])) });
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
    for (const item of items) if (!s.removable && !item.removable) this.pendingSidecars.set(s.id + ':' + item.id, { s, item });
    clearTimeout(this.sidecarTimer);
    this.sidecarTimer = setTimeout(() => { void this.flushSidecars(); }, 250);
    this.sidecarTimer.unref?.();
  }

  async flushSidecars() {
    clearTimeout(this.sidecarTimer);
    const pending = [...this.pendingSidecars.values()]; this.pendingSidecars.clear();
    this.sidecarWrites = this.sidecarWrites.catch(() => {}).then(async () => {
      if (!pending.length || !shouldWriteSidecars(this.settings(), false)) return;
      let protectedRoots;
      try { protectedRoots = await this.cardRoots(); }
      catch {
        for (const s of new Set(pending.map(job => job.s))) this.onWarning({ session: s.id, message: 'Could not check camera cards. Source XMP autosave skipped.' });
        return;
      }
      const owners = new Map(), updated = new Set();
      for (const { s } of pending) if (!owners.has(s.id)) {
        const counts = new Map();
        for (const item of s.items) counts.set(item.sidecar, (counts.get(item.sidecar) || 0) + 1);
        owners.set(s.id, counts);
      }
      await mapLimit(pending, 3, async ({ s, item }) => {
        const onCard = s.removable || item.removable || protectedRoots.some(root => inside(root, item.path));
        if (!s.byId.has(item.id) || !shouldWriteSidecars(this.settings(), onCard)) return;
        try {
          const root = await fs.stat(s.folder);
          if (`${root.dev}:${root.ino}` !== s.folderId || await fs.realpath(s.folder) !== s.folder) throw new Error('Photo folder changed; reopen it before writing XMP.');
          const source = await fs.lstat(item.path);
          if (!source.isFile() || await fs.realpath(item.path) !== item.path || `${source.dev}:${source.ino}` !== item.fileId || source.size !== item.size || source.mtimeMs !== item.mtimeMs) throw new Error('Photo changed; reopen it before writing XMP.');
          if (owners.get(s.id).get(item.sidecar) > 1) throw new Error('Multiple photos share this sidecar name.');
          const snapshot = this.sidecarItem(s, item);
          item.observedMetadata = await writeXmp(item.sidecar, snapshot, this.settings());
          if (Object.hasOwn(item, 'metadataOverrides')) updated.add(s);
          else item.sidecarMetadata = item.observedMetadata;
          this.stats.sidecarWrites++;
        } catch (e) {
          const warning = `${item.name}: XMP not written: ${e.message}`;
          if (!s.warnings.includes(warning)) { s.warnings.push(warning); this.onWarning({ session: s.id, message: warning }); }
        }
      });
      for (const session of updated) {
        try { await this.save(session); }
        catch (error) { this.onWarning({ session: session.id, message: `Could not save synchronized metadata: ${error.message}` }); }
      }
    });
    return this.sidecarWrites;
  }

  async close() { await this.flushSidecars(); await this.writes; }

  // Opens a folder for tethering without rescanning a session that already covers it. Widening a
  // nonrecursive session to recursive carries its decisions by verified path and fingerprint,
  // including ones only ever stored in the session file (writeSidecars: never).
  async openEmptyOrExisting(folder, recursive = false, { removable = false } = {}) {
    folder = await fs.realpath(folder);
    const covering = [...this.sessions.values()].find(s => s.folder === folder && (s.recursive || !recursive));
    if (covering) return this.publicSession(covering);
    await this.flushSidecars(); await this.writes.catch(() => {});
    const opened = await this.scan(folder, recursive, { removable });
    if (!recursive) return opened;
    let narrow = {};
    try { narrow = JSON.parse(await fs.readFile(path.join(this.dataDir, 'sessions', hash(folder + ':false') + '.json'), 'utf8')).decisions ?? {}; } catch {}
    const s = this.get(opened.id), carried = [];
    for (const item of s.items) {
      const cached = narrow[item.id];
      if (!cached || path.join(folder, cached.path || '') !== item.path || cached.fingerprint !== item.fingerprint || (cached.modified || 0) <= (item.modified || 0)) continue;
      restore(item, cached, folder); carried.push(item);
    }
    if (!carried.length) return opened;
    await this.save(s);
    return this.publicSession(s);
  }

  // Adds one published capture without rescanning: only its directory/stem group is regrouped,
  // with scan's pairing rules. Calls are serialized so revisions and deltas stay contiguous.
  ingestCapture(sessionId, payload) {
    const run = this.ingests.catch(() => {}).then(() => this.ingestNow(sessionId, payload));
    this.ingests = run;
    return run;
  }

  async ingestNow(sessionId, p) {
    const s = this.get(sessionId);
    if (!p || typeof p !== 'object' || typeof p.path !== 'string' || !path.isAbsolute(p.path)) throw coded('IO_ERROR', 'Invalid capture path.');
    const file = path.normalize(p.path), name = path.basename(file), dir = path.dirname(file);
    if (!SUPPORTED.has(path.extname(name).toLowerCase())) throw coded('UNSUPPORTED', `${name}: unsupported capture file type.`);
    const root = await fs.stat(s.folder).catch(() => null);
    if (!root || `${root.dev}:${root.ino}` !== s.folderId) throw coded('DEST_CHANGED', 'The capture folder has changed or is no longer available.');
    if (await fs.realpath(dir).catch(() => null) !== dir || !inside(s.folder, dir) || !s.recursive && dir !== s.folder) throw coded('DEST_CHANGED', `${name} is outside the open folder.`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw coded('IO_ERROR', `${name} is not a regular file.`);
    const receipt = p.fileIdentity;
    if (receipt && (receipt.size !== undefined && receipt.size !== stat.size || receipt.ino !== undefined && String(receipt.ino) !== String(stat.ino) || receipt.dev !== undefined && String(receipt.dev) !== String(stat.dev))) throw coded('DEST_CHANGED', `${name} does not match its published receipt.`);
    const f = { path: file, name, size: stat.size, mtimeMs: stat.mtimeMs, fileId: `${stat.dev}:${stat.ino}` };
    const sidecars = [];
    for (const candidate of sidecarPaths(file)) { const info = await fs.lstat(candidate).catch(() => null); if (info?.isFile()) sidecars.push({ file: candidate, modified: info.mtimeMs }); }
    if (this.sessions.get(sessionId) !== s) throw coded('STALE_SESSION', 'This folder session has closed.');
    // Everything below runs without awaiting, so it sees and leaves a consistent session.
    const delta = this.applyCapture(s, f, p, sidecars), unsaved = s.unsavedCaptures ??= new Map();
    const changed = delta.upserts.length || delta.remap.length || delta.removedIds.length;
    // A capture applied in memory whose save failed is not done: its retry saves again and reports it.
    const result = changed ? delta : unsaved.has(file) ? this.refreshDelta(s, unsaved.get(file)) : delta;
    if (!changed && !unsaved.has(file)) return result;
    unsaved.set(file, result);
    await this.save(s);
    unsaved.delete(file);
    return result;
  }

  applyCapture(s, f, p, sidecars) {
    const capture = { exposureId: typeof p.exposureId === 'string' ? p.exposureId : undefined, ordinal: Number.isSafeInteger(p.ordinal) ? p.ordinal : undefined };
    const develop = p.develop ? { recipe: typeof p.develop.recipe === 'string' ? p.develop.recipe : null, settings: checkSettings(p.develop.settings ?? {}) } : null;
    const metadata = p.captureMetadata ? normalizeCaptureMetadata(p.captureMetadata) : undefined;
    const upserts = [], remap = [], removedIds = [];
    const firstArrival = !!capture.exposureId && !s.items.some(i => i.exposureId === capture.exposureId);
    const applyDevelop = item => {
      if (!develop || !item.raw || item.captureDevelop) return false;
      // An explicit Develop edit made before the RAW arrived wins over the frozen patch.
      if (!item.develop) item.develop = developState(develop);
      item.captureDevelop = true;
      return true;
    };
    const initialize = item => {
      const initial = p.initial || {}, patch = {};
      if (initial.pick === true) patch.flag = 'pick';
      if (Number.isInteger(initial.rating)) patch.rating = initial.rating;
      if (initial.color !== null && initial.color !== undefined) patch.color = initial.color;
      Object.assign(item, decision({ ...item, ...patch }), { edited: Object.keys(patch).length > 0, ...capture, captureMetadata: metadata });
      applyDevelop(item);
    };
    const relevant = item => item.edited || item.captureMetadata || item.develop || Object.hasOwn(item, 'metadataOverrides');
    let target;
    const knownId = s.byPath.get(f.path);
    if (knownId) {
      // A replayed event: the same file must still be the same file; it is never adopted otherwise.
      target = s.byId.get(knownId);
      const own = target.path === f.path ? { size: target.size, mtimeMs: target.mtimeMs, fileId: target.fileId } : { size: target.companionSize, mtimeMs: target.companionMtimeMs };
      if (own.size !== f.size || own.mtimeMs !== f.mtimeMs || own.fileId && own.fileId !== f.fileId) throw coded('DEST_CHANGED', `${f.name} changed on disk; it was not adopted as a capture.`);
      let changed = false;
      if (capture.exposureId && !target.exposureId) {
        if (!target.edited && !target.modified) initialize(target);
        else Object.assign(target, capture);
        changed = true;
      }
      if (target.exposureId === capture.exposureId && applyDevelop(target)) changed = true;
      if (changed) upserts.push(target);
    } else {
      const exclude = exclusionMap(this.pairingExclusions(s.folder));
      if (p.separate === true) exclude.set(f.path, null);
      const key = groupKey(f.path, exclude, f.fileId);
      const previous = [...(s.byGroup.get(key) || [])].map(id => s.byId.get(id)).filter(Boolean);
      const files = previous.flatMap(item => [{ path: item.path, name: item.name, size: item.size, mtimeMs: item.mtimeMs, fileId: item.fileId },
        ...(item.companion ? [{ path: item.companion, name: path.basename(item.companion), size: item.companionSize, mtimeMs: item.companionMtimeMs }] : [])]);
      const records = groupFiles([...files, f], { exclude });
      const before = new Map(previous.map(item => [item.id, item])), after = new Set(records.map(r => r.id)), replaced = new Set();
      for (const record of records) {
        const old = before.get(record.id);
        if (old) {
          if (old.companion !== record.companion || old.fingerprint !== record.fingerprint) {
            unindexItem(s, old);
            Object.assign(old, { companion: record.companion, companionSize: record.companionSize, companionMtimeMs: record.companionMtimeMs, fingerprint: record.fingerprint, group: record.group, contentRev: (old.contentRev || 0) + 1 });
            indexItem(s, old); upserts.push(old);
          }
          if (old.path === f.path || old.companion === f.path) { target = old; if (old.exposureId === capture.exposureId && applyDevelop(old) && !upserts.includes(old)) upserts.push(old); }
          continue;
        }
        const item = record;
        if (item.path === f.path && sidecars.length) item.sidecar = sidecars.sort((a, b) => b.modified - a.modified)[0].file;
        // JPEG first: the RAW takes over the provisional row with every decision and reference.
        const donor = previous.find(old => !after.has(old.id) && item.companion === old.path);
        if (donor) {
          Object.assign(item, decision(donor), metadataState(donor), { sidecarMetadata: donor.sidecarMetadata, observedMetadata: donor.observedMetadata, modified: donor.modified, edited: donor.edited, develop: donor.develop ?? null, captureMetadata: donor.captureMetadata,
            exposureId: donor.exposureId ?? capture.exposureId, ordinal: donor.ordinal ?? capture.ordinal, contentRev: (donor.contentRev || 0) + 1, captureDevelop: donor.captureDevelop === true });
          if (!sidecars.length && item.sidecars.includes(donor.sidecar)) item.sidecar = donor.sidecar;
          if (item.exposureId === capture.exposureId) applyDevelop(item);
          this.remapItem(s, donor, item); replaced.add(donor.id); remap.push({ from: donor.id, to: item.id });
        } else if (item.path === f.path) {
          item.contentRev = 1;
          if (capture.exposureId) initialize(item);
        }
        s.byId.set(item.id, item); insertSorted(s.items, item); indexItem(s, item); upserts.push(item);
        if (item.path === f.path || item.companion === f.path) target = item;
      }
      for (const old of previous) if (!after.has(old.id) && !replaced.has(old.id)) {
        unindexItem(s, old); s.byId.delete(old.id); s.items.splice(s.items.indexOf(old), 1); removedIds.push(old.id);
      }
    }
    if (upserts.length || remap.length || removedIds.length) {
      s.rev = (s.rev || 0) + 1;
      const touched = upserts.filter(relevant);
      if (touched.length) this.changed(s, touched);
    }
    const roles = Array.isArray(p.expectedRoles) ? p.expectedRoles : [];
    return { session: s.id, shootId: p.shootId ?? null, rev: s.rev || 0, exposureId: capture.exposureId ?? null, ordinal: capture.ordinal ?? null, itemId: target?.id ?? null,
      upserts: upserts.map(item => this.publicItem(item)), removedIds, remap, firstArrival: firstArrival && upserts.includes(target),
      pairState: target?.companion ? 'paired' : p.separate ? 'separate' : roles.includes('raw') && roles.includes('jpeg') ? 'waiting' : 'single' };
  }

  refreshDelta(s, delta) {
    const upserts = delta.upserts.map(item => s.byId.get(item.id)).filter(Boolean).map(item => this.publicItem(item));
    return { ...delta, rev: s.rev || 0, upserts, removedIds: delta.removedIds.filter(id => !s.byId.has(id)) };
  }

  remapItem(s, from, to) {
    unindexItem(s, from); s.byId.delete(from.id); s.items.splice(s.items.indexOf(from), 1);
    s.aliases.set(from.id, to.id);
    for (const [alias, id] of s.aliases) if (id === from.id) s.aliases.set(alias, to.id);
    for (const action of [...s.undo, ...s.redo]) for (const entry of action.batch || [action]) if (entry.id === from.id) entry.id = to.id;
    this.pendingSidecars.delete(s.id + ':' + from.id);
  }

  // Develop state (see develop.cjs). Not part of undo: it is edited in the develop view, not by culling keys.
  developGet(sessionId, imageId) {
    const item = this.item(sessionId, imageId);
    const linked = item.develop?.handoffs.some(r => r.path === item.develop.tiff && r.linked) || !!item.develop?.tiff && this.linkedHandoffs().has(path.resolve(item.develop.tiff).toLowerCase());
    return { id: item.id, name: item.name, raw: item.raw, ...(item.develop || { recipe: null, settings: null, tiff: null, editedBy: null }), linked: !!linked, edited: !!item.develop?.editedBy, missing: !!item.develop?.missing };
  }

  async developSet(sessionId, ids, { recipe = null, settings = null } = {}) {
    const s = this.get(sessionId);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100_000) throw new Error('Choose photos to develop.');
    if (recipe !== null && (typeof recipe !== 'string' || recipe.length > 80)) throw new Error('Unknown recipe.');
    settings = settings === null ? null : checkSettings(settings);
    const items = [...new Set(ids.map(id => this.item(sessionId, id)))];
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
      const record = { path: next.tiff, realPath, editedBy: next.editedBy || null, exported: !!next.exported, exportedStamp, writtenStamp, ...(previous?.linked ? { linked: true } : {}) };
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
    const items = [...new Set(ids.map(id => this.item(sessionId, id)))];
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

  async editMetadata(sessionId, ids, patch) {
    const s = this.get(sessionId);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100_000) throw new Error('Choose photos to edit.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid metadata edit.');
    const fields = {}, operations = {};
    for (const [key, value] of Object.entries(patch)) {
      if (textFields.includes(key)) fields[key] = text(value, key === 'caption' ? 8192 : 1024);
      else if (key === 'addKeyword' || key === 'removeKeyword') {
        operations[key] = text(value, 128);
        if (!operations[key]) throw new Error('Enter a keyword.');
      } else throw new Error('Unknown metadata field.');
    }
    const original = [...new Set(ids.map(id => this.item(sessionId, id)))];
    const keywords = Object.keys(operations).length > 0;
    const embedded = keywords ? await mapLimit(original, 3, item =>
      item.metadataOverrides?.keywords || item.sidecarMetadata?.keywords ? {} : this.embeddedMetadata(item)) : [];
    if (s !== this.get(sessionId)) throw coded('STALE_SESSION', 'This folder session has changed.');
    const batch = [], items = [];
    for (const [index, requested] of original.entries()) {
      const item = this.item(sessionId, requested.id), before = item.metadataOverrides || null;
      const next = { ...before, ...fields };
      if (keywords) {
        const current = descriptive(item, embedded[index], this.settings().metadata).keywords;
        const words = current.filter(word => word !== operations.removeKeyword);
        if (operations.addKeyword && !words.includes(operations.addKeyword)) words.push(operations.addKeyword);
        if (words.length > 100) throw new Error('Use at most 100 keywords.');
        if (words.length !== current.length || words.some((word, i) => word !== current[i])) next.keywords = words;
      }
      if (JSON.stringify(before || {}) === JSON.stringify(next)) continue;
      items.push(item);
      batch.push({ id: item.id, before: { metadataOverrides: before }, after: { metadataOverrides: next } });
    }
    if (!batch.length) {
      await this.save(s);
      return { items: original.map(item => ({ id: item.id, ...metadataState(item) })) };
    }
    for (const [i, entry] of batch.entries()) Object.assign(items[i], entry.after);
    s.undo.push({ batch });
    if (s.undo.length > 500) s.undo.shift();
    s.redo = [];
    this.changed(s, items);
    await this.save(s);
    return { items: batch.map(entry => ({ id: entry.id, ...entry.after })) };
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
      const patch = direction === 'redo' ? entry.after : entry.before;
      if (Object.hasOwn(patch, 'metadataOverrides')) {
        Object.assign(item, patch);
        return { id: item.id, ...patch };
      }
      Object.assign(item, patch, { edited: true });
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
    const items = s.items.filter(i => i.edited || i.modified && (i.develop || i.captureMetadata || Object.hasOwn(i, 'metadataOverrides'))).map(i => this.sidecarItem(s, i));
    const failures = [], paths = new Map();
    // A same-stem second RAW format must never silently overwrite another decision.
    for (const item of s.items) {
      const count = (paths.get(item.sidecar) ?? 0) + 1;
      paths.set(item.sidecar, count);
    }
    let written = 0, saveBaseline = false;
    await mapLimit(items, 3, async item => {
      try {
        if (paths.get(item.sidecar) > 1) throw new Error('Multiple RAWs share this sidecar name; rename them before exporting.');
        const observed = await writeXmp(item.sidecar, item, settings);
        const current = s.byId.get(item.id);
        if (current) {
          current.observedMetadata = observed;
          if (Object.hasOwn(current, 'metadataOverrides')) saveBaseline = true;
          else current.sidecarMetadata = observed;
        }
        written++;
      } catch (e) { failures.push({ name: item.name, reason: e.message }); }
    });
    if (saveBaseline) await this.save(s);
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
    const doomed = [...new Set(ids.map(id => this.item(sessionId, id)))];
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
    const s = this.get(sessionId), gone = new Set(ids.map(id => s.byId.has(id) ? id : s.aliases.get(id) ?? id));
    s.items = s.items.filter(item => !gone.has(item.id));
    for (const id of gone) { const item = s.byId.get(id); if (item) unindexItem(s, item); s.byId.delete(id); }
    for (const [from, to] of s.aliases) if (gone.has(to)) s.aliases.delete(from);
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
      file: i.path, companion: i.companion, sidecar: i.sidecar, ...decision(i), ...metadataState(i) })) };
  }
}

module.exports = { Library, groupFiles, groupKey, RAW, JPEG, SUPPORTED, hash, coded, inside };
