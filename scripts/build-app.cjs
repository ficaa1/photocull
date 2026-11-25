const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function run(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const stagingEnv = { ...process.env };
delete stagingEnv.TAURI_SIGNING_PRIVATE_KEY;
delete stagingEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
run('scripts/stage-backend.cjs', [], stagingEnv);
const args = ['build', '--config', 'src-tauri/tauri.bundle.conf.json'];
if (process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) args.push('--config', 'src-tauri/tauri.updater.conf.json');
run(require.resolve('@tauri-apps/cli/tauri.js'), [...args, ...process.argv.slice(2)], process.env);
