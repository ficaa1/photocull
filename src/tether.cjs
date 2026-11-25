// Tethered capture coordinator (docs/tether-c1-spec.md). The Tauri shell owns the camera, staging
// downloads and exclusive publication; this side owns the durable shoot ledger, next-capture policy,
// naming, collision-free stem reservation and incremental Library ingestion.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicWrite, normalizeCaptureMetadata } = require('./xmp.cjs');
const { checkSettings } = require('./develop.cjs');
const { TETHER, normalizeTether } = require('./preferences.cjs');
const { renderCaptureName, validateCaptureTemplate, validStem } = require('./renderer/naming.js');
const { SUPPORTED, RAW, JPEG, coded, inside } = require('./library.cjs');

const STAGE = '.photocull-tether';
const LIMIT = 999_999_999;
const SAFETY = 256 * 1024 ** 2, BUDGET = 128 * 1024 ** 2;
const LAYOUT_FOLDERS = ['Capture', 'Selects', 'Output', 'Trash'];
const CONFIG_KEYS = ['namingTemplate', 'adjustments', 'metadataPresetId', 'initial', 'follow', 'composition', 'flash'];
// Lightcraft DevelopSettings paths per adjustment group. Arrays and objects are replaced wholesale.
const GROUP_PATHS = { wb: [['wb']], light: [['light'], ['hdr']], curve: [['curve']],
  detailColor: ['profile', 'treatment', 'detail', 'color', 'mixer', 'point_colors', 'bw_mix', 'grading', 'calibration', 'effects', 'vignette', 'grain'].map(k => [k]),
  optics: [['optics']], orientation: [['orientation'], ['geometry', 'rotate']] };
const PENDING = new Set(['announced', 'receiving', 'staged', 'reserved', 'published']);
const RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const ISSUE_CODES = ['CAMERA_LOST', 'IO_ERROR', 'NO_SPACE', 'INCOMPLETE', 'DEST_CHANGED', 'NAME_TAKEN', 'UNSUPPORTED', 'INVALID_FORMAT'];
// Bytes that are not the image their name promises are kept for inspection but never published.
const UNPUBLISHABLE = 'INVALID_FORMAT';

const fail = (code, message, extra) => { throw coded(code, message, extra); };
const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fold = name => name.normalize('NFC').toLowerCase();
const two = n => String(n).padStart(2, '0');
const wallClock = d => `${d.getFullYear()}:${two(d.getMonth() + 1)}:${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const WALL = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)$/;
const wallSeconds = text => { const m = WALL.exec(text ?? ''); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null; };
const secondsWall = seconds => { const d = new Date(seconds * 1000); return `${d.getUTCFullYear()}:${two(d.getUTCMonth() + 1)}:${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
const digest = text => createHash('sha256').update(text).digest('hex');
// How far before the shoot's start, on the camera's clock, a card photo still counts as missed.
const CARD_SLACK = 60, CARD_SLACK_UNKNOWN = 300;
// Seconds from a test shot's release, on the camera's clock, within which its frame was taken.
const TEST_EARLY = 2, TEST_LATE = 40;
// Member codes left by a transfer that never completed; the card copy may stand in for them.
const RETAKE = new Set(['CAMERA_LOST', 'INCOMPLETE', 'IO_ERROR', 'NO_SPACE']);
const reopenable = m => !m.sha256 && (['announced', 'receiving'].includes(m.status) || m.status === 'held' && RETAKE.has(m.code));
const bodyKeyOf = snapshot => snapshot.bodyId ? createHash('sha256').update(`photocull-body:${snapshot.model ?? ''}:${snapshot.bodyId}`).digest('hex').slice(0, 32) : null;
const stemOf = name => fold(path.basename(name, path.extname(name)));
// What card keys and the synced mark are filed under: the body, or its model when it has no serial.
const cardBody = camera => bodyKeyOf(camera) ?? `model:${camera.model ?? ''}`;
function only(value, allowed, field) {
  if (!isPlain(value)) fail('UNSUPPORTED', `Invalid ${field}.`, { field });
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) fail('UNSUPPORTED', `Unknown field: ${unknown}.`, { field: unknown });
  return value;
}
const id = (value, field = 'id') => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : fail('UNSUPPORTED', `Invalid ${field}.`, { field });
const revision = (value, field = 'revision') => Number.isSafeInteger(value) && value >= 0 ? value : fail('UNSUPPORTED', `Invalid ${field}.`, { field });
const counterValue = (value, field) => Number.isSafeInteger(value) && Math.abs(value) <= LIMIT ? value : fail('UNSUPPORTED', 'Counter values must be between −999,999,999 and 999,999,999.', { field });
function shortText(value, limit, field) {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) fail('UNSUPPORTED', `Invalid ${field}.`, { field });
  return value;
}
function component(part) {
  if (typeof part !== 'string' || !part || part.length > 255 || part.startsWith('.') || /[\x00-\x1f<>:"/\\|?*]/.test(part) || /[. ]$/.test(part) || RESERVED_NAME.test(part)) fail('UNSUPPORTED', `Invalid folder name: ${String(part).slice(0, 80)}`, { field: 'relative' });
  return part;
}
function relativeDir(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 1024 || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\')) fail('UNSUPPORTED', 'Choose a folder inside the capture location.', { field: 'relative' });
  const parts = value.split('/');
  if (parts.length > 16) fail('UNSUPPORTED', 'The capture folder is nested too deeply.', { field: 'relative' });
  return parts.map(component).join('/');
}
function cameraFilename(value) {
  const name = shortText(value, 255, 'originalName');
  if (!name || name !== path.basename(name) || /[\\/:]/.test(name) || name.startsWith('.')) fail('UNSUPPORTED', 'Invalid camera filename.', { field: 'originalName' });
  return name;
}

function captureMember(exposureId, memberId, originalName, declaredBytes, providerObjectKey = null) {
  const ext = path.extname(originalName).toLowerCase(), supported = SUPPORTED.has(ext);
  return { memberId, exposureId, role: RAW.has(ext) ? 'raw' : JPEG.has(ext) ? 'jpeg' : 'other', originalName, providerObjectKey, declaredBytes,
    receivedBytes: 0, stageRelPath: `${STAGE}/${memberId}.part`, sha256: null, finalRelPath: null, fileIdentity: null, claimId: null, separate: false,
    status: supported ? 'announced' : 'held', code: supported ? null : 'UNSUPPORTED', reason: supported ? null : `${originalName}: unsupported file type; kept in staging.` };
}

function cameraSnapshot(value = {}) {
  only(value, ['model', 'bodyId', 'firmware', 'captureTime', 'iso', 'shutter', 'aperture', 'focalLength'], 'camera snapshot');
  const result = {};
  for (const key of ['model', 'bodyId', 'firmware', 'captureTime']) if (value[key] !== undefined && value[key] !== null) result[key] = shortText(value[key], 128, key);
  for (const key of ['iso', 'shutter', 'aperture', 'focalLength']) if (value[key] !== undefined && value[key] !== null) {
    if (typeof value[key] === 'number' ? !Number.isFinite(value[key]) : typeof value[key] !== 'string' || value[key].length > 32) fail('UNSUPPORTED', `Invalid ${key}.`, { field: key });
    result[key] = value[key];
  }
  return result;
}
// What the staged journal recorded, so a retry verifies the very same bytes wherever they now are.
const receiptOf = m => m.sha256 ? { bytes: m.receivedBytes, sha256: m.sha256 } : {};
const sha256File = async file => {
  const handle = await fs.open(file), h = createHash('sha256');
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) h.update(chunk); } finally { await handle.close(); }
  return h.digest('hex');
};

function getPath(object, keys) { return keys.reduce((value, key) => isPlain(value) && Object.hasOwn(value, key) ? value[key] : undefined, object); }
function removePath(object, keys) {
  const parent = getPath(object, keys.slice(0, -1));
  if (!isPlain(parent)) return;
  delete parent[keys.at(-1)];
  if (keys.length > 1 && !Object.keys(parent).length) delete getPath(object, keys.slice(0, -2))[keys.at(-2)];
}
function setPath(object, keys, value) {
  let target = object;
  for (const key of keys.slice(0, -1)) { if (!isPlain(target[key])) target[key] = {}; target = target[key]; }
  target[keys.at(-1)] = structuredClone(value);
}
// Starts from the default patch; each checked group is replaced by exactly what the donor sets, so a
// donor at native defaults resets that group to the incoming RAW's own base.
function copyGroups(base, source, groups) {
  const result = structuredClone(base ?? {});
  for (const group of groups) for (const keys of GROUP_PATHS[group]) {
    removePath(result, keys);
    const value = getPath(source, keys);
    if (value !== undefined) setPath(result, keys, value);
  }
  // As-shot white balance belongs to each frame; the donor's measured temperature/tint never travels.
  if (groups.includes('wb') && isPlain(result.wb) && result.wb.mode === 'asShot') result.wb = { mode: 'asShot' };
  return result;
}

class TetherService {
  constructor({ dataDir, library, settings, presets = () => [], recipes, send = () => {}, isCard = async () => false, dimensions = async () => null, onDelta = () => {}, now = () => new Date() }) {
    Object.assign(this, { library, settings, presets, recipes, send, isCard, dimensions, onDelta, now });
    this.dir = path.join(dataDir, 'tether');
    this.ledgers = new Map(); this.queues = new Map(); this.primaries = new Map();
    this.cameraCounters = { version: 1, bodies: {} }; this.counterWrites = Promise.resolve();
    this.exclusionList = []; this.activeShoot = null;
  }

  async init() {
    await fs.mkdir(path.join(this.dir, 'shoots'), { recursive: true });
    const read = async (name, fallback) => {
      try { const value = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')); return value?.version === 1 ? value : fallback; }
      catch (error) { if (error.code !== 'ENOENT') console.warn('Tether %s could not be read: %s', name, error.message); return fallback; }
    };
    this.cameraCounters = await read('camera-counters.json', this.cameraCounters);
    const entries = (await read('exclusions.json', { version: 1, paths: [] })).paths ?? [];
    this.exclusionList = entries.map(e => typeof e === 'string' ? { path: e, fileId: null } : e).filter(e => typeof e?.path === 'string' && (e.fileId === null || typeof e.fileId === 'string'));
  }

  exclusions() { return this.exclusionList; }
  // Keeps a file another writer put next to a capture out of automatic pairing, durably and before
  // any later scan. The entry names that very file, so whatever replaces it later pairs normally.
  async exclude(file) {
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile()) return;
    const entry = { path: file, fileId: `${stat.dev}:${stat.ino}` };
    if (this.exclusionList.some(e => e.path === entry.path && e.fileId === entry.fileId)) return;
    const next = [...this.exclusionList.filter(e => e.path !== file), entry];
    await atomicWrite(path.join(this.dir, 'exclusions.json'), JSON.stringify({ version: 1, paths: next }));
    this.exclusionList = next;
  }
  // The exposure a file in a capture folder was journaled as, once its size matches what the camera sent.
  captureExposure({ path: file, size }) {
    for (const { shoot, members } of this.ledgers.values()) for (const m of Object.values(members)) {
      if (m.finalRelPath && ['reserved', 'published', 'ingested'].includes(m.status) && m.receivedBytes === size && this.absolute(shoot, m.finalRelPath) === file) return m.exposureId;
    }
    return null;
  }
  active() { return !!this.activeShoot; }
  // Pending members, and exposures still waiting for their companion, hold file operations and folder changes.
  busy() {
    const ledger = this.activeShoot && this.ledgers.get(this.activeShoot);
    return !!ledger && (Object.values(ledger.members).some(m => PENDING.has(m.status)) || Object.values(ledger.exposures).some(e => e.status === 'availablePartial'));
  }
  async close() { await Promise.allSettled([...this.queues.values(), this.counterWrites]); }

