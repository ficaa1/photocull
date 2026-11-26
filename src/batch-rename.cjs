const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const vm = require('node:vm');
const { renderName, validStem, needsCapture } = require('./renderer/naming.js');
const { sidecarPaths } = require('./xmp.cjs');

const fold = file => path.join(path.dirname(file), path.basename(file).normalize('NFC').toLowerCase());
const stemOf = file => path.basename(file, path.extname(file));
const stamp = s => ({ fileId: `${s.dev}:${s.ino}`, size: s.size, mtimeMs: s.mtimeMs });
const matches = (s, expected) => s.isFile() && s.size === expected.size && s.mtimeMs === expected.mtimeMs && expected.fileId === `${s.dev}:${s.ino}`;
const sideNames = item => [...new Set([item.path, item.companion].filter(Boolean).flatMap(sidecarPaths).map(fold))];
const problem = file => new Error(`${path.basename(file)} changed since scan. Reopen the folder.`);

function format(config) {
  const { mode = 'template', template = '{filename}', text = '', start = 1, padding = 4, find = '', replace = '' } = config;
  if (!['template', 'find-replace', 'both'].includes(mode) || typeof template !== 'string' || template.length > 180 ||
      typeof text !== 'string' || text.length > 80 || !Number.isInteger(start) || start < 1 || start > 999999999 || !Number.isInteger(padding) || padding < 1 || padding > 6)
    throw new Error('Invalid naming options.');
  let substitute;
  if (mode !== 'template') {
    if (typeof find !== 'string' || !find || find.length > 200 || typeof replace !== 'string' || replace.length > 200) throw new Error('Enter a search pattern and a replacement of at most 200 characters.');
    const flags = config.caseSensitive ? 'gu' : 'giu';
    if (config.useRegex) {
      const context = vm.createContext({ pattern: new RegExp(find, flags), replace });
      const script = new vm.Script('stem.replace(pattern, replace)');
      let stopped = false;
      substitute = stem => {
        if (stopped) throw new Error('Regular expression took too long.');
        context.stem = stem;
        try { return script.runInContext(context, { timeout: 50 }); }
        catch (error) { stopped = true; throw error; }
      };
    } else {
      const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      substitute = stem => stem.replace(pattern, () => replace);
    }
  }
  const naming = { template: template.replaceAll('{seq}', `{seq:${padding}}`), text, start };
  const now = new Date();
  return async (item, index, captureDate) => {
    let stem = stemOf(item.path);
    if (mode !== 'find-replace') {
      const captured = needsCapture(template) ? await captureDate(item) : null;
      stem = renderName(item.name, naming, index, { captured, now }).stem;
    }
    if (substitute) stem = substitute(stem);
    if (!validStem(stem, path.extname(item.name)) || /^[.]|[. ]$/.test(stem) || Buffer.byteLength(stem + path.extname(item.name)) > 255) throw new Error('Invalid filename.');
    return stem;
  };
}

async function directory(dir) {
  if (await fs.realpath(dir) !== dir) throw problem(dir);
  const entries = new Map();
  for (const name of await fs.readdir(dir)) {
    const file = path.join(dir, name), key = fold(file);
    if (!entries.has(key)) entries.set(key, []);
    entries.get(key).push(file);
  }
  return entries;
}

