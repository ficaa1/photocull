const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

test('offline notices reproduce the bundled inventory and reject stale lockfile metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-notices-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts')); await fs.mkdir(path.join(root, 'src-tauri'));
  const repo = path.resolve(__dirname, '..');
  for (const file of ['scripts/notices.cjs', 'src-tauri/Cargo.lock', 'package-lock.json', 'THIRD_PARTY_NOTICES.md']) {
    await fs.copyFile(path.join(repo, file), path.join(root, file));
  }
  await fs.cp(path.join(repo, 'third-party'), path.join(root, 'third-party'), { recursive: true });
  const run = () => execFileSync(process.execPath, [path.join(root, 'scripts/notices.cjs'), '--check'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.match(run(), /Verified THIRD_PARTY_NOTICES/);
  await fs.appendFile(path.join(root, 'src-tauri/Cargo.lock'), '\n# changed dependency resolution\n');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/notices.cjs'), '--check'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Cargo.lock changed/);
});
