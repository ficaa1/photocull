const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { options, FORMATS, MODES, PRESETS } = require('../src/renderer/export.js');
const { planExport } = require('../src/develop.cjs');
const { normalizeSettings } = require('../src/preferences.cjs');

test('finished-image formats map to supported depths, settings and effective color spaces', () => {
  for (const [format, spec] of Object.entries(FORMATS)) {
    for (const bitDepth of spec.depths) assert.equal(options({ format, bitDepth }).bitDepth, bitDepth);
    assert.throws(() => options({ format, bitDepth: 12 }), /bit depth/i);
    assert.equal(options({ format }).bitDepth, spec.depths[0]);
  }
  assert.equal(options({ format: 'avif', colorSpace: 'proPhoto' }).colorSpace, 'srgb');
  assert.equal(options({ format: 'jxl', colorSpace: 'adobeRgb' }).colorSpace, 'rec2020');
  assert.equal(options({ format: 'jxl', colorSpace: 'proPhoto', jxlLossless: true }).colorSpace, 'proPhoto');
  assert.equal(options({ format: 'png', limitKb: 100, jxlLossless: true }).limitKb, null);
  assert.equal(options({ format: 'png', jxlLossless: true }).jxlLossless, false);
  assert.equal(options({ format: 'jpeg', limitKb: '1024' }).limitKb, 1024);
  assert.equal(options({ format: 'tiff' }).tiffCompression, 'None');
  assert.equal(options({ format: 'tiff', tiffCompression: 'deflate' }).tiffCompression, 'Deflate');
  assert.equal(options({ format: 'tiff', tiffCompression: 'Deflate' }).tiffCompression, 'Deflate');
  for (const preset of PRESETS) assert.doesNotThrow(() => options(preset.options));
});

test('sizing, sharpening, metadata and last-used export settings validate instead of silently defaulting', () => {
  for (const mode of Object.keys(MODES).filter(m => m !== 'none')) {
    const resize = { mode, value: 12.5, height: 500, dontEnlarge: false };
    assert.deepEqual(options({ resize }).resize, resize);
  }
  for (const patch of [{ quality: 0 }, { quality: 101 }, { quality: NaN }, { ppi: 0 }, { format: 'original' }, { colorSpace: 'bad' }, { metadata: 'bad' }, { resize: { value: 0 } }, { resize: { value: Infinity } }, { limitKb: -1 }, { jxlEffort: 'slow', format: 'jxl' }]) assert.throws(() => options(patch));
  const input = { format: 'jxl', quality: 88, bitDepth: 16, jxlLossless: true, jxlEffort: 'fast', jxlProgressive: true, colorSpace: 'displayP3', sharpen: 'matte', sharpenAmount: 'high', metadata: 'copyright', removeLocation: true };
  assert.deepEqual(normalizeSettings({ exportOptions: input }).exportOptions, options(input));
  assert.throws(() => normalizeSettings({ exportOptions: { format: 'jpeg', bitDepth: 16 } }));
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const items = [{ id: 'a', name: 'IMG.ARW', path: path.join(root, 'IMG.ARW') }, { id: 'b', name: 'img.NEF', path: path.join(root, 'img.NEF') }];
  return { root, items, plan: opts => planExport(items, { folder: root, extension: 'jpg', ...opts }) };
}

test('export planner allocates unique names around existing files and duplicates case-insensitively', async t => {
  const { root, plan } = await fixture(t);
  await fs.writeFile(path.join(root, 'IMG.jpg'), 'keep');
  const result = await plan();
  assert.deepEqual(result.map(p => path.basename(p.dest)), ['IMG-2.jpg', 'img-3.jpg']);
  assert.equal(await fs.readFile(path.join(root, 'IMG.jpg'), 'utf8'), 'keep');
});

test('export planner reports all duplicate rows before overwrite/skip and preserves sequence numbers', async t => {
  const { plan } = await fixture(t);
  for (const conflict of ['overwrite', 'skip']) {
    const rows = await plan({ conflict });
    assert.equal(rows.filter(r => r.error).length, 2);
  }
  const rows = await plan({ naming: { template: '{text}_{seq:3}', text: 'Trip', start: 7 }, subfolder: 'Finished' });
  assert.deepEqual(rows.map(r => path.basename(r.dest)), ['Trip_007.jpg', 'Trip_008.jpg']);
  assert.equal(path.basename(path.dirname(rows[0].dest)), 'Finished');
});

test('export planner handles skip, overwrite, invalid names/dates and source protection', async t => {
  const { root, items, plan } = await fixture(t);
  await fs.writeFile(path.join(root, 'IMG.jpg'), 'keep');
  assert.equal((await planExport([items[0]], { folder: root, extension: 'jpg', conflict: 'skip' }))[0].skip, true);
  assert.equal((await planExport([items[0]], { folder: root, extension: 'jpg', conflict: 'overwrite' }))[0].skip, undefined);
  for (const subfolder of ['../escape', 'CON', 'trailing.', 'bad/name', 1]) await assert.rejects(plan({ subfolder }));
  for (const extension of ['arw', '../jpg', undefined]) await assert.rejects(plan({ extension }));
  const missing = await plan({ naming: { template: '{capturedate}_{filename}' }, captureDate: async () => null });
  assert.ok(missing.every(r => r.error));
  const image = { id: 'c', name: 'IMG.jpg', path: path.join(root, 'IMG.jpg') };
  const protectedResult = await planExport([image], { folder: root, extension: 'jpg', conflict: 'overwrite' });
  assert.match(protectedResult[0].error, /replace a source/);
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'alias'); await fs.symlink(root, alias);
    assert.match((await planExport([image], { folder: alias, extension: 'jpg', conflict: 'overwrite' }))[0].error, /replace a source/);
  }
});

