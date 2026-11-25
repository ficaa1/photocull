const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Library, hash } = require('../src/library.cjs');
const { TetherService } = require('../src/tether.cjs');
const { SettingsStore } = require('../src/settings.cjs');
const { RecipeStore } = require('../src/develop.cjs');
const { PreviewService } = require('../src/previews.cjs');
const { normalizeSettings, DEFAULTS, TETHER } = require('../src/preferences.cjs');
const { bundle, validate, SettingsBundles } = require('../src/settings-bundle.cjs');
const { readXmp, updateXmp } = require('../src/xmp.cjs');
const { TransferService } = require('../src/transfer.cjs');
const naming = require('../src/renderer/naming.js');

const idOf = file => hash(file).slice(0, 24);
const sha = data => createHash('sha256').update(data).digest('hex');

// A real Library, SettingsStore and RecipeStore in temporary app data; the shell's staging and
// no-replace publication are played by `deliver` below.
async function setup(t, { settings = {}, files = {} } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-tether-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'Ceramics'), dataDir = path.join(base, 'data');
  await fs.mkdir(root);
  for (const [name, content] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), content); }
  const store = new SettingsStore(dataDir); await store.init();
  await store.update({ writeSidecars: 'never', ...settings });
  const recipes = new RecipeStore(store.folder); await recipes.init();
  const ctx = { base, root, dataDir, store, recipes, events: [] };
  ctx.open = async () => {
    let service;
    const library = new Library(dataDir, { settings: () => store.value, recipeSettings: id => recipes.get(id)?.settings, pairingExclusions: () => service.exclusions(), captureExposure: file => service.captureExposure(file) });
    const scan = library.scan.bind(library);
    library.scans = 0; library.scan = (...args) => { library.scans++; return scan(...args); };
    service = new TetherService({ dataDir, library, recipes, settings: () => store.value, presets: () => store.presets, send: (event, payload) => ctx.events.push({ event, payload }) });
    await service.init();
    Object.assign(ctx, { library, service });
    return ctx;
  };
  ctx.bind = async (layout = 'single', includeShots = false, session = null) => {
    const bound = await ctx.service.bind(ctx.root, null, layout, includeShots, session);
    Object.assign(ctx, { shootId: bound.shootId, session: bound.session.id, libraryRoot: bound.session.folder });
    return bound;
  };
  ctx.state = () => ctx.service.state(ctx.session);
  ctx.accept = (options = {}) => ctx.service.accept(ctx.shootId, 1, options.requestId ?? null, { key: options.key ?? randomUUID() }, options.roles ?? ['raw', 'jpeg'],
    options.camera ?? { model: 'ILCE-7M3', bodyId: 'body-1', iso: 100, shutter: '1/125', aperture: 2.8, focalLength: 85 });
  ctx.deliver = async (exposureId, originalName, { content = `${originalName}:${exposureId}`, ingest = true, publish = true, objectKey } = {}) => {
    const member = await ctx.service.member(ctx.shootId, exposureId, { role: /\.jpe?g$/i.test(originalName) ? 'jpeg' : 'raw', originalName, providerObjectKey: objectKey });
    const stage = path.join(ctx.root, ...member.stageRelPath.split('/'));
    await fs.mkdir(path.dirname(stage), { recursive: true }); await fs.writeFile(stage, content);
    const plan = await ctx.service.reserve(ctx.shootId, member.memberId, { bytes: Buffer.byteLength(content), sha256: sha(content) });
    const final = path.join(ctx.libraryRoot, ...plan.finalRelPath.split('/'));
    if (!publish) return { member, plan, final };
    await fs.link(stage, final); await fs.unlink(stage);
    if (!ingest) return { member, plan, final };
    const result = await ctx.service.ingest(ctx.shootId, member.memberId, plan.claimId, { finalRelPath: plan.finalRelPath, bytes: Buffer.byteLength(content) });
    return { member, plan, final, result };
  };
  ctx.item = id => ctx.library.item(ctx.session, id);
  ctx.deltas = () => ctx.events.filter(e => e.event === 'tether-library-delta').map(e => e.payload);
  return ctx.open();
}

test('capture naming renders every token, width and fallback without touching copy naming', () => {
  const render = (template, context) => naming.renderCaptureName(template, { jobName: 'Ceramics', counter: 17, extension: '.ARW', ...context }).filename;
  assert.equal(render('{JobName}_{Subfolder}_{Counter:4}', { subfolder: 'Blue' }), 'Ceramics_Blue_0017.ARW');
  assert.equal(render('{Name}-{Counter}'), 'Ceramics-0017.ARW');
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => render(`{Counter:${n}}`, { counter: 7 })), ['7', '07', '007', '0007', '00007', '000007'].map(s => s + '.ARW'));
  assert.equal(render('{Counter:4}', { counter: 1234567 }), '1234567.ARW');
  assert.equal(render('{Counter:3}', { counter: -5 }), '-005.ARW');
  assert.equal(render('{CameraCounter}', { cameraCounter: 0 }), '0000.ARW');
  assert.equal(render('{CameraCounter}', { cameraCounter: 12345 }), '12345.ARW');
  assert.equal(render('{Date}-{Time}', { captureTime: '2026:09:26 10:11:12', hostTime: '2020:01:01 00:00:00' }), '20260926-101112.ARW');
  assert.equal(render('{Date}-{Time}', { hostTime: '2026:10:30 23:59:58' }), '20261030-235958.ARW');
  assert.equal(render('{ISO}_{Shutter}_{Aperture}_{FocalLength}', { iso: 100, shutter: '10/1250', aperture: '28/10', focalLength: '850/10' }), '100_1-125_f2.8_85mm.ARW');
  assert.deepEqual([2, '2/1', 0.5, 2.5, '3/10', 1 / 3, 'bogus'].map(naming.formatShutterToken), ['2s', '2s', '1-2', '2.5s', '0.3s', '1-3', null]);
  assert.deepEqual([8, 'f/1.40', 7.1].map(naming.formatApertureToken), ['f8', 'f1.4', 'f7.1']);
  assert.equal(render('{Camera}_{Original}', { camera: 'ILCE/7:M3', original: 'DSC0\u00071' }), 'ILCE-7-M3_DSC0-1.ARW');
  assert.equal(render('{Name}', { jobName: 'Café' }), 'Café.ARW');
  const missing = naming.renderCaptureName('{Name}_{ISO}', { jobName: 'Job', counter: 1, extension: '.ARW' });
  assert.equal(missing.filename, 'Job_unknown.ARW'); assert.deepEqual(missing.warnings, ['ISO unknown']);
  for (const [template, context] of [['{CameraCounter}', {}], ['{Name}', { jobName: 'CON' }], ['{Name}', { jobName: 'lpt1' }], ['x'.repeat(170) + '{Name}', { jobName: 'y'.repeat(40) }], ['{Name}', { extension: '.exe', allowedExtensions: new Set(['.arw']) }], ['{Original}', {}]]) {
    assert.throws(() => naming.renderCaptureName(template, { jobName: 'Job', counter: 1, extension: '.ARW', ...context }), e => e.code === 'NAME_INVALID', template);
  }
  for (const template of ['{name}', '{Counter:7}', '{Counter:0}', '{{Name}}', '{Name', 'Name}', 'a/b{Counter}', 'a:b', '', 'x'.repeat(181), '{Date:4}']) assert.equal(naming.validateCaptureTemplate(template).valid, false, template);
  const preview = naming.renderCaptureName('{Original}-{ISO}-{CameraCounter}', { counter: 1 }, { preview: true });
  assert.equal(preview.valid, false); assert.match(preview.warning, /Camera Counter unavailable/);
  const ok = naming.renderCaptureName('{Original}-{ISO}-{Time}', { counter: 1, iso: 200, hostTime: '2026:01:02 03:04:05' }, { preview: true });
  assert.deepEqual(ok.filenames, ['DSC00001-200-030405.ARW', 'DSC00001-200-030405.JPG']);
  assert.deepEqual(ok.pendingTokens, ['Original']); assert.deepEqual(ok.estimatedTokens.sort(), ['ISO', 'Time']);
  // Copy/export naming keeps its own lowercase tokens and meaning.
  assert.equal(naming.renderName('DSC1.ARW', { template: '{text}_{seq:3}', text: 'Trip', start: 12 }, 1).filename, 'Trip_013.ARW');
  assert.throws(() => naming.renderName('a.JPG', { template: '{Name}', text: '', start: 1 }), /Unknown filename token/);
});

test('tether settings default, merge, validate and keep a newer section intact', async t => {
  const settings = normalizeSettings({});
  assert.deepEqual(settings.tether, TETHER);
  assert.deepEqual(settings.tether.flash, { syncLimit: 200, recycleMs: 0, misfireAlert: true, misfireChime: false });
  const merged = normalizeSettings({ tether: { adjustments: { mode: 'recipe', groups: ['light', 'wb'] }, composition: { grid: { guides: [{ axis: 'x', at: 0.25 }] }, warning: { low: 10 } } } }, settings).tether;
  assert.deepEqual(merged.adjustments, { mode: 'recipe', recipeId: null, entireRecipe: true, groups: ['wb', 'light'] });
  assert.equal(merged.composition.grid.type, 'thirds'); assert.equal(merged.composition.warning.high, 250); assert.equal(merged.composition.warning.low, 10);
  for (const tether of [{ unknown: 1 }, { counterStep: 0 }, { counterStart: 1e10 }, { counterStep: 1.5 }, { layout: 'four' }, { namingTemplate: '{bad}' }, { adjustments: { groups: ['wb', 'wb'] } },
    { adjustments: { mode: 'clipboard' } }, { initial: { rating: 6 } }, { initial: { color: '9' } }, { initial: { pick: 'yes' } }, { follow: { mode: 'later' } },
    ...[{ syncLimit: 29 }, { syncLimit: 8001 }, { syncLimit: 200.5 }, { syncLimit: '200' }, { recycleMs: -1 }, { recycleMs: 10001 }, { recycleMs: 1.5 }, { misfireAlert: 1 }, { misfireChime: 'false' }].map(flash => ({ flash })),
    { composition: { overlay: { scale: 5 } } }, { composition: { grid: { opacity: NaN } } }, { composition: { grid: { color: 'red' } } }, { composition: { grid: { rows: 129 } } },
    { composition: { grid: { guides: Array.from({ length: 65 }, () => ({ axis: 'x', at: 0.5 })) } } }, { composition: { warning: { low: 250 } } }, { composition: { mask: { threshold: 0.5 } } }, { composition: { histogram: { mode: 'hsl' } } }]) {
    assert.throws(() => normalizeSettings({ tether }), undefined, JSON.stringify(tether));
  }
  const ctx = await setup(t);
  await fs.writeFile(ctx.store.file, JSON.stringify({ autoAdvance: false, tether: { version: 2, futureLayout: { columns: 4 } } }));
  const reopened = new SettingsStore(ctx.dataDir); await reopened.init();
  assert.equal(reopened.value.autoAdvance, false); assert.deepEqual(reopened.value.tether, { version: 2, futureLayout: { columns: 4 } });
  await assert.rejects(reopened.update({ tether: { chime: true } }), /newer PhotoCull/);
  ctx.store.value = reopened.value;
  await assert.rejects(ctx.bind(), e => e.code === 'UNSUPPORTED');
});

test('shoot flash preferences persist and older journals hydrate with application defaults', async t => {
  const ctx = await setup(t, { settings: { tether: { flash: { syncLimit: 250, misfireChime: true } } } });
  await ctx.bind();
  const defaults = { syncLimit: 200, recycleMs: 0, misfireAlert: true, misfireChime: false };
  assert.deepEqual((await ctx.state()).config.flash, { ...defaults, syncLimit: 250, misfireChime: true });
  await assert.rejects(ctx.service.config(ctx.shootId, 1, { flash: { recycleMs: 10001 } }), e => e.code === 'UNSUPPORTED' && e.detail.field === 'flash');
  const update = await ctx.service.config(ctx.shootId, 1, { flash: { syncLimit: 0, recycleMs: 10000, misfireAlert: false } });
  const custom = { syncLimit: 0, recycleMs: 10000, misfireAlert: false, misfireChime: true };
  assert.deepEqual(update.config.flash, custom);
  assert.deepEqual(ctx.events.at(-1).payload.config.flash, custom);
  const journal = path.join(ctx.dataDir, 'tether', 'shoots', ctx.shootId + '.json');
  await ctx.open(); await ctx.bind();
  assert.deepEqual((await ctx.state()).config.flash, custom);
  const legacy = JSON.parse(await fs.readFile(journal, 'utf8'));
  delete legacy.shoot.config.flash;
  await fs.writeFile(journal, JSON.stringify(legacy));
  await ctx.open(); await ctx.bind();
  assert.equal(ctx.shootId, legacy.shoot.shootId);
  assert.deepEqual((await ctx.state()).config.flash, defaults);
  const patched = await ctx.service.config(ctx.shootId, update.configRev, { flash: { syncLimit: 8000 } });
  assert.deepEqual(patched.config.flash, { ...defaults, syncLimit: 8000 });
});

