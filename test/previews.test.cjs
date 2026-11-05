const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { PreviewService, orient } = require('../src/previews.cjs');
const { Library } = require('../src/library.cjs');
const { PriorityQueue } = require('../src/queue.cjs');
const { fixtures } = require('../scripts/fixtures.cjs');

test('16-bit ICC TIFF previews retain sRGB colours at every size, including Dehancer edits', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-preview-colour-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const colors = [[114,175,203], [17,50,72], [147,185,199]];
  const pixels = Buffer.alloc(300 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 300; x++) {
    pixels.set(colors[Math.floor(x / 100)], (y * 300 + x) * 3);
  }
  const file = path.join(root, 'edit.tif');
  await sharp(pixels, { raw: { width: 300, height: 100, channels: 3 } })
    .withIccProfile('srgb').toColourspace('rgb16').tiff({ compression: 'none' }).toFile(file);
  assert.equal((await sharp(file).metadata()).bitsPerSample, 16);
  const original = await fs.readFile(file);
  // Remove only the ICC tag from this generated little-endian TIFF, retaining
  // 16-bit source samples to exercise the untagged-sRGB fallback too.
  const untagged = Buffer.from(original), ifd = untagged.readUInt32LE(4);
  for (let i = 0; i < untagged.readUInt16LE(ifd); i++) {
    const offset = ifd + 2 + i * 12;
    if (untagged.readUInt16LE(offset) === 34675) untagged.writeUInt16LE(65000, offset);
  }
  const plainFile = path.join(root, 'untagged.tif'); await fs.writeFile(plainFile, untagged);
  assert.equal((await sharp(plainFile).metadata()).hasProfile, false);
  const p3File = path.join(root, 'p3.tif');
  await sharp(pixels, { raw: { width: 300, height: 100, channels: 3 } })
    .withIccProfile('p3').toColourspace('rgb16').tiff({ compression: 'none' }).toFile(p3File);
  const previews = new PreviewService(path.join(root, 'cache'));
  t.after(() => previews.close());
  const direct = { id: 'tiff', path: file, fingerprint: 'one', raw: false };
  const edited = { id: 'raw', path: path.join(root, 'photo.ARW'), fingerprint: 'two', raw: true,
    develop: { edited: true, tiff: file } };
  const plain = { ...direct, id: 'untagged', path: plainFile };
  const p3 = { ...direct, id: 'p3', path: p3File };
  for (const item of [direct, edited, plain, p3]) for (const kind of ['thumb', 'preview', 'full']) {
    const bytes = await previews.get(item, kind);
    assert.ok((await sharp(bytes).metadata()).hasProfile, `${kind} must identify its source colour space`);
    const rgb = await sharp(bytes).raw().toBuffer();
    for (let patch = 0; patch < colors.length; patch++) {
      const offset = (50 * 300 + patch * 100 + 50) * 3;
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(rgb[offset + c] - colors[patch][c]) <= 3,
        `${item.id}/${kind}: patch ${patch}, channel ${c}: ${rgb[offset + c]} vs ${colors[patch][c]}`);
    }
  }
  assert.deepEqual(await fs.readFile(file), original);
});

test('visible work jumps ahead of prefetch, and duplicate work shares one promise', async () => {
  const queue = new PriorityQueue(1), order = [];
  let unblock;
  const first = queue.add('first', 1, () => new Promise(resolve => { unblock = resolve; }));
  await Promise.resolve();
  const low = queue.add('prefetch', 1, () => order.push('prefetch'));
  const high = queue.add('visible', 100, () => order.push('visible'));
  assert.equal(queue.add('visible', 10, () => assert.fail('Duplicated job ran')), high);
  unblock(); await Promise.all([first, low, high]);
  assert.deepEqual(order, ['visible', 'prefetch']);
});

