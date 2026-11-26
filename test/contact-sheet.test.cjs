const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { exportContactSheet } = require('../src/contact-sheet.cjs');
const { layout } = require('../src/renderer/contact-sheet-layout.js');

test('sheet sizes use physical page dimensions and reject invalid or impossible layouts', () => {
  for (const [pageSize, width, height] of [['letter', 1275, 1650], ['a4', 1240, 1754], ['square', 1275, 1275], ['landscape16x9', 1350, 2400]]) {
    const portrait = layout({ pageSize }), landscape = layout({ pageSize, orientation: 'landscape' });
    assert.deepEqual([portrait.width, portrait.height, landscape.width, landscape.height], [width, height, height, width]);
  }
  for (const options of [null, [], { file: 'photo.jpg' }, { format: 'png' }, { scope: 'trash' }, { dpi: 151 }, { columns: 0 },
    { rows: 1.5 }, { gapMm: '5' }, { marginMm: 41 }, { jpegQuality: 99 }, { pageSize: 'A3' }, { orientation: 'auto' },
    { theme: 'blue' }, { headerTitle: 'a'.repeat(201) }, { captions: { rating: 1 } }, { captions: { path: true } },
    { rows: 10, columns: 8, marginMm: 40, gapMm: 20 }]) assert.throws(() => layout(options));
});

test('JPEG sheets preserve rotated image proportions and confine escaped text to its cell', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-pixels-'));
  t.after(() => fs.rm(folder, { recursive: true }));
  const rotated = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#f00000' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const item = { id: 'a', name: '<&>"\'' + 'X'.repeat(350), rating: 5, flag: 'pick' };
  const file = path.join(folder, 'proof.jpg');
  await exportContactSheet({ photos: [item], file,
    options: { format: 'jpeg', rows: 2, columns: 2, headerTitle: '"<&>\'', captions: { exif: true } },
    previews: { getForPresentation: async () => rotated, metadata: async () => ({ focalLength: '50 mm', aperture: 'f/2', iso: 200 }) },
    signal: new AbortController().signal });
  const info = await sharp(file).metadata();
  assert.deepEqual([info.format, info.width, info.height, info.density], ['jpeg', 1275, 1650, 150]);
  const { data, info: raster } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => data.subarray((y * raster.width + x) * raster.channels, (y * raster.width + x) * raster.channels + 3);
  const red = (x, y) => pixel(x, y)[0] > 200 && pixel(x, y)[1] < 30;
  assert.ok(red(345, 145) && red(345, 740), 'portrait reaches the top and bottom of the image area');
  assert.ok(!red(120, 400) && !red(570, 400), 'portrait is centered with paper on both sides');
  let captionInk = 0;
  for (let y = 780; y < 851; y++) for (let x = 70; x < 1220; x++) {
    if (pixel(x, y)[0] > 190) continue;
    assert.ok(x < 625, 'caption spills into the empty second column');
    captionInk++;
  }
  assert.ok(captionInk > 80, 'the caption is visible');
});