test('preview metadata reads flash tags, preserves zero EV and replaces the previous cache format', async t => {
  const ctx = await setup(t);
  const paths = ['fired', 'missed', 'absent'].map(name => path.join(ctx.root, name + '.ARW'));
  const captures = new Map([
    [paths[0], { Flash: 'Fired, Return detected', FlashExposureComp: 0 }],
    [paths[1], { Flash: 'Auto, Did not fire', FlashExposureComp: '-2/3' }],
    [paths[2], { FlashExposureComp: null }],
  ]);
  let reads = 0;
  const cacheDir = path.join(ctx.dataDir, 'previews');
  const previews = new PreviewService(cacheDir, { exif: { readRaw: async (file, { readArgs }) => {
    reads++;
    assert.ok(readArgs.includes('-Flash'));
    assert.ok(readArgs.includes('-FlashExposureComp'));
    return captures.get(file);
  } } });
  const items = paths.map((file, i) => ({ id: String(i), path: file, fingerprint: 'synthetic', raw: true }));
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, hash(`sources-v2:${items[0].path}:${items[0].fingerprint}`) + '.metadata-v2.json'), '{}');
  const flash = async (service, item) => {
    const { flash, flashFired, flashComp } = await service.metadata(item);
    return { flash, flashFired, flashComp };
  };
  assert.deepEqual(await flash(previews, items[0]), { flash: 'Fired, Return detected', flashFired: true, flashComp: '0' });
  assert.deepEqual(await flash(previews, items[1]), { flash: 'Auto, Did not fire', flashFired: false, flashComp: '-2/3' });
  assert.deepEqual(await flash(previews, items[2]), { flash: '', flashFired: null, flashComp: '' });
  const reopened = new PreviewService(cacheDir, { exif: { readRaw: () => assert.fail('metadata cache miss') } });
  assert.deepEqual(await flash(reopened, items[0]), { flash: 'Fired, Return detected', flashFired: true, flashComp: '0' });
  assert.equal(reads, 3);
});

test('settings bundles carry portable tether defaults and resolve their recipe and preset references', async t => {
  const ctx = await setup(t);
  const recipe = await ctx.recipes.save({ name: 'Product', settings: { light: { exposure: 0.3 } } });
  const { preset } = await ctx.store.savePreset('Client', { metadata: { creator: 'Studio' } });
  await ctx.store.update({ tether: { namingTemplate: '{JobName}_{Counter:3}', counterStep: 5, chime: true, adjustments: { mode: 'recipe', recipeId: recipe.id }, metadataPresetId: preset.id } });
  await ctx.bind(); const e = await ctx.accept(); await ctx.deliver(e.exposureId, 'DSC00001.ARW');
  const exported = bundle(ctx.store, ctx.recipes), text = JSON.stringify(exported);
  assert.deepEqual(exported.preferences.tether, ctx.store.value.tether);
  for (const local of [ctx.root, ctx.shootId, 'nextOrdinal', 'camera-counters']) assert.ok(!text.includes(local), local);
  assert.deepEqual((await validate(exported)).warnings.filter(w => /Tether/.test(w)), []);
  const orphan = structuredClone(exported); orphan.recipes = []; orphan.presets = []; orphan.preferences.activePreset = 'standard';
  const checked = await validate(orphan);
  assert.equal(checked.preferences.tether.adjustments.recipeId, null); assert.equal(checked.preferences.tether.adjustments.mode, 'default');
  assert.equal(checked.preferences.tether.metadataPresetId, null); assert.equal(checked.warnings.filter(w => /Tether/.test(w)).length, 2);
  const broken = structuredClone(exported); broken.preferences.tether.counterStep = 0;
  await assert.rejects(validate(broken));
  await ctx.store.update({ tether: { chime: false, counterStep: 1 } });
  const service = new SettingsBundles(ctx.store, ctx.recipes), preview = await service.preview(exported);
  assert.ok(preview.changes.includes('tether'));
  await service.apply(preview.token);
  const reopened = new SettingsStore(ctx.dataDir); await reopened.init();
  assert.equal(reopened.value.tether.chime, true); assert.equal(reopened.value.tether.counterStep, 5); assert.equal(reopened.value.tether.adjustments.recipeId, recipe.id);
});

test('public config, counter and preview calls validate, serialize and never consume numbers', async t => {
  const ctx = await setup(t);
  const bound = await ctx.bind();
  assert.equal(bound.configRev, 1); assert.equal(ctx.libraryRoot, ctx.root);
  let state = await ctx.state();
  assert.equal(state.config.jobName, 'Ceramics'); assert.equal(state.config.namingTemplate, '{Name}-{Counter:4}'); assert.equal(state.counters.next, 1);
  assert.equal(typeof state.space.freeBytes, 'number'); assert.equal(state.space.estimatedShots, null);
  const preview = () => ctx.service.namePreview(ctx.shootId, {});
  assert.deepEqual((await preview()).filenames, ['Ceramics-0001.ARW', 'Ceramics-0001.JPG']);
  assert.deepEqual((await preview()).filenames, ['Ceramics-0001.ARW', 'Ceramics-0001.JPG']);
  assert.deepEqual(ctx.service.namePreview(ctx.shootId, { namingTemplate: '{JobName}_{Subfolder}_{Counter:4}', relativeShot: 'Blue' }).filenames, ['Ceramics_Blue_0001.ARW', 'Ceramics_Blue_0001.JPG']);
  assert.equal(ctx.service.namePreview(ctx.shootId, { namingTemplate: '{CameraCounter}' }).valid, false);
  assert.throws(() => ctx.service.namePreview(ctx.shootId, { other: 1 }), e => e.code === 'UNSUPPORTED');
  await assert.rejects(ctx.service.config(ctx.shootId, 0, { jobName: 'Vases' }), e => e.code === 'STALE_REV' && e.detail.currentRev === 1);
  await assert.rejects(ctx.service.config(ctx.shootId, 1, { namingTemplate: '{Counter:9}' }), e => e.code === 'NAME_INVALID' && e.detail.field === 'namingTemplate');
  await assert.rejects(ctx.service.config(ctx.shootId, 1, { layout: 'session' }), e => e.code === 'UNSUPPORTED');
  await assert.rejects(ctx.service.config(ctx.shootId, 1, { follow: { mode: 'sometimes' } }), e => e.code === 'UNSUPPORTED');
  const updated = await ctx.service.config(ctx.shootId, 1, { jobName: 'Vases', follow: { mode: 'off' }, composition: { aspect: { ratio: '4:5' } } });
  assert.equal(updated.configRev, 2); assert.equal(updated.config.follow.pauseOnInspect, true); assert.equal(updated.config.composition.aspect.matte, 0.65);
  assert.equal(ctx.events.filter(e => e.event === 'tether-config-changed').at(-1).payload.configRev, 2);
  const ops = [['setNext', 10], ['setStart', 5], ['setStep', -2], ['decrement'], ['increment'], ['increment'], ['reset']];
  const results = [];
  for (const [op, value] of ops) results.push(await ctx.service.counter(ctx.shootId, (await ctx.state()).configRev, op, value));
  assert.deepEqual(results.map(r => r.next), [10, 10, 10, 12, 10, 8, 5]);
  for (const [op, value] of [['setStep', 0], ['setStep', 10000], ['setNext', 1e9], ['setNext', 1.5], ['rewind']]) await assert.rejects(ctx.service.counter(ctx.shootId, (await ctx.state()).configRev, op, value), e => e.code === 'UNSUPPORTED', op);
  // A stale manual counter action cannot rewind past an intervening capture.
  const rev = (await ctx.state()).configRev;
  const shot = await ctx.accept();
  assert.equal(shot.counters.capture, 5);
  await assert.rejects(ctx.service.counter(ctx.shootId, rev, 'setNext', 5), e => e.code === 'STALE_REV');
  state = await ctx.state();
  assert.equal(state.counters.next, 3);
  await ctx.service.counter(ctx.shootId, state.configRev, 'setNext', -1);
  const names = [];
  for (let n = 0; n < 2; n++) { const e = await ctx.accept(); names.push((await ctx.deliver(e.exposureId, `DSC0000${n}.ARW`)).plan.finalRelPath); }
  assert.deepEqual(names, ['Vases--0001.ARW', 'Vases--0003.ARW']);
});

test('camera counters follow a body across shoots and an unavailable body needs a name', async t => {
  const ctx = await setup(t, { settings: { tether: { namingTemplate: '{Name}_{CameraCounter}' } } });
  await ctx.bind();
  const shots = [];
  for (const camera of [{ model: 'ILCE-7M3', bodyId: 'A' }, { model: 'ILCE-7M3', bodyId: 'A' }, { model: 'ILCE-7CM2', bodyId: 'B' }]) shots.push(await ctx.accept({ camera }));
  assert.deepEqual(shots.map(s => s.counters.camera), [0, 1, 0]);
  assert.deepEqual(shots.map(s => s.counters.capture), [1, 2, 3]);
  assert.equal((await ctx.deliver(shots[1].exposureId, 'DSC09999.ARW')).plan.finalRelPath, 'Ceramics_0001.ARW');
  const counters = await fs.readFile(path.join(ctx.dataDir, 'tether', 'camera-counters.json'), 'utf8');
  assert.ok(!counters.includes('ILCE') && !counters.includes('"A"'));
  await ctx.service.journal(ctx.shootId, 'close');
  const other = path.join(ctx.base, 'Glass'); await fs.mkdir(other);
  const second = await ctx.service.bind(other, null, 'single');
  const next = await ctx.service.accept(second.shootId, 1, null, { key: 'x' }, ['raw'], { model: 'ILCE-7M3', bodyId: 'A' });
  assert.equal(next.counters.camera, 2); assert.equal(next.counters.capture, 1);
  // No body identity: the frame still arrives, but publication waits for a name.
  const anonymous = await ctx.service.accept(second.shootId, 1, null, { key: 'y' }, ['raw'], { model: 'ILCE-7M3' });
  assert.equal(anonymous.counters.camera, null);
  const member = await ctx.service.member(second.shootId, anonymous.exposureId, { originalName: 'DSC00002.ARW' });
  await fs.mkdir(path.join(other, '.photocull-tether'), { recursive: true }); await fs.writeFile(path.join(other, member.stageRelPath), 'raw');
  await assert.rejects(ctx.service.reserve(second.shootId, member.memberId, { bytes: 3 }), e => e.code === 'NAME_INVALID' && e.detail.actions.includes('repairName'));
  assert.equal((await ctx.service.state(second.session.id)).issues[0].code, 'NAME_INVALID');
  await ctx.service.journal(second.shootId, 'recovery', { action: 'repairName', exposureId: anonymous.exposureId, name: 'Glass_manual' });
  assert.equal((await ctx.service.reserve(second.shootId, member.memberId, { bytes: 3 })).finalRelPath, 'Glass_manual.ARW');
});

test('stem reservation skips every same-stem variant and claim without consuming counters', async t => {
  const ctx = await setup(t, { files: { 'Café-0001.arw': 'a', 'Café-0001-2.JPG': 'b', 'CAFÉ-0001-3.xmp': 'c', 'café-0001-4.ARW.xmp': 'd', 'Café-0001-5.tif': 'e' } });
  await ctx.bind();
  await ctx.service.config(ctx.shootId, 1, { jobName: 'Café' });
  const first = await ctx.accept(), second = await ctx.accept();
  const a = await ctx.deliver(first.exposureId, 'DSC00001.ARW', { publish: false });
  // Two exposures racing: the in-flight claim is honored before anything is on disk.
  assert.equal(a.plan.stem, 'Café-0001-6');
  await ctx.service.counter(ctx.shootId, (await ctx.state()).configRev, 'setNext', 1);
  const raced = await ctx.accept();
  const b = await ctx.deliver(raced.exposureId, 'DSC00003.ARW', { publish: false });
  assert.equal(b.plan.stem, 'Café-0001-7');
  assert.equal((await ctx.deliver(second.exposureId, 'DSC00002.ARW')).plan.stem, 'Café-0002');
  assert.equal((await ctx.state()).counters.next, 2);
  for (const [name, content] of [['Café-0001.arw', 'a'], ['Café-0001-2.JPG', 'b']]) assert.equal(await fs.readFile(path.join(ctx.root, name), 'utf8'), content);
  // The shell lost the race to another writer: retry with that suffix excluded.
  await fs.writeFile(path.join(ctx.root, 'Café-0001-6.ARW'), 'foreign');
  await ctx.service.journal(ctx.shootId, 'conflict', { memberId: a.member.memberId, claimId: a.plan.claimId });
  const staged = `DSC00001.ARW:${first.exposureId}`;
  const retried = await ctx.service.reserve(ctx.shootId, a.member.memberId, { bytes: Buffer.byteLength(staged), sha256: sha(staged) });
  assert.equal(retried.stem, 'Café-0001-8');
});