  ledgerFile(shootId) { return path.join(this.dir, 'shoots', shootId + '.json'); }
  async loadLedger(shootId) {
    if (this.ledgers.has(shootId)) return this.ledgers.get(shootId);
    const value = JSON.parse(await fs.readFile(this.ledgerFile(shootId), 'utf8'));
    if (value?.version !== 1 || value.shoot?.shootId !== shootId) fail('UNSUPPORTED', 'This shoot journal was written by a newer PhotoCull.');
    value.shoot.config.flash ??= structuredClone(TETHER.flash);
    this.ledgers.set(shootId, value);
    return value;
  }
  ledger(shootId) {
    id(shootId, 'shootId');
    return this.ledgers.get(shootId) ?? fail('STALE_SESSION', 'This tethered shoot is not open.');
  }

  // One serialized transaction per shoot: the draft is persisted before it becomes current, and events
  // leave only after that. Errors marked `persist` still commit the draft (e.g. a member put on hold).
  tx(shootId, work) {
    const run = (this.queues.get(shootId) || Promise.resolve()).catch(() => {}).then(async () => {
      const draft = structuredClone(this.ledger(shootId)), events = [];
      let result, failure;
      try { result = await work(draft, events); } catch (error) { if (!error.persist) throw error; failure = error; }
      await atomicWrite(this.ledgerFile(shootId), JSON.stringify(draft));
      this.ledgers.set(shootId, draft);
      for (const [event, payload] of events) this.send(event, { v: 1, shootId, ...payload });
      if (failure) throw failure;
      return result;
    });
    this.queues.set(shootId, run);
    return run;
  }

  libraryRoot(shoot) { return shoot.layout === 'session' ? path.join(shoot.canonicalRoot, 'Capture') : shoot.canonicalRoot; }
  absolute(shoot, relative) { return path.join(this.libraryRoot(shoot), ...relative.split('/').filter(Boolean)); }
  checkRev(shoot, expected) { if (revision(expected, 'expectedConfigRev') !== shoot.configRev) fail('STALE_REV', 'Tether settings changed elsewhere. Refresh and try again.', { currentRev: shoot.configRev, retryable: true }); }

  location(shoot) {
    const root = this.libraryRoot(shoot), leaf = shoot.activeRelDir.split('/').at(-1) || path.basename(root);
    return { relative: shoot.activeRelDir, display: this.absolute(shoot, shoot.activeRelDir), leaf, layout: shoot.layout, recents: shoot.recentRelDirs.map(r => r.relative) };
  }
  configEvent(ledger) {
    const { shoot } = ledger;
    return ['tether-config-changed', { session: shoot.session, configRev: shoot.configRev, location: this.location(shoot), counters: { ...shoot.counters }, config: structuredClone(shoot.config) }];
  }

  async directoryIdentity(shoot, relative) {
    let current = this.libraryRoot(shoot);
    for (const part of relative.split('/').filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('DEST_CHANGED', `${relative || 'The capture folder'} is not an available folder.`, { field: 'relative' });
    }
    if (await fs.realpath(current).catch(() => null) !== current) fail('DEST_CHANGED', 'The capture folder moved or is reached through a link.', { field: 'relative' });
    const stat = await fs.stat(current);
    return `${stat.dev}:${stat.ino}`;
  }

  async findShoot(root, folderId, layout) {
    const names = await fs.readdir(path.join(this.dir, 'shoots')).catch(() => []);
    let best = null;
    for (const name of names) {
      if (!/^[\da-f-]{36}\.json$/i.test(name)) continue;
      try {
        const ledger = await this.loadLedger(name.slice(0, -5)), shoot = ledger.shoot;
        if (shoot.canonicalRoot === root && shoot.folderId === folderId && shoot.layout === layout && (!best || shoot.createdAt > best.shoot.createdAt)) best = ledger;
        else if (shoot.shootId !== this.activeShoot && !Object.values(ledger.members).some(m => PENDING.has(m.status))) this.ledgers.delete(shoot.shootId);
      } catch (error) { console.warn('Tether journal %s could not be read: %s', name, error.message); }
    }
    return best;
  }