test('export planner protects unresolved source paths through symlinked parents', async t => {
  const { root } = await fixture(t);
  const folder = path.join(await fs.realpath(root), 'photos'), alias = path.join(root, 'alias');
  await fs.mkdir(folder);
  await fs.symlink(folder, alias, 'junction');
  const source = path.join(alias, 'IMG.jpg');
  const image = { id: 'a', name: 'IMG.ARW', path: path.join(alias, 'IMG.ARW') };
  for (const exists of [false, true]) {
    if (exists) await fs.writeFile(source, 'keep');
    for (const [item, protectedPaths] of [
      [{ ...image, path: source }, []],
      [{ ...image, companion: source }, []],
      [{ ...image, develop: { tiff: source } }, []],
      [image, [source, path.join(root, 'missing', 'other.jpg')]],
    ]) {
      for (const conflict of ['overwrite', 'skip']) {
        const [row] = await planExport([item], { folder, extension: 'jpg', conflict, protectedPaths });
        assert.match(row.error, /replace a source/);
      }
      const [row] = await planExport([item], { folder, extension: 'jpg', conflict: 'unique', protectedPaths });
      assert.equal(row.error, undefined);
      assert.equal(path.basename(row.dest), 'IMG-2.jpg');
    }
  }
  assert.equal(await fs.readFile(source, 'utf8'), 'keep');
});

test('export presets migrate last settings and retain every output and naming option', async t => {
  const { root, items } = await fixture(t);
  const value = normalizeSettings({ exportOptions: {format:'webp',quality:73,webpLossless:false}, exportSubfolder:'Web', exportConflict:'skip', naming:{template:'{seq:3}',start:8} });
  const preset = value.exportPresets.find(p=>p.name==='My last export');
  assert.equal(preset.options.quality,73); assert.equal(preset.subfolder,'Web');assert.equal(preset.conflict,'skip');assert.equal(preset.naming.start,8);
  const migrated = normalizeSettings(JSON.parse(JSON.stringify(value)));
  assert.equal(migrated.exportPresets.filter(p=>p.name==='My last export').length,1);
  const plan = await planExport(items, {folder:root,preset});
  assert.deepEqual(plan.map(r=>path.basename(r.dest)),['008.webp','009.webp']);
  assert.equal(path.basename(path.dirname(plan[0].dest)),'Web');
  assert.throws(()=>normalizeSettings({exportPresets:[preset,preset]}),/id/);
  assert.throws(()=>normalizeSettings({exportPresets:[{...preset,subfolder:'../bad'}]}),/folder/);
  assert.throws(()=>normalizeSettings({exportPresets:[{...preset,options:{avifSpeed:'bad'}}]}),/speed/);
  assert.equal(normalizeSettings({exportPresets:[]}).exportPresets.length,4);
  assert.equal(options({format:'webp',quality:61}).quality,61);
  assert.equal(options({format:'webp',webpLossless:true}).webpLossless,true);
  assert.equal(options({format:'avif'}).avifSpeed,'faster');
});

test('saved export presets migrate once across settings restart and edits preserve order', async t => {
  const {root} = await fixture(t), {SettingsStore} = require('../src/settings.cjs');
  await fs.writeFile(path.join(root,'settings.json'),JSON.stringify({exportOptions:{format:'tiff',bitDepth:16,colorSpace:'proPhoto',metadata:'copyright'},exportSubfolder:'Archive',exportConflict:'overwrite',naming:{template:'{filename}_{seq:3}',start:9}}));
  const store = new SettingsStore(root); await store.init();
  const migrated = store.snapshot().exportPresets.find(p=>p.id==='migrated-last-export');
  assert.equal(migrated.options.colorSpace,'proPhoto');assert.equal(migrated.options.metadata,'copyright');assert.equal(migrated.conflict,'overwrite');
  const ordered = [...store.snapshot().exportPresets].reverse(); await store.update({exportPresets:ordered});
  const reopened = new SettingsStore(root); await reopened.init();
  assert.deepEqual(reopened.snapshot().exportPresets.map(p=>p.id),ordered.map(p=>p.id));
  assert.equal(reopened.snapshot().exportPresets.filter(p=>p.id==='migrated-last-export').length,1);
  assert.throws(()=>normalizeSettings({exportPresets:[{...migrated,id:'user',name:'Full-size JPEG'}]}),/reserved/);
});