async function plan(session, items, config, captureDate, undo) {
  const root = await fs.stat(session.folder);
  if (`${root.dev}:${root.ino}` !== session.folderId) throw problem(session.folder);
  const existing = new Map(), directories = new Map(), rows = [], moves = [], targets = new Map(), owners = new Map();
  const handoffs = new Set([...session.linkedPaths].map(f => f.toLowerCase()));
  for (const item of session.items) {
    if (item.develop?.tiff) handoffs.add(item.develop.tiff.toLowerCase());
    for (const record of item.develop?.handoffs || []) {
      if (record.path) handoffs.add(record.path.toLowerCase());
      if (record.realPath) handoffs.add(record.realPath.toLowerCase());
    }
    for (const key of sideNames(item)) {
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(item.id);
    }
  }
  const selected = new Set(items.map(i => i.id));
  let formatter, configError;
  try { if (!undo) formatter = format(config); } catch (error) { configError = error.message; }
  for (const [index, item] of items.entries()) {
    const row = { id: item.id, before: item.name, after: '', error: '', unchanged: false };
    rows.push(row);
    try {
      if (configError) throw new Error(configError);
      const dir = path.dirname(item.path);
      if (!directories.has(dir)) {
        const entries = await directory(dir);
        directories.set(dir, entries);
        for (const [key, paths] of entries) existing.set(key, paths);
      }
      const entries = directories.get(dir);
      const prior = undo?.get(item.id);
      const stem = prior ? stemOf(prior.path) : await formatter(item, index, captureDate);
      const dest = path.join(dir, stem + path.extname(item.path));
      row.after = path.basename(dest);
      row.unchanged = dest === item.path;
      const companions = item.companion ? [{ file: item.companion, to: prior?.companion || (row.unchanged ? item.companion : path.join(dir, stem + path.extname(item.companion))),
        expected: { fileId: item.companionFileId, size: item.companionSize, mtimeMs: item.companionMtimeMs } }] : [];
      const files = [{ file: item.path, to: dest, expected: item }, ...companions];
      const sides = new Set(sideNames(item).flatMap(key => entries.get(key) || []));
      if (sides.size !== item.renameSidecars.size) throw problem(item.path);
      for (const file of sides) {
        if (!item.renameSidecars.has(file)) throw problem(file);
        if (owners.get(fold(file)).size > 1) throw new Error('This XMP is shared by multiple photos.');
        const ext = path.extname(file), base = file.slice(0, -ext.length);
        const suffix = fold(base) === fold(path.join(dir, stemOf(item.path))) ? ext : path.extname(base) + ext;
        files.push({ file, to: prior?.sidecars.get(file) || (row.unchanged ? file : path.join(dir, stem + suffix)), expected: item.renameSidecars.get(file) });
      }
      // Reserve absent sidecars too: a rename must never adopt a stranger's XMP.
      for (const file of [dest, ...companions.map(c => c.to)].flatMap(sidecarPaths)) {
        const key = fold(file);
        if ([...(owners.get(key) || [])].some(id => !selected.has(id) && !prior?.shared.get(key)?.has(id))) throw new Error('Another photo uses this sidecar name.');
        if (!targets.has(key)) targets.set(key, new Set());
        targets.get(key).add(row);
      }
      for (const { file, to, expected } of files) {
        if (file !== to && (handoffs.has(file.toLowerCase()) || handoffs.has(to.toLowerCase()))) throw new Error('This filename is in use by a Develop hand-off.');
        if (Buffer.byteLength(path.basename(to)) > 255) throw new Error('Filename exceeds the filesystem limit.');
        if (!entries.get(fold(file))?.includes(file) || !matches(await fs.lstat(file), expected)) throw problem(file);
        moves.push({ from: file, to, expected, row });
        if (!targets.has(fold(to))) targets.set(fold(to), new Set());
        targets.get(fold(to)).add(row);
      }
    } catch (error) { row.error = error.message; }
  }
  const sources = new Set(moves.map(m => m.from));
  const destinations = new Set();
  for (const m of moves) {
    if (destinations.has(fold(m.to))) m.row.error = 'Filename collision within the batch.';
    destinations.add(fold(m.to));
  }
  for (const [key, users] of targets) {
    const collision = users.size > 1 && (!undo || destinations.has(key)) || existing.get(key)?.some(file => !sources.has(file));
    if (collision) for (const row of users) row.error ||= 'Filename collision.';
  }
  return { rows, moves, owners, valid: !rows.some(row => row.error) && moves.some(m => m.from !== m.to) };
}

// link() publishes exclusively on POSIX and Windows. rename() could overwrite a file created after preview.
async function hop(from, to, expected) {
  if (await fs.realpath(path.dirname(from)) !== path.dirname(from) || !matches(await fs.lstat(from), expected)) throw problem(from);
  try { await fs.link(from, to); }
  catch (error) {
    if (['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw new Error(`Cannot stage ${path.basename(from)}. Batch rename needs permission to create hard links on this volume.`);
    throw error;
  }
  try {
    if (!matches(await fs.lstat(to), expected) || !matches(await fs.lstat(from), expected)) throw problem(from);
    await fs.unlink(from);
  } catch (error) {
    if (matches(await fs.lstat(to), expected)) await fs.unlink(to);
    throw error;
  }
}

async function execute(plan, persist) {
  if (!plan.valid) throw new Error(plan.rows.find(row => row.error)?.error || 'No filenames would change.');
  const moves = plan.moves.filter(m => m.from !== m.to).map(m => ({ ...m, temp: path.join(path.dirname(m.from), '.photocull-' + randomUUID()) }));
  const hops = [];
  try {
    for (const [source, dest] of [['from', 'temp'], ['temp', 'to']]) for (const m of moves) {
      await hop(m[source], m[dest], m.expected);
      hops.push([m[dest], m[source], m.expected]);
    }
    await persist();
  } catch (error) {
    const failed = [];
    for (const [from, to, expected] of hops.reverse()) {
      try { await hop(from, to, expected); } catch { failed.push(from); }
    }
    if (failed.length) throw new Error(`${error.message}. Recovery required for: ${failed.join(', ')}`);
    throw error;
  }
}
module.exports = { plan, execute, stamp, sideNames, fold };
