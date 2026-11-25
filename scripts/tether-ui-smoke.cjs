// node scripts/tether-ui-smoke.cjs — Chromium renderer + real backend in browser mode, isolated
// temporary settings and synthetic photos. Browser mode has no camera, so the first phase covers the Tether
// workspace layout, Wi-Fi form, composition aids, pinned reference Compare and Settings → Tether
// with camera control disabled. A second phase simulates the desktop camera shell to cover capture,
// Live View, follow, studio flash guards, Test Shot Mode, the WB eyedropper, Stop session and capture metadata.
const { launch } = require('./launch.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixtures } = require('./fixtures.cjs');

// Stands in for the desktop shell's camera commands and events; runs in the page before app.js.
function simulateCamera() {
  const real = window.photocull, T = window.__camera = { calls: [], handlers: {}, frames: {}, shoot: null, epoch: 1, propRev: 1, shutter: '1/200', fel: false, reviewColor: null };
  const log = (...entry) => T.calls.push(entry), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const on = name => callback => { (T.handlers[name] ||= new Set()).add(callback); return () => T.handlers[name].delete(callback); };
  const jpeg = color => new Promise(resolve => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 427; const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 640, 427); canvas.toBlob(resolve, 'image/jpeg'); });
  T.emit = (name, payload) => { for (const callback of T.handlers[name] || []) callback(payload); };
  T.finishRender = () => (T.renderWaiters || []).splice(0).forEach(resolve => resolve());
  T.finishReview = () => (T.reviewWaiters || []).splice(0).forEach(resolve => resolve());
  T.finishStatus = () => (T.statusWaiters || []).splice(0).forEach(resolve => resolve());
  const shutters = ['1/160', '1/200', '1/250', '1/400'].map(id => ({ id, label: id }));
  T.snapshot = () => ({ epoch: T.epoch, state: 'ready', device: { deviceId: 'usb-1', model: 'ILCE-7M3', transport: 'usb-icc' }, actions: { trigger: true, liveView: true, halfPress: true }, capabilities: { fel: { supported: true, enabled: true } }, propRev: T.propRev,
    properties: [{ key: 'saveDestination', kind: 'enum', value: 1, display: 'PC Only', access: 'ro' }, { key: 'shutter', label: 'Shutter', kind: 'enum', value: T.shutter, display: T.shutter, access: 'rw', choices: shutters },
      { key: 'flashMode', label: 'Flash mode', kind: 'enum', value: 'Fill-flash', display: 'Fill-flash', access: 'rw', choices: [{ id: 'Fill-flash', label: 'Fill-flash' }, { id: 'Rear sync', label: 'Rear sync' }] },
      { key: 'flashComp', label: 'Flash comp.', value: '-0.7', display: '-0.7', access: 'ro' }, { key: 'felState', label: 'Flash lock', value: T.fel ? 'Locked' : 'Unlocked', display: T.fel ? 'Locked' : 'Unlocked', access: 'ro' }] });
  T.changed = key => T.emit('tether-properties', { shootId: 'shoot-1', epoch: T.epoch, propRev: ++T.propRev, changed: T.snapshot().properties.filter(p => p.key === key) });
  window.photocull = Object.freeze({ ...real, canTether: true, canDevelop: true,
    imageUrl: (session, id, kind, params) => id === T.nativePhoto ? `http://127.0.0.1:65531/camera/${kind}` : id === T.brokenPreview && kind === 'preview' ? 'data:image/jpeg;base64,AAAA' : real.imageUrl(session, id, kind, params),
    chooseFolder: async () => { log('chooseFolder', !!T.shoot); return null; },
    tetherOpen: async ({ session }) => {
      const settings = (await real.settings()).tether;
      T.shoot = { shootId: 'shoot-1', session, configRev: 1, libraryRev: 0, config: structuredClone(settings), counters: { next: 1, step: 1, resetTo: 1 }, location: { display: 'Capture', relative: '', leaf: 'Capture', recents: [] }, space: { freeBytes: 100 * 1024 ** 3, estimatedShots: 1000 } };
      return { shootId: 'shoot-1', configRev: 1, libraryRev: 0 };
    },
    tetherState: async session => T.shoot?.session === session ? structuredClone(T.shoot) : null,
    tetherConfig: async (shootId, configRev, patch) => { log('config', Object.keys(patch).sort().join()); if (T.holdConfig) await new Promise(resolve => { T.finishConfig = resolve; }); await wait(60); Object.assign(T.shoot.config, patch); T.shoot.configRev++; return { configRev: T.shoot.configRev, config: structuredClone(T.shoot.config) }; },
    tetherNamePreview: async (shootId, input) => PhotoCullNaming.renderCaptureName(input.namingTemplate, { jobName: input.jobName, counter: 1, extensions: ['.ARW'] }, { preview: true }),
    tetherPrimary: async (shootId, session, input) => { log('primary', input.seq, input.id); await wait(120); log('primary-ack', input.seq); return { acceptedSeq: input.seq, sourceId: input.id }; },
    // Like the desktop shell, discovery reports the camera this app holds as connected.
    tetherDevices: async () => ({ devices: [{ deviceId: 'usb-1', model: 'ILCE-7M3', transport: 'usb-icc', availability: T.connected ? 'connected' : 'available' }] }),
    tetherConnect: async () => { log('connect'); T.connected = true; return T.snapshot(); },
    tetherControl: async (shootId, epoch, op, extra = {}) => {
      log('control', op, ...('testSeq' in extra ? [extra.testSeq] : []));
      if (op === 'composition-on' || op === 'composition-off') T.composition = op === 'composition-on';
      if (op === 'composition-keep' || op === 'composition-discard') {
        if (T.resolveError) throw Object.assign(new Error('Test shot unavailable'), { code: T.resolveError });
        if (T.holdResolve) await new Promise(resolve => { T.finishResolve = resolve; });
        return { testSeq: extra.testSeq, exposureId: op === 'composition-keep' ? `kept-${extra.testSeq}` : undefined };
      }
      if (op === 'stop') { T.shoot = null; T.connected = false; return { state: 'offline', epoch, cleanupWarning: 'Temporary test files could not be removed.' }; }
      if (op === 'refresh') return T.snapshot();
      if (op === 'reconnect') { T.epoch++; setTimeout(() => T.emit('tether-connection', { shootId, ...T.snapshot() })); return { state: 'connecting', epoch: T.epoch }; }
      if (op === 'fel') { T.fel = !T.fel; setTimeout(() => T.changed('felState')); }
      return { state: 'ready', epoch };
    },
    tetherTrigger: async (shootId, epoch, requestId, primarySeq) => { log('trigger', primarySeq); return T.composition ? { status: 'released', state: 'released', testShot: true } : { state: 'requested' }; },
    tetherPresented: async (shootId, exposureId, ordinal, quality) => { log('presented', exposureId, quality); return {}; },
    tetherSetProperty: async (shootId, epoch, key, value) => {
      log('set', key, value);
      if (T.staleOnce) { T.staleOnce = false; throw Object.assign(new Error('Setting changed on the camera.'), { code: 'STALE_REV' }); }
      if (key === 'shutter') T.shutter = value;
      return { properties: T.snapshot().properties.filter(p => p.key === key), propRev: ++T.propRev };
    },
    tetherReviewFrame: async ({ session, id }) => {
      log('review-frame', id);
      if (id === T.holdReview) await new Promise(resolve => (T.reviewWaiters ||= []).push(resolve));
      return { blob: T.reviewColor ? await jpeg(T.reviewColor) : await (await fetch(real.imageUrl(session, id, 'preview', ''))).blob() };
    },
    tetherCompositionFrame: async (shootId, testSeq, previewRev) => { log('composition-frame', testSeq, previewRev); return { width: 640, height: 427, blob: await jpeg(T.testColor || (previewRev > 1 ? '#8090a0' : testSeq % 2 ? '#2f6f4f' : '#4f2f6f')) }; },
    tetherRecover: async ({ op, exposureId }) => { log('recover', op, exposureId); return {}; },
    tetherLibrary: async () => { log('library'); return structuredClone(T.library); },
    tetherLive: async (shootId, epoch, enabled) => { log('live', enabled); return enabled ? { streamId: T.frames['stream-a'] ? 'stream-c' : 'stream-a', state: 'streaming' } : { state: 'off' }; },
    // Once held, the first stream's next poll hangs until the test rejects it, as a retired stream's request would.
    tetherLiveFrame: async (shootId, epoch, streamId, afterSeq) => {
      T.frames[streamId] = (T.frames[streamId] || 0) + 1;
      if (streamId === 'stream-a' && T.holdA) return new Promise((resolve, reject) => { T.rejectA = () => reject(Object.assign(new Error('Live View stream closed.'), { code: 'STREAM_CLOSED' })); });
      await wait(30);
      return { streamId, seq: afterSeq + 1, jpegBytes: 1, blob: await jpeg(streamId === 'stream-a' ? '#446688' : '#886644') };
    },
    developGet: async (session, id) => ({ settings: structuredClone(T.saved?.[id] || {}) }),
    developInfo: async () => ({ asShot: { temp: 5500, tint: 0 }, base: { wb: { mode: 'asShot', temp: 5500, tint: 0 } } }),
    developSet: async (session, ids, value) => { (T.saved ||= {})[ids[0]] = structuredClone(value.settings); log('developSet', ids, value.settings.wb); return { items: [] }; },
    developRender: async (session, id, settings) => {
      log('develop-render', id);
      if (T.holdRender) await new Promise(resolve => (T.renderWaiters ||= []).push(resolve));
      const blob = await jpeg(settings?.wb?.mode === 'custom' ? '#808080' : '#9b8269'); (T.rendered ||= []).push(blob);
      return { width: 640, height: 427, blob };
    },
    // The RAW's camera preview description, held until the test releases it.
    previewStatus: async (session, id, kind, original) => {
      const status = await real.previewStatus(session, id, kind, original);
      if (id !== T.embedded) return status;
      log('preview-status', id);
      if (T.holdStatus) await new Promise(resolve => (T.statusWaiters ||= []).push(resolve));
      return { ...status, info: { ...status.info, type: 'embedded', tag: 'PreviewImage', source: 'Embedded PreviewImage' } };
    },
    lensDatabase: async () => ({ installed: false }),
    onTetherConnection: on('tether-connection'), onTetherProperties: on('tether-properties'), onTetherConfig: on('tether-config-changed'), onTetherTransfer: on('tether-transfer'),
    onTetherLibrary: on('tether-library-delta'), onTetherLive: on('tether-live-state'), onTetherIssue: on('tether-issue'), onTetherComposition: on('tether-composition'),
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-tether-ui-')), data = path.join(root, 'data'), photos = path.join(root, 'photos');
  await fixtures(photos, 4);
  await require('sharp')({ create: { width: 960, height: 640, channels: 3, background: '#9b8269' } }).jpeg().toFile(path.join(photos, 'DSC_0002.jpg'));
  let app; const errors = [], checks = [];
  const check = name => checks.push(name);
  try {
    app = await launch({ env: { ...process.env, PHOTOCULL_DATA_DIR: data } });
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    // Chromium requests /favicon.ico on its own; the backend refuses it.
    page.on('console', message => { if (message.type() === 'error' && !/favicon\.ico$/.test(message.location().url)) errors.push(message.text()); });
    await page.locator('#tether-sidebar-section').waitFor();
    await page.evaluate(async () => syncSettings(await photocull.settings({ writeSidecars: 'never' })));
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    await page.waitForFunction(() => document.querySelector('#count-all').textContent === '4');
    const settings = () => page.evaluate(() => photocull.settings().then(s => s.tether));
    const until = async (test, what) => { const deadline = Date.now() + 10000; let value; while (Date.now() < deadline) { value = await settings(); if (test(value)) return value; await page.waitForTimeout(100); } throw new Error(`settings never matched: ${what}`); };
    const press = async key => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(key); };
    // Counts overlay pixels matching a predicate inside the drawn photo.
    const overlay = (kind, region = 'all') => page.evaluate(([kind, region]) => {
      const canvas = document.querySelector('#image-viewport .overlay-layer'); if (!canvas || canvas.hidden) return -1;
      const d = loupe.view.drawn, dpr = window.devicePixelRatio || 1, ctx = canvas.getContext('2d');
      const x0 = Math.ceil(d.left * dpr), y0 = Math.ceil(d.top * dpr), w = Math.floor(d.width * dpr), h = Math.floor(d.height * dpr);
      const strip = region === 'edges' ? Math.floor(w * .08) : w;
      const data = ctx.getImageData(x0, y0, strip, h).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (kind === 'any' ? a > 0 : kind === 'green' ? a > 60 && g > 150 && r < 90 && b < 90 : kind === 'red' ? a > 60 && r > 150 && g < 90 && b < 90 : false) n++;
      }
      return n;
    }, [kind, region]);
    const waitOverlay = async (kind, test, region) => { const deadline = Date.now() + 10000; let n; while (Date.now() < deadline) { n = await overlay(kind, region); if (test(n)) return n; await page.waitForTimeout(100); } throw new Error(`overlay ${kind} stayed at ${n}`); };

    const visible = selector => page.locator(selector).isVisible();
    const pressed = selector => page.locator(selector).getAttribute('aria-pressed');
    const histogramInk = () => page.evaluate(() => { const c = document.querySelector('#tether-inspector-histogram'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });

    assert.equal(await page.locator('#tether-status-pill').textContent(), 'Desktop only');
    assert.equal(await page.locator('#inspector-tabs').count(), 0, 'the inspector has no Details/Tether sub-tabs');
    for (const selector of ['#tether-dock', '#tether-stage-bar', '#tether-inspector-histogram-panel']) assert.equal(await visible(selector), false, `${selector} stays out of plain Review`);
    assert.equal(await visible('#sources'), true); assert.equal(await visible('#image-details'), true);
    // J belongs to the tether contexts only; plain culling keeps it unbound.
    await press('j'); assert.equal((await settings()).composition.warning.shown, false, 'J is inert in plain Review');
    check('plain Review: no sub-tabs, J unbound');

    await page.locator('#tether-mode').click();
    await page.waitForFunction(() => state.mode === 'tether' && document.body.classList.contains('tether-active'));
    assert.equal(await pressed('#tether-mode'), 'true'); assert.equal(await pressed('#review-mode'), 'false');
    for (const selector of ['#tether-dock', '#tether-stage-bar', '#review', '#inspector', '#tether-inspector-histogram-panel', '#metadata', '#color-labels', '#detail-decision']) assert.equal(await visible(selector), true, `${selector} is part of the studio`);
    assert.equal(await visible('#sources'), false, 'the dock replaces Sources');
    await page.waitForFunction(() => document.querySelector('#tether-histogram-source').textContent !== '');
    assert.ok(await histogramInk() > 0, 'the inspector histogram draws the selected photo');
    assert.equal(await page.locator('#tether-capture').isDisabled(), true);
    assert.match(await page.locator('#tether-capture-reason').textContent(), /desktop app/);
    assert.match(await page.locator('#tether-panel-note').textContent(), /desktop app/);
    await press('b'); assert.equal(await visible('#tether-dock'), false, 'B hides the dock');
    await press('b'); assert.equal(await visible('#tether-dock'), true);
    await press('i'); assert.equal(await visible('#inspector'), false, 'I hides the inspector');
    await press('i'); assert.equal(await visible('#inspector'), true);
    check('Tether workspace: dock, stage bar, Review stage, histogram and EXIF together');

    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const stageBar = () => page.evaluate(() => {
      const bar = document.getElementById('tether-stage-bar'), [aids, end] = bar.children, box = bar.getBoundingClientRect(), follow = document.querySelector('.tether-follow-field').getBoundingClientRect();
      const buttons = [...aids.querySelectorAll('.button')].map(button => button.getBoundingClientRect());
      const sameRow = r => r.top < follow.bottom && r.bottom > follow.top;
      return { density: bar.dataset.density, labels: [...aids.querySelectorAll('.button > span')].filter(span => span.offsetWidth).length,
        collides: buttons.some(r => sameRow(r) && r.right > follow.left - 1), outside: [...buttons, end.getBoundingClientRect()].some(r => r.left < box.left - .5 || r.right > box.right + .5) };
    });
    for (const width of [1920, 1600, 1440, 1366, 1280, 1100, 960]) for (const inspector of [true, false]) {
      await page.setViewportSize({ width, height: 960 });
      if (await visible('#inspector') !== inspector) await press('i');
      await settle();
      const bar = await stageBar(), where = `${width} px${inspector ? '' : ', inspector hidden'}, ${bar.density}`;
      assert.equal(bar.collides, false, `no stage bar button runs under Follow at ${where}`);
      assert.equal(bar.outside, false, `the stage bar keeps every control inside it at ${where}`);
      if (width === 1920 && !inspector) assert.deepEqual([bar.density, bar.labels], ['full', 10], 'a wide stage shows every label');
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    if (!await visible('#inspector')) await press('i');
    check('stage bar: labels step down with the stage width and never collide with Follow');

    const tabs = [['#tether-check-a7m3', /USB Connection: PC Remote/, /Use USB for α7 III/], ['#tether-check-a7c2', /USB Connection Mode: PC Remote/, null], ['#tether-check-a7c2-wifi', /192\.168\.122\.1/, null]];
    for (const [tab, steps, note] of tabs) {
      await page.locator(tab).click();
      assert.equal(await page.locator(tab).getAttribute('aria-selected'), 'true');
      assert.match(await page.locator('#tether-checklist-steps').textContent(), steps, tab);
      assert.equal(await visible('#tether-checklist-note'), !!note, tab);
      if (note) assert.match(await page.locator('#tether-checklist-note').textContent(), note);
    }
    assert.match(await page.locator('#tether-checklist-steps').textContent(), /PC Remote: On/);
    await page.locator('#tether-check-a7c2-wifi').focus(); await page.keyboard.press('Home');
    assert.equal(await page.locator('#tether-check-a7m3').getAttribute('aria-selected'), 'true', 'Home moves to the first checklist tab');
    check('camera checklists: α7 III USB only, α7C II USB and Wi-Fi');

    await page.locator('#tether-wifi-add').click();
    await page.locator('#tether-wifi-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tether-wifi-add').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#tether-wifi-ip').getAttribute('placeholder'), '192.168.122.1');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tether-wifi-ip');
    assert.equal(await visible('#tether-wifi-ssh-fields'), false);
    await page.locator('#tether-wifi-auth').selectOption('ssh');
    assert.equal(await visible('#tether-wifi-user'), true);
    assert.equal(await page.locator('#tether-wifi-password').getAttribute('type'), 'password');
    assert.equal(await page.locator('#tether-wifi-password').getAttribute('autocomplete'), 'off');
    assert.match(await page.locator('#tether-wifi-ssh-fields').textContent(), /Never saved to disk/);
    await page.locator('#tether-wifi-auth').selectOption('plain');
    assert.equal(await visible('#tether-wifi-ssh-fields'), false); assert.equal(await visible('#tether-wifi-plain-note'), true);
    await page.locator('#tether-wifi-auth').selectOption('auto');
    assert.equal(await visible('#tether-wifi-plain-note'), false);
    assert.equal(await page.locator('#tether-wifi-connect').isDisabled(), true, 'Wi-Fi needs the desktop app');
    assert.match(await page.locator('#tether-wifi-status').textContent(), /desktop app/);
    assert.equal(await visible('#tether-wifi-fingerprint'), false);
    await page.locator('#tether-wifi-ip').focus(); await page.keyboard.press('Escape');
    await page.locator('#tether-wifi-form').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tether-wifi-add', 'Escape returns focus to Add by IP');
    check('Wi-Fi form: Auto, SSH credentials, Plaintext');

    await page.locator('#tether-job-name').fill('Studio');
    await page.locator('#tether-format').fill('{Name}_');
    await page.locator('#tether-tokens button', { hasText: '+Counter:4' }).click();
    assert.equal(await page.locator('#tether-format').inputValue(), '{Name}_{Counter:4}');
    await page.waitForFunction(() => /Studio_0001\.ARW \+ Studio_0001\.JPG/.test(document.querySelector('#tether-sample').textContent));
    await until(s => s.namingTemplate === '{Name}_{Counter:4}', 's.namingTemplate === {Name}_{Counter:4}');
    await page.locator('#tether-format').fill('{Nope}');
    await page.waitForFunction(() => document.querySelector('#tether-format').getAttribute('aria-invalid') === 'true');
    assert.equal((await settings()).namingTemplate, '{Name}_{Counter:4}', 'an invalid format is never saved');
    await page.locator('#tether-format').fill('{Name}_{Counter:4}');
    await page.locator('#tether-tool-adjustments > summary').click();
    await page.locator('#tether-adjust-mode').selectOption('recipe');
    await page.locator('#tether-recipe-row').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tether-groups input').first().isDisabled(), true, 'entire recipe locks the groups');
    await page.locator('#tether-adjust-mode').selectOption('primary');
    await page.locator('#tether-recipe-row').waitFor({ state: 'hidden' });
    assert.match(await page.locator('#tether-adjust-source').textContent(), /Primary/);
    await until(s => s.adjustments.mode === 'primary', 's.adjustments.mode === primary');
    check('dock naming tokens, sample, validation and adjustment modes');

    assert.equal(await visible('#tether-aids-drawer'), false);
    await page.locator('#tether-aids-popover-btn').click();
    await page.locator('#tether-aids-drawer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tether-aids-popover-btn').getAttribute('aria-expanded'), 'true');
    await page.locator('#tether-grid-shown').check();
    const thirds = await waitOverlay('any', n => n > 0);
    assert.equal(await pressed('#tether-stage-guides'), 'true', 'the stage bar mirrors the drawer');
    await page.locator('#tether-grid-type').selectOption('goldenSpiral');
    await page.locator('#tether-grid-spiral').waitFor({ state: 'visible' });
    await waitOverlay('any', n => n > 0 && n !== thirds);
    await until(s => s.composition.grid.shown && s.composition.grid.type === 'goldenSpiral', 's.composition.grid.shown && s.composition.grid.type === goldenSpiral');
    await page.locator('#tether-stage-guides').click();
    await waitOverlay('any', n => n === -1);
    assert.equal(await page.locator('#tether-grid-shown').isChecked(), false, 'the stage toggle turns guides off');
    await page.locator('#tether-aspect-ratio').selectOption('4:5');
    await page.locator('#tether-stage-aspect').click();
    await waitOverlay('any', n => n > 0, 'edges');
    await until(s => s.composition.aspect.shown && s.composition.aspect.ratio === '4:5', 's.composition.aspect.shown && s.composition.aspect.ratio === 4:5');
    await page.locator('#tether-aspect-shown').uncheck();
    await page.locator('#tether-aids-drawer').focus(); await page.keyboard.press('Escape');
    await page.locator('#tether-aids-drawer').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tether-aids-popover-btn', 'Escape returns focus to Configure aids');

    await press('m');
    await page.waitForFunction(() => document.querySelector('#overlay-status').textContent === 'Focus mask on');
    await waitOverlay('green', n => n > 50);
    assert.equal(await pressed('#tether-stage-mask'), 'true');
    await page.locator('#tether-stage-mask').click(); await until(s => !s.composition.mask.shown, '!s.composition.mask.shown');

    await press('j');
    await page.waitForFunction(() => document.querySelector('#overlay-status').textContent === 'Exposure warning on');
    assert.equal(await pressed('#tether-stage-warning'), 'true');
    await page.locator('#tether-aids-popover-btn').click();
    await page.locator('#tether-warning-high').fill('180'); await page.locator('#tether-warning-high').dispatchEvent('change');
    await waitOverlay('red', n => n > 50);
    await page.locator('#tether-warning-low').fill('200'); await page.locator('#tether-warning-low').dispatchEvent('change');
    assert.notEqual(await page.locator('#tether-composition-status').textContent(), '', 'low ≥ high is rejected with a message');
    const warning = (await settings()).composition.warning;
    assert.deepEqual([warning.shown, warning.high, warning.low], [true, 180, 5]);
    await page.locator('#tether-aids-close').click(); await page.locator('#tether-aids-drawer').waitFor({ state: 'hidden' });
    await press('j'); await until(s => !s.composition.warning.shown, '!s.composition.warning.shown');
    assert.equal(await pressed('#tether-stage-warning'), 'false');
    check('stage bar and aids drawer: golden spiral, 4:5 matte, focus mask (M), exposure warning (J) with validation');

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('#tether-aids-popover-btn').click(); await page.locator('#tether-aids-drawer').waitFor({ state: 'visible' });
    const drawerFit = () => page.evaluate(() => {
      const drawer = document.getElementById('tether-aids-drawer').getBoundingClientRect(), body = document.querySelector('.tether-drawer-body'), dock = document.getElementById('review-dock').getBoundingClientRect();
      const header = document.querySelector('.tether-drawer-header').getBoundingClientRect();
      return { above: drawer.bottom <= dock.top, scrolls: body.scrollHeight > body.clientHeight, header: header.top >= drawer.top && header.bottom <= drawer.bottom };
    });
    assert.deepEqual(await drawerFit(), { above: true, scrolls: true, header: true }, 'a short window keeps the aids above the filmstrip and scrolls their body');
    await page.locator('#tether-autopause').scrollIntoViewIfNeeded();
    assert.deepEqual(await drawerFit(), { above: true, scrolls: true, header: true }, 'scrolling to the last aid keeps the header in place');
    await page.setViewportSize({ width: 1440, height: 960 }); await settle();
    assert.equal((await drawerFit()).above, true, 'the drawer is placed again when the window grows');
    await page.locator('#tether-aids-close').click(); await page.locator('#tether-aids-drawer').waitFor({ state: 'hidden' });
    for (const [width, height] of [[1280, 360], [320, 350]]) {
      await page.setViewportSize({ width, height }); await settle();
      if (!await visible('#tether-aids-popover-btn')) continue;
      // A narrow window can lay the dock over the stage bar, so the drawer is opened by command.
      await page.evaluate(() => tether.toggleDrawer(true)); await page.locator('#tether-aids-drawer').waitFor({ state: 'visible' });
      const box = await page.evaluate(() => { const r = document.getElementById('tether-aids-drawer').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; });
      assert.ok(box.top >= 0 && box.bottom <= box.height, `the drawer stays inside a ${width}×${height} window: ${JSON.stringify(box)}`);
      await page.evaluate(() => tether.toggleDrawer(false)); await page.locator('#tether-aids-drawer').waitFor({ state: 'hidden' });
    }
    await page.setViewportSize({ width: 1440, height: 960 }); await settle();
    check('aids drawer: ends above the filmstrip and the window edge, with a fixed header and scrolling body');

    await press('l'); assert.equal(await visible('#tether-live-stage'), false, 'Live View needs the desktop app');
    const reference = await page.evaluate(() => state.selected);
    await page.locator('#tether-pin').click();
    await page.locator('.compare.pinned').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => state.mode), 'compare');
    assert.equal(await visible('#tether-dock'), true, 'the studio survives the pinned Compare');
    assert.equal(await page.locator('.reference-badge').textContent(), 'Reference');
    assert.equal(await page.locator('.compare-pane').nth(1).locator('.compare-waiting').isVisible(), true, 'the incoming pane waits for a capture');
    await press('ArrowRight');
    await page.waitForFunction(() => document.querySelectorAll('.compare-pane')[1]?.getAttribute('aria-label')?.startsWith('Incoming: DSC_'));
    assert.match(await page.locator('.compare-pane').first().getAttribute('aria-label'), new RegExp(`Reference: ${(await page.evaluate(id => state.session.items.find(i => i.id === id).name, reference)).replace('.', '\\.')}`));
    assert.equal(await page.locator('#tether-pin span').textContent(), 'Unpin reference');
    assert.equal(await pressed('#tether-pin'), 'true');
    await page.locator('.compare-pane').first().getByRole('button', { name: 'Unpin' }).click();
    await page.waitForFunction(() => state.mode === 'tether');
    assert.equal(await page.locator('#tether-pin span').textContent(), 'Pin reference');
    check('Pin reference enters two-pane Compare; Unpin returns to Tether');

    await page.locator('#review-mode').click();
    await page.waitForFunction(() => state.mode === 'review' && !document.body.classList.contains('tether-active'));
    assert.equal(await visible('#sources'), true); assert.equal(await visible('#tether-dock'), false);
    await page.keyboard.press('Control+k'); await page.locator('#command-query').fill('tether');
    const rows = await page.locator('#command-results [role=option]').evaluateAll(nodes => nodes.map(n => [n.textContent, n.getAttribute('aria-disabled')]));
    assert.ok(rows.some(([text, disabled]) => /Tether workspace/.test(text) && disabled === 'false'), 'the workspace is in the palette');
    assert.ok(rows.some(([text, disabled]) => /Capture with tethered camera/.test(text) && disabled === 'true'), 'capture is listed but disabled in browser mode');
    assert.ok(rows.some(([text, disabled]) => /Configure composition and review aids/.test(text) && disabled === 'false'));
    await page.locator('#command-query').fill('tether workspace'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.mode === 'tether');

    await press('Control+,'); await page.locator('#settings-dialog').waitFor({ state: 'visible' }); await page.locator('[data-settings-tab="tether"]').click();
    await page.locator('#settings-tether-follow').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#settings-tether-naming').inputValue(), '{Name}_{Counter:4}');
    await page.locator('#settings-tether-follow').selectOption('off');
    await page.locator('#settings-tether-chime').check();
    await page.locator('#settings-tether-counter-step').fill('2');
    await page.locator('#settings-tether-layout').selectOption('session');
    await page.locator('#settings-save').click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
    const saved = await settings();
    assert.deepEqual([saved.follow.mode, saved.chime, saved.counterStep, saved.layout], ['off', true, 2, 'session']);
    await page.waitForFunction(() => document.querySelector('#tether-follow-mode').value === 'off' && document.querySelector('#tether-chime').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('#tether-counter-step').inputValue(), '2');
    await page.locator('#tether-chime').click(); await until(s => s.chime === false, 's.chime === false');
    check('palette lists the workspace and tether actions; Settings → Tether persists');

    // Desktop tethering, simulated: the bridge's camera shell is swapped before app.js runs; the renderer and Node backend stay real.
    await page.route('**/app.js', async route => { const original = await route.fetch(); await route.fulfill({ response: original, body: `(${simulateCamera})();\n${await original.text()}` }); });
    await page.reload();
    await page.locator('#tether-sidebar-section').waitFor();
    await page.evaluate(async folder => { syncSettings(await photocull.settings({ tether: { follow: { mode: 'whenReady', pauseOnInspect: false, developedReview: false } } })); await window.loadTestFolder(folder); }, photos);
    await page.waitForFunction(() => document.querySelector('#count-all').textContent === '4');
    const calls = () => page.evaluate(() => __camera.calls);
    const clearCalls = () => page.evaluate(() => { __camera.calls = []; });
    const untilCall = async (test, what) => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if ((await calls()).some(test)) return; await page.waitForTimeout(50); } throw new Error(`never called: ${what}`); };
    const ids = await page.evaluate(() => filtered().map(i => i.id));
    let rev = 0;
    const arrive = (index, ordinal, patch = {}) => page.evaluate(([id, ordinal, patch, rev]) => {
      const item = state.session.items.find(i => i.id === id);
      __camera.emit('tether-library-delta', { shootId: 'shoot-1', session: state.session.id, rev, firstArrival: ordinal > 0, ordinal, itemId: id, upserts: [{ ...item, ...(ordinal ? { exposureId: `E${ordinal}`, ordinal } : {}), ...patch }] });
    }, [ids[index], ordinal, patch, ++rev]);
    const startShoot = async () => {
      await page.locator('#tether-dock-start').click(); await page.locator('#tether-start-dialog').waitFor({ state: 'visible' });
      await page.locator('#tether-start-confirm').click();
      await page.waitForFunction(() => tether.active() && tether.connected());
    };
    await page.locator('#tether-mode').click(); await page.waitForFunction(() => state.mode === 'tether');
    await startShoot();
    assert.equal(await visible('#tether-stop'), true, 'a running shoot offers Stop session');
    assert.equal(await page.locator('#tether-capture').isDisabled(), false);
    check('simulated camera: session started and connected');

    await page.locator('#tether-discover').click();
    await page.waitForFunction(() => tether.camera.devices[0]?.availability === 'connected');
    const deviceState = () => page.locator('#tether-device .tether-device-state').textContent();
    assert.equal(await deviceState(), 'Connected');
    await page.evaluate(() => __camera.emit('tether-connection', { ...__camera.snapshot(), state: 'lost' }));
    assert.equal(await page.locator('#tether-camera-usb').textContent(), 'USB Lost');
    assert.equal(await deviceState(), 'Lost', 'the camera row follows the live link, not discovery');
    await page.evaluate(() => __camera.emit('tether-connection', { ...__camera.snapshot(), state: 'reconnecting' }));
    assert.equal(await deviceState(), 'Reconnecting…');
    await page.evaluate(() => __camera.emit('tether-connection', { ...__camera.snapshot(), state: 'offline' }));
    assert.equal(await page.locator('#tether-camera-usb').textContent(), 'USB Disconnected');
    assert.equal(await deviceState(), 'Disconnected', 'an offline camera keeps its row badge');
    await page.evaluate(() => __camera.emit('tether-connection', __camera.snapshot()));
    assert.equal(await deviceState(), 'Connected');
    check('camera row badge follows Link: Lost, Reconnecting and Disconnected replace a stale connected');

    await page.locator('#tether-format').fill('{Nope}');
    await page.waitForFunction(() => document.querySelector('#tether-format').getAttribute('aria-invalid') === 'true');
    await clearCalls(); await page.locator('#tether-capture').click();
    await page.waitForFunction(() => /naming format/.test(document.querySelector('#toast').textContent));
    assert.ok(!(await calls()).some(c => c[0] === 'trigger'), 'an invalid naming format blocks the shutter');
    await page.locator('#tether-format').fill('{Name}-{Counter:4}');
    await page.waitForFunction(() => document.querySelector('#tether-format').getAttribute('aria-invalid') === 'false');
    await page.waitForTimeout(700); await clearCalls();
    await press('ArrowRight');
    await page.locator('#tether-job-name').fill('Barrier');
    await page.locator('#tether-capture').click();
    await untilCall(c => c[0] === 'trigger', 'trigger');
    {
      const log = await calls(), trigger = log.findIndex(c => c[0] === 'trigger'), sent = log.filter(c => c[0] === 'primary').map(c => c[1]);
      assert.ok(log.findIndex(c => c[0] === 'config' && /jobName/.test(c[1])) < trigger, `the debounced job name reaches Node before the shutter: ${JSON.stringify(log)}`);
      const acked = log.slice(0, trigger).filter(c => c[0] === 'primary-ack').map(c => c[1]);
      assert.ok(sent.length > 0, 'the new selection is published as Primary');
      assert.equal(log[trigger][1], Math.max(...sent), `the shutter carries the newest Primary: ${JSON.stringify(log)}`);
      assert.ok(acked.includes(log[trigger][1]), `and Node acknowledged it first: ${JSON.stringify(log)}`);
    }
    check('shutter barrier: invalid naming refused, config and acknowledged Primary flushed first');

    await clearCalls(); await page.locator('#tether-reconnect').click();
    await untilCall(c => c[0] === 'control' && c[1] === 'reconnect', 'reconnect');
    await page.waitForFunction(() => tether.camera.epoch === __camera.epoch && tether.connected());
    await clearCalls();
    const beforeJumpEpoch = await page.evaluate(() => tether.camera.epoch);
    await page.evaluate(() => { __camera.propRev += 5; __camera.emit('tether-properties', { shootId: 'shoot-1', epoch: tether.camera.epoch, propRev: __camera.propRev, changed: [{ key: 'shutter', label: 'Shutter', kind: 'enum', value: '1/250', display: '1/250', access: 'rw', choices: ['1/160', '1/200', '1/250', '1/400'].map(id => ({ id, label: id })) }] }); });
    await page.waitForFunction(() => document.querySelector('#tether-prop-shutter').value === '1/250');
    assert.equal(await page.evaluate(() => tether.camera.epoch), beforeJumpEpoch, 'a propRev jump applies updates without reconnecting');
    assert.ok(!(await calls()).some(c => c[0] === 'control' && c[1] === 'reconnect'), 'multi-property updates never trigger a reconnect');
    await page.evaluate(() => { __camera.staleOnce = true; });
    await page.locator('#tether-prop-shutter').selectOption('1/200');
    await untilCall(c => c[0] === 'control' && c[1] === 'refresh', 'stale property refresh');
    assert.ok(!(await calls()).some(c => c[0] === 'control' && c[1] === 'reconnect'), 'stale property recovery refreshes without reconnecting');
    await page.evaluate(() => {
      tether.camera.devices.push({ deviceId: 'wifi:192.168.1.42', model: 'ILCE-7CM2', transport: 'wifi-ptpip', availability: 'available', address: '192.168.1.42', auth: 'ssh', sshAdvertised: true, needsCredentials: true });
      tether.render();
    });
    await page.locator('#tether-device [data-device-id="wifi:192.168.1.42"]').click();
    await page.locator('#tether-wifi-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tether-wifi-ip').inputValue(), '192.168.1.42');
    assert.equal(await page.locator('#tether-wifi-auth').inputValue(), 'ssh');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tether-wifi-user');
    await page.locator('#tether-wifi-cancel').click();
    await page.locator('#tether-wifi-form').waitFor({ state: 'hidden' });
    check('Property jumps stay connected, stale writes use refresh, and discovered Wi-Fi opens pre-filled SSH auth');

    await press('l');
    await page.waitForFunction(() => tether.live.bitmap && !document.querySelector('#tether-live-stage').hidden);
    const boxes = await page.evaluate(() => { const box = id => document.getElementById(id).getBoundingClientRect().toJSON(); return { stage: box('tether-live-stage'), image: box('image-stage'), dock: box('review-dock'), inert: document.getElementById('image-stage').inert }; });
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(boxes.stage[key] - boxes.image[key]) < 1.5, `expanded Live View covers the photo stage: ${key}`);
    assert.ok(boxes.stage.bottom <= boxes.dock.top + 1 && boxes.dock.height > 40, 'the filmstrip and decision bar stay uncovered');
    assert.equal(boxes.inert, true, 'covered photo controls are inert');
    assert.equal(await visible('#filmstrip'), true);
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('#image-stage')), false, 'Tab never reaches the covered controls'); }
    await page.evaluate(() => { __camera.holdA = true; });
    await page.waitForFunction(() => !!__camera.rejectA);
    await page.evaluate(() => { __camera.epoch++; __camera.emit('tether-connection', { shootId: 'shoot-1', ...__camera.snapshot() }); __camera.emit('tether-live-state', { shootId: 'shoot-1', epoch: __camera.epoch, streamId: 'stream-b', state: 'streaming' }); });
    await page.waitForFunction(() => (__camera.frames['stream-b'] || 0) >= 2);
    await page.evaluate(() => __camera.rejectA());
    await page.waitForFunction(() => (__camera.frames['stream-b'] || 0) >= 6);
    assert.deepEqual(await page.evaluate(() => [tether.live.enabled, tether.live.streamId, tether.live.open]), [true, 'stream-b', true], 'the restarted stream is adopted and a retired poll cannot stop it');
    await page.evaluate(() => document.getElementById('tether-live-viewport').focus());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#tether-live-stage').hidden);
    assert.equal(await page.evaluate(() => document.getElementById('image-stage').inert), false);
    check('Live View: stage over the photo only, inert controls, restarted stream adopted, stale poll ignored');

    await page.evaluate(() => select(filtered()[0].id));
    await page.locator('#tether-pin').click(); await page.locator('.compare.pinned').waitFor({ state: 'visible' });
    await page.locator('.compare-pane').first().click();
    await page.evaluate(() => { document.querySelector('.compare-pane').dataset.kept = 'yes'; });
    await clearCalls(); await arrive(2, 1);
    await untilCall(c => c[0] === 'presented' && c[1] === 'E1', 'presented E1');
    assert.equal(await page.evaluate(() => state.selected), ids[0], 'the active reference keeps the selection');
    assert.equal(await page.evaluate(() => document.querySelector('.compare-pane').dataset.kept), 'yes', 'the reference pane is not rebuilt');
    assert.match(await page.locator('.compare-pane').nth(1).getAttribute('aria-label'), /^Incoming: DSC_0003/);
    assert.deepEqual((await calls()).find(c => c[0] === 'presented'), ['presented', 'E1', 'settled']);
    check('pinned Compare: the new capture fills the incoming pane without stealing the reference selection');

    await clearCalls();
    await page.evaluate(() => { state.busy = true; }); await arrive(3, 2);
    await page.waitForTimeout(300); await page.locator('#tether-follow-pause').click();
    await page.evaluate(() => { state.busy = false; }); await page.waitForTimeout(1300);
    assert.ok(!(await calls()).some(c => c[0] === 'presented'), 'a deferred capture is not shown after following was paused');
    assert.equal(await visible('#tether-arrival-pill'), true);
    await page.locator('#tether-follow-pause').click();
    await untilCall(c => c[0] === 'presented' && c[1] === 'E2', 'presented E2');
    await clearCalls();
    await page.evaluate(() => { state.busy = true; }); await arrive(1, 3);
    await page.waitForTimeout(300); await page.evaluate(() => { state.busy = false; });
    await untilCall(c => c[0] === 'presented' && c[1] === 'E3', 'presented E3');
    assert.deepEqual((await calls()).find(c => c[0] === 'presented'), ['presented', 'E3', 'settled'], 'a deferred When Ready capture stays When Ready');
    check('follow policy rechecked at display; deferred retries keep their mode');

    await page.locator('.compare-pane').first().getByRole('button', { name: 'Unpin' }).click();
    await page.waitForFunction(() => state.mode === 'tether');
    await page.evaluate(() => { const tool = document.getElementById('tether-tool-adjustments'); tool.open = true; });
    await page.locator('#tether-developed').check();
    await clearCalls(); await arrive(0, 4, { raw: true });
    await untilCall(c => c[0] === 'presented' && c[1] === 'E4', 'presented E4');
    await page.waitForFunction(() => document.querySelector('#review-image').src.startsWith('blob:') && document.querySelector('#preview-source').textContent === 'Developed RAW');
    check('developed review shows the developed frame for a RAW capture');
    await page.locator('#tether-developed').uncheck();

    await page.locator('#export').click(); await page.locator('#export-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#export-xmp').isDisabled(), true, 'nothing to export yet');
    await page.keyboard.press('Escape'); await page.locator('#export-dialog').waitFor({ state: 'hidden' });
    await arrive(3, 0, { captureMetadata: { creator: 'Ana Studio', copyright: '© Studio', caption: '', keywords: ['look', 'red'], presetId: null } });
    await page.evaluate(id => select(id), ids[3]);
    await page.waitForFunction(() => /Ana Studio/.test(document.querySelector('#metadata').textContent));
    const details = await page.locator('#metadata').evaluate(node => Object.fromEntries([...node.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent])));
    assert.deepEqual([details.Creator, details.Copyright, details.Keywords, details.Caption], ['Ana Studio', '© Studio', 'look, red', undefined]);
    await page.locator('#export').click(); await page.locator('#export-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#export-xmp').isDisabled(), false, 'frozen capture metadata can be written to source XMP');
    await page.keyboard.press('Escape'); await page.locator('#export-dialog').waitFor({ state: 'hidden' });
    check('Details show frozen capture metadata; Write source XMP enabled for it');

    const alertShown = selector => page.locator(selector).evaluate(node => !node.hidden && node.getBoundingClientRect().height > 0);
    assert.equal(await page.locator('#tether-prop-flashMode').inputValue(), 'Fill-flash');
    assert.equal(await page.locator('#tether-prop-flashComp').textContent(), '-0.7 EV');
    assert.deepEqual(await page.locator('#tether-properties .tether-property > label').evaluateAll(nodes => nodes.map(n => n.textContent).filter(t => /Shutter|Flash/.test(t))), ['Shutter', 'Flash mode', 'Flash comp.', 'Flash lock']);
    assert.equal(await visible('#tether-fel'), true, 'FEL is offered when the body supports it');
    assert.equal(await pressed('#tether-fel'), 'false');
    await clearCalls(); await page.locator('#tether-fel').click();
    await page.waitForFunction(() => document.querySelector('#tether-fel').getAttribute('aria-pressed') === 'true');
    assert.deepEqual((await calls()).find(c => c[0] === 'control'), ['control', 'fel']);
    assert.equal(await page.locator('#tether-prop-felState').textContent(), 'Locked');
    check('studio flash: Flash Mode, Flash Comp in EV and FEL lock state');

    const showProperties = changed => page.evaluate(changed => { __camera.propRev++; __camera.emit('tether-properties', { shootId: 'shoot-1', epoch: tether.camera.epoch, propRev: __camera.propRev, changed }); }, changed);
    const lcd = () => page.locator('#tether-lcd').evaluate(node => [...node.children].map(span => ({ text: span.textContent, title: span.title, clipped: span.scrollWidth > span.clientWidth + .5 || span.getBoundingClientRect().right > node.getBoundingClientRect().right + .5 })));
    const drive = 'Set with the camera’s drive dial; PhotoCull cannot change it over USB';
    await showProperties([{ key: 'program', label: 'Mode', value: 'M', display: 'M', access: 'ro' }, { key: 'aperture', label: 'Aperture', value: 'f/8', display: 'f/8', access: 'ro' }, { key: 'iso', label: 'ISO', value: 100, display: '100', access: 'ro' },
      { key: 'evComp', label: 'Exposure comp.', value: 0, display: '±0.0', access: 'ro' }, { key: 'drive', label: 'Drive mode', kind: 'enum', value: 'Single', display: 'Single', access: 'ro', reason: drive, choices: [{ id: 'Single', label: 'Single' }] }]);
    await page.waitForFunction(() => document.querySelector('[data-lcd=iso]').textContent === 'ISO 100');
    const strip = await lcd();
    assert.deepEqual(strip.filter(s => s.clipped), [], 'no exposure readout is cut off');
    assert.deepEqual([strip[3].text, strip[3].title, strip[4].text], ['ISO 100', 'ISO: ISO 100', '±0.0 EV']);
    await showProperties([{ key: 'iso', label: 'ISO', value: 102400, display: '102400', access: 'ro' }, { key: 'evComp', label: 'Exposure comp.', value: 3, display: '+3.0', access: 'ro' }, { key: 'aperture', label: 'Aperture', value: 'f/22', display: 'f/22', access: 'ro' }]);
    await page.waitForFunction(() => document.querySelector('[data-lcd=iso]').textContent === 'ISO 102400');
    assert.deepEqual((await lcd()).filter(s => s.clipped), [], 'the widest readouts still fit');
    const hint = await page.locator('#tether-prop-drive-reason').evaluate(node => ({ text: node.textContent, title: node.title, clipped: node.scrollWidth > node.clientWidth + .5, lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)) }));
    assert.deepEqual([hint.text, hint.title, hint.clipped], [drive, drive, false], 'a lock hint wraps whole and carries its text as a tooltip');
    assert.ok(hint.lines > 1, `the long hint wraps: ${hint.lines} line(s)`);
    assert.equal(await page.locator('label[for=tether-prop-drive]').getAttribute('title'), 'Drive mode');
    assert.equal(await page.locator('#tether-prop-drive').getAttribute('title'), `Single · ${drive}`);
    check('camera panel: exposure strip never clips; lock hints wrap with full tooltips');

    await page.locator('#tether-tool-flash > summary').click();
    assert.equal(await page.locator('#tether-flash-sync').inputValue(), '200', 'the MS300V-safe 1/200 is the default sync limit');
    assert.equal(await alertShown('#tether-sync-warning'), false);
    await page.locator('#tether-prop-shutter').selectOption('1/400');
    await page.waitForFunction(() => !document.querySelector('#tether-sync-warning').hidden);
    assert.equal(await page.locator('#tether-sync-warning').textContent(), 'Shutter 1/400 exceeds 1/200 sync limit — curtain band risk');
    assert.equal(await alertShown('#tether-stage-sync-warning'), true, 'the stage bar repeats the sync warning');
    assert.equal(await page.locator('.tether-property:has(#tether-prop-shutter)').evaluate(row => row.classList.contains('is-sync-warn')), true);
    await page.evaluate(() => { __camera.shutter = '1/200'; __camera.changed('shutter'); });
    await page.waitForFunction(() => document.querySelector('#tether-sync-warning').hidden && document.querySelector('#tether-stage-sync-warning').hidden);
    assert.equal(await page.locator('.tether-property:has(#tether-prop-shutter)').evaluate(row => row.classList.contains('is-sync-warn')), false);
    check('sync guard: 1/400 over the 1/200 limit warns in the dock and stage bar; 1/200 clears it');

    await page.locator('#tether-flash-recycle').selectOption('1000');
    await untilCall(c => c[0] === 'config' && /flash/.test(c[1]), 'flash config saved');
    await clearCalls(); await page.locator('#tether-capture').click();
    await untilCall(c => c[0] === 'trigger', 'trigger before recycling');
    await page.waitForFunction(() => /^Recycling \d\.\d s$/.test(document.querySelector('#tether-capture').innerText) && document.querySelector('#tether-capture').disabled);
    await press('t'); await page.waitForTimeout(100);
    assert.equal((await calls()).filter(c => c[0] === 'trigger').length, 1, 'T waits for the strobe to recycle');
    await page.waitForFunction(() => !document.querySelector('#tether-capture').disabled && /^Capture/.test(document.querySelector('#tether-capture').innerText), null, { timeout: 3000 });
    await page.evaluate(() => {
      const s = __camera.shoot;
      s.config.flash = { ...s.config.flash, syncLimit: 1000, recycleMs: 3500 };
      __camera.emit('tether-config-changed', { ...structuredClone(s), configRev: ++s.configRev });
    });
    assert.equal(await page.locator('#tether-flash-sync').inputValue(), '1000');
    assert.equal(await page.locator('#tether-flash-recycle').inputValue(), '3500');
    assert.equal(await page.locator('#tether-flash-recycle option:checked').textContent(), '3.5 s');
    check('recycle cooldown: countdown on Capture holds the software shutter, then releases it');

    await clearCalls();
    await page.evaluate(() => { __camera.holdConfig = true; });
    await page.locator('#tether-job-name').fill('Second setup');
    await page.locator('#tether-capture').click();
    await page.waitForFunction(() => !!__camera.finishConfig);
    await arrive(3, 5);
    await page.evaluate(() => { __camera.holdConfig = false; __camera.finishConfig(); });
    await page.waitForFunction(() => !tether.capturing);
    assert.ok(!(await calls()).some(c => c[0] === 'trigger'), 'a body release during the settings flush blocks the pending software shutter');

    const selected = await page.evaluate(() => state.selected), filmCount = await page.locator('#filmstrip .film-card').count();
    await clearCalls(); await page.locator('#tether-composition-toggle').click();
    await untilCall(c => c[0] === 'control' && c[1] === 'composition-on', 'composition-on');
    await page.waitForFunction(() => !document.querySelector('#tether-composition-banner').hidden);
    assert.match(await page.locator('#tether-composition-banner').textContent(), /Test Shot Mode — shots preview here without saving or advancing counter/);
    assert.equal(await pressed('#tether-stage-composition'), 'true', 'the stage bar mirrors Test Shot Mode');
    assert.equal(await page.locator('#tether-composition-keep').isDisabled(), true); assert.equal(await page.locator('#tether-composition-discard').isDisabled(), true);
    await page.locator('#tether-capture').click();
    await page.waitForFunction(() => document.querySelector('#tether-capture').classList.contains('is-recycling'));
    const testDeadline = await page.evaluate(() => tether.recycleUntil);
    await press('l');
    await page.waitForFunction(() => tether.stageExpanded() && tether.live.bitmap);
    const testShot = (seq, previewRev = 1, pairComplete = true) => page.evaluate(([seq, previewRev, pairComplete]) => __camera.emit('tether-composition', { shootId: 'shoot-1', active: true, hasShot: true, testSeq: seq, previewRev, pairComplete, meta: { iso: 100, shutter: '1/160', aperture: 'f/8', flash: 'Fired' } }), [seq, previewRev, pairComplete]);
    const showing = seq => page.waitForFunction(seq => loupe.item?.id === `tether-test-${seq}` && document.querySelector('#review-image').src.startsWith('blob:') && document.querySelector('#review-image').dataset.complete === 'yes', seq);
    await testShot(1, 1, false); await showing(1);
    assert.equal(await page.evaluate(() => tether.live.open && tether.live.docked), true);
    assert.ok(await page.evaluate(() => tether.recycleUntil) > testDeadline, 'a fresh body exposure extends an active cooldown');
    assert.equal(await page.locator('#tether-composition-keep').isDisabled(), true);
    assert.match(await page.locator('#tether-composition-meta').textContent(), /Waiting for RAW/);
    const rawFirst = await page.locator('#review-image').getAttribute('src');
    await testShot(1, 2); await testShot(1, 2);
    await page.waitForFunction(url => document.querySelector('#review-image').currentSrc !== url && document.querySelector('#review-image').complete, rawFirst);
    assert.equal((await calls()).filter(c => c[0] === 'composition-frame' && c[1] === 1 && c[2] === 2).length, 1);
    await page.waitForFunction(() => document.querySelector('#tether-histogram-source').textContent === 'Test shot · not saved');
    const liveFrames = await page.evaluate(() => __camera.frames['stream-c']);
    await page.waitForFunction(count => __camera.frames['stream-c'] >= count + 8, liveFrames);
    assert.equal(await page.locator('#tether-histogram-source').textContent(), 'Test shot · not saved', 'ongoing live frames leave the test histogram visible');
    await page.evaluate(() => __camera.emit('tether-connection', { ...__camera.snapshot(), state: 'lost' }));
    assert.equal(await page.evaluate(() => tether.recycling()), 0, 'disconnect clears the strobe deadline');
    await page.evaluate(() => __camera.emit('tether-connection', __camera.snapshot()));
    await page.waitForFunction(() => document.querySelector('#tether-histogram-source').textContent === 'Test shot · not saved');
    assert.equal(await page.locator('#preview-source').textContent(), 'Test shot · not saved');
    assert.match(await page.locator('#metadata').textContent(), /Fired/);
    assert.deepEqual([await page.evaluate(() => state.selected), await page.locator('#filmstrip .film-card').count()], [selected, filmCount], 'the filmstrip and selection stay on the session');
    assert.equal(await page.locator('#tether-composition-keep').isDisabled(), false);
    await page.locator('#tether-stage-guides').click(); await waitOverlay('any', n => n > 0);
    await page.locator('#tether-stage-guides').click(); await waitOverlay('any', n => n === -1);
    const decisions = () => page.evaluate(() => state.session.items.map(i => [i.id, i.flag, i.rating, i.color, i.trashed]));
    const before = await decisions();
    for (const key of ['x', '1', 'Delete', 'p', 'u', '6', 'Shift+Backspace']) await press(key);
    assert.deepEqual(await decisions(), before);
    assert.equal(await visible('#delete-prompt'), false);
    assert.match(await page.locator('#toast').textContent(), /Test Shot before culling/);
    for (const button of ['#pick', '#reject', '#clear', '#rating button', '#color-labels button']) assert.equal(await page.locator(button).first().isDisabled(), true);
    for (const [code, message] of [['PAIR_PENDING', /RAW companion/], ['STALE_SHOT', /newer test shot/]]) {
      await page.evaluate(code => { __camera.resolveError = code; }, code);
      await page.locator('#tether-composition-discard').click();
      assert.match(await page.locator('#toast').textContent(), message);
      assert.equal(await page.evaluate(() => state.testShot.seq), 1);
    }
    await page.evaluate(() => { __camera.resolveError = null; });
    const firstUrl = await page.locator('#review-image').getAttribute('src');
    await page.evaluate(() => { const revoke = URL.revokeObjectURL; window.__revoked = []; URL.revokeObjectURL = url => { __revoked.push(url); revoke.call(URL, url); }; });
    await clearCalls(); await page.locator('#tether-composition-discard').click();
    await untilCall(c => c[0] === 'control' && c[1] === 'composition-discard', 'composition-discard');
    await page.waitForFunction(selected => loupe.item?.id === selected && !state.testShot, selected);
    assert.equal(await page.locator('#tether-composition-keep').isDisabled(), true);
    assert.equal(await page.evaluate(() => tether.stageExpanded()), true, 'Discard restores expanded Live View');
    assert.deepEqual((await calls()).find(c => c[1] === 'composition-discard'), ['control', 'composition-discard', 1]);
    assert.ok(await page.evaluate(url => __revoked.includes(url), firstUrl), 'the discarded frame is released');
    await testShot(2); await showing(2);
    await page.locator('#tether-follow-pause').click();
    await page.evaluate(() => { __camera.holdResolve = true; });
    await clearCalls(); await page.locator('#tether-composition-keep').click();
    await untilCall(c => c[0] === 'control' && c[1] === 'composition-keep', 'composition-keep');
    assert.deepEqual((await calls()).find(c => c[1] === 'composition-keep'), ['control', 'composition-keep', 2]);
    await testShot(3); await showing(3);
    await arrive(2, 6, { exposureId: 'kept-2' });
    await page.evaluate(() => { __camera.holdResolve = false; __camera.finishResolve(); });
    await page.waitForFunction(() => /kept/.test(document.querySelector('#toast').textContent));
    await page.evaluate(() => tether.misfire.chain);
    assert.ok(!(await calls()).some(c => c[0] === 'review-frame' && c[1] === ids[2]), 'an early library delta for Keep does not reread the exposure');
    assert.equal(await page.evaluate(() => state.testShot?.seq), 3, 'a late Keep reply leaves the newer frame visible');
    await page.locator('#tether-composition-keep').click();
    await page.waitForFunction(() => !state.testShot && tether.stageExpanded());
    await testShot(4); await showing(4);
    await clearCalls(); await page.locator('#tether-stage-composition').click();
    await untilCall(c => c[0] === 'control' && c[1] === 'composition-off', 'composition-off');
    await page.waitForFunction(selected => loupe.item?.id === selected && document.querySelector('#tether-composition-banner').hidden, selected);
    assert.equal(await pressed('#tether-composition-toggle'), 'false');
    check('Test Shot Mode: preview with aids, Discard and Keep, Off restores the session photo');

    assert.equal(await page.evaluate(() => tether.stageExpanded()), true, 'Off restores expanded Live View');
    assert.equal(await page.evaluate(() => tether.recycling()), 0, 'leaving Test Shot Mode clears its last cooldown');
    await press('l');
    await page.locator('#tether-live-stage').waitFor({ state: 'hidden' });
    await clearCalls(); await arrive(2, 7, { exposureId: 'kept-3' });
    await page.evaluate(() => tether.misfire.chain);
    assert.ok(!(await calls()).some(c => c[0] === 'review-frame' && c[1] === ids[2]), 'a delayed Keep delta stays deduplicated after Test Shot Mode ends');
    const warmJpeg = await fs.readFile(path.join(photos, 'DSC_0002.jpg'));
    await page.route('http://127.0.0.1:65531/camera/**', route => route.fulfill({ contentType: 'image/jpeg', body: warmJpeg }));
    await page.evaluate(id => { __camera.nativePhoto = id; __camera.reviewColor = '#9b8269'; }, ids[1]);
    await arrive(1, 0, { raw: true, contentRev: 1 });
    await page.evaluate(id => select(id), ids[1]);
    await page.waitForFunction(() => loupe.el.image.currentSrc.startsWith('http://127.0.0.1:65531/') && loupe.el.image.complete);
    await page.waitForFunction(() => !document.querySelector('#tether-wb-pick').disabled);
    await page.locator('#tether-wb-pick').click();
    assert.equal(await pressed('#tether-wb-pick'), 'true');
    assert.equal(await page.locator('#image-viewport').evaluate(node => getComputedStyle(node).cursor), 'crosshair');
    await page.waitForFunction(() => loupe.el.image.currentSrc.startsWith('blob:') && loupe.el.image.complete);
    await page.evaluate(() => { __camera.reviewColor = '#000000'; });
    const zoom = await page.evaluate(() => loupe.zoomed);
    const box = await page.locator('#review-image').boundingBox();
    await clearCalls(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await untilCall(c => c[0] === 'developSet', 'developSet');
    const firstWb = (await calls()).find(c => c[0] === 'developSet')[2];
    {
      const [, setIds, wb] = (await calls()).find(c => c[0] === 'developSet');
      assert.deepEqual(setIds, [ids[1]]);
      assert.equal(wb.mode, 'custom'); assert.ok(wb.temp < 4500 && wb.temp > 2500, `a warm patch sets a lower custom Kelvin: ${wb.temp}`);
    }
    await page.waitForFunction(() => /^WB set to \d+ K · Tint [+-]?\d+/.test(document.querySelector('#toast').textContent));
    assert.equal(await pressed('#tether-wb-pick'), 'false', 'one pick disarms the eyedropper');
    assert.equal(await page.evaluate(() => loupe.zoomed), zoom, 'the pick click does not zoom');
    await page.waitForFunction(() => loupe.el.image.currentSrc.startsWith('blob:') && !document.querySelector('#tether-wb-pick').disabled);
    await page.locator('#tether-wb-pick').click();
    await clearCalls(); await page.locator('#review-image').click();
    await untilCall(c => c[0] === 'developSet', 'second WB pick');
    assert.deepEqual((await calls()).find(c => c[0] === 'developSet')[2], firstWb, 'neutral pixels retain the WB that rendered them');
    check('WB eyedropper: camera and developed stage pixels keep a neutral second pick steady');

    await page.locator('#develop-mode').click();
    await page.waitForFunction(() => document.querySelector('#develop-timing').textContent.includes('settled'));
    await page.locator('#develop-split').click();
    assert.equal(await page.locator('#develop-wb-pick').isDisabled(), true);
    await page.locator('#develop-split').click();
    await page.locator('#develop-before').click();
    await page.waitForFunction(() => document.querySelector('#develop-timing').textContent.includes('Before'));
    await page.evaluate(() => { __camera.holdRender = true; });
    await page.locator('#develop-wb-pick').click();
    await page.waitForFunction(() => __camera.renderWaiters?.length > 0);
    await page.locator('#develop-image').click();
    assert.equal(await pressed('#develop-wb-pick'), 'true', 'clicking the old Before image cannot apply WB');
    await page.locator('#settings-open').click();
    await page.locator('#settings-dialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.equal(await pressed('#develop-wb-pick'), 'true', 'Escape closes the dialog first');
    await page.evaluate(() => { __camera.holdRender = false; __camera.finishRender(); });
    await page.waitForFunction(() => document.querySelector('#develop-timing').textContent.includes('After'));
    await page.locator('#develop-image').click();
    assert.equal(await pressed('#develop-wb-pick'), 'false', 'the decoded After frame accepts the pick');
    await page.locator('#tether-mode').click();
    check('Develop WB: Split and pending Before transitions block picks, dialogs own Escape');

    await page.evaluate(id => { __camera.holdReview = id; __camera.reviewColor = '#000000'; }, ids[2]);
    await clearCalls(); await arrive(2, 8);
    await page.waitForFunction(() => __camera.reviewWaiters?.length > 0);
    await arrive(3, 9);
    await page.evaluate(() => {
      const s = __camera.shoot;
      s.location.relative = 'Second setup';
      __camera.emit('tether-config-changed', { ...structuredClone(s), configRev: ++s.configRev });
    });
    await arrive(0, 10);
    await page.evaluate(id => select(id), ids[0]);
    await page.waitForFunction(() => !document.querySelector('#tether-misfire-pill').hidden);
    assert.match(await page.locator('#tether-misfire-pill').textContent(), /Possible flash misfire/);
    await page.locator('#tether-misfire-dismiss').click();
    await page.evaluate(() => { __camera.holdReview = null; __camera.finishReview(); });
    assert.ok(!(await calls()).some(c => c[0] === 'review-frame' && c[1] === ids[3]), 'a queued preview for the old subfolder is retired');
    assert.equal(await alertShown('#tether-misfire-pill'), false);
    check('misfire alert: a near-black capture raises a dismissible warning');

    // A burst on a new set: frame 1 fires, frames 2 and 3 are dark while the strobe recycles.
    await page.evaluate(() => {
      const s = __camera.shoot;
      s.location.relative = 'Burst';
      __camera.emit('tether-config-changed', { ...structuredClone(s), configRev: ++s.configRev });
    });
    for (const [index, ordinal, color] of [[1, 11, '#9b8269'], [2, 12, '#000000'], [3, 13, '#000000']]) {
      await page.evaluate(color => { __camera.reviewColor = color; }, color);
      await arrive(index, ordinal); await page.evaluate(() => tether.misfire.chain);
    }
    await page.evaluate(() => { __camera.reviewColor = null; });
    const misfireBadges = () => page.evaluate(ids => ids.map(id => !!filmNodes.get(id)?.querySelector('.mini-misfire')), ids);
    assert.deepEqual(await misfireBadges(), [true, false, true, true], 'only the dark frames carry a misfire badge');
    assert.match(await page.evaluate(id => filmNodes.get(id).getAttribute('aria-description'), ids[2]), /Possible flash misfire/);
    const viewMisfire = async index => { await page.evaluate(id => select(id), ids[index]); await page.waitForFunction(id => loupe.item?.id === id, ids[index]); return alertShown('#tether-misfire-pill'); };
    assert.equal(await viewMisfire(1), false, 'the frame that fired shows no misfire warning');
    assert.equal(await viewMisfire(2), true);
    assert.match(await page.locator('#tether-misfire-detail').textContent(), /almost black|darker/);
    await page.locator('#tether-misfire-dismiss').click();
    assert.equal(await alertShown('#tether-misfire-pill'), false);
    assert.equal(await viewMisfire(3), true, 'dismissing one frame leaves the next dark frame flagged');
    assert.equal(await viewMisfire(2), false, 'a dismissed frame stays dismissed');
    assert.equal(await viewMisfire(1), false);
    assert.deepEqual(await misfireBadges(), [true, false, true, true], 'dismissing keeps the thumbnail badge');
    await page.evaluate(() => setMode('grid'));
    await page.waitForFunction(() => document.querySelectorAll('#grid .grid-card .mini-misfire').length === 3);
    await page.evaluate(() => setMode('tether')); await page.waitForFunction(() => state.mode === 'tether');
    check('burst misfire: only dark frames are flagged, badged in the filmstrip and grid, and dismissed per photo');

    if (await pressed('#tether-follow-pause') === 'true') await page.locator('#tether-follow-pause').click();
    await page.evaluate(() => { const tool = document.getElementById('tether-tool-adjustments'); tool.open = true; });
    await page.locator('#tether-developed').check();
    const itemOf = id => page.evaluate(id => structuredClone(state.session.items.find(i => i.id === id)), id);
    const jpegFirst = await itemOf(ids[2]), rawLater = await itemOf(ids[3]);
    const emitDelta = delta => page.evaluate(([delta, rev]) => __camera.emit('tether-library-delta', { shootId: 'shoot-1', session: state.session.id, rev, ...delta }), [delta, ++rev]);
    await page.evaluate(id => { __camera.embedded = id; __camera.holdStatus = true; }, ids[3]);
    await clearCalls();
    await emitDelta({ firstArrival: true, ordinal: 14, exposureId: 'E14', itemId: ids[2], pairState: 'waiting', upserts: [{ ...jpegFirst, raw: false, exposureId: 'E14', ordinal: 14 }] });
    await untilCall(c => c[0] === 'presented' && c[1] === 'E14', 'presented E14');
    assert.equal(await page.evaluate(() => loupe.item?.id), ids[2], 'the JPEG shows first');
    await page.waitForTimeout(400);
    assert.deepEqual((await calls()).filter(c => c[0] === 'primary' && c[2] === null), [], 'the JPEG-only moment keeps the current Primary');
    assert.match(await page.locator('#tether-adjust-source').textContent(), /waiting for its RAW/);
    await emitDelta({ firstArrival: false, ordinal: 14, exposureId: 'E14', itemId: ids[3], pairState: 'paired', remap: [{ from: ids[2], to: ids[3] }], upserts: [{ ...rawLater, raw: true, exposureId: 'E14', ordinal: 14, contentRev: (rawLater.contentRev || 0) + 1 }] });
    await page.waitForFunction(id => loupe.item?.id === id && document.querySelector('#review-image').src.startsWith('blob:') && document.querySelector('#preview-source').textContent === 'Developed RAW', ids[3]);
    await untilCall(c => c[0] === 'primary' && c[2] === ids[3], 'the RAW publishes itself as Primary');
    await untilCall(c => c[0] === 'preview-status' && c[1] === ids[3], 'camera preview status requested');
    await page.evaluate(() => { __camera.holdStatus = false; __camera.finishStatus(); });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#preview-source').textContent(), 'Developed RAW', 'a late camera preview description leaves the developed source');
    assert.equal(await page.locator('#camera-preview').isHidden(), true, 'and does not raise the Camera preview badge');
    check('RAW+JPEG: a JPEG-first capture shows its developed RAW once the RAW lands, with accurate stage badges and Primary kept');

    await emitDelta({ firstArrival: false, upserts: [jpegFirst] });
    await page.waitForFunction(id => state.session.items.some(i => i.id === id), ids[2]);
    await page.evaluate(() => {
      const create = URL.createObjectURL; window.__created = [];
      window.__urlOf = new Map();
      URL.createObjectURL = blob => { const url = create.call(URL, blob); __created.push(url); __urlOf.set(blob, url); return url; };
      __camera.holdRender = true;
    });
    await clearCalls();
    await page.evaluate(id => select(id), ids[0]);
    await untilCall(c => c[0] === 'develop-render' && c[1] === ids[0], 'develop render for the first RAW');
    await page.evaluate(id => select(id), ids[1]);
    await page.waitForTimeout(300);
    assert.ok(!(await calls()).some(c => c[0] === 'develop-render' && c[1] === ids[1]), 'one developed render runs at a time');
    await page.evaluate(() => { __camera.holdRender = false; __camera.finishRender(); });
    await untilCall(c => c[0] === 'develop-render' && c[1] === ids[1], 'develop render for the second RAW');
    await page.waitForFunction(id => loupe.item?.id === id && document.querySelector('#review-image').src.startsWith('blob:') && document.querySelector('#preview-source').textContent === 'Developed RAW', ids[1]);
    await page.waitForFunction(() => __created.length >= 2);
    const urls = await page.evaluate(id => ({ created: __created, revoked: __revoked, shown: document.querySelector('#review-image').getAttribute('src'), stale: loupe.reps.get(id)?.get('preview')?.info?.type }), ids[0]);
    assert.ok(urls.created.includes(urls.shown), 'the second RAW shows its developed frame');
    assert.deepEqual(urls.created.filter(url => url !== urls.shown && !urls.revoked.includes(url)), [], 'the superseded frame is released');
    assert.notEqual(urls.stale, 'developed', 'the photo left behind never receives a late developed frame');
    await clearCalls();
    await page.evaluate(([raw, jpeg]) => { select(raw); select(jpeg); }, [ids[0], ids[2]]);
    await page.waitForTimeout(400);
    assert.deepEqual((await calls()).filter(c => c[0] === 'develop-render'), [], 'a RAW passed over by held arrow keys is not developed');
    check('browsing RAWs in Tether honors Show developed preview with superseded renders released');

    const adjustSource = () => page.locator('#tether-adjust-source').textContent();
    await clearCalls();
    await emitDelta({ firstArrival: true, ordinal: 15, exposureId: 'E15', itemId: ids[0], pairState: 'waiting', upserts: [{ ...await itemOf(ids[0]), raw: true, exposureId: 'E15', ordinal: 15 }] });
    await untilCall(c => c[0] === 'presented' && c[1] === 'E15', 'presented E15');
    await untilCall(c => c[0] === 'primary' && c[2] === ids[0], 'a RAW that lands before its JPEG publishes itself as Primary');
    assert.doesNotMatch(await adjustSource(), /waiting/);
    await emitDelta({ firstArrival: true, ordinal: 16, exposureId: 'E16', itemId: ids[2], pairState: 'waiting', upserts: [{ ...jpegFirst, raw: false, exposureId: 'E16', ordinal: 16 }] });
    await untilCall(c => c[0] === 'presented' && c[1] === 'E16', 'presented E16');
    assert.match(await adjustSource(), /waiting for its RAW/);
    await page.evaluate(session => { document.getElementById('tether-tool-issues').open = true; __camera.emit('tether-issue', { shootId: 'shoot-1', session, exposureId: 'E16', code: 'INCOMPLETE', message: 'The RAW never arrived.', actions: ['retry', 'finishSingle'] }); }, await page.evaluate(() => state.session.id));
    await page.locator('#tether-issues').getByRole('button', { name: 'Finish as single' }).click();
    await untilCall(c => c[0] === 'recover' && c[1] === 'finishSingle', 'finishSingle');
    await page.waitForFunction(() => !/waiting/.test(document.querySelector('#tether-adjust-source').textContent));
    check('RAW+JPEG: a RAW-first pair publishes Primary at once; Finish as single ends the wait for a RAW');

    // A missed delta resyncs the library; its open pairs decide which JPEGs still wait for a RAW.
    const resync = async pendingPairs => {
      const target = rev + 10;
      await page.evaluate(([pendingPairs, target]) => { __camera.library = { shootId: 'shoot-1', session: state.session.id, rev: target, library: JSON.parse(JSON.stringify(state.session)), latestOrdinal: 16, pendingPairs }; }, [pendingPairs, target]);
      await clearCalls();
      await page.evaluate(gap => __camera.emit('tether-library-delta', { shootId: 'shoot-1', session: state.session.id, rev: gap, firstArrival: false, upserts: [] }), rev + 2);
      await untilCall(c => c[0] === 'library', 'library resync');
      rev = target;
    };
    await resync([{ exposureId: 'E16', ordinal: 16, itemId: ids[2] }]);
    await page.waitForFunction(() => /waiting for its RAW/.test(document.querySelector('#tether-adjust-source').textContent));
    await page.waitForTimeout(400);
    assert.deepEqual((await calls()).filter(c => c[0] === 'primary'), [], 'a JPEG first seen waiting in the snapshot keeps the current Primary');
    await resync([]);
    await page.waitForFunction(() => !/waiting/.test(document.querySelector('#tether-adjust-source').textContent));
    await untilCall(c => c[0] === 'primary' && c[2] === null, 'a pair completed during the gap releases the JPEG to publish');
    check('library resync rebuilds which JPEGs wait for their RAW from the snapshot');

    // Quick follow starts a render on arrival; a later request for the same RAW must win.
    await page.evaluate(() => { tether.update({ follow: { mode: 'quick' } }); __camera.holdRender = true; __camera.rendered = []; });
    await clearCalls();
    await emitDelta({ firstArrival: true, ordinal: 17, exposureId: 'E17', itemId: ids[1], pairState: 'single', upserts: [{ ...await itemOf(ids[1]), raw: true, exposureId: 'E17', ordinal: 17 }] });
    await untilCall(c => c[0] === 'develop-render' && c[1] === ids[1], 'the follow render');
    await page.waitForFunction(id => loupe.item?.id === id, ids[1]);
    await page.locator('#tether-developed').uncheck(); await page.locator('#tether-developed').check();
    await page.waitForTimeout(300);
    assert.equal((await calls()).filter(c => c[0] === 'develop-render').length, 1, 'the newer request waits for the running render');
    await page.evaluate(() => __camera.finishRender());
    await page.waitForFunction(() => __camera.renderWaiters?.length === 1);
    await page.evaluate(() => { __camera.holdRender = false; __camera.finishRender(); });
    await page.waitForFunction(() => __camera.rendered.length === 2 && document.querySelector('#review-image').getAttribute('src') === __urlOf.get(__camera.rendered[1]) && document.querySelector('#preview-source').textContent === 'Developed RAW');
    assert.ok(await page.evaluate(() => __revoked.includes(__urlOf.get(__camera.rendered[0]))), 'the earlier follow render is released, never shown');
    check('one developed render at a time: an older follow render never replaces a newer request for the same RAW');

    const developedShown = () => page.evaluate(() => document.querySelector('#review-image').getAttribute('src')?.startsWith('blob:') && document.querySelector('#preview-source').textContent === 'Developed RAW');
    const stageSrc = () => page.evaluate(() => document.querySelector('#review-image').getAttribute('src'));
    const ordinaryShown = () => page.waitForFunction(() => !document.querySelector('#review-image').getAttribute('src').startsWith('blob:') && document.querySelector('#review-image').complete && document.querySelector('#preview-source').textContent !== 'Developed RAW');
    let developedUrl = await stageSrc();
    await page.locator('#tether-developed').uncheck(); await ordinaryShown();
    assert.ok(await page.evaluate(url => __revoked.includes(url), developedUrl), 'unchecking releases the developed frame it replaced');
    await clearCalls(); await page.locator('#tether-developed').check();
    await untilCall(c => c[0] === 'develop-render' && c[1] === ids[1], 'checking renders again');
    await page.waitForFunction(() => document.querySelector('#preview-source').textContent === 'Developed RAW');
    developedUrl = await stageSrc();
    await clearCalls(); await page.evaluate(() => toggleOriginal()); await ordinaryShown();
    await page.waitForTimeout(300);
    assert.deepEqual((await calls()).filter(c => c[0] === 'develop-render'), [], 'Show originals bypasses the treatment');
    assert.ok(await page.evaluate(url => __revoked.includes(url), developedUrl), 'regenerated previews release the developed frame');
    await page.evaluate(() => toggleOriginal());
    await untilCall(c => c[0] === 'develop-render' && c[1] === ids[1], 'leaving Show originals renders again');
    await page.waitForFunction(() => document.querySelector('#preview-source').textContent === 'Developed RAW');
    await page.evaluate(() => setMode('review')); await ordinaryShown();
    await clearCalls(); await page.evaluate(() => setMode('tether'));
    await untilCall(c => c[0] === 'develop-render' && c[1] === ids[1], 'entering Tether with the same RAW selected');
    await page.waitForFunction(() => state.mode === 'tether' && document.querySelector('#preview-source').textContent === 'Developed RAW');
    assert.equal(await developedShown(), true);
    await clearCalls(); await page.evaluate(() => refreshPreviews());
    await untilCall(c => c[0] === 'develop-render' && c[1] === ids[1], 'regenerated previews render the developed frame again');
    await page.waitForFunction(() => document.querySelector('#preview-source').textContent === 'Developed RAW' && document.querySelector('#review-image').getAttribute('src').startsWith('blob:'));
    check('developed preview follows the workspace, the preference, Show originals and regenerated previews, releasing frames it drops');

    await page.evaluate(id => { __camera.embedded = id; __camera.holdStatus = true; __camera.holdRender = true; }, ids[1]);
    await clearCalls(); await page.evaluate(() => loupe.zoomToRatio(400));
    // The camera's full-size pixels stand in at this zoom and their description is requested.
    await page.waitForFunction(() => !document.querySelector('#review-image').getAttribute('src').startsWith('blob:') && document.querySelector('#review-image').dataset.complete === 'yes');
    await untilCall(c => c[0] === 'preview-status' && c[1] === ids[1], 'the full-size description is requested');
    await page.locator('#tether-developed').uncheck(); await page.locator('#tether-developed').check();
    await untilCall(c => c[0] === 'develop-render' && c[1] === ids[1], 'a render while zoomed');
    await page.evaluate(() => { __camera.holdRender = false; __camera.finishRender(); });
    await page.waitForFunction(() => document.querySelector('#preview-source').textContent === 'Developed RAW' && document.querySelector('#review-image').getAttribute('src').startsWith('blob:'));
    await page.evaluate(() => { __camera.holdStatus = false; __camera.finishStatus(); });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#preview-source').textContent(), 'Developed RAW', 'a late full-size description leaves the developed source');
    assert.equal(await page.locator('#camera-preview').isHidden(), true);
    await page.evaluate(() => { __camera.embedded = null; loupe.fit(); });
    check('zoomed past the preview, a late full-size description never relabels developed pixels');

    // When Ready: the JPEG's preview fails while its RAW takes over the row; the RAW is presented and developed.
    await page.evaluate(() => tether.update({ follow: { mode: 'whenReady' } }));
    await page.evaluate(id => select(id), ids[0]); await page.waitForFunction(id => loupe.item?.id === id, ids[0]);
    const jpegAgain = await itemOf(ids[2]), rawAgain = await itemOf(ids[3]);
    await clearCalls();
    await page.evaluate(([jpeg, raw, first]) => {
      const session = state.session.id; __camera.brokenPreview = jpeg.id;
      __camera.emit('tether-library-delta', { shootId: 'shoot-1', session, rev: first, firstArrival: true, ordinal: 18, exposureId: 'E18', itemId: jpeg.id, pairState: 'waiting', upserts: [{ ...jpeg, raw: false, exposureId: 'E18', ordinal: 18 }] });
      __camera.emit('tether-library-delta', { shootId: 'shoot-1', session, rev: first + 1, firstArrival: false, ordinal: 18, exposureId: 'E18', itemId: raw.id, pairState: 'paired', remap: [{ from: jpeg.id, to: raw.id }], upserts: [{ ...raw, raw: true, exposureId: 'E18', ordinal: 18, contentRev: (raw.contentRev || 0) + 1 }] });
    }, [jpegAgain, rawAgain, rev + 1]);
    rev += 2;
    await untilCall(c => c[0] === 'presented' && c[1] === 'E18', 'the RAW is presented after its JPEG failed');
    await page.waitForFunction(id => loupe.item?.id === id && document.querySelector('#preview-source').textContent === 'Developed RAW', ids[3]);
    await page.evaluate(() => { __camera.brokenPreview = null; });
    await emitDelta({ firstArrival: false, upserts: [jpegAgain] });
    await page.waitForFunction(id => state.session.items.some(i => i.id === id), ids[2]);
    await page.evaluate(id => select(id), ids[0]); await page.waitForFunction(id => loupe.item?.id === id, ids[0]);
    await page.evaluate(id => { __camera.brokenPreview = id; }, ids[2]);
    await clearCalls();
    await emitDelta({ firstArrival: true, ordinal: 19, exposureId: 'E19', itemId: ids[2], pairState: 'waiting', upserts: [{ ...jpegAgain, raw: false, exposureId: 'E19', ordinal: 19 }] });
    await page.waitForFunction(() => !document.querySelector('#tether-arrival-pill').hidden);
    await emitDelta({ firstArrival: false, ordinal: 19, exposureId: 'E19', itemId: ids[3], pairState: 'paired', remap: [{ from: ids[2], to: ids[3] }], upserts: [{ ...await itemOf(ids[3]), raw: true, exposureId: 'E19', ordinal: 19 }] });
    await untilCall(c => c[0] === 'presented' && c[1] === 'E19', 'a RAW landing after its JPEG failed is presented');
    await page.waitForFunction(id => loupe.item?.id === id && document.querySelector('#preview-source').textContent === 'Developed RAW', ids[3]);
    await page.evaluate(() => { __camera.brokenPreview = null; });
    check('When Ready: a JPEG that fails to decode hands the stage to its developed RAW, whether the RAW lands during or after the failure');

    // Show developed preview turned off and on while a When Ready capture renders: the capture still develops.
    await page.evaluate(() => { __camera.holdRender = true; });
    await clearCalls(); await arrive(0, 20, { raw: true });
    await untilCall(c => c[0] === 'develop-render' && c[1] === ids[0], 'the incoming render');
    await page.locator('#tether-developed').uncheck(); await page.locator('#tether-developed').check();
    await page.waitForTimeout(300);
    await page.evaluate(() => { __camera.holdRender = false; __camera.finishRender(); });
    await untilCall(c => c[0] === 'presented' && c[1] === 'E20', 'presented E20');
    await page.waitForFunction(id => loupe.item?.id === id && document.querySelector('#preview-source').textContent === 'Developed RAW', ids[0]);
    check('When Ready: a capture whose render was retired by a preference toggle develops once shown');

    // Keep replies before the dark test shot is measured; the measurement still flags the kept photo.
    await page.locator('#tether-follow-pause').click();
    await clearCalls(); await page.locator('#tether-composition-toggle').click();
    await untilCall(c => c[0] === 'control' && c[1] === 'composition-on', 'composition-on');
    await page.evaluate(id => { __camera.holdReview = id; __camera.reviewColor = '#9b8269'; __camera.testColor = '#000000'; }, ids[0]);
    await arrive(0, 21);
    await page.waitForFunction(() => __camera.reviewWaiters?.length > 0);
    await testShot(5); await showing(5);
    await page.locator('#tether-composition-keep').click();
    await page.waitForFunction(() => !state.testShot);
    await page.locator('#tether-composition-toggle').click();
    await untilCall(c => c[0] === 'control' && c[1] === 'composition-off', 'composition-off');
    await page.evaluate(() => { __camera.holdReview = null; __camera.finishReview(); });
    await page.evaluate(() => tether.misfire.chain);
    await arrive(1, 22, { exposureId: 'kept-5' });
    await page.waitForFunction(id => !!filmNodes.get(id)?.querySelector('.mini-misfire'), ids[1]);
    await page.evaluate(() => { __camera.testColor = null; __camera.reviewColor = null; });
    check('misfire: a dark test shot kept, then Test Shot Mode left before it was measured, flags the saved photo');

    // launch.cjs dismisses every native prompt; this confirmation must be accepted.
    let asked = '';
    page.removeAllListeners('dialog');
    page.once('dialog', dialog => { asked = dialog.message(); void dialog.accept(); });
    await clearCalls(); const session = await page.evaluate(() => state.session.id);
    await press('Control+o');
    await untilCall(c => c[0] === 'chooseFolder', 'chooseFolder');
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    assert.match(asked, /Stop the tethered session/);
    const opened = await calls();
    assert.ok(opened.findIndex(c => c[0] === 'control' && c[1] === 'stop') < opened.findIndex(c => c[0] === 'chooseFolder'));
    assert.deepEqual(opened.find(c => c[0] === 'chooseFolder'), ['chooseFolder', false], 'the shoot is stopped before the folder picker opens');
    assert.deepEqual(await page.evaluate(() => [tether.active(), state.session.id]), [false, session]);
    await startShoot();
    await page.keyboard.press('Control+k'); await page.locator('#command-query').fill('stop tethered');
    assert.equal(await page.locator('#command-results [role=option]').first().getAttribute('aria-disabled'), 'false');
    await page.keyboard.press('Escape');
    await clearCalls(); await page.locator('#tether-stop').click();
    await untilCall(c => c[0] === 'control' && c[1] === 'stop', 'stop');
    await page.waitForFunction(() => !tether.active());
    assert.equal(await visible('#tether-stop'), false);
    assert.match(await page.locator('#toast').textContent(), /Temporary test files could not be removed/);
    assert.equal(await page.evaluate(() => state.session.id), session, 'the folder stays open as an ordinary session');
    check('Stop session: button, palette and Open folder stop the shoot and keep the folder');

    await page.locator('#tether-developed').check();
    await page.evaluate(id => select(id), ids[0]);
    await page.waitForFunction(id => loupe.item?.id === id && document.querySelector('#preview-source').textContent === 'Developed RAW', ids[0]);
    const lastFrame = await stageSrc();
    const empty = path.join(root, 'empty'); await fs.mkdir(empty);
    await page.evaluate(folder => window.loadTestFolder(folder), empty);
    await page.waitForFunction(() => document.querySelector('#count-all').textContent === '0');
    assert.ok(await page.evaluate(url => __revoked.includes(url) && document.querySelector('#review-image').getAttribute('src') !== url, lastFrame), 'an empty folder releases the developed frame it replaced');
    check('opening an empty folder releases the developed frame on screen');

    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ passed: true, checks, errors }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ passed: false, checks, errors, failure: error.stack }, null, 2));
    process.exitCode = 1;
  } finally {
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main();