test('a late companion never pairs with or replaces a foreign file', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const e = await ctx.accept();
  const raw = await ctx.deliver(e.exposureId, 'DSC00001.ARW');
  await fs.writeFile(path.join(ctx.root, 'Ceramics-0001.jpg'), 'foreign');
  await assert.rejects(ctx.deliver(e.exposureId, 'DSC00001.JPG'), err => err.code === 'NAME_TAKEN' && err.detail.actions.includes('saveSeparate'));
  assert.equal(await fs.readFile(path.join(ctx.root, 'Ceramics-0001.jpg'), 'utf8'), 'foreign');
  const foreign = await fs.stat(path.join(ctx.root, 'Ceramics-0001.jpg'));
  assert.deepEqual(ctx.service.exclusions(), [{ path: path.join(ctx.root, 'Ceramics-0001.jpg'), fileId: `${foreign.dev}:${foreign.ino}` }]);
  const { records } = await ctx.service.journal(ctx.shootId, 'recovery', {});
  const held = records.find(r => r.state === 'held');
  assert.equal(held.code, 'NAME_TAKEN');
  await ctx.service.journal(ctx.shootId, 'recovery', { action: 'saveSeparate', memberId: held.memberId });
  const content = `DSC00001.JPG:${e.exposureId}`;
  const plan = await ctx.service.reserve(ctx.shootId, held.memberId, { bytes: Buffer.byteLength(content), sha256: sha(content) });
  assert.equal(plan.finalRelPath, 'Ceramics-0001-2.JPG');
  await fs.link(path.join(ctx.root, '.photocull-tether', held.memberId + '.part'), path.join(ctx.root, plan.finalRelPath));
  const separate = await ctx.service.ingest(ctx.shootId, held.memberId, plan.claimId, { finalRelPath: plan.finalRelPath, bytes: Buffer.byteLength(content) });
  assert.notEqual(separate.itemId, raw.result.itemId);
  assert.equal(ctx.deltas().at(-1).pairState, 'separate');
  assert.equal(ctx.item(raw.result.itemId).companion, null);
  // Reopening keeps the foreign JPEG apart from the capture's RAW.
  const scan = () => new Library(path.join(ctx.base, 'other'), { pairingExclusions: () => ctx.service.exclusions() }).scan(ctx.root);
  assert.deepEqual((await scan()).items.map(i => [i.name, i.paired]), [['Ceramics-0001-2.JPG', false], ['Ceramics-0001.ARW', false], ['Ceramics-0001.jpg', false]]);
  // The exclusion is durable and names that file only: whatever later takes its path pairs normally.
  await ctx.service.init();
  assert.deepEqual(ctx.service.exclusions().map(e => e.fileId), [`${foreign.dev}:${foreign.ino}`]);
  const replacement = path.join(ctx.root, 'replacement.tmp');
  await fs.writeFile(replacement, 'other');
  await fs.rename(replacement, path.join(ctx.root, 'Ceramics-0001.jpg'));
  assert.deepEqual((await scan()).items.map(i => [i.name, i.paired]), [['Ceramics-0001-2.JPG', false], ['Ceramics-0001.ARW', true]]);
  // A .jpeg spelling of the companion's name is the same conflict.
  const second = await ctx.accept();
  await ctx.deliver(second.exposureId, 'DSC00002.ARW');
  await fs.writeFile(path.join(ctx.root, 'ceramics-0002.Jpeg'), 'foreign');
  await assert.rejects(ctx.deliver(second.exposureId, 'DSC00002.JPG'), err => err.code === 'NAME_TAKEN');
  assert.ok(ctx.service.exclusions().some(e => e.path === path.join(ctx.root, 'ceramics-0002.Jpeg')));
});

test('a foreign file at a reserved name is excluded from pairing when publication or recovery finds it', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const excluded = () => ctx.service.exclusions().map(e => path.basename(e.path)).sort();
  // Publication loses the race for the companion's name.
  const raced = await ctx.accept();
  const raw = await ctx.deliver(raced.exposureId, 'DSC00001.ARW');
  const jpeg = await ctx.deliver(raced.exposureId, 'DSC00001.JPG', { publish: false });
  await fs.writeFile(jpeg.final, 'foreign');
  await ctx.service.journal(ctx.shootId, 'conflict', { memberId: jpeg.member.memberId, claimId: jpeg.plan.claimId });
  assert.deepEqual(excluded(), ['Ceramics-0001.JPG']);
  // The process dies with a companion reserved; another writer takes its name before the restart.
  const crashed = await ctx.accept();
  const raw2 = await ctx.deliver(crashed.exposureId, 'DSC00002.ARW');
  const jpeg2 = await ctx.deliver(crashed.exposureId, 'DSC00002.JPG', { publish: false });
  await ctx.library.close();
  await fs.writeFile(jpeg2.final, 'foreign');
  await ctx.open();
  const { recoveries } = await ctx.bind();
  assert.deepEqual(recoveries.filter(r => r.memberId === jpeg2.member.memberId).map(r => [r.state, r.code]), [['held', 'NAME_TAKEN']]);
  assert.deepEqual(excluded(), ['Ceramics-0001.JPG', 'Ceramics-0002.JPG']);
  // Excluded before the reopened Library scanned, so neither RAW ever paired with a foreign file.
  assert.deepEqual([ctx.item(raw.result.itemId).companion, ctx.item(raw2.result.itemId).companion], [null, null]);
});

test('arrivals update only their own group: RAW only, JPEG only, RAW then JPEG and duplicates', async t => {
  const ctx = await setup(t, { files: { 'existing.JPG': 'old' }, settings: { tether: { initial: { rating: 2, color: '', pick: true } } } });
  await ctx.bind();
  assert.equal(ctx.library.scans, 1);
  const rawOnly = await ctx.accept({ roles: ['raw'] });
  const r = await ctx.deliver(rawOnly.exposureId, 'DSC00001.ARW');
  const rawItem = ctx.item(r.result.itemId);
  assert.equal(r.result.itemId, idOf(r.final)); assert.equal(rawItem.raw, true); assert.equal(rawItem.exposureId, rawOnly.exposureId);
  assert.deepEqual([rawItem.flag, rawItem.rating, rawItem.color], ['pick', 2, '']);
  let delta = ctx.deltas().at(-1);
  assert.deepEqual([delta.rev, delta.ordinal, delta.firstArrival, delta.pairState, delta.upserts[0].contentRev, delta.upserts[0].exposureId], [1, 1, true, 'single', 1, rawOnly.exposureId]);
  const jpegOnly = await ctx.accept({ roles: ['jpeg'] });
  const j = await ctx.deliver(jpegOnly.exposureId, 'DSC00002.JPG');
  assert.equal(ctx.item(j.result.itemId).raw, false); assert.ok(!ctx.item(j.result.itemId).develop);
  const pair = await ctx.accept();
  const first = await ctx.deliver(pair.exposureId, 'DSC00003.ARW');
  assert.equal(ctx.deltas().at(-1).pairState, 'waiting');
  await ctx.library.decide(ctx.session, first.result.itemId, { rating: 5 });
  const second = await ctx.deliver(pair.exposureId, 'DSC00003.JPG');
  assert.equal(second.result.itemId, first.result.itemId);
  const paired = ctx.item(first.result.itemId);
  assert.equal(paired.companion, second.final); assert.equal(paired.rating, 5); assert.equal(paired.contentRev, 2);
  assert.equal(paired.fingerprint, `${paired.size}:${paired.mtimeMs}:${paired.companionSize}:${paired.companionMtimeMs}`);
  delta = ctx.deltas().at(-1);
  assert.deepEqual([delta.rev, delta.firstArrival, delta.pairState, delta.remap.length, delta.upserts.length], [4, false, 'paired', 0, 1]);
  // Replays return the same receipt and change nothing.
  const events = ctx.events.length;
  assert.deepEqual(await ctx.service.ingest(ctx.shootId, second.member.memberId, second.plan.claimId, {}), second.result);
  const again = await ctx.library.ingestCapture(ctx.session, { path: second.final, exposureId: pair.exposureId });
  assert.deepEqual([again.upserts, again.rev], [[], 4]);
  assert.equal(ctx.events.length, events);
  assert.equal(ctx.library.scans, 1);
  assert.deepEqual(ctx.library.publicSession(ctx.library.get(ctx.session)).items.map(i => i.name), ['Ceramics-0001.ARW', 'Ceramics-0002.JPG', 'Ceramics-0003.ARW', 'existing.JPG']);
  const library = await ctx.service.libraryState(ctx.shootId, ctx.session);
  assert.equal(library.rev, 4); assert.equal(library.latestOrdinal, 3); assert.equal(library.library.items.length, 4);
  await assert.rejects(ctx.service.libraryState(ctx.shootId, 'other'), e => e.code === 'STALE_SESSION');
  // A file changed on disk is never adopted as a retry.
  await fs.appendFile(second.final, 'x');
  await assert.rejects(ctx.library.ingestCapture(ctx.session, { path: second.final }), e => e.code === 'DEST_CHANGED');
  await assert.rejects(ctx.library.ingestCapture(ctx.session, { path: path.join(ctx.base, 'outside.ARW') }), e => e.code === 'DEST_CHANGED');
});

test('JPEG first: the RAW takes over the provisional row with decisions, history and in-flight edits', async t => {
  const ctx = await setup(t, { settings: { tether: { initial: { rating: 1, color: null, pick: null } } } });
  await ctx.bind();
  const e = await ctx.accept();
  const jpeg = await ctx.deliver(e.exposureId, 'DSC00001.JPG');
  const provisional = jpeg.result.itemId;
  assert.equal(ctx.item(provisional).rating, 1);
  await ctx.library.decide(ctx.session, provisional, { rating: 4, flag: 'pick' });
  await ctx.library.decideMany(ctx.session, [provisional], { color: '2' });
  const member = await ctx.service.member(ctx.shootId, e.exposureId, { originalName: 'DSC00001.ARW' }), content = 'raw bytes';
  await fs.writeFile(path.join(ctx.root, member.stageRelPath), content);
  const plan = await ctx.service.reserve(ctx.shootId, member.memberId, { bytes: content.length });
  assert.equal(plan.finalRelPath, 'Ceramics-0001.ARW');
  await fs.link(path.join(ctx.root, member.stageRelPath), path.join(ctx.root, plan.finalRelPath));
  const arriving = ctx.service.ingest(ctx.shootId, member.memberId, plan.claimId, { finalRelPath: plan.finalRelPath, bytes: content.length });
  const inFlight = ctx.library.decide(ctx.session, provisional, { trashed: false, rating: 3 });
  const result = await arriving; await inFlight;
  const raw = ctx.item(result.itemId);
  assert.equal(result.itemId, idOf(path.join(ctx.root, 'Ceramics-0001.ARW')));
  assert.deepEqual([raw.raw, raw.companion, raw.rating, raw.flag, raw.color, raw.contentRev, raw.exposureId], [true, jpeg.final, 3, 'pick', '2', 2, e.exposureId]);
  const delta = ctx.deltas().at(-1);
  assert.deepEqual(delta.remap, [{ from: provisional, to: result.itemId }]);
  assert.deepEqual([delta.firstArrival, delta.removedIds, delta.upserts.map(i => i.id)], [false, [], [result.itemId]]);
  assert.equal(ctx.library.get(ctx.session).byId.has(provisional), false);
  // The provisional ID still resolves, and undo/redo now own the RAW.
  assert.equal((await ctx.library.decide(ctx.session, provisional, { rating: 5 })).id, result.itemId);
  assert.equal((await ctx.library.history(ctx.session, 'undo')).id, result.itemId);
  assert.equal(raw.rating, 3);
  await ctx.library.history(ctx.session, 'undo'); await ctx.library.history(ctx.session, 'undo');
  assert.equal(raw.color, null);
  await ctx.library.history(ctx.session, 'undo');
  assert.deepEqual([raw.rating, raw.flag], [1, 'none']);
  await ctx.library.history(ctx.session, 'redo');
  assert.deepEqual([raw.rating, raw.flag], [4, 'pick']);
  // The frozen RAW patch is applied once, to the RAW only.
  assert.deepEqual(ctx.library.developGet(ctx.session, result.itemId).settings, { profile: { id: 'lc.neutral' } });
  assert.equal(raw.captureDevelop, true);
  const forgotten = await ctx.library.forget(ctx.session, [provisional]);
  assert.deepEqual(forgotten.removed, [result.itemId]);
  assert.equal(ctx.library.get(ctx.session).byPath.size, 0);
});

