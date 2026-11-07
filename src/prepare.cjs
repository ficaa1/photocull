// Background preparation of a folder on the server: every thumbnail first, so
// the grid fills, then review previews with focus scores. It runs below
// anything on screen and carries on with no browser open. One folder at a
// time; more wait in line.
const PRIORITY = { thumb: -30 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class PrepareJobs {
  constructor({ library, previews, culling, photo, onProgress = () => {} }) {
    Object.assign(this, { library, previews, culling, photo, onProgress });
    this.jobs = new Map(); this.waiting = []; this.running = null; this.closed = false;
  }
  public(job) {
    const { session, folder, total, thumbs, ready, state, started, finished } = job;
    return { session, folder, total, thumbs, ready, failed: job.failed.size, state, started, finished };
  }
  list() { return [...this.jobs.values()].map(job => this.public(job)); }
  status(session) { const job = this.jobs.get(session); return job ? this.public(job) : null; }
  emit(job, force = false) {
    const now = Date.now();
    if (!force && now - (job.emitted || 0) < 500) return;
    job.emitted = now; this.onProgress(this.public(job));
  }
  start(session) {
    const s = this.library.get(session), existing = this.jobs.get(session);
    if (existing && ['queued', 'running'].includes(existing.state)) return this.public(existing);
    const ids = s.items.filter(item => !item.trashed).map(item => item.id);
    const job = { session, folder: s.folder, ids, total: ids.length, thumbs: 0, ready: 0, failed: new Set(), state: 'queued', started: Date.now(), finished: null };
    this.jobs.set(session, job); this.waiting.push(job); this.emit(job, true);
    void this.drain();
    return this.public(job);
  }
  cancel(session) {
    const job = this.jobs.get(session);
    if (job && ['queued', 'running'].includes(job.state)) { job.state = 'cancelled'; job.finished = Date.now(); this.emit(job, true); }
    return job ? this.public(job) : null;
  }
  async drain() {
    if (this.running) return;
    while (this.waiting.length && !this.closed) {
      const job = this.running = this.waiting.shift();
      if (job.state !== 'queued') continue;
      job.state = 'running'; this.emit(job, true);
      try { await this.process(job); if (job.state === 'running') job.state = 'done'; }
      catch (error) { if (job.state === 'running') { job.state = 'failed'; job.error = error.message; } }
      job.finished ??= Date.now(); this.emit(job, true);
    }
    this.running = null;
  }
  // Navigation cancels queued previews it no longer needs, including ours; wait and ask again.
  async persist(work) {
    for (let attempt = 0; ; attempt++) {
      try { return await work(); }
      catch (error) { if (error.code !== 'CANCELED' || attempt >= 40 || this.closed) throw error; await sleep(250 * Math.min(attempt + 1, 8)); }
    }
  }
  async each(job, work) {
    let next = 0;
    await Promise.all([0, 1].map(async () => {
      while (job.state === 'running' && !this.closed && next < job.ids.length) {
        const id = job.ids[next++];
        let item;
        try { item = this.photo(job.session, id); } catch (error) {
          if (/session has closed/.test(error.message)) { job.state = 'cancelled'; return; }
          continue;
        }
        if (item.trashed) continue;
        await work(id, item);
      }
    }));
  }
  async process(job) {
    await this.each(job, async (id, item) => {
      try { await this.persist(() => this.previews.get(item, 'thumb', PRIORITY.thumb)); job.thumbs++; } catch { job.failed.add(id); }
      this.emit(job);
    });
    await this.each(job, async id => {
      try { await this.persist(() => this.culling.score(job.session, id)); job.ready++; } catch { job.failed.add(id); }
      this.emit(job);
    });
  }
  close() { this.closed = true; for (const job of this.jobs.values()) if (['queued', 'running'].includes(job.state)) job.state = 'cancelled'; }
}

module.exports = { PrepareJobs };
