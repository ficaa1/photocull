const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function decodeBase64(text, size) {
  const bytes = Buffer.from(text ?? '', 'base64');
  if (!text || bytes.toString('base64') !== text || (size && bytes.length !== size)) {
    throw new Error('Invalid minisign base64 or packet length.');
  }
  return bytes;
}

function packetLines(text) {
  return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(text)).split(/\r?\n/);
}

function verifyMinisign(payloadBytes, signatureText, pubkeyBase64) {
  const [, encodedKey] = packetLines(pubkeyBase64);
  const [, encodedSignature, comment, encodedGlobal] = packetLines(signatureText);
  const key = decodeBase64(encodedKey, 42), packet = decodeBase64(encodedSignature, 74);
  const algorithm = packet.toString('latin1', 0, 2);
  if (!['Ed', 'ED'].includes(key.toString('latin1', 0, 2)) || !['Ed', 'ED'].includes(algorithm)) {
    throw new Error('Unsupported minisign algorithm.');
  }
  if (!key.subarray(2, 10).equals(packet.subarray(2, 10))) throw new Error('Unexpected minisign key ID.');
  if (!comment?.startsWith('trusted comment: ')) throw new Error('Missing minisign trusted comment.');
  const publicKey = crypto.createPublicKey({
    format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: key.subarray(10).toString('base64url') },
  });
  const signature = packet.subarray(10);
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(payloadBytes).digest() : payloadBytes;
  if (!crypto.verify(null, message, publicKey, signature)) throw new Error('Invalid updater payload signature.');
  const trusted = comment.slice('trusted comment: '.length);
  if (!crypto.verify(null, Buffer.concat([signature, Buffer.from(trusted)]), publicKey, decodeBase64(encodedGlobal, 64))) {
    throw new Error('Invalid minisign trusted comment signature.');
  }
  return trusted;
}

function verifySignedVersion(comment, version, required) {
  const field = comment.split('\t').find(field => field.startsWith('version:'));
  if (field === undefined) {
    if (required) throw new Error('Missing signed version.');
    return;
  }
  if (field.slice('version:'.length).replace(/^v+/, '') !== version) throw new Error('Signed version differs from ' + version);
}

function* signatures(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* signatures(file);
    } else if (entry.isFile()) {
      const updater = platformFor(entry.name);
      if ((updater || entry.name.endsWith('.dmg')) && /[^A-Za-z0-9._-]/.test(entry.name)) {
        throw new Error('Unsafe release asset name: ' + entry.name);
      }
      if (updater && !fs.lstatSync(file + '.sig', { throwIfNoEntry: false })?.isFile()) {
        throw new Error('No signed updater for ' + file);
      }
      if (entry.name.endsWith('.sig') && platformFor(entry.name.slice(0, -4))) yield file;
    }
  }
}

function platformFor(relative) {
  if (relative.endsWith('.app.tar.gz')) {
    return /x64|x86_64/i.test(relative) ? 'darwin-x86_64' : 'darwin-aarch64';
  }
  if (relative.endsWith('-setup.exe')) return 'windows-x86_64-nsis';
  if (relative.endsWith('.msi')) return 'windows-x86_64-msi';
}

function buildManifest({ dir, tag, repo, config = 'src-tauri/tauri.conf.json', pubDate = new Date().toISOString(), notes = '' }) {
  const match = tagPattern.exec(tag);
  if (!match || tag !== match[0]
      || match.slice(1, 4).some(n => BigInt(n) > 0xffffffffffffffffn)
      || match[4]?.split('.').some(id => /^0\d+$/.test(id))) {
    throw new Error('Expected a v-prefixed semantic version for --tag.');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected owner/repository for --repo.');
  const version = tag.slice(1);
  const tauri = JSON.parse(fs.readFileSync(config, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(config), '../package.json'), 'utf8'));
  if (tauri.version !== version || pkg.version !== version) {
    throw new Error('Both package.json and the Tauri config must have version ' + version);
  }
  const platforms = {}, assetNames = new Set();
  for (const sig of signatures(dir)) {
    const file = sig.slice(0, -4), name = path.basename(file);
    const signature = fs.readFileSync(sig, 'utf8').trim();
    if (!signature) throw new Error('Empty signature: ' + sig);
    const payload = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!payload?.isFile() || !payload.size) throw new Error('Missing or empty updater payload: ' + file);

    const platform = platformFor(path.join(path.basename(path.resolve(dir)), path.relative(dir, file)));
    try {
      const { pubkey, requireSignedVersion } = tauri.plugins.updater;
      const comment = verifyMinisign(fs.readFileSync(file), signature, pubkey);
      verifySignedVersion(comment, version, requireSignedVersion);
    } catch (error) {
      throw new Error(name + ': ' + error.message);
    }
    if (assetNames.has(name)) throw new Error('Duplicate release asset name: ' + name);
    if (platforms[platform]) throw new Error('Multiple updater payloads for ' + platform);
    assetNames.add(name);
    platforms[platform] = { signature, url: 'https://github.com/' + repo + '/releases/download/' + tag + '/' + encodeURIComponent(name) };
  }
  if (!assetNames.size) throw new Error('No signed updater platforms found in ' + dir);
  const windows = platforms['windows-x86_64-nsis'] ?? platforms['windows-x86_64-msi'];
  if (windows) platforms['windows-x86_64'] = windows;
  return { version, notes, pub_date: pubDate, platforms };
}

module.exports = { buildManifest };

if (require.main === module) {
  try {
    const options = Object.fromEntries(['dir', 'tag', 'repo', 'out', 'config'].map(name => [name, { type: 'string' }]));
    options['verify-only'] = { type: 'boolean' };
    const { values } = parseArgs({ options });
    const required = ['dir', 'tag', 'repo'];
    if (!values['verify-only']) required.push('out');
    for (const name of required) {
      if (!values[name]) throw new Error('Missing --' + name);
    }
    const manifest = buildManifest(values);
    if (!values['verify-only']) fs.writeFileSync(values.out, JSON.stringify(manifest, null, 2) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
