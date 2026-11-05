// Offline inventory from lockfiles and reviewed Cargo license metadata.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');
const digest = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const json = file => JSON.parse(read(file));
const write = (file, text) => fs.writeFileSync(path.join(root, file), text);
const snapshotFile = 'third-party/cargo-licenses.json';
const args = process.argv.slice(2);
const nativePath = file => process.platform !== 'win32' && /^[A-Z]:\\/i.test(file)
  ? '/mnt/' + file[0].toLowerCase() + file.slice(2).replaceAll('\\', '/') : file;
if (args.includes('--refresh') || args.includes('--metadata')) {
  const at = args.indexOf('--metadata');
  const metadata = at >= 0 ? JSON.parse(fs.readFileSync(args[at + 1], 'utf8').replace(/^\uFEFF/, ''))
    : JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 }));
  const texts = {};
  const packages = metadata.packages.filter(p => p.name !== 'photocull').map(p => {
    const dir = path.dirname(nativePath(p.manifest_path));
    const files = [];
    const collect = (folder, depth = 0) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!/^(licen[cs]e|copying|copyright|notice|unlicense|third[-_]party)/i.test(entry.name)) continue;
        const full = path.join(folder, entry.name);
        if (entry.isDirectory() && depth < 2) collect(full, depth + 1);
        else if (entry.isFile()) files.push(full);
      }
    };
    collect(dir);
    if (p.license_file) files.push(path.resolve(dir, p.license_file));
    const licenses = [...new Set(files)].map(file => {
      const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const id = digest(text); texts[id] = text;
      return { file: path.relative(dir, file).replaceAll('\\', '/'), text: id };
    });
    const supplements = json('third-party/rust-license-supplements.json')[`${p.name}@${p.version}`] || [];
    for (const extra of supplements) {
      const id = digest(extra.text); texts[id] = extra.text;
      licenses.push({ file: extra.file, url: extra.url, text: id });
    }
    if (!p.license) throw new Error(`No SPDX license for ${p.name}`);
    if (!licenses.length) throw new Error(`No license text for ${p.name}: review workspace license supplements.`);
    return { name: p.name, version: p.version, source: p.source, license: p.license, repository: p.repository, licenses };
  }).sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  write(snapshotFile, JSON.stringify({ cargoLock: digest(read('src-tauri/Cargo.lock')), packages, texts }, null, 2) + '\n');
}
const snapshot = json(snapshotFile);
if (snapshot.cargoLock !== digest(read('src-tauri/Cargo.lock'))) throw new Error('Cargo.lock changed: refresh reviewed Cargo license metadata.');
for (const p of snapshot.packages.filter(p => p.license === 'MPL-2.0')) {
  const archive = `third-party/sources/${p.name}-${p.version}.crate`;
  if (!fs.existsSync(path.join(root, archive))) throw new Error(`Missing MPL corresponding source: ${archive}`);
  const blocks = read('src-tauri/Cargo.lock').split('[[package]]');
  const block = blocks.find(b => b.includes(`name = "${p.name}"`) && b.includes(`version = "${p.version}"`));
  const checksum = /checksum = "([a-f0-9]+)"/.exec(block || '')?.[1];
  const actual = createHash('sha256').update(fs.readFileSync(path.join(root, archive))).digest('hex');
  if (actual !== checksum) throw new Error(`MPL source does not match Cargo.lock: ${archive}`);
}
const npm = Object.entries(json('package-lock.json').packages).filter(([name]) => name).map(([location, p]) => {
  if (!p.license) throw new Error(`No SPDX license in package-lock.json: ${location}`);
  return { name: location.split('node_modules/').at(-1), ...p };
}).sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
const rows = (items, columns) => items.map(p => '| ' + columns.map(f => String(f(p) ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ') + ' |').join('\n');
let output = `# Third-party notices\n\nReproduce offline with \`node scripts/notices.cjs\`. Inventory covers all lockfile targets, including optional and build-only dependencies; an installer contains only its target's production dependencies. License expressions preserve upstream choices. PhotoCull's own code is MIT; dependencies retain their licenses.\n\n`;
output += read('third-party/runtime-notices.md') + '\n';
output += '## npm lockfile inventory\n\n| Package | Version | License | Scope |\n| --- | --- | --- | --- |\n' + rows(npm, [p=>p.name,p=>p.version,p=>p.license,p=>p.dev?'Build/test only':p.optional?'Runtime, platform optional':'Runtime']) + '\n\n';
output += '## Rust lockfile inventory\n\nMetadata captured with `cargo metadata --locked --format-version 1`; reviewed license texts follow. MPL sources are supplied in `third-party/sources/`. Permissive alternatives are used where an expression offers them.\n\n| Crate | Version | License | Source |\n| --- | --- | --- | --- |\n' + rows(snapshot.packages,[p=>p.name,p=>p.version,p=>p.license,p=>p.repository || p.source]) + '\n\n';
const exif = json('third-party/windows-exiftool-inventory.json');
if (!npm.some(p => p.name === exif.package && p.version === exif.version)) throw new Error('Refresh Windows ExifTool binary inventory.');
output += '## Windows ExifTool native runtime\n\nExact binaries from the locked npm tarball; license archive retained intact. Some embedded-component builds require source/provenance verification before release (marked below). Perl modules also retain their source notices inside node_modules.\n\n| Binary | License / review status | SHA-256 |\n| --- | --- | --- |\n' + rows(exif.binaries, [p=>p.file,p=>p.license,p=>p.sha256]) + '\n\n';
output += '## Bundled Rust license texts\n\n';
for (const id of Object.keys(snapshot.texts).sort()) {
  const users = snapshot.packages.filter(p=>p.licenses.some(l=>l.text===id)).map(p=>`${p.name} ${p.version}`).join(', ');
  output += `### ${users}\n\n\`\`\`text\n${snapshot.texts[id].trim()}\n\`\`\`\n\n`;
}
const native = json('third-party/native-versions.json');
output += '## Native build versions by platform\n\n';
for (const [name, versions] of Object.entries(native)) {
  const entry = npm.find(p => p.name === name);
  if (!entry || entry.version !== (name.startsWith('@img/sharp-libvips-') ? '1.3.4' : '0.35.5')) throw new Error(`Refresh native build inventory for ${name}`);
  output += `### ${name} ${entry.version}\n\n| Component | Version |\n| --- | --- |\n` + rows(Object.entries(versions), [p=>p[0],p=>p[1]]) + '\n\n';
}
output += '## Native libvips dependencies\n\n' + read('third-party/sharp-libvips-NOTICES.md') + '\n';
const target = 'THIRD_PARTY_NOTICES.md';
if (args.includes('--check')) {
  if (read(target) !== output) throw new Error('THIRD_PARTY_NOTICES.md is stale: run npm run notices.');
} else write(target, output);
console.log(`${args.includes('--check') ? 'Verified' : 'Wrote'} ${target}: ${npm.length} npm packages, ${snapshot.packages.length} Rust crates.`);
