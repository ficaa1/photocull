const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Library } = require('../src/library.cjs');
const { DEFAULTS } = require('../src/preferences.cjs');

async function fixture(t, names, removable = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-batch-')));
  const dir = path.join(root, 'photos');
  await fs.mkdir(dir);
  for (const name of names) await fs.writeFile(path.join(dir, name), name);
  const lib = new Library(root, { settings: () => ({ ...DEFAULTS, writeSidecars: 'never' }) });
  t.after(async () => { await lib.close(); await fs.rm(root, { recursive: true }); });
  const session = await lib.scan(dir, false, { removable });
  const ids = session.items.map(i => i.id);
  return { lib, dir, session, ids, run: (action, config = {}, picked = ids) =>
    lib.batchRename(session.id, picked, config, action, async () => '2026:04:07') };
}

test('rename preview formats tokens, plain text and regex with per-row validation', async t => {
  const { run } = await fixture(t, ['Img_a.jpg', 'img_b.JPG']);
  const config = { mode: 'both', template: '{capturedate}-{filename}-{text}-{seq}', text: 'print', start: 8, padding: 2, find: 'IMG_', replace: '' };
  const preview = await run('preview', config);
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.rows.map(r => r.after), ['20260407-a-print-08.jpg', '20260407-b-print-09.JPG']);
  assert.equal((await run('preview', { ...config, caseSensitive: true })).rows[0].after, '20260407-Img_a-print-08.jpg');
  const regex = { mode: 'find-replace', find: '^img_(.)$', replace: 'Photo-$1', useRegex: true };
  assert.deepEqual((await run('preview', regex)).rows.map(r => r.after), ['Photo-a.jpg', 'Photo-b.JPG']);
  for (const patch of [{ find: '[' }, { replace: '/' }, { replace: '' }, { replace: 'CON' }]) {
    const bad = await run('preview', { ...regex, ...patch });
    assert.equal(bad.valid, false); assert.ok(bad.rows.every(r => r.error));
  }
  const unchanged = await run('preview');
  assert.equal(unchanged.valid, false); assert.ok(unchanged.rows.every(r => r.unchanged));
});

test('reserved Windows device stems are invalid even with a suffix', async t => {
  const { run } = await fixture(t, ['one.jpg']);
  for (const template of ['COM¹', 'LPT²', 'com³ .proof', 'lpt0', 'aux .jpg', 'NUL... ']) {
    const preview = await run('preview', { template });
    assert.match(preview.rows[0].error, /invalid/i, template);
  }
  assert.ok((await run('preview', { template: 'COM¹-studio' })).valid);
});

test('every colliding target is reported including sidecars and case variants on disk', async t => {
  const { run, dir, ids } = await fixture(t, ['one.jpg', 'Two.JPG']);
  assert.ok((await run('preview', { template: 'same' })).rows.every(r => /collision/i.test(r.error)));
  for (const name of ['SAME.JPG', 'same.XMP', 'Same.JPG.xmp']) {
    const file = path.join(dir, name); await fs.writeFile(file, 'keep');
    const result = await run('preview', { template: 'same' }, [ids[0]]);
    assert.equal(result.valid, false);
    await assert.rejects(run('apply', { template: 'same' }, [ids[0]]), /collision/i);
    assert.equal(await fs.readFile(file, 'utf8'), 'keep'); await fs.unlink(file);
  }
});

test('swaps stage both groups, preserve decisions across rescans and undo each mixed-case member', async t => {
  const names = ['1.ARW', '1.JPG', '1.XMP', '1.ARW.xmp', '1.JPG.XMP', '2.ARW', '2.JPG', '2.XMP', '2.ARW.xmp', '2.JPG.XMP'];
  const { lib, dir, session, run, ids } = await fixture(t, names);
  await lib.decide(session.id, ids[0], { rating: 4, flag: 'pick', color: '2' });
  await lib.developSet(session.id, [ids[0]], { recipe: 'neutral' });
  const config = { template: '{seq}', padding: 1, start: 1 };
  const result = await run('apply', config, ids.slice().reverse());
  assert.equal(result.canUndo, true);
  for (const name of names) assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), (name[0] === '1' ? '2' : '1') + name.slice(1));
  const reopened = await new Library(lib.dataDir).scan(dir);
  const moved = reopened.items.find(i => i.name === '2.ARW');
  assert.deepEqual([moved.rating, moved.flag, moved.color, moved.recipe], [4, 'pick', '2', 'neutral']);
  await run('undo');
  for (const name of names) assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), name);
});

test('case-only rename restores the exact companion and sidecar spellings', async t => {
  const names = ['photo.ARW', 'Photo.JPG', 'Photo.JPG.xmp'];
  const { run, dir } = await fixture(t, names);
  await run('apply', { template: 'PHOTO' });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['PHOTO.ARW', 'PHOTO.JPG', 'PHOTO.JPG.xmp']);
  await run('undo');
  assert.deepEqual((await fs.readdir(dir)).sort(), names.sort());
});

