const test = require('node:test');
const assert = require('node:assert/strict');
const { layout, pointInImage } = require('../src/renderer/image-view.js');
const { normalizeSettings } = require('../src/preferences.cjs');
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
});