test('interleaved bursts land in their acceptance-time shot folders with zero rescans', async t => {
  const ctx = await setup(t, { settings: { tether: { namingTemplate: '{Original}' } } });
  await ctx.bind('session');
  assert.equal(ctx.libraryRoot, path.join(ctx.root, 'Capture'));
  for (const name of ['Capture', 'Selects', 'Output', 'Trash']) assert.ok((await fs.stat(path.join(ctx.root, name))).isDirectory());
  for (const shot of ['Blue', 'Red']) await fs.mkdir(path.join(ctx.libraryRoot, shot));
  await assert.rejects(ctx.service.setLocation(ctx.shootId, 1, '../Blue', null, true), e => e.code === 'UNSUPPORTED');
  for (const bad of ['/abs', 'a\\b', '.hidden', 'CON', 'trail.', '']) if (bad) await assert.rejects(ctx.service.setLocation(ctx.shootId, 1, bad), e => ['UNSUPPORTED', 'DEST_CHANGED'].includes(e.code), bad);
  await ctx.service.setLocation(ctx.shootId, 1, 'Blue', null, true);
  const blue = [await ctx.accept(), await ctx.accept()];
  const loc = await ctx.service.setLocation(ctx.shootId, (await ctx.state()).configRev, 'Red', null, true);
  assert.deepEqual(loc.location.recents, ['Red', 'Blue']);
  const red = [await ctx.accept(), await ctx.accept()];
  // Identical camera stems in two folders, with each pair's halves arriving out of order.
  const order = [[red[1], 'DSC00001.JPG'], [blue[0], 'DSC00001.JPG'], [red[0], 'DSC00002.ARW'], [blue[1], 'DSC00002.ARW'], [blue[0], 'DSC00001.ARW'], [red[1], 'DSC00001.ARW'], [blue[1], 'DSC00002.JPG'], [red[0], 'DSC00002.JPG']];
  for (const [exposure, name] of order) await ctx.deliver(exposure.exposureId, name);
  const items = ctx.library.publicSession(ctx.library.get(ctx.session)).items;
  assert.deepEqual(items.map(i => [path.relative(ctx.libraryRoot, ctx.item(i.id).path), i.paired, i.ordinal]).sort((a, b) => a[2] - b[2]),
    [[path.join('Blue', 'DSC00001.ARW'), true, 1], [path.join('Blue', 'DSC00002.ARW'), true, 2], [path.join('Red', 'DSC00002.ARW'), true, 3], [path.join('Red', 'DSC00001.ARW'), true, 4]]);
  assert.deepEqual(ctx.deltas().map(d => d.rev), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(ctx.deltas().filter(d => d.firstArrival).length, 4);
  assert.equal(ctx.library.scans, 1);
  const state = await ctx.state();
  assert.deepEqual([state.queue.pending, state.queue.pendingPairs, state.issues.length], [0, 0, 0]);
  assert.equal(typeof state.space.estimatedShots, 'number');
});

test('widening a folder to shot subfolders carries decisions saved with XMP off', async t => {
  const ctx = await setup(t, { files: { 'a.JPG': 'a', 'old/b.JPG': 'b' } });
  const narrow = await ctx.library.scan(ctx.root, false);
  await ctx.library.decide(narrow.id, narrow.items[0].id, { rating: 5, color: '3' });
  await ctx.bind('single', false, narrow.id);
  assert.equal(ctx.session, narrow.id);
  await assert.rejects(ctx.service.setLocation(ctx.shootId, 1, 'old'), e => e.code === 'UNSUPPORTED');
  await ctx.service.journal(ctx.shootId, 'close');
  const wide = await ctx.bind('single', true, narrow.id);
  assert.notEqual(ctx.session, narrow.id); assert.equal(wide.session.recursive, true);
  assert.deepEqual(wide.session.items.map(i => [i.name, i.rating, i.color]), [['a.JPG', 5, '3'], ['b.JPG', 0, null]]);
  await ctx.service.setLocation(ctx.shootId, (await ctx.state()).configRev, 'old');
});

test('next capture adjustments: default, recipe, last and primary with selective groups', async t => {
  const ctx = await setup(t);
  const style = await ctx.recipes.save({ name: 'Style', settings: { profile: { id: 'lc.color' }, light: { exposure: 0.5, contrast: 20 }, sharpening: { amount: 40 }, wb: { mode: 'custom', temperature: 4300, tint: 2 } } });
  await ctx.store.update({ defaultRecipe: style.id });
  await ctx.bind();
  const shoot = async name => { const e = await ctx.accept(); return ctx.item((await ctx.deliver(e.exposureId, name)).result.itemId); };
  const settingsOf = item => ctx.library.developGet(ctx.session, item.id).settings;
  const configure = adjustments => ctx.service.config(ctx.shootId, ctx.service.ledger(ctx.shootId).shoot.configRev, { adjustments });
  // Last on the first capture falls back to the whole default recipe.
  const first = await shoot('DSC00001.ARW');
  assert.deepEqual(settingsOf(first), style.settings); assert.equal(first.develop.recipe, style.id);
  const donor = { light: { exposure: -0.7 }, wb: { mode: 'custom', temperature: 5200, tint: 4 }, geometry: { crop: { left: 0.1 }, rotate: 'Rotate90' }, orientation: 'Rotate90' };
  await ctx.library.developSet(ctx.session, [first.id], { recipe: style.id, settings: donor });
  await configure({ groups: ['wb'] });
  const second = await shoot('DSC00002.ARW');
  assert.deepEqual(settingsOf(second), { ...style.settings, wb: donor.wb });
  await configure({ groups: ['orientation', 'light'] });
  const third = await shoot('DSC00003.ARW');
  assert.deepEqual(settingsOf(third), style.settings);
  // asShot drops the donor's kelvin, and orientation carries the rotation without the crop or exposure.
  await ctx.library.developSet(ctx.session, [third.id], { settings: { light: { exposure: -1 }, geometry: { rotate: 'Rotate180', crop: { top: 0.2 } }, orientation: 'Rotate270', wb: { mode: 'asShot', temperature: 3100, tint: -8 } } });
  await configure({ groups: ['wb', 'orientation'] });
  const fourth = await shoot('DSC00004.ARW');
  assert.deepEqual(settingsOf(fourth), { profile: { id: 'lc.color' }, light: { exposure: 0.5, contrast: 20 }, sharpening: { amount: 40 }, wb: { mode: 'asShot' }, geometry: { rotate: 'Rotate180' }, orientation: 'Rotate270' });
  // An acknowledged Develop draft of the Last photo wins over its saved settings.
  assert.deepEqual(ctx.service.primary(ctx.shootId, ctx.session, { seq: 1, id: fourth.id, settings: { wb: { mode: 'custom', temperature: 6500, tint: 0 } } }), { acceptedSeq: 1, sourceId: fourth.id });
  await configure({ groups: ['wb'] });
  assert.deepEqual(settingsOf(await shoot('DSC00005.ARW')).wb, { mode: 'custom', temperature: 6500, tint: 0 });
  // Out of order: an older exposure delivered late never becomes Last; an in-flight Last uses its frozen patch.
  const older = await ctx.accept();
  await configure({ mode: 'default' });
  const inflight = await ctx.accept();
  await configure({ mode: 'last', groups: ['wb', 'light'] });
  await ctx.deliver(older.exposureId, 'DSC00006.ARW');
  const late = ctx.item(ctx.deltas().at(-1).itemId);
  await ctx.library.developSet(ctx.session, [late.id], { settings: { light: { exposure: 2 } } });
  const next = await shoot('DSC00008.ARW');
  assert.deepEqual(settingsOf(next), style.settings);
  await ctx.deliver(inflight.exposureId, 'DSC00007.ARW');
  // Primary: a JPEG or nothing selected means Default; a stale sequence is ignored.
  await configure({ mode: 'primary', groups: ['light'] });
  ctx.service.primary(ctx.shootId, ctx.session, { seq: 2, id: null });
  assert.deepEqual(settingsOf(await shoot('DSC00009.ARW')), style.settings);
  assert.deepEqual(ctx.service.primary(ctx.shootId, ctx.session, { seq: 3, id: late.id }), { acceptedSeq: 3, sourceId: late.id });
  assert.deepEqual(ctx.service.primary(ctx.shootId, ctx.session, { seq: 2, id: first.id }), { acceptedSeq: 3, sourceId: late.id });
  assert.throws(() => ctx.service.primary(ctx.shootId, ctx.session, { seq: 4, id: late.id, settings: { light: { exposure: 9 } } }));
  assert.throws(() => ctx.service.primary(ctx.shootId, 'stale', { seq: 5, id: null }), e => e.code === 'STALE_SESSION');
  assert.deepEqual(settingsOf(await shoot('DSC00010.ARW')), { ...style.settings, light: { exposure: 2 } });
  // Recipe: the entire recipe, or only checked groups over the default; frozen against later edits.
  const product = await ctx.recipes.save({ name: 'Product', settings: { light: { exposure: 1 }, curve: { points: [[0, 0], [1, 1]] }, grain: { amount: 5 } } });
  await configure({ mode: 'recipe', recipeId: product.id, entireRecipe: true });
  const pending = await ctx.accept();
  await ctx.recipes.save({ id: product.id, name: 'Product', settings: { light: { exposure: -3 } } });
  await ctx.deliver(pending.exposureId, 'DSC00011.ARW');
  const frozen = ctx.item(ctx.deltas().at(-1).itemId);
  assert.deepEqual(settingsOf(frozen), { light: { exposure: 1 }, curve: { points: [[0, 0], [1, 1]] }, grain: { amount: 5 } });
  assert.equal(frozen.develop.recipe, product.id);
  await configure({ entireRecipe: false, groups: ['light'] });
  assert.deepEqual(settingsOf(await shoot('DSC00012.ARW')), { ...style.settings, light: { exposure: -3 } });
  await ctx.recipes.remove(product.id);
  assert.deepEqual(settingsOf(frozen), { light: { exposure: 1 }, curve: { points: [[0, 0], [1, 1]] }, grain: { amount: 5 } });
  assert.deepEqual(settingsOf(await shoot('DSC00013.ARW')), style.settings);
  // A JPEG-only exposure carries no Develop state.
  const jpeg = await ctx.accept({ roles: ['jpeg'] });
  assert.ok(!ctx.item((await ctx.deliver(jpeg.exposureId, 'DSC00014.JPG')).result.itemId).develop);
});

test('next capture metadata snapshots a preset, latches None and honors the XMP policy', async t => {
  const ctx = await setup(t, { settings: { writeSidecars: 'except-cards', metadata: { creator: 'Global Owner', caption: 'Global caption' }, tether: { initial: { pick: true } } } });
  const { preset } = await ctx.store.savePreset('Client', { metadata: { creator: 'Client Studio', copyright: '© Client', keywords: ['vase', 'blue'] } });
  await ctx.bind();
  await ctx.service.config(ctx.shootId, 1, { metadataPresetId: preset.id });
  const e1 = await ctx.accept(), a = await ctx.deliver(e1.exposureId, 'DSC00001.ARW');
  await ctx.service.config(ctx.shootId, ctx.service.ledger(ctx.shootId).shoot.configRev, { metadataPresetId: null });
  const e2 = await ctx.accept(), b = await ctx.deliver(e2.exposureId, 'DSC00002.ARW');
  assert.deepEqual(ctx.item(a.result.itemId).captureMetadata, { creator: 'Client Studio', copyright: '© Client', caption: '', keywords: ['vase', 'blue'], presetId: preset.id });
  assert.deepEqual(ctx.item(b.result.itemId).captureMetadata, { creator: '', copyright: '', caption: '', keywords: [], presetId: null });
  assert.equal(ctx.library.publicSession(ctx.library.get(ctx.session)).items[0].captureMetadata.creator, 'Client Studio');
  await ctx.library.flushSidecars();
  const sidecarA = path.join(ctx.root, 'Ceramics-0001.xmp'), sidecarB = path.join(ctx.root, 'Ceramics-0002.xmp');
  let xmpA = await fs.readFile(sidecarA, 'utf8'), xmpB = await fs.readFile(sidecarB, 'utf8');
  assert.match(xmpA, /Client Studio/); assert.match(xmpA, /© Client/); assert.match(xmpA, />vase</);
  assert.doesNotMatch(xmpA, /Global/); assert.doesNotMatch(xmpB, /Global/);
  // Another application adds its own settings and a camera creator; a later autosave keeps both.
  await fs.writeFile(sidecarB, xmpB.replace('<rdf:Description ', '<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:lr="http://ns.adobe.com/lightroom/1.0/" crs:Exposure2012="+0.50" lr:hierarchicalSubject="Studio|Vase" ')
    .replace('</rdf:Description>', '<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Seq><rdf:li>Camera Owner</rdf:li></rdf:Seq></dc:creator></rdf:Description>'));
  await ctx.store.update({ metadata: { creator: 'Later Customer', keywords: ['other'] } });
  await ctx.library.decide(ctx.session, b.result.itemId, { rating: 3 });
  await ctx.library.flushSidecars();
  xmpB = await fs.readFile(sidecarB, 'utf8');
  assert.match(xmpB, /crs:Exposure2012="\+0.50"/); assert.match(xmpB, /Studio\|Vase/); assert.match(xmpB, /Camera Owner/);
  assert.doesNotMatch(xmpB, /Later Customer|>other</);
  const restored = readXmp(xmpB, ctx.store.value, { portable: true });
  assert.deepEqual([restored.rating, restored.flag, restored.captureMetadata.presetId, restored.metadata.creator], [3, 'pick', null, 'Camera Owner']);
  // Explicit copies use the snapshot too, and the source files keep their bytes.
  const source = await fs.readFile(a.final);
  const destination = path.join(ctx.base, 'copies'); await fs.mkdir(destination);
  const copied = await new TransferService({ metadataWriter: { write: async (file, item, settings) => { assert.equal(settings.metadata.creator, item.id === a.result.itemId ? 'Client Studio' : ''); }, close: async () => {} } })
    .copy(ctx.library.get(ctx.session), destination, { includeXmp: true, metadataSettings: ctx.store.value, embedMetadata: true });
  assert.equal(copied.copied, 2);
  assert.match(await fs.readFile(path.join(destination, 'Ceramics-0001.xmp'), 'utf8'), /Client Studio/);
  assert.doesNotMatch(await fs.readFile(path.join(destination, 'Ceramics-0002.xmp'), 'utf8'), /Later Customer/);
  assert.deepEqual(await fs.readFile(a.final), source);
  // A missing preset freezes empty fields, never another customer's metadata.
  await ctx.service.config(ctx.shootId, ctx.service.ledger(ctx.shootId).shoot.configRev, { metadataPresetId: preset.id });
  await ctx.store.removePreset(preset.id);
  const e3 = await ctx.accept(), c = await ctx.deliver(e3.exposureId, 'DSC00003.ARW');
  assert.deepEqual(ctx.item(c.result.itemId).captureMetadata, { creator: '', copyright: '', caption: '', keywords: [], presetId: null });
  // Metadata-only captures are part of explicit export, and reopen without the session file restores them from XMP.
  await fs.rm(path.join(ctx.root, 'Ceramics-0001.xmp'));
  const exported = await ctx.library.exportXmp(ctx.session, { ...ctx.store.value, writeSidecars: 'never' });
  assert.equal(exported.written, 3);
  await fs.rm(path.join(ctx.dataDir, 'sessions'), { recursive: true });
  const reopened = await new Library(ctx.dataDir, { settings: () => ctx.store.value }).scan(ctx.root);
  assert.equal(reopened.items.find(i => i.name === 'Ceramics-0001.ARW').captureMetadata.creator, 'Client Studio');
});

test('autosave follows never, except-cards and always while decisions survive reopen', async t => {
  for (const policy of ['never', 'always', 'except-cards']) {
    const ctx = await setup(t, { settings: { writeSidecars: policy, tether: { initial: { rating: 4 } } } });
    await ctx.bind();
    const e = await ctx.accept({ roles: ['raw'] }), shot = await ctx.deliver(e.exposureId, 'DSC00001.ARW');
    await ctx.library.flushSidecars();
    const exists = await fs.stat(path.join(ctx.root, 'Ceramics-0001.xmp')).then(() => true, () => false);
    assert.equal(exists, policy !== 'never', policy);
    // The same policy applied to a removable session: only "always" writes there.
    const s = ctx.library.get(ctx.session); s.removable = true;
    await fs.rm(path.join(ctx.root, 'Ceramics-0001.xmp'), { force: true });
    await ctx.library.decide(ctx.session, shot.result.itemId, { rating: 4 });
    await ctx.library.flushSidecars();
    assert.equal(await fs.stat(path.join(ctx.root, 'Ceramics-0001.xmp')).then(() => true, () => false), policy === 'always', policy + ' removable');
    const reopened = await new Library(ctx.dataDir, { settings: () => ctx.store.value }).scan(ctx.root);
    assert.deepEqual([reopened.items[0].rating, reopened.items[0].exposureId, reopened.items[0].captureMetadata.presetId], [4, e.exposureId, null], policy);
  }
});

test('crash recovery replays published members once and never re-advances counters', async t => {
  const ctx = await setup(t, { settings: { tether: { initial: { rating: 2 } } } });
  await ctx.bind('session');
  await fs.mkdir(path.join(ctx.libraryRoot, 'Blue'));
  await ctx.service.setLocation(ctx.shootId, 1, 'Blue');
  const done = await ctx.accept({ key: 'shot-1', roles: ['raw'] });
  await ctx.deliver(done.exposureId, 'DSC00001.ARW');
  // JPEG first, rated by the photographer, then its RAW.
  const pair = await ctx.accept({ key: 'shot-2' });
  const jpeg = await ctx.deliver(pair.exposureId, 'DSC00002.JPG');
  await ctx.library.decide(ctx.session, jpeg.result.itemId, { rating: 5 });
  const raw = await ctx.deliver(pair.exposureId, 'DSC00002.ARW');
  // The process dies with one RAW published but not acknowledged and another still staged.
  const third = await ctx.accept({ key: 'shot-3', roles: ['raw'] });
  const unacked = await ctx.deliver(third.exposureId, 'DSC00003.ARW', { ingest: false });
  const staged = await ctx.accept({ key: 'shot-4', roles: ['raw'] });
  await ctx.deliver(staged.exposureId, 'DSC00004.ARW', { publish: false });
  const before = await ctx.state();
  await ctx.library.close();
  await ctx.open();
  const recovered = await ctx.bind('session');
  assert.equal(ctx.library.scans, 1);
  assert.deepEqual(recovered.recoveries.map(r => [r.originalName, r.state, r.action]).sort(), [['DSC00003.ARW', 'ingested', 'replayed'], ['DSC00004.ARW', 'reserved', 'publish']]);
  const replayed = ctx.item(idOf(unacked.final));
  assert.deepEqual([replayed.rating, replayed.exposureId, replayed.ordinal, replayed.captureDevelop], [2, third.exposureId, 3, true]);
  const after = await ctx.state();
  assert.deepEqual([after.counters.next, after.location.relative, after.location.recents], [before.counters.next, 'Blue', ['Blue']]);
  const duplicate = await ctx.accept({ key: 'shot-2' });
  assert.deepEqual([duplicate.exposureId, duplicate.ordinal, duplicate.counters.capture], [pair.exposureId, 2, 2]);
  assert.equal((await ctx.state()).counters.next, before.counters.next);
  const paired = ctx.item(raw.result.itemId);
  assert.deepEqual([paired.rating, paired.companion !== null], [5, true]);
  // Binding again replays nothing and applies no initial decision twice.
  await ctx.library.decide(ctx.session, replayed.id, { rating: 0 });
  const again = await ctx.bind('session');
  assert.deepEqual(again.recoveries.map(r => r.state), ['reserved']);
  assert.equal(ctx.item(replayed.id).rating, 0);
  // A restart with nothing to replay reports the reopened Library's revision, not the journal's.
  await ctx.library.close();
  await ctx.open();
  const reopened = await ctx.bind('session');
  assert.ok(ctx.service.ledger(ctx.shootId).shoot.libraryRev === reopened.libraryRev && reopened.libraryRev === (ctx.library.get(ctx.session).rev || 0));
  assert.equal((await ctx.state()).libraryRev, reopened.libraryRev);
});

test('JPEG-first edits survive a crash between RAW publication and the Library save', async t => {
  const ctx = await setup(t, { settings: { tether: { initial: { rating: 1, color: '4' } } } });
  await ctx.bind();
  const e = await ctx.accept();
  const jpeg = await ctx.deliver(e.exposureId, 'DSC00001.JPG');
  await ctx.library.decide(ctx.session, jpeg.result.itemId, { rating: 5, color: '' });
  await ctx.library.flushSidecars();
  const raw = await ctx.deliver(e.exposureId, 'DSC00001.ARW', { ingest: false });
  await ctx.library.close();
  await ctx.open();
  const bound = await ctx.bind();
  assert.deepEqual(bound.recoveries.map(r => [r.originalName, r.state]), [['DSC00001.ARW', 'ingested']]);
  const item = ctx.item(idOf(raw.final));
  assert.deepEqual([item.rating, item.color, item.exposureId, item.companion, item.captureDevelop], [5, '', e.exposureId, jpeg.final, true]);
  assert.deepEqual(ctx.library.developGet(ctx.session, item.id).settings, { profile: { id: 'lc.neutral' } });
  assert.equal(bound.session.items.length, 1);
});

test('RAW-first decisions survive a crash between JPEG publication and the Library save', async t => {
  const ctx = await setup(t, { settings: { tether: { initial: { rating: 1 } } } });
  await ctx.bind();
  const e = await ctx.accept();
  const raw = await ctx.deliver(e.exposureId, 'DSC00001.ARW');
  await ctx.library.decide(ctx.session, raw.result.itemId, { rating: 4, flag: 'pick' });
  const jpeg = await ctx.deliver(e.exposureId, 'DSC00001.JPG', { ingest: false });
  await ctx.library.close();
  // A JPEG that is not the journaled one never vouches for the RAW's saved decisions.
  const bytes = (await fs.stat(jpeg.final)).size;
  assert.equal(ctx.service.captureExposure({ path: jpeg.final, size: bytes + 1 }), null);
  await ctx.open();
  const bound = await ctx.bind();
  assert.deepEqual(bound.recoveries.map(r => [r.originalName, r.state]), [['DSC00001.JPG', 'ingested']]);
  const item = ctx.item(raw.result.itemId);
  assert.deepEqual([item.rating, item.flag, item.exposureId, item.companion], [4, 'pick', e.exposureId, jpeg.final]);
});

test('a capture whose Library save failed is saved and reported again on retry', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const e = await ctx.accept({ roles: ['raw'] });
  const save = ctx.library.save.bind(ctx.library);
  let saves = 0;
  ctx.library.save = s => saves++ ? save(s) : Promise.reject(Object.assign(new Error('Disk full.'), { code: 'NO_SPACE' }));
  const shot = await ctx.deliver(e.exposureId, 'DSC00001.ARW', { ingest: false });
  const ingest = () => ctx.service.ingest(ctx.shootId, shot.member.memberId, shot.plan.claimId, { finalRelPath: shot.plan.finalRelPath, bytes: (`DSC00001.ARW:${e.exposureId}`).length });
  await assert.rejects(ingest(), /Disk full/);
  assert.equal(ctx.deltas().length, 0);
  const retried = await ingest();
  assert.equal(saves, 2);
  assert.deepEqual(ctx.deltas().map(d => [d.itemId, d.upserts.map(u => u.id), d.firstArrival]), [[retried.itemId, [retried.itemId], true]]);
  assert.equal(ctx.service.ledger(ctx.shootId).members[shot.member.memberId].status, 'ingested');
});