test('stale pending work is canceled while the active job can finish', async () => {
  const queue = new PriorityQueue(1);
  let finish;
  const active = queue.add('active', 10, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  const stale = queue.add('stale', 1, () => assert.fail('Canceled preview ran'));
  const rejection = assert.rejects(stale, /superseded/);
  queue.cancelWhere(job => job.key === 'stale');
  finish(); await Promise.all([active, rejection]);
});

test('all eight RAW orientation transforms agree with EXIF auto-orientation', async () => {
  const width = 80, height = 60;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const n = (y * width + x) * 3;
    rgb[n] = x < width / 2 ? 210 : 30;
    rgb[n + 1] = y < height / 2 ? 210 : 30;
    rgb[n + 2] = x < width / 2 ? 25 : 140;
  }
  const input = await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
  for (let orientation = 1; orientation <= 8; orientation++) {
    const tagged = await sharp(input).withMetadata({ orientation }).png().toBuffer();
    const expected = await sharp(tagged).autoOrient().raw().toBuffer({ resolveWithObject: true });
    const actual = await orient(sharp(input), orientation).raw().toBuffer({ resolveWithObject: true });
    assert.equal(actual.info.width, expected.info.width, `Orientation ${orientation} width`);
    assert.equal(actual.info.height, expected.info.height, `Orientation ${orientation} height`);
    assert.deepEqual(actual.data, expected.data, `Orientation ${orientation} pixels`);
  }
});

test('preview pipeline orients JPEGs, reuses memory/disk, and invalidates edited sources', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fixtures(path.join(root, 'photos'), 3);
  const library = new Library(path.join(root, 'state')), s = await library.scan(path.join(root, 'photos'));
  const cache = path.join(root, 'cache');
  const previews = new PreviewService(cache);
  t.after(() => previews.close());
  const item = library.item(s.id, s.items[2].id);
  const thumb = await previews.get(item, 'thumb');
  const meta = await sharp(thumb).metadata();
  assert.equal(meta.height, 400); assert.equal(meta.width, 267);
  assert.equal(previews.stats.generated, 1);
  assert.deepEqual(await previews.get(item, 'thumb'), thumb);
  assert.equal(previews.stats.memoryHits, 1);
  const fresh = new PreviewService(cache); t.after(() => fresh.close());
  assert.deepEqual(await fresh.get(item, 'thumb'), thumb);
  assert.equal(fresh.stats.diskHits, 1);
  assert.notEqual(previews.key(item, 'thumb'), previews.key({ ...item, fingerprint: 'changed' }, 'thumb'));
  const full = await previews.get(item, 'full');
  const fullMeta = await sharp(full).metadata();
  assert.equal(fullMeta.width, 1200); assert.equal(fullMeta.height, 1800);
});

test('real camera RAW uses an embedded JPEG without touching source bytes', { skip: !process.env.PHOTOCULL_RAW_FIXTURE }, async t => {
  const { createHash } = require('node:crypto');
  const fixture = path.resolve(process.env.PHOTOCULL_RAW_FIXTURE);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-raw-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sum = async () => createHash('sha256').update(await fs.readFile(fixture)).digest('hex');
  const before = await sum(), stat = await fs.stat(fixture);
  const item = { path: fixture, id: 'real-raw', raw: true, fingerprint: `${stat.size}:${stat.mtimeMs}` };
  const previews = new PreviewService(path.join(root, 'cache')); t.after(() => previews.close());
  const result = await previews.get(item, 'preview', 100);
  const info = await sharp(result).metadata();
  assert.ok(info.width > 500 && info.height > 500);
  assert.match(previews.sourceInfo.get(item.id).source, /^Embedded /);
  assert.equal(await sum(), before);
});

