const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseRoots, FolderRoots, allowedHost } = require('../src/server.cjs');
const { ServerTrash } = require('../src/server-trash.cjs');
const { measure } = require('../src/sharpness.cjs');
const { PrepareJobs } = require('../src/prepare.cjs');
const { CullingService } = require('../src/culling.cjs');
const { PreviewService } = require('../src/previews.cjs');
const { Library } = require('../src/library.cjs');
const { fixtures } = require('../scripts/fixtures.cjs');

async function tempDir(t, name) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `photocull-${name}-`)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('photo roots come from PHOTOCULL_ROOTS as named or bare absolute paths', () => {
  assert.deepEqual(parseRoots('Photos=/srv/photos; /mnt/uploads'), [{ name: 'Photos', path: path.resolve('/srv/photos') }, { name: 'uploads', path: path.resolve('/mnt/uploads') }]);
  assert.throws(() => parseRoots(''), /PHOTOCULL_ROOTS/);
  assert.throws(() => parseRoots('Photos=relative/path'), /absolute/);
  assert.throws(() => parseRoots('A=/a;a=/b'), /used twice/);
});

test('the folder browser lists folders and photos inside the roots only', async t => {
  const root = await tempDir(t, 'roots');
  const library = path.join(root, 'Photos'), outside = path.join(root, 'private');
  await fs.mkdir(path.join(library, 'Trip', 'day 1'), { recursive: true }); await fs.mkdir(path.join(library, '.hidden')); await fs.mkdir(outside);
  for (const name of ['DSC1.ARW', 'DSC1.JPG', 'DSC2.JPG', 'notes.txt']) await fs.writeFile(path.join(library, 'Trip', name), 'x');
  await fs.symlink(outside, path.join(library, 'escape'));
  const roots = new FolderRoots([{ name: 'Photos', path: library }]); await roots.init();

  const top = await roots.browse(library);
  assert.deepEqual(top.folders.map(f => f.name), ['Trip'], 'hidden folders and symlinks are not listed');
  assert.equal(top.folders[0].photos, 2, 'a RAW + JPEG pair counts once');
  const trip = await roots.browse(path.join(library, 'Trip'));
  assert.deepEqual(trip.crumbs.map(c => c.name), ['Photos', 'Trip']);
  assert.equal(trip.parent, library);
  await assert.rejects(roots.browse(outside), /outside the photo library/);
  await assert.rejects(roots.resolve(path.join(library, 'escape')), /outside the photo library/);
  await assert.rejects(roots.resolve(path.join(library, 'Trip', '..', '..', 'private')), /outside the photo library/);
});

test('only IP addresses, localhost and configured names may reach the server', () => {
  assert.ok(allowedHost('192.168.1.162:8787'));
  assert.ok(allowedHost('[::1]:8787'));
  assert.ok(allowedHost('localhost:8787'));
  assert.ok(allowedHost('cull.lan', ['cull.lan']));
  assert.ok(!allowedHost('attacker.example:8787'));
  assert.ok(!allowedHost(undefined));
});