test('a destination appearing during publication rolls back files and session without clobbering it', async t => {
  const names = ['IMG.ARW', 'IMG.JPG', 'IMG.xmp'];
  const { run, dir, lib, ids, session } = await fixture(t, names);
  const link = fs.link, collision = path.join(dir, 'new.JPG');
  const intercept = t.mock.method(fs, 'link', async (from, to) => {
    if (to === collision) await fs.writeFile(to, 'another application', { flag: 'wx' });
    return link(from, to);
  });
  await assert.rejects(run('apply', { template: 'new' }), /EEXIST/);
  intercept.mock.restore();
  assert.equal(await fs.readFile(collision, 'utf8'), 'another application');
  assert.deepEqual((await fs.readdir(dir)).sort(), [...names, 'new.JPG'].sort());
  for (const name of names) assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), name);
  assert.equal(lib.item(session.id, ids[0]).name, 'IMG.ARW');
  await assert.rejects(run('undo'), /No batch/);
});

test('a link-less volume can swap and undo files and refuses a racing destination', async t => {
  const { run, dir, ids } = await fixture(t, ['1.jpg', '2.jpg']);
  const collision = path.join(dir, 'new.jpg');
  let occupy = false;
  t.mock.method(fs, 'link', async (from, to) => {
    if (occupy && to === collision) await fs.writeFile(to, 'foreign', { flag: 'wx' });
    throw Object.assign(new Error('Hard links unsupported'), { code: 'ENOTSUP' });
  });
  await run('apply', { template: '{seq}', padding: 1 }, ids.slice().reverse());
  assert.equal(await fs.readFile(path.join(dir, '1.jpg'), 'utf8'), '2.jpg');
  await run('undo');
  occupy = true;
  await assert.rejects(run('apply', { template: 'new' }, [ids[0]]), /collision/i);
  for (const name of ['1.jpg', '2.jpg']) assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), name);
  assert.equal(await fs.readFile(collision, 'utf8'), 'foreign');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['1.jpg', '2.jpg', 'new.jpg']);
});

test('staging leaves a replacement at the public source intact', async t => {
  const { run, dir } = await fixture(t, ['one.jpg']);
  const source = path.join(dir, 'one.jpg'), replacement = path.join(dir, 'incoming');
  await fs.writeFile(replacement, 'new exposure');
  const rename = fs.rename, unlink = fs.unlink;
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (from === source) await rename(replacement, source);
  });
  t.mock.method(fs, 'unlink', async file => {
    if (file === source) await rename(replacement, source);
    return unlink(file);
  });
  await run('apply', { template: 'moved' });
  assert.equal(await fs.readFile(source, 'utf8'), 'new exposure');
  assert.equal(await fs.readFile(path.join(dir, 'moved.jpg'), 'utf8'), 'one.jpg');
});

test('a replacement arriving just before staging is returned to its owner', async t => {
  const { run, dir, lib, ids, session } = await fixture(t, ['one.jpg']);
  const source = path.join(dir, 'one.jpg'), moved = path.join(dir, 'outside.jpg');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from === source) {
      await rename(source, moved);
      await fs.writeFile(source, 'foreign replacement', { flag: 'wx' });
    }
    return rename(from, to);
  });
  await assert.rejects(run('apply', { template: 'picked' }), /Recovery required/);
  assert.equal(await fs.readFile(source, 'utf8'), 'foreign replacement');
  assert.equal(await fs.readFile(moved, 'utf8'), 'one.jpg');
  assert.throws(() => lib.item(session.id, ids[0]), /session has closed/);
  await assert.rejects(fs.access(path.join(dir, 'picked.jpg')), { code: 'ENOENT' });
});

test('an occupied original during rollback closes the session and locates the recoverable photo', async t => {
  const { run, dir, session, ids, lib } = await fixture(t, ['one.ARW', 'one.JPG']);
  const original = path.join(dir, 'one.ARW'), target = path.join(dir, 'new.JPG');
  const link = fs.link;
  t.mock.method(fs, 'link', async (from, to) => {
    if (to === target) {
      await fs.writeFile(original, 'foreign RAW', { flag: 'wx' });
      await fs.writeFile(target, 'foreign JPEG', { flag: 'wx' });
    }
    return link(from, to);
  });
  const error = await run('apply', { template: 'new' }).catch(e => e);
  assert.match(error.message, /Recovery required/);
  assert.throws(() => lib.item(session.id, ids[0]), /session has closed/);
  const recoverable = (await fs.readdir(dir, { recursive: true })).map(p => path.join(dir, p));
  const raw = (await Promise.all(recoverable.map(async p => await fs.readFile(p, 'utf8').catch(() => null) === 'one.ARW' ? p : null))).find(Boolean);
  assert.ok(raw && error.message.includes(raw) && error.message.includes(original));
  assert.equal(await fs.readFile(original, 'utf8'), 'foreign RAW');
  assert.equal(await fs.readFile(target, 'utf8'), 'foreign JPEG');
  assert.equal(await fs.readFile(path.join(dir, 'one.JPG'), 'utf8'), 'one.JPG');
});