test('software requests freeze intent once and are never dispatched twice', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const recipe = await ctx.recipes.save({ name: 'Before', settings: { light: { exposure: 1 } } });
  await ctx.service.config(ctx.shootId, 1, { adjustments: { mode: 'recipe', recipeId: recipe.id } });
  await assert.rejects(ctx.service.request(ctx.shootId, 'req-1', 7, 'create'), e => e.code === 'STALE_REV' && e.detail.retryable);
  ctx.service.primary(ctx.shootId, ctx.session, { seq: 7, id: null });
  assert.deepEqual(await ctx.service.request(ctx.shootId, 'req-1', 7, 'create'), { state: 'requested', dispatchAllowed: true });
  assert.deepEqual(await ctx.service.request(ctx.shootId, 'req-1', 7, 'create'), { state: 'requested', dispatchAllowed: true });
  assert.deepEqual(await ctx.service.request(ctx.shootId, 'req-1', 7, 'dispatch'), { state: 'dispatching', dispatchAllowed: true });
  assert.deepEqual(await ctx.service.request(ctx.shootId, 'req-1', 7, 'dispatch'), { state: 'dispatching', dispatchAllowed: false });
  await ctx.recipes.save({ id: recipe.id, name: 'Before', settings: { light: { exposure: -1 } } });
  const e = await ctx.accept({ requestId: 'req-1' });
  assert.deepEqual(await ctx.service.request(ctx.shootId, 'req-1', 7, 'resolve', 'failed'), { state: 'confirmed', dispatchAllowed: false, exposureId: e.exposureId });
  const shot = await ctx.deliver(e.exposureId, 'DSC00001.ARW');
  assert.deepEqual(ctx.library.developGet(ctx.session, shot.result.itemId).settings, { light: { exposure: 1 } });
  // A second burst frame of the same request freezes at its own acceptance.
  const burst = await ctx.accept({ requestId: 'req-1' });
  assert.deepEqual(ctx.library.developGet(ctx.session, (await ctx.deliver(burst.exposureId, 'DSC00002.ARW')).result.itemId).settings, { light: { exposure: -1 } });
  await assert.rejects(ctx.service.request(ctx.shootId, 'unknown', 0, 'dispatch'), e => e.code === 'STALE_REV');
  await assert.rejects(ctx.service.accept(ctx.shootId, 1, null, { key: 'k' }, ['heif'], {}), e => e.code === 'UNSUPPORTED');
  const heif = await ctx.service.member(ctx.shootId, e.exposureId, { originalName: 'DSC00001.HIF' });
  assert.equal(heif.status, 'held');
  const asset = { assetId: 'overlay-1', sha256: 'a'.repeat(64), width: 800, height: 600, bytes: 1000 };
  assert.deepEqual(await ctx.service.asset(ctx.shootId, 'bind', asset), asset);
  assert.deepEqual(await ctx.service.asset(ctx.shootId, 'lookup', { assetId: 'overlay-1' }), asset);
  assert.equal(await ctx.service.asset(ctx.shootId, 'lookup', { assetId: 'other' }), null);
  await assert.rejects(ctx.service.asset(ctx.shootId, 'bind', { ...asset, width: 5000 }), e => e.code === 'UNSUPPORTED');
  const frame = await ctx.service.sessionFrame(ctx.session, shot.result.itemId, 'preview', true, 1);
  assert.equal(frame.route, `/image/${ctx.session}/${shot.result.itemId}/preview?v=1&original=1`);
  await assert.rejects(ctx.service.sessionFrame(ctx.session, shot.result.itemId, 'preview', false, 0), e => e.code === 'STALE_REV');
  assert.equal(ctx.service.active(), true);
  const closed = await ctx.service.journal(ctx.shootId, 'close');
  assert.deepEqual([closed.state, ctx.service.active()], ['closed', false]);
  assert.deepEqual(await ctx.state(), { session: ctx.session, shootId: null });
});

