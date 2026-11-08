const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { ExifTool } = require('exiftool-vendored');
const { ExternalEdits } = require('../src/external-edits.cjs');
const { Library } = require('../src/library.cjs');
const { inventory, cleanup } = require('../src/handoffs.cjs');
const { planTiffs } = require('../src/develop-plan.cjs');
const { externalEditFixtures } = require('../scripts/external-edit-fixtures.cjs');
const { PreviewService } = require('../src/previews.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-proposals-'));
  const f = await externalEditFixtures(root), exif = new ExifTool({ maxProcs: 2 });
  let service;
  const library = new Library(f.data, { settings: () => f.settings, linkedHandoffs: () => service.linkedPaths });
  service = new ExternalEdits(library, exif, () => f.settings); await service.init();
  const session = await library.scan(f.photos);
  t.after(async () => { await library.close(); await exif.end(); await fs.rm(root, { recursive: true, force: true }); });
  return { ...f, root, library, service, session, exif };
}

test('proposals recover saved edits across locations, preserve current links, and reject persistently', async t => {
  const f = await fixture(t);
  const pixels = await sharp(f.files[0].file).tiff().toBuffer(); await fs.writeFile(f.files[0].file, pixels);
  await f.exif.write(f.files[0].file, { 'XMP-exif:DateTimeOriginal': '2026:09:26 09:30:40.029Z', 'XMP-tiff:Model': 'Synthetic camera', 'XMP-exifEX:LensModel': 'Synthetic lens', 'IFD0:Software': 'Dehancer' }, ['-overwrite_original']);
  const { proposals } = await f.service.discover(f.session.id);
  assert.deepEqual(proposals.map(p => p.name).sort(), ['DSC001.ARW', 'DSC002.ARW']);
  assert.equal(f.session.items.filter(i => i.externalEdit).length, 1);
  assert.equal((await f.service.preview(f.session.id, proposals[0].id)).path, proposals[0].file);
  const previews = new PreviewService(path.join(f.root, 'preview-cache'));
  t.after(() => previews.close());
  const holds = [], blockers = Array.from({ length: 3 }, (_, n) => previews.queue.add(`hold-${n}`, 1, () => new Promise(resolve => holds.push(resolve))));
  await new Promise(resolve => setImmediate(resolve));
  const queued = await Promise.all(proposals.map(p => f.service.preview(f.session.id, p.id)));
  const images = queued.map(item => previews.get(item, 'thumb'));
  const loaded = Promise.all(images);
  await new Promise(resolve => setImmediate(resolve));
  previews.visible(proposals.map(p => f.library.item(f.session.id, p.itemId)));
  for (const release of holds) release();
  await Promise.all(blockers);
  assert.ok((await loaded).every(buffer => buffer.length > 0));
  await f.service.decide(f.session.id, proposals.map(p => p.id), false);
  const reopened = new ExternalEdits(f.library, f.exif, () => f.settings); await reopened.init();
  assert.deepEqual((await reopened.discover(f.session.id)).proposals, []);
  assert.equal(f.library.publicSession(f.library.get(f.session.id)).items.filter(i => i.externalEdit).length, 1);
});

test('accepted links survive XMP relocation, stay out of cleanup in every session, and cannot be regenerated', async t => {
  const f = await fixture(t), proposals = (await f.service.discover(f.session.id)).proposals;
  const original = await fs.readFile(f.files[0].file);
  const result = await f.service.decide(f.session.id, proposals.map(p => p.id), true);
  assert.equal(result.items.length, 2); assert.deepEqual(result.proposals, []);
  const item = f.library.item(f.session.id, proposals[0].itemId);
  assert.equal(f.library.developGet(f.session.id, item.id).linked, true);
  await f.library.developMark(f.session.id, item.id, { exported: true });
  let usage = await inventory(f.library.get(f.session.id));
  assert.deepEqual(usage.entries.map(r => r.path), [f.files[2].file]);
  await cleanup(f.library, f.session.id, usage.token, false, [item.id]);
  const plan = await planTiffs([item], f.edits, f.library.get(f.session.id).items, 'tif', f.service.linkedPaths);
  assert.equal(plan[0].own, false); assert.notEqual(plan[0].tiff, item.develop.tiff);
  await f.library.flushSidecars();
  const fresh = new Library(path.join(f.root, 'other-machine'));
  const copy = await fresh.scan(f.photos), restored = copy.items.find(i => i.name === item.name);
  assert.equal(fresh.developGet(copy.id, restored.id).linked, true); await fresh.close();
  const card = await f.library.scan(f.card, true, { removable: true });
  usage = await inventory(f.library.get(card.id));
  assert.deepEqual(usage.entries.map(r => r.path), [f.files[2].file]);
  const cardItem = f.library.item(card.id, card.items.find(i => i.name === item.name).id);
  assert.equal(f.library.developGet(card.id, cardItem.id).linked, true);
  assert.equal((await planTiffs([cardItem], f.edits, f.library.get(card.id).items, 'tif', f.service.linkedPaths))[0].own, false);
  assert.deepEqual(await fs.readFile(f.files[0].file), original);
});

test('metadata matching ignores filenames and refuses competing originals and changed or removed photos', async t => {
  const f = await fixture(t);
  await fs.copyFile(path.join(f.photos, 'DSC001.ARW'), path.join(f.photos, 'other.ARW'));
  let session = await f.library.scan(f.photos);
  let proposals = (await f.service.discover(session.id)).proposals;
  assert.deepEqual(proposals.map(p => p.name), ['DSC002.ARW']);
  await fs.appendFile(proposals[0].file, 'changed');
  await assert.rejects(f.service.decide(session.id, [proposals[0].id], true), /changed/);
  assert.equal(f.library.developGet(session.id, proposals[0].itemId).tiff, null);
  await fs.unlink(path.join(f.photos, 'other.ARW'));
  session = await f.library.scan(f.photos);
  proposals = (await f.service.discover(session.id)).proposals;
  const first = proposals.find(p => p.name === 'DSC001.ARW');
  await fs.appendFile(path.join(f.photos, first.name), 'changed');
  await assert.rejects(f.service.decide(session.id, [first.id], true), /original changed/i);
  await f.library.forget(session.id, [first.itemId]);
  assert.ok(!f.service.list(session.id).some(p => p.itemId === first.itemId));
  await assert.rejects(f.service.preview(session.id, first.id), /no longer available/);
});

test('configured folders propose recognizable editor outputs without saved records, retaining ambiguous versions for review', async t => {
  const f = await fixture(t);
  const extra = path.join(f.edits, 'another-version.tif'); await fs.copyFile(f.files[0].file, extra);
  const { proposals } = await f.service.discover(f.session.id);
  assert.equal(proposals.filter(p => p.name === 'DSC001.ARW').length, 2);
  await assert.rejects(f.service.decide(f.session.id, proposals.map(p => p.id), true), /one external edit per photo/);
  const first = proposals.find(p => p.file === extra);
  await f.service.decide(f.session.id, [first.id], true);
  assert.equal(f.service.list(f.session.id).filter(p => p.name === first.name).length, 0);
  const unedited = path.join(f.edits, 'raw-handoff.tif');
  await fs.copyFile(f.files[1].file, unedited);
  await f.exif.write(unedited, { Software: 'PhotoCull' }, ['-overwrite_original']);
  const session = await f.library.scan(f.photos);
  assert.ok(!(await f.service.discover(session.id)).proposals.some(p => p.file === unedited));
});