  async bind(validatedRoot, rootIdentity = null, layout = null, includeShots = false, existingSession = null) {
    const tether = this.settings().tether;
    if (tether?.version !== 1) fail('UNSUPPORTED', 'Tether settings were saved by a newer PhotoCull. Update PhotoCull to tether.');
    if (typeof validatedRoot !== 'string' || !path.isAbsolute(validatedRoot)) fail('DEST_CHANGED', 'Choose a capture folder.');
    layout ??= tether.layout;
    if (!['single', 'session'].includes(layout)) fail('UNSUPPORTED', 'Invalid capture layout.', { field: 'layout' });
    const root = await fs.realpath(validatedRoot).catch(() => null);
    if (root !== path.normalize(validatedRoot)) fail('DEST_CHANGED', 'The capture folder moved or is reached through a link.');
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) fail('DEST_CHANGED', 'Choose a capture folder.');
    const folderId = `${stat.dev}:${stat.ino}`;
    if (rootIdentity !== null) {
      only(rootIdentity, ['volumeId', 'folderId'], 'root identity');
      if (rootIdentity.folderId !== undefined && rootIdentity.folderId !== folderId) fail('DEST_CHANGED', 'The capture folder changed before tethering started.');
    }
    if (await this.isCard(root)) fail('UNSUPPORTED', 'Camera cards cannot be tether destinations. Choose a folder on this computer.');
    if (this.activeShoot && this.ledgers.get(this.activeShoot)?.shoot.canonicalRoot !== root) fail('CAMERA_BUSY', 'Stop the current tethered shoot first.');
    if (layout === 'session') for (const name of LAYOUT_FOLDERS) {
      const dir = path.join(root, name);
      await fs.mkdir(dir).catch(error => { if (error.code !== 'EEXIST') fail('IO_ERROR', `${dir}: ${error.message}`, { field: name }); });
      const info = await fs.lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('IO_ERROR', `${dir} exists and is not a folder.`, { field: name });
    }
    let ledger = await this.findShoot(root, folderId, layout);
    if (!ledger) {
      const shootId = randomUUID();
      ledger = { version: 1, shoot: { shootId, canonicalRoot: root, volumeId: rootIdentity?.volumeId ?? String(stat.dev), folderId, layout, recursive: layout === 'session',
        activeRelDir: '', activeDirId: null, recentRelDirs: [], configRev: 1, libraryRev: 0, nextOrdinal: 1,
        counters: { next: tether.counterStart, resetTo: tether.counterStart, step: tether.counterStep }, lastExposureId: null, lastBodyKey: null, lastCamera: null,
        config: { jobName: path.basename(root).slice(0, 80) || 'Capture', ...structuredClone(Object.fromEntries(CONFIG_KEYS.map(k => [k, tether[k]]))) },
        overlayAsset: null, pinnedRef: null, session: null, createdAt: this.now().toISOString(), closedAt: null },
        exposures: {}, members: {}, requests: {}, claims: {} };
      this.ledgers.set(shootId, ledger);
    }
    const shoot = ledger.shoot, libraryRoot = this.libraryRoot(shoot);
    for (const member of Object.values(ledger.members)) if (['reserved', 'published'].includes(member.status) && await this.occupied(shoot, member)) await this.excludeFromPair(ledger, member);
    const current = existingSession ? (() => { try { return this.library.get(id(existingSession, 'session')); } catch { return null; } })() : null;
    const recursive = layout === 'session' || !!includeShots || shoot.recursive || !!current?.recursive && current.folder === libraryRoot;
    const opened = current && current.folder === libraryRoot && (current.recursive || !recursive)
      ? this.library.publicSession(current) : await this.library.openEmptyOrExisting(libraryRoot, recursive);
    this.activeShoot = shoot.shootId;
    return this.tx(shoot.shootId, async (draft, events) => {
      const s = draft.shoot;
      if (!s.backfill || s.closedAt) s.backfill = { startedAt: wallClock(this.now()), synced: {} };
      Object.assign(s, { session: opened.id, recursive: opened.recursive, closedAt: null });
      if (!s.recursive && s.activeRelDir) s.activeRelDir = '';
      s.activeDirId = await this.directoryIdentity(s, s.activeRelDir).catch(() => null);
      const recoveries = await this.recover(draft, events);
      const session = this.library.get(opened.id);
      s.libraryRev = session.rev || 0;
      events.push(this.configEvent(draft));
      return { shootId: s.shootId, session: this.library.publicSession(session), configRev: s.configRev, libraryRev: s.libraryRev, recoveries };
    });
  }

  // Read-only: runs before anything, including the staging folder, is created in the chosen folder.
  async checkDestination(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('DEST_CHANGED', 'Choose a capture folder.');
    const canonical = await fs.realpath(root).catch(() => null);
    if (!canonical || !(await fs.stat(canonical)).isDirectory()) fail('DEST_CHANGED', 'Choose a capture folder.');
    if (await this.isCard(canonical)) fail('UNSUPPORTED', 'Camera cards cannot be tether destinations. Choose a folder on this computer.');
    return { canonicalRoot: canonical };
  }

  // Rust has already created and verified the folder; this records it for the next acceptance.
  setLocation(shootId, expectedRev, relative, directoryIdentity = null, activate = true) {
    return this.tx(shootId, async (ledger, events) => {
      const shoot = ledger.shoot;
      this.checkRev(shoot, expectedRev);
      relative = relativeDir(relative);
      if (relative && !shoot.recursive) fail('UNSUPPORTED', 'Include shot subfolders before shooting into a subfolder.', { field: 'relative' });
      const identity = await this.directoryIdentity(shoot, relative);
      if (directoryIdentity !== null && directoryIdentity !== identity) fail('DEST_CHANGED', 'The capture folder changed. Choose it again.', { field: 'relative' });
      shoot.recentRelDirs = [{ relative, identity }, ...shoot.recentRelDirs.filter(r => r.identity !== identity && r.relative !== relative)].slice(0, 12);
      if (activate !== false) { shoot.activeRelDir = relative; shoot.activeDirId = identity; }
      shoot.configRev++;
      events.push(this.configEvent(ledger));
      return { configRev: shoot.configRev, location: this.location(shoot) };
    });
  }

  config(shootId, expectedRev, patch) {
    return this.tx(shootId, async (ledger, events) => {
      const shoot = ledger.shoot;
      this.checkRev(shoot, expectedRev);
      const { jobName, ...rest } = only(patch, ['jobName', ...CONFIG_KEYS], 'tether config');
      const base = { ...structuredClone(TETHER), ...structuredClone(Object.fromEntries(CONFIG_KEYS.map(k => [k, shoot.config[k]]))) };
      const naming = 'namingTemplate' in rest ? validateCaptureTemplate(rest.namingTemplate) : { valid: true };
      if (!naming.valid) fail('NAME_INVALID', naming.error, { field: 'namingTemplate' });
      let next;
      try { next = normalizeTether(rest, base); } catch (error) { fail('UNSUPPORTED', error.message, { field: Object.keys(rest)[0] }); }
      if (jobName !== undefined && (typeof jobName !== 'string' || !jobName.trim() || jobName.length > 80 || /[\x00-\x1f\x7f]/.test(jobName))) fail('NAME_INVALID', 'Enter a job name of 1–80 characters.', { field: 'jobName' });
      shoot.config = { ...shoot.config, ...Object.fromEntries(CONFIG_KEYS.map(k => [k, next[k]])), ...(jobName !== undefined ? { jobName: jobName.trim() } : {}) };
      shoot.configRev++;
      events.push(this.configEvent(ledger));
      return { configRev: shoot.configRev, config: structuredClone(shoot.config) };
    });
  }

  counter(shootId, expectedRev, op, value) {
    return this.tx(shootId, async (ledger, events) => {
      const shoot = ledger.shoot, c = shoot.counters;
      this.checkRev(shoot, expectedRev);
      if (op === 'setNext') c.next = counterValue(value, 'value');
      else if (op === 'setStart') c.resetTo = counterValue(value, 'value');
      else if (op === 'setStep') { if (!Number.isSafeInteger(value) || !value || Math.abs(value) > 9999) fail('UNSUPPORTED', 'Use a nonzero step between −9999 and 9999.', { field: 'value' }); c.step = value; }
      else if (op === 'increment' || op === 'decrement') c.next = counterValue(c.next + (op === 'increment' ? c.step : -c.step), 'value');
      else if (op === 'reset') c.next = c.resetTo;
      else fail('UNSUPPORTED', 'Unknown counter operation.', { field: 'op' });
      shoot.configRev++;
      events.push(this.configEvent(ledger));
      return { configRev: shoot.configRev, next: c.next, resetTo: c.resetTo, step: c.step };
    });
  }

  namePreview(shootId, input = {}) {
    const { shoot } = this.ledger(shootId);
    only(input, ['jobName', 'namingTemplate', 'relativeShot'], 'name preview');
    const relative = input.relativeShot === undefined || input.relativeShot === null ? shoot.activeRelDir : relativeDir(input.relativeShot);
    const camera = shoot.lastCamera || {};
    const { stem, ...preview } = renderCaptureName(input.namingTemplate ?? shoot.config.namingTemplate, {
      jobName: input.jobName ?? shoot.config.jobName, counter: shoot.counters.next, subfolder: relative.split('/').at(-1) || path.basename(this.libraryRoot(shoot)),
      cameraCounter: shoot.lastBodyKey ? this.cameraCounters.bodies[shoot.lastBodyKey] ?? 0 : null, hostTime: this.now(), camera: camera.model,
      iso: camera.iso, shutter: camera.shutter, aperture: camera.aperture, focalLength: camera.focalLength }, { preview: true });
    return preview;
  }

  primary(shootId, sessionId, input) {
    const { shoot } = this.ledger(shootId);
    if (sessionId !== shoot.session) fail('STALE_SESSION', 'The tethered Library was reopened. Refresh and try again.');
    only(input, ['seq', 'id', 'settings', 'recipe'], 'primary');
    const seq = revision(input.seq, 'seq'), current = this.primaries.get(shootId);
    if (current && seq <= current.seq) return { acceptedSeq: current.seq, sourceId: current.eligible ? current.id : null };
    let item = null;
    if (input.id !== null && input.id !== undefined) item = this.library.item(sessionId, id(input.id));
    if (input.recipe !== undefined && input.recipe !== null && (typeof input.recipe !== 'string' || input.recipe.length > 80)) fail('UNSUPPORTED', 'Unknown recipe.', { field: 'recipe' });
    const settings = input.settings === undefined || input.settings === null ? null : checkSettings(input.settings);
    const next = { seq, id: item?.id ?? null, settings, recipe: input.recipe ?? null, eligible: !!item?.raw && !item.trashed };
    this.primaries.set(shootId, next);
    return { acceptedSeq: seq, sourceId: next.eligible ? next.id : null };
  }

  // Source settings resolve like develop-get: an acknowledged draft, the photo's own settings, its recipe, the default.
  donorSettings(shootId, item, base) {
    const primary = this.primaries.get(shootId);
    if (primary?.id === item.id && primary.settings) return primary.settings;
    return item.develop?.settings ?? this.recipes.get(item.develop?.recipe)?.settings ?? base;
  }
  sessionItem(shoot, itemId) { try { return itemId ? this.library.item(shoot.session, itemId) : null; } catch { return null; } }

  resolveFrozenAdjustments(ledger) {
    const { shoot } = ledger, adjustments = shoot.config.adjustments;
    const fallback = this.recipes.get(this.settings().defaultRecipe) || this.recipes.get('neutral');
    const base = fallback.settings;
    const frozen = (settings, source, extra = {}) => ({ mode: adjustments.mode, recipe: extra.recipe ?? fallback.id, settings: checkSettings(settings), source, sourceId: extra.sourceId ?? null, status: extra.status ?? null });
    if (adjustments.mode === 'recipe') {
      const recipe = adjustments.recipeId ? this.recipes.get(adjustments.recipeId) : null;
      if (!recipe) return frozen(base, `Default · ${fallback.name}`, { status: 'Recipe missing' });
      return frozen(adjustments.entireRecipe ? recipe.settings : copyGroups(base, recipe.settings, adjustments.groups), recipe.name, { recipe: recipe.id });
    }
    if (adjustments.mode === 'last') {
      // Ordinals, not arrival order, decide which exposure is Last.
      const last = Object.values(ledger.exposures).filter(e => e.expectedHostRoles.includes('raw') || Object.values(ledger.members).some(m => m.exposureId === e.exposureId && m.role === 'raw'))
        .sort((a, b) => b.ordinal - a.ordinal)[0];
      if (!last) return frozen(base, 'Default · first capture');
      const item = this.sessionItem(shoot, last.currentItemId);
      const source = item?.raw ? this.donorSettings(shoot.shootId, item, base) : last.frozenPolicy.adjustments.settings;
      return frozen(copyGroups(base, source, adjustments.groups), `Copy from Last · ${item?.name ?? last.stem ?? '#' + last.ordinal}`, { sourceId: item?.id ?? null });
    }
    if (adjustments.mode === 'primary') {
      const primary = this.primaries.get(shoot.shootId), item = this.sessionItem(shoot, primary?.id);
      if (!item?.raw || item.trashed) return frozen(base, 'Default · no primary RAW');
      return frozen(copyGroups(base, this.donorSettings(shoot.shootId, item, base), adjustments.groups), `Copy from Primary · ${item.name}`, { sourceId: item.id });
    }
    return frozen(base, `Default · ${fallback.name}`);
  }

  metadataSnapshot(shoot) {
    const presetId = shoot.config.metadataPresetId, empty = { creator: '', copyright: '', caption: '', keywords: [], presetId: null };
    if (!presetId) return { metadata: empty, status: null };
    const preset = this.presets().find(p => p.id === presetId);
    if (!preset) return { metadata: empty, status: 'Metadata preset missing' };
    const { creator, copyright, caption, keywords } = preset.metadata;
    return { metadata: normalizeCaptureMetadata({ creator, copyright, caption, keywords, presetId }), status: null };
  }

  freeze(ledger) {
    const { shoot } = ledger, metadata = this.metadataSnapshot(shoot);
    return { adjustments: this.resolveFrozenAdjustments(ledger), metadata: metadata.metadata, metadataStatus: metadata.status, initial: structuredClone(shoot.config.initial),
      namingTemplate: shoot.config.namingTemplate, jobName: shoot.config.jobName, configRev: shoot.configRev };
  }

  request(shootId, requestId, primarySeq, op, result = null) {
    return this.tx(shootId, async ledger => {
      id(requestId, 'requestId');
      let request = ledger.requests[requestId];
      if (op === 'create') {
        if (!request) {
          const primary = this.primaries.get(shootId);
          if (primarySeq !== null && primarySeq !== undefined && revision(primarySeq, 'primarySeq') > (primary?.seq ?? 0)) fail('STALE_REV', 'Waiting for the current adjustments to be saved.', { retryable: true, currentRev: primary?.seq ?? 0 });
          request = ledger.requests[requestId] = { requestId, primarySeq: primarySeq ?? null, state: 'requested', frozen: this.freeze(ledger), exposureId: null, createdAt: this.now().toISOString() };
        }
        return { state: request.state, dispatchAllowed: request.state === 'requested' };
      }
      if (!request) fail('STALE_REV', 'Unknown capture request.', { field: 'requestId' });
      if (op === 'dispatch') {
        // Never sent twice, even after a reconnect: a dispatched request is reconciled from camera events.
        const allowed = request.state === 'requested';
        if (allowed) Object.assign(request, { state: 'dispatching', dispatchSeq: 1 + Math.max(0, ...Object.values(ledger.requests).map(r => r.dispatchSeq ?? 0)) });
        return { state: request.state, dispatchAllowed: allowed };
      }
      if (op !== 'resolve' || !['confirmed', 'failed', 'outcomeUnknown'].includes(result)) fail('UNSUPPORTED', 'Unknown request operation.', { field: 'op' });
      // A request is confirmed only by the photo it produced.
      if (['requested', 'dispatching'].includes(request.state) && (result !== 'confirmed' || request.exposureId)) request.state = result;
      else if (request.state === 'outcomeUnknown' && (result === 'failed' || result === 'confirmed' && request.exposureId)) request.state = result;
      return { state: request.state, dispatchAllowed: false, exposureId: request.exposureId };
    });
  }

  editCameraCounters(change) {
    const run = this.counterWrites.catch(() => {}).then(async () => {
      const next = structuredClone(this.cameraCounters);
      const result = change(next);
      if (result.changed) {
        await atomicWrite(path.join(this.dir, 'camera-counters.json'), JSON.stringify(next));
        this.cameraCounters = next;
      }
      return result.value;
    });
    this.counterWrites = run;
    return run;
  }

  // The camera counter and shoot ledger are separate files. A replay reuses its first allocation.
  allocateCameraCounter(body, keep = null) {
    return this.editCameraCounters(next => {
      if (keep && Object.hasOwn(next.keeps ?? {}, keep)) return { value: next.keeps[keep] };
      const value = next.bodies[body] ?? 0;
      next.bodies[body] = value + 1;
      if (keep) (next.keeps ??= {})[keep] = value;
      return { changed: true, value };
    });
  }

  releaseKeptCounter(keep) {
    return this.editCameraCounters(next => {
      if (!Object.hasOwn(next.keeps ?? {}, keep)) return { changed: false };
      delete next.keeps[keep];
      return { changed: true };
    });
  }

  async accept(shootId, epoch, requestId, providerExposure, hostRoles, camera) {
    const accepted = await this.tx(shootId, async (ledger, events) => {
      const shoot = ledger.shoot;
      only(providerExposure ?? {}, ['key', 'staged'], 'provider exposure');
      const key = providerExposure?.key === undefined || providerExposure.key === null ? null : shortText(providerExposure.key, 256, 'key');
      if (!Array.isArray(hostRoles) || !hostRoles.length || hostRoles.length > 2 || new Set(hostRoles).size !== hostRoles.length || hostRoles.some(r => !['raw', 'jpeg'].includes(r))) fail('UNSUPPORTED', 'Invalid host file roles.', { field: 'hostRoles' });
      const snapshot = cameraSnapshot(camera ?? {});
      const receipt = e => ({ exposureId: e.exposureId, ordinal: e.ordinal, counters: { capture: e.captureCounter, camera: e.cameraCounter }, targetDirIdentity: e.targetDirId });
      // A repeated camera notification or second object of one exposure never advances a counter.
      // Across reconnects only a capture time vouches for the same shot: Sony restarts its
      // sequence numbers at power-up.
      const connection = Number.isSafeInteger(epoch) ? epoch : 0;
      const existing = key && Object.values(ledger.exposures).find(e => e.providerShotKey === key && (e.epoch === connection || (!!snapshot.captureTime && e.captureTime === snapshot.captureTime)));
      if (existing) return { ...receipt(existing), boundRequestId: null };
      const staged = providerExposure?.staged;
      const kept = staged === undefined ? [] : await this.verifiedKeep(ledger, key, requestId, hostRoles, staged);
      const c = shoot.counters;
      if (Math.abs(c.next) > LIMIT) fail('INCOMPLETE', 'The capture counter is exhausted. Set the next number or reset it.', { field: 'counter' });
      const request = requestId ? ledger.requests[id(requestId, 'requestId')] : null;
      if (requestId && !request) fail('STALE_REV', 'Unknown capture request.', { field: 'requestId' });
      const bodyKey = bodyKeyOf(snapshot);
      const cameraCounter = bodyKey ? await this.allocateCameraCounter(bodyKey, kept.length ? key : null) : null;
      // Only a released shutter still waiting for its photo is answered by this exposure; one that
      // timed out never claims it once a newer shutter was released.
      const superseded = request?.state === 'outcomeUnknown' && Object.values(ledger.requests).some(r => (r.dispatchSeq ?? 0) > (request.dispatchSeq ?? 0));
      const binds = !!request && !request.exposureId && ['dispatching', 'outcomeUnknown'].includes(request.state) && !superseded;
      const frozen = binds ? request.frozen : this.freeze(ledger);
      const exposureId = randomUUID(), { bodyId, ...cameraInfo } = snapshot;
      const exposure = ledger.exposures[exposureId] = { exposureId, shootId, ordinal: shoot.nextOrdinal++, epoch: connection, stableCameraKey: bodyKey, providerShotKey: key, requestId: binds ? request.requestId : null,
        expectedHostRoles: [...hostRoles], targetRelDir: shoot.activeRelDir, targetDirId: shoot.activeDirId, captureTime: snapshot.captureTime ?? null, hostTime: wallClock(this.now()),
        captureCounter: c.next, cameraCounter, camera: cameraInfo, shot: null, frozenPolicy: frozen, stem: null, stemOverride: null, claimId: null, excludedStems: [], status: 'accepted', currentItemId: null, acceptedAt: this.now().toISOString() };
      if (kept.length) {
        exposure.shot = cameraInfo;
        exposure.status = 'transferring';
        for (const member of kept) ledger.members[member.memberId] = { ...member, exposureId };
      }
      c.next += c.step;
      if (binds) Object.assign(request, { exposureId, state: 'confirmed' });
      Object.assign(shoot, { lastExposureId: exposureId, lastBodyKey: bodyKey, lastCamera: cameraInfo });
      shoot.configRev++;
      events.push(this.configEvent(ledger));
      return { ...receipt(exposure), boundRequestId: binds ? request.requestId : null };
    });
    if (providerExposure?.staged) await this.releaseKeptCounter(providerExposure.key);
    return accepted;
  }

  async verifiedKeep(ledger, key, requestId, roles, staged) {
    if (!key?.startsWith('composition:') || requestId || !Array.isArray(staged) || staged.length !== roles.length) fail('UNSUPPORTED', 'Invalid test shot promotion.');
    const members = [];
    for (const [i, detail] of staged.entries()) {
      only(detail, ['memberId', 'originalName', 'bytes', 'sha256'], 'kept member');
      const { memberId, bytes, sha256 } = detail;
      if (typeof memberId !== 'string' || !/^[a-f0-9]{64}$/.test(memberId) || ledger.members[memberId] || members.some(m => m.memberId === memberId)) fail('UNSUPPORTED', 'Invalid stage identifier.');
      const member = captureMember(null, memberId, cameraFilename(detail.originalName), bytes);
      if (member.role !== roles[i] || !Number.isSafeInteger(bytes) || bytes <= 0 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) fail('UNSUPPORTED', 'Invalid staged test shot.');
      const file = path.join(ledger.shoot.canonicalRoot, member.stageRelPath);
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.size !== bytes || await fs.realpath(file) !== file || await sha256File(file) !== sha256) fail('INCOMPLETE', 'The staged test shot changed.', { retryable: true });
      members.push({ ...member, receivedBytes: bytes, sha256, status: 'staged' });
    }
    return members;
  }

  member(shootId, exposureId, descriptor) {
    return this.tx(shootId, async ledger => {
      const exposure = ledger.exposures[id(exposureId, 'exposureId')] ?? fail('STALE_REV', 'Unknown exposure.', { field: 'exposureId' });
      only(descriptor, ['role', 'originalName', 'providerObjectKey', 'declaredBytes'], 'object descriptor');
      const name = cameraFilename(descriptor.originalName);
      const objectKey = descriptor.providerObjectKey === undefined || descriptor.providerObjectKey === null ? null : shortText(descriptor.providerObjectKey, 256, 'providerObjectKey');
      if (descriptor.declaredBytes !== undefined && descriptor.declaredBytes !== null && (!Number.isSafeInteger(descriptor.declaredBytes) || descriptor.declaredBytes < 0)) fail('UNSUPPORTED', 'Invalid declared size.', { field: 'declaredBytes' });
      const existing = Object.values(ledger.members).find(m => m.exposureId === exposure.exposureId && (objectKey ? m.providerObjectKey === objectKey : m.originalName === name));
      if (existing) return { memberId: existing.memberId, stageRelPath: existing.stageRelPath, status: existing.status };
      const memberId = randomUUID();
      const member = ledger.members[memberId] = captureMember(exposure.exposureId, memberId, name, descriptor.declaredBytes ?? null, objectKey);
      if (exposure.status === 'accepted') exposure.status = 'transferring';
      return { memberId, stageRelPath: member.stageRelPath, status: member.status };
    });
  }

  // Every same-stem RAW, JPEG and both XMP forms, compared case- and Unicode-insensitively, plus live claims.
  async takenStems(shoot, dir, dirId, exposure) {
    const taken = new Set(exposure.excludedStems);
    for (const name of await fs.readdir(dir)) {
      const folded = fold(name), stem = folded.replace(/\.[^.]*$/, '');
      taken.add(stem);
      if (folded.endsWith('.xmp')) taken.add(stem.replace(/\.[^.]*$/, ''));
    }
    for (const ledger of this.ledgers.values()) for (const claim of Object.values(ledger.claims)) {
      if (claim.status === 'reserved' && claim.dirId === dirId && claim.exposureId !== exposure.exposureId) taken.add(claim.foldedStem);
    }
    return taken;
  }

  // Claim files make a reservation visible to every PhotoCull process writing into the same folder.
  claimFile(shoot, dirId, foldedStem) {
    const name = createHash('sha256').update(`${dirId}\0${foldedStem}`).digest('hex');
    return path.join(shoot.canonicalRoot, STAGE, 'claims', `${name}.claim`);
  }
  async readClaim(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { return error.code === 'ENOENT' ? null : {}; }
  }
  // Wins the folded stem in that folder, or reports it as someone else's.
  async takeClaim(ledger, claim) {
    const shoot = ledger.shoot, file = this.claimFile(shoot, claim.dirId, claim.foldedStem);
    const body = JSON.stringify({ shootId: shoot.shootId, claimId: claim.claimId, exposureId: claim.exposureId, memberId: claim.memberId });
    await fs.mkdir(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await fs.writeFile(file, body, { flag: 'wx' }); return true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const held = await this.readClaim(file);
      if (held === null) continue;
      if (held.shootId === shoot.shootId && held.exposureId === claim.exposureId && held.memberId === claim.memberId) { await atomicWrite(file, body); return true; }
      // A claim its own journal no longer holds was left behind by an interrupted release.
      const owner = typeof held.shootId === 'string' && this.ledgers.get(held.shootId);
      if (!owner || owner.claims[held.claimId]?.status === 'reserved') return false;
      await fs.unlink(file).catch(() => {});
    }
    return false;
  }
  async releaseClaim(ledger, claim) {
    claim.status = 'released';
    const file = this.claimFile(ledger.shoot, claim.dirId, claim.foldedStem), held = await this.readClaim(file);
    if (held?.shootId === ledger.shoot.shootId && held.claimId === claim.claimId) await fs.unlink(file).catch(() => {});
  }
  async releaseClaims(ledger, keep) {
    for (const claim of Object.values(ledger.claims)) if (claim.status === 'reserved' && !keep(claim)) await this.releaseClaim(ledger, claim);
  }

  async reserveStem(ledger, exposure, member, wanted, ext) {
    const shoot = ledger.shoot, dir = this.absolute(shoot, exposure.targetRelDir);
    const taken = await this.takenStems(shoot, dir, exposure.targetDirId, exposure);
    for (let n = 1; n < 100_000; n++) {
      const stem = n === 1 ? wanted : `${wanted}-${n}`;
      if (!validStem(stem, ext) || Buffer.byteLength(stem + ext) > 255) fail('NAME_INVALID', 'The capture filename is too long once made unique.');
      if (taken.has(fold(stem))) continue;
      const claim = { claimId: randomUUID(), dirId: exposure.targetDirId, relDir: exposure.targetRelDir, foldedStem: fold(stem), stem, exposureId: exposure.exposureId, memberId: member.separate ? member.memberId : null, status: 'reserved' };
      if (!await this.takeClaim(ledger, claim)) continue;
      ledger.claims[claim.claimId] = claim;
      return { stem, claimId: claim.claimId };
    }
    fail('NAME_TAKEN', 'No free capture filename is available.');
  }

  hold(ledger, events, member, code, message, actions = []) {
    const exposure = ledger.exposures[member.exposureId];
    // Once rejected for its content, a file stays unpublishable whatever later goes wrong with it.
    if (member.code === UNPUBLISHABLE) [code, message] = [UNPUBLISHABLE, member.reason];
    const retryable = code !== UNPUBLISHABLE;
    if (!retryable) actions = [];
    Object.assign(member, { heldFrom: member.status === 'held' ? member.heldFrom : member.status, status: 'held', code, reason: message });
    exposure.status = 'needsAttention';
    events.push(['tether-issue', { session: ledger.shoot.session, exposureId: exposure.exposureId, memberId: member.memberId, code, message, retryable, actions }]);
    return Object.assign(coded(code, message, { retryable, actions }), { persist: true });
  }

  reserve(shootId, memberId, stagedReceipt, shotMetadata = null) {
    return this.tx(shootId, async (ledger, events) => {
      const shoot = ledger.shoot, member = ledger.members[id(memberId, 'memberId')] ?? fail('STALE_REV', 'Unknown capture member.', { field: 'memberId' });
      const exposure = ledger.exposures[member.exposureId];
      const plan = () => ({ stem: path.basename(member.finalRelPath, path.extname(member.finalRelPath)), finalRelPath: member.finalRelPath, claimId: member.claimId, dirId: exposure.targetDirId });
      if (member.status === 'held') fail(member.code || 'INCOMPLETE', member.reason || 'This capture needs attention.', { retryable: true });
      only(stagedReceipt, ['bytes', 'sha256'], 'staged receipt');
      if (!Number.isSafeInteger(stagedReceipt.bytes) || stagedReceipt.bytes <= 0) fail('INCOMPLETE', 'The staged capture is empty.');
      if (stagedReceipt.sha256 !== undefined && !/^[\da-f]{64}$/i.test(stagedReceipt.sha256)) fail('UNSUPPORTED', 'Invalid staged hash.', { field: 'sha256' });
      const sha = stagedReceipt.sha256?.toLowerCase() ?? null;
      // Whatever was journaled is the photo; a different staged file is never published under its name.
      const differs = (member.sha256 && sha !== member.sha256) || (member.receivedBytes && stagedReceipt.bytes !== member.receivedBytes);
      if (['published', 'ingested'].includes(member.status)) return differs ? fail('IO_ERROR', 'The staged capture does not match the published file.') : plan();
      if (differs) throw this.hold(ledger, events, member, 'INCOMPLETE', 'The staged capture no longer matches what the camera sent.', ['retry']);
      if (member.status === 'reserved') return plan();
      if (member.declaredBytes !== null && member.declaredBytes !== stagedReceipt.bytes) fail('INCOMPLETE', 'The staged capture is incomplete.', { retryable: true });
      const staged = await fs.lstat(path.join(shoot.canonicalRoot, ...member.stageRelPath.split('/'))).catch(() => null);
      if (!staged?.isFile() || staged.size !== stagedReceipt.bytes) fail('INCOMPLETE', 'The staged capture does not match its receipt.', { retryable: true });
      Object.assign(member, { receivedBytes: stagedReceipt.bytes, sha256: sha, status: 'staged' });
      // The first complete object supplies the naming metadata; later dial readings never replace it.
      if (shotMetadata && !exposure.shot) exposure.shot = cameraSnapshot(shotMetadata);
      const dir = this.absolute(shoot, exposure.targetRelDir), ext = path.extname(member.originalName);
      if (await this.directoryIdentity(shoot, exposure.targetRelDir).catch(() => null) !== exposure.targetDirId) throw this.hold(ledger, events, member, 'DEST_CHANGED', 'The capture folder changed or is unavailable.', ['retry']);
      let stem;
      if (member.separate || !exposure.stem) {
        let wanted = exposure.stemOverride ?? exposure.stem;
        if (!wanted) {
          const shot = { ...exposure.camera, ...exposure.shot }, policy = exposure.frozenPolicy;
          try {
            wanted = renderCaptureName(policy.namingTemplate, { jobName: policy.jobName, counter: exposure.captureCounter, cameraCounter: exposure.cameraCounter, captureTime: shot.captureTime ?? exposure.captureTime, hostTime: exposure.hostTime,
              iso: shot.iso, shutter: shot.shutter, aperture: shot.aperture, focalLength: shot.focalLength, camera: shot.model, subfolder: exposure.targetRelDir.split('/').at(-1) || path.basename(this.libraryRoot(shoot)),
              original: path.basename(member.originalName, ext), extension: ext, allowedExtensions: SUPPORTED }).stem;
          } catch (error) { throw this.hold(ledger, events, member, 'NAME_INVALID', `Needs name: ${error.message}`, ['repairName']); }
        }
        const reserved = await this.reserveStem(ledger, exposure, member, wanted, ext);
        stem = reserved.stem; member.claimId = reserved.claimId;
        if (!member.separate) Object.assign(exposure, { stem, claimId: reserved.claimId });
      } else {
        stem = exposure.stem; member.claimId = exposure.claimId;
        // Never pair with, or replace, a file another writer put there. Any same-stem RAW or JPEG
        // would join this group, so each is excluded from pairing; one in this member's own role
        // (.jpg and .jpeg alike) also takes its place.
        const own = new Set(Object.values(ledger.members).filter(m => m.exposureId === exposure.exposureId && m.finalRelPath).map(m => fold(path.posix.basename(m.finalRelPath))));
        const family = e => RAW.has(e.toLowerCase()) ? 'raw' : JPEG.has(e.toLowerCase()) ? 'jpeg' : null;
        const foreign = (await fs.readdir(dir)).filter(name => fold(path.basename(name, path.extname(name))) === fold(stem) && family(path.extname(name)) && !own.has(fold(name)));
        for (const name of foreign) await this.exclude(path.join(dir, name));
        const rival = foreign.find(name => family(path.extname(name)) === family(ext));
        if (rival) {
          member.claimId = null;
          throw this.hold(ledger, events, member, 'NAME_TAKEN', `${rival} already exists. Save this file separately with a unique name.`, ['saveSeparate']);
        }
      }
      Object.assign(member, { finalRelPath: [exposure.targetRelDir, stem + ext].filter(Boolean).join('/'), status: 'reserved' });
      return plan();
    });
  }

  ingest(shootId, memberId, claimId, publishedReceipt) {
    return this.tx(shootId, async (ledger, events) => {
      const member = ledger.members[id(memberId, 'memberId')] ?? fail('STALE_REV', 'Unknown capture member.', { field: 'memberId' });
      const exposure = ledger.exposures[member.exposureId];
      if (member.status === 'ingested') return { exposureId: exposure.exposureId, itemId: this.sessionItem(ledger.shoot, exposure.currentItemId)?.id ?? exposure.currentItemId, rev: ledger.shoot.libraryRev };
      if (!['reserved', 'published'].includes(member.status)) fail('INCOMPLETE', 'This capture has not been reserved.', { retryable: true });
      if (claimId !== member.claimId) fail('STALE_REV', 'The filename reservation changed.', { field: 'claimId' });
      only(publishedReceipt, ['finalRelPath', 'bytes', 'dev', 'ino'], 'published receipt');
      if (publishedReceipt.finalRelPath !== member.finalRelPath || publishedReceipt.bytes !== member.receivedBytes) fail('IO_ERROR', 'The published file does not match its reservation.');
      const stat = await fs.lstat(this.absolute(ledger.shoot, member.finalRelPath)).catch(() => null);
      const same = (claimed, actual) => claimed === undefined || String(claimed) === String(actual);
      if (!stat?.isFile() || stat.size !== member.receivedBytes || !same(publishedReceipt.dev, stat.dev) || !same(publishedReceipt.ino, stat.ino)) fail('DEST_CHANGED', 'The published file is not the one that was written.');
      member.status = 'published';
      return this.ingestMember(ledger, events, member, publishedReceipt);
    });
  }

  async ingestMember(ledger, events, member, receipt = {}) {
    const shoot = ledger.shoot, exposure = ledger.exposures[member.exposureId], policy = exposure.frozenPolicy;
    const delta = await this.library.ingestCapture(shoot.session, { path: this.absolute(shoot, member.finalRelPath), shootId: shoot.shootId, exposureId: exposure.exposureId, ordinal: exposure.ordinal,
      expectedRoles: exposure.expectedHostRoles, initial: policy.initial, captureMetadata: policy.metadata, develop: { recipe: policy.adjustments.recipe, settings: policy.adjustments.settings }, separate: member.separate,
      fileIdentity: { size: member.receivedBytes, ...(receipt.dev !== undefined ? { dev: receipt.dev } : {}), ...(receipt.ino !== undefined ? { ino: receipt.ino } : {}) } });
    Object.assign(member, { status: 'ingested', fileIdentity: { bytes: member.receivedBytes, dev: receipt.dev ?? null, ino: receipt.ino ?? null } });
    if (!member.separate || !exposure.currentItemId) exposure.currentItemId = delta.itemId;
    const settled = new Set(Object.values(ledger.members).filter(m => m.exposureId === exposure.exposureId && m.status === 'ingested').map(m => m.role));
    exposure.status = exposure.expectedHostRoles.every(r => settled.has(r)) ? 'complete' : 'availablePartial';
    if (exposure.status === 'complete') await this.releaseClaims(ledger, claim => claim.exposureId !== exposure.exposureId);
    shoot.libraryRev = delta.rev;
    if (delta.upserts.length || delta.remap.length || delta.removedIds.length) { this.onDelta(delta); events.push(['tether-library-delta', delta]); }
    return { exposureId: exposure.exposureId, itemId: delta.itemId, rev: delta.rev };
  }

  // A file at a member's reserved name that is not the journaled photo.
  async occupied(shoot, member) {
    const final = this.absolute(shoot, member.finalRelPath), stat = await fs.lstat(final).catch(() => null);
    if (!stat) return false;
    return !stat.isFile() || stat.size !== member.receivedBytes || (!!member.sha256 && await sha256File(final) !== member.sha256);
  }
  // A foreign file at a reserved name only meets this capture when a sibling already uses that stem.
  async excludeFromPair(ledger, member) {
    const siblings = Object.values(ledger.members).some(m => m !== member && m.exposureId === member.exposureId && !m.separate && m.finalRelPath && ['reserved', 'published', 'ingested'].includes(m.status));
    if (siblings && member.finalRelPath) await this.exclude(this.absolute(ledger.shoot, member.finalRelPath));
  }

  // Reconciles this shoot's own pending members after a restart without allocating anything new.
  async recover(ledger, events) {
    const shoot = ledger.shoot, records = [];
    const stageOf = member => path.join(shoot.canonicalRoot, ...member.stageRelPath.split('/'));
    const holdRecord = (record, member, code, message, actions) => { this.hold(ledger, events, member, code, message, actions); records.push({ ...record, state: 'held', code, message }); };
    for (const claim of Object.values(ledger.claims)) if (claim.status === 'released') await this.releaseClaim(ledger, claim);
    for (const member of Object.values(ledger.members)) {
      const record = { exposureId: member.exposureId, memberId: member.memberId, originalName: member.originalName, ...receiptOf(member) };
      if (member.status === 'held') { records.push({ ...record, state: 'held', code: member.code, message: member.reason }); continue; }
      if (member.status === 'ingested') continue;
      if (['announced', 'receiving', 'staged'].includes(member.status)) {
        const staged = await fs.lstat(stageOf(member)).catch(() => null);
        if (member.status === 'staged') {
          // Journaled as complete: only the very same bytes may still be published.
          if (staged?.isFile() && staged.size === member.receivedBytes && (!member.sha256 || await sha256File(stageOf(member)) === member.sha256)) records.push({ ...record, state: 'staged', action: 'reserve' });
          else holdRecord(record, member, 'INCOMPLETE', `${member.originalName}: the staged file is missing or changed.`, ['retry']);
        } else if (staged) {
          // Only the staged journal entry, written once the camera confirmed the transfer and the file
          // was synced, proves a stage file complete; its size alone never does.
          holdRecord(record, member, 'INCOMPLETE', `${member.originalName}: the transfer was interrupted; the partial file is kept for inspection.`, ['retry']);
        } else records.push({ ...record, state: member.status, action: 'transfer' });
        continue;
      }
      const final = this.absolute(shoot, member.finalRelPath), stat = await fs.lstat(final).catch(() => null);
      if (stat?.isFile() && stat.size === member.receivedBytes && (!member.sha256 || await sha256File(final) === member.sha256)) {
        try { await this.ingestMember(ledger, events, member, { dev: stat.dev, ino: stat.ino }); records.push({ ...record, state: 'ingested', action: 'replayed' }); }
        catch (error) { this.hold(ledger, events, member, error.code || 'IO_ERROR', error.message, ['retry']); records.push({ ...record, state: 'held', code: error.code || 'IO_ERROR', message: error.message }); }
        continue;
      }
      const staged = await fs.lstat(stageOf(member)).catch(() => null);
      if (!stat && staged?.isFile() && staged.size === member.receivedBytes && (!member.sha256 || await sha256File(stageOf(member)) === member.sha256)) { records.push({ ...record, state: 'reserved', action: 'publish' }); continue; }
      if (stat) {
        await this.excludeFromPair(ledger, member);
        holdRecord(record, member, 'NAME_TAKEN', 'A different file now uses the reserved name.', ['saveSeparate']);
      }
      else holdRecord(record, member, 'INCOMPLETE', staged ? 'The staged capture changed.' : 'The captured file is missing.', ['retry']);
    }
    return records;
  }

  journal(shootId, op, detail = {}) {
    return this.tx(shootId, async (ledger, events) => {
      const shoot = ledger.shoot, memberOf = value => ledger.members[id(value, 'memberId')] ?? fail('STALE_REV', 'Unknown capture member.', { field: 'memberId' });
      let records;
      if (op === 'lookupKeep') {
        only(detail, ['key'], 'kept shot');
        const exposure = Object.values(ledger.exposures).find(e => e.providerShotKey === detail.key);
        if (exposure) await this.releaseKeptCounter(detail.key);
        const ingested = exposure ? Object.fromEntries(Object.values(ledger.members)
          .filter(m => m.exposureId === exposure.exposureId && m.status === 'ingested')
          .map(m => [m.memberId, path.basename(m.finalRelPath)])) : {};
        return { exposureId: exposure?.exposureId ?? null, ingested };
      }
      if (op === 'issue') {
        only(detail, ['exposureId', 'memberId', 'code', 'message', 'retryable'], 'issue');
        const message = shortText(detail.message ?? 'Capture transfer failed.', 1024, 'message'), code = ISSUE_CODES.includes(detail.code) ? detail.code : 'IO_ERROR';
        if (detail.memberId) this.hold(ledger, events, memberOf(detail.memberId), code, message, ['retry']);
        else {
          const exposure = ledger.exposures[id(detail.exposureId, 'exposureId')] ?? fail('STALE_REV', 'Unknown exposure.');
          exposure.status = 'needsAttention';
          events.push(['tether-issue', { session: shoot.session, exposureId: exposure.exposureId, code, message, retryable: detail.retryable !== false, actions: ['retry', 'finishSingle'] }]);
        }
      } else if (op === 'staged') {
        // Recorded before publication, so a crash in between resumes from the verified stage file.
        only(detail, ['memberId', 'bytes', 'sha256', 'stageRelPath', 'shot'], 'staged');
        const member = memberOf(detail.memberId), exposure = ledger.exposures[member.exposureId];
        if (!Number.isSafeInteger(detail.bytes) || detail.bytes <= 0) fail('INCOMPLETE', 'The staged capture is empty.');
        if (!/^[\da-f]{64}$/i.test(detail.sha256 ?? '')) fail('UNSUPPORTED', 'Invalid staged hash.', { field: 'sha256' });
        if (detail.stageRelPath !== member.stageRelPath) fail('STALE_REV', 'The staged file belongs to another capture.', { field: 'stageRelPath' });
        const sha = detail.sha256.toLowerCase();
        if (['staged', 'reserved', 'published', 'ingested'].includes(member.status) && member.sha256) {
          if (member.sha256 !== sha || member.receivedBytes !== detail.bytes) fail('INCOMPLETE', 'This capture was already staged with different content.');
        } else {
          const staged = await fs.lstat(path.join(shoot.canonicalRoot, ...member.stageRelPath.split('/'))).catch(() => null);
          if (!staged?.isFile() || staged.size !== detail.bytes) fail('INCOMPLETE', 'The staged capture does not match its receipt.', { retryable: true });
          Object.assign(member, { receivedBytes: detail.bytes, sha256: sha });
          if (['announced', 'receiving'].includes(member.status)) member.status = 'staged';
          if (member.declaredBytes !== null && member.declaredBytes !== detail.bytes && member.status !== 'held') this.hold(ledger, events, member, 'INCOMPLETE', `${member.originalName}: the camera sent ${detail.bytes} of ${member.declaredBytes} bytes.`, ['retry']);
        }
        if (isPlain(detail.shot) && !exposure.shot) exposure.shot = cameraSnapshot(detail.shot);
      } else if (op === 'conflict') {
        only(detail, ['memberId', 'claimId'], 'conflict');
        const member = memberOf(detail.memberId), exposure = ledger.exposures[member.exposureId], claim = ledger.claims[detail.claimId];
        if (member.status !== 'reserved' || !claim || member.claimId !== claim.claimId) fail('STALE_REV', 'The reservation is no longer current.');
        // Another writer won the final name: retry allocation with that suffix excluded.
        await this.excludeFromPair(ledger, member);
        await this.releaseClaim(ledger, claim); exposure.excludedStems.push(claim.foldedStem);
        const published = Object.values(ledger.members).some(m => m.exposureId === exposure.exposureId && m !== member && ['published', 'ingested'].includes(m.status) && !m.separate);
        Object.assign(member, { status: 'staged', finalRelPath: null, claimId: null });
        if (published && !member.separate) this.hold(ledger, events, member, 'NAME_TAKEN', 'The paired filename is taken. Save this file separately with a unique name.', ['saveSeparate']);
        else if (!member.separate) Object.assign(exposure, { stem: null, claimId: null });
      } else if (op === 'recovery') {
        only(detail, ['action', 'exposureId', 'memberId', 'name'], 'recovery');
        const action = detail.action ?? 'list';
        if (action === 'retry' || action === 'saveSeparate') {
          const member = memberOf(detail.memberId);
          if (member.status !== 'held') fail('STALE_REV', 'This capture does not need recovery.');
          if (member.code === UNPUBLISHABLE) fail(UNPUBLISHABLE, member.reason || 'This file is not the image its name promises; it stays in staging.');
          if (action === 'saveSeparate' && member.code !== 'NAME_TAKEN') fail('UNSUPPORTED', 'Only a name conflict can be saved separately.');
          const back = member.heldFrom === 'reserved' && action === 'retry' && member.finalRelPath ? 'reserved' : member.receivedBytes ? 'staged' : 'announced';
          Object.assign(member, { status: back, code: null, reason: null, heldFrom: null, ...(back !== 'reserved' ? { finalRelPath: null, claimId: null } : {}), ...(action === 'saveSeparate' ? { separate: true } : {}) });
        } else if (action === 'repairName') {
          const exposure = ledger.exposures[id(detail.exposureId, 'exposureId')] ?? fail('STALE_REV', 'Unknown exposure.');
          const name = typeof detail.name === 'string' ? detail.name.normalize('NFC').trim() : '';
          if (!validStem(name, '.ARW') || name.startsWith('.') || /[. ]$/.test(name) || exposure.stem) fail('NAME_INVALID', 'Enter a valid filename without an extension.', { field: 'name' });
          exposure.stemOverride = name;
          for (const member of Object.values(ledger.members)) if (member.exposureId === exposure.exposureId && member.status === 'held' && member.code === 'NAME_INVALID') Object.assign(member, { status: 'staged', code: null, reason: null });
        } else if (action === 'finishSingle') {
          const exposure = ledger.exposures[id(detail.exposureId, 'exposureId')] ?? fail('STALE_REV', 'Unknown exposure.');
          const roles = Object.values(ledger.members).filter(m => m.exposureId === exposure.exposureId && m.status === 'ingested').map(m => m.role);
          if (!roles.length) fail('INCOMPLETE', 'No file of this capture has arrived yet.');
          exposure.expectedHostRoles = [...new Set(roles)].filter(r => r === 'raw' || r === 'jpeg');
          exposure.status = 'complete';
          await this.releaseClaims(ledger, claim => claim.exposureId !== exposure.exposureId);
        } else if (action !== 'list') fail('UNSUPPORTED', 'Unknown recovery action.', { field: 'action' });
        records = Object.values(ledger.members).filter(m => m.status !== 'ingested').map(m => ({ exposureId: m.exposureId, memberId: m.memberId, originalName: m.originalName, state: m.status, code: m.code ?? null, message: m.reason ?? null, ...receiptOf(m) }));
      } else if (op === 'close') {
        await this.library.flushSidecars();
        shoot.closedAt = this.now().toISOString();
        await this.releaseClaims(ledger, claim => ledger.exposures[claim.exposureId]?.status !== 'complete');
        if (this.activeShoot === shootId) this.activeShoot = null;
        this.primaries.delete(shootId);
      } else fail('UNSUPPORTED', 'Unknown journal operation.', { field: 'op' });
      const pending = Object.values(ledger.members).filter(m => PENDING.has(m.status)).length;
      return { state: shoot.closedAt ? 'closed' : 'open', pending, ...(records ? { records } : {}) };
    });
  }

  // Missed shots on the camera card. Nothing here touches the card: Rust lists and reads it, and
  // every file it pulls goes through the ordinary member journal, reservation and publication.
  // Clock offsets, matches and the synced mark all belong to one camera body.
  backfill(shootId, op, detail = {}) {
    if (op === 'window') return this.cardWindow(this.ledger(shootId), cameraSnapshot(only(detail, ['camera'], 'card window').camera ?? {}));
    if (op === 'plan') return this.cardPlan(this.ledger(shootId), detail);
    if (op === 'prepare') return this.cardPrepare(shootId, detail);
    if (op === 'synced') return this.tx(shootId, async ledger => {
      only(detail, ['camera', 'through'], 'card sync');
      if (wallSeconds(detail.through) === null) fail('UNSUPPORTED', 'Invalid capture time.', { field: 'through' });
      const camera = cameraSnapshot(detail.camera ?? {}), bodyKey = bodyKeyOf(camera), body = cardBody(camera), mark = ledger.shoot.backfill;
      if (!mark) return { syncedThrough: null };
      // Never past a photo of this body whose bytes have not reached the computer.
      let through = detail.through;
      const index = this.cardIndex(ledger, bodyKey);
      for (const [captureTime, exposures] of index.bySecond) {
        if (captureTime <= through && exposures.some(e => index.members(e.exposureId).some(m => ['raw', 'jpeg'].includes(m.role) && reopenable(m)))) through = secondsWall(wallSeconds(captureTime) - 1);
      }
      mark.synced ??= {};
      if (!mark.synced[body] || through > mark.synced[body]) mark.synced[body] = through;
      return { syncedThrough: mark.synced[body] };
    });
    fail('UNSUPPORTED', 'Unknown backfill operation.', { field: 'op' });
  }

  // Median camera-minus-computer clock offset this body's tethered shots showed, or null.
  cardOffset(ledger, bodyKey) {
    const offsets = Object.values(ledger.exposures).filter(e => !e.providerShotKey?.startsWith('card:') && (e.stableCameraKey ?? null) === bodyKey && e.captureTime && e.hostTime)
      .sort((a, b) => b.ordinal - a.ordinal).slice(0, 25).map(e => wallSeconds(e.captureTime) - wallSeconds(e.hostTime)).filter(Number.isFinite);
    return offsets.length ? median(offsets) : null;
  }

  // The earliest camera time a missed shot can have: this session's start moved onto the camera's
  // clock, or the newest time a full pass already settled for this body.
  cardWindow(ledger, camera) {
    const mark = ledger.shoot.backfill, start = wallSeconds(mark?.startedAt);
    if (start === null) return { since: null };
    const offset = this.cardOffset(ledger, bodyKeyOf(camera));
    let since = start + (offset === null ? -CARD_SLACK_UNKNOWN : offset - CARD_SLACK);
    const synced = wallSeconds(mark.synced?.[cardBody(camera)]);
    if (synced !== null) since = Math.max(since, synced - CARD_SLACK);
    return { since: secondsWall(Math.floor(since)) };
  }

  cardListing(detail) {
    only(detail, ['camera', 'hostRoles', 'objects', 'epoch', 'exclude', 'testShots', 'testReleases'], 'card listing');
    const camera = cameraSnapshot(detail.camera ?? {});
    const hostRoles = Array.isArray(detail.hostRoles) ? detail.hostRoles.filter(r => r === 'raw' || r === 'jpeg') : [];
    const objects = (Array.isArray(detail.objects) ? detail.objects : fail('UNSUPPORTED', 'Invalid card listing.', { field: 'objects' })).map(o => {
      only(o, ['handle', 'storageId', 'name', 'role', 'bytes', 'captureTime'], 'card object');
      // The camera's format code and the file's extension must agree on a photo role.
      const name = cameraFilename(o.name), role = captureMember(null, '', name, null).role;
      if (role !== o.role || !['raw', 'jpeg'].includes(role)) return null;
      for (const field of ['handle', 'storageId', 'bytes']) if (!Number.isSafeInteger(o[field]) || o[field] < 0) fail('UNSUPPORTED', `Invalid ${field}.`, { field });
      if (wallSeconds(o.captureTime) === null) fail('UNSUPPORTED', 'Invalid capture time.', { field: 'captureTime' });
      return { handle: o.handle, storageId: o.storageId, name, role, bytes: o.bytes, captureTime: o.captureTime };
    }).filter(Boolean);
    const list = (value, field) => value === undefined ? [] : Array.isArray(value) ? value : fail('UNSUPPORTED', `Invalid ${field}.`, { field });
    const exclude = list(detail.exclude, 'exclude').filter(x => typeof x === 'string');
    const testShots = list(detail.testShots, 'testShots').map(t => {
      only(t, ['captureTime', 'stem'], 'test shot');
      if (wallSeconds(t.captureTime) === null || typeof t.stem !== 'string') fail('UNSUPPORTED', 'Invalid test shot.', { field: 'testShots' });
      return `${t.captureTime}\0${fold(t.stem)}`;
    });
    const testReleases = list(detail.testReleases, 'testReleases').map(at => Number.isSafeInteger(at) && at > 0 ? at : fail('UNSUPPORTED', 'Invalid test release.', { field: 'testReleases' }));
    return { camera, bodyKey: bodyKeyOf(camera), body: cardBody(camera), hostRoles, objects, exclude, testShots: new Set(testShots), testReleases };
  }

  // One exposure per capture second and file stem, RAW first; ordered oldest first.
  cardGroups(body, objects) {
    const groups = new Map();
    for (const o of objects) {
      const stem = stemOf(o.name), at = `${o.captureTime}\0${stem}`;
      if (!groups.has(at)) groups.set(at, { key: `card:${digest(`${body}\0${o.captureTime}\0${stem}`).slice(0, 40)}`, captureTime: o.captureTime, stem, objects: [] });
      const group = groups.get(at);
      if (!group.objects.some(x => x.role === o.role)) group.objects.push({ ...o, objectKey: `${group.key}:${digest(fold(o.name)).slice(0, 16)}` });
    }
    for (const g of groups.values()) g.objects.sort((a, b) => (a.role === 'raw' ? 0 : 1) - (b.role === 'raw' ? 0 : 1));
    return [...groups.values()].sort((a, b) => a.captureTime < b.captureTime ? -1 : a.captureTime > b.captureTime ? 1 : a.stem < b.stem ? -1 : 1);
  }

  // Exposures by provider key and, for one body, by capture second; members by exposure.
  cardIndex(ledger, bodyKey) {
    const members = new Map(), byKey = new Map(), bySecond = new Map();
    for (const m of Object.values(ledger.members)) members.set(m.exposureId, [...members.get(m.exposureId) ?? [], m]);
    for (const e of Object.values(ledger.exposures).sort((a, b) => a.ordinal - b.ordinal)) {
      if (e.providerShotKey) byKey.set(e.providerShotKey, e);
      if (e.captureTime && (e.stableCameraKey ?? null) === bodyKey) bySecond.set(e.captureTime, [...bySecond.get(e.captureTime) ?? [], e]);
    }
    return { members: exposureId => members.get(exposureId) ?? [], byKey, bySecond };
  }

  // What the ledger already holds of a card exposure. Its exposure is this body's one of the same
  // capture second holding a file of the same stem, or one that has no file yet: a burst writes
  // several frames a second, often of equal size. A member whose transfer never completed is
  // reopened; one whose photo may still arrive another way is deferred.
  cardTarget(index, group, hostRoles, exclude) {
    const candidates = index.bySecond.get(group.captureTime) ?? [], own = e => index.members(e.exposureId);
    const exposure = index.byKey.get(group.key) ?? candidates.find(e => own(e).some(m => stemOf(m.originalName) === group.stem))
      ?? candidates.find(e => !e.providerShotKey?.startsWith('card:') && !own(e).length);
    const roles = group.objects.map(o => o.role), offered = hostRoles.filter(r => roles.includes(r)), visible = offered.length ? offered : roles;
    // A card exposure expects every role the card shows, whichever pass first saw it.
    const wanted = !exposure ? visible : exposure.providerShotKey === group.key ? [...new Set([...exposure.expectedHostRoles, ...visible])] : exposure.expectedHostRoles;
    const objects = group.objects.filter(o => wanted.includes(o.role)), todo = [], deferred = [];
    let present = 0;
    for (const object of objects) {
      const mine = exposure ? own(exposure).filter(m => m.role === object.role) : [];
      if (mine.some(m => exclude.includes(m.memberId))) { deferred.push(object); continue; }
      if (mine.some(m => !reopenable(m))) { present++; continue; }
      const member = mine.find(m => m.providerObjectKey === object.objectKey) ?? mine.find(m => stemOf(m.originalName) === group.stem) ?? mine[0];
      todo.push({ object, memberId: member?.memberId ?? null });
    }
    return { exposure, wanted, objects, todo, deferred, present };
  }

  // Which card exposures to pull, each with all of its photo files so a pair stays one exposure.
  // `unsettled` capture times must stay inside the next pass's window.
  cardPlan(ledger, detail) {
    const { bodyKey, body, hostRoles, objects, exclude, testShots, testReleases } = this.cardListing(detail);
    const index = this.cardIndex(ledger, bodyKey), open = [];
    let present = 0, tested = 0;
    for (const group of this.cardGroups(body, objects)) {
      // A test shot known by its own capture time and name never joins the shoot.
      if (testShots.has(`${group.captureTime}\0${group.stem}`)) { tested++; continue; }
      const target = this.cardTarget(index, group, hostRoles, exclude);
      if (target.todo.length || target.deferred.length) open.push({ group, target });
      else if (target.present) present++;
    }
    // A test shot released but never delivered has no name to match: the first frame taken after
    // its release stays on the card, or every frame near it while this body's clock is unknown.
    const offset = this.cardOffset(ledger, bodyKey), held = new Set(), consumed = [];
    for (const at of testReleases) {
      const released = wallSeconds(wallClock(new Date(at))), pullable = open.filter(o => o.target.todo.length && !held.has(o));
      if (offset === null) {
        for (const o of pullable) if (Math.abs(wallSeconds(o.group.captureTime) - released) <= CARD_SLACK_UNKNOWN) held.add(o);
        continue;
      }
      const first = pullable.find(o => { const d = wallSeconds(o.group.captureTime) - released - offset; return d >= -TEST_EARLY && d <= TEST_LATE; });
      if (first) { held.add(first); consumed.push(at); }
    }
    const groups = [], unsettled = [];
    for (const o of open) {
      if (held.has(o) || o.target.deferred.length) unsettled.push(o.group.captureTime);
      if (!held.has(o) && o.target.todo.length) groups.push({ captureTime: o.group.captureTime, objects: o.target.objects.map(({ objectKey, ...x }) => x) });
    }
    return { groups, present, tested, held: held.size, unsettled, consumed };
  }

  // Re-checks one exposure right before its files are read, then creates or reopens its members.
  async cardPrepare(shootId, detail) {
    const listing = this.cardListing(detail), { bodyKey, hostRoles, exclude } = listing;
    const [group, ...rest] = this.cardGroups(listing.body, listing.objects);
    if (!group || rest.length) fail('UNSUPPORTED', 'A card exposure is one capture.', { field: 'objects' });
    const handles = objects => objects.map(o => ({ handle: o.handle, storageId: o.storageId }));
    const first = this.cardTarget(this.cardIndex(this.ledger(shootId), bodyKey), group, hostRoles, exclude);
    if (!first.todo.length) return { exposureId: first.exposure?.exposureId ?? null, members: [], deferred: handles(first.deferred) };
    const exposureId = first.exposure?.exposureId
      ?? (await this.accept(shootId, detail.epoch, null, { key: group.key }, first.wanted, { ...listing.camera, captureTime: group.captureTime })).exposureId;
    return this.tx(shootId, async ledger => {
      const exposure = ledger.exposures[exposureId];
      const { todo, wanted, deferred } = this.cardTarget(this.cardIndex(ledger, bodyKey), group, hostRoles, exclude), members = [];
      if (exposure.providerShotKey === group.key) for (const role of wanted.filter(r => !exposure.expectedHostRoles.includes(r))) {
        exposure.expectedHostRoles.push(role);
        if (exposure.status === 'complete') exposure.status = 'availablePartial';
      }
      for (const { object, memberId } of todo) {
        let member = memberId && ledger.members[memberId];
        if (member?.status === 'held') Object.assign(member, { status: 'announced', code: null, reason: null, heldFrom: null, finalRelPath: null, claimId: null });
        else if (!member) {
          member = captureMember(exposure.exposureId, randomUUID(), object.name, object.bytes || null, object.objectKey);
          ledger.members[member.memberId] = member;
        }
        members.push({ handle: object.handle, storageId: object.storageId, memberId: member.memberId, stageRelPath: member.stageRelPath, status: member.status, originalName: member.originalName, declaredBytes: member.declaredBytes });
      }
      const open = Object.values(ledger.members).filter(m => m.exposureId === exposure.exposureId);
      if (['accepted', 'needsAttention'].includes(exposure.status) && members.length && !open.some(m => m.status === 'held')) exposure.status = 'transferring';
      return { exposureId: exposure.exposureId, members, deferred: handles(deferred) };
    });
  }

  async sessionFrame(sessionId, itemId, kind, original, contentRev) {
    if (!['thumb', 'preview', 'full'].includes(kind)) fail('UNSUPPORTED', 'Invalid frame kind.', { field: 'kind' });
    const item = this.library.item(id(sessionId, 'session'), id(itemId)), rev = item.contentRev || 0;
    if (rev !== revision(contentRev, 'contentRev')) fail('STALE_REV', 'The photo changed; request its current frame.', { currentRev: rev });
    const size = await this.dimensions(sessionId, item.id);
    return { contentRev: rev, width: size?.width ?? null, height: size?.height ?? null,
      route: `/image/${encodeURIComponent(sessionId)}/${encodeURIComponent(item.id)}/${kind}?v=${rev}${original === true ? '&original=1' : ''}` };
  }

  asset(shootId, op, asset) {
    return this.tx(shootId, async ledger => {
      const shoot = ledger.shoot;
      if (op === 'bind') {
        only(asset, ['assetId', 'sha256', 'width', 'height', 'bytes'], 'asset');
        id(asset.assetId, 'assetId');
        if (!/^[\da-f]{64}$/i.test(asset.sha256 ?? '') || ![asset.width, asset.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 4096) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 32 * 1024 ** 2) fail('UNSUPPORTED', 'Invalid overlay image.');
        shoot.overlayAsset = { assetId: asset.assetId, sha256: asset.sha256.toLowerCase(), width: asset.width, height: asset.height, bytes: asset.bytes };
        return { ...shoot.overlayAsset };
      }
      if (op === 'lookup') return shoot.overlayAsset && shoot.overlayAsset.assetId === asset?.assetId ? { ...shoot.overlayAsset } : null;
      if (op === 'clear') {
        const assetId = shoot.overlayAsset?.assetId ?? null;
        shoot.overlayAsset = null;
        return { assetId, inUse: assetId !== null && await this.assetInUse(shoot.shootId, assetId) };
      }
      fail('UNSUPPORTED', 'Unknown asset operation.', { field: 'op' });
    });
  }

  // Overlay files are content-addressed and shared, so one is deleted only when no shoot names it.
  async assetInUse(exceptShoot, assetId) {
    const names = await fs.readdir(path.join(this.dir, 'shoots')).catch(() => []);
    for (const name of names) {
      const shootId = name.replace(/\.json$/, '');
      if (shootId === exceptShoot || shootId === name) continue;
      let shoot = this.ledgers.get(shootId)?.shoot;
      if (!shoot) try { shoot = JSON.parse(await fs.readFile(path.join(this.dir, 'shoots', name), 'utf8')).shoot; } catch { return true; }
      if (shoot?.overlayAsset?.assetId === assetId) return true;
    }
    return false;
  }

  async space(shoot) {
    const dir = this.absolute(shoot, shoot.activeRelDir);
    const stat = await fs.statfs(dir).catch(() => null);
    if (!stat) return { freeBytes: null, estimatedShots: null };
    const ledger = this.ledgers.get(shoot.shootId), members = Object.values(ledger.members);
    const pending = Object.values(ledger.exposures).filter(e => !['complete'].includes(e.status));
    const reserved = pending.reduce((sum, e) => {
      const own = members.filter(m => m.exposureId === e.exposureId && PENDING.has(m.status) && !['published'].includes(m.status));
      return sum + (own.length ? own.reduce((n, m) => n + (m.declaredBytes ?? BUDGET), 0) : e.status === 'accepted' ? BUDGET : 0);
    }, 0);
    const sizes = Object.values(ledger.exposures).filter(e => e.status === 'complete').sort((a, b) => b.ordinal - a.ordinal).slice(0, 10)
      .map(e => members.filter(m => m.exposureId === e.exposureId && m.status === 'ingested').reduce((n, m) => n + m.receivedBytes, 0)).filter(Boolean);
    const freeBytes = stat.bavail * stat.bsize, usable = Math.max(0, freeBytes - reserved - SAFETY);
    return { freeBytes, reservedBytes: reserved, estimatedShots: sizes.length ? Math.floor(usable / median(sizes)) : null };
  }

  async state(sessionId) {
    const ledger = [...this.ledgers.values()].find(l => l.shoot.session === sessionId && !l.shoot.closedAt);
    if (!ledger) return { session: sessionId ?? null, shootId: null };
    const { shoot } = ledger, members = Object.values(ledger.members);
    const queue = { pending: members.filter(m => PENDING.has(m.status)).length, receiving: members.filter(m => m.status === 'announced' || m.status === 'receiving').length,
      pendingPairs: Object.values(ledger.exposures).filter(e => e.status === 'availablePartial').length, held: members.filter(m => m.status === 'held').length };
    const issues = members.filter(m => m.status === 'held').map(m => ({ exposureId: m.exposureId, memberId: m.memberId, code: m.code, message: m.reason, retryable: m.code !== UNPUBLISHABLE,
      actions: m.code === UNPUBLISHABLE ? [] : m.code === 'NAME_TAKEN' ? ['saveSeparate'] : m.code === 'NAME_INVALID' ? ['repairName'] : ['retry'] }));
    return { session: shoot.session, shootId: shoot.shootId, configRev: shoot.configRev, libraryRev: shoot.libraryRev, config: structuredClone(shoot.config), location: this.location(shoot),
      counters: { ...shoot.counters, camera: shoot.lastBodyKey ? this.cameraCounters.bodies[shoot.lastBodyKey] ?? 0 : null }, queue, space: await this.space(shoot), issues, overlayAsset: shoot.overlayAsset };
  }

  async libraryState(shootId, sessionId) {
    const { shoot } = this.ledger(shootId), ledger = this.ledgers.get(shootId);
    if (sessionId !== shoot.session) fail('STALE_SESSION', 'The tethered Library was reopened. Refresh and try again.');
    await this.library.ingests.catch(() => {});
    const s = this.library.get(sessionId);
    return { shootId, session: sessionId, rev: s.rev || 0, library: this.library.publicSession(s), latestOrdinal: shoot.nextOrdinal - 1,
      pendingPairs: Object.values(ledger.exposures).filter(e => e.status === 'availablePartial').map(e => ({ exposureId: e.exposureId, ordinal: e.ordinal, itemId: this.sessionItem(shoot, e.currentItemId)?.id ?? null })) };
  }
}

module.exports = { TetherService, copyGroups, GROUP_PATHS, STAGE };
