const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { normalizeSettings } = require('../src/preferences.cjs');
const { Library } = require('../src/library.cjs');
const { TransferService } = require('../src/transfer.cjs');
const { updateXmp, readXmp } = require('../src/xmp.cjs');
// Transfer-only tests isolate copying from the separate source autosave policy.
async function setup(t, settings = { writeSidecars: 'never' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-transfer-'));
  const photos = path.join(root, 'photos'), destination = path.join(root, 'keepers');
  await fs.mkdir(photos); await fs.mkdir(destination);
  const library = new Library(path.join(root, 'state'), { settings: () => normalizeSettings(settings) });
  t.after(async () => { await library.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, photos, destination, library };
}
async function pickAll(library, photos, recursive = false) {
  const s = await library.scan(photos, recursive);
  for (const i of s.items) await library.decide(s.id, i.id, { flag: 'pick', rating: 4 });
  return library.get(s.id);
}
test('copy picks transfers original bytes only; optional companion and destination XMP preserve source metadata', { timeout: 20000 }, async t => {
  const { photos, destination, library } = await setup(t);
  const raw = Buffer.alloc(1024 * 1024, 42), jpeg = Buffer.from('camera JPEG');
  await fs.writeFile(path.join(photos, 'a.ARW'), raw); await fs.writeFile(path.join(photos, 'a.JPG'), jpeg);
  await fs.writeFile(path.join(photos, 'reject.ARW'), 'reject'); await fs.writeFile(path.join(photos, 'unreviewed.JPG'), 'unreviewed');
  const xml = updateXmp('', { flag: 'none', rating: 1 }).replace('xmp:Label=""', 'xmp:Label="Blue" custom="preserve me"');
  await fs.writeFile(path.join(photos, 'a.xmp'), xml);
  const session = await library.scan(photos); const a = session.items.find(i => i.name === 'a.ARW');
  await library.decide(session.id, a.id, { flag: 'pick', rating: 5 });
  await library.decide(session.id, session.items.find(i => i.name === 'reject.ARW').id, { flag: 'reject' });
  const events = []; const copies = new TransferService({ onProgress: p => events.push(p) });
  const result = await copies.copy(library.get(session.id), destination, { includeJpeg: true, includeXmp: true });
  assert.equal(result.copied, 1); assert.equal(result.copiedFiles, 3); assert.equal(result.failures.length, 0);
  assert.deepEqual((await fs.readdir(destination)).sort(), ['a.ARW', 'a.JPG', 'a.xmp']);
  assert.deepEqual(await fs.readFile(path.join(destination, 'a.ARW')), raw);
  assert.deepEqual(await fs.readFile(path.join(destination, 'a.JPG')), jpeg);
  const exported = await fs.readFile(path.join(destination, 'a.xmp'), 'utf8');
  assert.deepEqual(readXmp(exported), { flag: 'none', rating: 5 });
  assert.match(exported, /xmp:Label="Blue"/, 'Independent imported color survives a pick decision'); assert.match(exported, /preserve me/);
  assert.equal(await fs.readFile(path.join(photos, 'a.xmp'), 'utf8'), xml);
  assert.equal(events.at(-1).state, 'done'); assert.equal(result.bytesCopied, result.totalBytes);
});
test('copy preserves current sidecar metadata after automatic source writes have completed', async t => {
  const { photos, destination, library } = await setup(t, {});
  const photo = path.join(photos, 'a.ARW'), sidecar = path.join(photos, 'a.xmp');
  await fs.writeFile(photo, 'camera original');
  const original = updateXmp('', { flag: 'none', rating: 1 }).replace('xmp:Label=""', 'xmp:Label="Blue" custom="preserve me"');
  await fs.writeFile(sidecar, original);
  const session = await library.scan(photos), id = session.items[0].id;
  await library.decide(session.id, id, { flag: 'pick', rating: 5 });
  // Force the schedule that used to race the source equality assertion.
  await library.flushSidecars();
  const saved = await fs.readFile(sidecar, 'utf8');
  assert.notEqual(saved, original); assert.equal(readXmp(saved).rating, 5); assert.match(saved, /custom="preserve me"/);
  const copies = new TransferService(); t.after(() => copies.close());
  const result = await copies.copy(library.get(session.id), destination, { includeXmp: true });
  assert.equal(result.copied, 1); assert.deepEqual(result.failures, []);
  assert.equal(await fs.readFile(sidecar, 'utf8'), saved, 'Copying itself must not rewrite the source sidecar');
  assert.equal(await fs.readFile(path.join(photos, 'a.xmp.photocull-backup'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(destination, 'a.ARW'), 'utf8'), 'camera original');
  assert.equal(await fs.readFile(photo, 'utf8'), 'camera original');
  const xml = await fs.readFile(path.join(destination, 'a.xmp'), 'utf8');
  assert.equal(readXmp(xml).rating, 5); assert.match(xml, /custom="preserve me"/);
  const portable = readXmp(xml, normalizeSettings({}), { portable: true });
  assert.equal(portable.flag, 'pick'); assert.equal(portable.rating, 5);
});
test('default export excludes companion JPEGs and XMP; JPEG-only picks are copied', async t => {
  const { photos, destination, library } = await setup(t);
  for (const file of ['a.ARW', 'a.JPG', 'solo.JPG']) await fs.writeFile(path.join(photos, file), file);
  const result = await new TransferService().copy(await pickAll(library, photos), destination);
  assert.equal(result.copied, 2);
  assert.deepEqual((await fs.readdir(destination)).sort(), ['a.ARW', 'solo.JPG']);
  assert.deepEqual((await fs.readdir(photos)).sort(), ['a.ARW', 'a.JPG', 'solo.JPG']);
});
test('subfolders retain duplicate filenames; existing destination files are never overwritten', async t => {
  const { photos, destination, library } = await setup(t);
  for (const sub of ['100SONY', '101SONY']) { await fs.mkdir(path.join(photos, sub)); await fs.writeFile(path.join(photos, sub, 'a.ARW'), sub); }
  const session = await pickAll(library, photos, true);
  await fs.mkdir(path.join(destination, '100SONY')); await fs.writeFile(path.join(destination, '100SONY', 'a.ARW'), 'keep existing');
  const result = await new TransferService().copy(session, destination, { folders: {mode:'preserve',name:''} });
  assert.equal(result.copied, 1); assert.equal(result.skipped.length, 1);
  assert.equal(await fs.readFile(path.join(destination, '100SONY', 'a.ARW'), 'utf8'), 'keep existing');
  assert.equal(await fs.readFile(path.join(destination, '101SONY', 'a.ARW'), 'utf8'), '101SONY');
});
test('copy rejects source destinations, changed originals, and conflicting XMP names', async t => {
  const { photos, destination, library } = await setup(t);
  for (const file of ['a.ARW', 'a.DNG']) await fs.writeFile(path.join(photos, file), file);
  const session = await pickAll(library, photos), copies = new TransferService();
  await assert.rejects(copies.copy(session, photos), /outside the source/);
  const conflict = await copies.copy(session, destination, { includeXmp: true });
  assert.equal(conflict.skipped.length, 2); assert.equal(conflict.copiedFiles, 0);
  await fs.appendFile(path.join(photos, 'a.ARW'), 'changed');
  const changed = await copies.copy(session, destination);
  assert.equal(changed.failures.length, 1); assert.match(changed.failures[0].reason, /Source changed/);
  assert.equal(changed.copied, 1);
});
test('malformed source XMP fails the image cleanly; source and destination symlinks are refused', async t => {
  const { root, photos, destination, library } = await setup(t);
  await fs.mkdir(path.join(photos, 'sub')); await fs.writeFile(path.join(photos, 'sub', 'a.ARW'), 'original');
  let session = await pickAll(library, photos, true);
  await fs.writeFile(path.join(photos, 'sub', 'a.xmp'), 'bad xml');
  let result = await new TransferService().copy(session, destination, { includeXmp: true });
  assert.equal(result.failures.length, 1); assert.deepEqual(await fs.readdir(destination), []);
  const outside = path.join(root, 'outside'), linked = path.join(photos, 'linked-outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'a.ARW'), 'original'); await fs.symlink(outside, linked, 'junction');
  const escaped = { ...session, items: session.items.map(item => ({ ...item, path: path.join(linked, 'a.ARW') })) };
  result = await new TransferService().copy(escaped, destination);
  assert.equal(result.failures.length, 1); assert.match(result.failures[0].reason, /outside the source/);
  assert.deepEqual(await fs.readdir(destination), []);
  await fs.symlink(outside, path.join(destination, 'sub'), 'junction');
  result = await new TransferService().copy(session, destination, { folders: {mode:'preserve',name:''} });
  assert.equal(result.failures.length, 1); assert.deepEqual(await fs.readdir(outside), ['a.ARW']);
  assert.equal(await fs.readFile(path.join(outside, 'a.ARW'), 'utf8'), 'original');
  if (process.platform === 'win32') return; // File symlinks need Developer Mode on Windows.
  await fs.rm(path.join(destination, 'sub'));
  await fs.rename(path.join(photos, 'sub', 'a.ARW'), path.join(root, 'original.ARW'));
  await fs.symlink(path.join(root, 'original.ARW'), path.join(photos, 'sub', 'a.ARW'));
  result = await new TransferService().copy(session, destination);
  assert.equal(result.failures.length, 1);
});
test('cancel during a copy removes the incomplete image group and keeps completed groups', async t => {
  const { photos, destination, library } = await setup(t);
  await fs.writeFile(path.join(photos, 'a.ARW'), Buffer.alloc(100));
  await fs.writeFile(path.join(photos, 'b.ARW'), Buffer.alloc(4 * 1024 * 1024));
  const session = await pickAll(library, photos);
  const copies = new TransferService({ onProgress(p) { if (p.file === 'b.ARW' && p.bytesCopied > 100 && p.completed === 1) copies.cancel(); } });
  const result = await copies.copy(session, destination);
  assert.equal(result.state, 'canceled'); assert.equal(result.copied, 1);
  assert.deepEqual(await fs.readdir(destination), ['a.ARW']);
});

test('an altered companion is refused and concurrent copies cannot overlap', async t => {
  const { photos, destination, library } = await setup(t);
  await fs.writeFile(path.join(photos, 'a.ARW'), 'raw'); await fs.writeFile(path.join(photos, 'a.JPG'), 'jpeg');
  const session = await pickAll(library, photos);
  await fs.appendFile(path.join(photos, 'a.JPG'), 'changed');
  const copies = new TransferService(); const first = copies.copy(session, destination, { includeJpeg: true });
  await assert.rejects(copies.copy(session, destination), /already running/);
  const result = await first;
  assert.equal(result.failures.length, 1); assert.match(result.failures[0].reason, /Companion JPEG changed/);
  assert.deepEqual(await fs.readdir(destination), []);
});
