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

test('batch decisions save once, undo/redo together and survive reopen', async t => {
  const root = await temp(t), photos = path.join(root, 'photos'); await fs.mkdir(photos);
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await fs.writeFile(path.join(photos, name), 'fixture');
  const data = path.join(root, 'state'), library = new Library(data), s = await library.scan(photos);
  const [a, b, c] = s.items, ids = [a.id, b.id];
  await library.decide(s.id, a.id, { rating: 2, color: '1' });
  const writes = library.stats.sessionWrites;
  const patch = { flag: 'pick', rating: 5, color: '3', trashed: true };
  const result = await library.decideMany(s.id, ids, patch);
  assert.deepEqual(result, { items: ids.map(id => ({ id, ...patch, edited: true })) });
  assert.equal(library.stats.sessionWrites, writes + 1);
  assert.equal(library.get(s.id).undo.length, 2);
  assert.deepEqual(library.get(s.id).undo.at(-1).batch.map(entry => entry.id), ids);
  const undone = await library.history(s.id, 'undo');
  assert.deepEqual(undone.items, [
    { id: a.id, flag: 'none', rating: 2, color: '1', trashed: false, edited: true },
    { id: b.id, flag: 'none', rating: 0, color: null, trashed: false, edited: true },
  ]);
  assert.deepEqual(await library.history(s.id, 'redo'), result);
  assert.equal(library.item(s.id, c.id).flag, 'none');
  const reopened = await new Library(data).scan(photos);
  for (const item of reopened.items.slice(0, 2)) for (const [key, value] of Object.entries(patch)) assert.equal(item[key], value);
  assert.equal(reopened.items[2].edited, false);
  await library.history(s.id, 'undo');
  await library.decideMany(s.id, ids, { color: '' });
  assert.equal(await library.history(s.id, 'redo'), null, 'a new batch clears redo');
});

test('batch validation is atomic, deduplicates ids and retains the 500-action cap', async t => {
  const root = await temp(t), photos = path.join(root, 'photos'); await fs.mkdir(photos);
  await fs.writeFile(path.join(photos, 'a.jpg'), 'fixture');
  const library = new Library(path.join(root, 'state')), s = await library.scan(photos), id = s.items[0].id;
  for (const ids of [null, id, [], Array(100_001).fill(id)]) await assert.rejects(library.decideMany(s.id, ids, { flag: 'pick' }), /Choose photos/);
  await assert.rejects(library.decideMany(s.id, [id, 'missing'], { flag: 'pick' }), /not in this folder session/);
  assert.equal(library.item(s.id, id).flag, 'none');
  assert.equal(library.get(s.id).undo.length, 0); assert.equal(library.stats.sessionWrites, 0);
  const result = await library.decideMany(s.id, [id, id], { flag: 'pick', rating: 9, color: '9' });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].rating, 0); assert.equal(result.items[0].color, null);
  await Promise.all(Array.from({ length: 501 }, () => library.decideMany(s.id, [id], { rating: 4 })));
  assert.equal(library.get(s.id).undo.length, 500);
});

