const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../src/renderer/overlays.js');
const C = require('../src/renderer/commands.js');
const T = require('../src/renderer/tether.js');
const D = require('../src/renderer/develop.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
function image(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fill(x, y); const p = (y * w + x) * 4; data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255; }
  return data;
}
const marked = (layer, x, y) => layer.data[(y * layer.width + x) * 4 + 3] > 0;
const at = (layer, x, y) => [...layer.data.slice((y * layer.width + x) * 4, (y * layer.width + x) * 4 + 4)];

test('grid lines place thirds, golden-ratio, crosshair, custom divisions and guides in the image rect', () => {
  const rect = { x: 10, y: 20, width: 300, height: 150 };
  const xs = lines => lines.filter(l => l.x1 === l.x2).map(l => l.x1), ys = lines => lines.filter(l => l.y1 === l.y2).map(l => l.y1);
  const thirds = O.computeGridLines(rect, { type: 'thirds' });
  assert.deepEqual(xs(thirds), [110, 210]); assert.deepEqual(ys(thirds), [70, 120]);
  const golden = O.computeGridLines(rect, { type: 'goldenRatio' });
  close(xs(golden)[0], 10 + 300 * 0.3819660112501051); close(xs(golden)[1], 10 + 300 * 0.6180339887498949);
  assert.deepEqual(O.computeGridLines(rect, { type: 'crosshair' }).map(l => [l.x1, l.y1, l.x2, l.y2]), [[160, 20, 160, 170], [10, 95, 310, 95]]);
  assert.equal(O.computeGridLines(rect, { type: 'custom', cols: 6, rows: 1 }).length, 5);
  assert.equal(O.computeGridLines(rect, { type: 'custom', cols: 500, rows: 1 }).length, 127);
  const guides = O.computeGridLines(rect, { type: 'none', guides: [{ axis: 'x', at: 0.25 }, { axis: 'y', at: 1 }, { axis: 'x', at: 2 }] });
  assert.deepEqual(guides.map(l => [l.x1, l.y1, l.x2, l.y2]), [[85, 20, 85, 170], [10, 170, 310, 170]]);
});

test('golden spiral tiles a centered golden rectangle with continuous quarter arcs and honors mirror and winding', () => {
  const rect = { x: 0, y: 0, width: 1000, height: 400 };
  const { rect: outer, arcs } = O.computeGoldenSpiral(rect, { minSize: 1 });
  close(outer.height, 400); close(outer.width, 400 / 0.6180339887498949); close(outer.x, (1000 - outer.width) / 2);
  assert.ok(arcs.length > 8);
  const end = a => [a.cx + a.radius * Math.cos(a.end), a.cy + a.radius * Math.sin(a.end)], start = a => [a.cx + a.radius * Math.cos(a.start), a.cy + a.radius * Math.sin(a.start)];
  for (let i = 1; i < arcs.length; i++) { const [x0, y0] = end(arcs[i - 1]), [x1, y1] = start(arcs[i]); close(x0, x1, 1e-6); close(y0, y1, 1e-6); }
  assert.deepEqual(start(arcs[0]).map(Math.round), [Math.round(outer.x), 400]);
  for (const [options, portrait] of [[{ clockwise: true }, false], [{ clockwise: false }, false], [{ mirror: true, clockwise: true }, false], [{ clockwise: true }, true], [{ mirror: true, clockwise: false }, true]]) {
    const spiral = O.computeGoldenSpiral(portrait ? { x: 0, y: 0, width: 400, height: 1000 } : rect, options);
    assert.equal(spiral.arcs[0].anticlockwise, !options.clockwise, JSON.stringify(options));
  }
  const mirrored = O.computeGoldenSpiral(rect, { mirror: true });
  close(mirrored.arcs[0].cx, outer.x + outer.width - (arcs[0].cx - outer.x));
  const portrait = O.computeGoldenSpiral({ x: 0, y: 0, width: 400, height: 1000 });
  close(portrait.rect.width, 400); close(portrait.rect.height, 400 / 0.6180339887498949);
});

