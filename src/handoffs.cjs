// Cleanup accepts session records, never arbitrary paths from the renderer.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const key = file => path.resolve(file).toLowerCase();
async function sourceGuard(session) {
  const sources = new Set(), identities = new Set();
  for (const file of session.items.flatMap(i => [i.path, i.companion, i.sidecar]).filter(Boolean)) {
    sources.add(key(file));
    try { sources.add(key(await fs.realpath(file))); const s = await fs.stat(file); identities.add(`${s.dev}:${s.ino}`); } catch {}
  }
  return { sources, identities };
}
async function inspect(record, { sources, identities }) {
  const file = record.path;
  if (!path.isAbsolute(file) || !/\.(tiff?|png|jpe?g)$/i.test(file)) throw new Error('Not a recorded hand-off image.');
  const s = await fs.lstat(file), real = await fs.realpath(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink > 1 || key(real) !== key(record.realPath || file) || sources.has(key(file)) || sources.has(key(real)) || identities.has(`${s.dev}:${s.ino}`)) throw new Error('Unsafe hand-off path; retained.');
  return { path: file, realPath: real, bytes: s.size, mtime: s.mtimeMs, ino: s.ino, dev: s.dev, unexported: (!!record.editedBy || !!record.writtenStamp && (record.writtenStamp.bytes !== s.size || record.writtenStamp.mtime !== s.mtimeMs)) && (!record.exported || record.exportedStamp?.bytes !== s.size || record.exportedStamp?.mtime !== s.mtimeMs) };
}
async function inventory(session) {
  const guard = await sourceGuard(session), entries = [], seen = new Set(), failures = [];
  for (const item of session.items) for (const record of item.develop?.handoffs || []) {
    if (seen.has(key(record.path))) continue;
    seen.add(key(record.path));
    try { entries.push(await inspect(record, guard)); }
    catch (e) { if (e.code !== 'ENOENT') failures.push({ path: record.path, error: e.message }); }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, count: entries.length, bytes: entries.reduce((n, r) => n + r.bytes, 0), unexported: entries.filter(r => r.unexported).length, failures,
    token: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
async function cleanup(library, sessionId, token, allowUnexported = false, onlyIds = null) {
  const session = library.get(sessionId), before = await inventory(session);
  if (token !== before.token) throw new Error('Hand-off files changed. Review cleanup again.');
  const allowed = onlyIds ? new Set(onlyIds.flatMap(id => library.item(sessionId, id).develop?.handoffs?.filter(r => r.path === library.item(sessionId, id).develop.tiff && r.exported).map(r => key(r.path)) || [])) : null;
  if (!allowed && before.unexported && !allowUnexported) throw new Error('Confirm deletion of external edits that have not been exported.');
  const deleted = [], failures = [...before.failures], guard = await sourceGuard(session);
  const records = new Map(session.items.flatMap(i => (i.develop?.handoffs || []).map(r => [r.path,r])));
  for (const entry of before.entries) {
    if (allowed && (!allowed.has(key(entry.path)) || entry.unexported)) continue;
    try {
      for (let attempt=0;;attempt++) {
        const current = await inspect(records.get(entry.path), guard);
        if (!current || JSON.stringify(current) !== JSON.stringify(entry)) throw new Error('Hand-off changed; retained.');
        try { await fs.unlink(entry.path); break; }
        catch (e) { if (!['EBUSY','EPERM','EACCES'].includes(e.code) || attempt>=6) throw e; await new Promise(resolve=>setTimeout(resolve,150)); }
      }
      deleted.push(entry.path);
    } catch (e) { failures.push({ path: entry.path, error: e.message }); }
  }
  const changed = session.items.filter(item => item.develop?.handoffs.some(r => deleted.includes(r.path)));
  for (const item of session.items) if (item.develop) {
    item.develop.handoffs = item.develop.handoffs.filter(r => !deleted.includes(r.path));
    if (deleted.includes(item.develop.tiff)) { item.develop.tiff = null; item.develop.editedBy = null; item.develop.exported = false; item.develop.revision++; }
  }
  library.changed(session, changed);
  await library.save(session);
  return { deleted, failures, items: session.items.map(i => ({ id: i.id, tiff: i.develop?.tiff || null, developed: !!i.develop?.tiff, externalEdit: !!i.develop?.editedBy, editedBy: i.develop?.editedBy || null, developRevision: i.develop?.revision || 0 })) };
}
module.exports = { inventory, cleanup };
