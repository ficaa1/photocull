const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { mapLimit } = require('./queue.cjs');
const { developState } = require('./develop.cjs');
const { atomicWrite, resolveDevelop } = require('./xmp.cjs');

const key = file => path.resolve(file).toLowerCase();
const digest = value => createHash('sha256').update(value).digest('hex');
const stamp = stat => `${stat.size}:${stat.mtimeMs}:${stat.dev}:${stat.ino}`;
const image = file => /\.(tiff?|png|jpe?g)$/i.test(file);

function identity(tags) {
  const date = String(tags.SubSecDateTimeOriginal || tags.DateTimeOriginal || '').match(/^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/);
  const fraction = date?.[7] || (tags.SubSecTimeOriginal === undefined ? '' : String(tags.SubSecTimeOriginal));
  const offset = date?.[8] || tags.OffsetTimeOriginal || '';
  if (!date || !/^\d+$/.test(fraction) || !tags.Model) return null;
  const milliseconds = Number(('0.' + fraction)) * 1000;
  let time = Date.UTC(...[Number(date[1]), Number(date[2]) - 1, ...date.slice(3, 7).map(Number)], milliseconds);
  if (offset && offset !== 'Z') {
    const zone = String(offset).match(/^([+-])(\d\d):(\d\d)$/);
    if (!zone) return null;
    time -= (zone[1] === '+' ? 1 : -1) * (Number(zone[2]) * 60 + Number(zone[3])) * 60000;
  }
  return { time: `${offset ? 'utc' : 'local'}:${time}`, model: String(tags.Model).trim().toLowerCase(), lens: String(tags.LensModel || '').trim().toLowerCase() };
}

function matches(a, b) {
  return a && b && a.time === b.time && a.model === b.model && a.lens === b.lens;
}

class ExternalEdits {
  constructor(library, exif, settings) {
    this.library = library; this.exif = exif; this.settings = settings;
    this.file = path.join(library.dataDir, 'external-edits.json');
    this.linkedPaths = new Set(); this.rejected = {}; this.jobs = new Map(); this.proposals = new Map(); this.metadata = new Map(); this.writes = Promise.resolve(); this.decisions = Promise.resolve();
  }