test('a pending member keeps the shoot busy until it settles', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const e = await ctx.accept({ roles: ['raw'] });
  const member = await ctx.service.member(ctx.shootId, e.exposureId, { originalName: 'DSC00001.ARW', declaredBytes: 3 });
  assert.equal(ctx.service.busy(), true);
  await ctx.service.journal(ctx.shootId, 'issue', { memberId: member.memberId, code: 'CAMERA_LOST', message: 'Cable unplugged.' });
  assert.equal(ctx.service.busy(), false);
  const issue = ctx.events.find(e => e.event === 'tether-issue').payload;
  assert.deepEqual([issue.v, issue.shootId, issue.code, issue.memberId], [1, ctx.shootId, 'CAMERA_LOST', member.memberId]);
  await ctx.service.journal(ctx.shootId, 'recovery', { action: 'retry', memberId: member.memberId });
  await fs.mkdir(path.join(ctx.root, '.photocull-tether')); await fs.writeFile(path.join(ctx.root, member.stageRelPath), 'ra');
  await assert.rejects(ctx.service.reserve(ctx.shootId, member.memberId, { bytes: 2 }), e => e.code === 'INCOMPLETE');
  await ctx.service.journal(ctx.shootId, 'recovery', { action: 'finishSingle', exposureId: e.exposureId }).catch(error => assert.equal(error.code, 'INCOMPLETE'));
  // A RAW whose JPEG is still due keeps it busy too, until that pair is finished one way or another.
  const pair = await ctx.accept();
  await ctx.deliver(pair.exposureId, 'DSC00002.ARW');
  await ctx.service.journal(ctx.shootId, 'issue', { memberId: member.memberId, code: 'CAMERA_LOST', message: 'Cable unplugged.' });
  assert.deepEqual([ctx.service.ledger(ctx.shootId).exposures[pair.exposureId].status, ctx.service.busy()], ['availablePartial', true]);
  await ctx.service.journal(ctx.shootId, 'recovery', { action: 'finishSingle', exposureId: pair.exposureId });
  assert.equal(ctx.service.busy(), false);
});

test('a request is confirmed only by the photo it produced, and only the waiting request binds one', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const start = async requestId => { await ctx.service.request(ctx.shootId, requestId, null, 'create'); await ctx.service.request(ctx.shootId, requestId, null, 'dispatch'); };
  const resolve = (requestId, result) => ctx.service.request(ctx.shootId, requestId, null, 'resolve', result);
  await start('slow');
  // The trigger timed out: nothing may confirm it until a photo does.
  assert.deepEqual(await resolve('slow', 'outcomeUnknown'), { state: 'outcomeUnknown', dispatchAllowed: false, exposureId: null });
  assert.deepEqual(await resolve('slow', 'confirmed'), { state: 'outcomeUnknown', dispatchAllowed: false, exposureId: null });
  const late = await ctx.accept({ requestId: 'slow', key: 'late' });
  assert.equal(late.boundRequestId, 'slow');
  assert.deepEqual(await resolve('slow', 'failed'), { state: 'confirmed', dispatchAllowed: false, exposureId: late.exposureId });
  // The companion object of that exposure and a later frame never claim a request again.
  assert.equal((await ctx.accept({ requestId: 'slow', key: 'late' })).boundRequestId, null);
  assert.equal((await ctx.accept({ requestId: 'slow' })).boundRequestId, null);
  await start('confirmed-early');
  assert.deepEqual(await resolve('confirmed-early', 'confirmed'), { state: 'dispatching', dispatchAllowed: false, exposureId: null });
  await start('refused');
  assert.equal((await resolve('refused', 'failed')).state, 'failed');
  assert.equal((await ctx.accept({ requestId: 'refused' })).boundRequestId, null);
  assert.deepEqual(await resolve('refused', 'confirmed'), { state: 'failed', dispatchAllowed: false, exposureId: null });
  // A timed-out request never claims the photo of a shutter released after it.
  await start('timed-out');
  await resolve('timed-out', 'outcomeUnknown');
  await start('next');
  assert.equal((await ctx.accept({ requestId: 'timed-out' })).boundRequestId, null);
  assert.equal((await ctx.accept({ requestId: 'next' })).boundRequestId, 'next');
  assert.equal((await resolve('timed-out', 'failed')).state, 'failed');
});

test('after a reconnect only a capture time proves a repeated camera key is the same photo', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const key = 'sony:body-1::1:DSC00001', objectKey = `${key}:DSC00001.ARW`;
  const accept = (epoch, camera = {}) => ctx.service.accept(ctx.shootId, epoch, null, { key }, ['raw'], { model: 'ILCE-7M3', bodyId: 'body-1', ...camera });
  const first = await accept(1);
  await ctx.deliver(first.exposureId, 'DSC00001.ARW', { objectKey });
  assert.equal((await accept(1)).exposureId, first.exposureId);
  // A power-cycled body restarts its sequence numbers; without a capture time this is a new photo.
  const next = await accept(2);
  assert.notEqual(next.exposureId, first.exposureId);
  const member = await ctx.service.member(ctx.shootId, next.exposureId, { originalName: 'DSC00001.ARW', providerObjectKey: objectKey });
  assert.equal(member.status, 'announced');
  assert.equal((await ctx.deliver(next.exposureId, 'DSC00001.ARW', { objectKey })).plan.finalRelPath, 'Ceramics-0002.ARW');
  const dated = await accept(3, { captureTime: '2026:11:25 10:11:12' });
  assert.equal((await accept(4, { captureTime: '2026:11:25 10:11:12' })).exposureId, dated.exposureId);
  assert.notEqual((await accept(4, { captureTime: '2026:11:25 10:11:13' })).exposureId, dated.exposureId);
});

test('missed card shots join the shoot once, beside what arrived live', async t => {
  const ctx = await setup(t);
  let now = new Date(2026, 10, 25, 14, 0, 0);
  ctx.service.now = () => now;
  await ctx.bind();
  const body = { model: 'ILCE-7M3', bodyId: 'body-1' };
  const live = async (captureTime, at, bodyId = 'body-1') => { now = at; return ctx.service.accept(ctx.shootId, 1, null, { key: `sony:${bodyId}:${captureTime}` }, ['raw', 'jpeg'], { ...body, bodyId, captureTime }); };
  // The camera clock runs five minutes ahead of this computer.
  const first = await live('2026:11:25 14:05:10', new Date(2026, 10, 25, 14, 0, 10));
  await ctx.deliver(first.exposureId, 'DSC00010.ARW'); await ctx.deliver(first.exposureId, 'DSC00010.JPG');
  const second = await live('2026:11:25 14:05:20', new Date(2026, 10, 25, 14, 0, 20));
  await ctx.deliver(second.exposureId, 'DSC00011.ARW');
  const lostJpeg = await ctx.service.member(ctx.shootId, second.exposureId, { role: 'jpeg', originalName: 'DSC00011.JPG', providerObjectKey: 'sony:live:DSC00011.JPG', declaredBytes: 96 });
  await ctx.service.journal(ctx.shootId, 'issue', { memberId: lostJpeg.memberId, code: 'CAMERA_LOST', message: 'The camera disconnected while sending this photo.' });
  // A burst frame that arrived live, and a frame of the same second from a second body.
  const burst = await live('2026:11:25 14:05:30', new Date(2026, 10, 25, 14, 0, 30));
  await ctx.deliver(burst.exposureId, 'DSC00020.ARW', { content: 'live:DSC00020.ARW' });
  const other = await live('2026:11:25 14:05:30', new Date(2026, 10, 25, 14, 0, 31), 'body-2');
  await ctx.deliver(other.exposureId, 'DSC00021.ARW', { content: 'live:DSC00021.ARW' });

  const content = name => `card:${name}`;
  const card = (name, captureTime, handle) => ({ handle, storageId: 0x10001, name, role: /\.JPG$/.test(name) ? 'jpeg' : 'raw', bytes: Buffer.byteLength(content(name)), captureTime });
  const objects = [
    card('DSC00009.ARW', '2026:11:25 14:04:30', 9), card('DSC00009.JPG', '2026:11:25 14:04:30', 10),
    card('DSC00010.JPG', '2026:11:25 14:05:10', 12), card('DSC00010.ARW', '2026:11:25 14:05:10', 11),
    card('DSC00011.ARW', '2026:11:25 14:05:20', 13), card('DSC00011.JPG', '2026:11:25 14:05:20', 14),
    // Same second and size as the live burst frame, and the second body's file name.
    card('DSC00021.ARW', '2026:11:25 14:05:30', 20),
    card('DSC00012.ARW', '2026:11:25 14:06:00', 15), card('DSC00012.JPG', '2026:11:25 14:06:00', 16),
    // A HEIF the camera reports as a RAW format is not a photo PhotoCull pulls.
    { ...card('DSC00013.HIF', '2026:11:25 14:06:30', 17), role: 'raw' },
  ];
  const listing = { camera: body, hostRoles: ['raw', 'jpeg'] };
  const handles = plan => plan.groups.map(g => g.objects.map(o => o.handle));
  const planned = await ctx.service.backfill(ctx.shootId, 'plan', { ...listing, objects });
  // The lost JPEG travels with its RAW so the pair stays one exposure; neither the equal-size
  // burst frame nor the other body's file name stands in for a missed frame.
  assert.deepEqual([handles(planned), planned.present, planned.unsettled], [[[9, 10], [13, 14], [20], [15, 16]], 1, []]);
  // A RAW-only computer copy takes only the RAW of an exposure nothing of has arrived.
  assert.deepEqual(handles(await ctx.service.backfill(ctx.shootId, 'plan', { camera: body, hostRoles: ['raw'], objects: objects.slice(7) })), [[15]]);

  const prepare = group => ctx.service.backfill(ctx.shootId, 'prepare', { ...listing, epoch: 2, objects: group });
  const pull = async (member, name) => {
    const stage = path.join(ctx.root, ...member.stageRelPath.split('/')), receipt = { bytes: Buffer.byteLength(content(name)), sha256: sha(content(name)) };
    await fs.mkdir(path.dirname(stage), { recursive: true }); await fs.writeFile(stage, content(name));
    await ctx.service.journal(ctx.shootId, 'staged', { memberId: member.memberId, stageRelPath: member.stageRelPath, ...receipt });
    const plan = await ctx.service.reserve(ctx.shootId, member.memberId, receipt);
    await fs.link(stage, path.join(ctx.libraryRoot, ...plan.finalRelPath.split('/'))); await fs.unlink(stage);
    await ctx.service.ingest(ctx.shootId, member.memberId, plan.claimId, { finalRelPath: plan.finalRelPath, bytes: receipt.bytes });
    return plan.finalRelPath;
  };
  // While the lost JPEG may still arrive from memory it is deferred, and so is the next pass's window.
  const deferred = await ctx.service.backfill(ctx.shootId, 'plan', { ...listing, objects: objects.slice(4, 6), exclude: [lostJpeg.memberId] });
  assert.deepEqual([handles(deferred), deferred.deferred, deferred.unsettled], [[], 1, ['2026:11:25 14:05:20']]);
  // The JPEG lost in transfer is reopened, not duplicated, and completes its live RAW.
  const reopened = await prepare(objects.slice(4, 6));
  assert.deepEqual([reopened.exposureId, reopened.members.map(m => [m.handle, m.memberId, m.status])], [second.exposureId, [[14, lostJpeg.memberId, 'announced']]]);
  assert.equal(await pull(reopened.members[0], 'DSC00011.JPG'), 'Ceramics-0002.JPG');
  // The missed pair becomes one new exposure with the shoot's naming and counter.
  const before = Object.keys(ctx.service.ledger(ctx.shootId).exposures).length;
  const missed = await ctx.service.backfill(ctx.shootId, 'prepare', { ...listing, epoch: 2, hostRoles: ['jpeg'], objects: planned.groups[0].objects });
  assert.deepEqual(missed.members.map(m => [m.handle, m.originalName]), [[9, 'DSC00009.ARW'], [10, 'DSC00009.JPG']]);
  const late = async object => {
    const provider = { key: 'sony:body-1:20261125T140430:9:DSC00009', originalName: object.name };
    const accepted = await ctx.service.accept(ctx.shootId, 2, null, provider, ['raw', 'jpeg'], { ...body, captureTime: object.captureTime });
    assert.equal(accepted.exposureId, missed.exposureId);
    return ctx.service.member(ctx.shootId, accepted.exposureId, { role: object.role, originalName: object.name, providerObjectKey: provider.key + ':' + object.name, declaredBytes: object.bytes });
  };
  const liveRaw = await late(objects[0]);
  assert.equal(liveRaw.memberId, missed.members[0].memberId);
  assert.equal(await pull(liveRaw, 'DSC00009.ARW'), 'Ceramics-0005.ARW');
  const remaining = await ctx.service.backfill(ctx.shootId, 'prepare', { ...listing, epoch: 2, exclude: [liveRaw.memberId], objects: objects.slice(0, 2) });
  assert.deepEqual([remaining.members.map(m => m.memberId), remaining.deferred], [[missed.members[1].memberId], []]);
  assert.equal(await pull(missed.members[1], 'DSC00009.JPG'), 'Ceramics-0005.JPG');
  const liveJpeg = await late(objects[1]);
  assert.deepEqual([liveJpeg.memberId, liveJpeg.status], [missed.members[1].memberId, 'ingested']);
  const exposure = ctx.service.ledger(ctx.shootId).exposures[missed.exposureId];
  assert.deepEqual([exposure.captureTime, exposure.expectedHostRoles, exposure.status], ['2026:11:25 14:04:30', ['raw', 'jpeg'], 'complete']);
  // The burst frame is its own exposure.
  const frame = await prepare([objects[6]]);
  assert.notEqual(frame.exposureId, burst.exposureId);
  assert.equal(await pull(frame.members[0], 'DSC00021.ARW'), 'Ceramics-0006.ARW');
  // A pass that saw only the JPEG of a pair: the RAW written later joins the same exposure.
  const jpegFirst = await prepare([objects[8]]);
  assert.equal(await pull(jpegFirst.members[0], 'DSC00012.JPG'), 'Ceramics-0007.JPG');
  assert.deepEqual(handles(await ctx.service.backfill(ctx.shootId, 'plan', { ...listing, objects: objects.slice(7, 9) })), [[15, 16]]);
  const rawLater = await prepare(objects.slice(7, 9));
  assert.deepEqual([rawLater.exposureId, rawLater.members.map(m => m.handle)], [jpegFirst.exposureId, [15]]);
  assert.equal(await pull(rawLater.members[0], 'DSC00012.ARW'), 'Ceramics-0007.ARW');
  assert.deepEqual(ctx.service.ledger(ctx.shootId).exposures[jpegFirst.exposureId].expectedHostRoles.sort(), ['jpeg', 'raw']);
  // A second pass finds everything and changes nothing.
  const again = await ctx.service.backfill(ctx.shootId, 'plan', { ...listing, objects });
  assert.deepEqual([handles(again), again.present], [[], 5]);
  assert.deepEqual((await prepare(objects.slice(0, 2))).members, []);
  assert.equal(Object.keys(ctx.service.ledger(ctx.shootId).exposures).length, before + 3);
  assert.deepEqual((await ctx.state()).issues, []);
});

