const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '../scripts/release-manifest.cjs');
const { buildManifest } = require(script);
const repo = 'example/photocull', tag = 'v0.9.3-rc.1+build.4';

const key = crypto.generateKeyPairSync('ed25519');
const keyId = crypto.randomBytes(8);
function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function pubkey(publicKey, id = keyId) {
  const bytes = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return base64('untrusted comment: public key\n' + base64(Buffer.concat([Buffer.from('Ed'), id, bytes])) + '\n');
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photocull-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'src-tauri', 'tauri.conf.json');
  write(dir, 'package.json', JSON.stringify({ version: tag.slice(1) }));
  write(dir, 'src-tauri/tauri.conf.json', JSON.stringify({
    version: tag.slice(1), plugins: { updater: { pubkey: pubkey(key.publicKey), requireSignedVersion: true } },
  }));
  return { dir, tag, repo, config, pubDate: '2026-11-25T12:00:00Z', notes: 'Release notes' };
}
function write(dir, relative, content) {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function signed(dir, relative, { alg = 'ED', comment = 'timestamp:123\tversion:' + tag, id = keyId } = {}) {
  const payload = Buffer.from('installer');
  const data = alg === 'ED' ? crypto.createHash('blake2b512').update(payload).digest() : payload;
  const signature = crypto.sign(null, data, key.privateKey);
  const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(comment)]), key.privateKey);
  const packet = Buffer.concat([Buffer.from(alg), id, signature]);
  const text = base64(['untrusted comment: test', base64(packet), 'trusted comment: ' + comment, base64(global)].join('\n'));
  write(dir, relative, payload);
  write(dir, relative + '.sig', text + '\n');
  return text;
}
function asset(name, signature) {
  return { signature, url: 'https://github.com/example/photocull/releases/download/' + tag + '/' + name };
}

test('nested signed installers use flat release URLs and NSIS is the Windows fallback', t => {
  const options = fixture(t);
  const arm = signed(options.dir, 'macos/PhotoCull.app.tar.gz');
  const intel = signed(options.dir, 'intel/x64/macos/PhotoCull-intel.app.tar.gz');
  const nsis = signed(options.dir, 'a-nsis/PhotoCull-setup.exe');
  const msi = signed(options.dir, 'z-msi/PhotoCull.msi', { alg: 'Ed' });
  write(options.dir, 'macos/PhotoCull.dmg', 'disk image');
  assert.deepEqual(buildManifest(options), {
    version: '0.9.3-rc.1+build.4', notes: 'Release notes', pub_date: options.pubDate,
    platforms: {
      'darwin-aarch64': asset('PhotoCull.app.tar.gz', arm),
      'darwin-x86_64': asset('PhotoCull-intel.app.tar.gz', intel),
      'windows-x86_64': asset('PhotoCull-setup.exe', nsis),
      'windows-x86_64-nsis': asset('PhotoCull-setup.exe', nsis),
      'windows-x86_64-msi': asset('PhotoCull.msi', msi),
    },
  });
});

test('the release CLI publishes MSI-only updates and reports invalid tags before writing', t => {
  const { dir } = fixture(t), out = path.join(dir, 'latest.json');
  const msi = signed(dir, 'PhotoCull.msi');
  const cli = tag => spawnSync(process.execPath, [script, '--dir', dir, '--tag', tag, '--repo', repo, '--out', out], { cwd: dir, encoding: 'utf8' });
  for (const bad of ['0.9.3', 'v01.2.3', 'v1.2', 'v1.2.3-01', 'v1.2.3+']) {
    const result = cli(bad);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag/i);
    assert.equal(fs.existsSync(out), false);
  }
  const result = cli(tag);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(manifest.platforms, {
    'windows-x86_64-msi': asset('PhotoCull.msi', msi),
    'windows-x86_64': asset('PhotoCull.msi', msi),
  });
  assert.equal(manifest.notes, '');
  assert.ok(Number.isFinite(Date.parse(manifest.pub_date)));
});

