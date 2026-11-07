// Server mode: PhotoCull's backend as a self-hosted web app. Everything here
// is configured through environment variables (see docs/server.md).
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { RAW, SUPPORTED } = require('./library.cjs');
const { mapLimit } = require('./queue.cjs');

const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const naturally = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// "Photos=/photos;Uploads=/uploads" or just "/photos".
function parseRoots(value) {
  const roots = [];
  for (const entry of String(value || '').split(/[;\n]/).map(s => s.trim()).filter(Boolean)) {
    const at = entry.indexOf('=');
    const folder = at > 0 && !entry.startsWith('/') ? entry.slice(at + 1).trim() : entry;
    const name = at > 0 && !entry.startsWith('/') ? entry.slice(0, at).trim() : path.basename(folder) || 'Photos';
    if (!path.isAbsolute(folder)) throw new Error(`PHOTOCULL_ROOTS: "${folder}" is not an absolute path.`);
    if (!/^[\w .-]+$/.test(name) || name.startsWith('.')) throw new Error(`PHOTOCULL_ROOTS: "${name}" is not a usable name (letters, digits, space, . _ -).`);
    if (roots.some(r => r.name.toLowerCase() === name.toLowerCase())) throw new Error(`PHOTOCULL_ROOTS: the name "${name}" is used twice.`);
    roots.push({ name, path: path.resolve(folder) });
  }
  if (!roots.length) throw new Error('Set PHOTOCULL_ROOTS to the photo folder(s) the server may browse.');
  return roots;
}

function serverConfig(env = process.env) {
  const number = (name, fallback) => {
    if (env[name] === undefined || env[name] === '') return fallback;
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number.`);
    return value;
  };
  const cacheGB = number('PHOTOCULL_PREVIEW_CACHE_GB', null);
  if (cacheGB !== null && ![1, 2, 5, 10].includes(cacheGB)) throw new Error('PHOTOCULL_PREVIEW_CACHE_GB must be 1, 2, 5 or 10.');
  return {
    roots: parseRoots(env.PHOTOCULL_ROOTS),
    trash: env.PHOTOCULL_TRASH ? path.resolve(env.PHOTOCULL_TRASH) : null,
    trashDays: number('PHOTOCULL_TRASH_DAYS', 30),
    host: env.PHOTOCULL_HOST || '0.0.0.0',
    port: number('PHOTOCULL_PORT', 8080),
    password: env.PHOTOCULL_PASSWORD || null,
    hostnames: String(env.PHOTOCULL_HOSTNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    previewCacheGB: cacheGB,
  };
}

class FolderRoots {
  constructor(roots) { this.configured = roots; this.roots = []; }
  async init() {
    for (const root of this.configured) {
      const real = await fs.realpath(root.path).catch(() => { throw new Error(`Photo folder ${root.path} (${root.name}) does not exist.`); });
      if (!(await fs.stat(real)).isDirectory()) throw new Error(`Photo folder ${root.path} is not a folder.`);
      this.roots.push({ name: root.name, path: real });
    }
  }
  rootOf(file) { return this.roots.find(r => inside(r.path, file)) || null; }
  // Real path of a folder inside a root; symlinks out of the roots are refused.
  async resolve(folder) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose a folder in the photo library.');
    const real = await fs.realpath(folder).catch(() => { throw new Error('That folder no longer exists.'); });
    if (!this.rootOf(real)) throw new Error('That folder is outside the photo library.');
    if (!(await fs.stat(real)).isDirectory()) throw new Error('Choose a folder.');
    return real;
  }
  async listing(folder) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort(naturally.compare);
    const files = entries.filter(e => e.isFile() && SUPPORTED.has(path.extname(e.name).toLowerCase())).map(e => e.name);
    // A RAW + JPEG pair is one photo.
    const raws = new Set(files.filter(f => RAW.has(path.extname(f).toLowerCase())).map(f => path.parse(f).name.toLowerCase()));
    const photos = files.filter(f => RAW.has(path.extname(f).toLowerCase()) || !raws.has(path.parse(f).name.toLowerCase())).length;
    return { folders, photos };
  }
  async browse(folder) {
    if (!folder) {
      return { path: null, name: 'Library', parent: null, crumbs: [], photos: 0,
        folders: await mapLimit(this.roots, 4, async r => ({ name: r.name, path: r.path, photos: (await this.listing(r.path).catch(() => ({ photos: 0 }))).photos })) };
    }
    const real = await this.resolve(folder), root = this.rootOf(real);
    const { folders, photos } = await this.listing(real);
    const children = await mapLimit(folders, 8, async name => {
      const child = path.join(real, name);
      const info = await this.listing(child).catch(() => ({ photos: 0, folders: [] }));
      return { name, path: child, photos: info.photos, subfolders: info.folders.length };
    });
    const crumbs = [{ name: root.name, path: root.path }];
    for (const part of path.relative(root.path, real).split(path.sep).filter(Boolean)) crumbs.push({ name: part, path: path.join(crumbs.at(-1).path, part) });
    return { path: real, name: crumbs.at(-1).name, parent: real === root.path ? null : path.dirname(real), crumbs, photos, folders: children };
  }
}

// DNS rebinding: a hostile page can only reach this server under its own
// domain name, so accept IP addresses, localhost and configured names only.
function allowedHost(header, hostnames = []) {
  if (!header) return false;
  let host = header.toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.replace(/:\d+$/, '');
  return net.isIP(host) !== 0 || host === 'localhost' || hostnames.includes(host);
}

async function createAuth({ password, dataDir }) {
  if (!password) return { required: false, valid: () => true, cookie: null, check: () => null };
  const file = path.join(dataDir, 'server-secret');
  let secret;
  try { secret = await fs.readFile(file, 'utf8'); } catch {
    secret = randomBytes(32).toString('hex');
    await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(file, secret, { mode: 0o600 });
  }
  // Changing the password signs every browser out.
  const value = createHmac('sha256', secret).update(password).digest('hex');
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
  return {
    required: true,
    valid: req => (req.headers.cookie || '').split(';').some(part => { const [k, v] = part.trim().split('='); return k === 'photocull' && same(v, value); }),
    cookie: `photocull=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
    check: given => same(given, password),
  };
}

const LOGIN_PAGE = failed => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PhotoCull</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f10;color:#e8e9ea;font:15px system-ui,sans-serif}
form{display:grid;gap:12px;width:min(320px,86vw)}input,button{font:inherit;padding:11px 12px;border-radius:8px;border:1px solid #3f4246;background:#1b1c1e;color:inherit}
button{background:#e6e3da;color:#1d1e1f;border:0;font-weight:600}p{margin:0;color:#e39a97}</style></head><body><form method="post" action="/login">
<strong>PhotoCull</strong><input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" aria-label="Password">
${failed ? '<p>Wrong password.</p>' : ''}<button>Sign in</button></form></body></html>`;

module.exports = { parseRoots, serverConfig, FolderRoots, allowedHost, createAuth, LOGIN_PAGE, inside };
