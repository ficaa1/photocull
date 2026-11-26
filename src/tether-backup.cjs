const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { hashFile, safeParent } = require('./backup.cjs');
const { inside } = require('./library.cjs');

const precise = { bigint: true };
const MARKER = '.photocull-backup-id';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const wrongDrive = () => Object.assign(new Error('Wrong backup drive. Reconnect the selected destination.'), { code: 'BACKUP_WRONG_DRIVE' });
const offline = () => Object.assign(new Error('Backup drive unavailable.'), { code: 'BACKUP_UNAVAILABLE' });

async function readMarker(root) {
  const file = path.join(root, MARKER), stat = await fs.lstat(file, precise);
  if (!stat.isFile() || stat.size > 64) throw wrongDrive();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat(precise);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 64) throw wrongDrive();
    const buffer = Buffer.alloc(64), { bytesRead } = await handle.read(buffer);
    const id = buffer.toString('utf8', 0, bytesRead).trim().toLowerCase();
    if (!UUID.test(id) || !sameFile(opened, await handle.stat(precise)) || !sameFile(opened, await fs.lstat(file, precise))) throw wrongDrive();
    return id;
  } finally { await handle.close(); }
}

async function markRoot(root, selected) {
  const verifyRoot = async () => {
    const stat = await fs.lstat(root, precise);
    if (!stat.isDirectory() || await fs.realpath(root) !== root || stat.dev !== selected.dev || stat.ino !== selected.ino) throw wrongDrive();
  };
  const reuse = async () => {
    const id = await readMarker(root);
    await verifyRoot();
    return id;
  };
  await verifyRoot();
  const file = path.join(root, MARKER);
  try { return await reuse(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let handle;
  try { handle = await fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code === 'EEXIST') return reuse(); throw error; }
  try {
    await verifyRoot();
    const opened = await handle.stat(precise);
    if (!opened.isFile() || opened.dev !== selected.dev || !sameFile(opened, await namedStat(file))) throw wrongDrive();
    await verifyRoot();
    const id = randomUUID();
    await handle.writeFile(id + '\n');
    await handle.sync();
    if (await reuse() !== id) throw wrongDrive();
    return id;
  } catch (error) {
    try {
      const stat = await handle.stat(precise);
      if (!stat.size && sameFile(stat, await namedStat(file))) await fs.unlink(file);
    } catch {}
    throw error;
  } finally { await handle.close(); }
}

async function checkRoot({ root, backupVolumeId }) {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat) throw offline();
  if (!stat.isDirectory() || await fs.realpath(root) !== root || !backupVolumeId) throw wrongDrive();
  const marker = await readMarker(root).catch(error => {
    if (error.code === 'ENOENT') throw wrongDrive();
    throw error;
  });
  if (marker !== backupVolumeId) throw wrongDrive();
}

async function hasAncestor(folder, ancestor) {
  for (;;) {
    const stat = await fs.stat(folder, precise);
    if (stat.dev === ancestor.dev && stat.ino === ancestor.ino) return true;
    const parent = path.dirname(folder);
    if (parent === folder) return false;
    folder = parent;
  }
}

async function writeCopy(source, output, checkCurrent) {
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (!(await input.stat()).isFile()) throw new Error('The published capture is no longer a regular file.');
    for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      checkCurrent();
      await output.writeFile(chunk);
    }
    await output.sync();
  } finally { await input.close(); }
}

