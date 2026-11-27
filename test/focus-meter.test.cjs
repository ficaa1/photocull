const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/renderer/focus-meter.js');
const { measure } = require('../src/sharpness.cjs');

function image(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fill(x, y), p = (y * w + x) * 4; data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255; }
  return data;
}

test('relative detail is the RMS of the desktop sharpness measure and falls as the pixels soften', () => {
  const sharp = image(48, 32, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 230 : 20);
  const soft = image(48, 32, (x, y) => 125 + 105 * Math.sin(x * Math.PI / 4) * Math.sin(y * Math.PI / 4));
  for (const data of [sharp, soft]) {
    const expected = Math.sqrt(measure(48, 32, data, 4));
    assert.ok(Math.abs(F.laplacianContrast(data, 48, 32) - expected) <= expected * 1e-6);
  }
  assert.ok(F.laplacianContrast(sharp, 48, 32) > 2 * F.laplacianContrast(soft, 48, 32));
  assert.equal(F.laplacianContrast(image(16, 16, () => 90), 16, 16), 0);
});

test('the loupe area is what 1:1 shows around the loupe centre, the same at fit and capped around its middle', () => {
  const frame = { width: 960, height: 640 };
  // A 868×580 device-pixel viewport shows 868×580 frame pixels at 1:1; the middle 640 columns are measured.
  assert.deepEqual(F.loupeRegion(frame, { x: 0.5, y: 0.5 }, { width: 868, height: 580 }), { x: 160, y: 30, width: 640, height: 580 });
  // Panned to the corner, the view stops at the frame edge as Live View's pan does: columns 92–960, rows 60–640.
  assert.deepEqual(F.loupeRegion(frame, { x: 1, y: 1 }, { width: 868, height: 580 }), { x: 206, y: 60, width: 640, height: 580 });
  assert.deepEqual(F.loupeRegion({ width: 640, height: 427 }, { x: 0.9, y: 0.1 }, { width: 868, height: 580 }), { x: 0, y: 0, width: 640, height: 427 });
  assert.deepEqual(F.loupeRegion(frame, { x: 0.5, y: 0.5 }, { width: 1736, height: 1160 }), { x: 160, y: 0, width: 640, height: 640 });
});

test('pinned points measure a square around them inside the frame and map through the letterboxed view', () => {
  const frame = { width: 960, height: 640 };
  assert.deepEqual(F.pointRegion(frame, { x: 0.2, y: 0.5 }), { x: 160, y: 288, width: 64, height: 64 });
  assert.deepEqual(F.pointRegion(frame, { x: 0, y: 1 }), { x: 0, y: 576, width: 64, height: 64 });
  assert.deepEqual(F.pointRegion({ width: 160, height: 120 }, { x: 0.5, y: 0.5 }), { x: 68, y: 48, width: 24, height: 24 });
  // Fit into an 868×580 viewport: scale 0.9, letterboxed 2 px top and bottom.
  const rect = { x: 2, y: 2, width: 864, height: 576 };
  const view = F.regionToView({ x: 160, y: 288, width: 64, height: 64 }, frame, rect);
  for (const [key, expected] of Object.entries({ x: 146, y: 261.2, width: 57.6, height: 57.6 })) assert.ok(Math.abs(view[key] - expected) < 1e-9, `${key}: ${view[key]}`);
  assert.deepEqual(F.viewToFrame(434, 290, rect), { x: 0.5, y: 0.5 });
  assert.equal(F.viewToFrame(434, 1, rect), null, 'a click on the letterbox pins nothing');
  assert.deepEqual(F.viewToFrame(900, -40, rect, true), { x: 1, y: 0 }, 'a dragged point stays on the frame');
  assert.deepEqual(F.nudge({ x: 0.5, y: 0.5 }, 'ArrowLeft', true), { x: 0.45, y: 0.5 });
  assert.deepEqual(F.nudge({ x: 0.995, y: 0 }, 'ArrowRight'), { x: 1, y: 0 });
  assert.equal(F.nudge({ x: 0.5, y: 0.5 }, 'Enter'), null);
  assert.deepEqual(F.freeSpot([{ x: 0.5, y: 0.5 }], { x: 0.5, y: 0.5 }), { x: 0.62, y: 0.5 });
});

test('the series keeps a bounded history of short means and holds its peak until cleared', () => {
  const series = new F.FocusSeries(4, 3);
  for (const value of [3, 6, 9, NaN, -1]) series.push(value);
  assert.deepEqual(series.values, [3, 4.5, 6]);
  for (const value of [0, 0, 0, 0]) series.push(value);
  assert.deepEqual(series.values, [5, 3, 0, 0], 'the history is bounded');
  assert.equal(series.peak, 6, 'the peak outlives the samples that set it');
  assert.equal(series.ratio(), 0);
  series.clear();
  assert.deepEqual([series.values.length, series.peak, series.ratio()], [0, 0, null]);
});