  async init() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const file of saved.linkedPaths || []) if (typeof file === 'string' && path.isAbsolute(file)) this.linkedPaths.add(key(file));
      if (saved.rejected && typeof saved.rejected === 'object' && !Array.isArray(saved.rejected)) this.rejected = saved.rejected;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  save() {
    const write = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await atomicWrite(this.file, JSON.stringify({ version: 1, linkedPaths: [...this.linkedPaths], rejected: this.rejected }));
    });
    this.writes = write; return write;
  }

  async tags(file, stat) {
    const id = `${file}:${stamp(stat)}`;
    if (!this.metadata.has(id)) {
      const job = this.exif.readRaw(file, { readArgs: ['-fast', '-SubSecDateTimeOriginal', '-DateTimeOriginal', '-SubSecTimeOriginal', '-OffsetTimeOriginal', '-Model', '-LensModel', '-Software'] });
      this.metadata.set(id, job); job.catch(() => this.metadata.delete(id));
      if (this.metadata.size > 4000) this.metadata.delete(this.metadata.keys().next().value);
    }
    return this.metadata.get(id);
  }

  list(sessionId) {
    const session = this.library.get(sessionId);
    return [...(this.proposals.get(sessionId)?.values() || [])].filter(p => {
      const item = session.byId.get(p.itemId);
      return item && !item.develop?.tiff && !item.trashed;
    })
      .map(({ id, itemId, name, file, editedBy }) => ({ id, itemId, name, file, editedBy }));
  }

  discover(sessionId) {
    if (!this.jobs.has(sessionId)) {
      const job = this.find(sessionId);
      this.jobs.set(sessionId, job); job.catch(() => this.jobs.delete(sessionId));
      for (const id of this.jobs.keys()) if (!this.library.sessions.has(id)) { this.jobs.delete(id); this.proposals.delete(id); }
    }
    return this.jobs.get(sessionId).then(warnings => ({ proposals: this.list(sessionId), warnings }));
  }

  async find(sessionId) {
    const session = this.library.get(sessionId), warnings = [], candidates = new Map();
    const active = () => this.library.sessions.get(sessionId) === session;
    let protectedLinks = false;
    for (const item of session.items) for (const record of item.develop?.handoffs || []) if (record.linked) {
      for (const file of [record.path, record.realPath].filter(Boolean)) if (!this.linkedPaths.has(key(file))) { this.linkedPaths.add(key(file)); protectedLinks = true; }
    }
    if (protectedLinks) await this.save();
    const add = (file, editor = null, fingerprint = null) => {
      if (!file || !path.isAbsolute(file) || !image(file)) return;
      const id = key(file), candidate = candidates.get(id) || { file, editor, fingerprints: [] };
      if (fingerprint) candidate.fingerprints.push(fingerprint);
      if (editor) candidate.editor = editor;
      candidates.set(id, candidate);
    };
    const stores = await fs.readdir(path.join(this.library.dataDir, 'sessions')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const name of stores.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      if (!active()) return warnings;
      const file = path.join(this.library.dataDir, 'sessions', name);
      if (file === session.store) continue;
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) continue;
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (typeof saved.folder !== 'string' || !path.isAbsolute(saved.folder)) continue;
        for (const record of Object.values(saved.decisions || {})) {
          const photo = path.join(saved.folder, typeof record.path === 'string' ? record.path : 'photo.ARW');
          const develop = developState(resolveDevelop(record.develop, photo, saved.folder));
          if (develop?.editedBy) add(develop.tiff, develop.editedBy, record.fingerprint);
        }
      } catch { warnings.push('A saved session could not be checked for external edits.'); }
    }
    const folders = new Set([this.settings().handoffFolder, path.join(session.folder, this.settings().handoffSubfolder || '_develop')].filter(Boolean));
    for (const folder of folders) {
      try { for (const entry of await fs.readdir(folder, { withFileTypes: true })) if (entry.isFile() && image(entry.name)) add(path.join(folder, entry.name)); }
      catch (error) { if (error.code !== 'ENOENT') warnings.push('An external edit folder is unavailable.'); }
    }
    const sources = new Set(session.items.flatMap(i => [i.path, i.companion, i.develop?.tiff, ...(i.develop?.handoffs || []).map(r => r.path)]).filter(Boolean).map(key));
    const outputs = (await mapLimit([...candidates.values()], 2, async candidate => {
      if (!active() || sources.has(key(candidate.file))) return null;
      try {
        const stat = await fs.lstat(candidate.file), real = await fs.realpath(candidate.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || sources.has(key(real))) return null;
        const tags = await this.tags(candidate.file, stat), ident = identity(tags);
        const editor = candidate.editor || this.settings().editors.find(e => String(tags.Software || '').toLowerCase().includes(e.name.toLowerCase()))?.id;
        if (!ident || !editor) return null;
        return { ...candidate, editor, ident, stat: stamp(stat), real };
      } catch { return null; }
    })).filter(Boolean);
    const rows = new Map();
    if (!outputs.length || !active()) { this.proposals.set(sessionId, rows); return warnings; }
    const originals = (await mapLimit(session.items.filter(i => i.raw && !i.trashed), 2, async item => {
      if (!active()) return null;
      try { const stat = await fs.stat(item.path); return { item, ident: identity(await this.tags(item.path, stat)) }; }
      catch { return null; }
    })).filter(Boolean);
    const rejected = new Set(this.rejected[digest(session.folder)] || []);
    for (const output of outputs) {
      const hits = originals.filter(r => matches(r.ident, output.ident));
      if (hits.length !== 1) continue;
      const { item } = hits[0];
      if (item.develop?.tiff) continue;
      if (output.fingerprints.length && !output.fingerprints.some(f => Number(f.split(':')[0]) === item.size && (!item.companion || !f.split(':')[2] || Number(f.split(':')[2]) === item.companionSize))) continue;
      const id = digest(`${item.id}:${item.fingerprint}:${key(output.file)}:${output.stat}`);
      if (!rejected.has(id)) rows.set(id, { id, itemId: item.id, name: item.name, file: output.file, editedBy: output.editor, output, fingerprint: item.fingerprint });
    }
    if (active()) this.proposals.set(sessionId, rows);
    return [...new Set(warnings)];
  }

  async preview(sessionId, id) {
    const session = this.library.get(sessionId), proposal = this.proposals.get(sessionId)?.get(id);
    const item = proposal && session.byId.get(proposal.itemId);
    if (!item || item.trashed) throw new Error('This proposed edit is no longer available.');
    const stat = await fs.lstat(proposal.file), real = await fs.realpath(proposal.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stamp(stat) !== proposal.output.stat || real !== proposal.output.real) throw new Error('The proposed edit changed; reopen the folder.');
    return { id, schedulingId: proposal.itemId, path: proposal.file, name: path.basename(proposal.file), fingerprint: proposal.output.stat, raw: false };
  }

  decide(sessionId, ids, accept) {
    const job = this.decisions.catch(() => {}).then(() => this.apply(sessionId, ids, accept));
    this.decisions = job; return job;
  }

  async apply(sessionId, ids, accept) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || typeof accept !== 'boolean') throw new Error('Choose proposed external edits.');
    const session = this.library.get(sessionId), proposals = this.proposals.get(sessionId);
    const selected = [...new Set(ids)].map(id => { const p = proposals?.get(id); if (!p) throw new Error('A proposed edit is no longer available.'); return p; });
    if (accept && new Set(selected.map(p => p.itemId)).size !== selected.length) throw new Error('Choose one external edit per photo.');
    const items = [];
    if (accept) {
      for (const p of selected) {
        const item = this.library.item(sessionId, p.itemId);
        if (item.develop?.tiff || item.trashed || item.fingerprint !== p.fingerprint) throw new Error('The photo changed; reopen the folder.');
        const stat = await fs.lstat(item.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size || stat.mtimeMs !== item.mtimeMs || `${stat.dev}:${stat.ino}` !== item.fileId) throw new Error('The original changed; reopen the folder.');
        await this.preview(sessionId, p.id);
      }
      for (const p of selected) { this.linkedPaths.add(key(p.file)); this.linkedPaths.add(key(p.output.real)); }
      await this.save();
      const root = await fs.stat(session.folder);
      if (this.library.get(sessionId) !== session || `${root.dev}:${root.ino}` !== session.folderId || await fs.realpath(session.folder) !== session.folder) throw new Error('The photo folder changed; reopen it.');
      for (const p of selected) await this.preview(sessionId, p.id);
      if (selected.some(p => this.library.item(sessionId, p.itemId).develop?.tiff)) throw new Error('The photo already has an external edit.');
      for (const p of selected) {
        const item = this.library.item(sessionId, p.itemId);
        item.develop = developState({ ...item.develop, tiff: p.file, editedBy: p.editedBy, exported: false, revision: (item.develop?.revision || 0) + 1,
          handoffs: [...(item.develop?.handoffs || []), { path: p.file, realPath: p.output.real, editedBy: p.editedBy, linked: true }] });
        items.push(item);
      }
      this.library.changed(session, items); await this.library.save(session);
    } else {
      const rejected = new Set(this.rejected[digest(session.folder)] || []);
      for (const p of selected) rejected.add(p.id);
      this.rejected[digest(session.folder)] = [...rejected]; await this.save();
    }
    for (const p of selected) proposals.delete(p.id);
    return { proposals: this.list(sessionId), items: this.library.publicSession(session).items.filter(i => items.some(item => item.id === i.id)) };
  }
}

module.exports = { ExternalEdits };