test('the server trash keeps the path inside its root, never overwrites, and purges old days', async t => {
  const root = await tempDir(t, 'trash');
  const library = path.join(root, 'Photos'), folder = path.join(library, 'Trip');
  await fs.mkdir(folder, { recursive: true });
  const roots = new FolderRoots([{ name: 'Photos', path: library }]); await roots.init();
  const trash = new ServerTrash({ dir: path.join(root, '.trash'), roots, days: 30 }); await trash.init();
  const now = new Date(2026, 10, 7, 12);

  await fs.writeFile(path.join(folder, 'DSC1.ARW'), 'first');
  const first = await trash.move(path.join(folder, 'DSC1.ARW'), now);
  assert.equal(first, path.join(trash.dir, '2026-11-07', 'Photos', 'Trip', 'DSC1.ARW'));
  await fs.writeFile(path.join(folder, 'DSC1.ARW'), 'second');
  const second = await trash.move(path.join(folder, 'DSC1.ARW'), now);
  assert.equal(path.basename(second), 'DSC1 (2).ARW');
  assert.equal(await fs.readFile(first, 'utf8'), 'first');
  await assert.rejects(fs.stat(path.join(folder, 'DSC1.ARW')), { code: 'ENOENT' });
  const log = (await fs.readFile(path.join(trash.dir, '2026-11-07', 'photocull-trash.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map(entry => entry.to), [first, second]);
  await assert.rejects(trash.move(path.join(root, 'elsewhere.jpg'), now), /Only photos in the library/);

  await fs.mkdir(path.join(trash.dir, '2026-10-01')); await fs.mkdir(path.join(trash.dir, 'keep-me'));
  assert.deepEqual(await trash.purge(now), ['2026-10-01']);
  assert.deepEqual((await fs.readdir(trash.dir)).sort(), ['2026-11-07', 'keep-me']);
});

test('focus scores rank sharp detail above blur and weight the focus point', () => {
  const pattern = (w, h, at) => { const data = Buffer.alloc(w * h * 3, 128); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (at(x, y)) data.fill((x + y) % 2 ? 240 : 20, (y * w + x) * 3, (y * w + x) * 3 + 3); return data; };
  const [w, h] = [96, 64];
  const sharp = pattern(w, h, () => true);
  const blurred = Buffer.from(sharp);
  for (let pass = 0; pass < 6; pass++) {
    const old = Buffer.from(blurred);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 3, v = Math.floor((old[i] + old[i - 3] + old[i + 3] + old[i - w * 3] + old[i + w * 3]) / 5);
      blurred.fill(v, i, i + 3);
    }
  }
  assert.ok(measure(w, h, sharp, 3) > measure(w, h, blurred, 3) * 4);
  assert.equal(measure(w, h, Buffer.alloc(w * h * 3, 128), 3), 0);
  const centre = pattern(100, 100, (x, y) => x >= 43 && x < 57 && y >= 43 && y < 57);
  assert.ok(measure(100, 100, centre, 3, { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }) > measure(100, 100, centre, 3) * 2);
  assert.throws(() => measure(1, 1, Buffer.alloc(3), 3), /too small/);
});

test('server sessions stay open per folder and keep their id when the folder is reopened', async t => {
  const root = await tempDir(t, 'sessions');
  const a = await fixtures(path.join(root, 'a'), 2), b = await fixtures(path.join(root, 'b'), 2);
  const library = new Library(path.join(root, 'data'), { keepSessions: 8 });
  const first = await library.scan(a), other = await library.scan(b);
  await library.decide(first.id, first.items[0].id, { flag: 'pick' });
  const again = await library.scan(a);
  assert.equal(again.id, first.id);
  assert.equal(again.items[0].flag, 'pick', 'decisions made before the rescan are kept');
  assert.equal(library.get(other.id).folder, b, 'another folder stays open');
  await library.close();
});

test('preparing a folder makes thumbnails, previews and focus scores without a browser', async t => {
  const root = await tempDir(t, 'prepare');
  const folder = await fixtures(path.join(root, 'shoot'), 4);
  const library = new Library(path.join(root, 'data'), { keepSessions: 8 });
  const previews = new PreviewService(path.join(root, 'data', 'previews')); t.after(() => previews.close());
  const culling = new CullingService(library, previews, () => ({ burstGap: 1 }));
  const updates = [];
  const jobs = new PrepareJobs({ library, previews, culling, photo: (s, id) => library.item(s, id), onProgress: job => updates.push(job) });
  const session = await library.scan(folder);
  const started = jobs.start(session.id).started;
  assert.equal(jobs.start(session.id).started, started, 'starting again joins the job in progress');
  assert.equal(jobs.list().length, 1);
  while (!['done', 'failed'].includes(jobs.status(session.id).state)) await new Promise(resolve => setTimeout(resolve, 50));
  const done = jobs.status(session.id);
  assert.deepEqual({ state: done.state, thumbs: done.thumbs, ready: done.ready, failed: done.failed }, { state: 'done', thumbs: 4, ready: 4, failed: 0 });
  assert.equal(updates.at(-1).state, 'done');
  for (const { id } of session.items) {
    const item = library.item(session.id, id);
    assert.ok(await previews.peek(item, 'thumb'), 'thumbnail cached');
    assert.ok(await previews.peek(item, 'preview'), 'review preview cached');
    assert.equal(typeof (await culling.source(session.id, item.id)).score, 'number', 'focus score cached');
  }
  await library.close();
});