test('aspect masks fit the largest centered ratio for each orientation and leave matte bands outside it', () => {
  const rect = { x: 0, y: 0, width: 600, height: 400 };
  const portrait = O.computeAspectRect(rect, '4:5', 'portrait');
  assert.deepEqual(portrait.rect, { x: 140, y: 0, width: 320, height: 400 });
  assert.deepEqual(portrait.mattes.map(m => [m.x, m.width]), [[0, 140], [460, 140]]);
  const wide = O.computeAspectRect(rect, '16:9', 'landscape');
  close(wide.rect.width, 600); close(wide.rect.height, 337.5); close(wide.rect.y, 31.25);
  assert.equal(O.computeAspectRect(rect, '1:1', 'landscape').rect.width, 400);
  assert.equal(O.computeAspectRect({ x: 0, y: 0, width: 300, height: 450 }, '2:3', 'portrait').mattes.length, 0);
  for (const ratio of O.RATIOS) for (const orientation of ['portrait', 'landscape']) {
    const { rect: r, mattes } = O.computeAspectRect(rect, ratio, orientation);
    close(r.width / r.height, O.aspectValue(ratio, orientation), 1e-9);
    close(mattes.reduce((s, m) => s + m.width * m.height, 0) + r.width * r.height, 600 * 400, 1e-6);
  }
  assert.throws(() => O.computeAspectRect(rect, '3:7', 'portrait'));
});

test('overlay image fits its anchor, follows the crop, scales and offsets by anchor fractions', () => {
  const image = { x: 0, y: 0, width: 400, height: 300 }, crop = { x: 100, y: 50, width: 200, height: 200 };
  assert.deepEqual(O.computeOverlayRect(image, null, { width: 800, height: 400 }), { x: 0, y: 50, width: 400, height: 200, clip: image });
  const followed = O.computeOverlayRect(image, crop, { width: 100, height: 100 }, { scale: 0.5, x: 0.25, y: -0.1 });
  assert.deepEqual(followed, { x: 200, y: 80, width: 100, height: 100, clip: crop });
  assert.deepEqual(O.computeOverlayRect(image, crop, { width: 100, height: 100 }, { followCrop: false }).clip, image);
  assert.equal(O.computeOverlayRect(image, null, { width: 100, height: 100 }, { scale: 99 }).width, 1200);
  assert.equal(O.computeOverlayRect(image, null, { width: 0, height: 100 }), null);
});

test('image boxes and strokes snap to device pixels', () => {
  assert.deepEqual(O.imageBox({ left: 10.2, top: 5.6, width: 100.5, height: 50.2 }, 2), { x: 10, y: 5.5, width: 100.5, height: 50.5 });
  close(O.crisp(10.2, 1), 10.5); close(O.crisp(10.2, 2), 10.25); close(O.crisp(10, 2, 2), 10); close(O.crisp(10, 1, 2), 10);
});

test('exposure warning marks clipped highlights red and shadows blue, as zebra stripes for live frames', () => {
  const pixels = image(32, 4, x => x < 8 ? [255, 10, 10] : x < 16 ? [249, 249, 249] : x < 24 ? [5, 5, 5] : [6, 6, 6]);
  const review = O.computeExposureWarning(pixels, 32, 4, { high: 250, low: 5, shadows: true });
  assert.deepEqual(at(review, 0, 0), [255, 0, 0, 255]); assert.deepEqual(at(review, 20, 0), [0, 0, 255, 255]);
  assert.equal(marked(review, 10, 0), false); assert.equal(marked(review, 28, 0), false);
  assert.equal(review.highlights, 32); assert.equal(review.shadows, 32);
  assert.equal(O.computeExposureWarning(pixels, 32, 4, { shadows: false }).shadows, 0);
  const zebra = O.computeExposureWarning(pixels, 32, 4, { zebra: true, shadows: true });
  assert.equal(marked(zebra, 0, 0), true); assert.equal(marked(zebra, 7, 0), true); assert.equal(marked(zebra, 0, 3), true); assert.equal(marked(zebra, 5, 3), false);
  assert.equal(zebra.highlights, 32);
  for (const bad of [{ high: 5, low: 5 }, { high: 256, low: 0 }, { high: 200.5, low: 0 }, { high: 10, low: -1 }]) assert.throws(() => O.computeExposureWarning(pixels, 32, 4, bad), RangeError);
});

