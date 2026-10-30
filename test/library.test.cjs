const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Library, groupFiles } = require('../src/library.cjs');
const { updateXmp, readXmp, writeXmp } = require('../src/xmp.cjs');

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('RAW + JPEG pairs are grouped without losing same-stem extra RAWs or JPEGs', () => {
  const make = name => ({ path: `/photos/${name}`, name, size: 42, mtimeMs: 100 });
  const items = groupFiles(['IMG_1.NEF', 'IMG_1.JPG', 'IMG_2.JPG', 'IMG_10.JPG', 'IMG_3.CR2', 'IMG_3.DNG', 'IMG_3.JPG'].map(make));
  assert.equal(items.length, 6);
  assert.equal(items[0].companion, '/photos/IMG_1.JPG');
  assert.equal(items[0].sidecar, '/photos/IMG_1.xmp');
  assert.equal(items[1].name, 'IMG_2.JPG');
  assert.equal(items[1].sidecar, '/photos/IMG_2.JPG.xmp');
  assert.equal(items.at(-1).name, 'IMG_10.JPG');
});

test('decisions survive reopen, undo/redo, and invalidate when a source changes', async t => {
  const root = await temp(t), photos = path.join(root, 'photos');
  await fs.mkdir(photos); await fs.writeFile(path.join(photos, 'a.jpg'), 'fixture');
  const library = new Library(path.join(root, 'state'));
  const s = await library.scan(photos); const item = s.items[0];
  await library.decide(s.id, item.id, { flag: 'pick', rating: 5 });
  assert.equal((await library.history(s.id, 'undo')).flag, 'none');
  assert.equal((await library.history(s.id, 'redo')).rating, 5);
  let reopened = await new Library(path.join(root, 'state')).scan(photos);
  assert.equal(reopened.items[0].flag, 'pick'); assert.equal(reopened.items[0].rating, 5);
  await fs.appendFile(path.join(photos, 'a.jpg'), 'changed');
  reopened = await new Library(path.join(root, 'state')).scan(photos);
  assert.equal(reopened.items[0].flag, 'none'); assert.equal(reopened.items[0].rating, 0);
  assert.equal(await fs.readFile(path.join(photos, 'a.jpg'), 'utf8'), 'fixturechanged');
});

test('XMP edits preserve unrelated metadata, namespaces and backups', async t => {
  const root = await temp(t), file = path.join(root, 'a.xmp');
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:xp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xp:Rating="2"><xp:Label>Blue</xp:Label><dc:creator><r:Seq><r:li>Photographer &amp; friends</r:li></r:Seq></dc:creator></r:Description></r:RDF></x:xmpmeta>`;
  await fs.writeFile(file, xml);
  await writeXmp(file, { flag: 'pick', rating: 4 });
  let result = await fs.readFile(file, 'utf8');
  assert.deepEqual(readXmp(result), { flag: 'pick', rating: 4 });
  assert.match(result, /Photographer &amp; friends/);
  assert.equal(await fs.readFile(file + '.photocull-backup', 'utf8'), xml);
  await writeXmp(file, { flag: 'reject', rating: 4 });
  result = await fs.readFile(file, 'utf8');
  assert.deepEqual(readXmp(result), { flag: 'reject', rating: 0 });
  assert.equal(await fs.readFile(file + '.photocull-backup', 'utf8'), xml);
  assert.throws(() => updateXmp('not xml', { flag: 'pick', rating: 1 }));
  assert.throws(() => updateXmp('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>', { flag: 'none', rating: 0 }));
});

test('unpaired same-stem RAWs report conflicting XMP paths without writing', async t => {
  const root = await temp(t);
  const photos = path.join(root, 'photos'); await fs.mkdir(photos);
  await fs.writeFile(path.join(photos, 'a.nef'), 'raw'); await fs.writeFile(path.join(photos, 'a.dng'), 'raw');
  const library = new Library(path.join(root, 'data')), s = await library.scan(photos);
  for (const item of s.items) await library.decide(s.id, item.id, { flag: 'pick' });
  const result = await library.exportXmp(s.id);
  assert.equal(result.written, 0); assert.equal(result.failures.length, 2);
  assert.deepEqual((await fs.readdir(photos)).sort(), ['a.dng', 'a.nef']);
});

test('XMP export leaves unedited images and existing color labels intact', async t => {
  const root = await temp(t), photos = path.join(root, 'photos'); await fs.mkdir(photos);
  await fs.writeFile(path.join(photos, 'a.jpg'), 'jpeg');
  await fs.writeFile(path.join(photos, 'b.jpg'), 'jpeg');
  const file = path.join(photos, 'a.jpg.xmp');
  const xmp = updateXmp('', { flag: 'none', rating: 3 }).replace('xmp:Label=""', 'xmp:Label="Blue"');
  await fs.writeFile(file, xmp);
  const library = new Library(path.join(root, 'data')), s = await library.scan(photos);
  assert.equal((await library.exportXmp(s.id)).written, 0);
  assert.equal(await fs.readFile(file, 'utf8'), xmp);
  const item = s.items.find(i => i.name === 'b.jpg');
  await library.decide(s.id, item.id, { flag: 'pick' });
  await library.decide(s.id, item.id, { flag: 'none' });
  assert.equal((await library.exportXmp(s.id)).written, 1, 'An explicit cleared decision must also export');
  assert.equal(await fs.readFile(file, 'utf8'), xmp);
  const a = s.items.find(i => i.name === 'a.jpg');
  await library.decide(s.id, a.id, { rating: 4 });
  assert.equal((await library.exportXmp(s.id)).written, 2);
  assert.match(await fs.readFile(file, 'utf8'), /xmp:Label="Blue"/, 'A star edit must preserve unmanaged color labels');
});

test('recursive scan is optional and skips symlinks', async t => {
  const root = await temp(t), photos = path.join(root, 'photos');
  await fs.mkdir(path.join(photos, 'sub'), { recursive: true });
  await fs.writeFile(path.join(photos, 'a.jpg'), 'jpeg');
  await fs.writeFile(path.join(photos, 'sub', 'b.jpg'), 'jpeg');
  await fs.symlink(photos, path.join(photos, 'cycle'));
  const library = new Library(path.join(root, 'data'));
  assert.equal((await library.scan(photos)).items.length, 1);
  assert.equal((await library.scan(photos, true)).items.length, 2);
});

test('burst decisions share queued durable writes and every decision survives reopen', async t => {
  const root=await temp(t),photos=path.join(root,'photos');await fs.mkdir(photos);
  for(let i=0;i<60;i++)await fs.writeFile(path.join(photos,`photo${i}.JPG`),'jpeg');
  const library=new Library(path.join(root,'state')),session=await library.scan(photos);
  await Promise.all(session.items.map(item=>library.decide(session.id,item.id,{flag:'pick',rating:4})));
  assert.ok(library.stats.sessionWrites<10);
  const reopened=await new Library(path.join(root,'state')).scan(photos);
  assert.ok(reopened.items.every(item=>item.flag==='pick'&&item.rating===4));
});