test('validated RAW ranges avoid an extraction subprocess; invalid offsets retain ExifTool fallback', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-ranges-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bytes=await sharp({create:{width:800,height:600,channels:3,background:'#628c70'}}).jpeg().toBuffer();
  const file=path.join(root,'a.ARW');await fs.writeFile(file,Buffer.concat([Buffer.alloc(128),bytes]));
  let calls=0;const exif={async readRaw(){return {JpgFromRaw:'binary',JpgFromRawStart:128,JpgFromRawLength:bytes.length,ImageWidth:800,ImageHeight:600};},async extractBinaryTagToBuffer(){calls++;return bytes;},async end(){}};
  const item={id:'range',path:file,fingerprint:'one',raw:true};
  const fast=new PreviewService(path.join(root,'fast'),{exif});t.after(()=>fast.close());await fast.get(item,'preview');assert.equal(calls,0);assert.equal(fast.stats.directExtractions,1);
  const fallback=new PreviewService(path.join(root,'fallback'),{exif:{...exif,async readRaw(){return{JpgFromRaw:'binary',JpgFromRawStart:1,JpgFromRawLength:bytes.length};}}});t.after(()=>fallback.close());await fallback.get(item,'preview');assert.equal(calls,1);
});

test('the disk cache prunes least recently used previews, honours its limit and can be cleared', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fixtures(path.join(root, 'photos'), 3);
  const library = new Library(path.join(root, 'state')), s = await library.scan(path.join(root, 'photos'));
  const cache = path.join(root, 'cache'), items = s.items.map(i => library.item(s.id, i.id));
  const first = new PreviewService(cache); t.after(() => first.close());
  for (const item of items) await first.get(item, 'thumb');
  const files = item => [first.key(item, 'thumb') + '.jpg', first.key(item, 'thumb') + '.jpg.json'].map(name => path.join(cache, name));
  // Everything was made an hour ago, the oldest first.
  for (const [index, item] of items.entries()) {
    const then = new Date(Date.now() - 3600_000 + index * 1000);
    for (const file of files(item)) await fs.utimes(file, then, then);
  }
  // Reading the oldest preview from disk marks it as used.
  const second = new PreviewService(cache); t.after(() => second.close());
  await second.get(items[0], 'thumb'); await new Promise(resolve => setTimeout(resolve, 50));
  const sizes = await Promise.all(items.map(async item => (await Promise.all(files(item).map(f => fs.stat(f)))).reduce((n, st) => n + st.size, 0)));
  await second.setDiskLimit(sizes[0] + 1);
  const exists = file => fs.access(file).then(() => true, () => false);
  assert.deepEqual(await Promise.all(files(items[0]).map(exists)), [true, true], 'the recently used preview is kept');
  assert.deepEqual(await Promise.all([...files(items[1]), ...files(items[2])].map(exists)), [false, false, false, false]);
  assert.equal((await second.diskUsage()).limit, sizes[0] + 1);
  await assert.rejects(second.setDiskLimit(0), /Invalid preview cache size/);
  const cleared = await second.clearDisk();
  assert.ok(cleared.freed >= sizes[0]); assert.equal(cleared.bytes, 0);
  assert.equal((await second.get(items[0], 'thumb')).length > 0, true, 'previews regenerate after clearing');
});

test('loupe support: real oriented sizes, cached-only peeks and untouched full-size JPEGs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-loupe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fixtures(path.join(root, 'photos'), 3);
  const library = new Library(path.join(root, 'state')), s = await library.scan(path.join(root, 'photos'));
  const previews = new PreviewService(path.join(root, 'cache')); t.after(() => previews.close());
  const [upright, , rotated] = s.items.map(i => library.item(s.id, i.id));
  assert.deepEqual(await previews.dimensions(upright), { width: 1800, height: 1200 });
  assert.deepEqual(await previews.dimensions(rotated), { width: 1200, height: 1800 }, 'EXIF orientation 6 swaps the axes');
  // peek never generates anything.
  assert.equal(await previews.peek(upright, 'preview'), null);
  assert.equal(previews.stats.generated, 0);
  const generated = await previews.get(upright, 'preview');
  assert.deepEqual(await previews.peek(upright, 'preview'), generated);
  const fresh = new PreviewService(path.join(root, 'cache')); t.after(() => fresh.close());
  assert.deepEqual(await fresh.peek(upright, 'preview'), generated, 'peek reads the disk cache');
  assert.equal(fresh.status(upright, 'preview').info.type, 'original');
  // An upright JPEG is served byte for byte at full size; a rotated one is re-encoded upright.
  assert.deepEqual(await previews.get(upright, 'full'), await fs.readFile(upright.path));
  const turned = await sharp(await previews.get(rotated, 'full')).metadata();
  assert.deepEqual([turned.width, turned.height, turned.orientation ?? 1], [1200, 1800, 1]);
});

