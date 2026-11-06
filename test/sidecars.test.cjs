const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DOMParser } = require('@xmldom/xmldom');
const { performance } = require('node:perf_hooks');
const { Library } = require('../src/library.cjs');
const { normalizeSettings, DEFAULTS } = require('../src/preferences.cjs');
const { TransferService } = require('../src/transfer.cjs');
const { updateXmp, readXmp, writeXmp, portablePath, resolveDevelop, shouldWriteSidecars } = require('../src/xmp.cjs');

async function setup(t, settings = {}, names = ['photo.ARW']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-sidecars-')));
  const photos = path.join(root, 'photos'), data = path.join(root, 'state');
  await fs.mkdir(photos);
  for (const name of names) await fs.writeFile(path.join(photos, name), 'synthetic photo');
  let config = normalizeSettings(settings);
  const library = new Library(data, { settings: () => config });
  t.after(async () => { await library.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, photos, data, library, setSettings: patch => { config = normalizeSettings(patch, config); } };
}
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const parse = xml => new DOMParser({ onError: (level, message) => { throw new Error(message); } }).parseFromString(xml, 'application/xml');
const descriptions = xml => Array.from(parse(xml).getElementsByTagNameNS(RDF, 'Description'));
const fixture = name => fs.readFile(path.join(__dirname, 'fixtures', 'xmp', name + '.xmp'), 'utf8');
const state = xml => readXmp(xml, DEFAULTS, { portable: true });

for (const name of ['lightroom', 'darktable', 'capture-one']) test(`${name} keeps foreign XML byte-for-byte through repeated writes`, async () => {
  const xml = await fixture(name);
  const foreign = name === 'lightroom' ? [xml.match(/    crs:Version[^>]+/)[0], xml.match(/   <!--[\s\S]*?<\/crs:Look>/)[0]]
    : name === 'darktable' ? [xml.match(/   <darktable:history>[\s\S]*?<\/darktable:colorlabels>/)[0]]
      : [xml.match(/   <dc:subject>[\s\S]*?<\/dc:rights>/)[0]];
  let next = xml;
  const item = { flag: 'reject', rating: 4, color: '5', modified: 1700000000000, develop: { recipe: 'camera', settings: { light: { exposure: 0.5 } }, tiff: null, editedBy: null } };
  for (let n = 0; n < 8; n++) {
    next = updateXmp(next, item);
    assert.equal(descriptions(next).length, 1, 'New properties must merge into the existing Description');
  }
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

test('new packets and self-closing descriptions keep a single photo Description', () => {
  let xml = '';
  for (let n = 0; n < 5; n++) {
    xml = updateXmp(xml, { flag: 'pick', rating: n, develop: null });
    assert.equal(descriptions(xml).length, 1);
    assert.equal(state(xml).rating, n);
  }
});

test('merging properties avoids foreign prefix collisions and preserves their XML bytes', () => {
  const foreign = `<xmp:Curve rdf:value="keep &amp; preserve"/><photocull:note>foreign</photocull:note><dc:title>foreign title</dc:title>`;
  let xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="${RDF}"><r:Description r:about="" xmlns:xmp="urn:foreign:xmp" xmlns:photocull="urn:foreign:photocull" xmlns:rdf="urn:foreign:rdf" xmlns:dc="urn:foreign:dc" xmp:Rating='99'>${foreign}</r:Description></r:RDF></x:xmpmeta>`;
  const config = normalizeSettings({ metadata: { creator: 'Test Photographer', keywords: ['travel'] } });
  for (let n = 0; n < 5; n++) {
    xml = updateXmp(xml, { flag: 'pick', rating: 4, develop: null }, config);
    const [desc] = descriptions(xml);
    assert.equal(descriptions(xml).length, 1);
    assert.equal(desc.getAttributeNS('urn:foreign:xmp', 'Rating'), '99');
    assert.equal(desc.getAttributeNS('http://ns.adobe.com/xap/1.0/', 'Rating'), '4');
    assert.equal(desc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')[0].textContent, 'Test Photographer');
    assert.equal(desc.getElementsByTagNameNS(RDF, 'li').length, 2);
    assert.ok(xml.includes(foreign)); assert.ok(xml.includes("xmp:Rating='99'"));
    assert.equal(state(xml).flag, 'pick');
  }
});

test('namespace entities and default RDF namespaces merge without duplicate fields', () => {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><RDF xmlns="${RDF}"><Description xmlns:p="http:&#47;&#47;ns.adobe.com/xap/1.0/" p:Rating="1"><p:Label>Blue</p:Label></Description></RDF></x:xmpmeta>`;
  const next = updateXmp(xml, { flag: 'reject', rating: 3 });
  assert.equal(descriptions(next).length, 1); assert.equal(state(next).rating, 3);
  assert.ok(next.includes('xmlns:p="http:&#47;&#47;ns.adobe.com/xap/1.0/"'));
  assert.equal(next.includes('p:Rating="1"'), false);
});

test('a single named RDF subject keeps its identity and properties in one Description', () => {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="${RDF}"><r:Description r:about='urn:photo:123' xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="1"/></r:RDF></x:xmpmeta>`;
  const next = updateXmp(xml, { flag: 'pick', rating: 4 });
  assert.equal(descriptions(next).length, 1); assert.ok(next.includes("r:about='urn:photo:123'"));
  assert.equal(state(next).rating, 4); assert.equal(state(next).flag, 'pick');
});

test('old redundant owned descriptions are removed and unrelated RDF subjects stay intact', () => {
  const other = `<r:Description r:about="urn:another-photo" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="1"/>`;
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="${RDF}"><r:Description r:about="" custom='preserve me'/><r:Description r:about="" xmlns:photocull="https://www.filipbiljic.com/photocull/ns/1.0/" photocull:version="1" photocull:flag="none"/>${other}</r:RDF></x:xmpmeta>`;
  const next = updateXmp(xml, { flag: 'pick', rating: 5 });
  assert.equal(descriptions(next).length, 2); assert.ok(next.includes(other)); assert.ok(next.includes("custom='preserve me'"));
  assert.equal(state(next).rating, 5); assert.equal(state(next).flag, 'pick');
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
  saved.decisions[id].flag = 'pick'; saved.decisions[id].rating = 2; saved.decisions[id].modified = local + 10000; await fs.writeFile(store, JSON.stringify(saved));
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
  const linked = path.join(root, 'linked-photos'); await fs.symlink(photos, linked, 'junction');
  const s = await library.scan(linked), id = s.items[0].id, folder = path.join(linked, '_develop');
  await fs.mkdir(folder); const tiff = path.join(folder, 'photo-edit.tif'); await fs.writeFile(tiff, 'tiff');
  await library.developSet(s.id, [id], { recipe: 'camera', settings: { light: { exposure: 1.25 } } });
  await library.developMark(s.id, id, { tiff }); await library.developMark(s.id, id, { editedBy: 'affinity' }); await library.flushSidecars();
  const xml = await fs.readFile(path.join(photos, 'photo.xmp'), 'utf8');
  assert.equal(state(xml).develop.tiff, '_develop/photo-edit.tif'); assert.ok(!xml.includes(root));
  const saved = JSON.parse(await fs.readFile(library.get(s.id).store, 'utf8')).decisions[id].develop;
  assert.equal(saved.tiff, '_develop/photo-edit.tif'); assert.equal(saved.handoffs[0].path, saved.tiff); assert.equal(saved.handoffs[0].realPath, saved.tiff);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  const outsideLink = path.join(root, 'linked-outside'); await fs.symlink(outside, outsideLink, 'junction');
  const external = path.join(outsideLink, 'external.tif'); await fs.writeFile(external, 'external');
  const pending = path.join(linked, '_develop', 'pending.tif');
  for (const absolute of [external, pending]) {
    await library.developMark(s.id, id, { tiff: absolute }); await library.flushSidecars();
    assert.equal(state(await fs.readFile(path.join(photos, 'photo.xmp'), 'utf8')).develop.tiff, absolute);
  }
  await library.developMark(s.id, id, { tiff, editedBy: 'affinity' }); await library.flushSidecars();
  const moved = path.join(root, 'nas-new-mount'); await fs.rename(photos, moved);
  const fresh = new Library(path.join(root, 'laptop-two')), again = await fresh.scan(moved), item = fresh.item(again.id, again.items[0].id);
  assert.equal(item.develop.tiff, path.join(moved, '_develop', 'photo-edit.tif')); assert.equal(item.develop.editedBy, 'affinity');
  assert.equal(item.develop.settings.light.exposure, 1.25); assert.equal(item.develop.recipe, 'camera'); assert.equal(item.develop.missing, false);
  assert.equal(item.develop.handoffs.find(r => r.path === item.develop.tiff).realPath, item.develop.tiff);
  await fs.rm(item.develop.tiff); const missing = await fresh.scan(moved);
  assert.equal(missing.items[0].handoffMissing, true); assert.equal(missing.items[0].externalEdit, false);
  assert.equal(fresh.developGet(missing.id, missing.items[0].id).missing, true);
  assert.equal(portablePath('Z:\\Photos\\Trip\\_develop\\a.tif', 'Z:\\Photos\\Trip\\a.ARW'), '_develop/a.tif');
  assert.equal(portablePath('C:\\Edits\\a.tif', 'Z:\\Photos\\a.ARW'), 'C:\\Edits\\a.tif');
  assert.equal(resolveDevelop({ tiff: '../escape.tif' }, path.join(moved, 'photo.ARW')).tiff, null);
});

test('recursive photo trees relocate root handoff folders and include effective custom recipe settings', async t => {
  const { root, photos, data } = await setup(t, {}, ['top.ARW']);
  await fs.mkdir(path.join(photos, 'DCIM')); await fs.writeFile(path.join(photos, 'DCIM', 'nested.ARW'), 'photo');
  await fs.mkdir(path.join(photos, 'Edits')); const tiff = path.join(photos, 'Edits', 'nested.tif'); await fs.writeFile(tiff, 'tiff');
  const library = new Library(data, { recipeSettings: id => id === 'custom-look' ? { light: { contrast: 12 } } : null });
  const linked = path.join(root, 'linked-photos'); await fs.symlink(photos, linked, 'junction');
  const s = await library.scan(linked, true), item = s.items.find(i => i.name === 'nested.ARW');
  await library.developSet(s.id, [item.id], { recipe: 'custom-look' }); await library.developMark(s.id, item.id, { tiff: path.join(linked, 'Edits', 'nested.tif') }); await library.close();
  const xml = await fs.readFile(path.join(photos, 'DCIM', 'nested.xmp'), 'utf8');
  assert.equal(state(xml).develop.tiff, '../Edits/nested.tif'); assert.equal(state(xml).develop.settings.light.contrast, 12);
  const moved = path.join(root, 'moved'); await fs.rename(photos, moved);
  const fresh = new Library(path.join(root, 'other-state')), again = await fresh.scan(moved, true);
  assert.equal(again.items.find(i => i.name === 'nested.ARW').tiff, path.join(moved, 'Edits', 'nested.tif'));
});

test('malformed alternate sidecars are respected and invalid develop settings cannot block opening decisions', async t => {
  const { photos, library } = await setup(t);
  const darktable = path.join(photos, 'photo.ARW.xmp'); await fs.writeFile(darktable, 'not xml');
  let s = await library.scan(photos); assert.equal(library.item(s.id, s.items[0].id).sidecar, darktable);
  await library.decide(s.id, s.items[0].id, { flag: 'pick' }); await library.flushSidecars();
  assert.equal(await fs.readFile(darktable, 'utf8'), 'not xml'); assert.ok(library.get(s.id).warnings.some(w => /not written/.test(w)));
  assert.equal((await fs.readdir(photos)).includes('photo.xmp'), false);
  await fs.writeFile(darktable, updateXmp('', { flag: 'pick', rating: 4, modified: Date.now() + 10000, develop: { settings: { light: { exposure: 100 } } } }));
  s = await library.scan(photos); assert.equal(s.items[0].flag, 'pick'); assert.equal(s.items[0].rating, 4); assert.equal(s.items[0].adjusted, false);
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

test('unsynced durable session decisions resume sidecar writing after reopening', async t => {
  const { photos, data, library } = await setup(t, { writeSidecars: 'never' });
  const s = await library.scan(photos); await library.decide(s.id, s.items[0].id, { flag: 'pick', rating: 5 });
  const fresh = new Library(data); await fresh.scan(photos); await fresh.close();
  assert.equal(state(await fs.readFile(path.join(photos, 'photo.xmp'), 'utf8')).rating, 5);
});