test('a foreign sidecar arriving during publication prevents adoption', async t => {
  const { run, dir, lib, ids, session } = await fixture(t, ['one.JPG']);
  const link = fs.link, late = path.join(dir, 'New.XMP');
  t.mock.method(fs, 'link', async (from, to) => {
    await link(from, to);
    if (to === path.join(dir, 'new.JPG')) await fs.writeFile(late, 'foreign sidecar', { flag: 'wx' });
  });
  await assert.rejects(run('apply', { template: 'new' }), /sidecar|collision/i);
  await lib.decide(session.id, ids[0], { rating: 5 });
  await lib.exportXmp(session.id);
  assert.equal(lib.item(session.id, ids[0]).name, 'one.JPG');
  assert.equal(await fs.readFile(late, 'utf8'), 'foreign sidecar');
});

test('XMP autosave never claims a sidecar added after publication', async t => {
  const { run, dir, lib, ids, session } = await fixture(t, ['one.JPG']);
  await run('apply', { template: 'new' });
  const sidecar = path.join(dir, 'new.xmp');
  const { updateXmp } = require('../src/xmp.cjs');
  const foreign = updateXmp('', { rating: 2, flag: 'pick' });
  await fs.writeFile(sidecar, foreign);
  lib.settings = () => DEFAULTS;
  await lib.decide(session.id, ids[0], { rating: 5 });
  await lib.flushSidecars();
  assert.equal(await fs.readFile(sidecar, 'utf8'), foreign);
  assert.equal((await lib.exportXmp(session.id)).written, 0);
  assert.equal(await fs.readFile(sidecar, 'utf8'), foreign);
});

test('undo refuses a companion captured after the rename', async t => {
  const { run, dir, lib, session, ids } = await fixture(t, ['one.ARW']);
  await run('apply', { template: 'new' });
  const jpeg = path.join(dir, 'new.JPG');
  await fs.writeFile(jpeg, 'new JPEG');
  await lib.ingestCapture(session.id, { path: jpeg, exposureId: 'new' });
  assert.equal(lib.item(session.id, ids[0]).companion, jpeg);
  await assert.rejects(run('undo'), /changed/);
  assert.equal(await fs.readFile(jpeg, 'utf8'), 'new JPEG');
  assert.equal(await fs.readFile(path.join(dir, 'new.ARW'), 'utf8'), 'one.ARW');
});

test('undo keeps edits written to a recorded sidecar', async t => {
  const { dir, lib } = await fixture(t, ['one.JPG', 'one.xmp']);
  const { updateXmp, readXmp } = require('../src/xmp.cjs');
  await fs.writeFile(path.join(dir, 'one.xmp'), updateXmp('', { rating: 2, flag: 'pick' }));
  const fresh = await lib.scan(dir);
  const batch = (action, config = {}) => lib.batchRename(fresh.id, [fresh.items[0].id], config, action);
  await batch('apply', { template: 'new' });
  await lib.decide(fresh.id, fresh.items[0].id, { rating: 5 });
  assert.equal((await lib.exportXmp(fresh.id)).written, 1);
  await batch('undo');
  assert.equal(readXmp(await fs.readFile(path.join(dir, 'one.xmp'), 'utf8')).rating, 5);
  assert.equal(await fs.readFile(path.join(dir, 'one.JPG'), 'utf8'), 'one.JPG');
});

test('rename refuses camera cards, changed members, and unsafe undo', async t => {
  const card = await fixture(t, ['photo.jpg'], true);
  await assert.rejects(card.run('apply', { template: 'new' }), /camera card/);
  for (const changed of ['one.ARW', 'one.JPG', 'one.xmp']) {
    const { run, dir } = await fixture(t, ['one.ARW', 'one.JPG', 'one.xmp']);
    await fs.appendFile(path.join(dir, changed), 'edited');
    await assert.rejects(run('apply', { template: 'new' }), /changed since scan/);
  }
  const { run, dir } = await fixture(t, ['one.ARW', 'one.JPG', 'one.xmp']);
  await run('apply', { template: 'new' });
  await fs.writeFile(path.join(dir, 'ONE.XMP'), 'keep');
  await assert.rejects(run('undo'), /collision/i);
  await fs.unlink(path.join(dir, 'ONE.XMP'));
  await fs.unlink(path.join(dir, 'new.JPG'));
  await assert.rejects(run('undo'), /changed since scan/);
  assert.equal(await fs.readFile(path.join(dir, 'new.ARW'), 'utf8'), 'one.ARW');
});