test('focus mask marks sharp texture, ignores flat and smoothly graded areas, and drops isolated speckles', () => {
  const w = 64, h = 32;
  const pixels = image(w, h, (x, y) => x < 32 ? ((x >> 1) + (y >> 1)) % 2 ? [255, 255, 255] : [0, 0, 0] : [x * 4, x * 4, x * 4]);
  const mask = O.computeFocusMask(pixels, w, h, { threshold: 0.03, color: '#00ff00', opacity: 0.5 });
  assert.equal(marked(mask, 16, 16), true); assert.equal(marked(mask, 50, 16), false);
  assert.deepEqual(at(mask, 16, 16), [0, 255, 0, 128]);
  const flat = O.computeFocusMask(image(16, 16, () => [128, 128, 128]), 16, 16);
  assert.equal(flat.count, 0);
  const strict = O.computeFocusMask(pixels, w, h, { threshold: 0.5 }), lenient = O.computeFocusMask(pixels, w, h, { threshold: 0.001 });
  assert.ok(strict.count <= mask.count && mask.count <= lenient.count);
  const speck = new Uint8Array(10 * 10); speck[11] = speck[12] = speck[22] = 1;
  for (let i = 0; i < 9; i++) speck[50 + i] = 1;
  O.suppressSpeckles(speck, 10, 10, 8);
  assert.equal(speck[11] + speck[12] + speck[22], 0); assert.equal(speck.slice(50, 59).reduce((a, b) => a + b), 9);
  const diagonal = new Uint8Array(9 * 9); for (let i = 0; i < 9; i++) diagonal[i * 9 + i] = 1;
  assert.equal(O.suppressSpeckles(diagonal, 9, 9, 8).reduce((a, b) => a + b), 9);
});

test('focus peaking marks strong luma edges, with sensitivity lowering the threshold', () => {
  const step = image(16, 8, x => x < 8 ? [0, 0, 0] : [255, 255, 255]), soft = image(16, 8, x => x < 8 ? [100, 100, 100] : [140, 140, 140]);
  const peaks = O.computeFocusPeaking(step, 16, 8, { color: '#ff0000', sensitivity: 0 });
  assert.equal(marked(peaks, 7, 4), true); assert.equal(marked(peaks, 2, 4), false); assert.deepEqual(at(peaks, 8, 4), [255, 0, 0, 255]);
  assert.equal(O.computeFocusPeaking(soft, 16, 8, { sensitivity: 0 }).count, 0);
  assert.ok(O.computeFocusPeaking(soft, 16, 8, { sensitivity: 1 }).count > 0);
});

test('histogram counts channels and Rec. 709 luma per pixel', () => {
  const h = O.computeHistogram(image(2, 2, (x, y) => [[255, 0, 0], [0, 255, 0], [0, 0, 255], [10, 10, 10]][y * 2 + x]), 2, 2);
  assert.equal(h.total, 4); assert.equal(h.r[255], 1); assert.equal(h.r[0], 2); assert.equal(h.g[255], 1); assert.equal(h.b[255], 1);
  assert.equal(h.luma[54], 1); assert.equal(h.luma[182], 1); assert.equal(h.luma[18], 1); assert.equal(h.luma[10], 1);
  assert.equal(O.parseHex('#00FF7f').join(), '0,255,127'); assert.equal(O.parseHex('nope').join(), '255,255,255');
});

test('shutter labels parse to seconds and only speeds faster than the flash sync limit warn', () => {
  for (const [label, seconds] of [['1/400', 1 / 400], ['1/250 s', 1 / 250], ['1/200', 1 / 200], ['0.5"', 0.5], ['2"', 2], ['1"3', 1.3], ['1.3', 1.3]]) close(T.parseShutterSeconds(label), seconds);
  for (const label of ['BULB', 'Bulb', '', null, 'Auto']) assert.equal(T.parseShutterSeconds(label), null, String(label));
  assert.equal(T.isOverSyncLimit('1/400', 200), true);
  assert.equal(T.isOverSyncLimit('1/250 s', 200), true);
  assert.equal(T.isOverSyncLimit('1/200', 200), false, 'the limit itself is safe');
  assert.equal(T.isOverSyncLimit('1/250', 250), false);
  assert.equal(T.isOverSyncLimit('0.5"', 200), false);
  assert.equal(T.isOverSyncLimit('BULB', 200), false);
  assert.equal(T.isOverSyncLimit('1/8000', 0), false, 'a zero limit turns the guard off');
});

test('the desktop bridge forwards the displayed shot and preview revision', async () => {
  const calls = [], window = { __PHOTOCULL__: { platform: 'linux' }, __TAURI__: {
    event: { listen() {} },
    core: { async invoke(command, args) {
      calls.push([command, { ...args }]);
      if (command === 'tether_composition_frame') return [2, 0, 0, 0, 123, 125, 255, 216];
      return { ok: true, value: { testSeq: args.testSeq } };
    } },
  } };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../src/renderer/bridge.js'), 'utf8'), { window, TextDecoder, Blob });
  for (const op of ['composition-keep', 'composition-discard']) {
    assert.equal((await window.photocull.tetherControl('shoot', 2, op, { testSeq: 5 })).testSeq, 5);
    assert.deepEqual(calls.pop(), ['tether_control', { shootId: 'shoot', epoch: 2, op, testSeq: 5 }]);
  }
  await window.photocull.tetherCompositionFrame('shoot', 5, 3);
  assert.deepEqual(calls.pop(), ['tether_composition_frame', { shootId: 'shoot', testSeq: 5, previewRev: 3 }]);
});