test('a RAW full-size request passes the upright embedded JPEG through and reports the RAW size', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-loupe-raw-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#628c70' } }).jpeg().toBuffer();
  const file = path.join(root, 'a.ARW'); await fs.writeFile(file, Buffer.concat([Buffer.alloc(64), bytes]));
  const tags = orientation => ({ JpgFromRaw: 'binary', JpgFromRawStart: 64, JpgFromRawLength: bytes.length, ExifImageWidth: 6000, ExifImageHeight: 4000, Orientation: orientation });
  const service = orientation => new PreviewService(path.join(root, `cache-${orientation}`), { exif: { async readRaw() { return tags(orientation); }, async extractBinaryTagToBuffer() { return bytes; }, async end() {} } });
  const upright = service(1); t.after(() => upright.close());
  const item = { id: 'raw', path: file, fingerprint: 'one', raw: true };
  assert.deepEqual(await upright.dimensions(item), { width: 6000, height: 4000 });
  assert.deepEqual(await upright.get(item, 'full'), bytes, 'served without re-encoding');
  assert.equal(upright.info(item, 'full').type, 'embedded');
  const portrait = service(6); t.after(() => portrait.close());
  assert.deepEqual(await portrait.dimensions(item), { width: 4000, height: 6000 });
  const turned = await sharp(await portrait.get(item, 'full')).metadata();
  assert.deepEqual([turned.width, turned.height], [1000, 1600], 'RAW orientation is still applied');
});

test('Dehancer TIFF pixels serve all cached sizes and zoom; originals stay available and saves invalidate', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-dehancer-preview-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'original.jpg'),tiff=path.join(dir,'edit.tif'),cache=path.join(dir,'cache');
  const make=(file,color)=>sharp({create:{width:800,height:600,channels:3,background:color}})[file.endsWith('tif')?'tiff':'jpeg']().toFile(file);
  await make(source,'#00ff00');await make(tiff,'#ff0000');
  const originalBytes=await fs.readFile(source);
  const item={id:'photo',path:source,fingerprint:'source',raw:true,develop:{tiff,edited:true}},events=[];
  const service=new PreviewService(cache,{onState:s=>events.push(s),exif:{end:async()=>{}}});t.after(()=>service.close());
  const pixel=async bytes=>[...(await sharp(bytes).resize(1,1).raw().toBuffer())].slice(0,3);
  for(const kind of ['thumb','preview','full']) {
    const bytes=await service.get(item,kind);const rgb=await pixel(bytes);assert.ok(rgb[0]>240 && rgb[1]<10);
    assert.deepEqual(await service.peek(item,kind),bytes);assert.match(service.info(item,kind).source,/Dehancer/);
  }
  assert.equal(service.stats.generated,3);assert.deepEqual(await service.dimensions(item),{width:800,height:600});
  await service.get(item,'thumb');assert.equal(service.stats.generated,3);
  const reopened=new PreviewService(cache,{exif:{end:async()=>{}}});t.after(()=>reopened.close());await reopened.get(item,'thumb');assert.equal(reopened.stats.diskHits,1);
  const original=await service.get({...item,raw:false,develop:null},'preview');const green=await pixel(original);assert.ok(green[1]>240 && green[0]<10);
  await make(tiff,'#0000ff');service.invalidatePhoto(item);assert.equal(events.at(-1).state,'invalidated');assert.equal(await service.peek(item,'thumb'),null);
  const blue=await pixel(await service.get(item,'thumb'));assert.ok(blue[2]>240 && blue[0]<10);
  assert.deepEqual(await fs.readFile(source),originalBytes);
});
