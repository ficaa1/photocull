const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { RAW, JPEG, coded, inside } = require('./library.cjs');
const { hasAncestor } = require('./tether-backup.cjs');

const SCAN_MS = 500, QUIET_MS = 1500, RETRY_MS = 5000;
const precise = { bigint: true };
const identity = stat => `${stat.dev}:${stat.ino}`;
const stamp = stat => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const stat = file => fs.lstat(file, precise).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
const photoName = name => !name.startsWith('.') && !/[\\/:\x00-\x1f\x7f\uFFFD]/.test(name) &&
  (RAW.has(path.extname(name).toLowerCase()) || JPEG.has(path.extname(name).toLowerCase()));

class HotFolder {
  constructor(shootId, root, info, stage, captureLocation, settled, exif) {
    Object.assign(this, { shootId, root, info, stage, captureLocation, settled, exif });
    this.observed = new Map();
    this.lastScan = -Infinity;
    this.message = '';
    this.cancelled = false;
  }

  static async open(shoot, picked, stageDir, members, exif) {
    if (typeof picked !== 'string' || !path.isAbsolute(picked)) throw coded('DEST_CHANGED', 'Choose an incoming folder.');
    const root = await fs.realpath(picked).catch(() => null), info = root && await stat(root);
    if (!info?.isDirectory()) throw coded('DEST_CHANGED', 'The incoming folder is unavailable.');
    const stage = path.join(shoot.canonicalRoot, stageDir);
    const watch = new HotFolder(shoot.shootId, root, info, stage, shoot.canonicalRoot,
      new Set(members.map(m => m.hotFolderVersion).filter(Boolean)), exif);
    await watch.assertSeparate(shoot.canonicalRoot, 'capture location');
    if (shoot.backup) await watch.assertSeparate(shoot.backup.root, 'backup location');
    await fs.readdir(root);
    await watch.cleanInterruptedStages(shoot.folderId, members);
    return watch;
  }

  async assertSeparate(destination, label) {
    const other = await fs.realpath(destination).catch(() => null), info = other && await stat(other);
    const source = await fs.realpath(this.root).catch(() => null);
    if (inside(this.root, other ?? destination) || inside(other ?? destination, this.root) ||
        (info && (await hasAncestor(other, this.info) || (source && await hasAncestor(source, info))))) {
      throw coded('DEST_CHANGED', `Choose an incoming folder separate from the ${label}.`);
    }
  }

  async checkSource() {
    const info = await stat(this.root);
    if (!info?.isDirectory() || identity(info) !== identity(this.info) || await fs.realpath(this.root).catch(() => null) !== this.root) {
      throw coded('DEST_CHANGED', 'The incoming folder is unavailable or has changed. Reconnect it, or stop watching and choose it again.');
    }
  }

