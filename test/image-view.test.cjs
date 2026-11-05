const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/renderer/image-view.js');
const { layout, pointInImage } = V;
const { normalizeSettings } = require('../src/preferences.cjs');
const near = (actual, expected, epsilon = 1e-9, label = '') => assert.ok(Math.abs(actual - expected) <= epsilon, `${label} ${actual} ≉ ${expected}`);

test('fit centers landscape and portrait without enlarging smaller files', () => {
  assert.deepEqual(layout({width:6000,height:4000},{width:900,height:800},false,100), {width:900,height:600,left:0,top:100});
  assert.deepEqual(layout({width:4000,height:6000},{width:900,height:600},false,100), {width:400,height:600,left:250,top:0});
  assert.deepEqual(layout({width:300,height:200},{width:900,height:600},false,100), {width:300,height:200,left:300,top:200});
});
test('percentage is relative to image pixels and clamps pans at every edge', () => {
  const image={width:6000,height:4000},view={width:900,height:600};
  assert.deepEqual(layout(image,view,true,200),{width:12000,height:8000,left:-5550,top:-3700});
  assert.deepEqual(layout(image,view,true,50,{x:0,y:0}),{width:3000,height:2000,left:0,top:0});
  assert.deepEqual(layout(image,view,true,50,{x:1,y:1}),{width:3000,height:2000,left:-2100,top:-1400});
  assert.equal(layout(image,view,true,12.5).left,75);
});
test('click coordinates retain image location when preview is replaced by a larger source', () => {
  const point=pointInImage({x:675,y:400},{left:0,top:100,width:900,height:600});
  assert.deepEqual(point,{x:.75,y:.5});
  const result=layout({width:6000,height:4000},{width:900,height:800},true,100,point);
  assert.equal((450-result.left)/result.width,.75);
  assert.equal((400-result.top)/result.height,.5);
  assert.equal(layout({width:0,height:0},{width:900,height:600},true,100).width,0);
});
test('zoom preference survives normalization and rejects unusable values', () => {
  assert.equal(normalizeSettings({zoomPercent:200}).zoomPercent,200);
  for(const zoomPercent of [0,-1,Infinity,1601,'100'])assert.throws(()=>normalizeSettings({zoomPercent}));
  assert.equal(normalizeSettings({}).zoomClickCenter,false);
  assert.equal(normalizeSettings({zoomClickCenter:true}).zoomClickCenter,true);
  assert.throws(()=>normalizeSettings({zoomClickCenter:'yes'}));
});

test('100% is one photo pixel per device pixel; Fit, Fill and ratios', () => {
  const source = { width: 7008, height: 4672 }, view = { width: 1200, height: 800 };
  assert.equal(V.scaleFor({ mode: 'ratio', percent: 100 }, source, view, 1), 1);
  assert.equal(V.scaleFor({ mode: 'ratio', percent: 100 }, source, view, 2), .5, 'HiDPI: 100% draws at half the CSS size');
  assert.equal(V.scaleFor({ mode: 'ratio', percent: 200 }, source, view, 1.5), 2 / 1.5);
  near(V.scaleFor({ mode: 'fit' }, source, view), 1200 / 7008);
  near(V.scaleFor({ mode: 'fill' }, { width: 4672, height: 7008 }, view), 1200 / 4672);
  near(V.percentOf(V.scaleFor({ mode: 'fit' }, source, view, 2), 2), 1200 / 7008 * 200);
  // Fit does not enlarge a photo whose real size is known, but does scale up a stand-in.
  assert.equal(V.fitScale({ width: 120, height: 80 }, view, 1, true), 1);
  assert.equal(V.fitScale({ width: 120, height: 80 }, view, 2, true), .5);
  assert.equal(V.fitScale({ width: 120, height: 80 }, view, 1, false), 10);
});

test('zooming around a point keeps that photo point under the pointer', () => {
  const source = { width: 6000, height: 4000 }, view = { width: 1000, height: 700 };
  const from = V.place(source, view, V.fitScale(source, view));
  for (const anchor of [{ x: 650, y: 350 }, { x: 300, y: 420 }, { x: 510, y: 233 }]) {
    for (const percent of [50, 100, 300, 1600]) {
      const scale = percent / 100, under = V.pointAt(anchor, from);
      const center = V.zoomAround(source, view, from, scale, anchor), box = V.place(source, view, scale, center);
      const after = V.pointAt(anchor, box);
      near(after.x * box.width, under.x * box.width, 1e-6, `x at ${percent}%`); near(after.y * box.height, under.y * box.height, 1e-6, `y at ${percent}%`);
    }
  }
  // Pressing in the letterbox above the photo: x keeps its point (2 px → photo x 12),
  // y is clamped so the photo still covers the viewport.
  const edge = V.place(source, view, 1, V.zoomAround(source, view, from, 1, { x: 2, y: 2 }));
  near(edge.left, -10, 1e-9); assert.equal(edge.top, 0);
  // From a zoomed state too (e.g. Ctrl+wheel steps).
  const zoomed = V.place(source, view, .5, { x: .3, y: .6 }), anchor = { x: 700, y: 200 }, under = V.pointAt(anchor, zoomed);
  const next = V.place(source, view, .8, V.zoomAround(source, view, zoomed, .8, anchor));
  near(V.pointAt(anchor, next).x, under.x, 1e-9); near(V.pointAt(anchor, next).y, under.y, 1e-9);
});

