const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/renderer/loupe.js');

test('previews are prepared five ahead in the direction of travel and one behind', () => {
  assert.deepEqual(L.prepareAhead(100, 10, 1), [11, 12, 13, 14, 15, 9]);
  assert.deepEqual(L.prepareAhead(100, 10, -1), [9, 8, 7, 6, 5, 11]);
  assert.deepEqual(L.prepareAhead(12, 9, 1), [10, 11, 8], 'stops at the end');
  assert.deepEqual(L.prepareAhead(12, 1, -1), [0, 2], 'stops at the start');
  assert.deepEqual(L.prepareAhead(1, 0, 1), []);
  assert.equal(1 + L.AHEAD + L.BEHIND <= 8, true, 'fits the backend focus limit with the current photo');
  assert.equal(L.travel(-1, 4, -1), -1, 'unknown previous photo keeps the direction');
  assert.equal(L.travel(5, 4, 1), -1); assert.equal(L.travel(4, 9, -1), 1); assert.equal(L.travel(4, 4, -1), -1);
});

test('held arrow keys: a photo left within 0.25 s defers expensive work by 0.12 s', () => {
  assert.equal(L.RAPID_MS, 250); assert.equal(L.SETTLE_MS, 120);
  assert.equal(L.isRapid(1000, 900), true); assert.equal(L.isRapid(1000, 750), false); assert.equal(L.isRapid(1000, -Infinity), false);
});

test('representations are scaled down, never up, and the best one stands in', () => {
  const thumb = { kind: 'thumb', width: 400, height: 267 }, preview = { kind: 'preview', width: 2560, height: 1707 }, full = { kind: 'full', width: 7008, height: 4672 };
  assert.equal(L.neededKind(1800), 'preview'); assert.equal(L.neededKind(2561), 'full');
  // Fit (1800 device px): the preview is enough; a loaded full-size image is reused rather than replaced.
  assert.deepEqual(L.chooseRepresentation([thumb, preview], 1800, 7008), { show: preview, adequate: true });
  assert.deepEqual(L.chooseRepresentation([thumb, preview, full], 1800, 7008, full), { show: full, adequate: true });
  assert.deepEqual(L.chooseRepresentation([thumb, preview, full], 1800, 7008), { show: preview, adequate: true }, 'smallest adequate when nothing is shown');
  // 100% zoom (7008 px): the preview stands in until the full-size image arrives.
  assert.deepEqual(L.chooseRepresentation([thumb, preview], 7008, 7008), { show: preview, adequate: false });
  assert.deepEqual(L.chooseRepresentation([thumb, preview, full], 7008, 7008, preview), { show: full, adequate: true });
  assert.deepEqual(L.chooseRepresentation([thumb], 1800, 7008), { show: thumb, adequate: false });
  assert.deepEqual(L.chooseRepresentation([], 1800, 7008), { show: null, adequate: false });
  // A small photo's preview is its real size, so it is enough at any zoom.
  const small = { kind: 'preview', width: 1200, height: 800 };
  assert.equal(L.chooseRepresentation([small], 4800, 1200).adequate, true);
  // A RAW whose only embedded image is tiny: the loaded fit preview is the best there is.
  const tiny = { kind: 'preview', width: 160, height: 120 };
  assert.equal(L.chooseRepresentation([{ ...tiny, kind: 'thumb' }, tiny], 1000, 7008).show, tiny);
  assert.equal(L.chooseRepresentation([{ ...tiny, kind: 'thumb' }, tiny], 1000, 7008).adequate, true);
  assert.equal(L.chooseRepresentation([tiny], 7008, 7008, tiny, 'full').adequate, false, 'zooming still asks for the full-size image');
});

test('"Camera preview" applies to embedded and companion JPEG pixels of RAWs only', () => {
  const embedded = { type: 'embedded', tag: 'JpgFromRaw', width: 7008, height: 4672, source: 'Embedded JpgFromRaw' };
  assert.equal(L.cameraPixels({ raw: true }, embedded), true);
  assert.equal(L.cameraPixels({ raw: true }, { type: 'companion' }), true);
  assert.equal(L.cameraPixels({ raw: true }, { type: 'rendered' }), false);
  assert.equal(L.cameraPixels({ raw: false }, { type: 'original' }), false);
  assert.equal(L.cameraPixels({ raw: true }, null), false);
  assert.match(L.cameraTooltip(embedded), /embedded in this RAW file \(JpgFromRaw, 7008 × 4672\)/);
  assert.match(L.cameraTooltip({ ...embedded, limited: true }), /enlarge/);
});

test('loupe keys do not collide with culling shortcuts', () => {
  const key = (key, extra = {}) => L.keyAction({ key, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
  assert.equal(key('z'), 'toggle'); assert.equal(key('Z', { shiftKey: true }), 'toggle'); assert.equal(key(' '), 'space');
  assert.equal(key('=', { ctrlKey: true, code: 'Equal' }), 'zoom-in'); assert.equal(key('+', { metaKey: true }), 'zoom-in');
  assert.equal(key('-', { ctrlKey: true }), 'zoom-out'); assert.equal(key('0', { ctrlKey: true }), 'fit');
  assert.equal(key('ß', { ctrlKey: true, code: 'Minus' }), 'zoom-out', 'layout-independent physical keys');
  for (const k of ['p', 'x', 'u', 'g', 'e', 'f', 'b', 'i', 'r', '?', 'ArrowLeft', 'ArrowRight', 'Delete', 'Escape', 'Enter', ...'0123456789']) assert.equal(key(k), null, k);
  assert.equal(key('z', { ctrlKey: true }), null, 'Ctrl+Z stays undo');
  assert.equal(key('z', { ctrlKey: true, shiftKey: true }), null, 'Ctrl+Shift+Z stays redo');
  assert.equal(key('a', { ctrlKey: true }), null, 'Ctrl+A stays select all');
  assert.equal(key('0', { altKey: true }), null, 'Alt+0 stays clear colour');
  assert.equal(key('3', { altKey: true }), null);
  assert.equal(key('0', { ctrlKey: true, altKey: true }), null);
});

test('prefetches run in order, at most two at once, and obsolete ones are abandoned', () => {
  const images = [], loaded = [];
  const createImage = () => { const image = { removed: false, removeAttribute() { this.removed = true; } }; images.push(image); return image; };
  const prefetcher = new L.Prefetcher(2, job => loaded.push(job.key), createImage);
  const jobs = keys => keys.map(key => ({ key, url: `/${key}` }));
  prefetcher.set(jobs(['a', 'b', 'c', 'd']));
  assert.deepEqual(images.map(i => i.src), ['/a', '/b']);
  images[0].onload();
  assert.deepEqual(loaded, ['a']); assert.equal(images[2].src, '/c');
  // Moving on: b is no longer wanted and is abandoned; c continues; e is queued after c.
  prefetcher.set(jobs(['c', 'e']));
  assert.equal(images[1].removed, true); assert.equal(images[1].onload, null);
  assert.equal(images[3].src, '/e');
  images[2].onerror(); images[3].onload();
  assert.deepEqual(loaded, ['a', 'e']); assert.equal(prefetcher.active.size, 0);
});

test('zoom levels are labelled compactly', () => {
  assert.equal(L.formatPercent(100), '100%'); assert.equal(L.formatPercent(33.3), '33.3%'); assert.equal(L.formatPercent(12.5), '12.5%');
  assert.equal(L.formatPercent(137.4), '137%'); assert.equal(L.formatPercent(27.71), '27.7%'); assert.equal(L.formatPercent(50.02), '50%'); assert.equal(L.formatPercent(0), '');
});
