// Update application code in an existing portable folder without copying Electron again.
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('../src/xmp.cjs');
async function update(folder) {
  if (!folder) throw new Error('Usage: npm run update:win -- /path/to/existing/PhotoCull-folder');
  const root = path.resolve(__dirname, '..'), target = path.resolve(folder), application = path.join(target, 'resources', 'app');
  await fs.access(path.join(target, 'PhotoCull.exe'));
  const installed = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'));
  const pkg = require('../package.json');
  if (JSON.stringify(installed.dependencies) !== JSON.stringify(pkg.dependencies)) throw new Error('Runtime dependencies changed. Build with pack:win before replacing the existing portable folder.');
  async function copy(source, dest) {
    const info = await fs.stat(source);
    if (info.isDirectory()) {
      await fs.mkdir(dest, { recursive: true });
      for (const name of await fs.readdir(source)) await copy(path.join(source, name), path.join(dest, name));
    } else await atomicWrite(dest, await fs.readFile(source));
  }
  for (const name of ['src', 'assets', 'docs', 'third-party', 'README.md']) await copy(path.join(root, name), path.join(application, name));
  const { devDependencies, scripts, ...production } = pkg;
  await atomicWrite(path.join(application, 'package.json'), JSON.stringify(production, null, 2));
  console.log(`Updated ${target} to ${pkg.version}. Restart PhotoCull to load the update.`);
}
if (require.main === module) update(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { update };