async function publish(temp, file, renameExclusive) {
  try { await fs.link(temp, file); }
  catch (error) {
    // FAT and exFAT support exclusive rename but lack hard links.
    if (!renameExclusive || !['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(error.code)) throw error;
    await renameExclusive(temp, file);
  }
}

const collision = () => Object.assign(new Error('The backup filename is occupied.'), { code: 'BACKUP_COLLISION' });
const namedStat = file => fs.lstat(file, precise).catch(error => { if (error.code !== 'ENOENT') throw error; });
const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

async function matches(file, expected) {
  if (!expected || !(await namedStat(file))?.isFile()) return false;
  try { return (await hashFile(file)).hash === expected; }
  catch (error) { if (['FILE_CHANGED', 'ENOENT', 'ELOOP'].includes(error.code)) return false; throw error; }
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs), size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
}

function identifies(id, stat) {
  return stat?.isFile() && id?.dev === String(stat.dev) && id.ino === String(stat.ino) && id.birthtimeNs === String(stat.birthtimeNs) &&
    id.size === String(stat.size) && id.mtimeNs === String(stat.mtimeNs);
}

async function verifiedReceipt(receipt) {
  if (!receipt?.owned || !receipt.identity) return;
  const stat = await namedStat(receipt.path);
  if (!identifies(receipt.identity, stat)) return;
  const id = identity(stat);
  if (await matches(receipt.path, receipt.hash) && identifies(id, await namedStat(receipt.path))) {
    return { path: receipt.path, hash: receipt.hash, owned: true, identity: id };
  }
}

async function backupDirectory(backup, relative, checkCurrent, create = true) {
  await checkRoot(backup);
  checkCurrent();
  if (!inside(backup.root, path.resolve(backup.root, relative))) throw new Error('Invalid backup path.');
  if (create) await safeParent(backup.root, relative);
  const dir = path.dirname(path.join(backup.root, relative)), parent = await fs.lstat(dir, precise);
  const verify = async (active = true) => {
    await checkRoot(backup);
    const stat = await fs.lstat(dir, precise);
    if (!stat.isDirectory() || stat.ino !== parent.ino || stat.dev !== parent.dev || await fs.realpath(dir) !== dir) throw new Error('Backup subfolder changed.');
    if (active) checkCurrent();
  };
  await verify();
  return { dir, verify };
}

const backupStem = (base, suffix) => suffix ? `${base}_${suffix}` : base;

function reservedStems(ledger, plan, sourceStem) {
  const { root, backupVolumeId } = ledger.shoot.backup, dir = path.dirname(sourceStem), taken = new Set();
  for (const exposure of Object.values(ledger.exposures)) {
    for (const other of exposure.backupPlans || []) {
      if (other === plan || other.root !== root || other.backupVolumeId !== backupVolumeId || path.dirname(other.sourceStem) !== dir) continue;
      taken.add(backupStem(path.basename(other.sourceStem), other.suffix).normalize('NFC').toLowerCase());
    }
  }
  return taken;
}

async function availableStem(dir, base, start, images, sidecar, reserved) {
  const names = await fs.readdir(dir);
  for (let suffix = start; ; suffix++) {
    const stem = backupStem(base, suffix), folded = stem.normalize('NFC').toLowerCase();
    if (reserved.has(folded)) continue;
    const family = names.filter(name => name.normalize('NFC').toLowerCase().startsWith(folded + '.'));
    let usable = true;
    for (const name of family) {
      const extension = name.normalize('NFC').slice(stem.normalize('NFC').length);
      const file = path.join(dir, stem + extension);
      const expected = images.get(extension);
      const recognized = expected ? await matches(file, expected) : sidecar?.path === file && await verifiedReceipt(sidecar);
      if (!recognized) { usable = false; break; }
      // A decomposing filesystem can list a different spelling of the same entry.
      if (name !== stem + extension && !sameFile(await namedStat(file), await namedStat(path.join(dir, name)))) { usable = false; break; }
    }
    if (usable) return { stem, suffix };
  }
}

async function cleanPartial(temp, verify, created) {
  if (!/^\.photocull-backup-[a-f0-9-]{36}\.partial$/.test(path.basename(temp))) throw new Error('Invalid backup staging name.');
  await verify(!created);
  const stat = await namedStat(temp);
  if (stat) {
    if (created && (stat.ino !== created.ino || stat.dev !== created.dev)) return;
    if (!stat.isFile()) throw new Error('The backup staging path is no longer a regular file.');
    await fs.unlink(temp);
  }
}

async function sweepPartial(backup, relative, partial, checkCurrent) {
  if (path.basename(partial) !== partial) throw new Error('Invalid backup staging name.');
  try {
    const { dir, verify } = await backupDirectory(backup, relative, checkCurrent, false);
    const temp = path.join(dir, partial);
    await cleanPartial(temp, verify);
    if (await namedStat(temp)) return false;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await checkRoot(backup);
  return true;
}

async function updateSidecar({ source, file, hash, previous, verify, remember }) {
  const flags = (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  const bytes = await fs.readFile(source, { flag: constants.O_RDONLY | flags });
  const digest = data => createHash('sha256').update(data).digest('hex');
  if (digest(bytes) !== hash) throw new Error('The published sidecar changed during backup.');
  const handle = await fs.open(file, constants.O_RDWR | flags).catch(error => {
    if (['ENOENT', 'ELOOP'].includes(error.code)) throw collision();
    throw error;
  });
  try {
    const before = await handle.stat(precise);
    if (before.nlink !== 1n || !identifies(previous.identity, before) || digest(await handle.readFile()) !== previous.hash) throw collision();
    await verify();
    const current = await handle.stat(precise);
    if (current.nlink !== 1n || !identifies(previous.identity, current) || !identifies(previous.identity, await namedStat(file))) throw collision();
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error('The backup sidecar write stopped.');
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length);
    const receipt = { path: file, hash, owned: true, identity: identity(await handle.stat(precise)) };
    await remember(receipt);
    await handle.sync();
    if (!await verifiedReceipt(receipt)) throw collision();
    return receipt;
  } finally { await handle.close(); }
}

async function mirrorFile({ source, file, temp, hash, previous, sidecar, verify, checkCurrent, renameExclusive, remember }) {
  if (await fs.realpath(source) !== source) throw new Error('The capture path changed.');
  hash ||= (await hashFile(source)).hash;
  await verify();
  const existing = await namedStat(file);
  if (existing) {
    const owned = previous?.owned && previous.path === file && identifies(previous.identity, existing);
    if (sidecar) {
      if (!owned) throw collision();
      if (hash !== previous.hash) return updateSidecar({ source, file, hash, previous, verify, remember });
    }
    const receipt = { path: file, hash, owned: !!owned, identity: identity(existing) };
    if (!await matches(file, hash) || !identifies(receipt.identity, await namedStat(file))) throw collision();
    return receipt;
  }
  const output = await fs.open(temp, 'wx');
  let staged;
  try {
    try {
      staged = await output.stat(precise);
      await writeCopy(source, output, checkCurrent);
      staged = await output.stat(precise);
    } finally { await output.close(); }
    if (!await matches(temp, hash)) throw new Error('Backup verification failed. The copy differs from the published file.');
    const receipt = { path: file, hash, owned: true, identity: identity(staged) };
    await remember(receipt);
    await verify();
    if (!identifies(receipt.identity, await namedStat(temp))) throw new Error('The verified backup file changed before publication.');
    try { await publish(temp, file, renameExclusive); }
    catch (error) { if (error.code === 'EEXIST') throw collision(); throw error; }
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file));
      try { await directory.sync(); }
      catch (error) { if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error; }
      finally { await directory.close(); }
    }
    return receipt;
  } finally { if (staged) await cleanPartial(temp, verify, staged); }
}

async function publishedReceipts(plan, dir) {
  const receipts = new Map();
  for (const receipt of Object.values(plan?.prepared || {})) {
    if (path.dirname(receipt.path) !== dir) continue;
    const published = await verifiedReceipt(receipt);
    if (published) receipts.set(published.path, published);
  }
  return receipts;
}

function backupState({ shoot, members }) {
  const state = { rev: shoot.backupRev || 0, root: shoot.backup?.root ?? null, enabled: !!shoot.backup?.enabled, availability: shoot.backup?.availability ?? 'checking', pending: 0, synced: 0, failed: 0, error: null };
  for (const { backup } of Object.values(members)) {
    if (!backup || backup.backupVolumeId !== shoot.backup?.backupVolumeId || backup.destination !== state.root) continue;
    state[backup.status]++;
    if (backup.error) state.error ??= backup.error;
  }
  return state;
}

module.exports = { identifies, hasAncestor, markRoot, checkRoot, backupDirectory, backupStem, reservedStems, availableStem, cleanPartial, sweepPartial, mirrorFile, publishedReceipts, backupState };