function lumaHistogram(...bins) {
  const luma = new Uint32Array(256);
  for (const [value, count] of bins) luma[value] = count;
  return { luma, total: luma.reduce((sum, count) => sum + count) };
}

test('flash history uses linear exposure and preserves a lit subject on a black background', () => {
  const history = new T.FlashHistory(), gray = value => lumaHistogram([value, 100]);
  assert.equal(history.measure('portrait', lumaHistogram([0, 95], [195, 5])).misfire, false);
  assert.equal(history.measure('unlit', gray(8)).misfire, true);
  const studio = new T.FlashHistory();
  for (const id of ['a', 'b', 'c']) assert.equal(studio.measure(id, gray(160)).misfire, false);
  assert.equal(studio.measure('d', gray(70)).misfire, true, '160 to 70 is over 2.5 stops in linear light');
  assert.equal(studio.measure('e', gray(76)).misfire, false);
  assert.equal(studio.measure('face', lumaHistogram([0, 95], [100, 5])).misfire, false);
});

test('a kept test shot contributes one exposure to the flash history', () => {
  const history = new T.FlashHistory(), gray = value => lumaHistogram([value, 100]);
  history.measure('a', gray(160));
  history.measure('b', gray(160));
  history.measure('test:3', gray(76));
  history.kept('E3');
  assert.equal(history.measure('E3', gray(76)), null);
  assert.equal(history.measure('E4', gray(60)).misfire, true, 'a duplicated dim test would lower the baseline enough to hide this misfire');
});

test('the white balance eyedropper neutralizes the sampled cast and rejects clipped or crushed samples', () => {
  assert.deepEqual(D.solveWhiteBalance(128, 128, 128), { temp: 5500, tint: 0 });
  assert.deepEqual(D.solveWhiteBalance(128, 128, 128, 3210, 7), { temp: 3200, tint: 7 }, 'a neutral sample keeps the current balance, rounded to 50 K');
  assert.deepEqual(D.solveWhiteBalance(155, 130, 105), { temp: 3300, tint: 4 }, 'a warm sample lowers the Kelvin');
  const cool = D.solveWhiteBalance(105, 130, 155);
  assert.ok(cool.temp > 15000, `a cool sample raises the Kelvin: ${cool.temp}`); assert.equal(cool.tint, 4);
  assert.deepEqual(D.solveWhiteBalance(120, 145, 120), { temp: 5500, tint: 47 }, 'a green sample raises the tint toward magenta');
  assert.ok(D.solveWhiteBalance(145, 120, 145).tint < 0, 'a magenta sample lowers the tint');
  for (const rgb of [[255, 255, 255], [254, 250, 251], [0, 0, 0], [2, 2, 2], [200, 120, 0]]) assert.match(D.solveWhiteBalance(...rgb).error || '', /neutral gray or white/, rgb.join());
});

test('a second neutral pick preserves the balance that rendered the developed frame', () => {
  const info = { asShot: { temp: 5500, tint: 0 } };
  const pick = (settings, rgb) => {
    const current = D.frameWhiteBalance(settings, info);
    return D.solveWhiteBalance(...rgb, current.temp, current.tint);
  };
  const first = pick({ mode: 'asShot', temp: 6500 }, [155, 130, 105]);
  assert.deepEqual(first, { temp: 3300, tint: 4 });
  assert.deepEqual(pick({ mode: 'custom', ...first }, [128, 128, 128]), first);
});

function fixture(context, custom = {}) {
  let ran = null;
  const registry = C.create({ actions: Object.fromEntries(C.table.map(c => [c.id, () => { ran = c.id; }])), context: () => context, custom: () => custom });
  return { press(key, mods = {}) { ran = null; registry.dispatch({ key, preventDefault() {}, ...mods }); return ran; }, registry };
}

