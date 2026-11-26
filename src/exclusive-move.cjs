const fs = require('node:fs/promises');
const { rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const unsupported = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EINVAL', 'ENOSYS', 'EXDEV']);

let helper;

// Standalone browser development runs without the desktop executable.
async function buildHelper() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-exclusive-'));
  const binary = path.join(dir, process.platform === 'win32' ? 'rename.exe' : 'rename');
  try {
    await run('rustc', ['--edition=2021', path.join(__dirname, '../src-tauri/src/exclusive_rename.rs'), '-o', binary]);
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    return binary;
  } catch (error) {
    helper = null;
    await fs.rm(dir, { recursive: true });
    throw new Error(`Exclusive rename on this volume needs the desktop app or the development Rust toolchain: ${error.message}`);
  }
}

// Returns true when a native move consumed the staging entry and may have changed its file ID.
async function publish(from, to) {
  try { await fs.link(from, to); return false; }
  catch (error) { if (!unsupported.has(error.code)) throw error; }
  const executable = process.env.PHOTOCULL_DESKTOP_EXE || await (helper ??= buildHelper());
  try { await run(executable, ['--rename-no-replace', from, to], { windowsHide: true }); return true; }
  catch (error) {
    if (error.code === 2) throw new Error(`Filename collision: ${to}`);
    throw new Error(`Could not publish ${to}: ${error.stderr?.trim() || error.message}`);
  }
}

const stamp = s => ({ fileId: `${s.dev}:${s.ino}`, size: s.size, mtimeMs: s.mtimeMs });
const sameAttributes = (s, expected) => s.isFile() && s.size === expected.size && s.mtimeMs === expected.mtimeMs;
const matches = (s, expected) => sameAttributes(s, expected) && expected.fileId === `${s.dev}:${s.ino}`;
const problem = file => Object.assign(new Error(`${path.basename(file)} changed since scan. Reopen the folder.`), { code: 'FILE_CHANGED' });

async function digest(handle, size) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new Error('File changed during rename.');
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  return hash.digest('hex');
}

// FAT can assign a new file ID on rename. The open source still identifies the original bytes.
async function movedReceipt(source, to, expected, mayChangeId) {
  const stat = await fs.lstat(to);
  if (matches(stat, expected)) return stamp(stat);
  if (!mayChangeId || !sameAttributes(stat, expected)) throw problem(to);
  const receipt = stamp(stat), target = await fs.open(to, 'r');
  try {
    if (!matches(await target.stat(), receipt) || await digest(source, expected.size) !== await digest(target, expected.size) ||
        !matches(await fs.lstat(to), receipt)) throw problem(to);
    return receipt;
  } finally { await target.close(); }
}

async function checkedMove(from, to, expected, move) {
  if (await fs.realpath(path.dirname(from)) !== path.dirname(from) || !matches(await fs.lstat(from), expected)) throw problem(from);
  const source = await fs.open(from, 'r');
  try {
    if (!matches(await source.stat(), expected)) throw problem(from);
    const mayChangeId = await move(from, to);
    return await movedReceipt(source, to, expected, mayChangeId);
  } finally { await source.close(); }
}

module.exports = { publish, checkedMove, matches, stamp, problem };