test('the sidecar serializes rename against deletion, copying, tethering and newly inserted cards', async t => {
  const { spawn } = require('node:child_process');
  const readline = require('node:readline');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-rename-jobs-')));
  const photos = path.join(root, 'photos'), list = path.join(root, 'devices.json');
  await fs.mkdir(photos); await fs.writeFile(path.join(photos, 'one.jpg'), 'original'); await fs.writeFile(list, '[]');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/backend.cjs')], {
    stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PHOTOCULL_SMOKE_TEST: '1', PHOTOCULL_DATA_DIR: path.join(root, 'data'), PHOTOCULL_TEST_DEVICES: list }
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.stdin.end(); await exited; await fs.rm(root, { recursive: true }); });
  const input = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.ok(JSON.parse((await input.next()).value).ready);
  let seq = 0;
  const send = (method, ...params) => {
    const id = ++seq; child.stdin.write(JSON.stringify({ method, params, id }) + '\n'); return id;
  };
  const pending = new Map();
  const reply = async id => {
    while (!pending.has(id)) {
      const entry = JSON.parse((await input.next()).value); if (entry.id) pending.set(entry.id, entry);
    }
    return pending.get(id);
  };
  const { value: session } = await reply(send('scan', photos, false)), ids = session.items.map(i => i.id);
  const rename = () => send('batch-rename-apply', session.id, ids, { template: 'new' });
  assert.ok((await reply(send('deletion-plan', session.id, ids))).ok);
  assert.match((await reply(rename())).error, /file operation/);
  await reply(send('deletion-end'));
  await fs.writeFile(list, JSON.stringify([{ root: photos, identity: 'new-card' }]));
  assert.match((await reply(rename())).error, /camera card/);
  await fs.writeFile(list, '[]');
  const applying = rename(), copy = send('copy-picks', session.id, root, {});
  assert.ok((await reply(applying)).ok);
  assert.match((await reply(copy)).error, /batch rename/);
  assert.ok((await reply(send('tether-bind', photos, null, 'single', false, session.id))).ok);
  assert.match((await reply(send('batch-rename-undo', session.id))).error, /tether/);
  assert.equal(await fs.readFile(path.join(photos, 'new.jpg'), 'utf8'), 'original');
});

test('persistence failure restores original files, session indexes and the previous undo record', async t => {
  const { run, dir, lib, session, ids } = await fixture(t, ['first.jpg']);
  await run('apply', { template: 'second' });
  const store = lib.get(session.id).store;
  await fs.unlink(store); await fs.mkdir(store);
  await assert.rejects(run('apply', { template: 'third' }));
  assert.equal(lib.item(session.id, ids[0]).name, 'second.jpg');
  assert.equal(lib.get(session.id).byPath.get(path.join(dir,'second.jpg')), ids[0]);
  assert.deepEqual(await fs.readdir(dir), ['second.jpg']);
  await fs.rmdir(store);
  await run('undo');
  assert.equal(await fs.readFile(path.join(dir, 'first.jpg'), 'utf8'), 'first.jpg');
});

test('a camera can reuse a freed name without inheriting the renamed photo’s decisions', async t => {
  const { lib, session, ids, dir, run } = await fixture(t, ['one.JPG']);
  await lib.decide(session.id, ids[0], { rating: 5 });
  await run('apply', { template: 'favorite' });
  await fs.writeFile(path.join(dir, 'one.JPG'), 'new exposure');
  const next = await lib.ingestCapture(session.id, { path: path.join(dir, 'one.JPG'), exposureId: 'next' });
  assert.notEqual(next.itemId, ids[0]);
  assert.equal(lib.item(session.id, ids[0]).name, 'favorite.JPG');
  assert.equal(lib.item(session.id, next.itemId).rating, 0);
  await assert.rejects(run('undo'), /sidecar name|collision/);
  const reopened = await lib.scan(dir);
  assert.deepEqual(reopened.items.map(i => [i.name, i.rating]), [['favorite.JPG', 5], ['one.JPG', 0]]);
});

test('undo restores distinct original formats that shared an unused sidecar name', async t => {
  const { lib, dir, session, ids, run } = await fixture(t, ['one.ARW', 'one.NEF']);
  for (const selection of [ids, ids.slice(0,1)]) {
    await run('apply', { template: 'frame-{seq}' }, selection);
    await run('undo');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['one.ARW', 'one.NEF']);
    assert.equal(lib.get(session.id).items.length, 2);
  }
});
