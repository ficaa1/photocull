const { test } = require('node:test');
const assert = require('node:assert/strict');
const { smooth, histogramData, zoneAt, dragged, quantize, clippingMask, merge, RenderQueue } = require('../src/renderer/histogram.js');
const bins = () => Array(256).fill(0);
const histogram = () => ({r:bins(),g:bins(),b:bins(),luma:bins(),total:1000});
test('histogram averages truncate at endpoints and scale against the interior RGB peak', () => {
  const b=bins();b[0]=30;b[3]=20;
  const s=smooth(b);assert.equal(s[0],10);assert.equal(s[1],12.5);assert.equal(s[2],10);assert.equal(s[3],4);
  const h=histogram();h.r[100]=100;h.luma[100]=400;h.g[150]=25;
  const result=histogramData(h);assert.equal(result.peak,20);assert.equal(result.heights[2][150],.5);assert.equal(result.heights[0][100],1);
  assert.ok(histogramData(histogram()).heights.flat().every(Number.isFinite));
});
test('clipping is max channel fraction, strictly above 0.3%; grayscale follows channel spread', () => {
  const h=histogram();h.r[0]=3;h.g[255]=4;
  assert.equal(histogramData(h).shadows,false);assert.equal(histogramData(h).highlights,true);
  h.r[0]=4;assert.equal(histogramData(h).shadows,true);
  h.r=h.g=h.b=Array(256).fill(10);assert.equal(histogramData(h).gray,true);
  h.b=[...h.b];h.b[10]=100;assert.equal(histogramData(h).gray,false);
});
test('zones include exact boundaries, reject off-plot and NaN', () => {
  for(const [x,name] of [[0,'blacks'],[.149,'blacks'],[.15,'shadows'],[.35,'exposure'],[.65,'highlights'],[.85,'whites'],[1,'whites']])assert.equal(zoneAt(x).control,`light.${name}`);
  for(const x of [-1,1.001,NaN,Infinity])assert.equal(zoneAt(x),null);
});
test('fine drag is one tenth, accumulates fractions, clamps, and rejects hostile input', () => {
  const s={min:-100,max:100,step:1,default:0};
  assert.equal(dragged(s,0,20,200,false),20);assert.equal(dragged(s,0,20,200,true),2);
  assert.equal(dragged(s,99,200,200,false),100);assert.equal(dragged(s,5,NaN,200,false),5);assert.equal(dragged(s,5,20,0,false),5);
  let value=0;for(let i=0;i<10;i++)value=dragged(s,value,.4,200,true);assert.equal(quantize(s,value),0);assert.ok(value>.39);
  assert.equal(quantize(s,NaN),0);assert.equal(quantize({...s,step:.01},.454),.45);
});
test('clipping mask preserves normal pixels as transparent and paints black blue / white red', () => {
  assert.deepEqual([...clippingMask([0,0,0,255,255,10,1,255,20,30,40,255])],[0,0,255,210,255,0,0,210,0,0,0,0]);
});
test('partial settings merge preserves defaults and replaces curve arrays without mutating', () => {
  const base={light:{exposure:0,contrast:0},curve:{master:[[0,0],[1,1]]}};
  const next=merge(base,{light:{exposure:1},curve:{master:[]}});assert.equal(next.light.contrast,0);assert.equal(base.light.exposure,0);assert.deepEqual(next.curve.master,[]);
});
const tick = () => new Promise(resolve => setImmediate(resolve));
test('render queue allows one request, coalesces latest and settles after idle', async () => {
  const calls=[],published=[],resolvers=[],timers=new Map();let timerId=0,active=0,max=0;
  const q=new RenderQueue((v,settled)=>{calls.push([v.n,settled]);max=Math.max(max,++active);return new Promise(resolve=>resolvers.push(()=>{active--;resolve(v.n);}));},f=>published.push(f),e=>{throw e;},{setTimer:fn=>{timers.set(++timerId,fn);return timerId;},clearTimer:id=>timers.delete(id)});
  q.request({n:1});q.request({n:2});q.request({n:3});assert.deepEqual(calls,[[1,false]]);
  resolvers.shift()();await tick();assert.deepEqual(calls,[[1,false],[3,false]]);assert.deepEqual(published,[1]);
  resolvers.shift()();await tick();assert.deepEqual(published,[1,3]);
  [...timers.values()][0]();assert.deepEqual(calls.at(-1),[3,true]);resolvers.shift()();await tick();assert.equal(max,1);
  q.request({n:4});q.invalidate();resolvers.shift()();await tick();assert.deepEqual(published,[1,3,3]);
});
test('obsolete render errors are suppressed and latest job continues', async () => {
  let reject,resolve;const errors=[],frames=[];
  const q=new RenderQueue(v=>new Promise((a,b)=>{if(v===1)reject=b;else resolve=a;}),f=>frames.push(f),e=>errors.push(e),{setTimer:()=>0,clearTimer:()=>{}});
  q.request(1);q.request(2);reject(new Error('stale'));await tick();resolve('latest');await tick();assert.deepEqual(errors,[]);assert.deepEqual(frames,['latest']);
});
test('TIFF handoff preflight keeps existing files and refuses collisions and symlinks', async t => {
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const {planTiffs}=require('../src/develop-plan.cjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-tiff-plan-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const items=[{id:'a',name:'IMG.ARW',raw:true},{id:'b',name:'NEW.ARW',raw:true}];await fs.writeFile(path.join(dir,'IMG.tif'),'keep edits');
  let result=await planTiffs(items,dir);assert.equal(result[0].exists,true);assert.equal(result[1].exists,false);assert.equal(await fs.readFile(path.join(dir,'IMG.tif'),'utf8'),'keep edits');
  result=await planTiffs([...items,{id:'c',name:'img.NEF',raw:true}],dir);assert.ok(result[0].error);assert.ok(result[2].error);assert.equal(result[1].exists,false);
  await fs.symlink(path.join(dir,'IMG.tif'),path.join(dir,'NEW.tif'));result=await planTiffs(items,dir);assert.match(result[1].error,/regular file/);
});