test('desktop sidecar exports scoped PDFs and JPEG siblings and rolls back collisions and cancellations', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-sidecar-')), photos = path.join(root, 'photos'), destination = path.join(root, 'sheets');
  await fs.mkdir(photos); await fs.mkdir(destination);
  const jpg = await sharp({ create: { width: 60, height: 90, channels: 3, background: 'red' } }).jpeg().toBuffer();
  for (const name of ['a&b.jpg', 'c.jpg', 'd.jpg']) await fs.writeFile(path.join(photos, name), jpg);
  const card = path.join(root, 'card'), devices = path.join(root, 'devices.json');
  await fs.mkdir(card); await fs.writeFile(devices, JSON.stringify([{ root: card, identity: 'camera-card' }]));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/backend.cjs')], { stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PHOTOCULL_SMOKE_TEST: '1', PHOTOCULL_TEST_DEVICES: devices, PHOTOCULL_DATA_DIR: path.join(root, 'data') } });
  const exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await exited; await fs.rm(root, { recursive: true }); });
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  async function next() { return JSON.parse((await lines.next()).value); }
  assert.ok((await next()).ready);
  let seq = 0;
  function send(method, params) { const id = ++seq; child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); return id; }
  async function reply(id, onProgress) {
    for (;;) {
      const msg = await next();
      if (msg.id === id) { if (!msg.ok) throw new Error(msg.error); return msg.value; }
      if (msg.event === 'contact-sheet-progress') onProgress?.(msg.payload);
    }
  }
  const session = await reply(send('scan', [photos, false]));
  const [first, second, third] = session.items;
  await reply(send('decide', [session.id, first.id, { flag: 'pick' }]));
  await reply(send('decide', [session.id, third.id, { trashed: true }]));
  const start = (name, options, ids = []) => send('export-contact-sheet', [session.id, ids, { columns: 1, rows: 1, ...options }, path.join(destination, name)]);
  const progress = [];
  const pdf = await reply(start('book.pdf', { scope: 'all', orientation: 'landscape' }), e => progress.push(e.done));
  assert.deepEqual([pdf.photos, pdf.pages, pdf.files], [2, 2, 1]); assert.deepEqual(progress, [0, 1, 2]);
  const bytes = await fs.readFile(path.join(destination, 'book.pdf')), text = bytes.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4')); assert.ok(text.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.ok(text.slice(startxref).startsWith('xref\n0 9\n0000000000 65535 f '));
  const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n /gm)];
  assert.equal(offsets.length, 8);
  offsets.forEach(([_, offset], i) => assert.ok(text.slice(+offset).startsWith((i + 1) + ' 0 obj\n')));
  assert.match(text, /\/Type \/Pages \/Count 2 \/Kids \[3 0 R 6 0 R\]/);
  const images = [...text.matchAll(/\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/g)];
  assert.equal(images.length, 2);
  assert.equal(text.match(/\/MediaBox \[0 0 792 612\]/g).length, 2);
  for (const match of images) {
    const start = match.index + match[0].length, length = Number(match[1]);
    const info = await sharp(bytes.subarray(start, start + length)).metadata();
    assert.deepEqual([info.format, info.width, info.height], ['jpeg', 1650, 1275]);
    assert.ok(text.slice(start + length).startsWith('\nendstream'));
  }
  const picks = await reply(start('picks.jpg', { format: 'jpeg', scope: 'picks' }));
  assert.deepEqual([picks.photos, picks.files], [1, 1]);
  const order = [second.id, first.id, first.id, third.id];
  const many = await reply(start('spread.jpg', { format: 'jpeg' }, order));
  assert.deepEqual([many.pages, many.files], [2, 2]);
  for (const name of ['picks.jpg', 'spread_p01.jpg', 'spread_p02.jpg']) assert.equal((await sharp(path.join(destination, name)).metadata()).format, 'jpeg');
  await fs.writeFile(path.join(destination, 'taken_p02.jpg'), 'existing');
  const before = (await fs.readdir(destination)).sort();
  await assert.rejects(reply(start('taken.jpg', { format: 'jpeg', scope: 'all' })), /exists/);
  assert.equal(await fs.readFile(path.join(destination, 'taken_p02.jpg'), 'utf8'), 'existing');
  await assert.rejects(reply(send('export-contact-sheet', [session.id, [first.id], { format: 'jpeg' }, path.join(photos, first.name)])), /source photo/);
  assert.deepEqual(await fs.readFile(path.join(photos, first.name)), jpg);
  await assert.rejects(reply(start('empty.pdf', {}, [])), /No photos/);
  await assert.rejects(reply(start('unknown.pdf', {}, ['missing'])), /not in this folder session/);
  await assert.rejects(reply(start('wrong.jpg', { format: 'pdf' }, [first.id])), /extension/);
  for (const format of ['pdf', 'jpeg']) {
    const job = start(format === 'pdf' ? 'cancel.pdf' : 'cancel.jpg', { format, scope: 'all' });
    await assert.rejects(reply(job, e => { if (e.done === 1) send('contact-sheet-cancel', []); }), /canceled/);
    assert.deepEqual((await fs.readdir(destination)).sort(), before);
  }
  await fs.unlink(path.join(photos, second.name));
  await assert.rejects(reply(send('export-contact-sheet', [session.id, [first.id], { format: 'jpeg' }, path.join(photos, second.name)])), /source photo/);
  await assert.rejects(reply(send('export-contact-sheet', [session.id, [first.id], {}, path.join(card, 'sheet.pdf')])), /camera card/);
  assert.deepEqual(await fs.readdir(card), []);
  await assert.rejects(fs.access(path.join(photos, second.name)), { code: 'ENOENT' });

  const mixed = path.join(root, 'mixed');
  await fs.mkdir(mixed); await fs.writeFile(path.join(mixed, '1-good.jpg'), jpg);
  await fs.writeFile(path.join(mixed, '2-corrupt.jpg'), 'invalid image');
  await fs.writeFile(path.join(mixed, '3-missing.jpg'), jpg);
  const scanned = await reply(send('scan', [mixed, false]));
  await fs.unlink(path.join(mixed, '3-missing.jpg'));
  const sheet = path.join(destination, 'mixed.jpg');
  const summary = await reply(send('export-contact-sheet', [scanned.id, [], { scope: 'all', format: 'jpeg', columns: 3, rows: 1,
    captions: { filename: false, rating: false } }, sheet]));
  assert.deepEqual(summary.warnings.map(w => w.filename), ['2-corrupt.jpg', '3-missing.jpg']);
  assert.deepEqual([summary.photos, summary.files], [3, 1]);
  const tile = await sharp(sheet).extract({ left: 461, top: 122, width: 345, height: 1450 }).greyscale().raw().toBuffer();
  assert.ok(tile.includes(237) && tile.some(v => v < 100), 'unavailable photo has a shaded tile and a printed label');
  await assert.rejects(reply(send('export-contact-sheet', [scanned.id, scanned.items.slice(1).map(i => i.id), {}, path.join(destination, 'bad.pdf')])),
    /2-corrupt\.jpg.*3-missing\.jpg/);
  await assert.rejects(fs.access(path.join(destination, 'bad.pdf')), { code: 'ENOENT' });

  const sibling = path.join(mixed, 'book_p02.jpg');
  await fs.writeFile(sibling, jpg);
  const book = await reply(send('scan', [mixed, false]));
  await fs.unlink(sibling);
  const ids = book.items.filter(i => i.name !== 'book_p02.jpg').map(i => i.id);
  await assert.rejects(reply(send('export-contact-sheet', [book.id, ids, { format: 'jpeg', columns: 1, rows: 1 }, path.join(mixed, 'book.jpg')])), /source photo/);
  await assert.rejects(fs.access(sibling), { code: 'ENOENT' });
});

