// The server's trash: deleted photos move to <trash>/<YYYY-MM-DD>/<root name>/<path in root>
// and each day folder keeps a photocull-trash.jsonl log of where files came from.
// Day folders older than the configured number of days are removed.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

class ServerTrash {
  constructor({ dir, roots, days = 30 }) { this.dir = dir; this.roots = roots; this.days = days; }
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    this.dir = await fs.realpath(this.dir);
    if (this.roots.roots.some(r => r.path === this.dir)) throw new Error('PHOTOCULL_TRASH must not be a photo folder itself.');
  }
  async free(target) {
    const { dir, name, ext } = path.parse(target);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? target : path.join(dir, `${name} (${n})${ext}`);
      try { await fs.lstat(candidate); } catch (e) { if (e.code === 'ENOENT') return candidate; throw e; }
    }
  }
  async move(file, now = new Date()) {
    const root = this.roots.rootOf(file);
    if (!root) throw new Error('Only photos in the library can be moved to the trash.');
    const day = path.join(this.dir, today(now));
    const target = await this.free(path.join(day, root.name, path.relative(root.path, file)));
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.rename(file, target); }
    catch (error) {
      // The trash is on another filesystem (or another mount of the same one).
      if (error.code !== 'EXDEV') throw error;
      await fs.copyFile(file, target, constants.COPYFILE_EXCL);
      const [from, to] = await Promise.all([fs.stat(file), fs.stat(target)]);
      if (from.size !== to.size) { await fs.rm(target, { force: true }); throw new Error('Copy to the trash was incomplete.'); }
      await fs.rm(file);
    }
    await fs.appendFile(path.join(day, 'photocull-trash.jsonl'), JSON.stringify({ at: now.toISOString(), from: file, to: target }) + '\n');
    return target;
  }
  async purge(now = new Date()) {
    if (!this.days) return [];
    const cutoff = today(new Date(now.getTime() - this.days * 86400000)), removed = [];
    for (const entry of await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && DAY.test(entry.name) && entry.name < cutoff) {
        await fs.rm(path.join(this.dir, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      }
    }
    return removed;
  }
}

module.exports = { ServerTrash, today };
