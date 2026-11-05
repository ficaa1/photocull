// Prepares what `tauri build` bundles next to the Rust shell:
//   src-tauri/backend/            src/ plus production node_modules (resource)
//   src-tauri/binaries/node-<triple>   the Node runtime running this script (sidecar)
// sharp and exiftool-vendored install platform-specific binaries, so stage on
// the platform you are building for (CI builds each OS natively).
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tauri = path.join(root, 'src-tauri');

function hostTriple() {
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  return /^host: (\S+)$/m.exec(output)[1];
}

async function main() {
  execFileSync(process.execPath, [path.join(__dirname, 'notices.cjs'), '--check'], { cwd: root, stdio: 'inherit' });
  const backend = path.join(tauri, 'backend');
  await fs.rm(backend, { recursive: true, force: true });
  await fs.mkdir(backend, { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(backend, 'src'), { recursive: true });
  // Decoder licenses and the LibRaw/WASM sources ship with the app (LGPL/CDDL).
  await fs.cp(path.join(root, 'third-party'), path.join(backend, 'third-party'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(path.join(root, file), path.join(backend, file));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: backend, stdio: 'inherit', shell: process.platform === 'win32' });

  const triple = hostTriple(), suffix = process.platform === 'win32' ? '.exe' : '';
  const binaries = path.join(tauri, 'binaries');
  await fs.mkdir(binaries, { recursive: true });
  const node = path.join(binaries, `node-${triple}${suffix}`);
  await fs.copyFile(process.execPath, node);
  await fs.chmod(node, 0o755);
  // Node's MIT license and bundled third-party notices must ship with the binary.
  // Official builds keep LICENSE next to node.exe (Windows) or one level above bin/node.
  const nodeDir = path.dirname(await fs.realpath(process.execPath));
  const license = [path.join(nodeDir, 'LICENSE'), path.join(nodeDir, '..', 'LICENSE')];
  const found = (await Promise.all(license.map(file => fs.access(file).then(() => file, () => null)))).find(Boolean);
  if (!found) throw new Error(`Node's LICENSE was not found next to ${process.execPath}; use an official Node build.`);
  await fs.copyFile(found, path.join(backend, 'third-party', 'Node-LICENSE.txt'));
  await fs.writeFile(path.join(backend, 'third-party', 'Node-VERSION.txt'), process.version + '\n');
  console.log(`Staged backend (${backend}) and Node ${process.version} (${node}).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
