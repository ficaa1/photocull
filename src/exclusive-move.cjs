const fs = require('node:fs/promises');
const { rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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

// A hard link leaves the private staging file available until the transaction commits.
async function publish(from, to) {
  try { await fs.link(from, to); return; }
  catch (error) { if (!unsupported.has(error.code)) throw error; }
  const executable = process.env.PHOTOCULL_DESKTOP_EXE || await (helper ??= buildHelper());
  try { await run(executable, ['--rename-no-replace', from, to], { windowsHide: true }); }
  catch (error) {
    if (error.code === 2) throw new Error(`Filename collision: ${to}`);
    throw new Error(`Could not publish ${to}: ${error.stderr?.trim() || error.message}`);
  }
}

module.exports = { publish };
