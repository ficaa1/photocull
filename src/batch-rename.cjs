const fs = require('node:fs/promises');
const path = require('node:path');
const { publish, checkedMove, matches, stamp, problem } = require('./exclusive-move.cjs');
const vm = require('node:vm');
const { renderName, validStem, needsCapture } = require('./renderer/naming.js');
const { sidecarPaths } = require('./xmp.cjs');

const fold = file => path.join(path.dirname(file), path.basename(file).normalize('NFC').toLowerCase());
const stemOf = file => path.basename(file, path.extname(file));
const sideNames = item => [...new Set([item.path, item.companion].filter(Boolean).flatMap(sidecarPaths).map(fold))];

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
      if (undo && (!prior || prior.primary !== item.path || prior.companion !== item.companion)) throw problem(item.path);
      const stem = prior ? stemOf(prior.pairs.get(item.path).from) : await formatter(item, index, captureDate);
      const dest = prior ? prior.pairs.get(item.path).from : path.join(dir, stem + path.extname(item.path));
      row.after = path.basename(dest);
      row.unchanged = dest === item.path;
      const target = (file, suffix) => {
        if (prior) return prior.pairs.get(file).from;
        return row.unchanged ? file : path.join(dir, stem + suffix);
      };
      const companions = item.companion ? [{ file: item.companion, to: target(item.companion, path.extname(item.companion)),
        expected: { fileId: item.companionFileId, size: item.companionSize, mtimeMs: item.companionMtimeMs } }] : [];
      const files = [{ file: item.path, to: dest, expected: item }, ...companions];
      const sides = new Set(sideNames(item).flatMap(key => entries.get(key) || []));
      if (sides.size !== item.renameSidecars.size || prior && files.length + sides.size !== prior.pairs.size) throw problem(item.path);
      for (const file of sides) {
        if (!item.renameSidecars.has(file) || prior && (!prior.pairs.has(file) || prior.pairs.get(file).invalid)) throw problem(file);
        if (owners.get(fold(file)).size > 1) throw new Error('This XMP is shared by multiple photos.');
        const ext = path.extname(file), base = file.slice(0, -ext.length);
        const suffix = fold(base) === fold(path.join(dir, stemOf(item.path))) ? ext : path.extname(base) + ext;
        files.push({ file, to: target(file, suffix), expected: item.renameSidecars.get(file) });
      }
      // Reserve absent sidecars too: a rename must never adopt a stranger's XMP.
      for (const file of [dest, ...companions.map(c => c.to)].flatMap(sidecarPaths)) {
        const key = fold(file);
        if ([...(owners.get(key) || [])].some(id => !selected.has(id) && !prior?.shared.get(key)?.has(id))) throw new Error('Another photo uses this sidecar name.');
        if (!targets.has(key)) targets.set(key, new Set());
        targets.get(key).add(row);
      }
      for (const member of files) {
        const { file, to } = member;
        const expected = prior ? prior.pairs.get(file).expected : member.expected;
        if (file !== to && (handoffs.has(file.toLowerCase()) || handoffs.has(to.toLowerCase()))) throw new Error('This filename is in use by a Develop hand-off.');
        if (Buffer.byteLength(path.basename(to)) > 255) throw new Error('Filename exceeds the filesystem limit.');
        if (!entries.get(fold(file))?.includes(file) || !matches(await fs.lstat(file), expected)) throw problem(file);
        const { fileId, size, mtimeMs } = expected;
        moves.push({ from: file, to, expected: { fileId, size, mtimeMs }, row });
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
  return { rows, moves, owners, targets, valid: !rows.some(row => row.error) && moves.some(m => m.from !== m.to) };
}

async function verify(file, expected) {
  if (!matches(await fs.lstat(file), expected)) throw problem(file);
}

async function verifyTargets(plan) {
  const actual = new Map(), physical = new Map(plan.moves.map(m => [fold(m.to), m.to]));
  for (const dir of new Set(plan.moves.map(m => path.dirname(m.to)))) {
    for (const [key, files] of await directory(dir)) actual.set(key, files);
  }
  for (const key of plan.targets.keys()) {
    const entries = actual.get(key) || [], file = physical.get(key);
    const valid = file ? entries.length === 1 && entries[0] === file : entries.length === 0;
    if (!valid) throw new Error(`Filename collision: ${key}`);
  }
  for (const m of plan.moves) await verify(m.to, m.current || m.expected);
}

