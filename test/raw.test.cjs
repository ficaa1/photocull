const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { PreviewService } = require('../src/previews.cjs');
const { RawRenderCache } = require('../src/raw-cache.cjs');
const { renderRaw } = require('../src/raw-decoder.cjs');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-raw-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.ARW'); await fs.writeFile(file, 'fixture');
  const stat = await fs.stat(file);
  return { dir, cache: path.join(dir, 'cache'), item: { id: 'test', path: file, raw: true, size: stat.size, mtimeMs: stat.mtimeMs, fingerprint: `${stat.size}:${stat.mtimeMs}` } };
}
const picture = (width, height, format = 'jpeg') => sharp({ create: { width, height, channels: 3, background: '#487558' } })[format]().toBuffer();
function extractor(images = {}) {
  return { calls: [], async readRaw() { return { ImageWidth: 6000, ImageHeight: 4000, Orientation: 1, ...Object.fromEntries(Object.keys(images).map(k => [k, '(Binary data)'])) }; },
    async extractBinaryTagToBuffer(tag) { this.calls.push(tag); if (!images[tag]) throw new Error('No binary tag'); return images[tag]; }, async end() {} };
}
function fakeRender(counter) {
  return async (_file, output, { halfSize }) => {
    counter.count++; const width = halfSize ? 3000 : 6000, height = halfSize ? 2000 : 4000;
    await fs.writeFile(output, await picture(width, height)); return { width, height, orientation: 1 };
  };
}
function service(t, cache, options) { const p = new PreviewService(cache, options); t.after(() => p.close()); return p; }

test('multiple embedded JPEG/TIFF representations choose adequate sizes without rendering', async t => {
  const { cache, item } = await setup(t), count = { count: 0 };
  const exif = extractor({ ThumbnailTIFF: await picture(640, 480, 'tiff'), PreviewImage: await picture(3000, 2000), JpgFromRaw: await picture(6000, 4000) });
  const p = service(t, cache, { exif, render: fakeRender(count) });
  await p.get(item, 'thumb'); assert.equal(p.info(item, 'thumb').tag, 'ThumbnailTIFF');
  await p.get(item, 'preview'); assert.equal(p.info(item).tag, 'JpgFromRaw');
  await p.get(item, 'full'); assert.equal(p.info(item, 'full').width, 6000);
  assert.equal(count.count, 0);
  assert.equal(exif.calls.filter(tag => tag === 'ThumbnailTIFF').length, 1);
});

test('render gate, small-preview upgrade, full-size rendering, and cached renders across restart', async t => {
  const { cache, item } = await setup(t), count = { count: 0 }, small = await picture(640, 480);
  const p = service(t, cache, { exif: extractor({ ThumbnailImage: small }), render: fakeRender(count) });
  await p.get(item, 'preview'); assert.equal(count.count, 0); assert.ok(p.info(item).limited);
  p.setPolicy('small');
  await p.get(item, 'thumb'); assert.equal(count.count, 0, 'thumbnail remains a fast stand-in');
  await p.get(item, 'preview'); assert.equal(count.count, 1); assert.equal(p.info(item).type, 'rendered');
  await p.get(item, 'full'); assert.equal(count.count, 2); assert.equal(p.info(item, 'full').precision, 'full');
  // Remove only derived preview, to force the new process to use the persistent RAW render.
  await fs.rm(path.join(cache, p.key(item, 'preview') + '.jpg'));
  const fresh = service(t, cache, { rendering: 'small', exif: extractor(), render: () => assert.fail('Render cache was ignored') });
  await fresh.get(item, 'preview'); assert.ok(fresh.info(item).cached); assert.equal(fresh.info(item).precision, 'full');
  fresh.setPolicy('off');
  await fresh.get(item, 'preview'); assert.equal(fresh.info(item).type, 'embedded');
});

test('missing previews render by default; off never uses a previously rendered result', async t => {
  const { cache, item } = await setup(t), count = { count: 0 };
  const p = service(t, cache, { exif: extractor(), render: fakeRender(count), rendering: 'off' });
  await assert.rejects(p.get(item, 'preview'), /Enable RAW rendering/); assert.equal(count.count, 0);
  p.setPolicy('missing'); await p.get(item, 'preview'); assert.equal(count.count, 1);
  p.setPolicy('off'); await assert.rejects(p.get(item, 'full'), /Enable RAW rendering/);
});