  async scan(now) {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const next = new Map();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !photoName(entry.name)) continue;
      const file = path.join(this.root, entry.name), info = await stat(file);
      if (!info?.isFile() || !info.size || info.size > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      const version = hash(`${identity(this.info)}\0${stamp(info)}`);
      if (this.settled.has(version)) continue;
      const previous = this.observed.get(entry.name);
      next.set(entry.name, previous?.version === version ? previous :
        { file, name: entry.name, info, version, firstSeen: now, retryAt: now + QUIET_MS });
    }
    this.observed = next;
    this.lastScan = now;
  }

  async next(now, captureId, margin) {
    await this.checkSource();
    if (now - this.lastScan >= SCAN_MS) await this.scan(now);
    const candidate = [...this.observed.values()].filter(f => f.retryAt <= now).sort((a, b) => a.firstSeen - b.firstSeen)[0];
    if (!candidate) return null;
    candidate.retryAt = now + RETRY_MS;
    const receipt = await this.stageFile(candidate, captureId, margin);
    return receipt && { ...candidate, ...receipt };
  }

  async checkStage(captureId) {
    const capture = await stat(this.captureLocation), stage = await stat(this.stage);
    if (!capture?.isDirectory() || `${Number(capture.dev)}:${Number(capture.ino)}` !== captureId ||
        !stage?.isDirectory() || await fs.realpath(this.stage).catch(() => null) !== this.stage) {
      throw coded('DEST_CHANGED', 'The capture staging folder is unavailable or has changed.');
    }
    return stage;
  }

  async cleanInterruptedStages(captureId, members) {
    await this.checkStage(captureId);
    const names = new Set(members.map(m => path.basename(m.stageRelPath)));
    const prefix = `hot-${this.shootId}-`;
    for (const name of await fs.readdir(this.stage)) {
      const owner = name.startsWith(prefix) && /^([1-9]\d{0,9})-[a-f0-9-]{36}\.part$/.exec(name.slice(prefix.length));
      if (!owner || names.has(name)) continue;
      // A different PhotoCull process can be staging in the same capture folder.
      try { process.kill(Number(owner[1]), 0); continue; }
      catch (error) { if (error.code !== 'ESRCH') continue; }
      const staged = path.join(this.stage, name), owned = await stat(staged);
      if (owned?.isFile()) await this.discard({ staged, owned });
    }
  }

  async stageFile(candidate, captureId, margin) {
    const { file, info } = candidate, version = stamp(info);
    const current = await stat(file);
    if (!current?.isFile() || stamp(current) !== version) return null;
    const stage = await this.checkStage(captureId);
    const disk = await fs.statfs(this.stage).catch(() => null);
    if (disk && disk.bavail * disk.bsize < Number(info.size) + margin) throw coded('NO_SPACE', 'Free space on the capture disk to continue importing from the Hot Folder.');
    const memberId = `hot-${this.shootId}-${process.pid}-${randomUUID()}`, staged = path.join(this.stage, memberId + '.part');
    let input, output, owned, complete = false;
    try {
      input = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const before = await input.stat(precise);
      if (!before.isFile() || stamp(before) !== version) return null;
      output = await fs.open(staged, 'wx', 0o600);
      owned = await output.stat(precise);
      const checksum = createHash('sha256');
      let bytes = 0;
      for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
        if (this.cancelled) return null;
        bytes += chunk.length;
        if (bytes > Number(info.size)) return null;
        checksum.update(chunk);
        await output.writeFile(chunk);
      }
      if (bytes !== Number(info.size) || stamp(await input.stat(precise)) !== version) return null;
      await output.sync();
      await this.checkSource();
      const after = await stat(file);
      if (!after?.isFile() || stamp(after) !== version) return null;
      const sameStage = await this.checkStage(captureId);
      const sameEntry = await stat(staged);
      if (identity(sameStage) !== identity(stage) || !sameEntry?.isFile() || identity(sameEntry) !== identity(owned)) {
        throw coded('DEST_CHANGED', 'The capture staging folder changed while copying.');
      }
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.stage);
        try { await directory.sync(); }
        catch (error) { if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error; }
        finally { await directory.close(); }
      }
      complete = true;
      return { memberId, staged, owned, bytes, sha256: checksum.digest('hex') };
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes(error.code)) return null;
      if (error.code === 'ENOSPC') throw coded('NO_SPACE', 'Free space on the capture disk to continue importing from the Hot Folder.');
      throw error;
    } finally {
      await Promise.allSettled([input?.close(), output?.close()]);
      if (owned && !complete) await this.discard({ staged, owned });
    }
  }

  async discard({ staged, owned }) {
    const current = await stat(staged).catch(() => null);
    if (current?.isFile() && identity(current) === identity(owned) &&
        await fs.realpath(this.stage).catch(() => null) === this.stage) await fs.unlink(staged).catch(() => {});
  }

  objectKey(file) {
    return 'hot:' + hash(`${identity(this.info)}\0${identity(file.info)}\0${file.sha256}`);
  }

  groupKey(stem) {
    return hash(`${identity(this.info)}\0${stem}`);
  }

  finish(file) {
    this.settled.add(file.version);
    this.observed.delete(file.name);
  }

  cancel() { this.cancelled = true; }

  snapshot() { return { path: this.root, message: this.message }; }

  async metadata(file) {
    const tags = await this.exif?.readRaw(file, { readArgs: ['-fast', '-Model', '-DateTimeOriginal', '-ExposureTime', '-FNumber#', '-ISO#', '-FocalLength#'] }).catch(() => null);
    if (!tags) return {};
    const text = (value, limit) => typeof value === 'string' ? value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) || undefined : undefined;
    const number = value => Number(value) > 0 && Number.isFinite(Number(value)) ? Number(value) : undefined;
    return { model: text(tags.Model, 128), captureTime: /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/.exec(tags.DateTimeOriginal)?.[0],
      shutter: text(tags.ExposureTime, 32) ?? number(tags.ExposureTime), aperture: number(tags.FNumber), iso: number(tags.ISO), focalLength: number(tags.FocalLength) };
  }
}

module.exports = { HotFolder };