test('the card window, synced mark and test shots belong to one camera body', async t => {
  const ctx = await setup(t);
  let now = new Date(2026, 10, 25, 14, 0, 0);
  ctx.service.now = () => now;
  await ctx.bind();
  const one = { model: 'ILCE-7M3', bodyId: 'body-1' }, two = { model: 'ILCE-7M3', bodyId: 'body-2' };
  const window = camera => ctx.service.backfill(ctx.shootId, 'window', { camera });
  // Body one runs five minutes ahead of this computer; nothing has arrived from body two.
  now = new Date(2026, 10, 25, 14, 0, 10);
  const shot = await ctx.service.accept(ctx.shootId, 1, null, { key: 'sony:a' }, ['raw'], { ...one, captureTime: '2026:11:25 14:05:10' });
  await ctx.deliver(shot.exposureId, 'DSC00010.ARW');
  assert.deepEqual([await window(one), await window(two)], [{ since: '2026:11:25 14:04:00' }, { since: '2026:11:25 13:55:00' }]);

  const card = (name, captureTime, handle) => ({ handle, storageId: 0x10001, name, role: 'raw', bytes: 5, captureTime });
  const objects = [card('DSC00011.ARW', '2026:11:25 14:06:00', 1), card('DSC00012.ARW', '2026:11:25 14:06:02', 2), card('DSC00013.ARW', '2026:11:25 14:06:20', 3), card('DSC00014.ARW', '2026:11:25 14:07:00', 4)];
  const plan = detail => ctx.service.backfill(ctx.shootId, 'plan', { camera: one, hostRoles: ['raw'], objects, ...detail });
  const handles = p => p.groups.map(g => g.objects.map(o => o.handle));
  // The earlier burst frame and the lost Test Shot both fit the release window.
  const released = new Date(2026, 10, 25, 14, 1, 3).getTime();
  const tested = await plan({ testShots: [{ captureTime: '2026:11:25 14:06:00', stem: 'DSC00011' }], testReleases: [released] });
  assert.deepEqual([handles(tested), tested.tested, tested.held, tested.unsettled], [[[4]], 1, 2, ['2026:11:25 14:06:02', '2026:11:25 14:06:20']]);
  // With no clock offset known for body two, every frame near the release is held.
  const unknown = await plan({ camera: two, testReleases: [new Date(2026, 10, 25, 14, 7, 0).getTime()] });
  assert.deepEqual([handles(unknown), unknown.held], [[], 4]);

  // The synced mark never passes a photo whose transfer did not complete.
  now = new Date(2026, 10, 25, 14, 15, 0);
  await ctx.service.backfill(ctx.shootId, 'synced', { camera: one, through: '2026:11:25 14:29:00' });
  const stalled = await ctx.service.accept(ctx.shootId, 1, null, { key: 'sony:b' }, ['raw'], { ...one, captureTime: '2026:11:25 14:20:00' });
  const stalledMember = await ctx.service.member(ctx.shootId, stalled.exposureId, { role: 'raw', originalName: 'DSC00030.ARW', declaredBytes: 0xffffffff });
  await ctx.service.journal(ctx.shootId, 'issue', { memberId: stalledMember.memberId, code: 'UNSUPPORTED', message: 'Unknown size.' });
  assert.deepEqual(await window(one), { since: '2026:11:25 14:18:59' });
  assert.deepEqual(await ctx.service.backfill(ctx.shootId, 'synced', { camera: one, through: '2026:11:25 14:30:00' }), { syncedThrough: '2026:11:25 14:19:59' });
  const retry = await plan({ objects: [card('DSC00030.ARW', '2026:11:25 14:20:00', 30)] });
  assert.deepEqual([handles(retry), retry.present], [[[30]], 0]);
  const ready = await ctx.service.backfill(ctx.shootId, 'prepare', { camera: one, epoch: 2, objects: retry.groups[0].objects });
  assert.deepEqual(ready.members.map(m => [m.memberId, m.declaredBytes]), [[stalledMember.memberId, 5]]);
  await ctx.deliver(stalled.exposureId, 'DSC00030.ARW', { content: 'frame' });
  await ctx.service.backfill(ctx.shootId, 'synced', { camera: one, through: '2026:11:25 14:30:00' });
  assert.deepEqual([await window(one), await window(two)], [{ since: '2026:11:25 14:29:00' }, { since: '2026:11:25 13:55:00' }]);
  // Stopping and reopening the shoot starts a new window.
  await ctx.service.journal(ctx.shootId, 'close');
  now = new Date(2026, 10, 26, 9, 0, 0);
  await ctx.bind();
  assert.deepEqual(await window(one), { since: '2026:11:26 09:04:00' });
});

test('a file that is not the image its name promises is never published, retried or recovered', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const { exposureId } = await ctx.accept({ roles: ['raw'] });
  const member = await ctx.service.member(ctx.shootId, exposureId, { originalName: 'DSC00001.ARW', declaredBytes: 4 });
  const stage = path.join(ctx.root, ...member.stageRelPath.split('/'));
  await fs.mkdir(path.dirname(stage), { recursive: true }); await fs.writeFile(stage, 'JPEG');
  await ctx.service.journal(ctx.shootId, 'staged', { memberId: member.memberId, bytes: 4, sha256: sha('JPEG'), stageRelPath: member.stageRelPath });
  const reason = 'DSC00001.ARW does not contain the image data its name promises; it stays in staging.';
  await ctx.service.journal(ctx.shootId, 'issue', { memberId: member.memberId, code: 'INVALID_FORMAT', message: reason, retryable: false });
  const issue = ctx.events.filter(e => e.event === 'tether-issue').at(-1).payload;
  assert.deepEqual([issue.code, issue.retryable, issue.actions], ['INVALID_FORMAT', false, []]);
  await assert.rejects(ctx.service.journal(ctx.shootId, 'recovery', { action: 'retry', memberId: member.memberId }), e => e.code === 'INVALID_FORMAT');
  await assert.rejects(ctx.service.reserve(ctx.shootId, member.memberId, { bytes: 4, sha256: sha('JPEG') }));
  // A later transfer failure does not turn it back into something retryable.
  await ctx.service.journal(ctx.shootId, 'issue', { memberId: member.memberId, code: 'IO_ERROR', message: 'Disk hiccup.' });
  assert.deepEqual((await ctx.state()).issues.map(i => [i.code, i.message, i.retryable, i.actions]), [['INVALID_FORMAT', reason, false, []]]);
  await ctx.library.close();
  await ctx.open();
  const { recoveries } = await ctx.bind();
  assert.deepEqual(recoveries.map(r => [r.state, r.code, r.action]), [['held', 'INVALID_FORMAT', undefined]]);
  assert.equal(await fs.readFile(stage, 'utf8'), 'JPEG');
});