test('blacklist survives restart, explicit retry recovers, and source changes have a new identity', async t => {
  const { cache, item } = await setup(t); let attempts = 0;
  const broken = async () => { attempts++; throw Object.assign(new Error('Unsupported sensor'), { code: 'RAW_DECODE_FAILED' }); };
  const first = new RawRenderCache(cache, { render: broken }); t.after(() => first.close());
  await assert.rejects(first.get(item), /Unsupported/);
  const second = new RawRenderCache(cache, { render: broken }); t.after(() => second.close());
  await assert.rejects(second.get(item), e => e.blocked); assert.equal(attempts, 1);
  await assert.rejects(second.get({ ...item, fingerprint: 'changed' }), /Unsupported/); assert.equal(attempts, 2);
  await second.retry(item);
  second.render = fakeRender({ count: 0 });
  await second.get(item); assert.equal(await second.failure(item), null);
});

test('timeout cools down, storage errors do not blacklist, and duplicate renders share one worker', async t => {
  const { cache, item } = await setup(t);
  const p = new RawRenderCache(cache, { render: async () => { throw Object.assign(new Error('timeout'), { code: 'RENDER_TIMEOUT' }); } }); t.after(() => p.close());
  await assert.rejects(p.get(item), /timeout/);
  assert.ok((await p.failure(item)).retryAfter > Date.now());
  await p.retry(item);
  p.render = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(p.get(item), /disk full/); assert.equal(await p.failure(item), null);
  const count = { count: 0 }; p.render = fakeRender(count);
  await Promise.all([p.get(item), p.get(item), p.get(item)]); assert.equal(count.count, 1);
});

test('broken rendered cache regenerates once; broken larger embedded image falls back to TIFF', async t => {
  const { cache, item } = await setup(t), count = { count: 0 };
  const p = service(t, cache, { exif: extractor(), render: fakeRender(count) });
  const result = await p.renders.get(item); await fs.writeFile(result.file, 'broken');
  await p.get(item, 'preview'); assert.equal(count.count, 2); assert.equal(p.info(item).type, 'rendered');
  const other = service(t, path.join(cache, 'other'), { rendering: 'off', exif: extractor({ JpgFromRaw: Buffer.from('broken'), ThumbnailTIFF: await picture(800, 600, 'tiff') }) });
  await other.get(item, 'preview'); assert.equal(other.info(item).tag, 'ThumbnailTIFF');
});

test('failed upgrade preserves embedded preview and retry invalidates its derived cache', async t => {
  const { cache, item } = await setup(t);
  const p = service(t, cache, { rendering: 'small', exif: extractor({ ThumbnailImage: await picture(640, 480) }),
    render: async () => { throw Object.assign(new Error('decode failure'), { code: 'RAW_DECODE_FAILED' }); } });
  await p.get(item, 'preview'); assert.equal(p.info(item).type, 'embedded'); assert.ok(p.info(item).renderError);
  await p.retry(item); p.renders.render = fakeRender({ count: 0 });
  await p.get(item, 'preview'); assert.equal(p.info(item).type, 'rendered');
});

test('close aborts active heavy work and cancels pending renders without blacklisting', async t => {
  const { cache, item } = await setup(t); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const p = new RawRenderCache(cache, { render: (_f, _o, { signal }) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'CANCELED' })));
  }) });
  const active = assert.rejects(p.get(item), /canceled/); await ready;
  const pending = assert.rejects(p.get({ ...item, id: 'other', fingerprint: 'other' }), /closing|superseded/);
  await p.close(); await Promise.all([active, pending]); assert.equal(await p.failure(item), null);
});

test('LibRaw worker enforces cancellation and timeout', async t => {
  const { dir, item } = await setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(renderRaw(item.path, path.join(dir, 'out.jpg'), { signal: controller.signal }), e => e.code === 'CANCELED');
  await assert.rejects(renderRaw(item.path, path.join(dir, 'out.jpg'), { timeoutMs: 1 }), e => e.code === 'RENDER_TIMEOUT');
});

const real = process.env.PHOTOCULL_RAW_CASES;
test('real Sony RAW with zeroed JPEG payloads renders from intact sensor data', { skip: !real, timeout: 120000 }, async t => {
  const { cache } = await setup(t);
  const { Library } = require('../src/library.cjs');
  const lib = new Library(path.join(cache, 'state'));
  const session = await lib.scan(path.join(real, 'no-previews'));
  const item = lib.item(session.id, session.items[0].id);
  const before = await fs.readFile(item.path);
  const p = service(t, cache, { rendering: 'off' });
  await assert.rejects(p.get(item, 'preview'), /Enable RAW rendering/);
  p.setPolicy('missing');
  const result = await p.get(item, 'preview'); assert.equal(p.info(item).type, 'rendered');
  assert.equal((await sharp(result).metadata()).width, 2560);
  const full = await p.get(item, 'full'); assert.ok((await sharp(full).metadata()).width > 6000);
  assert.deepEqual(await fs.readFile(item.path), before);
});