test('forget prunes deleted ids and empty batches from both undo and redo', async t => {
  const root = await temp(t), photos = path.join(root, 'photos'); await fs.mkdir(photos);
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await fs.writeFile(path.join(photos, name), 'fixture');
  const library = new Library(path.join(root, 'state')), s = await library.scan(photos), [a, b, c] = s.items;
  await library.decideMany(s.id, [a.id], { rating: 2 });
  await library.decideMany(s.id, [a.id, b.id], { flag: 'pick' });
  await library.decideMany(s.id, [a.id, c.id], { color: '3' });
  await library.decideMany(s.id, [a.id], { trashed: true });
  await library.history(s.id, 'undo'); await library.history(s.id, 'undo');
  await library.forget(s.id, [a.id]);
  assert.deepEqual(library.get(s.id).undo.map(action => action.batch.map(entry => entry.id)), [[b.id]]);
  assert.deepEqual(library.get(s.id).redo.map(action => action.batch.map(entry => entry.id)), [[c.id]]);
  assert.deepEqual((await library.history(s.id, 'redo')).items.map(i => [i.id, i.color]), [[c.id, '3']]);
  await library.history(s.id, 'undo');
  assert.deepEqual((await library.history(s.id, 'undo')).items.map(i => [i.id, i.flag]), [[b.id, 'none']]);
  assert.equal(await library.history(s.id, 'undo'), null);
  const saved = JSON.parse(await fs.readFile(library.get(s.id).store, 'utf8'));
  assert.deepEqual(Object.keys(saved.decisions), [b.id, c.id]);
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

test('a deletion plan lists images with companions, and sidecars with all their owners', async t => {
  const root = await temp(t), photos = path.join(root, 'photos');
  await fs.mkdir(photos);
  for (const name of ['A.NEF', 'A.JPG', 'A.xmp', 'B.JPG', 'C.CR2', 'C.DNG']) await fs.writeFile(path.join(photos, name), 'fixture');
  await fs.writeFile(path.join(photos, 'C.xmp'), 'shared');
  const library = new Library(path.join(root, 'state'));
  const s = await library.scan(photos);
  const id = name => s.items.find(i => i.name === name).id;
  const plan = await library.deletionPlan(s.id, [id('A.NEF'), id('B.JPG'), id('C.CR2')]);
  const files = Object.fromEntries(plan.photos.map(p => [p.name, p.files.map(f => path.basename(f))]));
  assert.deepEqual(files['A.NEF'], ['A.NEF', 'A.JPG']);
  assert.deepEqual(files['B.JPG'], ['B.JPG']);
  assert.deepEqual(files['C.CR2'], ['C.CR2']);
  assert.deepEqual(plan.sidecars.map(x => [path.basename(x.file), x.owners]), [['A.xmp', [id('A.NEF')]]],
    'a missing sidecar is not listed, and C.xmp stays while C.DNG uses it');
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.removable, false);
  const both = await library.deletionPlan(s.id, [id('C.CR2'), id('C.DNG')]);
  assert.deepEqual(both.sidecars.map(x => [path.basename(x.file), x.owners.sort()]), [['C.xmp', [id('C.CR2'), id('C.DNG')].sort()]],
    'a shared sidecar is listed once, owned by both photos');
  await assert.rejects(library.deletionPlan(s.id, []), /Choose photos/);
  await assert.rejects(library.deletionPlan(s.id, ['missing']), /not in this folder session/);
});

test('a deletion plan skips photos that changed since the scan and refuses a replaced folder', async t => {
  const root = await temp(t), photos = path.join(root, 'photos');
  await fs.mkdir(photos);
  for (const name of ['A.JPG', 'B.JPG', 'C.JPG']) await fs.writeFile(path.join(photos, name), 'fixture');
  const library = new Library(path.join(root, 'state'));
  const s = await library.scan(photos);
  const id = name => s.items.find(i => i.name === name).id;
  await fs.writeFile(path.join(photos, 'B.JPG'), 'another card');
  // Same name and size, another file: a different card's photo has its own timestamp.
  await fs.rm(path.join(photos, 'C.JPG')); await fs.writeFile(path.join(photos, 'C.JPG'), 'fixture');
  await fs.utimes(path.join(photos, 'C.JPG'), new Date('2001-01-01'), new Date('2001-01-01'));
  const plan = await library.deletionPlan(s.id, [id('A.JPG'), id('B.JPG'), id('C.JPG')]);
  assert.deepEqual(plan.photos.map(p => p.name), ['A.JPG']);
  assert.deepEqual(plan.skipped.map(p => p.name).sort(), ['B.JPG', 'C.JPG'], 'rewritten and replaced files are skipped');
  // A different folder (or card) mounted at the same path.
  await fs.rename(photos, path.join(root, 'old'));
  await fs.mkdir(photos); await fs.writeFile(path.join(photos, 'A.JPG'), 'fixture');
  await assert.rejects(library.deletionPlan(s.id, [id('A.JPG')]), /folder has changed/);
  // The folder replaced by a symlink to another one.
  await fs.rm(photos, { recursive: true }); await fs.symlink(path.join(root, 'old'), photos);
  await assert.rejects(library.deletionPlan(s.id, [id('A.JPG')]), /folder has changed/);
});

test('forgetting deleted photos drops them from the session, history and saved decisions', async t => {
  const root = await temp(t), photos = path.join(root, 'photos');
  await fs.mkdir(photos);
  for (const name of ['a.jpg', 'b.jpg']) await fs.writeFile(path.join(photos, name), 'fixture');
  const library = new Library(path.join(root, 'state'));
  const s = await library.scan(photos, false, { removable: true });
  assert.equal(s.removable, true);
  const [a, b] = s.items;
  await library.decide(s.id, a.id, { flag: 'reject' });
  await library.decide(s.id, b.id, { flag: 'pick' });
  await library.forget(s.id, [a.id]);
  assert.deepEqual(library.get(s.id).items.map(i => i.id), [b.id]);
  assert.throws(() => library.item(s.id, a.id), /not in this folder session/);
  assert.equal((await library.history(s.id, 'undo')).id, b.id);
  assert.equal(await library.history(s.id, 'undo'), null, 'undo skips the deleted photo');
  const saved = JSON.parse(await fs.readFile(library.get(s.id).store, 'utf8'));
  assert.deepEqual(Object.keys(saved.decisions), [b.id]);
});

test('Dehancer edit paths and preview revisions survive reopen and RAW adjustments preserve the edit', async t => {
  const root=await temp(t),photos=path.join(root,'photos'),state=path.join(root,'state');await fs.mkdir(photos);await fs.writeFile(path.join(photos,'photo.ARW'),'original');
  const library=new Library(state),session=await library.scan(photos),id=session.items[0].id,tiff=path.join(root,'photo.tif');
  await library.developMark(session.id,id,{tiff});await library.developMark(session.id,id,{edited:true});
  let saved=library.developGet(session.id,id);assert.equal(saved.edited,true);assert.equal(saved.revision,2);
  await library.developSet(session.id,[id],{settings:{light:{exposure:1}}});saved=library.developGet(session.id,id);assert.equal(saved.edited,true);assert.equal(saved.tiff,tiff);assert.equal(saved.revision,2);
  const reopened=new Library(state),again=await reopened.scan(photos);assert.equal(again.items[0].dehancer,true);assert.equal(again.items[0].tiff,tiff);assert.equal(again.items[0].developRevision,2);
  await reopened.developMark(again.id,id,{edited:true});assert.equal(reopened.developGet(again.id,id).revision,3);
  await reopened.developMark(again.id,id,{tiff});assert.equal(reopened.developGet(again.id,id).edited,false);
});
