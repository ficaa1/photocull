const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { ExifTool } = require('exiftool-vendored');
const { PriorityQueue } = require('./queue.cjs');
const { hash } = require('./library.cjs');
const { atomicWrite } = require('./xmp.cjs');
const { RawRenderCache } = require('./raw-cache.cjs');

sharp.concurrency(1);
sharp.cache({ memory: 48, files: 24, items: 64 });
const SIZES = { thumb: 400, preview: 2560, full: null };
const POLICIES = ['missing', 'small', 'off'];
const TAGS = ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailTIFF', 'ThumbnailImage'];
const RANGES = { JpgFromRaw: ['JpgFromRawStart','JpgFromRawLength'], PreviewImage: ['PreviewImageStart','PreviewImageLength'], ThumbnailImage: ['ThumbnailOffset','ThumbnailLength'] };
const TRANSIENT = new Set(['EIO', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC']);
function orient(image, orientation) {
  const angle = { 3: 180, 4: 180, 5: 270, 6: 90, 7: 90, 8: 270 }[orientation] || 0;
  if ([2, 4, 5, 7].includes(orientation)) image = image.flop();
  return angle ? image.rotate(angle) : image;
}
function touch(...files) {
  const now = new Date();
  for (const file of files) void fs.utimes(file, now, now).catch(() => {});
}
function chooseCandidate(candidates, edge) {
  const sorted = candidates.toSorted((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  return sorted.find(c => Math.max(c.width, c.height) >= edge) || sorted.at(-1) || null;
}
class PreviewService {
  constructor(cacheDir, { maxDiskBytes = 2 * 1024 ** 3, maxMemoryBytes = 96 * 1024 ** 2,
    rendering = 'missing', onState = () => {}, render, renderTimeoutMs = 45000, exif } = {}) {
    this.cacheDir = cacheDir; this.maxDiskBytes = maxDiskBytes; this.maxMemoryBytes = maxMemoryBytes;
    this.memory = new Map(); this.memoryBytes = 0;
    this.queue = new PriorityQueue(3); this.sources = new PriorityQueue(2);
    this.exif = exif || new ExifTool({ maxProcs: 2, taskTimeoutMillis: 15000 });
    this.suspendedHandoffs = new Set(); this.editorName = null; this.sourceInfo = new Map(); this.infoByKind = new Map(); this.states = new Map(); this.metadataJobs = new Map();
    this.inventories = new Map(); this.extracting = new Map(); this.sizes = new Map();
    this.policy = POLICIES.includes(rendering) ? rendering : 'missing';
    this.revision = 0; this.itemRevisions = new Map(); this.focusIds = new Set(); this.visibleIds = new Set();
    this.onState = onState; this.closed = false;
    this.stats = { memoryHits: 0, diskHits: 0, generated: 0, embeddedExtractions: 0, directExtractions: 0 };
    this.renders = new RawRenderCache(cacheDir, { render, timeoutMs: renderTimeoutMs,
      onState: (item, status) => this.emit(item, status) });
    this.lastPrune = 0;
  }
  // Keep the photo id for scheduling, but cache finished pixels under the TIFF's own file stamp.
  async displayItem(item) {
    if (this.suspendedHandoffs.has(item.id) || !(item.develop?.editedBy || item.develop?.edited) || !item.develop.tiff) return item;
    const file = item.develop.tiff, stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('The External edit is unavailable.');
    return { ...item, path: file, fingerprint: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, raw: false, companion: null, develop: null, externalSource: item.develop.editedBy || 'dehancer' };
  }
  invalidatePhoto(item) {
    this.itemRevisions.set(item.id, (this.itemRevisions.get(item.id) || 0) + 1);
    this.queue.cancelWhere(job => job.key.split(':')[1] === item.id);
    this.states.delete(item.id); this.sourceInfo.delete(item.id);
    for (const kind of Object.keys(SIZES)) this.infoByKind.delete(`${item.id}:${kind}`);
    this.emit(item, { state: 'invalidated' });
  }
  async suspendHandoffs(items) {
    for (const item of items) { this.suspendedHandoffs.add(item.id); this.invalidatePhoto(item); }
    await this.queue.idle();
    // libvips can retain open inputs in its operation cache; release Windows deletion/replacement locks.
    sharp.cache(false); sharp.cache({ memory: 48, files: 24, items: 64 });
  }
  resumeHandoffs(items) { for (const item of items) { this.suspendedHandoffs.delete(item.id); this.invalidatePhoto(item); } }
  baseKey(item) { return hash(`sources-v2:${item.path}:${item.fingerprint}`); }
  key(item, kind) { return hash(`representation-v4-srgb:${this.baseKey(item)}:${kind}:${this.policy}:${this.itemRevisions.get(item.id) || 0}`); }
  emit(item, status) { this.states.set(item.id, status); this.onState({ id: item.id, ...status }); }
  setInfo(item, kind, info) {
    this.infoByKind.set(`${item.id}:${kind}`, info);
    this.sourceInfo.set(item.id, this.infoByKind.get(`${item.id}:preview`) || info);
  }
  info(item, kind = 'preview') { return this.infoByKind.get(`${item.id}:${kind}`) || this.sourceInfo.get(item.id); }
  status(item, kind = 'preview') { return { ...(this.states.get(item.id) || {}), info: this.info(item, kind) }; }
  setPolicy(value) {
    if (!POLICIES.includes(value)) throw new Error('Unknown RAW rendering option.');
    this.policy = value; this.revision++;
    this.infoByKind.clear(); this.sourceInfo.clear();
    this.queue.cancelWhere(() => true);
    if (value === 'off') this.renders.queue.cancelWhere(() => true);
  }
  focus(items) {
    this.focusIds = new Set(items.map(i => i.id));
    this.queue.cancelWhere(job => /^(preview|full):/.test(job.key) && !this.focusIds.has(job.key.split(':')[1]));
    this.renders.cancelObsolete(new Set([...this.focusIds, ...this.visibleIds]));
  }
  visible(items) {
    this.visibleIds = new Set(items.map(i => i.id));
    const keep = new Set([...this.focusIds, ...this.visibleIds]);
    this.queue.cancelWhere(job => !keep.has(job.key.split(':')[1]));
    this.renders.cancelObsolete(keep);
  }
  remember(key, data, info) {
    if (data.length > this.maxMemoryBytes) return;
    if (this.memory.has(key)) this.memoryBytes -= this.memory.get(key).data.length;
    this.memory.delete(key); this.memory.set(key, { data, info }); this.memoryBytes += data.length;
    while (this.memoryBytes > this.maxMemoryBytes && this.memory.size) {
      const first = this.memory.keys().next().value;
      this.memoryBytes -= this.memory.get(first).data.length; this.memory.delete(first);
    }
  }
  async inventory(item) {
    const key = this.baseKey(item);
    if (!this.inventories.has(key)) {
      const job = (async () => {
        await fs.mkdir(this.cacheDir, { recursive: true });
        const file = path.join(this.cacheDir, key + '.inventory.json');
        let record;
        try { record = JSON.parse(await fs.readFile(file, 'utf8'));
          if (record?.version !== 2 || !record.candidates || typeof record.candidates !== 'object') record = null; }
        catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
        if (!record) {
          let tags = {}, known = false;
          try {
            tags = await this.exif.readRaw(item.path, { readArgs: ['-fast', '-Orientation#', '-ImageWidth', '-ImageHeight', '-ExifImageWidth', '-ExifImageHeight', ...TAGS.map(t => '-' + t), ...Object.values(RANGES).flat().map(tag => '-' + tag)] });
            known = !tags.errors?.length;
          } catch (e) { if (TRANSIENT.has(e.code)) throw e; }
          const candidates = {};
          for (const tag of TAGS) if (known && !tags[tag]) candidates[tag] = { status: 'missing' };
          record = { version: 2, orientation: Number(tags.Orientation) || null,
            width: Number(tags.ExifImageWidth || tags.ImageWidth) || 0,
            height: Number(tags.ExifImageHeight || tags.ImageHeight) || 0, ranges: Object.fromEntries(Object.entries(RANGES).map(([tag,[start,length]])=>[tag,{start:Number(tags[start]),length:Number(tags[length])}])), candidates };
          await atomicWrite(file, JSON.stringify(record));
        }
        return { key, file, record, writes: Promise.resolve() };
      })();
      this.inventories.set(key, job);
      job.catch(() => this.inventories.delete(key));
      if (this.inventories.size > 300) this.inventories.delete(this.inventories.keys().next().value);
    }
    return this.inventories.get(key);
  }
  saveInventory(inventory) {
    inventory.writes = inventory.writes.catch(() => {}).then(() => atomicWrite(inventory.file, JSON.stringify(inventory.record)));
    return inventory.writes;
  }
  async extract(item, inventory, tag) {
    const cached = inventory.record.candidates[tag];
    if (cached?.status === 'ready') {
      try { await fs.access(path.join(this.cacheDir, cached.name)); return cached; }
      catch (e) { if (e.code !== 'ENOENT') throw e; delete inventory.record.candidates[tag]; }
    } else if (cached) return null;
    const key = `${inventory.key}:${tag}`;
    if (this.extracting.has(key)) return this.extracting.get(key);
    const job = this.sources.add(key, 1, async () => {
      try {
        let bytes;
        if (tag === 'Companion') bytes = await fs.readFile(item.companion);
        else {
          const range = inventory.record.ranges?.[tag];
          if (Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.length) && range.start >= 0 && range.length > 0 && range.length <= 64 * 1024 ** 2) {
            const handle = await fs.open(item.path, 'r');
            try {
              const stat = await handle.stat();
              if (range.start + range.length <= stat.size) {
                const buffer = Buffer.alloc(range.length); let read = 0;
                while (read < buffer.length) {
                  const result = await handle.read(buffer, read, buffer.length - read, range.start + read);
                  if (!result.bytesRead) break; read += result.bytesRead;
                }
                // TIFF/JPEG signatures guard against incorrect offset tags.
                if (read === buffer.length && (buffer[0] === 0xff && buffer[1] === 0xd8 || buffer.subarray(0,4).equals(Buffer.from([0x49,0x49,0x2a,0])) || buffer.subarray(0,4).equals(Buffer.from([0x4d,0x4d,0,0x2a])))) {
                  try { await sharp(buffer).metadata(); bytes = buffer; this.stats.directExtractions++; } catch { /* Fall back to ExifTool. */ }
                }
              }
            } finally { await handle.close(); }
          }
          if (!bytes) { this.stats.embeddedExtractions++; bytes = await this.exif.extractBinaryTagToBuffer(tag, item.path); }
        }
        if (bytes.length > 64 * 1024 ** 2) throw new Error('Embedded preview exceeds the 64 MB limit.');
        const metadata = await sharp(bytes, { limitInputPixels: 160_000_000 }).metadata();
        if (!['jpeg', 'tiff'].includes(metadata.format) || !metadata.width || !metadata.height) throw new Error('No valid JPEG or TIFF preview.');
        const name = `${inventory.key}.${tag}.embedded`;
        const info = { status: 'ready', name, tag, format: metadata.format,
          source: tag === 'Companion' ? 'Companion JPEG' : `Embedded ${tag}`,
          type: tag === 'Companion' ? 'companion' : 'embedded', width: metadata.width, height: metadata.height,
          orientation: metadata.orientation || (tag === 'Companion' ? 1 : inventory.record.orientation) };
        await atomicWrite(path.join(this.cacheDir, name), bytes);
        inventory.record.candidates[tag] = info;
        await this.saveInventory(inventory);
        return info;
      } catch (e) {
        if (TRANSIENT.has(e.code)) throw e;
        inventory.record.candidates[tag] = { status: 'invalid', reason: e.message };
        await this.saveInventory(inventory);
        return null;
      }
    });
    this.extracting.set(key, job);
    try { return await job; } finally { this.extracting.delete(key); }
  }
  async rawSource(item, kind = 'preview', priority = 100, rejected = new Set(), policy = this.policy) {
    const inventory = await this.inventory(item);
    const nativeEdge = Math.max(inventory.record.width, inventory.record.height);
    const edge = kind === 'full' ? nativeEdge ? nativeEdge * .9 : 2560 : SIZES[kind];
    const full = kind === 'full';
    if (policy !== 'off' && !rejected.has('rendered') && kind !== 'thumb') {
      const cached = await this.renders.cached(item, full);
      if (cached) { this.renders.stats.renderCacheHits++; return { ...cached, info: { ...cached.info, orientation: inventory.record.orientation || cached.info.orientation } }; }
    }
    const order = kind === 'thumb' ? ['ThumbnailImage', 'ThumbnailTIFF', 'PreviewImage', 'JpgFromRaw', 'OtherImage'] : TAGS;
    let candidate = chooseCandidate(Object.values(inventory.record.candidates).filter(c => c.status === 'ready' && !rejected.has(c.tag)), edge);
    for (const tag of order) {
      if (candidate && Math.max(candidate.width, candidate.height) >= edge) break;
      const found = await this.extract(item, inventory, tag);
      if (found && !rejected.has(tag)) candidate = chooseCandidate([...(candidate ? [candidate] : []), found], edge);
    }
    if ((!candidate || Math.max(candidate.width, candidate.height) < edge) && item.companion && !rejected.has('Companion')) {
      const companion = await this.extract(item, inventory, 'Companion');
      if (companion) candidate = chooseCandidate([...(candidate ? [candidate] : []), companion], edge);
    }
    if (candidate) {
      try { await fs.access(path.join(this.cacheDir, candidate.name)); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        delete inventory.record.candidates[candidate.tag];
        const replacement = await this.extract(item, inventory, candidate.tag);
        if (!replacement) { rejected.add(candidate.tag); return this.rawSource(item, kind, priority, rejected, policy); }
        candidate = replacement;
      }
    }
    const shouldRender = policy !== 'off' && !rejected.has('rendered') &&
      (!candidate || kind !== 'thumb' && policy === 'small' && Math.max(candidate.width, candidate.height) < edge);
    if (shouldRender) {
      try {
        const rendered = await this.renders.get(item, full, priority);
        return { ...rendered, info: { ...rendered.info, orientation: inventory.record.orientation || rendered.info.orientation } };
      }
      catch (error) {
        if (!candidate) throw error;
        return { file: path.join(this.cacheDir, candidate.name), info: { ...candidate, limited: true, renderError: error.message } };
      }
    }
    if (!candidate) {
      const error = new Error(policy === 'off' ? 'No usable embedded preview or companion JPEG. Enable RAW rendering to develop this image.' : 'No usable preview could be generated.');
      error.code = 'NO_PREVIEW'; this.emit(item, { state: 'failed', error: error.message, code: error.code }); throw error;
    }
    return { file: path.join(this.cacheDir, candidate.name), info: { ...candidate, limited: Math.max(candidate.width, candidate.height) < edge } };
  }
  // The photo's real pixel size, oriented as displayed, so the loupe can place
  // zoom percentages before the full-size image has loaded. null if unknown.
  async dimensions(item) {
    item = await this.displayItem(item);
    const key = this.baseKey(item);
    if (!this.sizes.has(key)) {
      const job = (async () => {
        let width, height, orientation;
        if (item.raw) ({ width, height, orientation } = (await this.inventory(item)).record);
        else ({ width, height, orientation } = await sharp(item.path, { limitInputPixels: 160_000_000 }).metadata());
        // Some RAW formats report only a thumbnail's size in the main IFD.
        if (!width || !height || item.raw && Math.max(width, height) < 1000) return null;
        return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
      })();
      this.sizes.set(key, job); job.catch(() => this.sizes.delete(key));
      if (this.sizes.size > 500) this.sizes.delete(this.sizes.keys().next().value);
    }
    return this.sizes.get(key).catch(() => null);
  }
  // Returns an already generated representation from memory or disk without
  // doing any work, or null. Lets the loupe show cached previews at once while
  // arrow keys are held.
  async peek(item, kind) {
    item = await this.displayItem(item);
    if (this.closed || !(kind in SIZES)) return null;
    const key = this.key(item, kind), revision = this.revision, cached = this.memory.get(key);
    if (cached) {
      this.stats.memoryHits++; this.memory.delete(key); this.memory.set(key, cached);
      this.setInfo(item, kind, cached.info); return cached.data;
    }
    const file = path.join(this.cacheDir, key + '.jpg'), infoFile = file + '.json';
    try {
      const [data, info] = await Promise.all([fs.readFile(file), fs.readFile(infoFile, 'utf8').then(JSON.parse)]);
      if (!data.length) return null;
      touch(file, infoFile); this.remember(key, data, info);
      if (revision === this.revision) this.setInfo(item, kind, info);
      this.stats.diskHits++; return data;
    } catch { return null; }
  }
  // A full-size request needs no resizing; when the chosen JPEG is already
  // upright it is served as is instead of being decoded and re-encoded.
  async passThrough(kind, selected) {
    if (SIZES[kind]) return null;
    const info = selected.info;
    if (info.format === 'jpeg' && (info.orientation || 1) === 1) return fs.readFile(selected.file);
    if (info.type !== 'original') return null;
    const metadata = await sharp(selected.file, { limitInputPixels: 160_000_000 }).metadata();
    return metadata.format === 'jpeg' && (metadata.orientation || 1) === 1 && (!metadata.space || metadata.space === 'srgb') ? fs.readFile(selected.file) : null;
  }
  async get(item, kind = 'thumb', priority = 1) {
    item = await this.displayItem(item);
    if (this.closed) throw new Error('Preview service is closing.');
    if (!(kind in SIZES)) throw new Error('Unknown preview size.');
    const key = this.key(item, kind), policy = this.policy, revision = this.revision, itemRevision = this.itemRevisions.get(item.id) || 0;
    const current = () => revision === this.revision && itemRevision === (this.itemRevisions.get(item.id) || 0);
    const cached = this.memory.get(key);
    if (cached) {
      this.stats.memoryHits++; this.memory.delete(key); this.memory.set(key, cached);
      this.setInfo(item, kind, cached.info); return cached.data;
    }
    return this.queue.add(`${kind}:${item.id}:${key}`, priority, async () => {
      const file = path.join(this.cacheDir, key + '.jpg'), infoFile = file + '.json';
      try {
        const [data, info] = await Promise.all([fs.readFile(file), fs.readFile(infoFile, 'utf8').then(JSON.parse)]);
        await sharp(data).metadata();
        // Pruning removes the oldest mtimes first; touching on use makes it least-recently-used.
        touch(file, infoFile);
        this.remember(key, data, info); if (current()) this.setInfo(item, kind, info); this.stats.diskHits++; return data;
      } catch (e) { if (TRANSIENT.has(e.code) && e.code !== 'ENOENT') throw e; }
      const rejected = new Set(); let regeneratedRender = false;
      for (let attempt = 0; attempt < TAGS.length + 3; attempt++) {
        const selected = item.raw ? await this.rawSource(item, kind, priority, rejected, policy) : { file: item.path,
          info: { source: item.externalSource ? `Edited in ${item.externalSource === 'dehancer' ? 'Dehancer' : this.editorName?.(item.externalSource) || 'external editor'} · ${path.basename(item.path)}` : 'Original image', type: item.externalSource ? 'external' : 'original' } };
        let image = sharp(selected.file, { failOn: 'error', limitInputPixels: 160_000_000 });
        image = selected.info.orientation ? orient(image, selected.info.orientation) : image.autoOrient();
        if (SIZES[kind]) image = image.resize(SIZES[kind], SIZES[kind], { fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true });
        let data;
        // Sharp 0.35 processes RGB16 in Display P3. toColourspace('srgb') alone
        // only changes the pixel representation; it doesn't convert P3 primaries.
        // Convert AND tag the output, so the webview/OS can match it to the display
        // (including Windows ACM) exactly once. Disk caches stay display-independent.
        try {
          data = await this.passThrough(kind, selected);
          if (!data) {
            const metadata = await image.metadata();
            // Sharp also assumes P3 as the output transform's input for an
            // untagged RGB16 file. Establish the usual sRGB assumption first.
            if (metadata.space === 'rgb16' && !metadata.hasProfile) image = image.pipelineColourspace('srgb');
            data = await image.withIccProfile('srgb').jpeg({ quality: kind === 'thumb' ? 76 : 91 }).toBuffer();
          }
        }
        catch (error) {
          if (!item.raw || TRANSIENT.has(error.code)) throw error;
          const tag = selected.info.tag;
          if (tag) {
            rejected.add(tag);
            const inventory = await this.inventory(item);
            inventory.record.candidates[tag] = { status: 'invalid', reason: error.message };
            await this.saveInventory(inventory);
          } else {
            if (regeneratedRender) throw error;
            await this.renders.invalidate(item); regeneratedRender = true;
          }
          continue;
        }
        const info = selected.info;
        await fs.mkdir(this.cacheDir, { recursive: true });
        if (current()) {
          await atomicWrite(file, data); await atomicWrite(infoFile, JSON.stringify(info)); this.remember(key, data, info);
        }
        if (current()) this.setInfo(item, kind, info); this.stats.generated++;
        void this.prune().catch(() => {}); return data;
      }
      throw new Error('All available previews failed to decode.');
    });
  }
  async retry(item) {
    await this.renders.retry(item);
    await Promise.all(Object.keys(SIZES).flatMap(kind => {
      const key = this.key(item, kind); this.memory.delete(key);
      return [fs.rm(path.join(this.cacheDir, key + '.jpg'), { force: true }), fs.rm(path.join(this.cacheDir, key + '.jpg.json'), { force: true })];
    }));
    this.memoryBytes = [...this.memory.values()].reduce((sum, entry) => sum + entry.data.length, 0);
    this.itemRevisions.set(item.id, (this.itemRevisions.get(item.id) || 0) + 1);
    const key = this.baseKey(item), old = await this.inventories.get(key);
    if (old) await old.writes;
    this.inventories.delete(key);
    await fs.rm(path.join(this.cacheDir, key + '.inventory.json'), { force: true });
    this.states.delete(item.id); this.sizes.delete(key);
    for (const kind of Object.keys(SIZES)) this.infoByKind.delete(`${item.id}:${kind}`);
    this.sourceInfo.delete(item.id);
  }
  metadata(item, kind = 'preview') {
    const key = this.baseKey(item);
    if (!this.metadataJobs.has(key)) {
      const job = this.exif.readRaw(item.path, { readArgs: ['-fast', '-Make', '-Model', '-LensModel', '-FNumber', '-ExposureTime', '-ISO', '-DateTimeOriginal', '-ImageWidth', '-ImageHeight'] }).then(tags => ({
        camera: [tags.Make, tags.Model].filter(Boolean).join(' '), lens: tags.LensModel || '',
        aperture: tags.FNumber ? `f/${tags.FNumber}` : '', shutter: String(tags.ExposureTime || ''), iso: tags.ISO || '',
        captured: String(tags.DateTimeOriginal || ''), width: tags.ImageWidth || null, height: tags.ImageHeight || null,
        source: item.raw ? 'Finding RAW preview' : 'Original image' }));
      this.metadataJobs.set(key, job); job.catch(() => this.metadataJobs.delete(key));
      if (this.metadataJobs.size > 200) this.metadataJobs.delete(this.metadataJobs.keys().next().value);
    }
    return this.metadataJobs.get(key).then(data => ({ ...data, ...this.info(item, kind) }));
  }
  async cacheFiles({ failures = false } = {}) {
    const names = await fs.readdir(this.cacheDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const entries = await Promise.all(names.filter(n => !n.endsWith('.tmp') && (failures || !n.endsWith('.failure.json'))).map(async name => {
      const file = path.join(this.cacheDir, name), info = await fs.stat(file).catch(() => null);
      return info?.isFile() ? { file, bytes: info.size, modified: info.mtimeMs } : null;
    }));
    return entries.filter(Boolean);
  }
  async diskUsage() {
    return { bytes: (await this.cacheFiles({ failures: true })).reduce((n, f) => n + f.bytes, 0), limit: this.maxDiskBytes };
  }
  async setDiskLimit(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Invalid preview cache size.');
    const lower = bytes < this.maxDiskBytes;
    this.maxDiskBytes = bytes;
    if (lower) await this.prune(true);
  }
  // Removes every cached file, failure records included so blocked RAWs get
  // another try. In-flight temporary files are left to their writers; anything
  // still needed is regenerated on the next request.
  async clearDisk() {
    const files = await this.cacheFiles({ failures: true });
    let freed = 0;
    await Promise.all(files.map(f => fs.rm(f.file, { force: true }).then(() => { freed += f.bytes; }, () => {})));
    this.inventories.clear(); this.sizes.clear();
    return { freed, ...await this.diskUsage() };
  }
  async prune(force = false) {
    const now = Date.now(); if (!force && now - this.lastPrune < 60000) return; this.lastPrune = now;
    const files = (await this.cacheFiles()).sort((a, b) => a.modified - b.modified);
    let total = files.reduce((n, f) => n + f.bytes, 0);
    for (const file of files) {
      if (total <= this.maxDiskBytes) break;
      if (now - file.modified < 60000) continue;
      await fs.rm(file.file, { force: true }); total -= file.bytes;
    }
  }
  async close() {
    this.closed = true; this.queue.cancelWhere(() => true);
    await this.renders.close();
    await Promise.allSettled([this.queue.idle(), this.sources.idle(), ...this.metadataJobs.values()]);
    await this.exif.end();
  }
}
module.exports = { PreviewService, SIZES, POLICIES, TAGS, orient, chooseCandidate };
