const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('close', code => code ? reject(new Error(`${command} exited with ${code}`)) : resolve());
  });
}
async function main() {
  const root = path.resolve(__dirname, '..');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-win-'));
  try {
    const pkg = require('../package.json');
    const { devDependencies, scripts, ...production } = pkg;
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(production, null, 2));
    await fs.cp(path.join(root, 'src'), path.join(stage, 'src'), { recursive: true });
    await fs.cp(path.join(root, 'README.md'), path.join(stage, 'README.md'));
    await fs.cp(path.join(root, 'docs'), path.join(stage, 'docs'), { recursive: true });
    await fs.cp(path.join(root, 'third-party'), path.join(stage, 'third-party'), { recursive: true });
    await fs.cp(path.join(root, 'assets'), path.join(stage, 'assets'), { recursive: true });
    // Install platform-specific sharp and ExifTool without changing this checkout's Linux modules.
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const fsSync = require('node:fs');
    const cli = fsSync.existsSync(npmCli) ? npmCli : path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    await run(process.execPath, [cli, 'install', '--prefix', stage, '--omit=dev', '--ignore-scripts', '--os=win32', '--cpu=x64', '--package-lock=false']);
    const { packager } = await import('@electron/packager');
    const output = await packager({ dir: stage, name: 'PhotoCull', executableName: 'PhotoCull',
      platform: 'win32', arch: 'x64', electronVersion: require('electron/package.json').version,
      out: path.join(root, 'release'), overwrite: true, asar: false, prune: false,
      win32metadata: { CompanyName: 'PhotoCull', FileDescription: 'Preview-first photo culling', ProductName: 'PhotoCull' } });
    console.log('Windows portable application:', output);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