async function rollback(moves) {
  const problems = [];
  for (const m of moves.filter(m => m.published)) {
    try {
      m.current = await checkedMove(m.to, m.recall, m.current, async (from, to) => {
        await fs.rename(from, to);
        m.displaced = true;
        return m.variableFileIds;
      });
      m.displaced = false;
      m.held = m.recall;
    } catch (error) {
      problems.push(`${m.to}: ${error.message}`);
      if (m.displaced) {
        try { await publish(m.recall, m.to); m.displaced = false; }
        catch (restoreError) { problems.push(`${m.recall} → ${m.to}: ${restoreError.message}`); }
      }
    }
  }
  for (const m of moves) {
    try {
      if (m.held) {
        if (m.stageVerified) m.current = await checkedMove(m.held, m.from, m.current, publish);
        else await publish(m.held, m.from);
      }
      await verify(m.from, m.current || m.expected);
      m.restored = true;
    } catch (error) { problems.push(`${m.held || m.from} → ${m.from}: ${error.message}`); }
  }
  return problems;
}

async function execute(plan, persist) {
  if (!plan.valid) throw new Error(plan.rows.find(row => row.error)?.error || 'No filenames would change.');
  const moves = plan.moves.filter(m => m.from !== m.to), dirs = new Map();
  let failure, recovery = [];
  const cleanup = [];
  try {
    for (const [i, m] of moves.entries()) {
      const parent = path.dirname(m.from);
      if (!dirs.has(parent)) {
        const dir = await fs.mkdtemp(path.join(parent, '.photocull-'));
        const staging = { dir };
        dirs.set(parent, staging);
        // Verify exclusive publication on this volume before touching any original.
        const probe = path.join(dir, 'probe'), dest = path.join(dir, 'probe-moved');
        try { await fs.writeFile(probe, '', { flag: 'wx' }); staging.variableFileIds = await publish(probe, dest); }
        finally { await removePrivate(probe); await removePrivate(dest); }
      }
      m.variableFileIds = dirs.get(parent).variableFileIds;
      m.temp = path.join(dirs.get(parent).dir, String(i));
      m.recall = m.temp + '-rollback';
    }
    for (const m of plan.moves) {
      if (m.variableFileIds === undefined && dirs.has(path.dirname(m.from))) {
        m.variableFileIds = dirs.get(path.dirname(m.from)).variableFileIds;
      }
    }
    for (const m of moves) {
      m.current = await checkedMove(m.from, m.temp, m.expected, async (from, to) => {
        await fs.rename(from, to);
        m.held = to;
        return m.variableFileIds;
      });
      m.stageVerified = true;
    }
    for (const m of moves) {
      m.current = await checkedMove(m.temp, m.to, m.current, async (from, to) => {
        const mayChangeId = await publish(from, to);
        m.published = true;
        return mayChangeId;
      });
    }
    await verifyTargets(plan);
    await persist();
  } catch (error) {
    failure = error;
    recovery = await rollback(moves);
  }
  for (const m of moves) {
    for (const file of [m.temp, m.recall].filter(Boolean)) {
      if (failure && (!m.restored || m.displaced && file === m.recall)) {
        if (await fs.lstat(file).then(() => true, error => error.code !== 'ENOENT'))
          recovery.push(`${file} → ${m.displaced && file === m.recall ? m.to : m.from}`);
      } else {
        try { await removePrivate(file); } catch (error) { cleanup.push(error.message); }
      }
    }
  }
  for (const { dir } of dirs.values()) {
    try { await fs.rmdir(dir); }
    catch (error) { if (!recovery.length || error.code !== 'ENOTEMPTY') cleanup.push(error.message); }
  }
  if (recovery.length) {
    const paths = [...new Set([...recovery, ...cleanup])].join('\n');
    throw Object.assign(new Error(`${failure.message}. Recovery required. Reopen the folder after checking:\n${paths}`), { code: 'RENAME_RECOVERY' });
  }
  if (failure) {
    if (cleanup.length) failure.message += '\n' + cleanup.join('\n');
    throw failure;
  }
  return cleanup;
}

async function removePrivate(file) {
  try { await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

module.exports = { plan, execute, stamp, sideNames, fold };
