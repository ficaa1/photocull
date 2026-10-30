const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PriorityQueue } = require('./queue.cjs');
const { atomicWrite } = require('./xmp.cjs');
const { hash } = require('./library.cjs');
const { renderRaw, DECODER_ID } = require('./raw-decoder.cjs');

class RawRenderCache {
  constructor(cacheDir, { render = renderRaw, onState = () => {}, timeoutMs = 45000 } = {}) {
    this.cacheDir = cacheDir; this.render = render; this.onState = onState; this.timeoutMs = timeoutMs;
    this.queue = new PriorityQueue(1);
    this.controllers = new Set(); this.closed = false;
    this.stats = { renders: 0, renderCacheHits: 0, blockedRenders: 0, renderFailures: 0 };
  }

  identity(item) { return hash(`${DECODER_ID}:${item.path}:${item.fingerprint}`); }
  paths(item, full) {
    const key = hash(`${this.identity(item)}:${full ? 'full' : 'half'}`);
    return { file: path.join(this.cacheDir, key + '.render.jpg'), info: path.join(this.cacheDir, key + '.render.json'), key };
  }
  failurePath(item) { return path.join(this.cacheDir, this.identity(item) + '.failure.json'); }

  async cached(item, full) {
    for (const precision of full ? [true] : [true, false]) {
      const files = this.paths(item, precision);
      try {
        const [info, stat] = await Promise.all([fs.readFile(files.info, 'utf8').then(JSON.parse), fs.stat(files.file)]);
        if (stat.size === 0) continue;
        return { file: files.file, info: { ...info, cached: true } };
      } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code) && !(e instanceof SyntaxError)) throw e; }
    }
    return null;
  }

  async failure(item) {
    try {
      const failure = JSON.parse(await fs.readFile(this.failurePath(item), 'utf8'));
      return !failure.retryAfter || failure.retryAfter > Date.now() ? failure : null;
    } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; return null; }
  }

  async get(item, full = false, priority = 100) {
    if (this.closed) throw new Error('Preview service is closing.');
    const cached = await this.cached(item, full);
    if (cached) { this.stats.renderCacheHits++; return cached; }
    const blocked = await this.failure(item);
    if (blocked) {
      this.stats.blockedRenders++;
      this.onState(item, { state: 'blocked', error: blocked.message, code: blocked.code });
      throw Object.assign(new Error(blocked.message), { code: blocked.code, blocked: true });
    }
    const files = this.paths(item, full);
    this.onState(item, { state: 'queued' });
    return this.queue.add(`render:${item.id}:${files.key}`, priority, async () => {
      if (this.closed) throw new Error('Preview service is closing.');
      const existing = await this.cached(item, full);
      if (existing) { this.stats.renderCacheHits++; return existing; }
      const lateFailure = await this.failure(item);
      if (lateFailure) { this.stats.blockedRenders++; throw Object.assign(new Error(lateFailure.message), { code: lateFailure.code, blocked: true }); }
      await fs.mkdir(this.cacheDir, { recursive: true });
      const temp = path.join(this.cacheDir, `${files.key}.${randomUUID()}.tmp`);
      const controller = new AbortController(); this.controllers.add(controller);
      this.onState(item, { state: 'rendering' });
      try {
        const before = await fs.stat(item.path);
        if (item.size !== undefined && (before.size !== item.size || before.mtimeMs !== item.mtimeMs)) {
          throw Object.assign(new Error('This RAW changed. Reopen its folder before rendering.'), { code: 'SOURCE_CHANGED' });
        }
        this.stats.renders++;
        const result = await this.render(item.path, temp, { halfSize: !full, timeoutMs: this.timeoutMs, signal: controller.signal });
        const after = await fs.stat(item.path);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw Object.assign(new Error('This RAW changed while rendering. Reopen its folder.'), { code: 'SOURCE_CHANGED' });
        const info = { source: full ? 'Rendered RAW · full size' : 'Rendered RAW · half size',
          type: 'rendered', width: result.width, height: result.height, orientation: result.orientation || 1,
          decoder: DECODER_ID, precision: full ? 'full' : 'half', created: new Date().toISOString() };
        await fs.rename(temp, files.file);
        await atomicWrite(files.info, JSON.stringify(info));
        await fs.rm(this.failurePath(item), { force: true });
        this.onState(item, { state: 'ready', info });
        return { file: files.file, info };
      } catch (error) {
        const code = error.code || 'RAW_DECODE_FAILED';
        // Source/storage/cancellation errors must not blacklist a camera file.
        const transient = ['EIO', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'SOURCE_CHANGED', 'CANCELED'].includes(code);
        if (!transient) {
          this.stats.renderFailures++;
          const temporary = !['RAW_DECODE_FAILED', 'RAW_LIMIT'].includes(code);
          await atomicWrite(this.failurePath(item), JSON.stringify({ code, message: error.message,
            failedAt: Date.now(), retryAfter: temporary ? Date.now() + 60000 : null })).catch(() => {});
        }
        this.onState(item, { state: code === 'CANCELED' ? 'canceled' : 'failed', error: error.message, code });
        throw error;
      } finally {
        this.controllers.delete(controller);
        await fs.rm(temp, { force: true }).catch(() => {});
      }
    });
  }

  cancelObsolete(ids) {
    this.queue.cancelWhere(job => !ids.has(job.key.split(':')[1]));
  }
  async retry(item) { await fs.rm(this.failurePath(item), { force: true }); }
  async invalidate(item) {
    for (const full of [false, true]) {
      const files = this.paths(item, full);
      await Promise.all([fs.rm(files.file, { force: true }), fs.rm(files.info, { force: true })]);
    }
  }
  async close() {
    this.closed = true; this.queue.cancelWhere(() => true);
    for (const controller of this.controllers) controller.abort();
    await this.queue.idle();
  }
}

module.exports = { RawRenderCache };
