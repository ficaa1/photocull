const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { Library } = require('../src/library.cjs');
const { normalizeSettings, DEFAULTS } = require('../src/preferences.cjs');
const { TransferService } = require('../src/transfer.cjs');
const { updateXmp, readXmp, writeXmp, portablePath, resolveDevelop, shouldWriteSidecars } = require('../src/xmp.cjs');

async function setup(t, settings = {}, names = ['photo.ARW']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-sidecars-'));
  const photos = path.join(root, 'photos'), data = path.join(root, 'state');
  await fs.mkdir(photos);
  for (const name of names) await fs.writeFile(path.join(photos, name), 'synthetic photo');
  let config = normalizeSettings(settings);
  const library = new Library(data, { settings: () => config });
  t.after(async () => { await library.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, photos, data, library, setSettings: patch => { config = normalizeSettings(patch, config); } };
}
const fixture = name => fs.readFile(path.join(__dirname, 'fixtures', 'xmp', name + '.xmp'), 'utf8');
const state = xml => readXmp(xml, DEFAULTS, { portable: true });

for (const name of ['lightroom', 'darktable', 'capture-one']) test(`${name} keeps foreign XML byte-for-byte through repeated writes`, async () => {
  const xml = await fixture(name);
  const foreign = name === 'lightroom' ? [xml.match(/    crs:Version[^>]+/)[0], xml.match(/   <!--[\s\S]*?<\/crs:Look>/)[0]]
    : name === 'darktable' ? [xml.match(/   <darktable:history>[\s\S]*?<\/darktable:colorlabels>/)[0]]
      : [xml.match(/   <dc:subject>[\s\S]*?<\/dc:rights>/)[0]];
  let next = xml;
  const item = { flag: 'reject', rating: 4, color: '5', modified: 1700000000000, develop: { recipe: 'camera', settings: { light: { exposure: 0.5 } }, tiff: null, editedBy: null } };
  for (let n = 0; n < 8; n++) next = updateXmp(next, item);
  for (const bytes of foreign) assert.ok(next.includes(bytes), 'Foreign properties must not be serialized or reformatted');
  assert.equal((next.match(/photocull:version=/g) || []).length, 1);
  assert.equal((next.match(/xmp:Rating=/g) || []).length, 1);
  assert.equal(state(next).flag, 'reject'); assert.equal(state(next).rating, 4); assert.equal(state(next).color, '5');
  assert.equal(state(next).develop.settings.light.exposure, 0.5);
  assert.equal(readXmp(next).rating, 0); // Lightroom sees reject = -1.
});

test('namespace aliases, nested foreign properties, quoted markup and empty RDF survive', () => {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:p="http://ns.adobe.com/xap/1.0/" xmlns:f="urn:foreign" p:Rating = '2' f:note='a > b'><p:Label>Blue</p:Label><f:tree><p:Rating>99</p:Rating></f:tree></r:Description></r:RDF></x:xmpmeta>`;
  const next = updateXmp(xml, { flag: 'pick', rating: 5 });
  assert.ok(next.includes("f:note='a > b'")); assert.ok(next.includes('<f:tree><p:Rating>99</p:Rating></f:tree>'));
  assert.equal(readXmp(next).rating, 5);
  const empty = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>`;
  assert.equal(readXmp(updateXmp(empty, { flag: 'pick', rating: 3 })).rating, 3);
});

test('newest sidecar wins on reopen; a newer local decision and timestamp ties keep the session', async t => {
  const { photos, data, library } = await setup(t, { writeSidecars: 'never' });
  const session = await library.scan(photos), id = session.items[0].id;
  await library.decide(session.id, id, { flag: 'pick', rating: 2 });
  const local = library.item(session.id, id).modified, file = path.join(photos, 'photo.xmp');
  const xml = updateXmp('', { flag: 'reject', rating: 5, modified: local - 10000 });
  await fs.writeFile(file, xml); await fs.utimes(file, (local - 10000) / 1000, (local - 10000) / 1000);
  let reopened = await new Library(data).scan(photos);
  assert.equal(reopened.items[0].flag, 'pick'); assert.equal(reopened.items[0].rating, 2);
  // The explicit PhotoCull timestamp wins even when a copy resets file mtime.
  await fs.writeFile(file, xml.replace(new Date(local - 10000).toISOString(), new Date(local + 10000).toISOString()));
  await fs.utimes(file, 1, 1);
  reopened = await new Library(data).scan(photos);
  assert.equal(reopened.items[0].flag, 'reject'); assert.equal(reopened.items[0].rating, 5);
  const store = library.get(session.id).store, saved = JSON.parse(await fs.readFile(store, 'utf8'));
  saved.decisions[id].modified = local + 10000; await fs.writeFile(store, JSON.stringify(saved));
  reopened = await new Library(data).scan(photos);
  assert.equal(reopened.items[0].flag, 'pick', 'Equal timestamps favor the session');
});

test('external standard rating/label edits override stale PhotoCull decisions by file mtime', async t => {
  const { photos, data, library } = await setup(t);
  const s = await library.scan(photos), id = s.items[0].id;
  await library.decide(s.id, id, { flag: 'pick', rating: 2 }); await library.flushSidecars();
  const file = path.join(photos, 'photo.xmp'), modified = library.item(s.id, id).modified;
  let xml = await fs.readFile(file, 'utf8'); xml = xml.replace('xmp:Rating="2"', 'xmp:Rating="4"').replace('xmp:Label="Green"', 'xmp:Label="Purple"');
  await fs.writeFile(file, xml); await fs.utimes(file, (modified + 5000) / 1000, (modified + 5000) / 1000);
  const reopened = await new Library(data).scan(photos);
  assert.equal(reopened.items[0].rating, 4); assert.equal(reopened.items[0].color, '5'); assert.equal(reopened.items[0].flag, 'none');
});

test('both naming styles are read; newest existing style is written and RAW+JPEG stay paired', async t => {
  const { photos, library } = await setup(t, {}, ['photo.ARW', 'photo.JPG', 'solo.JPG']);
  const lightroom = path.join(photos, 'photo.xmp'), darktable = path.join(photos, 'photo.ARW.xmp');
  await fs.writeFile(lightroom, await fixture('lightroom')); await fs.utimes(lightroom, 1, 1);
  await fs.writeFile(darktable, await fixture('darktable'));
  const s = await library.scan(photos), raw = s.items.find(i => i.raw), jpeg = s.items.find(i => !i.raw);
  assert.equal(raw.paired, true); assert.equal(s.items.length, 2); assert.equal(raw.flag, 'reject');
  assert.equal(library.item(s.id, raw.id).sidecar, darktable);
  await library.decide(s.id, raw.id, { rating: 5 }); await library.decide(s.id, jpeg.id, { flag: 'pick' }); await library.flushSidecars();
  assert.equal(await fs.readFile(lightroom, 'utf8'), await fixture('lightroom'));
  assert.equal(state(await fs.readFile(darktable, 'utf8')).rating, 5);
  assert.equal(state(await fs.readFile(path.join(photos, 'solo.xmp'), 'utf8')).flag, 'pick');
  const plan = await library.deletionPlan(s.id, [raw.id]); assert.equal(plan.sidecars.length, 2);
});

test('relative handoffs, recipe settings, editor and export state relocate with the photo folder', async t => {
  const { root, photos, library } = await setup(t);
  const s = await library.scan(photos), id = s.items[0].id, folder = path.join(photos, '_develop');
  await fs.mkdir(folder); const tiff = path.join(folder, 'photo-edit.tif'); await fs.writeFile(tiff, 'tiff');
  await library.developSet(s.id, [id], { recipe: 'camera', settings: { light: { exposure: 1.25 } } });
  await library.developMark(s.id, id, { tiff }); await library.developMark(s.id, id, { editedBy: 'affinity' }); await library.flushSidecars();
  const xml = await fs.readFile(path.join(photos, 'photo.xmp'), 'utf8');
  assert.equal(state(xml).develop.tiff, '_develop/photo-edit.tif'); assert.ok(!xml.includes(root));
  const moved = path.join(root, 'nas-new-mount'); await fs.rename(photos, moved);
  const fresh = new Library(path.join(root, 'laptop-two')), again = await fresh.scan(moved), item = fresh.item(again.id, again.items[0].id);
  assert.equal(item.develop.tiff, path.join(moved, '_develop', 'photo-edit.tif')); assert.equal(item.develop.editedBy, 'affinity');
  assert.equal(item.develop.settings.light.exposure, 1.25); assert.equal(item.develop.recipe, 'camera'); assert.equal(item.develop.missing, false);
  assert.equal(item.develop.handoffs[0].realPath, item.develop.tiff);
  await fs.rm(item.develop.tiff); const missing = await fresh.scan(moved);
  assert.equal(missing.items[0].handoffMissing, true); assert.equal(missing.items[0].externalEdit, false);
  assert.equal(fresh.developGet(missing.id, missing.items[0].id).missing, true);
  assert.equal(portablePath('Z:\\Photos\\Trip\\_develop\\a.tif', 'Z:\\Photos\\Trip\\a.ARW'), '_develop/a.tif');
  assert.equal(portablePath('C:\\Edits\\a.tif', 'Z:\\Photos\\a.ARW'), 'C:\\Edits\\a.tif');
  assert.equal(resolveDevelop({ tiff: '../escape.tif' }, path.join(moved, 'photo.ARW')).tiff, null);
});

test('card default avoids source XMP and copies portable decisions automatically; Never opts out', async t => {
  const { root, photos, library, setSettings } = await setup(t);
  const s = await library.scan(photos, false, { removable: true }), id = s.items[0].id;
  await library.decide(s.id, id, { flag: 'pick', rating: 5 }); await library.flushSidecars();
  assert.deepEqual(await fs.readdir(photos), ['photo.ARW']);
  const out = path.join(root, 'out'); await fs.mkdir(out);
  const copies = new TransferService(); t.after(() => copies.close());
  const result = await copies.copy(library.get(s.id), out);
  assert.equal(result.copiedFiles, 2); assert.equal(state(await fs.readFile(path.join(out, 'photo.xmp'), 'utf8')).rating, 5);
  setSettings({ writeSidecars: 'never' }); const out2 = path.join(root, 'never'); await fs.mkdir(out2);
  const optedOut = await copies.copy(library.get(s.id), out2, { metadataSettings: normalizeSettings({ writeSidecars: 'never' }) });
  assert.equal(optedOut.copiedFiles, 1);
  setSettings({ writeSidecars: 'always' }); await library.decide(s.id, id, { rating: 3 }); await library.flushSidecars();
  assert.equal(state(await fs.readFile(path.join(photos, 'photo.xmp'), 'utf8')).rating, 3);
  for (const policy of ['always', 'except-cards', 'never']) for (const card of [false, true]) assert.equal(shouldWriteSidecars({ writeSidecars: policy }, card), policy === 'always' || policy === 'except-cards' && !card);
  assert.throws(() => normalizeSettings({ writeSidecars: 'sometimes' }));
});

test('read-only locations, malformed XML and symlinks are left intact without temporary files', async t => {
  const { root, photos } = await setup(t), file = path.join(photos, 'photo.xmp');
  await fs.writeFile(file, 'malformed'); await assert.rejects(writeXmp(file, { flag: 'pick', rating: 2 }));
  assert.equal(await fs.readFile(file, 'utf8'), 'malformed');
  if (process.platform !== 'win32') {
    await fs.chmod(photos, 0o555);
    try { await assert.rejects(writeXmp(file, { flag: 'pick', rating: 2 }), /read-only/); } finally { await fs.chmod(photos, 0o755); }
    await fs.rm(file); const foreign = path.join(root, 'foreign.xmp'); await fs.writeFile(foreign, await fixture('lightroom')); await fs.symlink(foreign, file);
    await assert.rejects(writeXmp(file, { flag: 'pick', rating: 2 }), /regular file/);
    assert.equal(await fs.readFile(foreign, 'utf8'), await fixture('lightroom'));
  }
  assert.ok(!(await fs.readdir(photos)).some(n => n.endsWith('.tmp')));
});

test('300 decisions acknowledge durable local state without waiting for sidecar I/O', async t => {
  const { photos, library } = await setup(t, {}, Array.from({ length: 300 }, (_, n) => `photo-${n}.JPG`));
  const s = await library.scan(photos), start = performance.now();
  await Promise.all(s.items.map(i => library.decide(s.id, i.id, { flag: 'pick', rating: 4 })));
  const elapsed = performance.now() - start;
  assert.equal(library.stats.sidecarWrites, 0, 'Decisions do not await the debounced sidecar queue');
  assert.ok(library.stats.sessionWrites < 10); assert.ok(elapsed < 2000, `Decision burst took ${elapsed.toFixed(0)} ms`);
  const ticks = []; const timer = setInterval(() => ticks.push(performance.now()), 5);
  await library.flushSidecars(); clearInterval(timer);
  assert.equal(library.stats.sidecarWrites, 300); assert.ok(ticks.length > 0, 'Sidecar batch yields to the event loop');
  const fresh = await new Library(path.join(photos, '..', 'second-laptop')).scan(photos);
  assert.ok(fresh.items.every(i => i.flag === 'pick' && i.rating === 4));
  t.diagnostic(`300 decisions acknowledged in ${elapsed.toFixed(1)} ms; ${library.stats.sessionWrites} local writes; ${ticks.length} event-loop ticks during sidecar flush`);
});