test('"zoom clicked point to center" centres the point unless that would show past an edge', () => {
  const source = { width: 6000, height: 4000 }, view = { width: 1000, height: 700 };
  const centered = V.place(source, view, 1, V.centerOn(source, view, 1, { x: .4, y: .55 }));
  assert.deepEqual(V.centerOf(centered, view), { x: .4, y: .55 });
  const clamped = V.centerOn(source, view, 1, { x: .01, y: .99 });
  assert.equal(clamped.x, 500 / 6000); near(clamped.y, 1 - 350 / 4000);
});

test('panning is clamped; axes smaller than the viewport stay centred', () => {
  const source = { width: 3000, height: 1000 }, view = { width: 1000, height: 700 };
  const box = V.place(source, view, 1, { x: .5, y: .5 });
  assert.equal(box.top, -150);
  let center = V.panCenter(source, view, box, 100, 40);
  let moved = V.place(source, view, 1, center);
  assert.equal(moved.left, box.left + 100); assert.equal(moved.top, -110);
  center = V.panCenter(source, view, box, 99999, 99999); moved = V.place(source, view, 1, center);
  assert.equal(moved.left, 0); assert.equal(moved.top, 0);
  center = V.panCenter(source, view, box, -99999, -99999); moved = V.place(source, view, 1, center);
  assert.equal(moved.left, 1000 - 3000); assert.equal(moved.top, 700 - 1000);
  const narrow = V.place(source, view, .3, { x: .9, y: .1 });
  assert.deepEqual([narrow.left, narrow.top], [50, 200], 'a photo smaller than the view is centred on both axes');
});

test('a press is a click until it moves more than 4 px', () => {
  assert.equal(V.DRAG_THRESHOLD, 4);
  assert.equal(V.isDrag(3, 2), false); assert.equal(V.isDrag(0, 4), false);
  assert.equal(V.isDrag(4, 1), true); assert.equal(V.isDrag(-5, 0), true);
});

test('Ctrl +/- step through zoom levels above Fit; wheel zoom is clamped to Fit…1600%', () => {
  const fit = 27.7;
  const up = [fit]; for (let i = 0; i < 12; i++) up.push(V.stepPercent(up.at(-1), 1, fit));
  assert.deepEqual(up.slice(1, 10), [33.3, 50, 66.7, 100, 200, 300, 400, 800, 1600]);
  assert.equal(up.at(-1), 1600, 'stays at the maximum');
  assert.equal(V.stepPercent(100, -1, fit), 66.7);
  assert.equal(V.stepPercent(33.3, -1, fit), null, 'stepping below the first level returns to Fit');
  assert.equal(V.stepPercent(40, -1, 30), 33.3);
  assert.equal(V.stepPercent(137, 1, fit), 200, 'free zoom levels snap to the next step');
  assert.ok(V.wheelPercent(100, -100, fit) > 100);
  assert.ok(V.wheelPercent(100, 100, fit) < 100);
  assert.equal(V.wheelPercent(1500, -250, fit), 1600);
  assert.equal(V.wheelPercent(30, 250, fit), null);
  assert.deepEqual(V.wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }), { x: 0, y: 120 });
});

test('navigator rectangle is the visible part of the photo', () => {
  const view = { width: 1000, height: 500 };
  assert.deepEqual(V.visibleRect({ width: 4000, height: 2000, left: -1000, top: -500 }, view), { x: .25, y: .25, width: .25, height: .25 });
  assert.deepEqual(V.visibleRect({ width: 800, height: 400, left: 100, top: 50 }, view), { x: 0, y: 0, width: 1, height: 1 });
});

test('zoom and relative position carry over to the next photo', () => {
  const view = { width: 1000, height: 700 }, kept = { x: .25, y: .3 };
  const landscape = { width: 3600, height: 2400 }, portrait = { width: 2400, height: 3600 };
  const first = V.place(landscape, view, 1, kept);
  assert.deepEqual(V.centerOf(first, view), kept);
  // The same normalized centre applies to the next photo, clamped to its edges.
  const next = V.place(portrait, view, 1, V.centerOf(first, view));
  assert.deepEqual(V.centerOf(next, view), kept);
  const small = V.place({ width: 1200, height: 800 }, view, 1, kept);
  near(V.centerOf(small, view).x, 500 / 1200); near(V.centerOf(small, view).y, 350 / 800);
});