test('cancel during final publication keeps completed files without deleting foreign replacements', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-publish-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const first = path.join(root, 'sheet_p01.jpg'), last = path.join(root, 'sheet_p03.jpg');
  const controller = new AbortController(), link = fs.link;
  t.mock.method(fs, 'link', async (source, target) => {
    await link(source, target);
    if (target === last) {
      await fs.unlink(first);
      await fs.writeFile(first, 'foreign', { flag: 'wx' });
      controller.abort(new Error('Canceled during publication'));
    }
  });
  const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  await assert.rejects(exportContactSheet({ photos: ['a', 'b', 'c'].map(name => ({ name })), file: path.join(root, 'sheet.jpg'),
    options: { format: 'jpeg', columns: 1, rows: 1 }, previews: { getForPresentation: async () => image }, signal: controller.signal }),
    /Canceled during publication.*Completed files kept.*sheet_p01\.jpg.*sheet_p03\.jpg/);
  assert.deepEqual((await fs.readdir(root)).sort(), ['sheet_p01.jpg', 'sheet_p02.jpg', 'sheet_p03.jpg']);
  assert.equal(await fs.readFile(first, 'utf8'), 'foreign');
  assert.equal((await sharp(last).metadata()).format, 'jpeg');
});

test('volumes without hard links fail cleanly without overwriting or leaving partial files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-nolink-'));
  t.after(() => fs.rm(root, { recursive: true }));
  t.mock.method(fs, 'link', async () => {
    throw Object.assign(new Error('Hard links unavailable'), { code: 'ENOTSUP' });
  });
  const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  await assert.rejects(exportContactSheet({ photos: [{ name: 'a.jpg' }], file: path.join(root, 'sheet.pdf'),
    options: { format: 'pdf', columns: 1, rows: 1 }, previews: { getForPresentation: async () => image } }),
    /atomic non-overwriting saves/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('destination replaced before staging or redirected before cleanup never writes or deletes foreign files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-card-swap-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const out = path.join(root, 'out'), card = path.join(root, 'card'), moved = path.join(root, 'moved');
  await fs.mkdir(out); await fs.mkdir(card);
  const mkdtemp = fs.mkdtemp;
  // Redirecting destination before staging fails before mkdtemp even touches the card.
  let checkedCard = false;
  const realpath = fs.realpath;
  t.mock.method(fs, 'realpath', async target => {
    if (!checkedCard && target === out) {
      checkedCard = true;
      return realpath(out);
    }
    if (checkedCard && target === out) {
      checkedCard = false;
      await fs.rename(out, moved);
      await fs.symlink(card, out);
    }
    return realpath(target);
  });
  const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  await assert.rejects(exportContactSheet({
    photos: [{ name: 'a.jpg' }],
    file: path.join(out, 'sheet.pdf'),
    options: { format: 'pdf', columns: 1, rows: 1 },
    previews: { getForPresentation: async () => image },
    isCard: async folder => (await realpath(folder)) === (await realpath(card)),
  }), /camera card|changed during export/);
  assert.deepEqual(await fs.readdir(card), []);

  // Same-path replacement right after mkdtemp aborts before rendering and never deletes a same-named empty dir in the replacement.
  const out2 = path.join(root, 'out2'), moved2 = path.join(root, 'moved2');
  await fs.mkdir(out2);
  let replaced = false, rendered = false, replacementStage = null;
  t.mock.method(fs, 'mkdtemp', async prefix => {
    const dir = await mkdtemp(prefix);
    if (!replaced) {
      replaced = true;
      await fs.rename(out2, moved2);
      await fs.mkdir(out2);
      replacementStage = path.join(out2, path.basename(dir));
      await fs.mkdir(replacementStage);
    }
    return dir;
  });
  await assert.rejects(exportContactSheet({
    photos: [{ name: 'a.jpg' }],
    file: path.join(out2, 'sheet.pdf'),
    options: { format: 'pdf', columns: 1, rows: 1 },
    previews: { getForPresentation: async () => { rendered = true; return image; } },
  }), /changed during export/);
  assert.equal(rendered, false);
  assert.equal((await fs.lstat(replacementStage)).isDirectory(), true);

  // Replacing the staged file while PDF writer holds its handle must be rejected before publication.
  const out4 = path.join(root, 'out4');
  await fs.mkdir(out4);
  let stagedDir4 = null;
  t.mock.method(fs, 'mkdtemp', async prefix => {
    const dir = await mkdtemp(prefix);
    stagedDir4 = dir;
    return dir;
  });
  await assert.rejects(exportContactSheet({
    photos: [{ name: 'a.jpg' }],
    file: path.join(out4, 'tampered.pdf'),
    options: { format: 'pdf', columns: 1, rows: 1 },
    previews: {
      getForPresentation: async () => {
        const stagedPath = path.join(stagedDir4, '0');
        await fs.unlink(stagedPath);
        await fs.writeFile(stagedPath, 'replaced bytes', { flag: 'wx' });
        return image;
      },
    },
  }), /staged contact sheet file changed/);
  await assert.rejects(fs.access(path.join(out4, 'tampered.pdf')), { code: 'ENOENT' });

  // Destination redirected before cancellation cleanup must never delete a same-named foreign directory.
  const out3 = path.join(root, 'out3'), moved3 = path.join(root, 'moved3'), other = path.join(root, 'other');
  await fs.mkdir(out3); await fs.mkdir(other);
  const controller = new AbortController();
  let stageName = null;
  t.mock.method(fs, 'mkdtemp', async prefix => {
    const dir = await mkdtemp(prefix);
    stageName = path.basename(dir);
    return dir;
  });
  await assert.rejects(exportContactSheet({
    photos: [{ name: 'a.jpg' }],
    file: path.join(out3, 'sheet.pdf'),
    options: { format: 'pdf', columns: 1, rows: 1 },
    signal: controller.signal,
    previews: {
      getForPresentation: async () => {
        const foreignStage = path.join(other, stageName);
        await fs.mkdir(foreignStage);
        await fs.writeFile(path.join(foreignStage, 'sentinel.txt'), 'keep');
        await fs.rename(out3, moved3);
        await fs.symlink(other, out3);
        controller.abort(new Error('Canceled after redirect'));
        return image;
      },
    },
  }), /Canceled after redirect/);
  assert.equal(await fs.readFile(path.join(other, stageName, 'sentinel.txt'), 'utf8'), 'keep');
});