test('a staged photo survives a crash before publication and only its own bytes are ever published', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const stage = rel => path.join(ctx.root, ...rel.split('/'));
  const write = async (rel, content) => { await fs.mkdir(path.dirname(stage(rel)), { recursive: true }); await fs.writeFile(stage(rel), content); };
  const announce = async (key, originalName, declaredBytes) => {
    const { exposureId } = await ctx.accept({ key, roles: ['raw'] });
    return { exposureId, ...await ctx.service.member(ctx.shootId, exposureId, { originalName, declaredBytes }) };
  };
  const journaled = await announce('a', 'DSC00001.ARW', 3);
  await write(journaled.stageRelPath, 'one');
  await assert.rejects(ctx.service.journal(ctx.shootId, 'staged', { memberId: journaled.memberId, bytes: 4, sha256: sha('one!'), stageRelPath: journaled.stageRelPath }), e => e.code === 'INCOMPLETE');
  await assert.rejects(ctx.service.journal(ctx.shootId, 'staged', { memberId: journaled.memberId, bytes: 3, sha256: sha('one'), stageRelPath: '.photocull-tether/other.part' }), e => e.code === 'STALE_REV');
  await ctx.service.journal(ctx.shootId, 'staged', { memberId: journaled.memberId, bytes: 3, sha256: sha('one'), stageRelPath: journaled.stageRelPath, shot: { iso: 400 } });
  // Complete on disk but the process died before journaling it.
  const unjournaled = await announce('b', 'DSC00002.ARW', 3);
  await write(unjournaled.stageRelPath, 'two');
  const partial = await announce('c', 'DSC00003.ARW', 10);
  await write(partial.stageRelPath, 'thr');
  const altered = await announce('d', 'DSC00004.ARW', 4);
  await write(altered.stageRelPath, 'four');
  await ctx.service.journal(ctx.shootId, 'staged', { memberId: altered.memberId, bytes: 4, sha256: sha('four'), stageRelPath: altered.stageRelPath });
  await fs.writeFile(stage(altered.stageRelPath), 'FOUR');
  await ctx.library.close();
  await ctx.open();
  const { recoveries } = await ctx.bind();
  assert.deepEqual(recoveries.map(r => [r.originalName, r.state, r.action ?? r.code]), [
    ['DSC00001.ARW', 'staged', 'reserve'], ['DSC00002.ARW', 'held', 'INCOMPLETE'], ['DSC00003.ARW', 'held', 'INCOMPLETE'], ['DSC00004.ARW', 'held', 'INCOMPLETE']]);
  // Retries verify the journaled receipt, wherever the bytes are by then.
  assert.deepEqual([recoveries[0].bytes, recoveries[0].sha256, recoveries[1].sha256], [3, sha('one'), undefined]);
  // Unjournaled stage files, even of the declared size, are kept for inspection and never promoted.
  assert.deepEqual([await fs.readFile(stage(unjournaled.stageRelPath), 'utf8'), await fs.readFile(stage(partial.stageRelPath), 'utf8')], ['two', 'thr']);
  assert.equal(ctx.service.ledger(ctx.shootId).members[unjournaled.memberId].sha256, null);
  // A different staged file never goes out under the journaled photo's name.
  await assert.rejects(ctx.service.reserve(ctx.shootId, unjournaled.memberId, { bytes: 3, sha256: sha('TWO') }), e => e.code === 'INCOMPLETE');
  assert.deepEqual((await ctx.state()).issues.map(i => [i.memberId, i.code]), [[unjournaled.memberId, 'INCOMPLETE'], [partial.memberId, 'INCOMPLETE'], [altered.memberId, 'INCOMPLETE']]);
  const plan = await ctx.service.reserve(ctx.shootId, journaled.memberId, { bytes: 3, sha256: sha('one') });
  const root = await fs.stat(ctx.root);
  assert.deepEqual([plan.finalRelPath, plan.dirId], ['Ceramics-0001.ARW', `${root.dev}:${root.ino}`]);
  await assert.rejects(ctx.service.reserve(ctx.shootId, journaled.memberId, { bytes: 3, sha256: sha('One') }), e => e.code === 'INCOMPLETE');
  assert.equal((await ctx.state()).issues.find(i => i.memberId === journaled.memberId).code, 'INCOMPLETE');
  await ctx.service.journal(ctx.shootId, 'recovery', { action: 'retry', memberId: journaled.memberId });
  assert.equal((await ctx.service.reserve(ctx.shootId, journaled.memberId, { bytes: 3, sha256: sha('one') })).finalRelPath, 'Ceramics-0001.ARW');
  // Ingest accepts only the very file the shell published.
  await fs.writeFile(path.join(ctx.root, 'Ceramics-0001.ARW'), 'own');
  await assert.rejects(ctx.service.ingest(ctx.shootId, journaled.memberId, plan.claimId, { finalRelPath: plan.finalRelPath, bytes: 3, ino: (await fs.stat(stage(journaled.stageRelPath))).ino }), e => e.code === 'DEST_CHANGED');
  await fs.rm(path.join(ctx.root, 'Ceramics-0001.ARW'));
  await fs.link(stage(journaled.stageRelPath), path.join(ctx.root, 'Ceramics-0001.ARW'));
  await ctx.service.ingest(ctx.shootId, journaled.memberId, plan.claimId, { finalRelPath: plan.finalRelPath, bytes: 3, ino: (await fs.stat(stage(journaled.stageRelPath))).ino });
  await assert.rejects(ctx.service.reserve(ctx.shootId, journaled.memberId, { bytes: 3, sha256: sha('One') }), e => e.code === 'IO_ERROR');
  assert.equal((await ctx.service.reserve(ctx.shootId, journaled.memberId, { bytes: 3, sha256: sha('one') })).finalRelPath, 'Ceramics-0001.ARW');
});

test('filename claims are exclusive across writers and released once their capture settles', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const root = await fs.stat(ctx.root), claims = path.join(ctx.root, '.photocull-tether', 'claims');
  const claimFile = stem => path.join(claims, sha(`${root.dev}:${root.ino}\0${stem.normalize('NFC').toLowerCase()}`) + '.claim');
  // Another PhotoCull writing into the same folder holds the first name.
  await fs.mkdir(claims, { recursive: true });
  await fs.writeFile(claimFile('Ceramics-0001'), JSON.stringify({ shootId: randomUUID(), claimId: randomUUID(), exposureId: 'x', memberId: null }));
  const first = await ctx.accept();
  const raw = await ctx.deliver(first.exposureId, 'DSC00001.ARW', { publish: false });
  assert.equal(raw.plan.stem, 'Ceramics-0001-2');
  assert.equal(JSON.parse(await fs.readFile(claimFile('Ceramics-0001-2'), 'utf8')).claimId, raw.plan.claimId);
  await fs.link(path.join(ctx.root, raw.member.stageRelPath), raw.final);
  await ctx.service.ingest(ctx.shootId, raw.member.memberId, raw.plan.claimId, { finalRelPath: raw.plan.finalRelPath, bytes: (await fs.stat(raw.final)).size });
  // The JPEG still pairs under the held claim, which goes only when the exposure is complete.
  assert.equal((await ctx.deliver(first.exposureId, 'DSC00001.JPG')).plan.finalRelPath, 'Ceramics-0001-2.JPG');
  assert.deepEqual(await fs.readdir(claims), [path.basename(claimFile('Ceramics-0001'))]);
  // Losing the publish race gives up the claim file along with the name.
  const second = await ctx.accept({ roles: ['raw'] });
  const lost = await ctx.deliver(second.exposureId, 'DSC00002.ARW', { publish: false });
  await ctx.service.journal(ctx.shootId, 'conflict', { memberId: lost.member.memberId, claimId: lost.plan.claimId });
  await assert.rejects(fs.access(claimFile(lost.plan.stem)), e => e.code === 'ENOENT');
});

test('choosing a camera card as the destination is refused before anything is written to it', async t => {
  const ctx = await setup(t);
  const card = path.join(ctx.base, 'card');
  await fs.mkdir(path.join(card, 'DCIM'), { recursive: true });
  ctx.service.isCard = async root => root === card;
  await assert.rejects(ctx.service.checkDestination(card), e => e.code === 'UNSUPPORTED');
  await assert.rejects(ctx.service.bind(card, null, 'session'), e => e.code === 'UNSUPPORTED');
  assert.deepEqual(await fs.readdir(card), ['DCIM']);
  await fs.symlink(ctx.root, path.join(ctx.base, 'link'));
  assert.deepEqual(await ctx.service.checkDestination(path.join(ctx.base, 'link')), { canonicalRoot: ctx.root });
  assert.deepEqual(await fs.readdir(ctx.root), []);
  await assert.rejects(ctx.service.checkDestination('relative'), e => e.code === 'DEST_CHANGED');
});

test('a card inserted since the last device poll is still refused as a destination', async t => {
  const { spawn } = require('node:child_process');
  const readline = require('node:readline');
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-card-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const card = path.join(base, 'card'), list = path.join(base, 'devices.json');
  await fs.mkdir(path.join(card, 'DCIM'), { recursive: true }); await fs.writeFile(list, '[]');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'backend.cjs')], { stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PHOTOCULL_SMOKE_TEST: '1', PHOTOCULL_DATA_DIR: path.join(base, 'data'), PHOTOCULL_TEST_DEVICES: list } });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await lines.next()).value);
  let seq = 0;
  const call = async (method, params) => {
    const id = ++seq;
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    for (;;) { const message = await next(); if (message.id === id) return message; }
  };
  assert.ok((await next()).ready);
  assert.deepEqual((await call('devices', [])).value.devices, []);
  await fs.writeFile(list, JSON.stringify([{ root: card, name: 'CARD', identity: 'card-1' }]));
  const reply = await call('tether-check-destination', [card]);
  assert.deepEqual([reply.ok, reply.errorDetail?.code], [false, 'UNSUPPORTED']);
  child.stdin.end();
});

test('clearing an overlay reports whether another shoot still uses the shared file', async t => {
  const ctx = await setup(t);
  const asset = { assetId: 'ov-1', sha256: 'a'.repeat(64), width: 800, height: 600, bytes: 1000 };
  await ctx.bind();
  assert.deepEqual(await ctx.service.asset(ctx.shootId, 'clear'), { assetId: null, inUse: false });
  await ctx.service.asset(ctx.shootId, 'bind', asset);
  const first = ctx.shootId;
  await ctx.service.journal(first, 'close');
  ctx.root = path.join(ctx.base, 'Glass'); await fs.mkdir(ctx.root);
  await ctx.bind();
  await ctx.service.asset(ctx.shootId, 'bind', asset);
  assert.deepEqual(await ctx.service.asset(ctx.shootId, 'clear'), { assetId: 'ov-1', inUse: true });
  assert.equal(await ctx.service.asset(ctx.shootId, 'lookup', { assetId: 'ov-1' }), null);
  // Another process's journal on disk counts too.
  ctx.service.ledgers.delete(first);
  await ctx.service.asset(ctx.shootId, 'bind', asset);
  assert.deepEqual(await ctx.service.asset(ctx.shootId, 'clear'), { assetId: 'ov-1', inUse: true });
  await ctx.service.journal(ctx.shootId, 'close');
  ctx.root = path.join(ctx.base, 'Ceramics');
  await ctx.bind();
  assert.deepEqual(await ctx.service.asset(ctx.shootId, 'clear'), { assetId: 'ov-1', inUse: false });
});

test('Keep verifies the whole selection before allocating and recovers both members under one capture number', async t => {
  const ctx = await setup(t);
  await ctx.bind();
  const stage = path.join(ctx.root, '.photocull-tether');
  await fs.mkdir(stage, { recursive: true });
  const key = 'composition:launch:7';
  const files = [
    { role: 'raw', name: 'DSC00007.ARW', content: Buffer.from('II*\0sample') },
    { role: 'jpeg', name: 'DSC00007.JPG', content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
  ];
  const members = files.map(({ role, name, content }) => ({
    memberId: sha(key + ':' + role), originalName: name, bytes: content.length, sha256: sha(content),
  }));
  const stagedPath = member => path.join(stage, member.memberId + '.part');
  const keep = () => ctx.service.accept(ctx.shootId, 2, null, { key, staged: members }, ['raw', 'jpeg'], { model: 'ILCE-7M3', bodyId: 'studio' });
  await fs.writeFile(stagedPath(members[0]), files[0].content);
  await fs.writeFile(stagedPath(members[1]), Buffer.alloc(files[1].content.length));
  await assert.rejects(keep(), e => e.code === 'INCOMPLETE');
  await ctx.open();
  assert.deepEqual((await ctx.bind()).recoveries, []);
  assert.equal((await ctx.state()).counters.next, 1);
  await fs.writeFile(stagedPath(members[1]), files[1].content);
  const ledgerFile = ctx.service.ledgerFile(ctx.shootId);
  await fs.rename(ledgerFile, ledgerFile + '.saved');
  await fs.mkdir(ledgerFile);
  await assert.rejects(keep(), error => ['EISDIR', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code));
  await fs.rmdir(ledgerFile);
  await fs.rename(ledgerFile + '.saved', ledgerFile);
  await ctx.open();
  await ctx.bind();
  const accepted = await keep();
  assert.deepEqual(accepted.counters, { capture: 1, camera: 0 });
  await ctx.open();
  const reopened = await ctx.bind();
  assert.deepEqual(reopened.recoveries.map(r => [r.exposureId, r.originalName, r.sha256, r.action]).sort(),
    members.map(m => [accepted.exposureId, m.originalName, m.sha256, 'reserve']).sort());
  for (const m of members) {
    const plan = await ctx.service.reserve(ctx.shootId, m.memberId, { bytes: m.bytes, sha256: m.sha256 });
    assert.equal(plan.finalRelPath, 'Ceramics-0001' + path.extname(m.originalName));
    const target = path.join(ctx.root, plan.finalRelPath);
    await fs.link(stagedPath(m), target);
    await fs.unlink(stagedPath(m));
    await ctx.service.ingest(ctx.shootId, m.memberId, plan.claimId, { finalRelPath: plan.finalRelPath, bytes: m.bytes });
    assert.equal(sha(await fs.readFile(target)), m.sha256);
  }
  assert.equal((await keep()).exposureId, accepted.exposureId);
  assert.equal((await ctx.state()).counters.next, 2);
  assert.equal(ctx.service.busy(), false);
});