test('tether shortcuts follow their contexts and leave existing bindings intact', () => {
  for (const mode of ['review', 'tether', 'grid', 'develop', 'compare', 'stage']) {
    const f = fixture(mode === 'review' ? ['review', 'tether-review'] : mode);
    assert.equal(f.press('t'), 'tether-shutter', mode);
    assert.equal(f.press('T', { shiftKey: true }), 'tether-pause', mode);
    assert.equal(f.press('l'), 'tether-live-view', mode);
    assert.equal(f.press('y'), 'tether-jump-latest', mode);
    assert.equal(f.press('o'), ['review', 'tether', 'stage'].includes(mode) ? 'tether-overlay-toggle' : null, mode);
    assert.equal(f.press('m'), ['review', 'tether'].includes(mode) ? 'tether-focus-mask' : null, mode);
    assert.equal(f.press('j'), mode === 'develop' ? 'clipping' : ['review', 'tether', 'stage'].includes(mode) ? 'tether-exposure-warning' : null, mode);
    assert.equal(f.press('o', { ctrlKey: true }), 'open', mode);
    assert.equal(f.press('k', { metaKey: true }), 'palette', mode);
    assert.equal(f.press('t', { ctrlKey: true }), null, mode);
  }
  assert.equal(fixture('review').press('j'), null);
  const studio = fixture('tether');
  assert.equal(studio.press('p'), 'flag-pick'); assert.equal(studio.press('ArrowRight'), 'navigate-right'); assert.equal(studio.press('3'), 'rating-3');
  assert.equal(studio.press('e'), 'view-review'); assert.equal(studio.press('b'), 'sources'); assert.equal(studio.press('i'), 'details'); assert.equal(studio.press('g'), 'view-grid');
  assert.equal(fixture('stage').press('p'), null);
  assert.equal(fixture('grid').press('y', { ctrlKey: true, shiftKey: true }), null);
  const ids = C.table.filter(c => c.category === 'Tether').map(c => c.id);
  for (const id of ['tether-start', 'tether-aids', 'tether-follow-pause', 'tether-pin-reference', 'tether-new-shot', 'tether-guides-toggle', 'tether-aspect-toggle', 'tether-af', 'tether-counter-reset']) {
    assert.ok(ids.includes(id)); assert.deepEqual(C.table.find(c => c.id === id).shortcuts.default, []);
  }
  for (const id of ids) assert.equal(C.conflicts(C.table, {}, id, C.table.find(c => c.id === id).shortcuts.default, { defaults: true }).length, 0, id);
  assert.deepEqual(C.conflicts(C.table, {}, 'tether-focus-mask', ['J']).map(c => c.id), ['tether-exposure-warning']);
  assert.equal(C.conflicts(C.table, {}, 'tether-shutter', ['Ctrl+O'])[0].id, 'open');
  assert.deepEqual(C.validateCustom({ 'tether-shutter': ['F5'] }), { 'tether-shutter': ['F5'] });
  const custom = fixture('grid', { 'tether-shutter': ['F5'] });
  assert.equal(custom.press('t'), null); assert.equal(custom.press('F5'), 'tether-shutter');
  assert.equal(fixture('review').registry.search('pick')[0].id, 'flag-pick');
  assert.equal(fixture('review').registry.search('pin reference')[0].id, 'tether-pin-reference');
  const view = C.table.find(c => c.id === 'view-tether');
  assert.equal(view.category, 'View'); assert.deepEqual(view.shortcuts.default, []);
  assert.equal(fixture('grid').registry.search('tether workspace')[0].id, 'view-tether');
});

test('saved shortcuts that already use a new tether key keep it, leave the tether command unassigned and keep the other settings', async () => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { SettingsStore } = require('../src/settings.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-shortcuts-'));
  try {
    await fs.mkdir(path.join(dir, 'settings'));
    const shortcuts = { 'view-grid': ['T'], details: ['Shift+T'], 'focus-overlay': ['Y'], 'burst-stack': ['m'], 'flag-pick': ['F5'] };
    await fs.writeFile(path.join(dir, 'settings', 'settings.json'), JSON.stringify({ autoAdvance: false, recursive: true, shortcuts }));
    const value = await new SettingsStore(dir).init();
    assert.equal(value.warning, '');
    assert.equal(value.autoAdvance, false); assert.equal(value.recursive, true);
    assert.deepEqual(value.shortcuts, { 'view-grid': ['T'], details: ['Shift+T'], 'focus-overlay': ['Y'], 'burst-stack': ['M'], 'flag-pick': ['F5'],
      'tether-shutter': [], 'tether-pause': [], 'tether-jump-latest': [], 'tether-focus-mask': [] });
    const studio = fixture('tether', value.shortcuts);
    assert.equal(studio.press('t'), 'view-grid'); assert.equal(studio.press('T', { shiftKey: true }), 'details');
    assert.equal(studio.press('y'), 'focus-overlay'); assert.equal(studio.press('m'), 'burst-stack');
    assert.equal(studio.press('l'), 'tether-live-view'); assert.equal(studio.press('j'), 'tether-exposure-warning');
    assert.throws(() => C.migrateCustom({ 'view-grid': ['T'], 'tether-shutter': ['T'] }), /conflict/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
