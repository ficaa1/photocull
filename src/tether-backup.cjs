const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hashFile, safeParent } = require('./backup.cjs');
const { inside } = require('./library.cjs');

async function checkRoot({ root, folderId }) {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat?.isDirectory() || `${stat.dev}:${stat.ino}` !== folderId || await fs.realpath(root).catch(() => null) !== root) {
    throw Object.assign(new Error('Backup drive unavailable. Reconnect it or choose its folder again.'), { code: 'BACKUP_UNAVAILABLE' });
  }
}

async function hasAncestor(folder, folderId) {
  for (;;) {
    const stat = await fs.stat(folder);
    if (`${stat.dev}:${stat.ino}` === folderId) return true;
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

async function mirrorFile({ backup, source, relative, expectedHash, checkCurrent, renameExclusive }) {
  const target = path.resolve(backup.root, relative);
  if (!inside(backup.root, target) || await fs.realpath(source) !== source) throw new Error('The capture path changed.');
  const hash = expectedHash || (await hashFile(source)).hash;
  await checkRoot(backup);
  checkCurrent();
  await safeParent(backup.root, relative);
  const dir = path.dirname(target), ext = path.extname(target), stem = path.basename(target, ext);
  const parent = await fs.stat(dir);
  const sameParent = async () => {
    const stat = await fs.lstat(dir);
    return stat.isDirectory() && parent.ino === stat.ino && parent.dev === stat.dev && await fs.realpath(dir) === dir;
  };
  const temp = path.join(dir, `.photocull-${randomUUID()}.partial`);
  let staged, suffix = 0;
  try {
    for (;;) {
      await checkRoot(backup);
      if (!await sameParent()) throw new Error('Backup subfolder changed.');
      checkCurrent();
      const file = suffix ? path.join(dir, `${stem}_${suffix}${ext}`) : target;
      const existing = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (existing) {
        if (existing.isFile() && (await hashFile(file)).hash === hash) return { path: file, hash };
        suffix++;
        continue;
      }
      if (!staged) {
        const output = await fs.open(temp, 'wx');
        try {
          staged = await output.stat();
          await writeCopy(source, output, checkCurrent);
          staged = await output.stat();
        } finally { await output.close(); }
        if ((await hashFile(temp)).hash !== hash) throw new Error('Backup verification failed. The copy differs from the published file.');
        continue;
      }
      const stat = await fs.lstat(temp);
      if (stat.dev !== staged.dev || stat.ino !== staged.ino || stat.size !== staged.size || stat.mtimeMs !== staged.mtimeMs) {
        throw new Error('The verified backup file changed before publication.');
      }
      checkCurrent();
      try {
        await publish(temp, file, renameExclusive);
        if (process.platform !== 'win32') {
          const directory = await fs.open(dir);
          try { await directory.sync(); }
          catch (error) { if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error; }
          finally { await directory.close(); }
        }
        return { path: file, hash };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    if (staged && await sameParent().catch(() => false)) {
      const stat = await fs.lstat(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat?.dev === staged.dev && stat.ino === staged.ino) await fs.unlink(temp);
    }
  }
}

function backupState({ shoot, members }) {
  const state = { rev: shoot.backupRev || 0, root: shoot.backup?.root ?? null, enabled: !!shoot.backup?.enabled, pending: 0, synced: 0, failed: 0, error: null };
  for (const { backup } of Object.values(members)) {
    if (!backup || backup.folderId !== shoot.backup?.folderId || backup.destination !== state.root) continue;
    state[backup.status]++;
    if (backup.error) state.error ??= backup.error;
  }
  return state;
}

module.exports = { hasAncestor, checkRoot, mirrorFile, backupState };