test('incomplete signatures and empty payloads abort even when another platform is valid', t => {
  const options = fixture(t);
  write(options.dir, 'unsigned/PhotoCull.msi', 'installer');
  assert.throws(() => buildManifest(options), /no signed updater/i);
  signed(options.dir, 'windows/PhotoCull-setup.exe');
  assert.throws(() => buildManifest(options), /PhotoCull\.msi/);
  signed(options.dir, 'unsigned/PhotoCull.msi');
  write(options.dir, 'macos/App.app.tar.gz.sig', 'sig');
  assert.throws(() => buildManifest(options), /App\.app\.tar\.gz/);
  write(options.dir, 'macos/App.app.tar.gz', '');
  assert.throws(() => buildManifest(options), /empty.*App\.app\.tar\.gz/i);
  write(options.dir, 'macos/App.app.tar.gz', 'installer');
  write(options.dir, 'macos/App.app.tar.gz.sig', ' \n');
  assert.throws(() => buildManifest(options), /empty.*App\.app\.tar\.gz\.sig/i);
});

test('ambiguous platforms and colliding flattened asset names abort publication', t => {
  const options = fixture(t);
  signed(options.dir, 'a/App.app.tar.gz');
  signed(options.dir, 'x86_64/App.app.tar.gz');
  assert.throws(() => buildManifest(options), /App\.app\.tar\.gz/);
  fs.rmSync(path.join(options.dir, 'x86_64'), { recursive: true });
  signed(options.dir, 'b/Other.app.tar.gz');
  assert.throws(() => buildManifest(options), /darwin-aarch64/);
});

test('verification rejects tampered installers, keys and authenticated comments', t => {
  const options = fixture(t), name = 'PhotoCull.msi';
  const text = signed(options.dir, name);
  write(options.dir, name + '.sig', base64(Buffer.from(text, 'base64').toString().replace('timestamp:123', 'timestamp:124')));
  assert.throws(() => buildManifest(options), /trusted comment/i);
  signed(options.dir, name, { id: Buffer.alloc(8) });
  assert.throws(() => buildManifest(options), /key id/i);
  signed(options.dir, name);
  write(options.dir, name, 'changed');
  assert.throws(() => buildManifest(options), /signature/i);
  write(options.dir, name, 'installer');
  const config = JSON.parse(fs.readFileSync(options.config));
  config.plugins.updater.pubkey = pubkey(crypto.generateKeyPairSync('ed25519').publicKey);
  fs.writeFileSync(options.config, JSON.stringify(config));
  assert.throws(() => buildManifest(options), /signature/i);
});

test('the first tab-delimited signed version must match the entire release version', t => {
  const options = fixture(t);
  for (const comment of ['timestamp:123 version:' + tag, 'version:0.9.2\tversion:' + tag, 'version:0.9.3-rc.1+build.5']) {
    signed(options.dir, 'PhotoCull.msi', { comment });
    assert.throws(() => buildManifest(options), /signed version/i);
  }
});

test('verify-only checks both project versions and the payload without creating a manifest', t => {
  const { dir, config } = fixture(t), out = path.join(dir, 'latest.json');
  signed(dir, 'PhotoCull.msi');
  const verify = () => spawnSync(process.execPath, [script, '--verify-only', '--tag', tag, '--repo', repo,
    '--dir', dir, '--config', config, '--out', out], { cwd: dir, encoding: 'utf8' });
  const valid = verify();
  assert.equal(valid.status, 0, valid.stderr);
  for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
    const original = fs.readFileSync(path.join(dir, file));
    write(dir, file, JSON.stringify({ ...JSON.parse(original), version: '0.9.2' }));
    const result = verify();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version/i);
    write(dir, file, original);
  }
  write(dir, 'PhotoCull.msi', 'other payload');
  assert.notEqual(verify().status, 0);
  assert.equal(fs.existsSync(out), false);
});

test('asset names that GitHub would rewrite abort publication', t => {
  const options = fixture(t);
  signed(options.dir, 'macos/Photo Cull.app.tar.gz');
  assert.throws(() => buildManifest(options), /asset name/i);
  fs.rmSync(path.join(options.dir, 'macos'), { recursive: true });
  signed(options.dir, 'PhotoCull.msi');
  write(options.dir, 'Photo Cull.dmg', 'disk image');
  assert.throws(() => buildManifest(options), /asset name/i);
});
